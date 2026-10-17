import { getLLMClient } from "@services/llmClient.js";
import { PROMPTS } from "@config/prompts.js";
import { QUESTION_BANK } from "@config/questionBank.js";
import { IQuestion } from "@models/ChatSession.js";

export interface EvaluationResult {
  correct: boolean;
  explanation: string;
}

/**
 * Agent 1: Extracts up to `count` question-answer pairs from study materials.
 * One LLM call; throws if the reply is not a JSON array.
 */
export async function extractQuestions(studyMaterials: string, count: number): Promise<IQuestion[]> {
  const llmClient = getLLMClient();
  const response = await llmClient.sendTextPrompt(PROMPTS.chat.questionExtractor(studyMaterials, count));
  return parseJsonArray(response);
}

/**
 * Agent 2: Reviews questions to ensure answers exist in the material.
 * One LLM call; throws if the reply is not a JSON array.
 */
export async function reviewQuestions(questions: IQuestion[], studyMaterials: string): Promise<IQuestion[]> {
  const llmClient = getLLMClient();
  const response = await llmClient.sendTextPrompt(
    PROMPTS.chat.questionReviewer(JSON.stringify(questions), studyMaterials)
  );
  return parseJsonArray(response);
}

/**
 * Runs the full question generation pipeline: extract → review.
 * The AI chat uses the default count; it throws when either step yields nothing.
 */
export async function generateQuestions(
  studyMaterials: string,
  count: number = QUESTION_BANK.CHAT_EXTRACTION_COUNT
): Promise<IQuestion[]> {
  const extracted = await extractQuestions(studyMaterials, count);
  if (extracted.length === 0) throw new Error("Failed to extract questions from study materials");

  const reviewed = await reviewQuestions(extracted, studyMaterials);
  if (reviewed.length === 0) throw new Error("No questions passed review");

  return reviewed;
}

/**
 * Agent 3: Evaluates a student's answer against the expected answer
 */
export async function evaluateAnswer(
  question: string,
  expectedAnswer: string,
  studentAnswer: string
): Promise<EvaluationResult> {
  const llmClient = getLLMClient();
  const response = await llmClient.sendTextPrompt(
    PROMPTS.chat.answerEvaluator(question, expectedAnswer, studentAnswer)
  );

  const cleaned = response.replace(/```json\s*/g, "").replace(/```/g, "").trim();
  const parsed = JSON.parse(cleaned);

  return {
    correct: Boolean(parsed.correct),
    explanation: parsed.explanation || "",
  };
}

/** Parses an LLM reply holding a JSON array, optionally inside ```json fences. Throws otherwise. */
export function parseJsonArray<T = IQuestion>(response: string): T[] {
  const cleaned = response.replace(/```json\s*/g, "").replace(/```/g, "").trim();
  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) throw new Error("Expected JSON array from LLM");
  return parsed;
}
