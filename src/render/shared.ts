/**
 * Claude and pi tool-result content can be a plain string or an array of
 * content blocks; we only keep the text blocks. Anything else → ''.
 */
export function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    // Guard each block: log content is parsed JSON and may hold null or
    // non-object entries, which must be ignored rather than crash rendering.
    return content
      .filter(
        (b): b is { type: 'text'; text?: unknown } =>
          typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text',
      )
      .map((b) => (typeof b.text === 'string' ? b.text : ''))
      .join('\n');
  }
  return '';
}
