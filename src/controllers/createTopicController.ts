import { Request, Response } from "express";
import { Topic } from "@models/Topic.js";
import { calculateNextReview } from "@services/sm2Algorithm.js";
import { generatePresignedUploadUrl } from "@services/s3Storage.js";
import { newUrlEntries, pendingFileEntry, queueUrlsOrMarkFailed } from "@services/topicMaterials.js";
import { CreateTopicResponse } from "$types/createTopic.types.js";
import { ErrorResponse } from "$types/common.types.js";
import { createTopicSchema } from "@/schemas/index.js";
import { logger } from "@config/logger.js";

const log = logger.child({ module: "createTopicController" });

/**
 * POST /api/topics
 * Creates a new topic and generates presigned URLs for file uploads
 */
export async function createTopic(req: Request, res: Response): Promise<void> {
  try {
    const validation = createTopicSchema.safeParse(req.body);
    if (!validation.success) {
      res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: validation.error.issues[0].message,
        },
      } as ErrorResponse);
      return;
    }

    const { topicName, subjectName, description, dateStudied, files, urls } = validation.data;
    log.info({ data: validation.data }, "Topic create details");
    const dateStudiedParsed = new Date(dateStudied);

    const sm2Result = calculateNextReview({
      eFactor: 2.5,
      repetitionNumber: 0,
      interval: 1,
      quality: 3,
    });

    const now = new Date();
    const { entries: urlEntries, publishable } = newUrlEntries([...new Set(urls ?? [])], now);

    const topic = new Topic({
      userId: req.userId!,
      topicName: topicName.trim(),
      subjectName: subjectName.trim(),
      description: description?.trim() || "",
      urls: urlEntries,
      dateStudied: dateStudiedParsed,
      revisionDate: sm2Result.nextRevisionDate,
      lastRevised: null,
      eFactor: 2.5,
      repetitionNumber: 0,
      interval: 1,
      files: [],
    });

    // Issuing the upload URLs validates each declared file (type, size, path),
    // so a rejected file fails the request before anything is saved.
    const uploadUrls = await Promise.all(
      (files ?? []).map(async (file) => ({
        fileName: file.fileName,
        uploadUrl: await generatePresignedUploadUrl(req.userId!, topic._id.toString(), file.fileName, file.contentType, file.size),
      })),
    );

    // A pending entry per declared file, so the topic page and the
    // all-attachments-settled check see uploads still on their way (KTD13).
    const declaredFiles = [...new Map((files ?? []).map((f) => [f.fileName, f])).values()];
    for (const file of declaredFiles) {
      topic.files.push(pendingFileEntry(req.userId!, topic._id.toString(), file, now));
    }

    await topic.save();

    try {
      await queueUrlsOrMarkFailed(topic._id.toString(), req.userId!, publishable, now);
    } catch (err) {
      // The topic is saved either way; a URL left pending is failed by the staleness sweep.
      log.error({ err, topicId: topic._id.toString(), urls: publishable }, "Failed to record unqueued URLs");
    }

    const response: CreateTopicResponse = {
      topicId: topic._id.toString(),
      topicName: topic.topicName,
      subjectName: topic.subjectName,
      description: topic.description,
      dateStudied: topic.dateStudied.toISOString(),
      revisionDate: topic.revisionDate.toISOString(),
      isDue: topic.isDue,
      uploadUrls,
    };

    res.status(201).json(response);
  } catch (error) {
    log.error({ err: error }, "Error creating topic");

    if (error instanceof Error && error.name === "ValidationError") {
      res.status(400).json({
        error: {
          code: "MONGODB_VALIDATION_ERROR",
          message: "Invalid data provided",
          details: error.message,
        },
      } as ErrorResponse);
      return;
    }

    res.status(500).json({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to create topic",
        details: error instanceof Error ? error.message : "Unknown error",
      },
    } as ErrorResponse);
  }
}
