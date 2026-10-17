import { randomInt } from "node:crypto";
import type { Types } from "mongoose";
import { Topic, type IBankQuestion } from "@models/Topic.js";
import { QuizSession, type IQuizQuestion, type IQuizResult } from "@models/QuizSession.js";
import { recordRevision, AlreadyReviewedTodayError, TopicNotFoundError } from "@services/reviewRecorder.js";
import { isDueToday, isReviewedToday, type LearnerDay } from "@services/learnerDay.js";
import { normalizeText } from "@services/questionText.js";
import { scoreQuiz } from "@services/quizScoring.js";
import { QUIZ } from "@config/questionBank.js";
import { logger } from "@config/logger.js";

const log = logger.child({ module: "quizSession" });

const ERROR_MESSAGES = {
  TOPIC_NOT_FOUND: "Topic not found or access denied",
  ALREADY_REVIEWED_TODAY: "This topic has already been reviewed today",
  NOT_DUE: "This topic is not due for review yet",
  NOT_ENOUGH_QUESTIONS: `A quiz needs at least ${QUIZ.MIN_SCORED} usable questions`,
  SESSION_NOT_FOUND: "Quiz session not found or access denied",
  QUESTION_NOT_FOUND: "Question not found in this quiz",
  NOT_ANSWERED: "Answer the question before flagging it",
  INCOMPLETE: "Answer every question before completing the quiz",
} as const;

export type QuizErrorCode = keyof typeof ERROR_MESSAGES;

/** A refusal from the quiz flow. The controller maps `code` to an HTTP status. */
export class QuizError extends Error {
  constructor(readonly code: QuizErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "QuizError";
  }
}

/** A drawn question as the learner sees it before answering: no answer fields of any kind. */
export interface QuizQuestionView {
  id: string;
  type: "mcq" | "fill_blank";
  prompt: string;
  options?: string[];
}

export interface StartQuizResult {
  sessionId: string;
  topicId: string;
  topicName: string;
  questions: QuizQuestionView[];
}

export interface AnswerResult {
  questionId: string;
  correct: boolean;
  correctAnswer: string;
}

export interface FlagResult {
  questionId: string;
  flagged: true;
}

export interface CompleteQuizResult {
  rating: number | null;
  scored: number;
  correct: number;
  /** ISO timestamp, or null when no review was recorded. */
  nextRevisionDate: string | null;
  results: Array<{ questionId: string; correct: boolean; flagged: boolean; correctAnswer: string }>;
}

/** A shuffled copy (Fisher–Yates over `crypto.randomInt`). */
export function shuffled<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Grades one response (KTD19). Both sides go through `normalizeText`, so case,
 * surrounding and repeated spaces and trailing punctuation are ignored. A blank
 * also accepts any listed alternative. There is no fuzzy matching, and an empty
 * response is always wrong.
 */
export function gradeResponse(question: Pick<IBankQuestion, "type" | "answer" | "alternatives">, response: string): boolean {
  const given = normalizeText(response);
  if (given === "") return false;
  const accepted = question.type === "fill_blank" ? [question.answer, ...(question.alternatives ?? [])] : [question.answer];
  return accepted.some((a) => normalizeText(a) === given);
}

/**
 * Opens a normal quiz on a topic (R21, R22, R37). Checks run in review
 * availability order: missing topic, reviewed today (a reviewed topic is never
 * due, so this goes first), not due, then too few usable questions. Draws
 * `QUIZ.QUESTIONS_PER_QUIZ` questions at random, or every usable one when fewer
 * remain, shuffles each multiple-choice question's options, and snapshots them.
 *
 * @throws QuizError TOPIC_NOT_FOUND | ALREADY_REVIEWED_TODAY | NOT_DUE | NOT_ENOUGH_QUESTIONS
 */
export async function startQuizSession(input: { userId: string; topicId: string; day: LearnerDay }): Promise<StartQuizResult> {
  const { userId, topicId, day } = input;

  const topic = await Topic.findOne({ _id: topicId, userId })
    .select("topicName revisionDate lastRevised +questionBank.questions +retiredQuestions")
    .lean();
  if (!topic) throw new QuizError("TOPIC_NOT_FOUND");
  if (isReviewedToday(topic, day)) throw new QuizError("ALREADY_REVIEWED_TODAY");
  if (!isDueToday(topic, day)) throw new QuizError("NOT_DUE");

  // A flag retires a question by pulling it from the bank; this also covers a
  // build that saved a retired question back between its read and its save.
  const retired = new Set((topic.retiredQuestions ?? []).map((r) => r.key));
  const usable = (topic.questionBank?.questions ?? []).filter((q) => !retired.has(q.key));
  if (usable.length < QUIZ.MIN_SCORED) throw new QuizError("NOT_ENOUGH_QUESTIONS");

  const questions = shuffled(usable).slice(0, QUIZ.QUESTIONS_PER_QUIZ).map(snapshotOf);
  const session = await QuizSession.create({
    userId,
    topicId: topic._id,
    topicName: topic.topicName,
    questions,
    status: "active",
    startedAt: day.now,
    expiresAt: new Date(day.now.getTime() + QUIZ.SESSION_TTL_MS),
  });

  log.info({ userId, topicId: String(topic._id), sessionId: String(session._id), questionCount: questions.length }, "Quiz started");

  return {
    sessionId: session._id.toString(),
    topicId: topic._id.toString(),
    topicName: topic.topicName,
    questions: questions.map(toQuestionView),
  };
}

