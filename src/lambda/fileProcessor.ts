import "dotenv/config";

import { S3Event, Context } from "aws-lambda";
import { GetObjectCommand, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import mongoose from "mongoose";
import { Topic, truncateErrorReason } from "@models/Topic.js";
import { extractContent } from "@services/fileExtractor.js";
import { parseUploadKey } from "@services/uploadKey.js";
import { logger } from "@config/logger.js";
import { s3Client } from "@/config/s3.js";
import { ALLOWED_CONTENT_TYPES, MAX_FILE_SIZE } from "@/config/fileConstants.js";
import { ConnectionManager } from "@services/rabbitmq/connectionManager.js";
import { QueuePublisher } from "@services/rabbitmq/publisher.js";
import { QueueConsumer, type MessageOutcome } from "@services/rabbitmq/consumer.js";
import { RABBITMQ_CONFIG, RABBITMQ_URL } from "@config/rabbitmq.js";
import { fileProcessingMessageSchema, type FileProcessingMessage } from "@/schemas/queue.schema.js";
import type { ConsumeMessage } from "amqplib";

const log = logger.child({ module: "fileProcessor" });

let isConnected = false;

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
 * Determines if a file processing message should be skipped based on the object key.
 * Messages with keys containing "/extracted/" are acknowledged without processing
 * to prevent reprocessing loops.
 */
export function shouldSkipExtractedKey(key: string): boolean {
  return key.includes("/extracted/");
}

/**
 * Determines if an error is transient (network timeout, S3 unavailability, DB failure)
 * and should result in a nack_requeue.
 */
export function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("timeout") ||
    msg.includes("econnrefused") ||
    msg.includes("econnreset") ||
    msg.includes("network") ||
    msg.includes("etimedout") ||
    msg.includes("ehostunreach") ||
    (msg.includes("mongo") && msg.includes("connect")) ||
    (msg.includes("s3") && !msg.includes("nosuchbucket"))
  );
}

/**
 * Process a single file upload event.
 * Throws typed errors for classification by the message handler.
 */
async function processFile(bucket: string, key: string): Promise<void> {
  const parsedKey = parseUploadKey(key);
  if (!parsedKey) {
    throw new Error(`Key is not shaped like an upload: ${key}`);
  }
  const { topicId, userId, fileName } = parsedKey;

  const headResponse = await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  const contentType = headResponse.ContentType || "application/octet-stream";

  // Validate content type
  if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
    throw new Error(`Invalid content type: ${contentType} for key: ${key}`);
  }

  // Validate file size
  const contentLength = headResponse.ContentLength || 0;
  if (contentLength > MAX_FILE_SIZE) {
    throw new Error(`File exceeds size limit: ${contentLength} bytes for key: ${key}`);
  }

  await connectDB();

  // Find the file subdocument by s3Path and update status to "processing"
  await Topic.updateOne(
    { _id: topicId, userId, "files.s3Path": key },
    { $set: { "files.$.processingStatus": "processing" } },
  );

  const response = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const fileBuffer = Buffer.from(await response.Body!.transformToByteArray());

  const fileType = getFileType(contentType);

  // Extract content
  const result = await extractContent(fileType, {
    fileBuffer,
    mimeType: contentType,
  });

  if (!result.success || !result.content) {
    // Mark as failed
    const errorMsg = result.error || "Extraction returned no content";
    await Topic.updateOne(
      { _id: topicId, userId, "files.s3Path": key },
      {
        $set: {
          "files.$.processingStatus": "failed",
          "files.$.errorReason": truncateErrorReason(errorMsg),
        },
      },
    );
    throw new Error(`Extraction failed for key: ${key}: ${errorMsg}`);
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

  // Update file with extractedContentUrl and mark as completed
  await Topic.updateOne(
    { _id: topicId, userId, "files.s3Path": key },
    {
      $set: {
        "files.$.extractedContentUrl": extractedPath,
        "files.$.processingStatus": "completed",
        "files.$.processedAt": new Date(),
      },
    },
  );

  log.info({ key }, "Successfully processed file");
}

