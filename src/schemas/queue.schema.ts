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

export const QUESTION_BANK_BUILD_REASONS = ["materials_settled", "material_removed", "regenerate", "backfill", "sweep", "follow_up"] as const;

/**
 * A request to (re)build one topic's question bank. `requestedAt` is compared
 * with the bank's last successful build so duplicate requests cost nothing.
 */
export const questionBankMessageSchema = z.object({
  topicId: z.string().min(1),
  userId: z.string().min(1),
  requestedAt: z.iso.datetime(),
  reason: z.enum(QUESTION_BANK_BUILD_REASONS),
});

export type UrlProcessingMessage = z.infer<typeof urlProcessingMessageSchema>;
export type FileProcessingMessage = z.infer<typeof fileProcessingMessageSchema>;
export type QuestionBankMessage = z.infer<typeof questionBankMessageSchema>;
export type QuestionBankBuildReason = (typeof QUESTION_BANK_BUILD_REASONS)[number];
