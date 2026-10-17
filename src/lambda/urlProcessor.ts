import "dotenv/config";

import { Context } from "aws-lambda";
import mongoose from "mongoose";
import { Topic } from "@models/Topic.js";
import { truncateErrorReason } from "@models/Topic.js";
import { saveExtractedContentAtPath } from "@services/s3Storage.js";
import { extractedFileNameForUrl } from "@services/uploadKey.js";
import { PROMPTS } from "@config/prompts.js";
import { logger } from "@config/logger.js";
import { tavily } from "@tavily/core";
import Exa from "exa-js";
import { readUrl } from "@services/jinaReader.js";
import { readUrlWithFirecrawl } from "@services/firecrawlReader.js";
import { ConnectionManager } from "@services/rabbitmq/connectionManager.js";
import { QueuePublisher } from "@services/rabbitmq/publisher.js";
import { QueueConsumer, type MessageOutcome } from "@services/rabbitmq/consumer.js";
import { RABBITMQ_CONFIG, RABBITMQ_URL } from "@config/rabbitmq.js";
import { urlProcessingMessageSchema } from "@/schemas/queue.schema.js";
import { Publishers, initQuestionBankPublisher } from "@services/rabbitmq/index.js";
import { bestEffort, onAttachmentSettled } from "@services/questionBankJobs.js";
import type { ConsumeMessage } from "amqplib";

const log = logger.child({ module: "urlProcessor" });

export interface UrlProcessorEvent {
  topicId: string;
  userId: string;
  urls: string[];
}

let isConnected = false;

async function connectDB() {
  if (isConnected || mongoose.connection.readyState === 1) return;
  await mongoose.connect(process.env.MONGODB_URI!);
  isConnected = true;
}

const URL_EXTRACTOR = process.env.URL_EXTRACTOR || "jina"; // "tavily" | "jina" | "exa" | "firecrawl"

async function extractWithTavily(url: string): Promise<string | null> {
  const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY! });
  const response = await tvly.extract([url]);
  const result = response.results?.[0];
  return result?.rawContent || (result as any)?.text || null;
}

async function extractWithJina(url: string): Promise<string | null> {
  const result = await readUrl(url, {
    engine: "browser",
    respondWith: "markdown",
    timeout: 30,
  });
  return result.success ? result.content : null;
}

async function extractWithExa(url: string): Promise<string | null> {
  const exa = (Exa as any).default ? new (Exa as any).default(process.env.EXA_API_KEY!) : new (Exa as any)(process.env.EXA_API_KEY!);
  const result = await exa.getContents([url], {
    summary: { query: PROMPTS.extraction.url },
  });
  return result.results?.[0]?.summary || result.results?.[0]?.text || null;
}

async function extractWithFirecrawl(url: string): Promise<string | null> {
  const result = await readUrlWithFirecrawl(url);
  return result.success ? result.content : null;
}

async function extractUrl(url: string): Promise<string | null> {
  try {
    switch (URL_EXTRACTOR) {
      case "tavily":
        return await extractWithTavily(url);
      case "exa":
        return await extractWithExa(url);
      case "firecrawl":
        return await extractWithFirecrawl(url);
      default:
        return await extractWithJina(url);
    }
  } catch (error) {
    log.error({ url, err: error }, "URL extraction failed");
    throw error; // Re-throw so caller can classify the error
  }
}

async function processUrl(topicId: string, userId: string, url: string) {
  const content = await extractUrl(url);
  if (!content) return;

  const extractedPath = await saveExtractedContentAtPath(userId, topicId, extractedFileNameForUrl(url), content);

  await Topic.updateOne(
    { _id: topicId, userId, "urls.url": url },
    {
      $set: {
        "urls.$.extractedContentPath": extractedPath,
        "urls.$.processedAt": new Date(),
      },
    },
  );

  log.info({ url }, "URL processed");
}

/**
 * Determines if an error is transient (network timeout, DB connection failure)
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
    (msg.includes("mongo") && msg.includes("connect"))
  );
}

/**
 * RabbitMQ message handler for URL processing messages from Queue A.
 *
 * - Validates message with urlProcessingMessageSchema (handled by consumer)
 * - Updates URL statuses to "processing"
 * - Extracts content for each URL
 * - Updates status to "completed" or "failed" per URL
 * - Classifies errors: transient → nack_requeue, permanent → nack_reject
 */
