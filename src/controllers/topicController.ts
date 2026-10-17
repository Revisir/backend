import { Request, Response } from "express";
import { Topic } from "@models/Topic.js";
import { RevisionRecord } from "@models/RevisionRecord.js";
import { generateMindMap } from "@services/mindMapGenerator.js";
import { generatePresignedUploadUrl, deleteTopicFiles, deleteFile, deleteByPath, getSignedContentUrl } from "@services/s3Storage.js";
import { recordRevision, AlreadyReviewedTodayError, TopicNotFoundError } from "@services/reviewRecorder.js";
import { getLearnerDay, changedStudyDate } from "@services/learnerDay.js";
import { GetTopicsResponse } from "$types/topic.types.js";
import { ErrorResponse } from "$types/common.types.js";
import { getTopicsQuerySchema, topicIdParamSchema, topicFileParamSchema, markRevisedSchema, updateTopicSchema } from "@/schemas/index.js";
import { applyUrlListUpdate, upsertPendingFileEntries } from "@services/topicMaterials.js";
import { z } from "zod";
import { logger } from "@config/logger.js";

const log = logger.child({ module: "topicController" });

import { ALLOWED_CONTENT_TYPES, MAX_FILE_SIZE, MAX_FILES_PER_UPLOAD, MAX_FILES_PER_TOPIC } from "@/config/fileConstants.js";

const fileInfoSchema = z.object({
  fileName: z.string().min(1),
  size: z
    .number()
    .positive()
    .max(MAX_FILE_SIZE, `File size must not exceed ${MAX_FILE_SIZE / (1024 * 1024)}MB`),
  contentType: z.string().refine((val) => ALLOWED_CONTENT_TYPES.includes(val), {
    message: `Content type must be one of: ${ALLOWED_CONTENT_TYPES.join(", ")}`,
  }),
});

