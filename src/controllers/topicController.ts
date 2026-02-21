import { Request, Response } from "express";
import { Topic } from "@models/Topic";
import { RevisionRecord } from "@models/RevisionRecord";
import { generateMindMap } from "@services/mindMapGenerator";
import { calculateNextReview } from "@services/sm2Algorithm";
import { generatePresignedUploadUrl, deleteTopicFiles, deleteFile } from "@services/s3Storage";
import { GetTopicsResponse } from "$types/topic.types";
import { ErrorResponse } from "$types/common.types";
import { getTopicsQuerySchema, topicIdParamSchema } from "@/schemas";
import { z } from "zod";

const markRevisedSchema = z.object({
  userQuality: z.number().min(1).max(5),
  llmQuality: z.number().min(1).max(5).optional(),
});

const updateTopicSchema = z.object({
  topicName: z.string().max(200).optional(),
  subjectName: z.string().max(100).optional(),
  description: z.string().optional(),
  dateStudied: z.string().datetime().optional(),
});

const fileInfoSchema = z.object({
  fileName: z.string().min(1),
  size: z.number().positive(),
  contentType: z.string().min(1),
});

const uploadFilesSchema = z.object({
  files: z.array(fileInfoSchema).min(1),
});

/**
 * GET /api/topics
 * List all topics with pagination and optional subject filter
 */
export async function getTopics(req: Request, res: Response): Promise<void> {
  try {
    const validation = getTopicsQuerySchema.safeParse(req.query);
    if (!validation.success) {
      res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: validation.error.issues[0].message,
        },
      } as ErrorResponse);
      return;
    }

    const { page: pageNum, limit: limitNum, subject } = validation.data;

    const filter: any = { userId: req.userId };
    if (subject) {
      filter.subjectName = subject;
    }

    const skip = (pageNum - 1) * limitNum;

    const [topics, total] = await Promise.all([Topic.find(filter).sort({ createdAt: -1 }).select("topicName subjectName description dateStudied revisionDate isDue").skip(skip).limit(limitNum).lean(), Topic.countDocuments(filter)]);

    const response: GetTopicsResponse = {
      topics,
      total: Math.ceil(total / limitNum),
      page: pageNum,
    };

    res.status(200).json(response);
  } catch (error) {
    console.error("Error fetching topics:", error);

    res.status(500).json({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to fetch topics",
        details: error instanceof Error ? error.message : "Unknown error",
      },
    } as ErrorResponse);
  }
}

/**
 * GET /api/topics/:id
 * Get topic details by ID
 */
export async function getTopicById(req: Request, res: Response): Promise<void> {
  try {
    const validation = topicIdParamSchema.safeParse(req.params);
    if (!validation.success) {
      res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: validation.error.issues[0].message,
        },
      } as ErrorResponse);
      return;
    }

    const { id } = validation.data;

    const topic = await Topic.findOne({ _id: id, userId: req.userId }).lean();

    if (!topic) {
      res.status(404).json({
        error: {
          code: "TOPIC_NOT_FOUND",
          message: "Topic not found or access denied",
        },
      } as ErrorResponse);
      return;
    }

    res.status(200).json(topic);
  } catch (error) {
    console.error("Error fetching topic by ID:", error);

    res.status(500).json({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to fetch topic",
        details: error instanceof Error ? error.message : "Unknown error",
      },
    } as ErrorResponse);
  }
}

/**
 * GET /api/topics/due
 * Get topics due for revision (revisionDate <= currentDate)
 */
export async function getDueTopics(req: Request, res: Response): Promise<void> {
  try {
    const currentDate = new Date();

    const dueTopics = await Topic.find({
      userId: req.userId,
      revisionDate: { $lte: currentDate },
    })
      .sort({ revisionDate: 1 })
      .lean();

    res.status(200).json({ topics: dueTopics });
  } catch (error) {
    console.error("Error fetching due topics:", error);

    res.status(500).json({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to fetch due topics",
        details: error instanceof Error ? error.message : "Unknown error",
      },
    } as ErrorResponse);
  }
}

/**
 * GET /api/topics/:id/history
 * Get revision history for a topic
 */
