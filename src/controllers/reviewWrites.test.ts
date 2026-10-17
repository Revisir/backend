/**
 * U1 — one durable review per topic per learner-day, 0–5 ratings, and the
 * learner's local day in the due list and statistics.
 *
 * Runs against a real in-memory MongoDB: the concurrent-completion case is the
 * one a mocked model would hide.
 */
import request from "supertest";
import { Types } from "mongoose";

jest.mock("@services/chatContext", () => ({
  buildChatContext: jest.fn(),
  assessStudentPerformance: jest.fn(),
}));
jest.mock("@services/questionAgent", () => ({
  generateQuestions: jest.fn(),
  evaluateAnswer: jest.fn(),
}));
jest.mock("@services/s3Storage", () => ({
  getSignedContentUrl: jest.fn().mockResolvedValue("https://signed.example/file"),
  generatePresignedUploadUrl: jest.fn(),
  deleteTopicFiles: jest.fn(),
  deleteFile: jest.fn(),
  deleteByPath: jest.fn(),
}));

import { useMongoMemoryServer, buildTestApp, freezeDate } from "../test/mongo";
import topicRoutes from "@routes/topicRoutes";
import chatRoutes from "@routes/chatRoutes";
import statisticsRoutes from "@routes/statisticsRoutes";
import { Topic } from "@models/Topic";
import { RevisionRecord } from "@models/RevisionRecord";
import { ChatSession } from "@models/ChatSession";
import { recordRevision, AlreadyReviewedTodayError } from "@services/reviewRecorder";
import { learnerDayFromHeader } from "@services/learnerDay";
import { buildChatContext, assessStudentPerformance } from "@services/chatContext";
import { generateQuestions } from "@services/questionAgent";

useMongoMemoryServer();

const app = buildTestApp({ "/api/topics": topicRoutes, "/api/chat": chatRoutes, "/api/statistics": statisticsRoutes });

const USER = "user-1";

async function createTopic(overrides: Record<string, unknown> = {}) {
  return Topic.create({
    userId: USER,
    topicName: "Photosynthesis",
    subjectName: "Biology",
    dateStudied: new Date("2026-01-01T00:00:00.000Z"),
    revisionDate: new Date("2026-01-02T00:00:00.000Z"),
    eFactor: 2.5,
    repetitionNumber: 0,
    interval: 1,
    ...overrides,
  });
}

beforeAll(() => {
  process.env.LLM_API_KEY = "test-key";
});

afterEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
});

