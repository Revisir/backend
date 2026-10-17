import { randomUUID } from "node:crypto";
import { isValidObjectId } from "mongoose";
import { logger } from "@config/logger.js";
import { PROMPTS } from "@config/prompts.js";
import { QUESTION_BANK, QUIZ } from "@config/questionBank.js";
import { Topic, truncateErrorReason, type IBankQuestion, type IRetiredQuestion } from "@models/Topic.js";
import type { IQuestion } from "@models/ChatSession.js";
import { completedMaterialSources, type MaterialSource } from "@services/attachments.js";
import { getExtractedContent } from "@services/s3Storage.js";
import { getLLMClient } from "@services/llmClient.js";
import { extractQuestions, reviewQuestions, parseJsonArray } from "@services/questionAgent.js";
import { normalizeText, BLANK_MARKER } from "@services/questionText.js";

/**
 * Builds a topic's question bank for the normal quiz (R14–R16, R19, R38).
 *
 * One pipeline, shared with the AI chat (KTD5): extract question-answer pairs,
 * keep the ones the reviewer finds answered in the material, then format the
 * survivors into multiple-choice and fill-in-the-blank items. Every item is
 * checked structurally before it is saved, and retired questions never return
 * (KTD6). The save is conditional on the caller's claim, so a superseded build
 * writes nothing.
 */

const log = logger.child({ module: "questionBank" });

export interface BuildResult {
  state: "ready" | "empty" | "failed";
  questionCount: number;
  /** False when the claim was superseded and nothing was written. */
  saved: boolean;
}

type BuildErrorCode = "LLM_ERROR" | "STORAGE_ERROR";

type Outcome =
  | { state: "ready"; questions: IBankQuestion[] }
  | { state: "empty" }
  | { state: "failed"; errorCode: BuildErrorCode; errorReason: string };

/** Rounds of re-reading the retired list when a retirement lands between the re-read and the save. */
const SAVE_ROUNDS = 5;

let retryBaseMs: number = QUESTION_BANK.LLM_RETRY_BASE_MS;

/** Overrides the first LLM retry delay (it doubles per attempt). Call with no argument to restore the default. */
export function setRetryDelayForTests(ms?: number): void {
  retryBaseMs = ms ?? QUESTION_BANK.LLM_RETRY_BASE_MS;
}

/**
 * Builds and saves the bank for the topic claimed at `claimedAt`.
 *
 * LLM and storage failures are saved as `failed` and never throw; only
 * database errors do, so the caller can requeue.
 */
export async function buildQuestionBank(p: { topicId: string; userId: string; claimedAt: Date }): Promise<BuildResult> {
  const { topicId, userId, claimedAt } = p;
  if (!isValidObjectId(topicId)) {
    log.warn({ topicId }, "Question bank build skipped: invalid topic id");
    return { state: "failed", questionCount: 0, saved: false };
  }

  const topic = await Topic.findOne({ _id: topicId, userId }).select("+retiredQuestions").lean();
  if (!topic) {
    log.warn({ topicId }, "Question bank build skipped: topic not found");
    return { state: "failed", questionCount: 0, saved: false };
  }

  const outcome = await produce(topicId, userId, completedMaterialSources(topic), topic.retiredQuestions ?? []);
  const result = await save(topicId, userId, claimedAt, outcome);

  if (result.saved) log.info({ topicId, state: result.state, questionCount: result.questionCount }, "Question bank build saved");
  else log.warn({ topicId, state: result.state }, "Question bank build discarded: claim superseded");
  return result;
}

