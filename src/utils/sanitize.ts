/**
 * Sanitize PTY input by stripping dangerous control characters.
 * Preserves \n (0x0a) and \r (0x0d) since those are needed for Enter/newlines.
 * Strips: 0x00-0x09, 0x0b-0x0c, 0x0e-0x1f, 0x7f
 */
export function sanitizePtyInput(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

/**
 * Check if text is a raw control sequence that should bypass sanitization.
 * Returns true for escape sequences (starts with \x1b) or single control characters
 * used for background/interrupt/mode commands.
 */
export function isRawControlSequence(text: string): boolean {
  // Escape sequences (e.g., \x1b, \x1b[Z)
  if (text.startsWith('\x1b')) return true;
  // Single control characters (e.g., \x02 for Ctrl+B)
  if (text.length === 1 && text.charCodeAt(0) < 0x20 && text !== '\n' && text !== '\r') return true;
  return false;
}
