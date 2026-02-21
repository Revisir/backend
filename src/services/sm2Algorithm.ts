/**
 * SM-2 Algorithm Implementation
 * 
 * Based on the SuperMemo 2 algorithm for spaced repetition learning.
 * Calculates optimal review intervals based on user performance.
 * 
 * References:
 * - https://www-beta.supermemo.com/archives1990-2015/english/ol/sm2
 */

/**
 * Input parameters for SM-2 algorithm calculation
 */
export interface SM2Input {
  eFactor: number;          // Current E-Factor (1.3 to 2.5)
  repetitionNumber: number; // Current repetition count (0, 1, 2, ...)
  interval: number;         // Current interval in days
  quality: number;          // Quality rating (0-5 scale)
}

/**
 * Output result from SM-2 algorithm calculation
 */
export interface SM2Result {
  eFactor: number;          // Updated E-Factor (1.3 to 2.5)
  repetitionNumber: number; // Updated repetition count
  interval: number;         // Updated interval in days
  nextRevisionDate: Date;   // Calculated next revision date
}

/**
 * Calculate the next review schedule using the SM-2 algorithm
 * 
 * Algorithm rules:
 * 1. E-Factor update: EF' = EF + (0.1 - (5-q) * (0.08 + (5-q) * 0.02))
 * 2. E-Factor boundaries: 1.3 <= EF <= 2.5
 * 3. Interval calculation:
 *    - I(1) = 1 day
 *    - I(2) = 6 days
 *    - I(n) = I(n-1) * EF (for n > 2)
 * 4. Reset logic: If quality < 3, reset repetition to 0 and interval to 1
 * 
 * @param input - Current topic state and quality rating
 * @returns Updated topic state with next revision date
 */
export function calculateNextReview(input: SM2Input): SM2Result {
  const { eFactor, repetitionNumber, interval, quality } = input;

  // Calculate new E-Factor using SM-2 formula
  let newEFactor = eFactor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
  
  // Enforce E-Factor boundaries (1.3 to 2.5)
  if (newEFactor < 1.3) {
    newEFactor = 1.3;
  }
  if (newEFactor > 2.5) {
    newEFactor = 2.5;
  }

  let newRepetition: number;
  let newInterval: number;

  // Reset logic for quality < 3 (failed review)
  if (quality < 3) {
    newRepetition = 0;
    newInterval = 1;
  } else {
    // Progress forward for successful review (quality >= 3)
    newRepetition = repetitionNumber + 1;

    // Calculate interval based on repetition number
    if (newRepetition === 1) {
      newInterval = 1;
    } else if (newRepetition === 2) {
      newInterval = 6;
    } else {
      // For n > 2: I(n) = I(n-1) * EF
      newInterval = Math.round(interval * newEFactor);
    }
  }

  // Calculate next revision date
  const nextRevisionDate = new Date();
  nextRevisionDate.setDate(nextRevisionDate.getDate() + newInterval);

  return {
    eFactor: newEFactor,
    repetitionNumber: newRepetition,
    interval: newInterval,
    nextRevisionDate
  };
}