/**
 * Grades one answer, once (R23, KTD7). The grade is written by a conditional
 * update on the still-unanswered question, so a repeat or a racing answer gets
 * the stored first result back unchanged.
 *
 * @throws QuizError SESSION_NOT_FOUND | QUESTION_NOT_FOUND
 */
export async function answerQuizQuestion(input: { userId: string; sessionId: string; questionId: string; response: string; now?: Date }): Promise<AnswerResult> {
  const { userId, sessionId, questionId, response, now = new Date() } = input;

  const session = await findLiveSession(userId, sessionId, now);
  const question = findQuestion(session.questions, questionId);
  if (question.answeredAt) return toAnswerResult(question);

  const correct = gradeResponse(question, response);
  const { matchedCount } = await QuizSession.updateOne(
    { _id: session._id, userId, questions: { $elemMatch: { id: questionId, answeredAt: null } } },
    { $set: { "questions.$.response": response, "questions.$.correct": correct, "questions.$.answeredAt": now } },
  );
  if (matchedCount === 1) return { questionId, correct, correctAnswer: question.answer };

  // Another answer to this question landed first.
  const current = await findLiveSession(userId, sessionId, now);
  return toAnswerResult(findQuestion(current.questions, questionId));
}

/**
 * Flags an answered question as bad (R25, R26). The whole question is left out
 * of this quiz's score and retired on the topic straight away, so it survives an
 * abandoned quiz (R28) and never comes back to the bank. Repeat flags are
 * no-ops that return the same result. Flagging after completion still retires
 * the question but leaves the stored result as it was.
 *
 * @throws QuizError SESSION_NOT_FOUND | QUESTION_NOT_FOUND | NOT_ANSWERED
 */
export async function flagQuizQuestion(input: { userId: string; sessionId: string; questionId: string; now?: Date }): Promise<FlagResult> {
  const { userId, sessionId, questionId, now = new Date() } = input;

  const session = await findLiveSession(userId, sessionId, now);
  const question = findQuestion(session.questions, questionId);
  if (!question.answeredAt) throw new QuizError("NOT_ANSWERED");

  if (!question.flagged) {
    await QuizSession.updateOne({ _id: session._id, userId, "questions.id": questionId }, { $set: { "questions.$.flagged": true } });
  }
  // Always run: both writes are guarded, and a retry after a failed write completes the retirement.
  await retireQuestion({ userId, topicId: session.topicId, key: question.key, text: question.prompt, now });

  log.info({ userId, sessionId, questionId }, "Quiz question flagged");
  return { questionId, flagged: true };
}

/**
 * Retires a question on its topic: adds it to the append-only retired list
 * (once per key) and removes it from the bank, decrementing `usableCount` only
 * when the question was still there. Both writes are idempotent.
 */
export async function retireQuestion(input: { userId: string; topicId: Types.ObjectId | string; key: string; text: string; now: Date }): Promise<void> {
  const { userId, topicId, key, text, now } = input;
  await Topic.updateOne({ _id: topicId, userId, "retiredQuestions.key": { $ne: key } }, { $push: { retiredQuestions: { key, text, retiredAt: now } } });
  await Topic.updateOne(
    { _id: topicId, userId, "questionBank.questions.key": key },
    { $pull: { "questionBank.questions": { key } }, $inc: { "questionBank.usableCount": -1 } },
  );
}

/**
 * Finishes a quiz (R27, R29, R30, R37, R43). Every question must be answered.
 * Flagged questions are left out of the score; with at least three scored, the
 * rating is recorded once as a `normal_quiz` review. With fewer, nothing is
 * recorded and the topic stays due. The result is stored on the session, and a
 * repeat completion returns it.
 *
 * When the day is already claimed by this session's own review (a concurrent
 * completion of the same session won), that review is returned; when it is
 * claimed by anything else, ALREADY_REVIEWED_TODAY, recording nothing and
 * leaving the session open.
 *
 * @throws QuizError SESSION_NOT_FOUND | INCOMPLETE | ALREADY_REVIEWED_TODAY | TOPIC_NOT_FOUND
 */
