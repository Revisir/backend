import { z } from "zod";

export const urlProcessingMessageSchema = z.object({
  topicId: z.string().min(1),
  userId: z.string().min(1),
  urls: z.array(z.string().url().startsWith("http")).min(1).max(50),
});

/**
 * A single uploaded object to extract, as published by the storage webhook.
 *
 * Deliberately not the AWS S3 event envelope: the SeaweedFS filer notification
 * carries a filer path rather than an S3 event, so
 * `storageWebhookController` normalises it to this shape before publishing.
 */
export const fileProcessingMessageSchema = z.object({
  bucket: z.string().min(1),
  key: z.string().min(1),
});

export type UrlProcessingMessage = z.infer<typeof urlProcessingMessageSchema>;
export type FileProcessingMessage = z.infer<typeof fileProcessingMessageSchema>;
