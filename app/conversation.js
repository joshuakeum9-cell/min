/**
 * The two-sided conversation: transcript segments rendered as chat bubbles.
 *
 * Attribution follows Granola's own convention and never guesses. "them" is the
 * system-audio track (grey, left), "you" is the microphone (green tint, right).
 * The track is a physical fact of the capture, so the side a bubble sits on is
 * exact even when both people talk at once.
 *
 * Everything here goes through textContent. Transcript text is model output
 * over audio the user did not control, and a bubble is the one place that text
 * meets the DOM, so no string from a segment is ever parsed as markup.
 *
 * Shared by the live view (appendBubble, one segment at a time as the worker
 * emits them) and the saved view (renderBubbles over transcript.md).
 */

// Two utterances from one speaker this close together are one thought that
// the VAD split at a breath. transcribe.js folds them with the same threshold,
// so the live view and the saved transcript agree on where bubbles break.
const MERGE_GAP_SECONDS = 2;

// How far above the bottom the reader may sit and still be pulled along.
// Anything further is someone re-reading an earlier line, and yanking them
// back to the newest bubble every few seconds makes the panel unusable.
const FOLLOW_SLACK_PX = 40;

const LABEL = { you: 'Me', them: 'Them' };

const hhmmss = (sec) => {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
};

const trackOf = (segment) => (segment?.track === 'you' ? 'you' : 'them');

/**
 * The element that actually scrolls. The bubbles container is usually inside a
 * panel with its own overflow, so walk up to whichever ancestor owns the
 * scrollbar rather than assuming it is the container itself.
 */
function scrollerOf(container) {
  let el = container;
  while (el && el !== document.body) {
    const overflow = getComputedStyle(el).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') return el;
    el = el.parentElement;
  }
  return container;
}

const nearBottom = (el) => el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK_PX;

function makeBubble(segment, first) {
  const track = trackOf(segment);
  const el = document.createElement('div');
  // `first` is both the label's visibility and the extra gap that separates one
  // speaker's run from the next, so it goes on the element as well.
  el.className = `bubble ${track}${first ? ' first' : ''}`;
  el.dataset.t0 = (Number(segment.t0) || 0).toFixed(2);
  el.dataset.t1 = (Number(segment.t1) || Number(segment.t0) || 0).toFixed(2);

  // The label is always in the tree so the bubble shape is stable for CSS and
  // for copy; it is only hidden past the first bubble of a run.
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = LABEL[track];
  who.hidden = !first;

  const text = document.createElement('span');
  text.className = 'text';
  text.textContent = String(segment.text ?? '').trim();

  const ts = document.createElement('time');
  ts.className = 'ts';
  ts.textContent = hhmmss(segment.t0);

  el.append(who, text, ts);
  return el;
}

/** Can `segment` be folded into the bubble `last` instead of starting a new one? */
function canMerge(last, segment) {
  if (!last || !last.classList.contains('bubble')) return false;
  if (!last.classList.contains(trackOf(segment))) return false;
  const gap = (Number(segment.t0) || 0) - Number(last.dataset.t1);
  return gap >= 0 && gap <= MERGE_GAP_SECONDS;
}

function mergeInto(last, segment) {
  const text = last.querySelector('.text');
  const add = String(segment.text ?? '').trim();
  if (text && add) text.textContent = text.textContent ? `${text.textContent} ${add}` : add;
  const t1 = Number(segment.t1);
  if (Number.isFinite(t1) && t1 > Number(last.dataset.t1)) last.dataset.t1 = t1.toFixed(2);
}

/**
 * Add one segment to the end of the conversation, merging into the previous
 * bubble when it is the same speaker continuing. Follows the newest line unless
 * the reader has scrolled up to look at something.
 */
export function appendBubble(container, segment) {
  if (!container || !segment) return null;
  if (segment.echo) return null; // acoustic bleed, not a second speaker
  const text = String(segment.text ?? '').trim();
  if (!text) return null;

  const scroller = scrollerOf(container);
  const follow = nearBottom(scroller);

  const last = container.lastElementChild;
  let el;
  if (canMerge(last, segment)) {
    mergeInto(last, segment);
    el = last;
  } else {
    const first = !last || !last.classList.contains(trackOf(segment));
    el = makeBubble(segment, first);
    container.appendChild(el);
  }

  if (follow) scroller.scrollTop = scroller.scrollHeight;
  return el;
}

/**
 * Replace the container's contents with a whole conversation.
 *
 * `live` says the list will keep growing: start pinned to the newest line so
 * the first streamed segment lands in view. A saved transcript reads from the
 * top like any document.
 */
