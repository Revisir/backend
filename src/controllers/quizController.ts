import type { Request, Response } from "express";
import type { ZodError } from "zod";
import type { ErrorResponse } from "$types/common.types.js";
import { startQuizSchema, quizSessionParamsSchema, answerQuizQuestionSchema, flagQuizQuestionSchema } from "@/schemas/index.js";
import { startQuizSession, answerQuizQuestion, flagQuizQuestion, completeQuizSession, QuizError, type QuizErrorCode } from "@services/quizSession.js";
import { getLearnerDay } from "@services/learnerDay.js";
import { logger } from "@config/logger.js";

const log = logger.child({ module: "quizController" });

const STATUS_BY_CODE: Record<QuizErrorCode, number> = {
  TOPIC_NOT_FOUND: 404,
  SESSION_NOT_FOUND: 404,
  QUESTION_NOT_FOUND: 404,
  ALREADY_REVIEWED_TODAY: 409,
  NOT_DUE: 409,
  NOT_ENOUGH_QUESTIONS: 409,
  NOT_ANSWERED: 409,
  INCOMPLETE: 409,
};

/** POST /api/quiz/start */
export async function startQuiz(req: Request, res: Response): Promise<void> {
  const body = startQuizSchema.safeParse(req.body);
  if (!body.success) return sendValidationError(res, body.error);

  try {
    const result = await startQuizSession({ userId: req.userId!, topicId: body.data.topicId, day: getLearnerDay(req) });
    res.status(201).json(result);
  } catch (err) {
    sendError(res, err, "Failed to start quiz");
  }
}

/** POST /api/quiz/:sessionId/answer */
export async function answerQuiz(req: Request, res: Response): Promise<void> {
  const params = quizSessionParamsSchema.safeParse(req.params);
  if (!params.success) return sendValidationError(res, params.error);
  const body = answerQuizQuestionSchema.safeParse(req.body);
  if (!body.success) return sendValidationError(res, body.error);

  try {
    const result = await answerQuizQuestion({ userId: req.userId!, sessionId: params.data.sessionId, ...body.data });
    res.status(200).json(result);
  } catch (err) {
    sendError(res, err, "Failed to grade answer");
  }
}

/** POST /api/quiz/:sessionId/flag */
export async function flagQuiz(req: Request, res: Response): Promise<void> {
  const params = quizSessionParamsSchema.safeParse(req.params);
  if (!params.success) return sendValidationError(res, params.error);
  const body = flagQuizQuestionSchema.safeParse(req.body);
  if (!body.success) return sendValidationError(res, body.error);

  try {
    const result = await flagQuizQuestion({ userId: req.userId!, sessionId: params.data.sessionId, questionId: body.data.questionId });
    res.status(200).json(result);
  } catch (err) {
    sendError(res, err, "Failed to flag question");
  }
}

/** POST /api/quiz/:sessionId/complete */
export async function completeQuiz(req: Request, res: Response): Promise<void> {
  const params = quizSessionParamsSchema.safeParse(req.params);
  if (!params.success) return sendValidationError(res, params.error);

  try {
    const result = await completeQuizSession({ userId: req.userId!, sessionId: params.data.sessionId, day: getLearnerDay(req) });
    res.status(200).json(result);
  } catch (err) {
    sendError(res, err, "Failed to complete quiz");
  }
}

function sendValidationError(res: Response, error: ZodError): void {
  res.status(400).json({ error: { code: "VALIDATION_ERROR", message: error.issues[0].message } } as ErrorResponse);
}

function sendError(res: Response, err: unknown, message: string): void {
  if (err instanceof QuizError) {
    res.status(STATUS_BY_CODE[err.code]).json({ error: { code: err.code, message: err.message } } as ErrorResponse);
    return;
  }
  log.error({ err }, message);
  res.status(500).json({ error: { code: "INTERNAL_SERVER_ERROR", message } } as ErrorResponse);
}