describe("recordRevision (day claim)", () => {
  const ny = (iso: string) => learnerDayFromHeader("America/New_York", new Date(iso));

  it("records once and refuses a second review in the same learner-day, leaving the first intact", async () => {
    const topic = await createTopic();
    const morning = ny("2026-03-10T13:00:00.000Z"); // 09:00 EDT

    const first = await recordRevision({ userId: USER, topicId: topic._id, userQuality: 4, method: "self", day: morning });

    const evening = ny("2026-03-11T00:00:00.000Z"); // 20:00 EDT, same learner day
    await expect(recordRevision({ userId: USER, topicId: topic._id, userQuality: 1, method: "self", day: evening })).rejects.toBeInstanceOf(AlreadyReviewedTodayError);

    const records = await RevisionRecord.find({ topicId: topic._id });
    expect(records).toHaveLength(1);
    expect(records[0].finalQuality).toBe(4);

    const after = await Topic.findById(topic._id).lean();
    expect(after!.revisionDate.toISOString()).toBe(first.nextRevisionDate.toISOString());
    expect(after!.lastQuality).toBe(4);
    expect(after!.repetitionNumber).toBe(1);
  });

  it("lets exactly one of two concurrent completions through", async () => {
    const topic = await createTopic();
    const day = ny("2026-03-10T15:00:00.000Z");

    const results = await Promise.allSettled([
      recordRevision({ userId: USER, topicId: topic._id, userQuality: 5, method: "ai_quiz", llmQuality: 5, day }),
      recordRevision({ userId: USER, topicId: topic._id, userQuality: 3, method: "normal_quiz", day }),
      recordRevision({ userId: USER, topicId: topic._id, userQuality: 4, method: "self", day }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(2);
    rejected.forEach((r) => expect(r.reason).toBeInstanceOf(AlreadyReviewedTodayError));
    expect(await RevisionRecord.countDocuments({ topicId: topic._id })).toBe(1);
  });

  it("returns the same review to concurrent completions of one session, writing one record", async () => {
    const topic = await createTopic();
    const day = ny("2026-03-10T15:00:00.000Z");
    const sessionId = new Types.ObjectId();

    const results = await Promise.all(
      [5, 5, 5].map((q) => recordRevision({ userId: USER, topicId: topic._id, userQuality: q, method: "normal_quiz", quizScored: 5, quizCorrect: 5, sessionId, day })),
    );

    expect(await RevisionRecord.countDocuments({ topicId: topic._id })).toBe(1);
    const dates = new Set(results.map((r) => r.nextRevisionDate.toISOString()));
    expect(dates.size).toBe(1);
    results.forEach((r) => expect(r.finalQuality).toBe(5));
    // A different session that day is still refused.
    await expect(recordRevision({ userId: USER, topicId: topic._id, userQuality: 4, method: "normal_quiz", sessionId: new Types.ObjectId(), day })).rejects.toBeInstanceOf(AlreadyReviewedTodayError);
  });

  it("records a review at 23:30 local and another at 00:30 the next local day", async () => {
    const topic = await createTopic();

    await recordRevision({ userId: USER, topicId: topic._id, userQuality: 4, method: "self", day: ny("2026-03-11T03:30:00.000Z") }); // 23:30 EDT on the 10th
    await recordRevision({ userId: USER, topicId: topic._id, userQuality: 4, method: "self", day: ny("2026-03-11T04:30:00.000Z") }); // 00:30 EDT on the 11th

    expect(await RevisionRecord.countDocuments({ topicId: topic._id })).toBe(2);
  });

  it("saves a 0 rating and resets the interval to one day", async () => {
    const topic = await createTopic({ repetitionNumber: 3, interval: 15, eFactor: 2.3 });
    const day = ny("2026-03-10T15:00:00.000Z");

    const result = await recordRevision({ userId: USER, topicId: topic._id, userQuality: 0, method: "self", day });

    expect(result.finalQuality).toBe(0);
    expect(result.interval).toBe(1);
    expect(result.repetitionNumber).toBe(0);
    const record = await RevisionRecord.findOne({ topicId: topic._id }).lean();
    expect(record!.finalQuality).toBe(0);
    expect(record!.userQuality).toBe(0);
    expect((await Topic.findById(topic._id).lean())!.lastQuality).toBe(0);
  });

  it("counts an AI score of 0 in the average", async () => {
    const topic = await createTopic();
    const result = await recordRevision({ userId: USER, topicId: topic._id, userQuality: 4, llmQuality: 0, method: "ai_quiz", day: ny("2026-03-10T15:00:00.000Z") });

    expect(result.finalQuality).toBe(2);
    const record = await RevisionRecord.findOne({ topicId: topic._id }).lean();
    expect(record!.llmQuality).toBe(0);
    expect(record!.method).toBe("ai_quiz");
  });

  it("stores the method, quiz counts and session id", async () => {
    const topic = await createTopic();
    const sessionId = new Types.ObjectId();

    await recordRevision({ userId: USER, topicId: topic._id, userQuality: 3, method: "normal_quiz", quizScored: 4, quizCorrect: 3, sessionId, day: ny("2026-03-10T15:00:00.000Z") });

    const record = await RevisionRecord.findOne({ topicId: topic._id }).lean();
    expect(record).toMatchObject({ method: "normal_quiz", quizScored: 4, quizCorrect: 3, finalQuality: 3 });
    expect(record!.sessionId!.toString()).toBe(sessionId.toString());
  });

  it("restores the topic when the revision record cannot be written", async () => {
    const topic = await createTopic({ repetitionNumber: 2, interval: 6, revisionDate: new Date("2026-03-09T00:00:00.000Z"), lastQuality: 4 });
    const spy = jest.spyOn(RevisionRecord, "create").mockRejectedValueOnce(new Error("write failed") as never);

    await expect(recordRevision({ userId: USER, topicId: topic._id, userQuality: 5, method: "self", day: ny("2026-03-10T15:00:00.000Z") })).rejects.toThrow("write failed");
    spy.mockRestore();

    const after = await Topic.findById(topic._id).lean();
    expect(after).toMatchObject({ repetitionNumber: 2, interval: 6, lastRevised: null, lastQuality: 4 });
    expect(after!.revisionDate.toISOString()).toBe("2026-03-09T00:00:00.000Z");
  });

  it("does not touch another user's topic", async () => {
    const topic = await createTopic({ userId: "someone-else" });
    await expect(recordRevision({ userId: USER, topicId: topic._id, userQuality: 4, method: "self", day: ny("2026-03-10T15:00:00.000Z") })).rejects.toThrow();
    expect(await RevisionRecord.countDocuments({})).toBe(0);
  });
});

describe("POST /api/topics/:id/revised", () => {
  it("records a 0–5 rating with method self and returns the new schedule", async () => {
    const topic = await createTopic();

    const res = await request(app).post(`/api/topics/${topic._id}/revised`).send({ userQuality: 0 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, interval: 1, repetitionNumber: 0, lastQuality: 0 });
    expect(typeof res.body.nextRevisionDate).toBe("string");
    expect(typeof res.body.lastRevised).toBe("string");
    expect(typeof res.body.eFactor).toBe("number");
    expect(res.body).not.toHaveProperty("unrevised");

    const record = await RevisionRecord.findOne({ topicId: topic._id }).lean();
    expect(record).toMatchObject({ method: "self", finalQuality: 0 });
  });

  it("covers AE13: a second review that learner-day returns ALREADY_REVIEWED_TODAY and changes nothing", async () => {
    const topic = await createTopic();

    const first = await request(app).post(`/api/topics/${topic._id}/revised`).send({ userQuality: 4 });
    expect(first.status).toBe(200);
    const before = await Topic.findById(topic._id).lean();

    const second = await request(app).post(`/api/topics/${topic._id}/revised`).send({ userQuality: 2 });

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("ALREADY_REVIEWED_TODAY");
    expect(await RevisionRecord.countDocuments({ topicId: topic._id })).toBe(1);
    const after = await Topic.findById(topic._id).lean();
    expect(after!.revisionDate.toISOString()).toBe(before!.revisionDate.toISOString());
    expect(after!.lastQuality).toBe(4);
  });

  it.each([[-1], [6], ["4"], [undefined]])("rejects userQuality %p", async (userQuality) => {
    const topic = await createTopic();
    const res = await request(app).post(`/api/topics/${topic._id}/revised`).send({ userQuality });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns TOPIC_NOT_FOUND for another user's topic", async () => {
    const topic = await createTopic({ userId: "someone-else" });
    const res = await request(app).post(`/api/topics/${topic._id}/revised`).send({ userQuality: 4 });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("TOPIC_NOT_FOUND");
  });
});

describe("POST /api/chat/complete", () => {
  async function createChat(topicId: Types.ObjectId) {
    return ChatSession.create({ userId: USER, topicId, questions: [{ question: "Q?", answer: "A" }], messages: [{ role: "assistant", content: "Q?" }] });
  }

  it("averages a learner 4 with an AI 0 into a 2 and records method ai_quiz", async () => {
    const topic = await createTopic();
    const chat = await createChat(topic._id);
    (assessStudentPerformance as jest.Mock).mockResolvedValue(0);

    const res = await request(app).post("/api/chat/complete").send({ sessionId: chat._id.toString(), topicId: topic._id.toString(), userQuality: 4 });

    expect(res.status).toBe(200);
    expect(res.body.finalQuality).toBe(2);
    const record = await RevisionRecord.findOne({ topicId: topic._id }).lean();
    expect(record).toMatchObject({ method: "ai_quiz", userQuality: 4, llmQuality: 0, finalQuality: 2 });
    expect((await Topic.findById(topic._id).lean())!.lastQuality).toBe(2);
  });

  it("returns the stored result when the session is completed again, writing no second record", async () => {
    const topic = await createTopic();
    const chat = await createChat(topic._id);
    (assessStudentPerformance as jest.Mock).mockResolvedValue(4);
    const body = { sessionId: chat._id.toString(), topicId: topic._id.toString(), userQuality: 4 };

    const first = await request(app).post("/api/chat/complete").send(body);
    const second = await request(app).post("/api/chat/complete").send(body);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(assessStudentPerformance).toHaveBeenCalledTimes(1);
    expect(await RevisionRecord.countDocuments({ topicId: topic._id })).toBe(1);
  });

  it("returns ALREADY_REVIEWED_TODAY when the topic was reviewed today by another path", async () => {
    const topic = await createTopic();
    await request(app).post(`/api/topics/${topic._id}/revised`).send({ userQuality: 4 });
    const chat = await createChat(topic._id);

    const res = await request(app).post("/api/chat/complete").send({ sessionId: chat._id.toString(), topicId: topic._id.toString(), userQuality: 5 });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ALREADY_REVIEWED_TODAY");
    expect(assessStudentPerformance).not.toHaveBeenCalled();
    expect(await RevisionRecord.countDocuments({ topicId: topic._id })).toBe(1);
  });
});

describe("POST /api/chat/start", () => {
  it("responds CONTENT_NOT_FOUND once and never generates questions when nothing is extracted", async () => {
    const topic = await createTopic({ urls: [{ url: "https://example.com/a", processingStatus: "pending" }] });
    (buildChatContext as jest.Mock).mockResolvedValue({ studyMaterials: new Error("Atleast one Study Material Needed") });

    const res = await request(app).post("/api/chat/start").send({ topicId: topic._id.toString() });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("CONTENT_NOT_FOUND");
    expect(generateQuestions).not.toHaveBeenCalled();
    expect(await ChatSession.countDocuments({})).toBe(0);
  });
});

describe("learner day in the due list and statistics", () => {
  // 2026-03-11T00:00Z is 20:00 EDT on 2026-03-10 and already 2026-03-11 in UTC.
  const EVENING_NY = new Date("2026-03-11T00:00:00.000Z");

  it("covers AE14: a topic reviewed at 09:00 New York time is still listed at 20:00", async () => {
    // A third successful review: the next one lands about two weeks out, so only
    // the done-today window can keep the topic in the list.
    const topic = await createTopic({ repetitionNumber: 2, interval: 6 });
    freezeDate(new Date("2026-03-10T13:00:00.000Z")); // 09:00 EDT
    const review = await request(app).post(`/api/topics/${topic._id}/revised`).set("X-Local-TimeZone", "America/New_York").send({ userQuality: 4 });
    expect(review.status).toBe(200);
    expect(review.body.interval).toBe(15);

    freezeDate(EVENING_NY);
    const ny = await request(app).get("/api/topics/due").set("X-Local-TimeZone", "America/New_York");
    const utc = await request(app).get("/api/topics/due");

    expect(ny.status).toBe(200);
    expect(ny.body.topics.map((t: { _id: string }) => t._id)).toEqual([topic._id.toString()]);
    // In UTC it is already the next day, so the morning review is not "today" there.
    expect(utc.body.topics).toHaveLength(0);
  });

  it("orders the due list most overdue first and leaves out topics due tomorrow", async () => {
    freezeDate(EVENING_NY);
    const older = await createTopic({ topicName: "Older", revisionDate: new Date("2026-03-01T00:00:00.000Z") });
    const today = await createTopic({ topicName: "Today", revisionDate: new Date("2026-03-10T22:00:00.000Z") });
    await createTopic({ topicName: "Tomorrow", revisionDate: new Date("2026-03-11T05:00:00.000Z") }); // 01:00 EDT on the 11th

    const res = await request(app).get("/api/topics/due").set("x-local-timezone", "America/New_York");

    expect(res.body.topics.map((t: { _id: string }) => t._id)).toEqual([older._id.toString(), today._id.toString()]);
  });

  it("counts topics due today in the learner's zone", async () => {
    freezeDate(EVENING_NY);
    // 05:00Z on the 11th: tomorrow in New York, but still today in UTC.
    await createTopic({ revisionDate: new Date("2026-03-11T05:00:00.000Z") });

    const ny = await request(app).get("/api/statistics").set("X-Local-TimeZone", "America/New_York");
    const utc = await request(app).get("/api/statistics");

    expect(ny.status).toBe(200);
    expect(ny.body.dueToday).toBe(0);
    expect(utc.body.dueToday).toBe(1);
  });
});