export async function getTopicHistory(req: Request, res: Response): Promise<void> {
  try {
    const validation = topicIdParamSchema.safeParse(req.params);
    if (!validation.success) {
      res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: validation.error.issues[0].message,
        },
      } as ErrorResponse);
      return;
    }

    const { id } = validation.data;

    const topicExists = await Topic.exists({ _id: id, userId: req.userId });
    if (!topicExists) {
      res.status(404).json({
        error: {
          code: "TOPIC_NOT_FOUND",
          message: "Topic not found or access denied",
        },
      } as ErrorResponse);
      return;
    }

    const history = await RevisionRecord.find({ topicId: id, userId: req.userId }).sort({ revisionDate: -1 }).lean();

    res.status(200).json({ history });
  } catch (error) {
    console.error("Error fetching topic history:", error);

    res.status(500).json({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to fetch topic history",
        details: error instanceof Error ? error.message : "Unknown error",
      },
    } as ErrorResponse);
  }
}

/**
 * POST /api/topics/:id/mindmap
 * Generate a Mermaid mind map for a topic
 */
export async function generateTopicMindMap(req: Request, res: Response): Promise<void> {
  try {
    const validation = topicIdParamSchema.safeParse(req.params);
    if (!validation.success) {
      res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: validation.error.issues[0].message,
        },
      } as ErrorResponse);
      return;
    }

    const { id } = validation.data;

    const topic = await Topic.findOne({ _id: id, userId: req.userId });
    if (!topic) {
      res.status(404).json({
        error: {
          code: "TOPIC_NOT_FOUND",
          message: "Topic not found or access denied",
        },
      } as ErrorResponse);
      return;
    }

    const mermaidCode = await generateMindMap(topic);

    topic.mindMap = mermaidCode;
    topic.mindMapGeneratedAt = new Date();
    await topic.save();

    res.status(200).json({
      mindmap: mermaidCode,
      generatedAt: topic.mindMapGeneratedAt.toISOString(),
    });
  } catch (error) {
    console.error("Error generating mind map:", error);

    if (error instanceof Error) {
      if (error.message.includes("S3") || error.message.includes("retrieve")) {
        res.status(500).json({
          error: {
            code: "S3_ACCESS_ERROR",
            message: "Failed to retrieve study materials for mind map generation",
            details: error.message,
          },
        } as ErrorResponse);
        return;
      }

      if (error.message.includes("LLM") || error.message.includes("timeout")) {
        res.status(500).json({
          error: {
            code: "LLM_UNAVAILABLE",
            message: "Failed to generate mind map with LLM",
            details: error.message,
          },
        } as ErrorResponse);
        return;
      }

      if (error.message.includes("Mermaid") || error.message.includes("syntax")) {
        res.status(500).json({
          error: {
            code: "VALIDATION_ERROR",
            message: "Generated mind map has invalid Mermaid syntax",
            details: error.message,
          },
        } as ErrorResponse);
        return;
      }
    }

    res.status(500).json({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to generate mind map",
        details: error instanceof Error ? error.message : "Unknown error",
      },
    } as ErrorResponse);
  }
}

/**
 * GET /api/topics/:id/mindmap
 * Retrieve existing mind map for a topic
 */
export async function getTopicMindMap(req: Request, res: Response): Promise<void> {
  try {
    const validation = topicIdParamSchema.safeParse(req.params);
    if (!validation.success) {
      res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: validation.error.issues[0].message,
        },
      } as ErrorResponse);
      return;
    }

    const { id } = validation.data;

    const topic = await Topic.findOne({ _id: id, userId: req.userId }).select("mindMap mindMapGeneratedAt").lean();

    if (!topic) {
      res.status(404).json({
        error: {
          code: "TOPIC_NOT_FOUND",
          message: "Topic not found or access denied",
        },
      } as ErrorResponse);
      return;
    }

    if (!topic.mindMap) {
      res.status(404).json({
        error: {
          code: "MINDMAP_NOT_FOUND",
          message: "Mind map has not been generated for this topic",
        },
      } as ErrorResponse);
      return;
    }

    res.status(200).json({
      mindmap: topic.mindMap,
      generatedAt: topic.mindMapGeneratedAt?.toISOString() || null,
    });
  } catch (error) {
    console.error("Error retrieving mind map:", error);

    res.status(500).json({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to retrieve mind map",
        details: error instanceof Error ? error.message : "Unknown error",
      },
    } as ErrorResponse);
  }
}

/**
 * POST /api/topics/:id/revised
 * Mark topic as revised/unrevised and create revision record
 */
