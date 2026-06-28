/**
 * Claude Code injects a handful of XML wrapper tags into the *user* turn of a
 * session log to annotate harness activity — slash-command invocations and the
 * output of local `!`-commands. In a search snippet or a rendered transcript
 * these read as angle-bracket noise, so we normalise them away.
 *
 * This is a deliberately CLOSED registry, not a generic XML stripper: agents
 * talk about real XML/HTML and write code full of `<` and `>`, so we only ever
 * touch the exact tag names below. Text containing no registry tag is returned
 * byte-for-byte unchanged.
 *
 * Strategies:
 *   - 'unwrap' — remove the open/close tags, keep the inner text verbatim
 *                (newlines inside the block are preserved).
 *   - 'drop'   — remove the whole element, inner content included (boilerplate).
 *
 * Tag survey done against ~/.claude/projects on 2026-06-28. Add new tags here
 * as they show up; the rest of the pipeline needs no changes.
 */

export type TagStrategy = 'unwrap' | 'drop';

export const HARNESS_TAGS: Record<string, TagStrategy> = {
  // Slash-command invocation, e.g. <command-name>/login</command-name>.
  'command-name': 'unwrap',
  'command-message': 'unwrap',
  'command-args': 'unwrap',
  // Output captured from a local `!`-command.
  'local-command-stdout': 'unwrap',
  'local-command-stderr': 'unwrap',
  // Pure boilerplate the harness prepends to local-command messages — no value.
  'local-command-caveat': 'drop',
};

const TAG_NAMES = Object.keys(HARNESS_TAGS);
const TAG_ALTERNATION = TAG_NAMES.join('|');

/** Matches any registry tag (open or close) — used as a cheap presence check. */
const ANY_TAG = new RegExp(`</?(?:${TAG_ALTERNATION})\\b[^>]*>`);

const DROP_NAMES = TAG_NAMES.filter((t) => HARNESS_TAGS[t] === 'drop').join('|');

/**
 * Normalise Claude harness wrapper tags in a user message. No-op (returns the
 * input unchanged) unless the text actually contains a registry tag.
 */
export function stripHarnessTags(text: string): string {
  if (!text || !ANY_TAG.test(text)) return text;

  let out = text;

  // 1. Drop boilerplate elements (tags + inner content). `[\s\S]` spans newlines.
  if (DROP_NAMES) {
    out = out.replace(
      new RegExp(`<(?:${DROP_NAMES})\\b[^>]*>[\\s\\S]*?</(?:${DROP_NAMES})>`, 'g'),
      '',
    );
  }

  // 2. Collapse the harness's pretty-print indentation that sits *between*
  //    adjacent registry tags, so a multi-line command block reads as one line.
  //    Only inter-tag whitespace is touched; inner content is left alone.
  out = out.replace(
    new RegExp(`(</(?:${TAG_ALTERNATION})>)\\s+(<(?:${TAG_ALTERNATION})\\b)`, 'g'),
    '$1 $2',
  );

  // 3. Unwrap remaining registry tags, keeping their inner text.
  out = out.replace(new RegExp(`</?(?:${TAG_ALTERNATION})\\b[^>]*>`, 'g'), '');

  return out.trim();
}
