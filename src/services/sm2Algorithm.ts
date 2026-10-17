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
 * @param now - The review instant the next revision date counts from
 * @returns Updated topic state with next revision date
 */
export function calculateNextReview(input: SM2Input, now: Date = new Date()): SM2Result {
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
  const nextRevisionDate = new Date(now);
  nextRevisionDate.setDate(nextRevisionDate.getDate() + newInterval);

  return {
    eFactor: newEFactor,
    repetitionNumber: newRepetition,
    interval: newInterval,
    nextRevisionDate
  };
}

/** Retention the SM-2 schedule aims for when a review falls due. */
const RETENTION_AT_DUE = 0.9;
/** Stability per day of interval: `S = interval / -ln(0.9)`, so retention is 0.9 when a review falls due. */
const STABILITY_PER_INTERVAL_DAY = -1 / Math.log(RETENTION_AT_DUE);
const DAY_MS = 86_400_000;

/**
 * Retention `days` after a review on an interval of `intervalDays` (KTD12):
 * `e^(-t/S)` with `S = interval / -ln(0.9)`, so retention is 0.9 when the
 * review falls due. Shared by the forgetting curve and the recall estimate.
 */
export function retentionAt(days: number, intervalDays: number): number {
  return Math.exp(-days / (intervalDays * STABILITY_PER_INTERVAL_DAY));
}

/** The topic fields the recall estimate reads. */
export interface RetentionInput {
  interval: number;
  lastRevised?: Date | string | null;
  createdAt?: Date | string | null;
}

/**
 * The estimated chance of remembering the topic at `now`, in [0, 1] (R7, KTD12).
 * Time counts from the later of the last review and the topic's creation, so a
 * never-reviewed topic decays from when it was added.
 */
export function estimateRetention(topic: RetentionInput, now: Date = new Date()): number {
  const anchors = [topic.lastRevised, topic.createdAt].filter((d): d is Date | string => d != null).map((d) => new Date(d).getTime());
  if (anchors.length === 0) return 1;

  const days = Math.max(0, (now.getTime() - Math.max(...anchors)) / DAY_MS);
  const interval = Number.isFinite(topic.interval) && topic.interval > 0 ? topic.interval : 1;
  return Math.min(1, Math.max(0, retentionAt(days, interval)));
}

/** Days until the next review for each rating 0–5 if the topic were rated now (R32). Index = rating. */
export function previewIntervals(state: Pick<SM2Input, "eFactor" | "repetitionNumber" | "interval">): number[] {
  return [0, 1, 2, 3, 4, 5].map((quality) => calculateNextReview({ ...state, quality }).interval);
}
