import { ITopic } from "@models/Topic.js";
import { getExtractedContent } from "./s3Storage.js";
import { getLLMClient } from "./llmClient.js";
import { PROMPTS } from "@config/prompts.js";

/**
 * Chat Context Builder
 * Builds context for LLM-based revision sessions
 */

export interface ChatContextResult {
  studyMaterials: string | Error;
}

/**
 * Retrieves and combines extracted content from S3 for a topic.
 *
 * @param topic - The topic document containing all topic information
 * @returns Combined study materials text
 * @throws Error if S3 content retrieval fails
 */
export async function buildChatContext(topic: ITopic): Promise<ChatContextResult> {
  const extractedContents: string[] = [];

  for (const file of topic.files) {
    if (file?.extractedContentUrl) {
      try {
        const content = await getExtractedContent(topic.userId, file.extractedContentUrl);
        extractedContents.push(`\n### ${file.fileName}\n${content}`);
      } catch (error) {
        console.error(`Failed to retrieve content for file ${file.fileName}:`, error);
        extractedContents.push(`\n### ${file.fileName}\n[Content unavailable]`);
      }
    }
  }

  const studyMaterials = extractedContents.length > 0 ? extractedContents.join("\n") : new Error("Atleast one Study Material Needed");

  return { studyMaterials };
}

/**
 * Builds an assessment prompt for the LLM to evaluate student performance.
 *
 * @param messages - Array of conversation messages from the chat session
 * @returns Assessment prompt for the LLM
 */
export function buildAssessmentPrompt(messages: { role: string; content: string }[]): string {
  const conversationHistory = messages.map((msg) => `${msg.role === "user" ? "Student" : "Tutor"}: ${msg.content}`).join("\n\n");
  return PROMPTS.chat.assessment(conversationHistory);
}

/**
 * Assesses student performance by sending conversation history to LLM.
 *
 * @param messages - Array of conversation messages from the chat session
 * @returns Quality score from 0-5
 */
export async function assessStudentPerformance(messages: { role: string; content: string }[]): Promise<number> {
  const assessmentPrompt = buildAssessmentPrompt(messages);
  const llmClient = getLLMClient();
  const response = await llmClient.sendTextPrompt(assessmentPrompt);
  return parseQualityRating(response);
}

function parseQualityRating(response: string): number {
  const cleanResponse = response.trim().toLowerCase();

  const patterns = [/^([0-5])$/, /rating[:\s]+([0-5])/, /score[:\s]+([0-5])/, /^([0-5])[^0-9]/, /[^0-9]([0-5])$/, /\b([0-5])\b/];

  for (const pattern of patterns) {
    const match = cleanResponse.match(pattern);
    if (match && match[1]) {
      const rating = parseInt(match[1], 10);
      if (rating >= 0 && rating <= 5) return rating;
    }
  }

  throw new Error(`Failed to parse quality rating from LLM response: "${response}". Expected a number between 0-5.`);
}
