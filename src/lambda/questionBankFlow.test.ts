/**
 * U3 + U4 end to end: worker settles an attachment → bank request published →
 * bank consumer claims and builds with the real pipeline (LLM scripted,
 * storage mocked) → a ready bank.
 */
import { mockClient } from "aws-sdk-client-mock";
import { S3Client, HeadObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import type { ConsumeMessage } from "amqplib";

const mockSendTextPrompt = jest.fn();
jest.mock("@services/llmClient", () => ({ getLLMClient: () => ({ sendTextPrompt: mockSendTextPrompt }) }));
jest.mock("@services/fileExtractor", () => ({ extractContent: jest.fn() }));

import { useMongoMemoryServer } from "../test/mongo";
import { Topic } from "@models/Topic";
import { handleFileMessage } from "@/lambda/fileProcessor";
import { handleBankRequest } from "@/lambda/questionBankProcessor";
import { onAttachmentSettled } from "@services/questionBankJobs";
import { applyUrlListUpdate } from "@services/topicMaterials";
import { setRetryDelayForTests } from "@services/questionBank";
import { extractContent } from "@services/fileExtractor";
import { Publishers } from "@services/rabbitmq/index";
import type { QuestionBankMessage } from "@/schemas/queue.schema";

useMongoMemoryServer();

const s3 = mockClient(S3Client);
const USER = "user-1";
const BUCKET = "revision-study-content";
const publish = jest.fn();
const stored = new Map<string, string>();

const pairs = (n: number) => Array.from({ length: n }, (_, i) => ({ question: `What is fact ${i}?`, answer: `Answer ${i}` }));
const items = (n: number, prefix = "Fact") =>
  Array.from({ length: n }, (_, i) =>
    i % 2 === 0
      ? { type: "mcq", prompt: `${prefix} ${i}: which is right?`, options: [`Right ${i}`, `Wrong A${i}`, `Wrong B${i}`, `Wrong C${i}`], answer: `Right ${i}` }
      : { type: "fill_blank", prompt: `${prefix} ${i} is ____.`, answer: `term ${i}`, alternatives: [] },
  );

/** Scripts one build: extract, review, format. */
function scriptBuild(formatted: unknown[], reviewed = pairs(formatted.length)) {
  mockSendTextPrompt
    .mockResolvedValueOnce(JSON.stringify(reviewed))
    .mockResolvedValueOnce(JSON.stringify(reviewed))
    .mockResolvedValueOnce(JSON.stringify(formatted));
}

function fileMessage(key: string): ConsumeMessage {
  return { content: Buffer.from(JSON.stringify({ bucket: BUCKET, key })) } as unknown as ConsumeMessage;
}

function bankMessages(): QuestionBankMessage[] {
  return publish.mock.calls.map((call) => call[0].message);
}

async function bankOf(topicId: unknown) {
  return (await Topic.findById(topicId).select("+questionBank.questions +retiredQuestions").lean())!;
}

beforeAll(() => setRetryDelayForTests(0));
afterAll(() => setRetryDelayForTests());

beforeEach(() => {
  s3.reset();
  stored.clear();
  mockSendTextPrompt.mockReset();
  publish.mockReset().mockResolvedValue(true);
  Publishers.questionBank = { publish } as unknown as typeof Publishers.questionBank;
  (extractContent as jest.Mock).mockReset().mockImplementation(async () => ({ success: true, content: "# Photosynthesis\nChlorophyll absorbs light." }));
  s3.on(HeadObjectCommand).resolves({ ContentType: "application/pdf", ContentLength: 100 });
  s3.on(GetObjectCommand).callsFake(async ({ Key }: { Key: string }) => ({
    Body: {
      transformToByteArray: async () => new Uint8Array([1]),
      transformToString: async () => stored.get(Key) ?? "",
    },
  }));
  s3.on(PutObjectCommand).callsFake(async ({ Key, Body }: { Key: string; Body: string }) => {
    stored.set(Key, Body);
    return {};
  });
});

async function seedTopic(overrides: Record<string, unknown> = {}) {
  return Topic.create({ userId: USER, topicName: "Photosynthesis", subjectName: "Biology", dateStudied: new Date(), revisionDate: new Date(), ...overrides });
}

const pendingFile = (topicId: string, fileName: string) => ({ fileName, fileType: "pdf", s3Path: `${USER}/${topicId}/files/${fileName}`, s3Bucket: BUCKET, processingStatus: "pending", statusUpdatedAt: new Date() });

it("covers AE16 (job half): a PDF-only topic's completed upload publishes a build, and the consumer produces a ready bank", async () => {
  const topic = await seedTopic();
  const id = topic._id.toString();
  await Topic.updateOne({ _id: id }, { $push: { files: pendingFile(id, "notes.pdf") } });

  expect(await handleFileMessage(fileMessage(`${USER}/${id}/files/notes.pdf`))).toBe("ack");

  expect(bankMessages()).toHaveLength(1);
  expect(bankMessages()[0]).toMatchObject({ topicId: id, userId: USER, reason: "materials_settled" });

  scriptBuild(items(15));
  expect(await handleBankRequest(bankMessages()[0])).toBe("ack");

  const after = await bankOf(id);
  expect(after.files[0].processingStatus).toBe("completed");
  expect(after.questionBank).toMatchObject({ state: "ready", usableCount: 15 });
  expect(new Set(after.questionBank.questions.map((q) => q.type))).toEqual(new Set(["mcq", "fill_blank"]));
});

it("builds a topic uploaded with two files from both, after the second settles", async () => {
  const topic = await seedTopic();
  const id = topic._id.toString();
  await Topic.updateOne({ _id: id }, { $push: { files: { $each: [pendingFile(id, "a.pdf"), pendingFile(id, "b.pdf")] } } });
  (extractContent as jest.Mock).mockResolvedValueOnce({ success: true, content: "Material from A" }).mockResolvedValueOnce({ success: true, content: "Material from B" });

  await handleFileMessage(fileMessage(`${USER}/${id}/files/a.pdf`));
  expect(bankMessages()).toHaveLength(0);
  await handleFileMessage(fileMessage(`${USER}/${id}/files/b.pdf`));
  expect(bankMessages()).toHaveLength(1);

  scriptBuild(items(6));
  await handleBankRequest(bankMessages()[0]);

  const extractPrompt = mockSendTextPrompt.mock.calls[0][0] as string;
  expect(extractPrompt).toContain("Material from A");
  expect(extractPrompt).toContain("Material from B");
  expect((await bankOf(id)).questionBank.state).toBe("ready");
});

it("covers AE8: adding a URL to a topic with two flagged questions rebuilds from old and new material without either of them", async () => {
  const topic = await seedTopic({
    urls: [{ url: "https://old.example", processingStatus: "completed", extractedContentPath: `${USER}/x/extracted/url_old.md`, statusUpdatedAt: new Date(Date.now() - 60_000) }],
    questionBank: { state: "ready", usableCount: 1, questions: [{ id: "q0", key: "kept", type: "fill_blank", prompt: "Kept ____", answer: "x" }], sourcedAt: new Date(Date.now() - 30_000) },
    retiredQuestions: [
      { key: "fact 0: which is right?", text: "Fact 0: which is right?", retiredAt: new Date() },
      { key: "fact 1 is ____", text: "Fact 1 is ____.", retiredAt: new Date() },
    ],
  });
  const id = topic._id.toString();
  stored.set(`${USER}/x/extracted/url_old.md`, "Old material");
  stored.set(`${USER}/x/extracted/url_new.md`, "New material");
  Publishers.url = { publish: jest.fn().mockResolvedValue(true) } as unknown as typeof Publishers.url;

  await applyUrlListUpdate(topic, ["https://old.example", "https://new.example"]);
  // The URL worker extracts the new URL.
  await Topic.updateOne(
    { _id: id, "urls.url": "https://new.example" },
    { $set: { "urls.$.processingStatus": "completed", "urls.$.extractedContentPath": `${USER}/x/extracted/url_new.md`, "urls.$.statusUpdatedAt": new Date() } },
  );
  expect(await onAttachmentSettled(id, USER)).toBe(true);

  scriptBuild(items(8));
  await handleBankRequest(bankMessages().at(-1)!);

  const after = await bankOf(id);
  const keys = after.questionBank.questions.map((q) => q.key);
  expect(keys).toHaveLength(6);
  expect(keys).not.toContain("fact 0: which is right?");
  expect(keys).not.toContain("fact 1 is ____");
  expect(after.retiredQuestions).toHaveLength(2);
  const formatterPrompt = mockSendTextPrompt.mock.calls[2][0] as string;
  expect(formatterPrompt).toContain("Old material");
  expect(formatterPrompt).toContain("New material");
  expect(formatterPrompt).toContain("Fact 0: which is right?");
});
