import { Request, Response } from "express";
import { Topic } from "@models/Topic";
import { ChatSession } from "@models/ChatSession";
import { RevisionRecord } from "@models/RevisionRecord";
import { buildChatContext } from "@services/chatContext";
import { getLLMClient } from "@services/llmClient";
import { calculateNextReview } from "@services/sm2Algorithm";
import { ErrorResponse } from "$types/common.types";
import { startChatSessionSchema, sendChatMessageSchema, completeChatSessionSchema } from "@/schemas";

/**
 * POST /api/chat/start
 * Initialize chat session with topic context
 */
export async function startChatSession(req: Request, res: Response): Promise<void> {
  try {
    const validation = startChatSessionSchema.safeParse(req.body);
    if (!validation.success) {
      res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: validation.error.issues[0].message,
        },
      } as ErrorResponse);
      return;
    }

    const { topicId } = validation.data;

    const topic = await Topic.findOne({ _id: topicId, userId: req.userId });
    if (!topic) {
      res.status(404).json({
        error: {
          code: "TOPIC_NOT_FOUND",
          message: "Topic not found or access denied",
        },
      } as ErrorResponse);
      return;
    }

    const contextPrompt = await buildChatContext(topic);

    const llmClient = getLLMClient();
    const initialMessage = await llmClient.sendTextPrompt(contextPrompt);

    const chatSession = await ChatSession.create({
      userId: req.userId,
      topicId: topic._id,
      messages: [
        {
          role: "assistant",
          content: initialMessage,
          timestamp: new Date(),
        },
      ],
      active: true,
    });

    res.status(200).json({
      sessionId: chatSession._id.toString(),
      initialMessage,
    });
  } catch (error) {
    console.error("Error starting chat session:", error);

    if (error instanceof Error) {
      if (error.message.includes("S3") || error.message.includes("retrieve")) {
        res.status(500).json({
          error: {
            code: "S3_ACCESS_ERROR",
            message: "Failed to retrieve study materials",
            details: error.message,
          },
        } as ErrorResponse);
        return;
      }

      if (error.message.includes("LLM") || error.message.includes("timeout")) {
        res.status(500).json({
          error: {
            code: "LLM_UNAVAILABLE",
            message: "Failed to initialize chat session with LLM",
            details: error.message,
          },
        } as ErrorResponse);
        return;
      }
    }

    res.status(500).json({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to start chat session",
        details: error instanceof Error ? error.message : "Unknown error",
      },
    } as ErrorResponse);
  }
}

/**
 * POST /api/chat/message
 * Send message and get LLM response
 */
export async function sendChatMessage(req: Request, res: Response): Promise<void> {
  try {
    const validation = sendChatMessageSchema.safeParse(req.body);
    if (!validation.success) {
      res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: validation.error.issues[0].message,
        },
      } as ErrorResponse);
      return;
    }

    const { sessionId, message } = validation.data;

    const chatSession = await ChatSession.findOne({ _id: sessionId, userId: req.userId });
    if (!chatSession) {
      res.status(404).json({
        error: {
          code: "SESSION_INVALID",
          message: "Chat session not found or access denied",
        },
      } as ErrorResponse);
      return;
    }

    if (!chatSession.active) {
      res.status(400).json({
        error: {
          code: "SESSION_INVALID",
          message: "Chat session is no longer active",
        },
      } as ErrorResponse);
      return;
    }

    chatSession.messages.push({
      role: "user",
      content: message,
      timestamp: new Date(),
    });

    const conversationContext = chatSession.messages.map((msg) => `${msg.role === "user" ? "Student" : "Tutor"}: ${msg.content}`).join("\n\n");

    const llmClient = getLLMClient();
    const llmResponse = await llmClient.sendTextPrompt(conversationContext);

    chatSession.messages.push({
      role: "assistant",
      content: llmResponse,
      timestamp: new Date(),
    });

    await chatSession.save();

    res.status(200).json({ response: llmResponse });
  } catch (error) {
    console.error("Error sending chat message:", error);

    if (error instanceof Error) {
      if (error.message.includes("LLM") || error.message.includes("timeout")) {
        res.status(500).json({
          error: {
            code: "LLM_UNAVAILABLE",
            message: "Failed to get response from LLM",
            details: error.message,
          },
        } as ErrorResponse);
        return;
      }
    }

    res.status(500).json({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to send chat message",
        details: error instanceof Error ? error.message : "Unknown error",
      },
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
        error: {
          code: "VALIDATION_ERROR",
          message: validation.error.issues[0].message,
        },
      } as ErrorResponse);
      return;
    }

    const { sessionId, topicId, userQuality, llmQuality } = validation.data;

    const [chatSession, topic] = await Promise.all([ChatSession.findOne({ _id: sessionId, userId: req.userId }), Topic.findOne({ _id: topicId, userId: req.userId })]);

    if (!chatSession) {
      res.status(404).json({
        error: {
          code: "SESSION_INVALID",
          message: "Chat session not found or access denied",
        },
      } as ErrorResponse);
      return;
    }

    if (!topic) {
      res.status(404).json({
        error: {
          code: "TOPIC_NOT_FOUND",
          message: "Topic not found or access denied",
        },
      } as ErrorResponse);
      return;
    }

    const finalQuality = (userQuality + llmQuality) / 2;

    const reviewResult = calculateNextReview({
      eFactor: topic.eFactor,
      repetitionNumber: topic.repetitionNumber,
      interval: topic.interval,
      quality: finalQuality,
    });

    topic.eFactor = reviewResult.eFactor;
    topic.repetitionNumber = reviewResult.repetitionNumber;
    topic.interval = reviewResult.interval;
    topic.revisionDate = reviewResult.nextRevisionDate;
    await topic.save();

    await RevisionRecord.create({
      userId: req.userId,
      topicId: topic._id,
      revisionDate: new Date(),
      userQuality,
      llmQuality,
      finalQuality,
      newEFactor: reviewResult.eFactor,
      newInterval: reviewResult.interval,
      nextRevisionDate: reviewResult.nextRevisionDate,
    });

    chatSession.completedAt = new Date();
    chatSession.active = false;
    await chatSession.save();

    res.status(200).json({
      nextRevisionDate: reviewResult.nextRevisionDate.toISOString(),
      finalQuality,
    });
  } catch (error) {
    console.error("Error completing chat session:", error);

    res.status(500).json({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to complete chat session",
        details: error instanceof Error ? error.message : "Unknown error",
      },
    } as ErrorResponse);
  }
}
