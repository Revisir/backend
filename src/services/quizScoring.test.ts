/**
 * Normal-quiz rating bands (R29), the three-question minimum (R37) and the
 * flagged-question exclusion (R26), by example. The exhaustive version is
 * `__properties__/quizScoring.property.test.ts`.
 */
import { ratingForScore, scoreQuiz } from "@services/quizScoring";

describe("ratingForScore", () => {
  it.each([
    // A five-question quiz: one point per correct answer.
    [5, 5, 5],
    [4, 5, 4],
    [3, 5, 3],
    [2, 5, 2],
    [1, 5, 1],
    [0, 5, 0],
    // Four scored after one flag.
    [4, 4, 5],
    [3, 4, 3], // 75%
    [2, 4, 2], // 50%
    [1, 4, 1], // 25%
    [0, 4, 0],
    // Three scored.
    [3, 3, 5],
    [2, 3, 3], // 66.7%
    [1, 3, 1], // 33.3%
    [0, 3, 0],
    // Exact band floors and the counts just below them.
    [100, 100, 5],
    [99, 100, 4],
    [80, 100, 4],
    [79, 100, 3],
    [60, 100, 3],
    [59, 100, 2],
    [40, 100, 2],
    [39, 100, 1],
    [20, 100, 1],
    [19, 100, 0],
  ])("rates %i of %i correct as %i", (correct, scored, rating) => {
    expect(ratingForScore(correct, scored)).toBe(rating);
  });

  it.each([
    [0, 0],
    [4, 3],
    [-1, 3],
    [1.5, 3],
    [1, 2.5],
  ])("refuses %p correct of %p scored", (correct, scored) => {
    expect(() => ratingForScore(correct, scored)).toThrow(RangeError);
  });
});

describe("scoreQuiz", () => {
  const right = { correct: true, flagged: false };
  const wrong = { correct: false, flagged: false };
  const flaggedRight = { correct: true, flagged: true };
  const flaggedWrong = { correct: false, flagged: true };

  it("covers AE1: three correct of four scored, with one miss flagged, rates a 3", () => {
    expect(scoreQuiz([right, right, right, wrong, flaggedWrong])).toEqual({ scored: 4, correct: 3, rating: 3 });
  });

  it("leaves a flagged correct answer out of both counts", () => {
    expect(scoreQuiz([right, right, right, flaggedRight, wrong])).toEqual({ scored: 4, correct: 3, rating: 3 });
  });

  it("rates three of three correct as a 5", () => {
    expect(scoreQuiz([right, right, right])).toEqual({ scored: 3, correct: 3, rating: 5 });
  });

  it("rates an all-wrong quiz 0 rather than no rating", () => {
    expect(scoreQuiz([wrong, wrong, wrong, wrong, wrong])).toEqual({ scored: 5, correct: 0, rating: 0 });
  });

  it("covers AE4: every question flagged gives no rating", () => {
    expect(scoreQuiz([flaggedRight, flaggedWrong, flaggedRight, flaggedRight, flaggedWrong])).toEqual({ scored: 0, correct: 0, rating: null });
  });

  it("covers AE10: three of five flagged leaves two scored and no rating", () => {
    expect(scoreQuiz([right, right, flaggedRight, flaggedWrong, flaggedRight])).toEqual({ scored: 2, correct: 2, rating: null });
  });

  it("counts an unanswered question as scored but not correct", () => {
    expect(scoreQuiz([right, right, { correct: null, flagged: false }])).toEqual({ scored: 3, correct: 2, rating: 3 });
  });
});
