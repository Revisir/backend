import { Types } from "mongoose";
import { Topic, truncateErrorReason, type IAttachedUrl } from "@models/Topic.js";
import { Publishers } from "@services/rabbitmq/index.js";
import { deleteByPath } from "@services/s3Storage.js";
import { buildUploadKey } from "@services/uploadKey.js";
import { fileTypeFor } from "@services/attachments.js";
import { afterMaterialRemoved, bestEffort, onAttachmentSettled } from "@services/questionBankJobs.js";
import { S3_BUCKET_NAME } from "@config/s3.js";
import { logger } from "@config/logger.js";

const log = logger.child({ module: "topicMaterials" });

/**
 * Writes that keep a topic's attachment entries truthful (KTD13): a pending
 * entry exists from the moment an upload URL is issued, URL saves only touch
 * URLs that changed, and anything that cannot be sent for extraction is saved
 * as failed with a reason rather than left pending forever.
 */

/**
 * Filters URLs to only those with http:// or https:// scheme.
 * Used to determine which URLs are publishable to the URL processing queue.
 */
export function filterPublishableUrls(urls: string[]): string[] {
  return urls.filter((u) => u.startsWith("http://") || u.startsWith("https://"));
}

export const URL_NOT_EXTRACTABLE_REASON = "Only http:// and https:// URLs can be extracted";
export const URL_NOT_QUEUED_REASON = "The URL could not be queued for extraction";

export interface DeclaredFile {
  fileName: string;
  contentType: string;
  size: number;
}

/** A pending file entry for an upload whose URL is being issued. */
export function pendingFileEntry(userId: string, topicId: string, file: DeclaredFile, now: Date = new Date()) {
  return {
    fileName: file.fileName,
    fileType: fileTypeFor(file.contentType),
    s3Path: buildUploadKey(userId, topicId, file.fileName),
    s3Bucket: S3_BUCKET_NAME,
    size: file.size,
    processingStatus: "pending" as const,
    statusUpdatedAt: now,
    processedAt: now,
  };
}

/**
 * Entries for newly added URLs: pending when they can be extracted, failed
 * with a reason when they cannot. Returns the URLs to publish.
 */
export function newUrlEntries(urls: string[], now: Date = new Date()): { entries: Partial<IAttachedUrl>[]; publishable: string[] } {
  const publishable = filterPublishableUrls(urls);
  const entries = urls.map((url) =>
    publishable.includes(url)
      ? { url, processingStatus: "pending" as const, statusUpdatedAt: now }
      : { url, processingStatus: "failed" as const, statusUpdatedAt: now, errorReason: URL_NOT_EXTRACTABLE_REASON },
  );
  return { entries, publishable };
}

/** Publishes URLs to the extraction queue. Returns false, never throws, when they could not be queued. */
export async function queueUrlsForExtraction(topicId: string, userId: string, urls: string[]): Promise<boolean> {
  if (!urls.length) return true;
  if (!Publishers.url) {
    log.error({ topicId, urls }, "URL publisher not initialised; URLs not queued");
    return false;
  }
  try {
    const queued = await Publishers.url.publish({ message: { topicId, userId, urls } });
    if (!queued) log.error({ topicId, urls }, "Failed to publish URL processing message");
    return queued;
  } catch (err) {
    log.error({ err, topicId, urls }, "Failed to publish URL processing message");
    return false;
  }
}

/** Marks pending URLs that could not be queued as failed. */
export async function markUrlsUnqueued(topicId: string, userId: string, urls: string[], now: Date = new Date()): Promise<void> {
  await Topic.updateOne(
    { _id: topicId, userId },
    {
      $set: {
        "urls.$[elem].processingStatus": "failed",
        "urls.$[elem].errorReason": URL_NOT_QUEUED_REASON,
        "urls.$[elem].statusUpdatedAt": now,
      },
    },
    { arrayFilters: [{ "elem.url": { $in: urls }, "elem.processingStatus": "pending" }] },
  );
}

/** Queues URLs and, when that fails, saves them as failed. */
export async function queueUrlsOrMarkFailed(topicId: string, userId: string, urls: string[], now: Date = new Date()): Promise<boolean> {
  const queued = await queueUrlsForExtraction(topicId, userId, urls);
  if (!queued) await markUrlsUnqueued(topicId, userId, urls, now);
  return queued;
}

/**
 * Creates a pending entry per declared file, or resets the existing entry
 * when a file of the same name is uploaded again.
 */
export async function upsertPendingFileEntries(topicId: string, userId: string, files: DeclaredFile[], now: Date = new Date()): Promise<void> {
  for (const file of files) {
    const entry = pendingFileEntry(userId, topicId, file, now);
    const reset = await Topic.updateOne(
      { _id: topicId, userId, "files.s3Path": entry.s3Path },
      {
        $set: {
          "files.$.fileType": entry.fileType,
          "files.$.size": entry.size,
          "files.$.processingStatus": "pending",
          "files.$.statusUpdatedAt": now,
          "files.$.errorReason": null,
        },
      },
    );
    if (reset.matchedCount === 0) {
      await Topic.updateOne({ _id: topicId, userId, "files.s3Path": { $ne: entry.s3Path } }, { $push: { files: entry } });
    }
  }
}

