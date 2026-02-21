import { z } from "zod";

const mongoIdRegex = /^[0-9a-fA-F]{24}$/;

export const startChatSessionSchema = z.object({
  topicId: z.string().regex(mongoIdRegex, "Invalid topic ID format"),
});

export const sendChatMessageSchema = z.object({
  sessionId: z.string().regex(mongoIdRegex, "Invalid session ID format"),
  message: z.string().trim().min(1, "Message must be a non-empty string"),
});

export const completeChatSessionSchema = z.object({
  sessionId: z.string().regex(mongoIdRegex, "Invalid session ID format"),
  topicId: z.string().regex(mongoIdRegex, "Invalid topic ID format"),
  userQuality: z.number().min(0, "User quality must be between 0 and 5").max(5, "User quality must be between 0 and 5"),
  llmQuality: z.number().min(0, "LLM quality must be between 0 and 5").max(5, "LLM quality must be between 0 and 5"),
});

export type StartChatSessionInput = z.infer<typeof startChatSessionSchema>;
export type SendChatMessageInput = z.infer<typeof sendChatMessageSchema>;
export type CompleteChatSessionInput = z.infer<typeof completeChatSessionSchema>;
