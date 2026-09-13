import { Request, Response } from "express";
import { ErrorResponse } from "$types/common.types.js";
import { storageNotificationSchema } from "@/schemas/index.js";
import { Publishers } from "@services/rabbitmq/index.js";
import { parseUploadKey } from "@services/uploadKey.js";
import type { QueuePublisher } from "@services/rabbitmq/publisher.js";
import { logger } from "@config/logger.js";

const log = logger.child({ module: "storageWebhookController" });

/**
 * Filer path under which the SeaweedFS S3 gateway stores every bucket.
 * Matches the gateway's own default; we do not override it.
 */
const BUCKETS_PATH = "/buckets/";

/**
 * Filer events that mean "these bytes are new or changed, extract them".
 * Deletes and renames carry no content to process.
 */
const PROCESSABLE_EVENTS = new Set(["create", "update"]);

let publisherOverride: QueuePublisher | null = null;

/**
 * Overrides the publisher used by `handleStorageWebhook`.
 * Exists so tests can capture published messages; production reads
 * `Publishers.file`, which `initRabbitMQ()` populates at startup.
 */
export function setWebhookPublisher(publisher: QueuePublisher): void {
  publisherOverride = publisher;
}

/**
 * Splits a filer path into its bucket and S3 object key.
 *
 * `/buckets/revision-study-content/user/topic/files/a.pdf`
 *   → `{ bucket: "revision-study-content", key: "user/topic/files/a.pdf" }`
 *
 * Returns null for paths outside the bucket root, and for the bucket
 * directories themselves (which have no object key).
 */
export function splitFilerPath(filerPath: string): { bucket: string; key: string } | null {
  if (!filerPath.startsWith(BUCKETS_PATH)) return null;

  const relative = filerPath.slice(BUCKETS_PATH.length);
  const separator = relative.indexOf("/");
  if (separator <= 0) return null;

  const bucket = relative.slice(0, separator);
  const key = relative.slice(separator + 1);
  if (!bucket || !key) return null;

  return { bucket, key };
}

/**
 * POST /internal/storage-webhook
 *
 * Receives SeaweedFS filer notifications and publishes one `{ bucket, key }`
 * message per uploaded object onto the file processing queue.
 *
 * Events are dropped without publishing when they are not a create/update, are
 * a directory entry, sit outside a bucket, point at already-extracted content, or
 * are not shaped like an upload. Extracted content would otherwise loop, since the
 * file processor writes its output back into the same bucket; and SeaweedFS emits
 * events for its own writes under the `.system` bucket, which nothing downstream
 * can process.
 *
 * Always answers 2xx once the body parses: SeaweedFS retries non-2xx with
 * backoff, and a filtered event is a successful no-op, not a failure.
 */
export async function handleStorageWebhook(req: Request, res: Response): Promise<void> {
  const validation = storageNotificationSchema.safeParse(req.body);
  if (!validation.success) {
    log.warn({ issues: validation.error.issues }, "Rejected malformed storage notification");
    res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: validation.error.issues[0].message,
      },
    } as ErrorResponse);
    return;
  }

  const { key: filerPath, event_type: eventType, message } = validation.data;

  if (!PROCESSABLE_EVENTS.has(eventType)) {
    log.debug({ filerPath, eventType }, "Ignoring non-content storage event");
    res.status(204).send();
    return;
  }

  if (message?.new_entry?.is_directory) {
    log.debug({ filerPath }, "Ignoring directory storage event");
    res.status(204).send();
    return;
  }

  const location = splitFilerPath(filerPath);
  if (!location) {
    log.debug({ filerPath }, "Ignoring storage event outside a bucket");
    res.status(204).send();
    return;
  }

  const { bucket, key } = location;

  if (key.includes("/extracted/")) {
    log.debug({ bucket, key }, "Ignoring extracted content, would reprocess");
    res.status(204).send();
    return;
  }

  if (!parseUploadKey(key)) {
    log.debug({ bucket, key }, "Ignoring key that is not an upload");
    res.status(204).send();
    return;
  }

  const publisher = publisherOverride ?? Publishers.file;
  if (!publisher) {
    log.error({ bucket, key }, "File publisher unavailable, dropping storage event");
    res.status(503).json({
      error: {
        code: "QUEUE_UNAVAILABLE",
        message: "File processing queue is not available",
      },
    } as ErrorResponse);
    return;
  }

  const published = await publisher.publish({ message: { bucket, key } });
  if (!published) {
    log.error({ bucket, key }, "Failed to publish file processing message");
    res.status(503).json({
      error: {
        code: "PUBLISH_FAILED",
        message: "Could not enqueue the uploaded file for processing",
      },
    } as ErrorResponse);
    return;
  }

  log.info({ bucket, key, eventType }, "Enqueued uploaded file for processing");
  res.status(202).json({ status: "queued" });
}
