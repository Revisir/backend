/**
 * U3: question-bank generation (extract, check, then format) and its
 * claim-conditional save. Runs against a real in-memory MongoDB with the LLM,
 * object storage and logger mocked.
 */
import { Types } from "mongoose";

jest.mock("@services/llmClient", () => {
  const sendTextPrompt = jest.fn();
  return { getLLMClient: () => ({ sendTextPrompt }) };
});
jest.mock("@services/s3Storage", () => ({ getExtractedContent: jest.fn() }));
jest.mock("@config/logger", () => {
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn(), fatal: jest.fn() };
  return { logger: { ...log, child: () => log } };
});

import { useMongoMemoryServer } from "../test/mongo";
import { Topic, type IBankQuestion } from "@models/Topic";
import { getLLMClient } from "@services/llmClient";
import { getExtractedContent } from "@services/s3Storage";
import { logger } from "@config/logger";
import { QUESTION_BANK, QUIZ } from "@config/questionBank";
import { normalizeText, BLANK_MARKER } from "@services/questionText";
import { generateQuestions } from "@services/questionAgent";
import { buildQuestionBank, validateFormattedItems, setRetryDelayForTests } from "@services/questionBank";

useMongoMemoryServer();

const sendTextPrompt = getLLMClient().sendTextPrompt as unknown as jest.Mock<Promise<string>, [string]>;
const readContent = getExtractedContent as jest.MockedFunction<typeof getExtractedContent>;
const bankLog = logger.child({ module: "test" }) as unknown as Record<"info" | "warn" | "error", jest.Mock>;

const USER = "user-1";
const CLAIM = new Date("2026-10-17T10:00:00.000Z");
const EARLIER = new Date("2026-10-01T08:00:00.000Z");

// ---------------------------------------------------------------- fixtures

const pairs = (n: number) => Array.from({ length: n }, (_, i) => ({ question: `What is fact number ${i + 1}?`, answer: `Fact ${i + 1}` }));

const mcqItem = (i: number, over: Record<string, unknown> = {}) => ({
  type: "mcq",
  prompt: `Which pigment absorbs band ${i}?`,
  options: [`Pigment ${i}A`, `Pigment ${i}B`, `Pigment ${i}C`, `Pigment ${i}D`],
  answer: `Pigment ${i}B`,
  ...over,
});

const blankItem = (i: number, over: Record<string, unknown> = {}) => ({
  type: "fill_blank",
  prompt: `Stage ${i} of the cycle is called the ____.`,
  answer: `stage ${i} phase`,
  alternatives: [`S${i}P`],
  ...over,
});

const storedQuestion = (i: number): IBankQuestion => ({
  id: `old-${i}`,
  key: `old question ${i}`,
  type: "fill_blank",
  prompt: `Old question ${i} is ${BLANK_MARKER}.`,
  answer: `old ${i}`,
});

function sourcesFor(id: Types.ObjectId) {
  return {
    files: [
      { fileName: "notes.pdf", fileType: "pdf", s3Path: `${USER}/${id}/files/notes.pdf`, s3Bucket: "bucket", processingStatus: "completed", extractedContentUrl: `${USER}/${id}/extracted/notes.md` },
    ],
    urls: [{ url: "https://example.com/light", processingStatus: "completed", extractedContentPath: `${USER}/${id}/extracted/light.md` }],
  };
}

async function createTopic(overrides: Record<string, unknown> = {}) {
  const _id = new Types.ObjectId();
  return Topic.create({
    _id,
    userId: USER,
    topicName: "Photosynthesis",
    subjectName: "Biology",
    dateStudied: new Date("2026-10-01T00:00:00.000Z"),
    revisionDate: new Date("2026-10-02T00:00:00.000Z"),
    ...sourcesFor(_id),
    questionBank: { state: "building", requestedAt: CLAIM, claimedAt: CLAIM, claimRequestedAt: CLAIM, attempts: 2 },
    ...overrides,
  });
}

async function loadBank(id: Types.ObjectId) {
  const topic = await Topic.findById(id).select("+questionBank.questions +retiredQuestions").lean();
  return topic!;
}