/** Reads the material and runs the pipeline. Never throws for LLM or storage failures. */
async function produce(topicId: string, userId: string, sources: MaterialSource[], retired: readonly IRetiredQuestion[]): Promise<Outcome> {
  if (sources.length === 0) {
    log.info({ topicId }, "Question bank empty: no completed attachments");
    return { state: "empty" };
  }

  const material = await readMaterial(topicId, userId, sources);
  if ("error" in material) return { state: "failed", errorCode: "STORAGE_ERROR", errorReason: material.error };
  if (!material.text) {
    log.info({ topicId }, "Question bank empty: completed attachments hold no text");
    return { state: "empty" };
  }

  try {
    return await runPipeline(topicId, material.text, retired);
  } catch (err) {
    if (!(err instanceof LlmStepError)) throw err;
    log.error({ err, topicId }, "Question bank LLM step failed after retries");
    return { state: "failed", errorCode: "LLM_ERROR", errorReason: err.message };
  }
}

/**
 * Reads each completed attachment's recorded extracted path, one object at a
 * time. The extracted folder is never listed: orphaned objects there are not
 * the topic's material.
 */
async function readMaterial(topicId: string, userId: string, sources: MaterialSource[]): Promise<{ text: string } | { error: string }> {
  const reads = await Promise.allSettled(sources.map((source) => getExtractedContent(userId, source.path)));

  const sections: string[] = [];
  let lastError: unknown = null;
  reads.forEach((read, i) => {
    const source = sources[i];
    if (read.status === "rejected") {
      lastError = read.reason;
      log.warn({ err: read.reason, topicId, path: source.path }, "Skipping material source that could not be read");
      return;
    }
    const content = read.value.trim();
    if (content) sections.push(`# Source: ${source.label}\n\n${content}`);
  });

  if (sections.length === 0 && lastError !== null) {
    return { error: truncateErrorReason(`Could not read the material of ${sources.length} attachment(s): ${messageOf(lastError)}`) };
  }

  const text = sections.join("\n\n");
  if (text.length <= QUESTION_BANK.MATERIAL_CHAR_CAP) return { text };
  log.warn({ topicId, originalLength: text.length, cap: QUESTION_BANK.MATERIAL_CHAR_CAP }, "Question bank material truncated to the character cap");
  return { text: text.slice(0, QUESTION_BANK.MATERIAL_CHAR_CAP) };
}

/** Extract → review (the AI chat's steps) → format (bank only) → validate. */
async function runPipeline(topicId: string, material: string, retired: readonly IRetiredQuestion[]): Promise<Outcome> {
  const extracted = wellFormedPairs(await withRetry("extract", topicId, () => extractQuestions(material, QUESTION_BANK.EXTRACTION_COUNT)));
  if (extracted.length === 0) {
    log.info({ topicId }, "Question bank empty: extraction found no questions");
    return { state: "empty" };
  }

  const reviewed = wellFormedPairs(await withRetry("review", topicId, () => reviewQuestions(extracted, material)));
  if (reviewed.length === 0) {
    log.info({ topicId, extracted: extracted.length }, "Question bank empty: no question passed review");
    return { state: "empty" };
  }

  const formatted = await withRetry("format", topicId, () => formatItems(reviewed, material, retired));
  const questions = validateFormattedItems(formatted, retiredKeysOf(retired));
  log.info({ topicId, extracted: extracted.length, reviewed: reviewed.length, formatted: formatted.length, valid: questions.length }, "Question bank pipeline finished");
  return questions.length > 0 ? { state: "ready", questions } : { state: "empty" };
}

/** Bank-only step: one LLM call that writes quiz items from the reviewed pairs, avoiding retired questions. */
async function formatItems(pairs: IQuestion[], material: string, retired: readonly IRetiredQuestion[]): Promise<unknown[]> {
  const excluded = JSON.stringify(retired.map((r) => r.text));
  const response = await getLLMClient().sendTextPrompt(PROMPTS.questionBank.formatter(JSON.stringify(pairs), material, excluded));
  return parseJsonArray<unknown>(response);
}

/** Pairs with a non-empty question and answer, reduced to those two fields. */
function wellFormedPairs(pairs: unknown[]): IQuestion[] {
  const out: IQuestion[] = [];
  for (const pair of pairs) {
    if (!isRecord(pair)) continue;
    const question = cleanText(pair.question);
    const answer = cleanText(pair.answer);
    if (question && answer) out.push({ question, answer });
  }
  return out;
}