export function renderBubbles(container, segments, options = {}) {
  if (!container) return;
  const { live = false } = options || {};
  container.replaceChildren();
  container.classList.toggle('live', Boolean(live));

  const ordered = (Array.isArray(segments) ? segments : [])
    .filter((s) => s && !s.echo && String(s.text ?? '').trim())
    .slice()
    .sort((a, b) => (Number(a.t0) || 0) - (Number(b.t0) || 0) || (trackOf(a) === 'you' ? -1 : 1));

  // Build the whole run without touching scroll, then position once. Going
  // through appendBubble here would measure the scroller per segment.
  let last = null;
  for (const seg of ordered) {
    if (canMerge(last, seg)) {
      mergeInto(last, seg);
      continue;
    }
    const first = !last || !last.classList.contains(trackOf(seg));
    last = makeBubble(seg, first);
    container.appendChild(last);
  }

  const scroller = scrollerOf(container);
  scroller.scrollTop = live ? scroller.scrollHeight : 0;
}

// The line format transcribe.js writes. Anything else in the file is either a
// wrapped continuation of the line above or noise, and is treated as the former
// so a long utterance is never silently dropped from the conversation.
const LINE = /^\[(\d{2}):(\d{2}):(\d{2})\]\s+(You|Them):\s*(.*)$/;

// transcript.md carries a start time per line and no end. The end is estimated
// from length so the merge rule has something to work with: a little under
// three words a second is the pace of ordinary speech.
const SECONDS_PER_WORD = 0.4;

/**
 * Parse transcript.md back into segments for renderBubbles. Each line becomes
 * {track, t0, t1, text}; t1 is an estimate (see above), capped at the next
 * line's start so bubbles never overlap on the timeline.
 */
export function segmentsFromTranscript(markdownText) {
  const out = [];
  for (const raw of String(markdownText ?? '').split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const m = line.match(LINE);
    if (!m) {
      const prev = out[out.length - 1];
      if (prev) prev.text = `${prev.text} ${line.trim()}`.trim();
      continue;
    }
    const t0 = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    out.push({ track: m[4] === 'You' ? 'you' : 'them', t0, t1: t0, text: m[5].trim() });
  }
  for (let i = 0; i < out.length; i++) {
    const words = out[i].text.split(/\s+/).filter(Boolean).length;
    let t1 = out[i].t0 + Math.max(1, words * SECONDS_PER_WORD);
    const next = out[i + 1];
    if (next && next.t0 > out[i].t0) t1 = Math.min(t1, next.t0);
    out[i].t1 = +t1.toFixed(2);
  }
  return out;
}

/* ------------------------------------------------------- copy and search */

// How long the copied outline stays on a bubble. Long enough to read as a
// flash, short enough that copying a run of lines does not leave half the
// panel lit up behind you.
const COPIED_MS = 900;

const COPY_TITLE = 'Click to copy this line';

/**
 * One bubble as a transcript line.
 *
 * makeBubble put the track on the class list and the start time in data-t0, so
 * a bubble already carries everything the line format needs; LABEL and hhmmss
 * are the same ones the rest of the file uses, so a copied line reads exactly
 * the way the bubble reads.
 */
function bubbleLine(el) {
  const track = el.classList.contains('you') ? 'you' : 'them';
  const text = el.querySelector('.text')?.textContent.trim() ?? '';
  return text ? `[${hhmmss(el.dataset.t0)}] ${LABEL[track]}: ${text}` : '';
}

/** Make one bubble reachable by keyboard and say what clicking it does. */
function stampBubble(el) {
  if (el.hasAttribute('tabindex')) return;
  el.setAttribute('tabindex', '0');
  el.title = COPY_TITLE;
}

function copyBubble(el, onCopied) {
  const line = bubbleLine(el);
  if (!line) return;
  // Going through Promise.resolve first puts a missing or blocked clipboard
  // (insecure context, no focus, permission refused) on the same rejection
  // path as a refused write, rather than throwing out of an event handler.
  // A failed copy says nothing: the user still has the line on screen.
  Promise.resolve()
    .then(() => navigator.clipboard.writeText(line))
    .then(() => {
      el.classList.add('copied');
      setTimeout(() => el.classList.remove('copied'), COPIED_MS);
      if (typeof onCopied === 'function') onCopied(line);
    }, () => {});
}

/**
 * Click, Enter or Space on a bubble copies that one utterance.
 *
 * One delegated listener on the container rather than one per bubble, so a
 * line that streams in mid-recording is copyable the moment it lands and
 * nothing has to be rebound. Idempotent through a flag on the container: a
 * second call is a no-op instead of a second listener and a double copy.
 *
 * `onCopied(text)` runs only once the clipboard has actually taken the line.
 */
