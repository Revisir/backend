import { Types } from "mongoose";
import { ATTACHMENT_STALE_MS } from "@config/questionBank.js";
import type { IAttachedFile, IAttachedUrl, ProcessingStatus } from "@models/Topic.js";

/**
 * Pure helpers over a topic's attachments (files and URLs), shared by review
 * availability, the question-bank triggers, the sweep and the launch repair.
 */

export interface AttachmentLike {
  _id?: Types.ObjectId | string | null;
  processingStatus?: ProcessingStatus | null;
  statusUpdatedAt?: Date | string | null;
}

export interface TopicAttachments {
  files?: ReadonlyArray<AttachmentLike & Pick<Partial<IAttachedFile>, "extractedContentUrl" | "fileName">> | null;
  urls?: ReadonlyArray<AttachmentLike & Pick<Partial<IAttachedUrl>, "extractedContentPath" | "url">> | null;
}

/** File type stored on a file entry, from the object's content type. */
export function fileTypeFor(contentType: string): "image" | "pdf" | "text" {
  if (contentType.startsWith("image/")) return "image";
  if (contentType === "application/pdf") return "pdf";
  return "text";
}

/** When the attachment last changed status: `statusUpdatedAt`, else the subdocument's creation time. */
export function statusTime(att: AttachmentLike): Date | null {
  if (att.statusUpdatedAt) return new Date(att.statusUpdatedAt);
  if (att._id && Types.ObjectId.isValid(att._id)) return new Types.ObjectId(att._id).getTimestamp();
  return null;
}

function isUnsettled(att: AttachmentLike): boolean {
  const status = att.processingStatus ?? "pending";
  return status === "pending" || status === "processing";
}

/** Pending or processing for longer than the staleness window: counts as failed. */
export function isStale(att: AttachmentLike, now: Date = new Date()): boolean {
  if (!isUnsettled(att)) return false;
  const since = statusTime(att);
  return since === null || now.getTime() - since.getTime() > ATTACHMENT_STALE_MS;
}

/** Pending or processing within the staleness window. */
export function isInFlight(att: AttachmentLike, now: Date = new Date()): boolean {
  return isUnsettled(att) && !isStale(att, now);
}

export function attachmentsOf(topic: TopicAttachments): AttachmentLike[] {
  return [...(topic.files ?? []), ...(topic.urls ?? [])];
}

export interface AttachmentSummary {
  total: number;
  completed: number;
  /** Pending or processing within the staleness window. */
  inFlight: number;
  /** Failed, or stale. */
  failed: number;
}

export function summarizeAttachments(topic: TopicAttachments, now: Date = new Date()): AttachmentSummary {
  const summary: AttachmentSummary = { total: 0, completed: 0, inFlight: 0, failed: 0 };
  for (const att of attachmentsOf(topic)) {
    summary.total += 1;
    if (att.processingStatus === "completed") summary.completed += 1;
    else if (isInFlight(att, now)) summary.inFlight += 1;
    else summary.failed += 1;
  }
  return summary;
}

/** Every attachment is completed, failed, or stale. True for a topic with none. */
export function allSettled(topic: TopicAttachments, now: Date = new Date()): boolean {
  return summarizeAttachments(topic, now).inFlight === 0;
}

export interface MaterialSource {
  /** Storage key of the extracted markdown. */
  path: string;
  /** File name or URL, for section headings and logs. */
  label: string;
}

/** Recorded extracted paths of every completed attachment, files first. */
export function completedMaterialSources(topic: TopicAttachments): MaterialSource[] {
  const sources: MaterialSource[] = [];
  for (const file of topic.files ?? []) {
    if (file.processingStatus === "completed" && file.extractedContentUrl) sources.push({ path: file.extractedContentUrl, label: file.fileName ?? file.extractedContentUrl });
  }
  for (const url of topic.urls ?? []) {
    if (url.processingStatus === "completed" && url.extractedContentPath) sources.push({ path: url.extractedContentPath, label: url.url ?? url.extractedContentPath });
  }
  return sources;
}

export function hasCompletedMaterial(topic: TopicAttachments): boolean {
  return completedMaterialSources(topic).length > 0;
}
