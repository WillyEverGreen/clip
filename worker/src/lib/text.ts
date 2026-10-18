/**
 * Multipart form encoding turns every line break in text fields into "\r\n" (browsers and other
 * clients alike). Store plain "\n" instead so raw and CLI output has normal Unix line endings and
 * text round-trips exactly as typed.
 */
export function normalizeNewlines(text: string | null): string | null {
  return text === null ? null : text.replace(/\r\n?/g, '\n')
}
