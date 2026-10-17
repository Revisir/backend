/** The blank in a fill-in-the-blank prompt. */
export const BLANK_MARKER = "____";

/**
 * Normalizes question or answer text for comparison: lowercase, single spaces,
 * no surrounding whitespace, and no trailing `.,;:!?`.
 *
 * Used for retirement keys (a flagged question never comes back, however the
 * formatter re-punctuates it) and for fill-in-the-blank grading, which ignores
 * letter case, extra spaces and trailing punctuation. Idempotent.
 */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s.,;:!?]+$/, "");
}
