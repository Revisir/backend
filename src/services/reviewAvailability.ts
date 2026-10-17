import type { IQuestionBank } from "@models/Topic.js";
import { QUIZ } from "@config/questionBank.js";
import { summarizeAttachments, type AttachmentSummary, type TopicAttachments } from "@services/attachments.js";
import { isDueToday, isReviewedToday, type LearnerDay } from "@services/learnerDay.js";
import { toQuestionBankView, type QuestionBankView } from "@services/questionBankView.js";
import { estimateRetention, previewIntervals } from "@services/sm2Algorithm.js";
import type { QuizAvailability, ReasonCode, TopicReviewFields } from "$types/topic.types.js";

export type { ReasonCode } from "$types/topic.types.js";

/**
 * Review availability (KTD10): what the learner can do with a topic right now,
 * computed on the server so the client renders it and never re-derives it.
 * Pure: the caller supplies the learner day, the instant and the AI config.
 */

/** The topic fields availability reads. A `.lean()` topic satisfies it. */
export interface ReviewTopic extends TopicAttachments {
  revisionDate: Date;
  lastRevised?: Date | null;
  createdAt?: Date | null;
  interval: number;
  eFactor: number;
  repetitionNumber: number;
  lastQuality?: number | null;
  /** Missing on topics saved before banks existed; reads as `none`. */
  questionBank?: Partial<IQuestionBank> | null;
}

export interface ReviewContext {
  day: LearnerDay;
  now: Date;
  /** `isAIConfigured()`: an LLM key is present, or the provider is local. */
  aiConfigured: boolean;
}

export type ReviewState = TopicReviewFields;

function quiz(reason: ReasonCode | null): QuizAvailability {
  return { available: reason === null, reason };
}

/** Rules shared by both quizzes, in order: reviewed today, not due, no files or URLs (any status). */
function sharedReason(topic: ReviewTopic, day: LearnerDay, materials: AttachmentSummary): ReasonCode | null {
  if (isReviewedToday(topic, day)) return "done_today";
  if (!isDueToday(topic, day)) return "not_due";
  if (materials.total === 0) return "no_materials";
  return null;
}

/**
 * Normal quiz. A usable bank wins whatever its state, so a ready bank stays
 * usable while new material extracts, during a rebuild, and after a rebuild
 * that ended empty or failed (R38). A quiz needs `QUIZ.MIN_SCORED` questions.
 */
function normalQuizReason(shared: ReasonCode | null, bank: QuestionBankView, materials: AttachmentSummary, aiConfigured: boolean): ReasonCode | null {
  if (shared) return shared;
  if (bank.usableCount >= QUIZ.MIN_SCORED) return null;
  if (bank.usableCount > 0) return "not_enough_questions";
  if (!aiConfigured) return "ai_not_configured";
  if (materials.inFlight > 0) return "materials_processing";
  if (bank.state === "queued" || bank.state === "building") return "preparing_questions";
  // Stale attachments count as failed (summarizeAttachments).
  if (materials.failed === materials.total) return "extraction_failed";
  return "no_questions";
}

/** AI quiz: needs an LLM and at least one extracted attachment. */
function aiQuizReason(shared: ReasonCode | null, materials: AttachmentSummary, aiConfigured: boolean): ReasonCode | null {
  if (shared) return shared;
  if (!aiConfigured) return "ai_not_configured";
  if (materials.completed > 0) return null;
  if (materials.inFlight > 0) return "materials_processing";
  return "extraction_failed";
}

/**
 * The review fields of a due-list item or topic-detail response: the last
 * rating, the recall estimate, the interval each rating 0–5 would produce,
 * the bank's public view, and each quiz's availability with its reason.
 */
export function computeReviewState(topic: ReviewTopic, { day, now, aiConfigured }: ReviewContext): ReviewState {
  const materials = summarizeAttachments(topic, now);
  const questionBank = toQuestionBankView(topic.questionBank);
  const shared = sharedReason(topic, day, materials);

  return {
    lastQuality: topic.lastQuality ?? null,
    estimatedRecall: estimateRetention(topic, now),
    nextIntervals: previewIntervals(topic),
    questionBank,
    review: {
      doneToday: isReviewedToday(topic, day),
      normalQuiz: {
        ...quiz(normalQuizReason(shared, questionBank, materials, aiConfigured)),
        questionCount: Math.min(QUIZ.QUESTIONS_PER_QUIZ, questionBank.usableCount),
      },
      aiQuiz: quiz(aiQuizReason(shared, materials, aiConfigured)),
    },
  };
}

/**
 * A topic shaped for a response: its stored fields plus the review fields.
 * The stored bank subdocument is replaced by its three-field view, and the
 * retired list is dropped even if a caller selected it.
 */
export function withReviewState<T extends ReviewTopic & { retiredQuestions?: unknown }>(topic: T, ctx: ReviewContext): Omit<T, "questionBank" | "retiredQuestions"> & ReviewState {
  const { retiredQuestions: _retired, questionBank: _bank, ...stored } = topic;
  return { ...stored, ...computeReviewState(topic, ctx) };
}
