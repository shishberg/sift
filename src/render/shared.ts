/**
 * Claude and pi tool-result content can be a plain string or an array of
 * content blocks; we only keep the text blocks. Anything else → ''.
 */
export function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as Record<string, unknown>[])
      .filter((b) => b['type'] === 'text')
      .map((b) => (b['text'] as string | undefined) ?? '')
      .join('\n');
  }
  return '';
}