export async function completeQuizSession(input: { userId: string; sessionId: string; day: LearnerDay }): Promise<CompleteQuizResult> {
  const { userId, sessionId, day } = input;
  const now = day.now;

  const session = await findLiveSession(userId, sessionId, now);
  if (session.status === "completed" && session.result) return toCompleteResult(session.result);
  if (session.questions.some((q) => !q.answeredAt)) throw new QuizError("INCOMPLETE");

  const score = scoreQuiz(session.questions);
  let nextRevisionDate: Date | null = null;
  if (score.rating !== null) {
    nextRevisionDate = await recordQuizReview({ userId, session, rating: score.rating, scored: score.scored, correct: score.correct, day });
  }

  const result: IQuizResult = {
    rating: score.rating,
    scored: score.scored,
    correct: score.correct,
    nextRevisionDate,
    results: session.questions.map((q) => ({ questionId: q.id, correct: q.correct === true, flagged: q.flagged, correctAnswer: q.answer })),
  };

  const stored = await QuizSession.findOneAndUpdate(
    { _id: session._id, userId, status: "active" },
    { $set: { status: "completed", result, completedAt: now, expiresAt: new Date(now.getTime() + QUIZ.COMPLETED_TTL_MS) } },
    { returnDocument: "after" },
  ).lean();
  if (stored?.result) {
    log.info({ userId, sessionId, rating: result.rating, scored: result.scored, correct: result.correct }, "Quiz completed");
    return toCompleteResult(stored.result);
  }

  // A concurrent completion of this session stored its result first.
  const current = await QuizSession.findOne({ _id: session._id, userId }).lean();
  return toCompleteResult(current?.result ?? result);
}

async function recordQuizReview(input: {
  userId: string;
  session: { _id: Types.ObjectId; topicId: Types.ObjectId };
  rating: number;
  scored: number;
  correct: number;
  day: LearnerDay;
}): Promise<Date> {
  const { userId, session, rating, scored, correct, day } = input;
  try {
    const revision = await recordRevision({
      userId,
      topicId: session.topicId,
      userQuality: rating,
      method: "normal_quiz",
      quizScored: scored,
      quizCorrect: correct,
      sessionId: session._id,
      day,
    });
    return revision.nextRevisionDate;
  } catch (err) {
    if (err instanceof TopicNotFoundError) throw new QuizError("TOPIC_NOT_FOUND");
    if (err instanceof AlreadyReviewedTodayError) throw new QuizError("ALREADY_REVIEWED_TODAY");
    throw err;
  }
}

/** The user's session, unless it is missing, another user's, or past its expiry (the TTL monitor deletes lazily). */
async function findLiveSession(userId: string, sessionId: string, now: Date) {
  const session = await QuizSession.findOne({ _id: sessionId, userId, expiresAt: { $gt: now } }).lean();
  if (!session) throw new QuizError("SESSION_NOT_FOUND");
  return session;
}

function findQuestion<Q extends { id: string }>(questions: Q[], questionId: string): Q {
  const question = questions.find((q) => q.id === questionId);
  if (!question) throw new QuizError("QUESTION_NOT_FOUND");
  return question;
}

function snapshotOf(q: IBankQuestion): IQuizQuestion {
  const isMcq = q.type === "mcq";
  return {
    id: q.id,
    key: q.key,
    type: q.type,
    prompt: q.prompt,
    options: isMcq ? shuffled(q.options ?? []) : undefined,
    answer: q.answer,
    alternatives: isMcq ? undefined : q.alternatives,
    response: null,
    correct: null,
    answeredAt: null,
    flagged: false,
  };
}

function toQuestionView(q: IQuizQuestion): QuizQuestionView {
  return q.type === "mcq" ? { id: q.id, type: q.type, prompt: q.prompt, options: [...(q.options ?? [])] } : { id: q.id, type: q.type, prompt: q.prompt };
}

function toAnswerResult(q: Pick<IQuizQuestion, "id" | "correct" | "answer">): AnswerResult {
  return { questionId: q.id, correct: q.correct === true, correctAnswer: q.answer };
}

function toCompleteResult(result: IQuizResult): CompleteQuizResult {
  return {
    rating: result.rating ?? null,
    scored: result.scored,
    correct: result.correct,
    nextRevisionDate: result.nextRevisionDate ? new Date(result.nextRevisionDate).toISOString() : null,
    results: result.results.map((r) => ({ questionId: r.questionId, correct: r.correct, flagged: r.flagged, correctAnswer: r.correctAnswer })),
  };
}