/** Scripts the LLM's next replies in order; objects are sent as JSON, Errors reject. */
function llmReplies(...replies: unknown[]) {
  for (const reply of replies) {
    if (reply instanceof Error) sendTextPrompt.mockRejectedValueOnce(reply);
    else sendTextPrompt.mockResolvedValueOnce(typeof reply === "string" ? reply : JSON.stringify(reply));
  }
}

const promptsSent = () => sendTextPrompt.mock.calls.map(([prompt]) => prompt);

const build = (topicId: Types.ObjectId, userId = USER, claimedAt = CLAIM) => buildQuestionBank({ topicId: topicId.toString(), userId, claimedAt });

beforeAll(() => setRetryDelayForTests(0));
afterAll(() => setRetryDelayForTests());

beforeEach(() => {
  sendTextPrompt.mockReset();
  sendTextPrompt.mockRejectedValue(new Error("unexpected LLM call"));
  readContent.mockReset();
  readContent.mockImplementation(async (_userId, path) => `Content stored at ${path}.`);
  bankLog.info.mockClear();
  bankLog.warn.mockClear();
  bankLog.error.mockClear();
});

// ---------------------------------------------------------------- validateFormattedItems

describe("validateFormattedItems", () => {
  const none = new Set<string>();

  it("keeps a valid multiple-choice item with a canonical answer, an id and a normalized key", () => {
    const [q] = validateFormattedItems([mcqItem(1, { prompt: "  Which pigment absorbs band 1?  ", answer: "pigment 1b." })], none);

    expect(q).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      key: "which pigment absorbs band 1",
      type: "mcq",
      prompt: "Which pigment absorbs band 1?",
      options: ["Pigment 1A", "Pigment 1B", "Pigment 1C", "Pigment 1D"],
      answer: "Pigment 1B",
    });
  });

  it("drops a multiple-choice item whose answer is not among its options", () => {
    expect(validateFormattedItems([mcqItem(1, { answer: "Chlorophyll" })], none)).toEqual([]);
  });

  it("drops a multiple-choice item with duplicate options, including after normalization", () => {
    expect(validateFormattedItems([mcqItem(1, { options: ["Pigment 1A", "Pigment 1B", "Pigment 1A", "Pigment 1D"] })], none)).toEqual([]);
    expect(validateFormattedItems([mcqItem(1, { options: ["Pigment 1A", "Pigment 1B", "pigment  1b.", "Pigment 1D"] })], none)).toEqual([]);
  });

  it.each([
    ["three options", { options: ["Pigment 1A", "Pigment 1B", "Pigment 1C"] }],
    ["five options", { options: ["Pigment 1A", "Pigment 1B", "Pigment 1C", "Pigment 1D", "Pigment 1E"] }],
    ["an empty option", { options: ["Pigment 1A", "Pigment 1B", "  ", "Pigment 1D"] }],
    ["a non-string option", { options: ["Pigment 1A", "Pigment 1B", 3, "Pigment 1D"] }],
    ["options that are not an array", { options: "Pigment 1A, Pigment 1B" }],
    ["an empty prompt", { prompt: "   " }],
    ["a missing answer", { answer: undefined }],
  ])("drops a multiple-choice item with %s", (_label, over) => {
    expect(validateFormattedItems([mcqItem(1, over)], none)).toEqual([]);
  });

  it(`requires exactly ${QUIZ.MCQ_OPTIONS} options`, () => {
    expect(QUIZ.MCQ_OPTIONS).toBe(4);
    expect(validateFormattedItems([mcqItem(1)], none)).toHaveLength(1);
  });

  it("keeps a valid fill-in-the-blank item and rewrites a longer underscore run to the blank marker", () => {
    const [q] = validateFormattedItems([blankItem(1, { prompt: "Stage 1 of the cycle is called the ________." })], none);

    expect(q).toEqual({
      id: expect.any(String),
      key: "stage 1 of the cycle is called the ____",
      type: "fill_blank",
      prompt: `Stage 1 of the cycle is called the ${BLANK_MARKER}.`,
      answer: "stage 1 phase",
      alternatives: ["S1P"],
    });
  });

  it.each([
    ["no blank", "Stage 1 of the cycle is called the light phase."],
    ["two blanks", "Stage ____ of the cycle is called the ____."],
    ["a two-underscore gap that is not a blank", "Stage 1 of the cycle is called the __."],
    ["only a blank", " ____ "],
  ])("drops a fill-in-the-blank item with %s", (_label, prompt) => {
    expect(validateFormattedItems([blankItem(1, { prompt })], none)).toEqual([]);
  });

  it("drops a fill-in-the-blank item with an empty answer", () => {
    expect(validateFormattedItems([blankItem(1, { answer: " " })], none)).toEqual([]);
  });

  it("de-duplicates alternatives, drops empty ones and the answer itself, and omits an empty list", () => {
    const [withAlts] = validateFormattedItems([blankItem(1, { answer: "ATP", alternatives: ["adenosine triphosphate", "Adenosine Triphosphate.", "atp", "", 7, "  "] })], none);
    const [noAlts] = validateFormattedItems([blankItem(2, { answer: "ATP", alternatives: ["ATP."] })], none);
    const [missing] = validateFormattedItems([blankItem(3, { alternatives: undefined })], none);

    expect(withAlts.alternatives).toEqual(["adenosine triphosphate"]);
    expect(noAlts).not.toHaveProperty("alternatives");
    expect(missing).not.toHaveProperty("alternatives");
  });

  it.each([
    ["an unknown type", { type: "true_false", prompt: "The sky is blue.", answer: "true" }],
    ["no type", { prompt: "Which?", options: ["a", "b", "c", "d"], answer: "a" }],
    ["a string", "Which pigment absorbs red light?"],
    ["null", null],
    ["an array", [mcqItem(1)]],
  ])("drops %s", (_label, item) => {
    expect(validateFormattedItems([item], none)).toEqual([]);
  });

  it("drops an item matching a retired question after normalization", () => {
    const retired = new Set([normalizeText("Which pigment absorbs band 1?"), normalizeText(`Stage 2 of the cycle is called the ${BLANK_MARKER}.`)]);

    const kept = validateFormattedItems([mcqItem(1, { prompt: "WHICH pigment   absorbs band 1 ?!" }), blankItem(2, { prompt: "Stage 2 of the cycle is called the ______" }), mcqItem(3)], retired);

    expect(kept.map((q) => q.prompt)).toEqual(["Which pigment absorbs band 3?"]);
  });

  it("drops a second item with the same key", () => {
    const kept = validateFormattedItems([mcqItem(1), mcqItem(1, { prompt: "which pigment absorbs band 1" }), blankItem(1)], none);

    expect(kept.map((q) => q.type)).toEqual(["mcq", "fill_blank"]);
  });

  it(`keeps at most ${QUESTION_BANK.MAX_BANK_SIZE} questions, in order, with unique ids`, () => {
    const raw = Array.from({ length: QUESTION_BANK.MAX_BANK_SIZE + 5 }, (_, i) => (i % 2 ? mcqItem(i) : blankItem(i)));

    const kept = validateFormattedItems(raw, none);

    expect(kept).toHaveLength(QUESTION_BANK.MAX_BANK_SIZE);
    expect(kept[0].prompt).toContain("Stage 0");
    expect(new Set(kept.map((q) => q.id)).size).toBe(kept.length);
  });
});

