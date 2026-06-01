import "dotenv/config";

import { S3Event, Context } from "aws-lambda";
import { GetObjectCommand, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import mongoose from "mongoose";
import { Topic, IAttachedFile } from "@models/Topic.js";
import { extractContent } from "@services/fileExtractor.js";
import { s3Client, S3_BUCKET_NAME, minioClient, useMinio } from "@/config/s3.js";
import { ALLOWED_CONTENT_TYPES, MAX_FILE_SIZE } from "@/config/fileConstants.js";

let isConnected = false;

const recentlyProcessed = new Map<string, number>();
const DEDUP_TTL_MS = 10_000;

function isDuplicate(key: string): boolean {
  const now = Date.now();
  const lastSeen = recentlyProcessed.get(key);
  if (lastSeen && now - lastSeen < DEDUP_TTL_MS) return true;
  recentlyProcessed.set(key, now);
  // Cleanup old entries
  for (const [k, t] of recentlyProcessed) {
    if (now - t > DEDUP_TTL_MS) recentlyProcessed.delete(k);
  }
  return false;
}

async function connectDB() {
  if (isConnected) return;
  await mongoose.connect(process.env.MONGODB_URI!);
  isConnected = true;
}

function getFileType(contentType: string): "image" | "pdf" | "text" {
  if (contentType.startsWith("image/")) return "image";
  if (contentType === "application/pdf") return "pdf";
  return "text";
}

/**
 * Process a single file upload event
 */
async function processFile(bucket: string, key: string) {
  try {
    const headResponse = await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    const contentType = headResponse.ContentType || "application/octet-stream";
    const topicId = headResponse.Metadata?.topicid || "";
    const userId = headResponse.Metadata?.userid || "";
    const fileName = headResponse.Metadata?.filename || "";

    if (!topicId || !userId || !fileName) {
      console.error(`Missing required metadata for ${key}. topicId:${topicId}, userId:${userId}, fileName:${fileName}`);
      return;
    }

    // Validate content type
    if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
      console.error(`Invalid content type '${contentType}' for ${key}`);
      return;
    }

    // Validate file size
    const contentLength = headResponse.ContentLength || 0;
    if (contentLength > MAX_FILE_SIZE) {
      console.error(`File exceeds size limit: ${contentLength} bytes for ${key}`);
      return;
    }

    const response = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const fileBuffer = Buffer.from(await response.Body!.transformToByteArray());

    await connectDB();

    const fileType = getFileType(contentType);

    // Save file to DB first
    const fileId = new mongoose.Types.ObjectId();
    const fileData: IAttachedFile = {
      _id: fileId,
      fileName,
      fileType,
      s3Path: key,
      s3Bucket: bucket,
      processedAt: new Date(),
    };

    const topic = await Topic.findOneAndUpdate({ _id: topicId, userId }, { $push: { files: fileData } });
    if (!topic) {
      console.error(`Topic not found: ${topicId}`);
      return;
    }

    // Extract content
    const result = await extractContent(fileType, {
      fileBuffer,
      mimeType: contentType,
    });

    if (!result.success || !result.content) {
      console.error(`Extraction failed for ${key}:`, result.error);
      return;
    }

    const extractedPath = `${userId}/${topicId}/extracted/${fileName}.md`;

    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: extractedPath,
        Body: result.content,
        ContentType: "text/plain",
        Metadata: { userid: userId, topicid: topicId, originalfile: fileName },
      }),
    );

    // Update file with extractedContentUrl using the saved file's _id
    await Topic.updateOne({ _id: topicId, "files._id": fileId }, { $set: { "files.$.extractedContentUrl": extractedPath } });

    console.log(`Successfully processed: ${key}`);
  } catch (error) {
    console.error(`Error processing ${key}:`, error);
  }
}

/**
 * AWS Lambda handler - triggered by S3 event notifications
 */
export const handler = async (event: S3Event, _context: Context) => {
  console.log("Processing S3 event:", JSON.stringify(event, null, 2));

  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
    await processFile(bucket, key);
  }

  return { statusCode: 200, body: "Processing complete" };
};

/**
 * MinIO bucket notification listener - runs as a long-lived process
 * Automatically triggers when a file is uploaded to MinIO
 *
 * PREREQUISITE: MinIO must have bucket notifications enabled.
 * Run: mc event add local/revision-study-content arn:minio:sqs::_:webhook --event put
 */
export async function startMinioListener() {
  if (!useMinio || !minioClient) {
    console.error("MinIO listener can only run when BUCKET_TYPE=minio");
    return;
  }

  console.log(`Starting MinIO bucket notification listener on bucket: ${S3_BUCKET_NAME}`);

  // Empty prefix and suffix to listen for all objects
  const poller = minioClient.listenBucketNotification(S3_BUCKET_NAME, "", "", ["s3:ObjectCreated:*"]);

  poller.on("notification", async (record: any) => {
    try {
      console.log("Triggered");
      const events = record.Records || [record];
      for (const event of events) {
        if (!event.s3) continue;
        const bucket = event.s3.bucket.name;

        const key = decodeURIComponent(event.s3.object.key.replace(/\+/g, " "));

        // Skip extracted content files to avoid infinite loop
        if (key.includes("/extracted/")) continue;

        // Skip duplicate notifications for the same key
        if (isDuplicate(key)) continue;

        console.log(`MinIO notification received for: ${key}`);
        await processFile(bucket, key);
      }
    } catch (error) {
      console.error("Error handling notification:", error);
    }
  });

  poller.start();

  poller.on("error", (error: unknown) => {
    console.error("MinIO listener error:", error);
    // Restart listener after a delay
    setTimeout(() => {
      console.log("Restarting MinIO listener...");
      startMinioListener();
    }, 5000);
  });

  console.log("MinIO listener started successfully");
}

// Auto-start MinIO listener when this module is loaded in dev
console.log("BUCKET_TYPE:", process.env.BUCKET_TYPE, "useMinio:", useMinio);
if (useMinio) {
  console.log("Notification server on");
  startMinioListener();
}