export async function markTopicRevised(req: Request, res: Response): Promise<void> {
  try {
    const paramValidation = topicIdParamSchema.safeParse(req.params);
    if (!paramValidation.success) {
      res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: paramValidation.error.issues[0].message,
        },
      } as ErrorResponse);
      return;
    }

    const bodyValidation = markRevisedSchema.safeParse(req.body);
    if (!bodyValidation.success) {
      res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: bodyValidation.error.issues[0].message,
        },
      } as ErrorResponse);
      return;
    }

    const { id } = paramValidation.data;
    const { userQuality, llmQuality } = bodyValidation.data;

    const topic = await Topic.findOne({ _id: id, userId: req.userId });
    if (!topic) {
      res.status(404).json({
        error: {
          code: "TOPIC_NOT_FOUND",
          message: "Topic not found or access denied",
        },
      } as ErrorResponse);
      return;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const todayRecord = await RevisionRecord.findOne({
      topicId: id,
      userId: req.userId,
      revisionDate: { $gte: today, $lt: tomorrow },
    });

    if (todayRecord) {
      await RevisionRecord.deleteOne({ _id: todayRecord._id });

      const prevRecord = await RevisionRecord.findOne({ topicId: id, userId: req.userId }).sort({ revisionDate: -1 });

      if (prevRecord) {
        topic.eFactor = prevRecord.newEFactor;
        topic.interval = prevRecord.newInterval;
        topic.revisionDate = prevRecord.nextRevisionDate;
        topic.repetitionNumber = Math.max(0, topic.repetitionNumber - 1);
        topic.lastRevised = prevRecord.revisionDate;
      } else {
        topic.eFactor = 2.5;
        topic.interval = 1;
        topic.revisionDate = topic.dateStudied;
        topic.repetitionNumber = 0;
        topic.lastRevised = null;
      }

      await topic.save();

      res.status(200).json({ success: true, unrevised: true });
      return;
    }

    const finalQuality = llmQuality ? (userQuality + llmQuality) / 2 : userQuality;

    const lastRecord = await RevisionRecord.findOne({ topicId: id, userId: req.userId }).sort({ revisionDate: -1 });

    const result = calculateNextReview({
      eFactor: lastRecord?.newEFactor ?? topic.eFactor,
      repetitionNumber: topic.repetitionNumber,
      interval: lastRecord?.newInterval ?? topic.interval,
      quality: finalQuality,
    });

    await RevisionRecord.create({
      userId: req.userId,
      topicId: id,
      revisionDate: new Date(),
      userQuality,
      llmQuality: llmQuality ?? userQuality,
      finalQuality,
      newEFactor: result.eFactor,
      newInterval: result.interval,
      nextRevisionDate: result.nextRevisionDate,
    });

    topic.eFactor = result.eFactor;
    topic.interval = result.interval;
    topic.revisionDate = result.nextRevisionDate;
    topic.repetitionNumber = result.repetitionNumber;
    topic.lastRevised = new Date();
    await topic.save();

    res.status(200).json({
      success: true,
      nextRevisionDate: result.nextRevisionDate.toISOString(),
    });
  } catch (error) {
    console.error("Error marking topic as revised:", error);

    res.status(500).json({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to mark topic as revised",
        details: error instanceof Error ? error.message : "Unknown error",
      },
    } as ErrorResponse);
  }
}

/**
 * PATCH /api/topics/:id
 * Update topic details
 */
export async function updateTopic(req: Request, res: Response): Promise<void> {
  try {
    const paramValidation = topicIdParamSchema.safeParse(req.params);
    if (!paramValidation.success) {
      res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: paramValidation.error.issues[0].message,
        },
      } as ErrorResponse);
      return;
    }

    const bodyValidation = updateTopicSchema.safeParse(req.body);
    if (!bodyValidation.success) {
      res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: bodyValidation.error.issues[0].message,
        },
      } as ErrorResponse);
      return;
    }

    const { id } = paramValidation.data;
    const updates = bodyValidation.data;

    const topic = await Topic.findOne({ _id: id, userId: req.userId });
    if (!topic) {
      res.status(404).json({
        error: {
          code: "TOPIC_NOT_FOUND",
          message: "Topic not found or access denied",
        },
      } as ErrorResponse);
      return;
    }

    if (updates.topicName) topic.topicName = updates.topicName.trim();
    if (updates.subjectName) topic.subjectName = updates.subjectName.trim();
    if (updates.description !== undefined) topic.description = updates.description.trim();

    if (updates.dateStudied) {
      topic.dateStudied = new Date(updates.dateStudied);
      topic.eFactor = 2.5;
      topic.interval = 1;
      topic.repetitionNumber = 0;
      topic.revisionDate = new Date(updates.dateStudied);
      await RevisionRecord.deleteMany({ topicId: id, userId: req.userId });
    }

    await topic.save();

    res.status(200).json({ success: true, topic });
  } catch (error) {
    console.error("Error updating topic:", error);

    res.status(500).json({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to update topic",
        details: error instanceof Error ? error.message : "Unknown error",
      },
    } as ErrorResponse);
  }
}