export async function handleUrlMessage(msg: ConsumeMessage): Promise<MessageOutcome> {
  const parsed = JSON.parse(msg.content.toString());
  const { topicId, userId, urls } = parsed;

  log.info({ topicId, userId, urlCount: urls.length }, "Processing URL message");

  // Update all URL statuses to "processing"
  await Topic.updateMany(
    { _id: topicId, userId },
    { $set: { "urls.$[elem].processingStatus": "processing", "urls.$[elem].statusUpdatedAt": new Date() } },
    { arrayFilters: [{ "elem.url": { $in: urls } }] },
  );

  let allFailed = true;

  for (const url of urls) {
    // Defensive: skip "/extracted/" keys if encountered
    if (url.includes("/extracted/")) {
      log.debug({ url }, "Skipping /extracted/ URL");
      continue;
    }

    try {
      const content = await extractUrl(url);

      if (content) {
        const extractedPath = await saveExtractedContentAtPath(userId, topicId, extractedFileNameForUrl(url), content);

        await Topic.updateOne(
          { _id: topicId, userId, "urls.url": url },
          {
            $set: {
              "urls.$.extractedContentPath": extractedPath,
              "urls.$.processedAt": new Date(),
              "urls.$.processingStatus": "completed",
              "urls.$.statusUpdatedAt": new Date(),
              "urls.$.errorReason": null,
            },
          },
        );

        allFailed = false;
        log.info({ url }, "URL extracted successfully");
      } else {
        // Extraction returned no content - permanent failure for this URL
        await Topic.updateOne(
          { _id: topicId, userId, "urls.url": url },
          {
            $set: {
              "urls.$.processingStatus": "failed",
              "urls.$.statusUpdatedAt": new Date(),
              "urls.$.errorReason": truncateErrorReason("Extraction returned no content"),
            },
          },
        );
        log.warn({ url }, "URL extraction returned no content");
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      // Classify as transient if network/DB error → nack_requeue the whole message
      if (isTransientError(err)) {
        log.warn({ url, err }, "Transient error during URL extraction, requeueing message");
        return "nack_requeue";
      }

      // Permanent failure for this URL
      await Topic.updateOne(
        { _id: topicId, userId, "urls.url": url },
        {
          $set: {
            "urls.$.processingStatus": "failed",
            "urls.$.statusUpdatedAt": new Date(),
            "urls.$.errorReason": truncateErrorReason(errorMsg),
          },
        },
      );
      log.error({ url, err }, "URL extraction failed permanently");
    }
  }

  // Every URL in the message has settled; build the bank if the whole topic has.
  await bestEffort("attachment_settled", topicId, () => onAttachmentSettled(topicId, userId));

  // If all URLs failed with permanent errors, reject the message
  if (allFailed) {
    log.warn({ topicId }, "All URLs failed extraction, rejecting message");
    return "nack_reject";
  }

  return "ack";
}

/**
 * Starts the URL processor consumer.
 * Connects to RabbitMQ, declares Queue with named exchange, and begins consuming messages.
 */
export async function startUrlConsumer(): Promise<void> {
  const connectionManager = new ConnectionManager({ url: RABBITMQ_URL });
  await connectionManager.connect();

  QueuePublisher.setConnectionManager(connectionManager);
  await new QueuePublisher({
    queue: RABBITMQ_CONFIG.URL_PROCESSING_QUEUE,
    exchange: RABBITMQ_CONFIG.URL_PROCESSING_EXCHANGE,
    routingKey: RABBITMQ_CONFIG.URL_PROCESSING_ROUTING_KEY,
    dlqName: RABBITMQ_CONFIG.URL_PROCESSING_DLQ,
  }).init();

  // Publishes bank builds when a topic's attachments settle; the file-processor builds them.
  Publishers.questionBank = await initQuestionBankPublisher();

  const consumer = new QueueConsumer(connectionManager);
  await consumer.consume(RABBITMQ_CONFIG.URL_PROCESSING_QUEUE, handleUrlMessage, {
    schema: urlProcessingMessageSchema,
  });

  log.info("URL processor consumer started");
}

/**
 * AWS Lambda handler (kept for backward compatibility)
 */
export const handler = async (event: UrlProcessorEvent, _context?: Context) => {
  log.info({ event }, "Processing URLs");

  const { topicId, userId, urls } = event;
  if (!topicId || !userId || !urls?.length) {
    return { statusCode: 400, body: "Missing required fields" };
  }

  await connectDB();

  for (const url of urls) {
    await processUrl(topicId, userId, url);
  }

  return { statusCode: 200, body: "URL processing complete" };
};

// Auto-start consumer when this module is loaded as a standalone service
if (process.env.START_URL_CONSUMER === "true") {
  connectDB()
    .then(() => startUrlConsumer())
    .catch((err) => {
      log.fatal({ err }, "Failed to start URL consumer");
      process.exit(1);
    });
}