class LlmStepError extends Error {
  constructor(step: string, cause: unknown) {
    super(truncateErrorReason(`LLM ${step} step failed after ${QUESTION_BANK.LLM_ATTEMPTS} attempts: ${messageOf(cause)}`));
    this.name = "LlmStepError";
  }
}

/** Runs one LLM step (call and parse) up to `LLM_ATTEMPTS` times with exponential backoff. */
async function withRetry<T>(step: string, topicId: string, run: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= QUESTION_BANK.LLM_ATTEMPTS; attempt++) {
    try {
      return await run();
    } catch (err) {
      lastError = err;
      log.warn({ err, topicId, step, attempt, maxAttempts: QUESTION_BANK.LLM_ATTEMPTS }, "Question bank LLM step attempt failed");
      if (attempt < QUESTION_BANK.LLM_ATTEMPTS) await sleep(retryBaseMs * 2 ** (attempt - 1));
    }
  }
  throw new LlmStepError(step, lastError);
}

// ---------------------------------------------------------------- save

function claimFilter(topicId: string, userId: string, claimedAt: Date) {
  return { _id: topicId, userId, "questionBank.state": "building" as const, "questionBank.claimedAt": claimedAt };
}

const CLEARED_CLAIM = { "questionBank.claimedAt": null, "questionBank.claimRequestedAt": null };

/**
 * Saves the outcome only while the caller's claim still holds. A ready bank is
 * re-checked against the retired list just before the write, and the write
 * itself refuses if any of its questions has been retired since.
 */
async function save(topicId: string, userId: string, claimedAt: Date, outcome: Outcome): Promise<BuildResult> {
  const filter = claimFilter(topicId, userId, claimedAt);

  if (outcome.state === "failed") {
    const { matchedCount } = await Topic.updateOne(filter, {
      $set: { "questionBank.state": "failed", "questionBank.errorCode": outcome.errorCode, "questionBank.errorReason": truncateErrorReason(outcome.errorReason), ...CLEARED_CLAIM },
    });
    return { state: "failed", questionCount: 0, saved: matchedCount === 1 };
  }

  let questions = outcome.state === "ready" ? outcome.questions : [];
  for (let round = 0; round < SAVE_ROUNDS && questions.length > 0; round++) {
    const current = await Topic.findOne(filter).select("retiredQuestions").lean();
    if (!current) return { state: "ready", questionCount: questions.length, saved: false };

    const retiredNow = retiredKeysOf(current.retiredQuestions ?? []);
    questions = questions.filter((q) => !retiredNow.has(q.key));
    if (questions.length === 0) break;

    const { matchedCount } = await Topic.updateOne(
      { ...filter, "retiredQuestions.key": { $nin: questions.map((q) => q.key) } },
      {
        $set: {
          "questionBank.questions": questions,
          "questionBank.usableCount": questions.length,
          "questionBank.state": "ready",
          "questionBank.builtAt": new Date(),
          "questionBank.sourcedAt": claimedAt,
          "questionBank.attempts": 0,
          "questionBank.errorCode": null,
          "questionBank.errorReason": null,
          ...CLEARED_CLAIM,
        },
      },
    );
    if (matchedCount === 1) return { state: "ready", questionCount: questions.length, saved: true };
    // Claim lost, or a question was retired after the re-read: the next round tells which.
  }
  if (questions.length > 0) throw new Error(`Question bank save for topic ${topicId} kept racing retirements`);

  // Empty: previous questions and usableCount stay usable (R38).
  const { matchedCount } = await Topic.updateOne(filter, {
    $set: { "questionBank.state": "empty", "questionBank.sourcedAt": claimedAt, "questionBank.attempts": 0, "questionBank.errorCode": null, "questionBank.errorReason": null, ...CLEARED_CLAIM },
  });
  return { state: "empty", questionCount: 0, saved: matchedCount === 1 };
}

