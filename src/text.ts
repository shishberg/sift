/**
 * Shared text helpers for adapters and sources.
 *
 * The three JSONL adapters (claude, codex, pi) and the opencode source all
 * truncate tool-call args and tool-result/output text to the same limits. These
 * live here so the numbers and the truncation behaviour are defined once.
 */

/** Max length for a tool call's serialized args (compact FTS form). */
export const TOOL_ARGS_MAX = 200;

/** Max length for tool-result / tool-output text (FTS-only). */
export const TOOL_RESULT_MAX = 500;

/** Truncate `s` to `max` chars, appending an ellipsis when shortened. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '...';
}
