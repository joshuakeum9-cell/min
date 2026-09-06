/**
 * A small markdown renderer for the note views.
 *
 * Deliberately not a full parser. It covers exactly what a meeting write-up
 * contains, headings, lists, emphasis, code spans, blockquotes, because the
 * write-up is the thing the user actually reads, and showing them a literal
 * "# Timeline" makes the product look like a text dump.
 *
 * Escaping happens FIRST, on the raw source, so no user or model text can ever
 * reach the DOM as markup. Everything after that operates on already-safe text.
 */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/** Inline spans, applied to already-escaped text. */
function inline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>');
}

export function renderMarkdown(src) {
  const lines = esc(src ?? '').split('\n');
  const out = [];
  let para = [];
  let list = null; // 'ul' | 'ol'

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join(' '))}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };
  const flush = () => {
    flushPara();
    flushList();
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (!line.trim()) {
      flush();
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flush();
      const level = Math.min(heading[1].length + 1, 5); // # -> h2, so h1 stays the page title
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    if (bullet) {
      flushPara();
      if (list !== 'ul') {
        flushList();
        out.push('<ul>');
        list = 'ul';
      }
      out.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }

    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (numbered) {
      flushPara();
      if (list !== 'ol') {
        flushList();
        out.push('<ol>');
        list = 'ol';
      }
      out.push(`<li>${inline(numbered[1])}</li>`);
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flush();
      out.push(`<blockquote>${inline(quote[1])}</blockquote>`);
      continue;
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flush();
      out.push('<hr>');
      continue;
    }

    flushList();
    para.push(line.trim());
  }

  flush();
  return out.join('\n');
}
