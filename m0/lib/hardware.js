/**
 * Hardware detection and model tiering.
 *
 * The point of M0 is to measure what the MEDIAN user experiences, not what the
 * developer's machine can do. This module detects the host and shouts if the
 * host is too good to be a valid test bed.
 */

import os from 'node:os';
import { execSync } from 'node:child_process';

/** The machine we are actually designing for. Anything better is not a valid M0 run. */
export const TARGET_SPEC = {
  cores: 4,
  ramGB: 8,
  discreteGPU: false,
};

export function detectHardware() {
  const cpus = os.cpus();
  const ramGB = os.totalmem() / 1024 ** 3;

  return {
    platform: os.platform(),
    arch: os.arch(),
    cpuModel: cpus[0]?.model?.trim() ?? 'unknown',
    logicalCores: cpus.length,
    physicalCores: detectPhysicalCores(cpus.length),
    ramGB: Number(ramGB.toFixed(1)),
    freeRamGB: Number((os.freemem() / 1024 ** 3).toFixed(1)),
    gpus: detectGPUs(),
    nodeVersion: process.version,
  };
}

function detectPhysicalCores(logical) {
  try {
    if (os.platform() === 'win32') {
      const out = execSync(
        'powershell -NoProfile -Command "(Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum"',
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim();
      const n = parseInt(out, 10);
      if (Number.isFinite(n) && n > 0) return n;
    } else if (os.platform() === 'darwin') {
      const n = parseInt(execSync('sysctl -n hw.physicalcpu', { encoding: 'utf8' }).trim(), 10);
      if (Number.isFinite(n) && n > 0) return n;
    } else {
      const out = execSync('lscpu -p=Core,Socket | grep -v "^#" | sort -u | wc -l', {
        encoding: 'utf8',
        shell: '/bin/bash',
      }).trim();
      const n = parseInt(out, 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch {
    /* fall through */
  }
  return Math.max(1, Math.floor(logical / 2));
}

function detectGPUs() {
  try {
    if (os.platform() === 'win32') {
      const out = execSync(
        'powershell -NoProfile -Command "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name"',
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      );
      return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    }
    if (os.platform() === 'darwin') {
      const out = execSync('system_profiler SPDisplaysDataType -json', { encoding: 'utf8' });
      const data = JSON.parse(out);
      return (data.SPDisplaysDataType ?? []).map((g) => g.sppci_model ?? g._name).filter(Boolean);
    }
    const out = execSync('lspci | grep -i "vga\\|3d\\|display"', {
      encoding: 'utf8',
      shell: '/bin/bash',
    });
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

const DISCRETE_PATTERNS = [/nvidia/i, /geforce/i, /\brtx\b/i, /\bgtx\b/i, /radeon\s+rx/i, /\barc\b/i];

export function hasDiscreteGPU(hw) {
  return hw.gpus.some((g) => DISCRETE_PATTERNS.some((p) => p.test(g)));
}

/**
 * Which model tier this machine gets.
 * Thresholds are provisional; bench-llm.js is what actually sets them.
 */
export function modelTier(hw) {
  if (hw.ramGB >= 12) {
    return {
      tier: 'standard',
      llm: 'qwen3-4b',
      reason: `${hw.ramGB} GB RAM is enough to hold the 4B model and the ASR model together`,
    };
  }
  return {
    tier: 'light',
    llm: 'qwen3-1.7b',
    reason: `${hw.ramGB} GB RAM is tight — 4B would page or force serial model loading`,
  };
}

/**
 * Is this a valid M0 test bed? A developer desktop is not.
 * Returns a list of reasons the numbers from this machine will flatter the design.
 */
export function validateTestBed(hw) {
  const warnings = [];

  if (hasDiscreteGPU(hw)) {
    warnings.push(
      `Discrete GPU present (${hw.gpus.filter((g) => DISCRETE_PATTERNS.some((p) => p.test(g))).join(', ')}). ` +
        `Benchmarks must run with the CPU backend forced on, or every number here is meaningless for the target user.`
    );
  }
  if (hw.physicalCores > TARGET_SPEC.cores) {
    warnings.push(
      `${hw.physicalCores} physical cores vs the ${TARGET_SPEC.cores}-core target. ` +
        `Expect this machine to be roughly ${(hw.physicalCores / TARGET_SPEC.cores).toFixed(1)}x faster than the median laptop.`
    );
  }
  if (hw.ramGB > TARGET_SPEC.ramGB * 1.5) {
    warnings.push(
      `${hw.ramGB} GB RAM vs the ${TARGET_SPEC.ramGB} GB target. ` +
        `The "can both models be resident at once" question cannot be answered on this machine.`
    );
  }
  return warnings;
}

export function describe(hw) {
  const tier = modelTier(hw);
  const lines = [
    `Platform      ${hw.platform}/${hw.arch}  ·  Node ${hw.nodeVersion}`,
    `CPU           ${hw.cpuModel}`,
    `Cores         ${hw.physicalCores} physical / ${hw.logicalCores} logical`,
    `Memory        ${hw.ramGB} GB total, ${hw.freeRamGB} GB free`,
    `Graphics      ${hw.gpus.length ? hw.gpus.join(' · ') : 'none detected'}`,
    `Model tier    ${tier.tier} → ${tier.llm}  (${tier.reason})`,
  ];
  return lines.join('\n');
}

import { pathToFileURL } from 'node:url';

/** True when this file was run directly (not imported). Windows-safe. */
export function isMain(metaUrl) {
  return Boolean(process.argv[1]) && metaUrl === pathToFileURL(process.argv[1]).href;
}

if (isMain(import.meta.url)) {
  const hw = detectHardware();
  console.log(describe(hw));
  const warnings = validateTestBed(hw);
  if (warnings.length) {
    console.log('\n⚠  This machine is NOT a valid M0 test bed:\n');
    for (const w of warnings) console.log(`   · ${w}`);
    console.log(
      '\n   Run the real M0 on a 4-core / 8 GB / no-GPU machine (a throttled VM is fine)\n' +
        '   with a video call running. Numbers from this machine are an upper bound only.\n'
    );
  } else {
    console.log('\n✓ Valid M0 test bed.\n');
  }
}
