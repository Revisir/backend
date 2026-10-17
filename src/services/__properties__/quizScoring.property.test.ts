/** Feature: due-queue-normal-quiz, Property 2: quiz rating bands
 * Validates: R29, R37 */
import * as fc from "fast-check";
import { ratingForScore, scoreQuiz } from "@services/quizScoring";
import { QUIZ } from "@config/questionBank";

/** A quiz result: `scored` questions counted, `correct` of them right. */
const scoreArb = fc.integer({ min: 1, max: 2_000 }).chain((scored) => fc.integer({ min: 0, max: scored }).map((correct) => ({ correct, scored })));

/**
 * The R29 table read literally from the share as a percentage. One division of
 * two exact integers is exact enough: a percentage that is not a band floor
 * misses it by at least 1/scored.
 */
function bandFromTable(correct: number, scored: number): number {
  const percent = (correct * 100) / scored;
  if (percent >= 100) return 5;
  if (percent >= 80) return 4;
  if (percent >= 60) return 3;
  if (percent >= 40) return 2;
  if (percent >= 20) return 1;
  return 0;
}

describe("Feature: due-queue-normal-quiz, Property 2: quiz rating bands", () => {
  it("matches the R29 table for every score", () => {
    fc.assert(
      fc.property(scoreArb, ({ correct, scored }) => {
        expect(ratingForScore(correct, scored)).toBe(bandFromTable(correct, scored));
      }),
      { numRuns: 1_000 },
    );
  });

  it("never decreases as the share correct rises", () => {
    fc.assert(
      fc.property(scoreArb, scoreArb, (a, b) => {
        // Compare the shares a.correct/a.scored and b.correct/b.scored exactly.
        const [low, high] = a.correct * b.scored <= b.correct * a.scored ? [a, b] : [b, a];
        expect(ratingForScore(low.correct, low.scored)).toBeLessThanOrEqual(ratingForScore(high.correct, high.scored));
      }),
      { numRuns: 1_000 },
    );
  });

  it("puts the boundaries at exactly 100%, 80%, 60%, 40% and 20%", () => {
    // With a multiple of five scored, every band floor is a whole count.
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 400 }), fc.integer({ min: 1, max: 5 }), (unit, band) => {
        const scored = 5 * unit;
        const atFloor = band * unit; // exactly band * 20%
        expect(ratingForScore(atFloor, scored)).toBe(band);
        expect(ratingForScore(atFloor - 1, scored)).toBe(band - 1);
      }),
      { numRuns: 1_000 },
    );
  });

  it("gives one point per correct answer in a five-question quiz", () => {
    for (let correct = 0; correct <= 5; correct++) expect(ratingForScore(correct, 5)).toBe(correct);
  });

  it("rates only with at least three scored questions, and ignores flagged ones", () => {
    const questionArb = fc.record({ correct: fc.boolean(), flagged: fc.boolean() });
    fc.assert(
      fc.property(fc.array(questionArb, { maxLength: QUIZ.QUESTIONS_PER_QUIZ }), (questions) => {
        const counted = questions.filter((q) => !q.flagged);
        const correct = counted.filter((q) => q.correct).length;

        const score = scoreQuiz(questions);

        expect(score.scored).toBe(counted.length);
        expect(score.correct).toBe(correct);
        if (counted.length < QUIZ.MIN_SCORED) expect(score.rating).toBeNull();
        else expect(score.rating).toBe(ratingForScore(correct, counted.length));
      }),
      { numRuns: 1_000 },
    );
  });
});