/**
 * Ensures an uploaded object has a file entry, creating it from the object's
 * HEAD when the API never did (uploads that predate pending entries, or a lost
 * write). Returns false when the topic no longer exists.
 */
export async function ensureFileEntry(params: {
  topicId: string;
  userId: string;
  key: string;
  bucket: string;
  fileName: string;
  contentType: string;
  size: number;
  now?: Date;
}): Promise<boolean> {
  const { topicId, userId, key, bucket, fileName, contentType, size, now = new Date() } = params;
  if (!Types.ObjectId.isValid(topicId)) return false;
  if (!(await Topic.exists({ _id: topicId, userId }))) return false;

  await Topic.updateOne(
    { _id: topicId, userId, "files.s3Path": { $ne: key } },
    {
      $push: {
        files: {
          fileName,
          fileType: fileTypeFor(contentType),
          s3Path: key,
          s3Bucket: bucket,
          size,
          processingStatus: "pending",
          statusUpdatedAt: now,
          processedAt: now,
        },
      },
    },
  );
  return true;
}

/** Sets a file entry's processing status. */
export async function setFileStatus(
  topicId: string,
  userId: string,
  key: string,
  status: "processing" | "completed" | "failed",
  extra: { extractedContentUrl?: string; errorReason?: string } = {},
  now: Date = new Date(),
): Promise<void> {
  const $set: Record<string, unknown> = {
    "files.$.processingStatus": status,
    "files.$.statusUpdatedAt": now,
  };
  if (status === "completed") {
    $set["files.$.extractedContentUrl"] = extra.extractedContentUrl;
    $set["files.$.processedAt"] = now;
    $set["files.$.errorReason"] = null;
  }
  if (status === "failed") $set["files.$.errorReason"] = truncateErrorReason(extra.errorReason ?? "Extraction failed");
  await Topic.updateOne({ _id: topicId, userId, "files.s3Path": key }, { $set });
}

/**
 * Applies a submitted URL list to a topic. Existing entries are left exactly as
 * they were, new URLs are appended (pending, or failed when they cannot be
 * extracted), and removed URLs lose their entry and their extracted file.
 * Uses atomic array updates so a concurrent worker status write is never lost.
 * Publishes only the new extractable URLs. Removing completed material
 * rebuilds the question bank from what remains (or clears it).
 */
export async function applyUrlListUpdate(
  topic: { _id: Types.ObjectId; userId: string; urls: ReadonlyArray<Pick<IAttachedUrl, "url" | "extractedContentPath" | "processingStatus">> },
  submitted: string[],
  now: Date = new Date(),
): Promise<{ added: string[]; removed: string[] }> {
  const topicId = topic._id.toString();
  const wanted = [...new Set(submitted)];
  const existing = new Set(topic.urls.map((u) => u.url));
  const removedEntries = topic.urls.filter((u) => !wanted.includes(u.url));
  const added = wanted.filter((url) => !existing.has(url));

  if (removedEntries.length) {
    await Topic.updateOne({ _id: topic._id, userId: topic.userId }, { $pull: { urls: { url: { $in: removedEntries.map((u) => u.url) } } } });
    for (const removed of removedEntries) {
      if (removed.extractedContentPath) await deleteByPath(removed.extractedContentPath);
    }
  }

  if (added.length) {
    const { entries, publishable } = newUrlEntries(added, now);
    await Topic.updateOne({ _id: topic._id, userId: topic.userId }, { $push: { urls: { $each: entries } } });
    await queueUrlsOrMarkFailed(topicId, topic.userId, publishable, now);
  }

  await afterAttachmentRemoved(topicId, topic.userId, removedEntries, now);

  return { added, removed: removedEntries.map((u) => u.url) };
}

/**
 * Keeps the question bank in step with removed attachments: removing completed
 * material rebuilds the bank from what remains (or clears it when nothing
 * does); removing an unsettled or failed one may leave every remaining
 * attachment settled, which is when a first build is due.
 */
export async function afterAttachmentRemoved(
  topicId: string,
  userId: string,
  removed: ReadonlyArray<{ processingStatus?: string | null }>,
  now: Date = new Date(),
): Promise<void> {
  if (!removed.length) return;
  if (removed.some((att) => att.processingStatus === "completed")) {
    await bestEffort("material_removed", topicId, () => afterMaterialRemoved(topicId, userId, now));
  } else {
    await bestEffort("attachment_settled", topicId, () => onAttachmentSettled(topicId, userId, now));
  }
}