/**
 * DELETE /api/topics/:id/files/:fileId
 * Delete a specific file from topic
 */
export async function deleteTopicFile(req: Request, res: Response): Promise<void> {
  try {
    const { id, fileId } = req.params;

    const topic = await Topic.findOne({ _id: id, userId: req.userId });
    if (!topic) {
      res.status(404).json({
        error: {
          code: "TOPIC_NOT_FOUND",
          message: "Topic not found or access denied",
        },
      } as ErrorResponse);
      return;
    }

    const fileIndex = topic.files.findIndex((f) => f._id?.toString() === fileId);
    if (fileIndex === -1) {
      res.status(404).json({
        error: {
          code: "FILE_NOT_FOUND",
          message: "File not found in topic",
        },
      } as ErrorResponse);
      return;
    }

    const fileName = topic.files[fileIndex].fileName;
    await deleteFile(req.userId!, Array.isArray(id) ? id[0] : id, fileName);

    topic.files.splice(fileIndex, 1);
    await topic.save();

    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error deleting file:", error);

    res.status(500).json({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to delete file",
        details: error instanceof Error ? error.message : "Unknown error",
      },
    } as ErrorResponse);
  }
}

/**
 * POST /api/topics/:id/files
 * Upload additional files to topic
 */
export async function uploadTopicFiles(req: Request, res: Response): Promise<void> {
  try {
    const paramValidation = topicIdParamSchema.safeParse(req.params);
    if (!paramValidation.success) {
      res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: paramValidation.error.issues[0].message,
        },
      } as ErrorResponse);
      return;
    }

    const bodyValidation = uploadFilesSchema.safeParse(req.body);
    if (!bodyValidation.success) {
      res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: bodyValidation.error.issues[0].message,
        },
      } as ErrorResponse);
      return;
    }

    const { id } = paramValidation.data;
    const { files } = bodyValidation.data;

    const topic = await Topic.findOne({ _id: id, userId: req.userId });
    if (!topic) {
      res.status(404).json({
        error: {
          code: "TOPIC_NOT_FOUND",
          message: "Topic not found or access denied",
        },
      } as ErrorResponse);
      return;
    }

    const uploadUrls = await Promise.all(
      files.map(async (file) => ({
        fileName: file.fileName,
        uploadUrl: await generatePresignedUploadUrl(req.userId!, id, file.fileName, file.contentType),
      })),
    );

    res.status(200).json({ uploadUrls });
  } catch (error) {
    console.error("Error generating upload URLs:", error);

    res.status(500).json({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to generate upload URLs",
        details: error instanceof Error ? error.message : "Unknown error",
      },
    } as ErrorResponse);
  }
}

/**
 * DELETE /api/topics/:id
 * Delete a topic and all its revision records
 */
export async function deleteTopic(req: Request, res: Response): Promise<void> {
  try {
    const validation = topicIdParamSchema.safeParse(req.params);
    if (!validation.success) {
      res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: validation.error.issues[0].message,
        },
      } as ErrorResponse);
      return;
    }

    const { id } = validation.data;

    const topic = await Topic.findOneAndDelete({ _id: id, userId: req.userId });
    if (!topic) {
      res.status(404).json({
        error: {
          code: "TOPIC_NOT_FOUND",
          message: "Topic not found or access denied",
        },
      } as ErrorResponse);
      return;
    }

    await Promise.all([RevisionRecord.deleteMany({ topicId: id, userId: req.userId }), deleteTopicFiles(req.userId!, id)]);

    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error deleting topic:", error);

    res.status(500).json({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to delete topic",
        details: error instanceof Error ? error.message : "Unknown error",
      },
    } as ErrorResponse);
  }
}
