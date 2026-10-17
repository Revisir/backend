import * as fc from "fast-check";
import { normalizeText } from "@services/questionText";

/**
 * Feature: due-queue-normal-quiz, Property 1: question-text normalization
 * Validates: R19, R24, KTD6, KTD19
 *
 * Retirement keys (a flagged question never returns, however it is re-punctuated)
 * and fill-in-the-blank grading both compare text through `normalizeText`. For any
 * input:
 * - normalizing twice gives the same result as normalizing once
 * - ASCII letter case does not matter
 * - surrounding whitespace and runs of whitespace between words do not matter
 * - trailing `.,;:!?` (mixed with whitespace) does not matter
 * - the result has no surrounding whitespace, no double spaces, no ASCII capitals,
 *   and never ends in `.,;:!?`
 */
describe("Feature: due-queue-normal-quiz, Property 1: question-text normalization", () => {
  const TRAILING = [".", ",", ";", ":", "!", "?"];
  const WHITESPACE = [" ", "  ", "\t", "\n", "\r\n", " "];

  // Characters that exercise every branch: letters of both cases, digits,
  // the trailing-punctuation set, other punctuation, the blank marker, whitespace.
  const charArb = fc.constantFrom(..."aZbYcX09 -_'()".split(""), ...TRAILING, ...WHITESPACE);
  const interestingArb = fc.array(charArb, { maxLength: 40 }).map((chars) => chars.join(""));
  const anyTextArb = fc.oneof(interestingArb, fc.string({ maxLength: 40 }), fc.string({ unit: "binary", maxLength: 40 }));

  const asciiTextArb = fc.oneof(interestingArb, fc.string({ unit: "binary-ascii", maxLength: 40 }).map((s) => s.replace(/[^\x00-\x7f]/g, "")));
  const wordArb = fc.string({ unit: fc.constantFrom(..."abcXYZ019-'_".split("")), minLength: 1, maxLength: 8 });
  const whitespaceRunArb = fc.array(fc.constantFrom(...WHITESPACE), { minLength: 1, maxLength: 3 }).map((ws) => ws.join(""));
  const paddingArb = fc.array(fc.constantFrom(...WHITESPACE), { maxLength: 3 }).map((ws) => ws.join(""));
  const trailingArb = fc.array(fc.constantFrom(...TRAILING, ...WHITESPACE), { minLength: 1, maxLength: 6 }).map((cs) => cs.join(""));

  it("is idempotent", () => {
    fc.assert(
      fc.property(anyTextArb, (text) => {
        const once = normalizeText(text);
        expect(normalizeText(once)).toBe(once);
      }),
      { numRuns: 500 },
    );
  });

  it("ignores ASCII letter case", () => {
    fc.assert(
      fc.property(asciiTextArb, (text) => {
        expect(normalizeText(text.toUpperCase())).toBe(normalizeText(text));
        expect(normalizeText(text.toLowerCase())).toBe(normalizeText(text));
      }),
      { numRuns: 300 },
    );
  });

  it("ignores surrounding and repeated whitespace", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(wordArb, whitespaceRunArb), { minLength: 1, maxLength: 6 }), paddingArb, paddingArb, (parts, lead, tail) => {
        const words = parts.map(([w]) => w);
        const spaced = lead + parts.map(([w, ws], i) => (i < parts.length - 1 ? w + ws : w)).join("") + tail;
        expect(normalizeText(spaced)).toBe(normalizeText(words.join(" ")));
      }),
      { numRuns: 300 },
    );
  });

  it("ignores trailing .,;:!? mixed with whitespace", () => {
    fc.assert(
      fc.property(anyTextArb, trailingArb, (text, tail) => {
        expect(normalizeText(text + tail)).toBe(normalizeText(text));
      }),
      { numRuns: 300 },
    );
  });

  it("produces trimmed, single-spaced, lower-case text with no trailing punctuation", () => {
    fc.assert(
      fc.property(anyTextArb, (text) => {
        const out = normalizeText(text);
        expect(out).toBe(out.trim());
        expect(out).not.toMatch(/\s{2,}/);
        expect(out).not.toMatch(/[A-Z]/);
        expect(out).not.toMatch(/[.,;:!?]$/);
      }),
      { numRuns: 300 },
    );
  });

  it("keeps the words themselves", () => {
    expect(normalizeText("  What is   the Calvin cycle?! ")).toBe("what is the calvin cycle");
    expect(normalizeText("The ____ produces ATP.")).toBe("the ____ produces atp");
  });
});
