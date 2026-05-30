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
  urls: z.array(z.url("Each URL must be a valid URL")).optional(),
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

export type CreateTopicInput = z.infer<typeof createTopicSchema>;
export type GetTopicsQuery = z.infer<typeof getTopicsQuerySchema>;
export type TopicIdParam = z.infer<typeof topicIdParamSchema>;
