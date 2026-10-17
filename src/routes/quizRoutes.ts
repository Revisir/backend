import { Router } from "express";
import { startQuiz, answerQuiz, flagQuiz, completeQuiz } from "@controllers/quizController.js";

// No requireAIConfig: a normal quiz draws from the stored question bank and never calls an LLM.
const router = Router();

/*
 * Normal quiz (R21–R31, R37, R43). Every error has the shape
 * { error: { code: string, message: string } }. On every route:
 * - 400 VALIDATION_ERROR: malformed body, or a :sessionId that is not an ObjectId
 * - 500 INTERNAL_SERVER_ERROR
 */

/**
 * POST /api/quiz/start
 * Open a normal quiz on a due topic. Draws five random questions from the bank,
 * or every remaining one when fewer than five remain, and snapshots them, so a
 * bank rebuild cannot change an open quiz.
 *
 * Request body:
 * - topicId: string (MongoDB ObjectId)
 *
 * Response:
 * - 201: { sessionId: string, topicId: string, topicName: string,
 *          questions: [{ id: string, type: "mcq" | "fill_blank", prompt: string, options?: string[] }] }
 *   No answer fields of any kind. Multiple-choice options are shuffled; a
 *   fill-in-the-blank prompt marks the blank with "____".
 * - 404 TOPIC_NOT_FOUND: no such topic for this user
 * - 409 ALREADY_REVIEWED_TODAY: the topic has a review in the learner's current day (checked before NOT_DUE)
 * - 409 NOT_DUE: the topic's revision date is after today
 * - 409 NOT_ENOUGH_QUESTIONS: fewer than three usable questions in the bank
 */
router.post("/start", startQuiz);

/**
 * POST /api/quiz/:sessionId/answer
 * Grade one answer. Multiple choice compares the option text; a blank ignores
 * case, extra spaces and trailing punctuation and accepts listed alternatives
 * (no fuzzy matching). A question is graded once: a repeat returns the stored
 * first result unchanged.
 *
 * Request body:
 * - questionId: string
 * - response: string (the chosen option's text, or the typed text; at most 1000 characters; empty is graded wrong)
 *
 * Response:
 * - 200: { questionId: string, correct: boolean, correctAnswer: string }
 * - 404 SESSION_NOT_FOUND: unknown, expired, or another user's session
 * - 404 QUESTION_NOT_FOUND: questionId is not in this session (addition to the contract)
 */
router.post("/:sessionId/answer", answerQuiz);

/**
 * POST /api/quiz/:sessionId/flag
 * Flag an answered question as bad. The whole question leaves this quiz's score
 * and is retired on the topic immediately (added to the retired list and pulled
 * from the bank), so it stays retired even if the quiz is abandoned. A repeat
 * flag returns the same 200. Flagging after completion still retires the
 * question and returns 200, but leaves the stored completion result unchanged
 * (addition to the contract).
 *
 * Request body:
 * - questionId: string
 *
 * Response:
 * - 200: { questionId: string, flagged: true }
 * - 404 SESSION_NOT_FOUND: unknown, expired, or another user's session
 * - 404 QUESTION_NOT_FOUND: questionId is not in this session (addition to the contract)
 * - 409 NOT_ANSWERED: the question's answer has not been revealed yet
 */
router.post("/:sessionId/flag", flagQuiz);

/**
 * POST /api/quiz/:sessionId/complete
 * Finish the quiz. Flagged questions are not scored. With at least three scored
 * questions, the rating comes from the share correct (100% → 5, 80–99% → 4,
 * 60–79% → 3, 40–59% → 2, 20–39% → 1, under 20% → 0) and is recorded once as a
 * normal_quiz review with its scored and correct counts. With fewer, nothing is
 * recorded and the topic stays due. A repeat returns the stored result.
 *
 * Request body: none
 *
 * Response:
 * - 200: { rating: number | null, scored: number, correct: number, nextRevisionDate: string (ISO) | null,
 *          results: [{ questionId: string, correct: boolean, flagged: boolean, correctAnswer: string }] }
 *   rating and nextRevisionDate are null when fewer than three questions were scored.
 * - 404 SESSION_NOT_FOUND: unknown, expired, or another user's session
 * - 404 TOPIC_NOT_FOUND: the topic was deleted during the quiz (addition to the contract)
 * - 409 INCOMPLETE: a question is still unanswered
 * - 409 ALREADY_REVIEWED_TODAY: the topic was reviewed elsewhere today; nothing is recorded and the session stays open
 */
router.post("/:sessionId/complete", completeQuiz);

export default router;