// ---------------------------------------------------------------- buildQuestionBank

describe("buildQuestionBank", () => {
  it("builds a ready bank of 15 questions of both types from 20 extracted and 17 reviewed pairs", async () => {
    const topic = await createTopic();
    const extracted = pairs(20);
    const reviewed = extracted.slice(0, 17);
    const formatted = [
      ...Array.from({ length: 8 }, (_, i) => mcqItem(i)),
      ...Array.from({ length: 7 }, (_, i) => blankItem(i)),
      mcqItem(99, { answer: "Not an option" }),
      blankItem(99, { prompt: "No blank in this sentence." }),
    ];
    llmReplies(extracted, reviewed, `\`\`\`json\n${JSON.stringify(formatted)}\n\`\`\``);

    const result = await build(topic._id);

    expect(result).toEqual({ state: "ready", questionCount: 15, saved: true });
    const after = await loadBank(topic._id);
    expect(after.questionBank).toMatchObject({
      state: "ready",
      usableCount: 15,
      sourcedAt: CLAIM,
      claimedAt: null,
      claimRequestedAt: null,
      attempts: 0,
      errorCode: null,
      errorReason: null,
    });
    expect(after.questionBank.builtAt).toBeInstanceOf(Date);
    expect(after.questionBank.requestedAt).toEqual(CLAIM);
    const questions = after.questionBank.questions;
    expect(questions).toHaveLength(15);
    expect(questions.filter((q) => q.type === "mcq")).toHaveLength(8);
    expect(questions.filter((q) => q.type === "fill_blank")).toHaveLength(7);
    questions.forEach((q) => expect(q.key).toBe(normalizeText(q.prompt)));

    const [extractPrompt, reviewPrompt, formatPrompt] = promptsSent();
    expect(promptsSent()).toHaveLength(3);
    expect(extractPrompt).toContain(`Extract up to ${QUESTION_BANK.EXTRACTION_COUNT} revision questions`);
    expect(extractPrompt).toContain(`Maximum ${QUESTION_BANK.EXTRACTION_COUNT} questions`);
    expect(reviewPrompt).toMatch(/^Review the following questions and remove any whose answer is NOT explicitly present in the study material\./);
    expect(reviewPrompt).toContain(JSON.stringify(extracted));
    expect(formatPrompt).toContain(JSON.stringify(reviewed));
    expect(formatPrompt).toContain(`Content stored at ${USER}/${topic._id}/extracted/notes.md.`);
  });

  it("leaves the saved questions out of plain topic queries", async () => {
    const topic = await createTopic();
    llmReplies(pairs(3), pairs(3), [mcqItem(1), blankItem(2)]);

    await build(topic._id);

    const lean = await Topic.findOne({ _id: topic._id, userId: USER }).lean();
    const listed = await Topic.find({ userId: USER }).lean();
    expect(lean!.questionBank.usableCount).toBe(2);
    expect(lean!.questionBank).not.toHaveProperty("questions");
    expect(listed[0].questionBank).not.toHaveProperty("questions");
    expect(JSON.stringify(listed)).not.toContain("Pigment 1B");
  });

  it("drops items matching retired questions and lists the retired questions in the formatter's input (AE8)", async () => {
    const retiredA = "Which pigment absorbs band 1?";
    const retiredB = `Stage 2 of the cycle is called the ${BLANK_MARKER}.`;
    const topic = await createTopic({
      retiredQuestions: [
        { key: normalizeText(retiredA), text: retiredA, retiredAt: EARLIER },
        { key: normalizeText(retiredB), text: retiredB, retiredAt: EARLIER },
      ],
    });
    llmReplies(pairs(5), pairs(5), [
      mcqItem(1, { prompt: "which pigment absorbs band 1" }),
      blankItem(2, { prompt: "STAGE 2 of the cycle is called the _____!" }),
      mcqItem(3),
      blankItem(4),
    ]);

    const result = await build(topic._id);

    expect(result).toEqual({ state: "ready", questionCount: 2, saved: true });
    const after = await loadBank(topic._id);
    const keys = after.questionBank.questions.map((q) => q.key);
    expect(keys).not.toContain(normalizeText(retiredA));
    expect(keys).not.toContain(normalizeText(retiredB));
    expect(after.retiredQuestions).toHaveLength(2);
    const formatPrompt = promptsSent()[2];
    expect(formatPrompt).toContain(JSON.stringify(retiredA));
    expect(formatPrompt).toContain(JSON.stringify(retiredB));
  });

  it("never saves a question retired while the build was running", async () => {
    const topic = await createTopic();
    const flagged = mcqItem(1);
    llmReplies(pairs(4), pairs(4));
    sendTextPrompt.mockImplementationOnce(async () => {
      await Topic.updateOne({ _id: topic._id }, { $push: { retiredQuestions: { key: normalizeText(flagged.prompt), text: flagged.prompt, retiredAt: new Date() } } });
      return JSON.stringify([flagged, blankItem(2), mcqItem(3)]);
    });

    const result = await build(topic._id);

    expect(result).toEqual({ state: "ready", questionCount: 2, saved: true });
    const after = await loadBank(topic._id);
    expect(after.questionBank.questions.map((q) => q.key)).not.toContain(normalizeText(flagged.prompt));
    expect(after.questionBank.usableCount).toBe(2);
    expect(after.retiredQuestions).toHaveLength(1);
  });

  it("refuses the write when a question is retired between the re-read and the save, then saves without it", async () => {
    const topic = await createTopic();
    const flagged = mcqItem(1);
    llmReplies(pairs(3), pairs(3), [flagged, blankItem(2)]);
    const realUpdateOne = Topic.updateOne.bind(Topic);
    const updateSpy = jest.spyOn(Topic, "updateOne").mockImplementationOnce(((filter: never, update: never) =>
      Topic.collection
        .updateOne({ _id: topic._id }, { $push: { retiredQuestions: { key: normalizeText(flagged.prompt), text: flagged.prompt, retiredAt: new Date() } } } as never)
        .then(() => realUpdateOne(filter, update))) as never);

    try {
      const result = await build(topic._id);

      expect(result).toEqual({ state: "ready", questionCount: 1, saved: true });
      expect(updateSpy).toHaveBeenCalledTimes(2);
      const after = await loadBank(topic._id);
      expect(after.questionBank.questions.map((q) => q.type)).toEqual(["fill_blank"]);
      expect(after.questionBank.usableCount).toBe(1);
    } finally {
      updateSpy.mockRestore();
    }
  });

  it("saves empty when the only valid question was retired mid-build", async () => {
    const topic = await createTopic({ questionBank: { state: "building", claimedAt: CLAIM, questions: [storedQuestion(1)], usableCount: 1 } });
    const flagged = blankItem(1);
    llmReplies(pairs(2), pairs(2));
    sendTextPrompt.mockImplementationOnce(async () => {
      await Topic.updateOne({ _id: topic._id }, { $push: { retiredQuestions: { key: normalizeText(flagged.prompt), text: flagged.prompt, retiredAt: new Date() } } });
      return JSON.stringify([flagged]);
    });

    expect(await build(topic._id)).toEqual({ state: "empty", questionCount: 0, saved: true });
    expect((await loadBank(topic._id)).questionBank.questions).toEqual([storedQuestion(1)]);
  });

  it("sets empty and keeps the previous questions when no formatted item is valid", async () => {
    const previous = [storedQuestion(1), storedQuestion(2)];
    const topic = await createTopic({
      questionBank: { state: "building", claimedAt: CLAIM, claimRequestedAt: CLAIM, questions: previous, usableCount: 2, builtAt: EARLIER, sourcedAt: EARLIER, attempts: 1, errorCode: "LLM_ERROR", errorReason: "old failure" },
    });
    llmReplies(pairs(4), pairs(4), [mcqItem(1, { answer: "nope" }), blankItem(2, { prompt: "No blank." }), { type: "essay" }]);

    const result = await build(topic._id);

    expect(result).toEqual({ state: "empty", questionCount: 0, saved: true });
    const after = await loadBank(topic._id);
    expect(after.questionBank).toMatchObject({
      state: "empty",
      usableCount: 2,
      builtAt: EARLIER,
      sourcedAt: CLAIM,
      claimedAt: null,
      claimRequestedAt: null,
      errorCode: null,
      errorReason: null,
    });
    expect(after.questionBank.questions).toEqual(previous);
  });

  it("sets empty without formatting when extraction yields no pairs", async () => {
    const topic = await createTopic();
    llmReplies("[]");

    expect(await build(topic._id)).toEqual({ state: "empty", questionCount: 0, saved: true });
    expect(promptsSent()).toHaveLength(1);
    expect((await loadBank(topic._id)).questionBank.state).toBe("empty");
  });

  it("sets empty without formatting when no pair survives review", async () => {
    const topic = await createTopic();
    llmReplies(pairs(5), "```json\n[]\n```");

    expect(await build(topic._id)).toEqual({ state: "empty", questionCount: 0, saved: true });
    expect(promptsSent()).toHaveLength(2);
  });

  it("sets failed with a reason and keeps the previous questions when an LLM error persists through the retries", async () => {
    const previous = [storedQuestion(1)];
    const topic = await createTopic({ questionBank: { state: "building", claimedAt: CLAIM, claimRequestedAt: CLAIM, questions: previous, usableCount: 1, sourcedAt: EARLIER, builtAt: EARLIER, attempts: 2 } });
    sendTextPrompt.mockRejectedValue(new Error("model overloaded"));

    const result = await build(topic._id);

    expect(result).toEqual({ state: "failed", questionCount: 0, saved: true });
    expect(sendTextPrompt).toHaveBeenCalledTimes(QUESTION_BANK.LLM_ATTEMPTS);
    const after = await loadBank(topic._id);
    expect(after.questionBank).toMatchObject({
      state: "failed",
      errorCode: "LLM_ERROR",
      usableCount: 1,
      sourcedAt: EARLIER,
      builtAt: EARLIER,
      claimedAt: null,
      claimRequestedAt: null,
    });
    expect(after.questionBank.errorReason).toContain("model overloaded");
    expect(after.questionBank.questions).toEqual(previous);
  });

  it("sets failed when the formatter keeps returning text that is not a JSON array", async () => {
    const topic = await createTopic();
    llmReplies(pairs(3), pairs(3), "Here are your questions!", '{"type":"mcq"}', "[{ broken");

    const result = await build(topic._id);

    expect(result.state).toBe("failed");
    expect(sendTextPrompt).toHaveBeenCalledTimes(2 + QUESTION_BANK.LLM_ATTEMPTS);
    expect((await loadBank(topic._id)).questionBank.errorCode).toBe("LLM_ERROR");
  });

  it("truncates a long error reason to fit the field", async () => {
    const topic = await createTopic();
    sendTextPrompt.mockRejectedValue(new Error("x".repeat(2_000)));

    expect((await build(topic._id)).state).toBe("failed");
    expect((await loadBank(topic._id)).questionBank.errorReason!.length).toBeLessThanOrEqual(500);
  });

  it("produces a ready bank when a transient LLM error succeeds on retry", async () => {
    const topic = await createTopic();
    llmReplies(new Error("socket hang up"), pairs(3), "not json at all", pairs(3), [mcqItem(1), blankItem(2), mcqItem(3)]);

    const result = await build(topic._id);

    expect(result).toEqual({ state: "ready", questionCount: 3, saved: true });
    expect(sendTextPrompt).toHaveBeenCalledTimes(5);
    expect((await loadBank(topic._id)).questionBank.state).toBe("ready");
  });

  it("reads only completed attachments' recorded extracted paths, never other objects in the folder", async () => {
    const _id = new Types.ObjectId();
    const ext = (name: string) => `${USER}/${_id}/extracted/${name}`;
    const topic = await createTopic({
      _id,
      files: [
        { fileName: "done.pdf", fileType: "pdf", s3Path: `${USER}/${_id}/files/done.pdf`, s3Bucket: "b", processingStatus: "completed", extractedContentUrl: ext("done.md") },
        { fileName: "pending.pdf", fileType: "pdf", s3Path: `${USER}/${_id}/files/pending.pdf`, s3Bucket: "b", processingStatus: "processing", extractedContentUrl: ext("pending.md") },
        { fileName: "broken.png", fileType: "image", s3Path: `${USER}/${_id}/files/broken.png`, s3Bucket: "b", processingStatus: "failed", extractedContentUrl: ext("broken.md") },
      ],
      urls: [
        { url: "https://example.com/done", processingStatus: "completed", extractedContentPath: ext("url-done.md") },
        { url: "https://example.com/waiting", processingStatus: "pending" },
      ],
    });
    // An orphaned object sits in the same folder; reading it would be a bug.
    readContent.mockImplementation(async (_userId, path) => (path === ext("orphan.md") ? "ORPHANED MATERIAL" : `Material from ${path}`));
    llmReplies(pairs(2), pairs(2), [mcqItem(1)]);

    await build(topic._id);

    expect(readContent.mock.calls).toEqual([
      [USER, ext("done.md")],
      [USER, ext("url-done.md")],
    ]);
    const extractPrompt = promptsSent()[0];
    expect(extractPrompt).toContain("done.pdf");
    expect(extractPrompt).toContain("https://example.com/done");
    expect(extractPrompt).toContain(`Material from ${ext("url-done.md")}`);
    expect(extractPrompt).not.toContain("ORPHANED MATERIAL");
  });

  it("skips a source whose read fails and builds from the rest", async () => {
    const topic = await createTopic();
    readContent.mockImplementation(async (_userId, path) => {
      if (path.endsWith("notes.md")) throw new Error("storage down");
      return "Light reactions happen in the thylakoid.";
    });
    llmReplies(pairs(2), pairs(2), [mcqItem(1)]);

    const result = await build(topic._id);

    expect(result.state).toBe("ready");
    expect(promptsSent()[0]).toContain("Light reactions happen in the thylakoid.");
    expect(bankLog.warn).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error), topicId: topic._id.toString() }), expect.any(String));
  });

  it("sets failed with STORAGE_ERROR, without any LLM call, when every source read fails", async () => {
    const topic = await createTopic({ questionBank: { state: "building", claimedAt: CLAIM, questions: [storedQuestion(1)], usableCount: 1 } });
    readContent.mockRejectedValue(new Error("storage down"));

    const result = await build(topic._id);

    expect(result).toEqual({ state: "failed", questionCount: 0, saved: true });
    expect(sendTextPrompt).not.toHaveBeenCalled();
    const after = await loadBank(topic._id);
    expect(after.questionBank).toMatchObject({ state: "failed", errorCode: "STORAGE_ERROR", usableCount: 1, claimedAt: null });
    expect(after.questionBank.errorReason).toContain("storage down");
    expect(after.questionBank.questions).toEqual([storedQuestion(1)]);
  });

  it("truncates material over the cap and logs it", async () => {
    const topic = await createTopic({ urls: [] });
    const huge = "A".repeat(QUESTION_BANK.MATERIAL_CHAR_CAP + 10_000);
    readContent.mockResolvedValue(huge);
    llmReplies(pairs(2), pairs(2), [mcqItem(1)]);

    await build(topic._id);

    // The material sent is at most the cap, heading included.
    const sent = promptsSent()[0].match(/# Source: notes\.pdf\n\nA+/)?.[0] ?? "";
    expect(sent.length).toBe(QUESTION_BANK.MATERIAL_CHAR_CAP);
    expect(promptsSent()[2]).not.toContain(huge);
    const logged = [...bankLog.warn.mock.calls, ...bankLog.info.mock.calls].map(([fields]) => fields);
    expect(logged).toContainEqual(expect.objectContaining({ topicId: topic._id.toString(), originalLength: expect.any(Number) }));
    const entry = logged.find((f) => f && typeof f === "object" && "originalLength" in f) as { originalLength: number };
    expect(entry.originalLength).toBeGreaterThan(QUESTION_BANK.MATERIAL_CHAR_CAP);
  });

  it("ends empty without any LLM call when the topic has no completed attachments", async () => {
    const _id = new Types.ObjectId();
    const topic = await createTopic({
      _id,
      files: [{ fileName: "p.pdf", fileType: "pdf", s3Path: `${USER}/${_id}/files/p.pdf`, s3Bucket: "b", processingStatus: "failed" }],
      urls: [{ url: "https://example.com/x", processingStatus: "processing" }],
    });

    const result = await build(topic._id);

    expect(result).toEqual({ state: "empty", questionCount: 0, saved: true });
    expect(sendTextPrompt).not.toHaveBeenCalled();
    expect(readContent).not.toHaveBeenCalled();
    expect((await loadBank(topic._id)).questionBank).toMatchObject({ state: "empty", sourcedAt: CLAIM, claimedAt: null });
  });

  it("writes nothing and returns saved:false when the claim was superseded mid-build", async () => {
    const topic = await createTopic({ questionBank: { state: "building", claimedAt: CLAIM, questions: [storedQuestion(1)], usableCount: 1 } });
    const takeover = new Date(CLAIM.getTime() + 60_000);
    llmReplies(pairs(3), pairs(3));
    sendTextPrompt.mockImplementationOnce(async () => {
      await Topic.updateOne({ _id: topic._id }, { $set: { "questionBank.claimedAt": takeover } });
      return JSON.stringify([mcqItem(1), blankItem(2)]);
    });

    const result = await build(topic._id);

    expect(result).toEqual({ state: "ready", questionCount: 2, saved: false });
    const after = await loadBank(topic._id);
    expect(after.questionBank).toMatchObject({ state: "building", claimedAt: takeover, usableCount: 1, sourcedAt: null });
    expect(after.questionBank.questions).toEqual([storedQuestion(1)]);
  });

  it("does not save a failed build over a superseded claim", async () => {
    const topic = await createTopic({ questionBank: { state: "building", claimedAt: new Date(CLAIM.getTime() + 1) } });
    sendTextPrompt.mockRejectedValue(new Error("boom"));

    expect(await build(topic._id)).toEqual({ state: "failed", questionCount: 0, saved: false });
    expect((await loadBank(topic._id)).questionBank).toMatchObject({ state: "building", errorCode: null });
  });

  it("does not save when the bank is no longer building", async () => {
    const topic = await createTopic({ questionBank: { state: "ready", claimedAt: CLAIM, questions: [storedQuestion(1)], usableCount: 1 } });
    llmReplies(pairs(2), pairs(2), [mcqItem(1)]);

    expect((await build(topic._id)).saved).toBe(false);
    expect((await loadBank(topic._id)).questionBank.questions).toEqual([storedQuestion(1)]);
  });

  it("returns failed without writing for a missing topic or another user's topic", async () => {
    const topic = await createTopic();

    expect(await build(new Types.ObjectId())).toEqual({ state: "failed", questionCount: 0, saved: false });
    expect(await build(topic._id, "user-2")).toEqual({ state: "failed", questionCount: 0, saved: false });
    expect(await buildQuestionBank({ topicId: "not-an-id", userId: USER, claimedAt: CLAIM })).toEqual({ state: "failed", questionCount: 0, saved: false });
    expect(sendTextPrompt).not.toHaveBeenCalled();
    expect(readContent).not.toHaveBeenCalled();
    expect((await loadBank(topic._id)).questionBank).toMatchObject({ state: "building", claimedAt: CLAIM });
  });
});

// ---------------------------------------------------------------- the AI chat keeps its pipeline

describe("generateQuestions (AI chat)", () => {
  it(`still asks the extractor for ${QUESTION_BANK.CHAT_EXTRACTION_COUNT} questions and reviews them with the unchanged reviewer`, async () => {
    llmReplies(pairs(3), pairs(2));

    const questions = await generateQuestions("Chlorophyll absorbs red and blue light.");

    expect(questions).toEqual(pairs(2));
    const [extractPrompt, reviewPrompt] = promptsSent();
    expect(QUESTION_BANK.CHAT_EXTRACTION_COUNT).toBe(10);
    expect(extractPrompt).toContain("Extract up to 10 revision questions from the following study material.");
    expect(extractPrompt).toContain("- Maximum 10 questions");
    expect(extractPrompt).toContain("Chlorophyll absorbs red and blue light.");
    expect(reviewPrompt).toContain(JSON.stringify(pairs(3)));
  });

  it("still throws when extraction or review yields nothing", async () => {
    llmReplies("[]");
    await expect(generateQuestions("material")).rejects.toThrow("Failed to extract questions from study materials");

    llmReplies(pairs(2), "[]");
    await expect(generateQuestions("material")).rejects.toThrow("No questions passed review");
  });
});
