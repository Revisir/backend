import { Request, Response } from "express";
import { Topic } from "@models/Topic.js";
import { ChatSession } from "@models/ChatSession.js";
import { buildChatContext, assessStudentPerformance } from "@services/chatContext.js";
import { generateQuestions, evaluateAnswer } from "@services/questionAgent.js";
import { ErrorResponse } from "$types/common.types.js";
import { startChatSessionSchema, sendChatMessageSchema, completeChatSessionSchema } from "@/schemas/index.js";
import { recordRevision, AlreadyReviewedTodayError } from "@services/reviewRecorder.js";
import { getLearnerDay, isReviewedToday } from "@services/learnerDay.js";
import { logger } from "@config/logger.js";

const log = logger.child({ module: "chatController" });

/**
 * POST /api/chat/start
 * Initialize chat session: extract questions, review them, store, return first question
 */
export async function startChatSession(req: Request, res: Response): Promise<void> {
  try {
    const validation = startChatSessionSchema.safeParse(req.body);
    if (!validation.success) {
      res.status(400).json({
        error: { code: "VALIDATION_ERROR", message: validation.error.issues[0].message },
      } as ErrorResponse);
      return;
    }

    const { topicId } = validation.data;

    const topic = await Topic.findOne({ _id: topicId, userId: req.userId });
    if (!topic) {
      res.status(404).json({
        error: { code: "TOPIC_NOT_FOUND", message: "Topic not found or access denied" },
      } as ErrorResponse);
      return;
    }

    const hasFiles = topic.files.length > 0;
    const hasHttpUrls = topic.urls.some((u) => u.url.startsWith("http://") || u.url.startsWith("https://"));
    if (!hasFiles && !hasHttpUrls) {
      res.status(400).json({
        error: { code: "NO_MATERIALS", message: "Cannot start chat session without study materials or valid URLs" },
      } as ErrorResponse);
      return;
    }

    // Build study materials context
    const { studyMaterials } = await buildChatContext(topic);

    if (studyMaterials instanceof Error) {
      res.status(404).json({
        error: { code: "CONTENT_NOT_FOUND", message: "Topic doesnt have any material" },
      } as ErrorResponse);
      return;
    }

    // Agent pipeline: extract → review
    const questions = await generateQuestions(studyMaterials as string);

    const firstQuestion = questions[0].question;
    const initialMessage = `Hello! Let's revise this topic. Here's your first question:\n\n${firstQuestion}`;

    const chatSession = await ChatSession.create({
      userId: req.userId,
      topicId: topic._id,
      questions,
      currentQuestionIndex: 0,
      messages: [{ role: "assistant", content: initialMessage, timestamp: new Date() }],
      active: true,
    });

    res.status(200).json({
      sessionId: chatSession._id.toString(),
      initialMessage,
      totalQuestions: questions.length,
    });
  } catch (error) {
    log.error({ err: error }, "Error starting chat session");

    if (error instanceof Error) {
      if (error.message.includes("S3") || error.message.includes("retrieve")) {
        res.status(500).json({
          error: { code: "S3_ACCESS_ERROR", message: "Failed to retrieve study materials", details: error.message },
        } as ErrorResponse);
        return;
      }
      if (error.message.includes("LLM") || error.message.includes("timeout")) {
        res.status(500).json({
          error: { code: "LLM_UNAVAILABLE", message: "Failed to initialize chat session with LLM", details: error.message },
        } as ErrorResponse);
        return;
      }
    }

    res.status(500).json({
      error: { code: "INTERNAL_SERVER_ERROR", message: "Failed to start chat session", details: error instanceof Error ? error.message : "Unknown error" },
    } as ErrorResponse);
  }
}

/**
 * POST /api/chat/message
 * Evaluate student answer, provide feedback, send next question or complete
 */
