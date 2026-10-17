/**
 * U6 — due-list and topic-detail responses carry review availability, the
 * recall estimate, the last rating and the interval previews, and never the
 * bank's questions, answers or retired list. The forgetting curve keeps its
 * output after moving onto the shared retention helper.
 */
import request from "supertest";

jest.mock("@services/s3Storage", () => ({
  getSignedContentUrl: jest.fn(async (path: string) => `https://signed.example/${path}`),
  generatePresignedUploadUrl: jest.fn(),
  deleteTopicFiles: jest.fn(),
  deleteFile: jest.fn(),
  deleteByPath: jest.fn(),
}));

import { useMongoMemoryServer, buildTestApp, freezeDate } from "../test/mongo";
import topicRoutes from "@routes/topicRoutes";
import { Topic, type IBankQuestion } from "@models/Topic";
import { RevisionRecord } from "@models/RevisionRecord";
import { calculateNextReview } from "@services/sm2Algorithm";

useMongoMemoryServer();

const app = buildTestApp({ "/api/topics": topicRoutes });
const USER = "user-1";
const NOW = new Date("2026-03-10T15:00:00.000Z");
const MIN_MS = 60_000;

const ORIGINAL_ENV = { LLM_API_KEY: process.env.LLM_API_KEY, LLM_PROVIDER: process.env.LLM_PROVIDER };

beforeEach(() => {
  process.env.LLM_API_KEY = "test-key";
  delete process.env.LLM_PROVIDER;
});

afterEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
});

