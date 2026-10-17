import { Request, Response } from "express";
import { topicIdParamSchema } from "@/schemas/index.js";
import { requestBankBuild } from "@services/questionBankJobs.js";
import { ErrorResponse } from "$types/common.types.js";
import { logger } from "@config/logger.js";

const log = logger.child({ module: "questionBankController" });

/**
 * POST /api/topics/:id/questions/regenerate
 * Queues a rebuild that replaces the topic's question bank (R18). Flagged
 * questions stay retired. The current questions stay usable until it lands.
 */
export async function regenerateQuestions(req: Request, res: Response): Promise<void> {
  try {
    const validation = topicIdParamSchema.safeParse(req.params);
    if (!validation.success) {
      res.status(400).json({
        error: { code: "VALIDATION_ERROR", message: validation.error.issues[0].message },
      } as ErrorResponse);
      return;
    }

    const { id } = validation.data;
    const questionBank = await requestBankBuild({ topicId: id, userId: req.userId!, reason: "regenerate" });
    if (!questionBank) {
      res.status(404).json({
        error: { code: "TOPIC_NOT_FOUND", message: "Topic not found or access denied" },
      } as ErrorResponse);
      return;
    }

    res.status(202).json({ questionBank });
  } catch (error) {
    log.error({ err: error }, "Error queueing question regeneration");

    res.status(500).json({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to queue question regeneration",
        details: error instanceof Error ? error.message : "Unknown error",
      },
    } as ErrorResponse);
  }
}
