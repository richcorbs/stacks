/** Normalize line endings for text written to the system clipboard. */
export function normalizeClipboardText(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}