// ---------------------------------------------------------------- validation

type FormattedItem = Omit<IBankQuestion, "id" | "key">;

/** A run of three or more underscores is a blank; it is stored as `BLANK_MARKER`. */
const BLANK_RUN = /_{3,}/g;

/**
 * Keeps the formatter's items that are structurally sound, assigning each an
 * id and its retirement key. Pure apart from the random ids.
 *
 * - `mcq`: a prompt, exactly `QUIZ.MCQ_OPTIONS` non-empty options that differ
 *   after normalization, and an answer matching one option (stored as that
 *   option's text).
 * - `fill_blank`: a prompt with exactly one blank, a non-empty answer, and
 *   optional alternatives (de-duplicated, never the answer itself).
 *
 * Anything else is dropped, as are retired keys, repeated keys, and items past
 * `MAX_BANK_SIZE`.
 */
export function validateFormattedItems(raw: unknown[], retiredKeys: ReadonlySet<string>): IBankQuestion[] {
  const kept: IBankQuestion[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (kept.length >= QUESTION_BANK.MAX_BANK_SIZE) break;
    const parsed = parseItem(item);
    if (!parsed) continue;
    const key = normalizeText(parsed.prompt);
    if (retiredKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    kept.push({ id: randomUUID(), key, ...parsed });
  }
  return kept;
}

function parseItem(item: unknown): FormattedItem | null {
  if (!isRecord(item)) return null;
  if (item.type === "mcq") return parseMultipleChoice(item);
  if (item.type === "fill_blank") return parseFillBlank(item);
  return null;
}

function parseMultipleChoice(item: Record<string, unknown>): FormattedItem | null {
  const prompt = cleanText(item.prompt);
  const answer = cleanText(item.answer);
  if (!prompt || !answer || !Array.isArray(item.options) || item.options.length !== QUIZ.MCQ_OPTIONS) return null;

  const options: string[] = [];
  for (const option of item.options) {
    const text = cleanText(option);
    if (!text) return null;
    options.push(text);
  }
  const normalized = options.map(normalizeText);
  if (new Set(normalized).size !== options.length) return null;

  const answerIndex = normalized.indexOf(normalizeText(answer));
  if (answerIndex === -1) return null;
  return { type: "mcq", prompt, options, answer: options[answerIndex] };
}

function parseFillBlank(item: Record<string, unknown>): FormattedItem | null {
  const text = cleanText(item.prompt);
  const answer = cleanText(item.answer);
  if (!text || !answer) return null;
  if ((text.match(BLANK_RUN) ?? []).length !== 1) return null;

  const prompt = text.replace(BLANK_RUN, BLANK_MARKER);
  if (!normalizeText(prompt.replace(BLANK_MARKER, ""))) return null;

  const alternatives = parseAlternatives(item.alternatives, answer);
  return alternatives.length > 0 ? { type: "fill_blank", prompt, answer, alternatives } : { type: "fill_blank", prompt, answer };
}

function parseAlternatives(value: unknown, answer: string): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set([normalizeText(answer)]);
  const out: string[] = [];
  for (const entry of value) {
    const text = cleanText(entry);
    if (!text || seen.has(normalizeText(text))) continue;
    seen.add(normalizeText(text));
    out.push(text);
  }
  return out;
}

// ---------------------------------------------------------------- helpers

/** Retirement keys, plus each retired text's normalized form in case a key was written differently. */
function retiredKeysOf(retired: readonly IRetiredQuestion[]): Set<string> {
  const keys = new Set<string>();
  for (const r of retired) {
    if (r.key) keys.add(r.key);
    if (r.text) keys.add(normalizeText(r.text));
  }
  return keys;
}

/** The trimmed string when `value` is a string with content after normalization; otherwise null. */
function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return normalizeText(trimmed) ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
