import { Request, Response } from "express";
import { Topic } from "@models/Topic.js";
import { calculateNextReview } from "@services/sm2Algorithm.js";
import { generatePresignedUploadUrl } from "@services/s3Storage.js";
import { invokeUrlProcessor } from "@services/lambdaInvoker.js";
import { CreateTopicResponse } from "$types/createTopic.types.js";
import { ErrorResponse } from "$types/common.types.js";
import { createTopicSchema } from "@/schemas/index.js";

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
    console.log("Topic create details : ", validation.data);
    const dateStudiedParsed = new Date(dateStudied);

    const sm2Result = calculateNextReview({
      eFactor: 2.5,
      repetitionNumber: 0,
      interval: 1,
      quality: 3,
    });

    const topic = new Topic({
      userId: req.userId!,
      topicName: topicName.trim(),
      subjectName: subjectName.trim(),
      description: description?.trim() || "",
      urls: urls?.map((url) => ({ url })) || [],
      dateStudied: dateStudiedParsed,
      revisionDate: sm2Result.nextRevisionDate,
      lastRevised: null,
      eFactor: 2.5,
      repetitionNumber: 0,
      interval: 1,
      files: [],
    });

    await topic.save();

    if (urls?.length) {
      const processableUrls = urls.filter((u) => u.startsWith("http://") || u.startsWith("https://"));
      if (processableUrls.length) {
        invokeUrlProcessor({ topicId: topic._id.toString(), userId: req.userId!, urls: processableUrls });
      }
    }

    const uploadUrls =
      files?.map((file) => ({
        fileName: file.fileName,
        uploadUrl: generatePresignedUploadUrl(req.userId!, topic._id.toString(), file.fileName, file.contentType, file.size),
      })) || [];

    const response: CreateTopicResponse = {
      topicId: topic._id.toString(),
      topicName: topic.topicName,
      subjectName: topic.subjectName,
      description: topic.description,
      dateStudied: topic.dateStudied.toISOString(),
      revisionDate: topic.revisionDate.toISOString(),
      isDue: topic.isDue,
      uploadUrls: await Promise.all(
        uploadUrls.map(async (u) => ({
          fileName: u.fileName,
          uploadUrl: await u.uploadUrl,
        })),
      ),
    };

    res.status(201).json(response);
  } catch (error) {
    console.error("Error creating topic:", error);

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