const uploadFilesSchema = z.object({
  files: z.array(fileInfoSchema).min(1).max(MAX_FILES_PER_UPLOAD, `Cannot upload more than ${MAX_FILES_PER_UPLOAD} files at once`),
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

    const [topics, total] = await Promise.all([Topic.find(filter).sort({ createdAt: -1 }).select("topicName subjectName description dateStudied revisionDate lastRevised").skip(skip).limit(limitNum).lean(), Topic.countDocuments(filter)]);

    const response: GetTopicsResponse = {
      topics,
      total: Math.ceil(total / limitNum),
      page: pageNum,
    };

    res.status(200).json(response);
  } catch (error) {
    log.error({ err: error }, "Error fetching topics");

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

    const files = await Promise.all(
      (topic.files || []).map(async (file) => ({
        _id: file._id,
        fileName: file.fileName,
        fileType: file.fileType,
        fileUrl: await getSignedContentUrl(file.s3Path),
        ...statusFields(file),
      })),
    );
    const urls = (topic.urls || []).map(({ errorReason, ...url }) => ({ ...url, ...statusFields({ processingStatus: url.processingStatus, errorReason }) }));

    res.status(200).json({ ...topic, files, urls });
  } catch (error) {
    log.error({ err: error }, "Error fetching topic by ID");

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
    const day = getLearnerDay(req);
    // Due today in the learner's zone, plus anything already finished today so
    // the queue can keep showing it as done for the rest of the day (R12).
    const dueTopics = await Topic.find({
      userId: req.userId,
      $or: [{ revisionDate: { $lt: day.tomorrowStart } }, { lastRevised: { $gte: day.start, $lt: day.tomorrowStart } }],
    })
      .sort({ revisionDate: 1 })
      .lean();

    res.status(200).json({ topics: dueTopics });
  } catch (error) {
    log.error({ err: error }, "Error fetching due topics");

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
 * GET /api/topics/:id/forgetting-curve
 * Compute forgetting curve data for a topic
 * Returns retention decay points from last revision to next revision date, plus revision history markers.
 */
export async function getForgettingCurve(req: Request, res: Response): Promise<void> {
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

    const topic = await Topic.findOne({ _id: id, userId: req.userId })
      .select("eFactor repetitionNumber interval revisionDate lastRevised dateStudied topicName")
      .lean();

    if (!topic) {
      res.status(404).json({
        error: {
          code: "TOPIC_NOT_FOUND",
          message: "Topic not found or access denied",
        },
      } as ErrorResponse);
      return;
    }

    const history = await RevisionRecord.find({ topicId: id, userId: req.userId })
      .sort({ revisionDate: 1 })
      .lean();

    // Build curve segments: each revision resets retention to 100%
    // Between revisions, retention decays exponentially: R(t) = e^(-t/S)
    // Stability S is derived from the interval (days where R drops to ~0.9 threshold from SM-2)
    // We use S = -interval / ln(0.9) ≈ interval * 9.49 (assuming SM-2 targets 90% at interval boundary)
    const RETENTION_THRESHOLD = 0.9;
    const stabilityFactor = -1 / Math.log(RETENTION_THRESHOLD); // ≈ 9.49

    interface CurvePoint {
      date: string;
      retention: number;
    }
    interface RevisionMarker {
      date: string;
      quality: number;
      eFactor: number;
      interval: number;
    }

    const curvePoints: CurvePoint[] = [];
    const revisionMarkers: RevisionMarker[] = [];

    // Determine anchor date (start of tracking)
    const anchorDate = topic.dateStudied ? new Date(topic.dateStudied) : new Date(topic.revisionDate.getTime() - topic.interval * 86400000);

    if (history.length === 0) {
      // No revisions yet — show decay from dateStudied to now (or revisionDate, whichever is later)
      const stability = topic.interval * stabilityFactor;
      const endDate = new Date(Math.max(Date.now(), topic.revisionDate.getTime()));
      const totalDays = Math.ceil((endDate.getTime() - anchorDate.getTime()) / 86400000);
      const step = Math.max(1, Math.floor(totalDays / 60)); // cap at ~60 points

      for (let d = 0; d <= totalDays; d += step) {
        const pointDate = new Date(anchorDate.getTime() + d * 86400000);
        const retention = Math.exp(-d / stability);
        curvePoints.push({
          date: pointDate.toISOString().split("T")[0],
          retention: Math.round(retention * 1000) / 1000,
        });
      }
    } else {
      // Build curve through each revision segment
      let segmentStart = anchorDate;
      let currentInterval = 1; // initial interval before first revision

      for (let i = 0; i < history.length; i++) {
        const record = history[i];
        const revDate = new Date(record.revisionDate);
        const stability = currentInterval * stabilityFactor;
        const segmentDays = Math.ceil((revDate.getTime() - segmentStart.getTime()) / 86400000);
        const step = Math.max(1, Math.floor(segmentDays / 30));

        for (let d = 0; d < segmentDays; d += step) {
          const pointDate = new Date(segmentStart.getTime() + d * 86400000);
          const retention = Math.exp(-d / stability);
          curvePoints.push({
            date: pointDate.toISOString().split("T")[0],
            retention: Math.round(retention * 1000) / 1000,
          });
        }

        // Add the revision point (retention resets to 1.0)
        curvePoints.push({
          date: revDate.toISOString().split("T")[0],
          retention: 1.0,
        });

        revisionMarkers.push({
          date: revDate.toISOString().split("T")[0],
          quality: record.finalQuality,
          eFactor: record.newEFactor,
          interval: record.newInterval,
        });

        segmentStart = revDate;
        currentInterval = record.newInterval;
      }

      // Final segment: from last revision to now or next revision date
      const lastRevision = history[history.length - 1];
      const lastRevDate = new Date(lastRevision.revisionDate);
      const stability = lastRevision.newInterval * stabilityFactor;
      const endDate = new Date(Math.max(Date.now(), topic.revisionDate.getTime()));
      const finalDays = Math.ceil((endDate.getTime() - lastRevDate.getTime()) / 86400000);
      const step = Math.max(1, Math.floor(finalDays / 30));

      for (let d = 1; d <= finalDays; d += step) {
        const pointDate = new Date(lastRevDate.getTime() + d * 86400000);
        const retention = Math.exp(-d / stability);
        curvePoints.push({
          date: pointDate.toISOString().split("T")[0],
          retention: Math.round(retention * 1000) / 1000,
        });
      }
    }

    res.status(200).json({
      topicName: topic.topicName,
      eFactor: topic.eFactor,
      interval: topic.interval,
      repetitionNumber: topic.repetitionNumber,
      revisionDate: topic.revisionDate,
      lastRevised: topic.lastRevised,
      curvePoints,
      revisionMarkers,
    });
  } catch (error) {
    log.error({ err: error }, "Error computing forgetting curve");

    res.status(500).json({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to compute forgetting curve",
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

    const records = await RevisionRecord.find({ topicId: id, userId: req.userId }).sort({ revisionDate: -1 }).lean();
    // Records written before `method` existed were all self-reported or AI-chat
    // reviews with no way to tell them apart; they read as `self`.
    const history = records.map((record) => ({ ...record, method: record.method ?? "self" }));

    res.status(200).json({ history });
  } catch (error) {
    log.error({ err: error }, "Error fetching topic history");

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
 * Generate a MindElixir mind map for a topic
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

    const hasFiles = topic.files.length > 0;
    const hasHttpUrls = topic.urls.some((u) => u.url.startsWith("http://") || u.url.startsWith("https://"));
    if (!hasFiles && !hasHttpUrls) {
      res.status(400).json({
        error: {
          code: "NO_MATERIALS",
          message: "Cannot generate mind map without study materials or valid URLs",
        },
      } as ErrorResponse);
      return;
    }

    const elixirCode = await generateMindMap(topic);

    topic.mindMap = elixirCode;
    topic.mindMapGeneratedAt = new Date();
    await topic.save();

    res.status(200).json({
      mindmap: elixirCode,
      generatedAt: topic.mindMapGeneratedAt.toISOString(),
    });
  } catch (error) {
    log.error({ err: error }, "Error generating mind map");

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

      if (error.message.includes("Elixir") || error.message.includes("syntax")) {
        res.status(500).json({
          error: {
            code: "VALIDATION_ERROR",
            message: "Generated mind map has invalid MindElixir format",
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
    log.error({ err: error }, "Error retrieving mind map");

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
 * Done on the topic page: record the learner's own 0–5 rating.
 * A topic takes one review per learner-day; there is no same-day undo.
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
    const { userQuality } = bodyValidation.data;

    const result = await recordRevision({ userId: req.userId!, topicId: id, userQuality, method: "self", day: getLearnerDay(req) });

    res.status(200).json({
      success: true,
      nextRevisionDate: result.nextRevisionDate.toISOString(),
      lastRevised: result.lastRevised.toISOString(),
      eFactor: result.eFactor,
      interval: result.interval,
      repetitionNumber: result.repetitionNumber,
      lastQuality: result.lastQuality,
    });
  } catch (error) {
    if (error instanceof TopicNotFoundError || error instanceof AlreadyReviewedTodayError) {
      res.status(error instanceof TopicNotFoundError ? 404 : 409).json({
        error: { code: error.code, message: error.message },
      } as ErrorResponse);
      return;
    }

    log.error({ err: error }, "Error marking topic as revised");

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

    const day = getLearnerDay(req);

    if (updates.topicName) topic.topicName = updates.topicName.trim();
    if (updates.subjectName) topic.subjectName = updates.subjectName.trim();
    if (updates.description !== undefined) topic.description = updates.description.trim();

    if (updates.urls !== undefined) {
      // Atomic array updates: existing entries keep their status and paths (R41).
      await applyUrlListUpdate(topic, updates.urls, day.now);
    }

    // Clear mindmap if no materials remain
    const materials = await Topic.findOne({ _id: id, userId: req.userId }).select("files urls").lean();
    const hasFiles = (materials?.files.length ?? 0) > 0;
    const hasHttpUrls = (materials?.urls ?? []).some((u) => u.url.startsWith("http://") || u.url.startsWith("https://"));
    if (!hasFiles && !hasHttpUrls) {
      topic.mindMap = null;
      topic.mindMapGeneratedAt = null;
    }

    // Only a changed study date resets the schedule and history (R42, KTD20).
    const newStudyDate = updates.dateStudied ? changedStudyDate(updates.dateStudied, topic.dateStudied, day) : null;
    if (newStudyDate) {
      topic.dateStudied = newStudyDate;
      topic.eFactor = 2.5;
      topic.interval = 1;
      topic.repetitionNumber = 0;
      topic.revisionDate = newStudyDate;
      topic.lastRevised = null;
      topic.lastQuality = null;
      await RevisionRecord.deleteMany({ topicId: id, userId: req.userId });
    }

    await topic.save();

    const updated = await Topic.findOne({ _id: id, userId: req.userId });

    res.status(200).json({ success: true, topic: updated });
  } catch (error) {
    log.error({ err: error }, "Error updating topic");

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
    const validation = topicFileParamSchema.safeParse(req.params);
    if (!validation.success) {
      res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: validation.error.issues[0].message,
        },
      } as ErrorResponse);
      return;
    }

    const { id, fileId } = validation.data;

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

    const file = topic.files.id(fileId);
    if (!file) {
      res.status(404).json({
        error: {
          code: "FILE_NOT_FOUND",
          message: "File not found in topic",
        },
      } as ErrorResponse);
      return;
    }

    await deleteFile(req.userId!, id, file.fileName);
    if (file.extractedContentUrl) await deleteByPath(file.extractedContentUrl);

    file.deleteOne();

    // Clear mindmap if no materials remain after file deletion
    const hasRemainingFiles = topic.files.length > 0;
    const hasHttpUrls = topic.urls.some((u) => u.url.startsWith("http://") || u.url.startsWith("https://"));
    if (!hasRemainingFiles && !hasHttpUrls) {
      topic.mindMap = null;
      topic.mindMapGeneratedAt = null;
    }

    await topic.save();

    res.status(200).json({ success: true });
  } catch (error) {
    log.error({ err: error }, "Error deleting file");

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

    if (topic.files.length + files.length > MAX_FILES_PER_TOPIC) {
      res.status(400).json({
        error: {
          code: "FILE_LIMIT_EXCEEDED",
          message: `A topic cannot have more than ${MAX_FILES_PER_TOPIC} files. Current: ${topic.files.length}, Requested: ${files.length}`,
        },
      } as ErrorResponse);
      return;
    }

    const uploadUrls = await Promise.all(
      files.map(async (file) => ({
        fileName: file.fileName,
        uploadUrl: await generatePresignedUploadUrl(req.userId!, id, file.fileName, file.contentType, file.size),
      })),
    );

    // A pending entry per file, so it shows on the topic page while it uploads and extracts.
    await upsertPendingFileEntries(id, req.userId!, files);

    res.status(200).json({ uploadUrls });
  } catch (error) {
    log.error({ err: error }, "Error generating upload URLs");

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
 * POST /api/topics/:id/reset
 * Reset topic progress (SM-2 values and revision records)
 */
export async function resetTopicProgress(req: Request, res: Response): Promise<void> {
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

    topic.eFactor = 2.5;
    topic.interval = 1;
    topic.repetitionNumber = 0;
    topic.revisionDate = topic.dateStudied;
    topic.lastRevised = null;
    topic.lastQuality = null;
    await topic.save();

    await RevisionRecord.deleteMany({ topicId: id, userId: req.userId });

    res.status(200).json({ success: true, revisionDate: topic.revisionDate });
  } catch (error) {
    log.error({ err: error }, "Error resetting topic progress");

    res.status(500).json({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to reset topic progress",
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
    log.error({ err: error }, "Error deleting topic");

    res.status(500).json({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to delete topic",
        details: error instanceof Error ? error.message : "Unknown error",
      },
    } as ErrorResponse);
  }
}

/**
 * The status an attachment shows on the topic page, with its reason when it failed.
 */
function statusFields(att: { processingStatus?: string | null; errorReason?: string | null }) {
  const processingStatus = att.processingStatus ?? "pending";
  return processingStatus === "failed" ? { processingStatus, errorReason: att.errorReason ?? "Extraction failed" } : { processingStatus };
}