/**
 * RabbitMQ message handler for file processing messages.
 *
 * - Reads the `{ bucket, key }` message published by `storageWebhookController`
 *   (the consumer has already validated it against fileProcessingMessageSchema)
 * - Skips "/extracted/" keys (ack without processing)
 * - Processes the file using processFile()
 * - Classifies errors: transient → nack_requeue, permanent → nack_reject
 */
async function handleFileMessage(msg: ConsumeMessage): Promise<MessageOutcome> {
  const { bucket, key } = JSON.parse(msg.content.toString()) as FileProcessingMessage;

  // Skip "/extracted/" keys (ack without processing)
  if (shouldSkipExtractedKey(key)) {
    log.debug({ key }, "Skipping /extracted/ key, acking");
    return "ack";
  }

  log.info({ bucket, key }, "Processing file message");

  try {
    await processFile(bucket, key);
    return "ack";
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);

    // Classify the error
    if (isTransientError(err)) {
      log.warn({ bucket, key, err }, "Transient error during file processing, requeueing");
      return "nack_requeue";
    }

    // Permanent error — store errorReason on the file subdocument if possible
    log.error({ bucket, key, err }, "Permanent error during file processing, rejecting");

    // Try to update the file status to failed (best effort)
    try {
      const parsedKey = parseUploadKey(key);

      if (parsedKey) {
        await connectDB();
        const { topicId, userId } = parsedKey;
        await Topic.updateOne(
          { _id: topicId, userId, "files.s3Path": key },
          {
            $set: {
              "files.$.processingStatus": "failed",
              "files.$.errorReason": truncateErrorReason(errorMsg),
            },
          },
        );
      }
    } catch (updateErr) {
      log.error({ err: updateErr, bucket, key }, "Failed to update file status on permanent error");
    }

    return "nack_reject";
  }
}

/**
 * Starts the file processor consumer.
 * Connects to RabbitMQ, declares Queue with named exchange, and begins consuming messages.
 */
export async function startFileConsumer(): Promise<void> {
  const connectionManager = new ConnectionManager({ url: RABBITMQ_URL });
  await connectionManager.connect();

  QueuePublisher.setConnectionManager(connectionManager);
  await new QueuePublisher({
    queue: RABBITMQ_CONFIG.FILE_PROCESSING_QUEUE,
    exchange: RABBITMQ_CONFIG.FILE_PROCESSING_EXCHANGE,
    routingKey: RABBITMQ_CONFIG.FILE_PROCESSING_ROUTING_KEY,
    dlqName: RABBITMQ_CONFIG.FILE_PROCESSING_DLQ,
  }).init();

  const consumer = new QueueConsumer(connectionManager);
  await consumer.consume(RABBITMQ_CONFIG.FILE_PROCESSING_QUEUE, handleFileMessage, {
    schema: fileProcessingMessageSchema,
  });

  log.info("File processor consumer started");
}

/**
 * AWS Lambda handler - triggered by S3 event notifications (backward compatibility)
 */
export const handler = async (event: S3Event, _context: Context) => {
  log.info({ event: JSON.stringify(event) }, "Processing S3 event");

  await connectDB();

  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));

    // Skip extracted content files
    if (key.includes("/extracted/")) continue;

    try {
      await processFile(bucket, key);
    } catch (error) {
      log.error({ key, err: error }, "Error processing file in Lambda handler");
    }
  }

  return { statusCode: 200, body: "Processing complete" };
};

// Auto-start consumer when this module is loaded as a standalone service
if (process.env.START_FILE_CONSUMER === "true") {
  connectDB()
    .then(() => startFileConsumer())
    .catch((err) => {
      log.fatal({ err }, "Failed to start file consumer");
      process.exit(1);
    });
}
