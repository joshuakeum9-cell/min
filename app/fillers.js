/**
 * MIN · filler removal, one pure function over one string.
 *
 * No imports, and none may be added. Four callers need this logic and they do
 * not share a module graph: the renderer, the main process, a worker, and
 * `node app/fillers.test.js` with no Electron around it. The worker is the case
 * that decides the rule. The ASR workers are asar-unpacked (see asarUnpack in
 * package.json), so a worker file and everything it pulls in live outside the
 * archive while the rest of app/ lives inside it. An import added here would
 * resolve in development, where both are ordinary files on disk, and fail only
 * in the installed build. That is the ship-it-twice class of bug: it passes
 * every check on this machine, and the user is the one who finds it. Zero
 * imports means one copy of this logic that all four callers can reach, and
 * nothing to keep in sync with the build config.
 *
 * Why whole words only, rather than a list of tokens to delete. Speech is full
 * of real words that begin with the same letters as a hesitation: umbrella,
 * hummus, album, humble. Worse, the model writes backchannels as hyphenated
 * tokens, and those carry meaning. Someone saying "uh-huh" is agreeing, and
 * that agreement is often the point of the sentence it answers. Half-stripping
 * one leaves "-huh", which is not a word in any transcript. So a letter, digit,
 * hyphen or apostrophe on either side disqualifies the match outright, and the
 * boundary is checked before the optional comma is taken, not after.
 *
 * The tidy-up afterwards exists because a filler is rarely alone. It usually
 * arrives with the comma the transcriber gave it and a space on each side, so
 * deleting only the letters leaves punctuation holding nothing apart. Removal
 * is never partial: either the token and its debris go, or nothing does.
 *
 * A string that contains no filler is returned exactly as it came in. Callers
 * run this over every line of a transcript, and a function that silently
 * re-spaces text it had no reason to touch is a function nobody can trust with
 * the whole file.
 */

/**
 * The four hesitation shapes, case-insensitive:
 *   u+h+     uh, uhh, uuh
 *   u+h*m+   um, umm, uhm, uuhm
 *   h+m+     hm, hmm, hmmm
 *   erm+     erm, ermm
 *
 * The guards on either side are the whole-word rule. \p{L} and \p{N} rather
 * than \w because a transcript carries accented words, and "naive" spelled the
 * proper way must protect the letters next to it exactly as a plain one does.
 * U+2019 is in the set because that is the apostrophe a speech model writes.
 *
 * Alternation order does not matter here. "uhm" is tried against u+h+ first,
 * which matches "uh" and then fails the trailing guard on the m, so the engine
 * backtracks into u+h*m+ and takes the whole token. Guard and token are one
 * pattern for exactly that reason.
 */
const FILLER = /(?<![\p{L}\p{N}_'’\-])(?:u+h+|u+h*m+|h+m+|erm+)(?![\p{L}\p{N}_'’\-]),?/giu;

/** A word survived the removal, as opposed to punctuation that outlived its sentence. */
const HAS_WORD = /[\p{L}\p{N}]/u;

/**
 * Close up what the removal left behind.
 *
 * Spaces are matched as literal spaces and tabs, never \s, because a caller may
 * hand over several transcript lines at once and the line breaks are the
 * structure of that text. Only the horizontal gap a deleted word used to fill
 * is the mess this function is here to clean.
 */
function tidy(text) {
  let out = text;

  // "yes, hmm, no" with the comma written before the filler rather than after
  // it leaves two commas with nothing between them. Repeated because a run of
  // fillers leaves a run of commas.
  while (/,[ \t]*,/.test(out)) out = out.replace(/,[ \t]*,/g, ',');

  // A comma that has become the first thing in the string, or the first thing
  // in a sentence. It was punctuating a word that is gone.
  out = out.replace(/^[ \t]*,[ \t]*/, '');
  out = out.replace(/([.!?])[ \t]*,[ \t]*/g, '$1 ');

  // The mirror case: a comma left leaning against the end of its sentence.
  out = out.replace(/,[ \t]*([.!?;:])/g, '$1');

  // A sentence whose only word was a filler still has its full stop. The stop
  // before it already ended the previous sentence. Whitespace is required
  // between the two so that "Really?!" is left alone.
  out = out.replace(/([.!?])[ \t]+([.!?])/g, '$1');

  out = out.replace(/[ \t]+([,.!?;:])/g, '$1');
  out = out.replace(/ {2,}/g, ' ');

  // The same debris at a line boundary. trim() below only reaches the two ends
  // of the whole string, so a filler removed at the end of one line of a
  // multi-line input leaves a space hanging in front of the newline. Horizontal
  // whitespace only: the line breaks themselves are the structure of that text
  // and are never touched.
  out = out.replace(/[ \t]*\n[ \t]*/g, String.fromCharCode(10));

  return out.trim();
}

/**
 * Remove standalone filler words from a line of transcript.
 *
 * Returns '' for anything that is not a string. The input is model output read
 * off audio nobody controlled, and it reaches here through IPC and JSON, so
 * null and undefined are ordinary arguments rather than programmer errors.
 */
export function stripFillers(text) {
  if (typeof text !== 'string') return '';

  const firstWordAt = text.search(/\S/);
  let removed = false;
  let lostFirstWord = false;

  const stripped = text.replace(FILLER, (match, offset) => {
    removed = true;
    if (offset === firstWordAt) lostFirstWord = true;
    return '';
  });

  if (!removed) return text;

  const out = tidy(stripped);

  // Nothing but punctuation survived, so the line was a hesitation and the
  // marks around it were never a sentence. "Hmm." is not "."
  if (!HAS_WORD.test(out)) return '';

  // The capital belonged to the sentence, not to the filler that happened to
  // be carrying it. Only promote a word that is standing in a position it did
  // not previously hold, and only when there was a capital there to inherit.
  if (lostFirstWord && /\p{Lu}/u.test(text.charAt(firstWordAt))) {
    return out.replace(/^\p{Ll}/u, (c) => c.toUpperCase());
  }

  return out;
}
