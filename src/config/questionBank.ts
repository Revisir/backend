/**
 * Tunables for question banks, normal quizzes and the attachment staleness
 * window. Deployment config stays unchanged: none of these are env vars.
 */
export const QUESTION_BANK = {
  /** Question-answer pairs asked of the extractor per bank build. Review and formatting keep roughly 60–70%. */
  EXTRACTION_COUNT: 25,
  /** The AI chat keeps its original extraction size. */
  CHAT_EXTRACTION_COUNT: 10,
  /** Questions kept from one build. */
  MAX_BANK_SIZE: 20,
  /** Material sent to the LLM per build, in characters. Larger material is truncated and logged. */
  MATERIAL_CHAR_CAP: 120_000,
  /** Attempts per LLM pipeline step before the build is saved as failed. */
  LLM_ATTEMPTS: 3,
  /** First retry delay; doubles per attempt. */
  LLM_RETRY_BASE_MS: 1_000,
  /** A `building` claim older than this is abandoned and may be reclaimed. */
  STALE_CLAIM_MS: 15 * 60_000,
  /** How often the file-processor process sweeps for stalled banks and attachments. */
  SWEEP_INTERVAL_MS: 5 * 60_000,
  /** Sweep republishes of one stalled bank before it is marked failed. */
  SWEEP_MAX_ATTEMPTS: 3,
} as const;

/** An attachment left pending or processing for longer than this counts as failed. */
export const ATTACHMENT_STALE_MS = 60 * 60_000;

export const QUIZ = {
  /** Questions drawn per quiz (R22). */
  QUESTIONS_PER_QUIZ: 5,
  /** Fewest scored questions that can produce a rating (R37). */
  MIN_SCORED: 3,
  /** Options on every multiple-choice question. */
  MCQ_OPTIONS: 4,
  /** Unfinished sessions expire this long after they start. */
  SESSION_TTL_MS: 24 * 60 * 60_000,
  /** Completed sessions are kept this long so repeat completions return the stored result. */
  COMPLETED_TTL_MS: 7 * 24 * 60 * 60_000,
} as const;
