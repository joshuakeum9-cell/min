/**
 * MIN · filler tests. Run: node app/fillers.test.js
 *
 * No framework, by the same reasoning as the module itself: a test runner is a
 * dependency, and this file has to keep working in a repo that ships unsigned
 * and never auto-updates. The output looks like calendar.test.js and reads the
 * same way.
 *
 * Nothing here needs Electron, a model, a file or a clock. stripFillers takes a
 * string and returns a string, so every case below is the whole test: an input,
 * an expected output, and no setup between them.
 *
 * The negative cases carry as much weight as the positive ones. A filler
 * stripper that eats "hummus" or breaks "uh-huh" in half does more damage to a
 * transcript than one that leaves every "um" in place, so the words that must
 * survive are checked one at a time rather than in a single sentence.
 */

import { stripFillers } from './fillers.js';

/* ------------------------------------------------------------- tiny harness */

let failures = 0;
let checks = 0;

function ok(label, condition, detail = '') {
  checks++;
  if (!condition) failures++;
  const line = `${condition ? '  ok  ' : '  FAIL'} ${label}`;
  console.log(detail && !condition ? `${line} , ${detail}` : line);
}

function show(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return `[${value.map(show).join(', ')}]`;
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}

function eq(label, actual, expected) {
  const same = Array.isArray(actual) || (actual && typeof actual === 'object')
    ? JSON.stringify(actual) === JSON.stringify(expected)
    : Object.is(actual, expected);
  ok(label, same, `got ${show(actual)} want ${show(expected)}`);
}

function section(name) {
  console.log(`\n${name}`);
}

/** The two shapes almost every case takes, so the intent stays on one line. */
const strips = (label, input, expected) => eq(label, stripFillers(input), expected);
const keeps = (label, input) => eq(label, stripFillers(input), input);

/* ------------------------------------------------------------------- tests */

section('stripFillers , the vectors this module was written for');
strips('a leading filler takes its comma and the capital moves on', 'Um, we should ship.', 'We should ship.');
strips('a word that starts like a filler is not one', 'the umbrella, uh, is red', 'the umbrella, is red');
strips('a line that was only a hesitation is nothing', 'Hmm.', '');
strips('a hyphenated backchannel survives whole', 'uh-huh, yes', 'uh-huh, yes');
strips('a filler between two numbers closes up', '3 um 4', '3 4');
strips('words containing filler letters are untouched', 'hummus and album', 'hummus and album');
strips('an empty string stays empty', '', '');
strips('a bare filler leaves nothing', 'uh', '');
strips('an upper case filler still hands the capital over', 'UM, okay', 'Okay');

section('stripFillers , the four token shapes');
for (const token of ['uh', 'uhh', 'uuh', 'uhhh']) strips(`u+h+ removes ${show(token)}`, `well ${token} yes`, 'well yes');
for (const token of ['um', 'umm', 'uhm', 'uuhm', 'uhhmm']) strips(`u+h*m+ removes ${show(token)}`, `well ${token} yes`, 'well yes');
for (const token of ['hm', 'hmm', 'hmmm']) strips(`h+m+ removes ${show(token)}`, `well ${token} yes`, 'well yes');
for (const token of ['erm', 'ermm']) strips(`erm+ removes ${show(token)}`, `well ${token} yes`, 'well yes');

section('stripFillers , whole words only');
keeps('umbrella keeps its letters', 'an umbrella');
keeps('hummus keeps its letters', 'more hummus please');
keeps('album keeps its letters', 'the album');
keeps('humble keeps its letters', 'a humble start');
keeps('hum is a word, not a hesitation', 'the hum of the room');
keeps('mum is not a filler', 'call your mum');
keeps('erms is not erm', 'erms and conditions');
keeps('uh-huh survives on the left of a hyphen', 'uh-huh, yes');
keeps('mm-hmm survives on the right of a hyphen', 'she said mm-hmm');
keeps('a hyphen after the token disqualifies it', 'the um-brella thing');
keeps('an apostrophe after the token disqualifies it', "uh'oh, the build");
keeps("a curly apostrophe does too", 'uh’oh, the build');
keeps('an underscore is part of a word too', 'the um_flag setting');
keeps('an accented letter protects the token welded to it', 'the caféum sign');