export function enableBubbleCopy(container, onCopied) {
  if (!container || container.dataset.bubbleCopy === 'on') return;
  container.dataset.bubbleCopy = 'on';

  // Attributes are stamped on what is here now and on each new bubble through
  // a MutationObserver, rather than lazily on focusin. An unstamped bubble has
  // no tabindex, so it can never take focus and focusin would never fire for
  // it: keyboard reach has to exist before the first Tab, not after it. This
  // keeps the whole feature inside this function, out of makeBubble.
  for (const el of container.querySelectorAll('.bubble')) stampBubble(el);
  if (typeof MutationObserver === 'function') {
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType === 1 && node.classList.contains('bubble')) stampBubble(node);
        }
      }
    }).observe(container, { childList: true });
  }

  // closest() from the event target, so a click on the timestamp or the
  // speaker label copies the whole line and not the fragment under the pointer.
  const bubbleFor = (node) => {
    const el = node?.closest ? node.closest('.bubble') : null;
    return el && container.contains(el) ? el : null;
  };

  container.addEventListener('click', (event) => {
    const el = bubbleFor(event.target);
    if (el) copyBubble(el, onCopied);
  });

  container.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const el = bubbleFor(event.target);
    if (!el) return;
    // Space scrolls the panel by default, which would throw the reader off the
    // line they just copied.
    if (event.key === ' ') event.preventDefault();
    copyBubble(el, onCopied);
  });
}

/**
 * Put the text of `host` back the way it was rendered: every <mark> becomes
 * the plain text it held again, and normalize() re-joins the pieces. Without
 * that join, a few searches in a row would leave one utterance spread over
 * hundreds of adjacent text nodes.
 */
function unmark(host) {
  const marks = host.querySelectorAll('mark');
  if (!marks.length) return;
  for (const mark of marks) {
    mark.parentNode.replaceChild(document.createTextNode(mark.textContent), mark);
  }
  host.normalize();
}

/**
 * Wrap every occurrence of `needle` (already lowercased) in a <mark>.
 *
 * The text nodes are collected before anything is replaced, so the walk is
 * never chasing a tree it is editing underneath itself.
 */
function markMatches(host, needle) {
  const nodes = [];
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) nodes.push(child);
      else if (child.nodeType === 1) walk(child);
    }
  };
  walk(host);

  for (const node of nodes) {
    const raw = node.textContent;
    const hay = raw.toLowerCase();
    if (!hay.includes(needle)) continue;

    const frag = document.createDocumentFragment();
    let cut = 0;
    for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, cut)) {
      if (at > cut) frag.appendChild(document.createTextNode(raw.slice(cut, at)));
      const mark = document.createElement('mark');
      // The matched run comes off the original string, so the highlight keeps
      // the speaker's own casing rather than the casing that was typed.
      mark.textContent = raw.slice(at, at + needle.length);
      frag.appendChild(mark);
      cut = at + needle.length;
    }
    if (cut < raw.length) frag.appendChild(document.createTextNode(raw.slice(cut)));
    node.parentNode.replaceChild(frag, node);
  }
}

/**
 * Live search over the conversation. Non-matching bubbles take the global
 * `hide` class, matching ones show with each hit wrapped in a <mark>. An empty
 * or whitespace-only query is the reset: everything visible, every highlight
 * gone. Returns how many bubbles are showing, which is the match count, or the
 * whole conversation when there is no query.
 *
 * Matching is against the .text span only. The label and the timestamp are the
 * app's own words, and having "Them" or a stray "00" pull up half the meeting
 * makes the search useless.
 *
 * Same rule as the rest of this file, and it matters more here: the transcript
 * is model output over audio the user did not control, so the highlight is
 * built out of createTextNode and createElement('mark'). Nothing on this path
 * assigns innerHTML, and no transcript string is ever parsed as markup.
 */
export function filterBubbles(container, query) {
  if (!container) return 0;
  const needle = String(query ?? '').trim().toLowerCase();
  const bubbles = container.querySelectorAll('.bubble');
  let hits = 0;

  for (const el of bubbles) {
    const host = el.querySelector('.text');
    // Clear the last search before judging this one, so repeated queries can
    // never nest one <mark> inside another or leave a stale highlight behind.
    if (host) unmark(host);

    if (!needle) {
      el.classList.remove('hide');
      continue;
    }

    const hit = Boolean(host) && host.textContent.toLowerCase().includes(needle);
    el.classList.toggle('hide', !hit);
    if (!hit) continue;
    markMatches(host, needle);
    hits++;
  }

  return needle ? hits : bubbles.length;
}
