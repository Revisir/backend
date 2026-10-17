import { getLLMClient } from "@services/llmClient.js";
import { PROMPTS } from "@config/prompts.js";
import { IQuestion } from "@models/ChatSession.js";

export interface EvaluationResult {
  correct: boolean;
  explanation: string;
}

/**
 * Agent 1: Extracts questions from study materials
 */
async function extractQuestions(studyMaterials: string): Promise<IQuestion[]> {
  const llmClient = getLLMClient();
  const response = await llmClient.sendTextPrompt(PROMPTS.chat.questionExtractor(studyMaterials));
  return parseJsonArray(response);
}

/**
 * Agent 2: Reviews questions to ensure answers exist in the material
 */
async function reviewQuestions(questions: IQuestion[], studyMaterials: string): Promise<IQuestion[]> {
  const llmClient = getLLMClient();
  const response = await llmClient.sendTextPrompt(
    PROMPTS.chat.questionReviewer(JSON.stringify(questions), studyMaterials)
  );
  return parseJsonArray(response);
}

/**
 * Runs the full question generation pipeline: extract → review
 */
export async function generateQuestions(studyMaterials: string): Promise<IQuestion[]> {
  const extracted = await extractQuestions(studyMaterials);
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

function parseJsonArray(response: string): IQuestion[] {
  const cleaned = response.replace(/```json\s*/g, "").replace(/```/g, "").trim();
  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) throw new Error("Expected JSON array from LLM");
  return parsed;
}
