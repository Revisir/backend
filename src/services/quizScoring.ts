import { QUIZ } from "@config/questionBank.js";

/**
 * Lowest share correct, in percent, for each rating from 5 down to 1 (R29).
 * Anything under the last floor rates 0.
 */
const BAND_FLOORS: ReadonlyArray<readonly [percent: number, rating: number]> = [
  [100, 5],
  [80, 4],
  [60, 3],
  [40, 2],
  [20, 1],
];

/**
 * The rating a normal quiz earns from its share of scored questions answered
 * correctly (R29): 100% gives 5, 80–99% 4, 60–79% 3, 40–59% 2, 20–39% 1, and
 * under 20% 0. Compared with integer arithmetic (`correct * 100 >= floor * scored`)
 * so a share that lands exactly on a floor is never lost to rounding.
 *
 * @throws RangeError unless `scored` is a positive integer and `correct` an integer in `0..scored`
 */
export function ratingForScore(correct: number, scored: number): number {
  if (!Number.isInteger(scored) || scored < 1) throw new RangeError(`scored must be a positive integer, got ${scored}`);
  if (!Number.isInteger(correct) || correct < 0 || correct > scored) throw new RangeError(`correct must be an integer in 0..${scored}, got ${correct}`);

  for (const [percent, rating] of BAND_FLOORS) {
    if (correct * 100 >= percent * scored) return rating;
  }
  return 0;
}

export interface QuizScore {
  /** Questions that count toward the score: every question not flagged. */
  scored: number;
  /** Scored questions answered correctly. */
  correct: number;
  /** The R29 band, or null when fewer than `QUIZ.MIN_SCORED` questions were scored (R37). */
  rating: number | null;
}

/**
 * Scores a quiz. Flagged questions are left out of both counts (R26); a quiz
 * left with fewer than three scored questions earns no rating (R30, R37).
 */
export function scoreQuiz(questions: ReadonlyArray<{ correct: boolean | null; flagged: boolean }>): QuizScore {
  const counted = questions.filter((q) => !q.flagged);
  const scored = counted.length;
  const correct = counted.filter((q) => q.correct === true).length;
  return { scored, correct, rating: scored < QUIZ.MIN_SCORED ? null : ratingForScore(correct, scored) };
}