export async function sendChatMessage(req: Request, res: Response): Promise<void> {
  try {
    const validation = sendChatMessageSchema.safeParse(req.body);
    if (!validation.success) {
      res.status(400).json({
        error: { code: "VALIDATION_ERROR", message: validation.error.issues[0].message },
      } as ErrorResponse);
      return;
    }

    const { sessionId, message } = validation.data;

    const chatSession = await ChatSession.findOne({ _id: sessionId, userId: req.userId });
    if (!chatSession) {
      res.status(404).json({
        error: { code: "SESSION_INVALID", message: "Chat session not found or access denied" },
      } as ErrorResponse);
      return;
    }

    if (!chatSession.active) {
      res.status(400).json({
        error: { code: "SESSION_INVALID", message: "Chat session is no longer active" },
      } as ErrorResponse);
      return;
    }

    // Save student message
    chatSession.messages.push({ role: "user", content: message, timestamp: new Date() });

    // Evaluate the answer against current question
    const currentQ = chatSession.questions[chatSession.currentQuestionIndex];
    const evaluation = await evaluateAnswer(currentQ.question, currentQ.answer, message);

    // Move to next question
    chatSession.currentQuestionIndex += 1;
    const isComplete = chatSession.currentQuestionIndex >= chatSession.questions.length;

    // Build response
    let responseText = evaluation.explanation;
    if (!isComplete) {
      const nextQ = chatSession.questions[chatSession.currentQuestionIndex];
      responseText += `\n\nNext question:\n${nextQ.question}`;
    } else {
      responseText += "\n\n[SESSION_COMPLETE]";
      chatSession.active = false;
    }

    chatSession.messages.push({ role: "assistant", content: responseText, timestamp: new Date() });
    await chatSession.save();

    res.status(200).json({
      response: responseText.replace("[SESSION_COMPLETE]", "").trim(),
      correct: evaluation.correct,
      sessionComplete: isComplete,
      questionNumber: chatSession.currentQuestionIndex,
      totalQuestions: chatSession.questions.length,
    });
  } catch (error) {
    log.error({ err: error }, "Error sending chat message");

    if (error instanceof Error && (error.message.includes("LLM") || error.message.includes("timeout"))) {
      res.status(500).json({
        error: { code: "LLM_UNAVAILABLE", message: "Failed to get response from LLM", details: error.message },
      } as ErrorResponse);
      return;
    }

    res.status(500).json({
      error: { code: "INTERNAL_SERVER_ERROR", message: "Failed to send chat message", details: error instanceof Error ? error.message : "Unknown error" },
    } as ErrorResponse);
  }
}

/**
 * POST /api/chat/complete
 * Complete revision session and update schedule.
 *
 * Idempotent per session: a session that already completed returns its stored
 * result. A topic already reviewed today (by any path) returns
 * ALREADY_REVIEWED_TODAY without spending an LLM call.
 */
export async function completeChatSession(req: Request, res: Response): Promise<void> {
  try {
    const validation = completeChatSessionSchema.safeParse(req.body);
    if (!validation.success) {
      res.status(400).json({
        error: { code: "VALIDATION_ERROR", message: validation.error.issues[0].message },
      } as ErrorResponse);
      return;
    }

    const { sessionId, topicId, userQuality } = validation.data;

    const [chatSession, topic] = await Promise.all([ChatSession.findOne({ _id: sessionId, userId: req.userId }), Topic.findOne({ _id: topicId, userId: req.userId })]);

    if (!chatSession) {
      res.status(404).json({
        error: { code: "SESSION_INVALID", message: "Chat session not found or access denied" },
      } as ErrorResponse);
      return;
    }

    if (chatSession.result) {
      res.status(200).json(toCompleteResponse(chatSession.result));
      return;
    }

    if (chatSession.completedAt) {
      // Completed before results were stored on the session; nothing to replay.
      res.status(400).json({
        error: { code: "SESSION_INVALID", message: "Chat session is already complete" },
      } as ErrorResponse);
      return;
    }

    if (!topic) {
      res.status(404).json({
        error: { code: "TOPIC_NOT_FOUND", message: "Topic not found or access denied" },
      } as ErrorResponse);
      return;
    }

    const day = getLearnerDay(req);
    if (isReviewedToday(topic, day)) {
      sendAlreadyReviewed(res);
      return;
    }

    // LLM evaluates session quality from conversation history
    const llmQuality = await assessStudentPerformance(chatSession.messages);

    log.info({ userId: req.userId!, topicId: topic._id, userQuality, llmQuality }, "Recording revision");

    let result: { nextRevisionDate: Date; finalQuality: number };
    try {
      // A concurrent completion of this same session returns that completion's review.
      result = await recordRevision({ userId: req.userId!, topicId: topic._id, userQuality, llmQuality, method: "ai_quiz", sessionId: chatSession._id, day });
    } catch (err) {
      if (!(err instanceof AlreadyReviewedTodayError)) throw err;
      sendAlreadyReviewed(res);
      return;
    }

    log.info({ result }, "Revision recorded");

    chatSession.completedAt = new Date();
    chatSession.active = false;
    chatSession.result = { nextRevisionDate: result.nextRevisionDate, finalQuality: result.finalQuality };
    await chatSession.save();

    res.status(200).json(toCompleteResponse(chatSession.result));
  } catch (error) {
    log.error({ err: error }, "Error completing chat session");

    res.status(500).json({
      error: { code: "INTERNAL_SERVER_ERROR", message: "Failed to complete chat session", details: error instanceof Error ? error.message : "Unknown error" },
    } as ErrorResponse);
  }
}

function toCompleteResponse(result: { nextRevisionDate: Date; finalQuality: number }) {
  return { nextRevisionDate: new Date(result.nextRevisionDate).toISOString(), finalQuality: result.finalQuality };
}

function sendAlreadyReviewed(res: Response): void {
  const error = new AlreadyReviewedTodayError();
  res.status(error.status).json({ error: { code: error.code, message: error.message } } as ErrorResponse);
}