afterAll(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const SECRET_QUESTIONS: IBankQuestion[] = [
  { id: "q1", key: "the powerhouse of the cell", type: "fill_blank", prompt: "The powerhouse of the cell is the ____", answer: "ANSWER-MITOCHONDRION-7731", alternatives: ["ALT-ANSWER-4410"] },
  { id: "q2", key: "which pigment", type: "mcq", prompt: "PROMPT-WHICH-PIGMENT-2290?", options: ["OPTION-CHLOROPHYLL-1", "Keratin", "Melanin", "Haemoglobin"], answer: "OPTION-CHLOROPHYLL-1" },
  { id: "q3", key: "q3", type: "fill_blank", prompt: "Three ____", answer: "ANSWER-THREE-8812" },
  { id: "q4", key: "q4", type: "fill_blank", prompt: "Four ____", answer: "ANSWER-FOUR-9923" },
];
const RETIRED = [{ key: "retired one", text: "RETIRED-QUESTION-TEXT-5150", retiredAt: new Date("2026-03-01T00:00:00.000Z") }];
const FORBIDDEN = ["ANSWER-", "ALT-ANSWER", "PROMPT-WHICH", "OPTION-CHLOROPHYLL", "RETIRED-QUESTION", "retiredQuestions", '"questions"', "requestedAt", "claimedAt", "claimRequestedAt", "sourcedAt", "errorCode"];

async function seedTopic(overrides: Record<string, unknown> = {}) {
  return Topic.create({
    userId: USER,
    topicName: "Cells",
    subjectName: "Biology",
    dateStudied: new Date("2026-03-01T00:00:00.000Z"),
    revisionDate: new Date("2026-03-10T00:00:00.000Z"),
    lastRevised: new Date("2026-03-04T00:00:00.000Z"),
    // Created before the last review, so recall counts from the review (KTD12).
    createdAt: new Date("2026-03-01T00:00:00.000Z"),
    interval: 6,
    eFactor: 2.36,
    repetitionNumber: 2,
    lastQuality: 3,
    files: [{ fileName: "cells.pdf", fileType: "pdf", s3Path: `${USER}/t/files/cells.pdf`, s3Bucket: "b", processingStatus: "completed", extractedContentUrl: `${USER}/t/extracted/cells.pdf.md`, statusUpdatedAt: new Date("2026-03-01T01:00:00.000Z") }],
    urls: [{ url: "https://cells.example", processingStatus: "failed", errorReason: "404", statusUpdatedAt: new Date("2026-03-01T01:00:00.000Z") }],
    questionBank: { state: "ready", questions: SECRET_QUESTIONS, usableCount: 4, requestedAt: new Date("2026-03-01T02:00:00.000Z"), claimedAt: null, sourcedAt: new Date("2026-03-01T02:00:00.000Z"), builtAt: new Date("2026-03-01T02:05:00.000Z") },
    retiredQuestions: RETIRED,
    ...overrides,
  });
}

function expectNoBankSecrets(body: unknown) {
  const json = JSON.stringify(body);
  for (const needle of FORBIDDEN) expect(json).not.toContain(needle);
}

const AVAILABLE = { available: true, reason: null };
const EXPECTED_INTERVALS = [0, 1, 2, 3, 4, 5].map((quality) => calculateNextReview({ eFactor: 2.36, repetitionNumber: 2, interval: 6, quality }).interval);

describe("GET /api/topics/due — review fields", () => {
  it("decorates each item with availability, recall, last rating and interval previews, and no bank secrets", async () => {
    freezeDate(NOW);
    const topic = await seedTopic();
    // The secrets really are stored, so their absence below is meaningful.
    const stored = await Topic.findById(topic._id).select("+questionBank.questions +retiredQuestions").lean();
    expect(stored!.questionBank.questions).toHaveLength(4);
    expect(stored!.retiredQuestions).toHaveLength(1);

    const res = await request(app).get("/api/topics/due");

    expect(res.status).toBe(200);
    expect(res.body.topics).toHaveLength(1);
    const item = res.body.topics[0];
    expect(item).toMatchObject({ _id: topic._id.toString(), topicName: "Cells", subjectName: "Biology", interval: 6, repetitionNumber: 2, eFactor: 2.36, revisionDate: "2026-03-10T00:00:00.000Z", lastQuality: 3 });
    expect(item.files[0]).toMatchObject({ fileName: "cells.pdf", processingStatus: "completed" });
    expect(Object.keys(item.questionBank).sort()).toEqual(["rebuilding", "state", "usableCount"]);
    expect(item.questionBank).toEqual({ state: "ready", usableCount: 4, rebuilding: false });
    expect(item.review).toEqual({ doneToday: false, normalQuiz: { ...AVAILABLE, questionCount: 4 }, aiQuiz: AVAILABLE });
    expect(item.nextIntervals).toEqual(EXPECTED_INTERVALS);
    // Six and a half days since the last review on a six-day interval: just under 0.9.
    expect(item.estimatedRecall).toBeGreaterThan(0.88);
    expect(item.estimatedRecall).toBeLessThan(0.9);
    expect(item).not.toHaveProperty("retiredQuestions");
    expectNoBankSecrets(res.body);
  });

  it("covers AE12 over HTTP: with no LLM key a topic without a bank reports ai_not_configured", async () => {
    delete process.env.LLM_API_KEY;
    freezeDate(NOW);
    await seedTopic({ questionBank: { state: "none", usableCount: 0 } });

    const res = await request(app).get("/api/topics/due");

    expect(res.body.topics[0].review).toEqual({
      doneToday: false,
      normalQuiz: { available: false, reason: "ai_not_configured", questionCount: 0 },
      aiQuiz: { available: false, reason: "ai_not_configured" },
    });
  });

  it("treats the local provider as configured without a key", async () => {
    delete process.env.LLM_API_KEY;
    process.env.LLM_PROVIDER = "local";
    freezeDate(NOW);
    await seedTopic({ questionBank: { state: "none", usableCount: 0 } });

    const res = await request(app).get("/api/topics/due");

    expect(res.body.topics[0].review.aiQuiz).toEqual(AVAILABLE);
    expect(res.body.topics[0].review.normalQuiz.reason).toBe("no_questions");
  });

  it("covers AE7 over HTTP: a topic whose only material is a processing PDF reports materials_processing", async () => {
    freezeDate(NOW);
    await seedTopic({
      files: [{ fileName: "new.pdf", fileType: "pdf", s3Path: `${USER}/t/files/new.pdf`, s3Bucket: "b", processingStatus: "processing", statusUpdatedAt: new Date(NOW.getTime() - 5 * MIN_MS) }],
      urls: [],
      questionBank: { state: "none", usableCount: 0 },
    });

    const res = await request(app).get("/api/topics/due");

    expect(res.body.topics[0].review.normalQuiz).toEqual({ available: false, reason: "materials_processing", questionCount: 0 });
    expect(res.body.topics[0].review.aiQuiz).toEqual({ available: false, reason: "materials_processing" });
  });

  it("covers R12: a topic finished today stays listed, marked done with its rating and next review date", async () => {
    freezeDate(NOW);
    const topic = await seedTopic();
    const review = await request(app).post(`/api/topics/${topic._id}/revised`).send({ userQuality: 5 });
    expect(review.status).toBe(200);

    const res = await request(app).get("/api/topics/due");

    expect(res.body.topics).toHaveLength(1);
    const item = res.body.topics[0];
    expect(item.lastQuality).toBe(5);
    expect(item.revisionDate).toBe(review.body.nextRevisionDate);
    expect(item.review).toEqual({ doneToday: true, normalQuiz: { available: false, reason: "done_today", questionCount: 4 }, aiQuiz: { available: false, reason: "done_today" } });
    expect(item.estimatedRecall).toBe(1);
    expectNoBankSecrets(res.body);
  });

  it("lists only the caller's topics", async () => {
    freezeDate(NOW);
    await seedTopic({ userId: "someone-else" });

    const res = await request(app).get("/api/topics/due");

    expect(res.body.topics).toEqual([]);
  });
});

describe("GET /api/topics/:id — review fields", () => {
  it("carries the same review fields, keeps attachment statuses and signed URLs, and leaks no bank secrets", async () => {
    freezeDate(NOW);
    const topic = await seedTopic();

    const res = await request(app).get(`/api/topics/${topic._id}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ _id: topic._id.toString(), topicName: "Cells", subjectName: "Biology", lastQuality: 3 });
    expect(res.body.files).toEqual([{ _id: topic.files[0]._id!.toString(), fileName: "cells.pdf", fileType: "pdf", fileUrl: `https://signed.example/${USER}/t/files/cells.pdf`, processingStatus: "completed" }]);
    expect(res.body.urls[0]).toMatchObject({ url: "https://cells.example", processingStatus: "failed", errorReason: "404" });
    expect(res.body.questionBank).toEqual({ state: "ready", usableCount: 4, rebuilding: false });
    expect(res.body.review).toEqual({ doneToday: false, normalQuiz: { ...AVAILABLE, questionCount: 4 }, aiQuiz: AVAILABLE });
    expect(res.body.nextIntervals).toEqual(EXPECTED_INTERVALS);
    expect(typeof res.body.estimatedRecall).toBe("number");
    expect(res.body).not.toHaveProperty("retiredQuestions");
    expectNoBankSecrets(res.body);
  });

  it("reports done today in the learner's zone", async () => {
    // Reviewed 2026-03-10 13:00Z (09:00 New York). At 2026-03-11T00:00Z it is
    // still the 10th in New York but already the 11th in UTC.
    freezeDate(new Date("2026-03-11T00:00:00.000Z"));
    const topic = await seedTopic({ lastRevised: new Date("2026-03-10T13:00:00.000Z"), revisionDate: new Date("2026-03-25T13:00:00.000Z") });

    const ny = await request(app).get(`/api/topics/${topic._id}`).set("X-Local-TimeZone", "America/New_York");
    const utc = await request(app).get(`/api/topics/${topic._id}`);

    expect(ny.body.review.doneToday).toBe(true);
    expect(ny.body.review.normalQuiz.reason).toBe("done_today");
    expect(utc.body.review.doneToday).toBe(false);
    expect(utc.body.review.normalQuiz.reason).toBe("not_due");
  });

  it("returns TOPIC_NOT_FOUND for another user's topic", async () => {
    const topic = await seedTopic({ userId: "someone-else" });

    const res = await request(app).get(`/api/topics/${topic._id}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("TOPIC_NOT_FOUND");
  });
});

describe("GET /api/topics/:id/forgetting-curve — characterization", () => {
  // Captured from the endpoint before it moved onto `retentionAt`.
  const pts = (rows: [string, number][]) => rows.map(([date, retention]) => ({ date, retention }));

  it("keeps its output for a topic with no revision history", async () => {
    const topic = await Topic.create({ userId: USER, topicName: "Curve A", subjectName: "Biology", dateStudied: new Date("2026-01-01T00:00:00.000Z"), revisionDate: new Date("2026-01-03T00:00:00.000Z"), interval: 2, eFactor: 2.5, repetitionNumber: 0 });

    freezeDate(new Date("2026-01-11T12:00:00.000Z"));
    const res = await request(app).get(`/api/topics/${topic._id}/forgetting-curve`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      topicName: "Curve A",
      eFactor: 2.5,
      interval: 2,
      repetitionNumber: 0,
      revisionDate: "2026-01-03T00:00:00.000Z",
      lastRevised: null,
      curvePoints: pts([
        ["2026-01-01", 1], ["2026-01-02", 0.949], ["2026-01-03", 0.9], ["2026-01-04", 0.854], ["2026-01-05", 0.81], ["2026-01-06", 0.768],
        ["2026-01-07", 0.729], ["2026-01-08", 0.692], ["2026-01-09", 0.656], ["2026-01-10", 0.622], ["2026-01-11", 0.59], ["2026-01-12", 0.56],
      ]),
      revisionMarkers: [],
    });
  });

  it("keeps its output for a topic with revision history, ignoring another user's records", async () => {
    const topic = await Topic.create({ userId: USER, topicName: "Curve B", subjectName: "Biology", dateStudied: new Date("2026-01-01T00:00:00.000Z"), revisionDate: new Date("2026-01-24T00:00:00.000Z"), lastRevised: new Date("2026-01-09T10:00:00.000Z"), interval: 15, eFactor: 2.46, repetitionNumber: 3, lastQuality: 5 });
    const record = (userId: string, revisionDate: string, finalQuality: number, newEFactor: number, newInterval: number, next: string) =>
      RevisionRecord.create({ userId, topicId: topic._id, revisionDate: new Date(revisionDate), userQuality: finalQuality, llmQuality: finalQuality, finalQuality, newEFactor, newInterval, nextRevisionDate: new Date(next) });
    await record(USER, "2026-01-02T09:00:00.000Z", 4, 2.5, 1, "2026-01-03T09:00:00.000Z");
    await record(USER, "2026-01-03T18:00:00.000Z", 3, 2.36, 6, "2026-01-09T18:00:00.000Z");
    await record(USER, "2026-01-09T10:00:00.000Z", 5, 2.46, 15, "2026-01-24T10:00:00.000Z");
    await record("someone-else", "2026-01-05T10:00:00.000Z", 1, 1.3, 1, "2026-01-06T10:00:00.000Z");

    freezeDate(new Date("2026-01-20T08:00:00.000Z"));
    const res = await request(app).get(`/api/topics/${topic._id}/forgetting-curve`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      topicName: "Curve B",
      eFactor: 2.46,
      interval: 15,
      repetitionNumber: 3,
      revisionDate: "2026-01-24T00:00:00.000Z",
      lastRevised: "2026-01-09T10:00:00.000Z",
      curvePoints: pts([
        ["2026-01-01", 1], ["2026-01-02", 0.9], ["2026-01-02", 1],
        ["2026-01-02", 1], ["2026-01-03", 0.9], ["2026-01-03", 1],
        ["2026-01-03", 1], ["2026-01-04", 0.983], ["2026-01-05", 0.965], ["2026-01-06", 0.949], ["2026-01-07", 0.932], ["2026-01-08", 0.916], ["2026-01-09", 1],
        ["2026-01-10", 0.993], ["2026-01-11", 0.986], ["2026-01-12", 0.979], ["2026-01-13", 0.972], ["2026-01-14", 0.965], ["2026-01-15", 0.959], ["2026-01-16", 0.952], ["2026-01-17", 0.945],
        ["2026-01-18", 0.939], ["2026-01-19", 0.932], ["2026-01-20", 0.926], ["2026-01-21", 0.919], ["2026-01-22", 0.913], ["2026-01-23", 0.906], ["2026-01-24", 0.9],
      ]),
      revisionMarkers: [
        { date: "2026-01-02", quality: 4, eFactor: 2.5, interval: 1 },
        { date: "2026-01-03", quality: 3, eFactor: 2.36, interval: 6 },
        { date: "2026-01-09", quality: 5, eFactor: 2.46, interval: 15 },
      ],
    });
  });
});
