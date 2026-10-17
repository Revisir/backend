import { z } from "zod";

const mongoIdRegex = /^[0-9a-fA-F]{24}$/;
const fileInfoSchema = z.object({
  fileName: z.string().min(1),
  size: z.number().positive(),
  contentType: z.string().min(1),
});
export const createTopicSchema = z.object({
  topicName: z.string().trim().min(1, "Topic name is required").max(200, "Topic name must not exceed 200 characters"),
  subjectName: z.string().trim().min(1, "Subject name is required").max(100, "Subject name must not exceed 100 characters"),
  description: z.string().trim().max(1000, "Description must not exceed 1000 characters").optional(),
  urls: z.array(z.url("Each URL must be a valid URL")).min(1, "URLs list cannot be empty").max(20, "Maximum 20 URLs allowed per request").optional(),
  files: z.array(fileInfoSchema).optional(),
  dateStudied: z
    .string()
    .refine((val) => !isNaN(Date.parse(val)), "Invalid date format for dateStudied")
    .refine((val) => new Date(val) <= new Date(), "Date studied cannot be in the future"),
});

export const getTopicsQuerySchema = z.object({
  page: z.preprocess((val) => (typeof val === "string" ? parseInt(val, 10) : val), z.number().min(1, "Page must be a positive integer").default(1)),
  limit: z.preprocess((val) => (typeof val === "string" ? parseInt(val, 10) : val), z.number().min(1, "Limit must be at least 1").max(100, "Limit must be between 1 and 100").default(10)),
  subject: z.string().trim().optional(),
});

export const topicIdParamSchema = z.object({
  id: z.string().regex(mongoIdRegex, "Invalid topic ID format"),
});

export const topicFileParamSchema = z.object({
  id: z.string().regex(mongoIdRegex, "Invalid topic ID format"),
  fileId: z.string().regex(mongoIdRegex, "Invalid file ID format"),
});

/**
 * PATCH /api/topics/:id. `dateStudied` takes the edit form's date-only value
 * (`YYYY-MM-DD`) or a full ISO date-time.
 */
export const updateTopicSchema = z.object({
  topicName: z.string().max(200).optional(),
  subjectName: z.string().max(100).optional(),
  description: z.string().optional(),
  urls: z.array(z.string().url()).optional(),
  dateStudied: z
    .union([z.iso.date(), z.iso.datetime({ offset: true })], { error: "dateStudied must be a date (YYYY-MM-DD) or an ISO date-time" })
    .optional(),
});

/** Done on the topic page: the learner's own 0–5 rating. */
export const markRevisedSchema = z.object({
  userQuality: z.number("userQuality must be a number between 0 and 5").min(0, "userQuality must be between 0 and 5").max(5, "userQuality must be between 0 and 5"),
});

export type CreateTopicInput = z.infer<typeof createTopicSchema>;
export type GetTopicsQuery = z.infer<typeof getTopicsQuerySchema>;
export type TopicIdParam = z.infer<typeof topicIdParamSchema>;
export type MarkRevisedInput = z.infer<typeof markRevisedSchema>;
export type UpdateTopicInput = z.infer<typeof updateTopicSchema>;
