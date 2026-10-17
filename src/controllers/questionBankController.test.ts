/**
 * U4 — Regenerate, and bank rebuilds when material is removed through the API.
 */
import request from "supertest";

jest.mock("@services/s3Storage", () => ({
  generatePresignedUploadUrl: jest.fn(async () => "https://upload.example"),
  getSignedContentUrl: jest.fn(async () => "https://signed.example"),
  deleteByPath: jest.fn(),
  deleteFile: jest.fn(),
  deleteTopicFiles: jest.fn(),
}));

import { useMongoMemoryServer, buildTestApp, TEST_USER_HEADER } from "../test/mongo";
import topicRoutes from "@routes/topicRoutes";
import { Topic } from "@models/Topic";
import { Publishers } from "@services/rabbitmq/index";

useMongoMemoryServer();

const app = buildTestApp({ "/api/topics": topicRoutes });
const USER = "user-1";
const bankPublish = jest.fn();
const ORIGINAL_KEY = process.env.LLM_API_KEY;

beforeEach(() => {
  process.env.LLM_API_KEY = "test-key";
  bankPublish.mockReset().mockResolvedValue(true);
  Publishers.questionBank = { publish: bankPublish } as unknown as typeof Publishers.questionBank;
  Publishers.url = { publish: jest.fn().mockResolvedValue(true) } as unknown as typeof Publishers.url;
});

afterAll(() => {
  process.env.LLM_API_KEY = ORIGINAL_KEY;
});

const completedUrl = (url: string) => ({ url, processingStatus: "completed", extractedContentPath: `${USER}/t/extracted/${encodeURIComponent(url)}.md` });
const readyBank = { state: "ready", usableCount: 12, questions: [{ id: "q", key: "k", type: "fill_blank", prompt: "a ____", answer: "b" }], sourcedAt: new Date() };

async function seedTopic(overrides: Record<string, unknown> = {}) {
  return Topic.create({ userId: USER, topicName: "Cells", subjectName: "Biology", dateStudied: new Date(), revisionDate: new Date(), ...overrides });
}

function bankMessages() {
  return bankPublish.mock.calls.map((call) => call[0].message);
}

describe("POST /api/topics/:id/questions/regenerate", () => {
  it("responds 202, sets the bank queued and publishes a rebuild", async () => {
    const topic = await seedTopic({ urls: [completedUrl("https://a.example")], questionBank: readyBank });

    const res = await request(app).post(`/api/topics/${topic._id}/questions/regenerate`);

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ questionBank: { state: "queued", usableCount: 12, rebuilding: true } });
    expect(bankMessages()).toEqual([expect.objectContaining({ topicId: topic._id.toString(), userId: USER, reason: "regenerate" })]);
    const bank = (await Topic.findById(topic._id).lean())!.questionBank;
    expect(bank.state).toBe("queued");
    expect(bank.requestedAt).toBeInstanceOf(Date);
  });

  it("keeps a running build building and reports it as rebuilding", async () => {
    const topic = await seedTopic({ questionBank: { ...readyBank, state: "building", claimedAt: new Date() } });

    const res = await request(app).post(`/api/topics/${topic._id}/questions/regenerate`);

    expect(res.status).toBe(202);
    expect(res.body.questionBank).toEqual({ state: "building", usableCount: 12, rebuilding: true });
  });

  it("returns AI_NOT_CONFIGURED without an LLM key", async () => {
    delete process.env.LLM_API_KEY;
    const topic = await seedTopic();

    const res = await request(app).post(`/api/topics/${topic._id}/questions/regenerate`);

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("AI_NOT_CONFIGURED");
    expect(bankPublish).not.toHaveBeenCalled();
  });

  it("returns TOPIC_NOT_FOUND for another user's topic", async () => {
    const topic = await seedTopic({ userId: "someone-else" });

    const res = await request(app).post(`/api/topics/${topic._id}/questions/regenerate`).set(TEST_USER_HEADER, USER);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("TOPIC_NOT_FOUND");
    expect(bankPublish).not.toHaveBeenCalled();
    expect((await Topic.findById(topic._id).lean())!.questionBank.state).toBe("none");
  });
});

describe("material removed through the API", () => {
  it("removing one of two extracted URLs publishes a rebuild", async () => {
    const topic = await seedTopic({ urls: [completedUrl("https://a.example"), completedUrl("https://b.example")], questionBank: readyBank });

    await request(app).patch(`/api/topics/${topic._id}`).send({ urls: ["https://b.example"] });

    expect(bankMessages()).toEqual([expect.objectContaining({ reason: "material_removed" })]);
    expect((await Topic.findById(topic._id).lean())!.questionBank).toMatchObject({ state: "queued", usableCount: 12 });
  });

  it("removing the last material clears the bank to none without publishing", async () => {
    const topic = await seedTopic({ urls: [completedUrl("https://a.example")], questionBank: readyBank });

    await request(app).patch(`/api/topics/${topic._id}`).send({ urls: [] });

    expect(bankPublish).not.toHaveBeenCalled();
    const after = await Topic.findById(topic._id).select("+questionBank.questions").lean();
    expect(after!.questionBank).toMatchObject({ state: "none", usableCount: 0, questions: [] });
  });

  it("adding a URL does not rebuild until it settles", async () => {
    const topic = await seedTopic({ urls: [completedUrl("https://a.example")], questionBank: readyBank });

    await request(app).patch(`/api/topics/${topic._id}`).send({ urls: ["https://a.example", "https://c.example"] });

    expect(bankPublish).not.toHaveBeenCalled();
  });

  it("deleting an extracted file publishes a rebuild", async () => {
    const topic = await seedTopic({
      urls: [completedUrl("https://a.example")],
      files: [{ fileName: "a.pdf", fileType: "pdf", s3Path: `${USER}/t/files/a.pdf`, s3Bucket: "b", processingStatus: "completed", extractedContentUrl: `${USER}/t/extracted/a.pdf.md` }],
      questionBank: readyBank,
    });

    const res = await request(app).delete(`/api/topics/${topic._id}/files/${topic.files[0]._id}`);

    expect(res.status).toBe(200);
    expect(bankMessages()).toEqual([expect.objectContaining({ reason: "material_removed" })]);
  });

  it("deleting the last extracted file clears the bank", async () => {
    const topic = await seedTopic({
      files: [{ fileName: "a.pdf", fileType: "pdf", s3Path: `${USER}/t/files/a.pdf`, s3Bucket: "b", processingStatus: "completed", extractedContentUrl: `${USER}/t/extracted/a.pdf.md` }],
      questionBank: readyBank,
    });

    await request(app).delete(`/api/topics/${topic._id}/files/${topic.files[0]._id}`);

    expect(bankPublish).not.toHaveBeenCalled();
    expect((await Topic.findById(topic._id).lean())!.questionBank).toMatchObject({ state: "none", usableCount: 0 });
  });
});