section('stripFillers , tidying up after the removal');
strips('repeated fillers in one sentence', 'So, um, we should, uh, ship it.', 'So, we should, ship it.');
strips('a filler at the end of a sentence takes the stranded comma', 'We should ship, um.', 'We should ship.');
strips('a filler that was the whole second sentence', 'Yes. Hmm.', 'Yes.');
strips('a comma written before the filler leaves one comma, not two', 'yes, hmm, no', 'yes, no');
strips('a filler between two commas with spaces', 'Well, hmm , yes', 'Well, yes');
strips('a filler holding a comma at the start of a sentence', 'Um , we should ship.', 'We should ship.');
strips('several fillers in a row', 'uh um hmm we ship', 'we ship');
strips('leading and trailing space goes with the removal', '  uh, we ship  ', 'we ship');
strips('multiple sentences, each with its own filler', 'Um, we ship Friday. The client, uh, agreed.', 'We ship Friday. The client, agreed.');
strips('mixed case across every shape', 'UH, Um, hMm, we ship.', 'We ship.');
strips('a filler in the middle of a longer line', 'the deck is, um, ready for review', 'the deck is, ready for review');
strips('a lower case opener is not promoted', 'hmm, we ship.', 'we ship.');
strips('a capital only moves when the first word actually went', 'We should, um, ship.', 'We should, ship.');
strips('a line break is structure, not a gap to close', 'one um two\nthree uh four', 'one two\nthree four');
keeps('a line with no filler is returned exactly as it came in', '  spaces   and   more  ');

// A caller may hand over several transcript lines at once, and the line breaks
// are the structure of that text. They survive; the horizontal debris a deleted
// word leaves against them does not.
const NL = String.fromCharCode(10);
section('stripFillers , more than one line');
eq('a filler at the end of a line leaves no trailing space',
  stripFillers('line one uh' + NL + 'line two um here'), 'line one' + NL + 'line two here');
eq('a filler at the start of a line leaves no leading space',
  stripFillers('line one' + NL + 'uh line two'), 'line one' + NL + 'line two');
eq('a line that was only a filler collapses to an empty line',
  stripFillers('one' + NL + 'um' + NL + 'two'), 'one' + NL + NL + 'two');
eq('line breaks survive when nothing is removed',
  stripFillers('one' + NL + '  two'), 'one' + NL + '  two');

section('stripFillers , input it will be handed anyway');
eq('null is not a string', stripFillers(null), '');
eq('undefined is not a string', stripFillers(undefined), '');
eq('a number is not a string', stripFillers(42), '');
eq('zero is not a string either', stripFillers(0), '');
eq('an object is not a string', stripFillers({ text: 'um, hello' }), '');
eq('an array is not a string', stripFillers(['um', 'hello']), '');
eq('a boolean is not a string', stripFillers(true), '');
eq('no argument at all', stripFillers(), '');
eq('whitespace only comes back untouched', stripFillers('   '), '   ');
ok('stripFillers always returns a string', [null, undefined, 42, {}, [], '', 'um, hi'].every((v) => typeof stripFillers(v) === 'string'));
ok('stripFillers is stable when run twice', ['Um, we should ship.', 'uh-huh, yes', 'Hmm.', '3 um 4'].every((v) => stripFillers(stripFillers(v)) === stripFillers(v)));

/* ------------------------------------------------------------------ result */

console.log(`\n${failures ? 'FAILED' : 'PASSED'} , ${checks - failures}/${checks} checks`);
process.exit(failures ? 1 : 0);
