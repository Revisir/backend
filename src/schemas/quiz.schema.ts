import { z } from "zod";

const mongoIdRegex = /^[0-9a-fA-F]{24}$/;

const questionId = z.string({ error: "Question ID must be a string" }).min(1, "Question ID is required").max(100, "Question ID is too long");

export const startQuizSchema = z.object({
  topicId: z.string({ error: "Topic ID must be a string" }).regex(mongoIdRegex, "Invalid topic ID format"),
});

export const quizSessionParamsSchema = z.object({
  sessionId: z.string().regex(mongoIdRegex, "Invalid session ID format"),
});

export const answerQuizQuestionSchema = z.object({
  questionId,
  /** The chosen option's text for multiple choice, or the typed text for a blank. An empty answer is graded wrong. */
  response: z.string({ error: "Response must be a string" }).max(1000, "Response must be at most 1000 characters"),
});

export const flagQuizQuestionSchema = z.object({
  questionId,
});

export type StartQuizInput = z.infer<typeof startQuizSchema>;
export type QuizSessionParams = z.infer<typeof quizSessionParamsSchema>;
export type AnswerQuizQuestionInput = z.infer<typeof answerQuizQuestionSchema>;
export type FlagQuizQuestionInput = z.infer<typeof flagQuizQuestionSchema>;
