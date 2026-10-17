import type { BankState } from "@models/Topic.js";

export interface GetTopicsQuery {
  page?: string;
  limit?: string;
  subject?: string;
}

export interface GetTopicsResponse {
  topics: any[];
  total: number;
  page: number;
}

/** Why a review action cannot run. The first matching availability rule wins (KTD10). */
export type ReasonCode =
  | "done_today"
  | "not_due"
  | "no_materials"
  | "not_enough_questions"
  | "ai_not_configured"
  | "materials_processing"
  | "preparing_questions"
  | "extraction_failed"
  | "no_questions";

export interface QuizAvailability {
  available: boolean;
  /** Null exactly when `available` is true. */
  reason: ReasonCode | null;
}

export interface NormalQuizAvailability extends QuizAvailability {
  /** `min(QUIZ.QUESTIONS_PER_QUIZ, usableCount)`: the Start quiz label. */
  questionCount: number;
}

export interface TopicReviewAvailability {
  /** Reviewed in the learner's current day. */
  doneToday: boolean;
  normalQuiz: NormalQuizAvailability;
  aiQuiz: QuizAvailability;
}

/** The only view of a question bank a topic response carries: never questions, answers or the retired list. */
export interface TopicQuestionBankSummary {
  state: BankState;
  /** Questions available to draw now; previous questions count during a rebuild. */
  usableCount: number;
  /** Queued or building while previous questions remain usable. */
  rebuilding: boolean;
}

/** Fields added to every `GET /api/topics/due` item and to `GET /api/topics/:id`. */
export interface TopicReviewFields {
  /** Final rating of the latest review; null before the first. Older records may hold halves. */
  lastQuality: number | null;
  /** Estimated chance of remembering the topic now, 0..1 (KTD12). */
  estimatedRecall: number;
  /** Length 6; index = rating 0..5; days until the next review if rated that now. */
  nextIntervals: number[];
  questionBank: TopicQuestionBankSummary;
  review: TopicReviewAvailability;
}
