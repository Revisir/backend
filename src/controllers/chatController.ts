import { Request, Response } from "express";
import { Topic } from "@models/Topic.js";
import { ChatSession } from "@models/ChatSession.js";
import { buildChatContext, assessStudentPerformance } from "@services/chatContext.js";
import { generateQuestions, evaluateAnswer } from "@services/questionAgent.js";
import { ErrorResponse } from "$types/common.types.js";
import { startChatSessionSchema, sendChatMessageSchema, completeChatSessionSchema } from "@/schemas/index.js";
import { recordRevision } from "@controllers/topicController.js";

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

    // Build study materials context
    const { studyMaterials } = await buildChatContext(topic);

    if (studyMaterials instanceof Error) {
      res.status(404).json({
        error: { code: "CONTENT_NOT_FOUND", message: "Topic doesnt have any material" },
      } as ErrorResponse);
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
    console.error("Error starting chat session:", error);

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
    console.error("Error sending chat message:", error);

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
 * Complete revision session and update schedule
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

    if (!topic) {
      res.status(404).json({
        error: { code: "TOPIC_NOT_FOUND", message: "Topic not found or access denied" },
      } as ErrorResponse);
      return;
    }

    // LLM evaluates session quality from conversation history
    const llmQuality = await assessStudentPerformance(chatSession.messages);

    console.log({ userId: req.userId!, topic, userQuality, llmQuality });

    const result = await recordRevision({ userId: req.userId!, topic, userQuality, llmQuality });

    console.log({ result });

    chatSession.completedAt = new Date();
    chatSession.active = false;
    await chatSession.save();

    res.status(200).json({
      nextRevisionDate: result.nextRevisionDate.toISOString(),
      finalQuality: result.finalQuality,
    });
  } catch (error) {
    console.error("Error completing chat session:", error);

    res.status(500).json({
      error: { code: "INTERNAL_SERVER_ERROR", message: "Failed to complete chat session", details: error instanceof Error ? error.message : "Unknown error" },
    } as ErrorResponse);
  }
}
