import { ITopic } from "@models/Topic.js";
import { getAllExtractedContent } from "./s3Storage.js";
import { getLLMClient } from "./llmClient.js";
import { PROMPTS } from "@config/prompts.js";
import { logger } from "@config/logger.js";

const log = logger.child({ module: "mindMapGenerator" });

/**
 * Mind Map Generator
 * Generates MindElixir mind map data for topics using LLM
 */

/**
 * Builds a prompt for generating a MindElixir mind map from topic data.
 * Retrieves all extracted content from the topic's extracted/ folder in S3.
 *
 * @param topic - The topic document containing all topic information
 * @returns Formatted prompt for mind map generation
 */
export async function buildMindMapPrompt(topic: ITopic): Promise<string> {
  const studyMaterials = await getAllExtractedContent(topic.userId, topic._id.toString());
  const materials = studyMaterials || "[No study materials attached]";
  return PROMPTS.mindMap.generate(materials);
}

/**
 * Generates a MindElixir mind map for a topic using LLM.
 * Retrieves topic content from S3, sends to LLM, and validates the result.
 *
 * @param topic - The topic document to generate a mind map for
 * @returns MindElixir node data as a JSON string
 * @throws Error if LLM fails or returns invalid JSON
 */
export async function generateMindMap(topic: ITopic): Promise<string> {
  const prompt = await buildMindMapPrompt(topic);
  log.debug({ topicId: topic._id }, "MindMap prompt built");

  const llmClient = getLLMClient();
  const response = await llmClient.sendTextPrompt(prompt);

  try {
    JSON.parse(response);
    return response;
  } catch (error) {
    throw new Error("Invlaid Elixir mind map");
  }
}
