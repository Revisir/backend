/**
 * U4 — every trigger produces one build per request, and stalled builds and
 * attachments are recovered by the sweep.
 *
 * The build itself (U3) is replaced by a stand-in that honours its save
 * contract: write only while holding the claim, record sourcedAt = claimedAt.
 */
import { Types } from "mongoose";

jest.mock("@services/questionBank", () => ({ buildQuestionBank: jest.fn() }));

import { useMongoMemoryServer } from "../test/mongo";
import { Topic } from "@models/Topic";
import { buildQuestionBank } from "@services/questionBank";
import { onAttachmentSettled, requestBankBuild } from "@services/questionBankJobs";
import { handleBankRequest, failStaleAttachments, republishStalledBanks } from "@/lambda/questionBankProcessor";
import { Publishers } from "@services/rabbitmq/index";
import { questionBankMessageSchema, type QuestionBankMessage } from "@/schemas/queue.schema";
import { ATTACHMENT_STALE_MS, QUESTION_BANK } from "@config/questionBank";

useMongoMemoryServer();

const USER = "user-1";
const publish = jest.fn();
const T0 = new Date("2026-03-10T12:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

let duringBuild: (() => Promise<void>) | null = null;
const builds: { topicId: string; claimedAt: Date; urls: string[] }[] = [];

beforeEach(() => {
  builds.length = 0;
  duringBuild = null;
  publish.mockReset().mockResolvedValue(true);
  Publishers.questionBank = { publish } as unknown as typeof Publishers.questionBank;
  (buildQuestionBank as jest.Mock).mockReset().mockImplementation(async ({ topicId, userId, claimedAt }: { topicId: string; userId: string; claimedAt: Date }) => {
    const topic = await Topic.findOne({ _id: topicId, userId }).lean();
    builds.push({ topicId, claimedAt, urls: topic!.urls.filter((u) => u.processingStatus === "completed").map((u) => u.url) });
    if (duringBuild) await duringBuild();
    const saved = await Topic.updateOne(
      { _id: topicId, userId, "questionBank.state": "building", "questionBank.claimedAt": claimedAt },
      {
        $set: {
          "questionBank.state": "ready",
          "questionBank.questions": [{ id: "q", key: "k", type: "fill_blank", prompt: "x ____", answer: "y" }],
          "questionBank.usableCount": 1,
          "questionBank.sourcedAt": claimedAt,
          "questionBank.claimedAt": null,
          "questionBank.claimRequestedAt": null,
          "questionBank.attempts": 0,
        },
      },
    );
    return { state: "ready", questionCount: 1, saved: saved.matchedCount === 1 };
  });
});

const completedUrl = (url: string, statusUpdatedAt = T0) => ({ url, processingStatus: "completed", extractedContentPath: `p/${url}`, statusUpdatedAt });

async function seedTopic(overrides: Record<string, unknown> = {}) {
  return Topic.create({ userId: USER, topicName: "Cells", subjectName: "Biology", dateStudied: T0, revisionDate: T0, ...overrides });
}

function published(): QuestionBankMessage[] {
  return publish.mock.calls.map((call) => call[0].message);
}

async function bankOf(id: Types.ObjectId) {
  return (await Topic.findById(id).select("+questionBank.questions").lean())!.questionBank;
}

describe("settle trigger", () => {
  it("publishes nothing while a URL is still pending, and once when the last attachment settles", async () => {
    const topic = await seedTopic({
      files: [{ fileName: "a.pdf", fileType: "pdf", s3Path: "k", s3Bucket: "b", processingStatus: "completed", extractedContentUrl: "e", statusUpdatedAt: at(1) }],
      urls: [{ url: "https://a.example", processingStatus: "pending", statusUpdatedAt: at(0) }],
    });

    expect(await onAttachmentSettled(topic._id.toString(), USER, at(2))).toBe(false);
    expect(publish).not.toHaveBeenCalled();

    await Topic.updateOne({ _id: topic._id }, { $set: { "urls.0.processingStatus": "completed", "urls.0.statusUpdatedAt": at(3) } });
    expect(await onAttachmentSettled(topic._id.toString(), USER, at(4))).toBe(true);

    expect(published()).toEqual([{ topicId: topic._id.toString(), userId: USER, requestedAt: at(4).toISOString(), reason: "materials_settled" }]);
    expect((await bankOf(topic._id)).state).toBe("queued");
  });

  it("publishes nothing when every attachment failed", async () => {
    const topic = await seedTopic({ urls: [{ url: "https://a.example", processingStatus: "failed" }] });
    expect(await onAttachmentSettled(topic._id.toString(), USER, at(1))).toBe(false);
    expect(publish).not.toHaveBeenCalled();
  });

  it("publishes nothing when no material completed since the last successful build", async () => {
    const topic = await seedTopic({
      urls: [completedUrl("https://a.example", at(0)), { url: "https://b.example", processingStatus: "failed", statusUpdatedAt: at(5) }],
      questionBank: { state: "ready", usableCount: 4, sourcedAt: at(2) },
    });
    expect(await onAttachmentSettled(topic._id.toString(), USER, at(6))).toBe(false);
  });
});

describe("claim protocol", () => {
  async function request(topicId: Types.ObjectId, now: Date, reason: QuestionBankMessage["reason"] = "materials_settled") {
    await requestBankBuild({ topicId: topicId.toString(), userId: USER, reason, now });
    return published().at(-1)!;
  }

  it("builds a queued request and records the claim as sourcedAt", async () => {
    const topic = await seedTopic({ urls: [completedUrl("https://a.example")] });
    const message = await request(topic._id, at(1));

    expect(await handleBankRequest(message, at(2))).toBe("ack");

    expect(builds).toHaveLength(1);
    const bank = await bankOf(topic._id);
    expect(bank.state).toBe("ready");
    expect(bank.sourcedAt!.toISOString()).toBe(at(2).toISOString());
  });

  it("skips a message requested before the last successful build's claim", async () => {
    const topic = await seedTopic({ urls: [completedUrl("https://a.example")] });
    const early = await request(topic._id, at(1));
    const later = await request(topic._id, at(2));

    await handleBankRequest(later, at(3));
    expect(await handleBankRequest(early, at(4))).toBe("ack");

    expect(builds).toHaveLength(1);
  });

  it("covers a material change landing mid-build with exactly one follow-up build that includes it", async () => {
    const topic = await seedTopic({ urls: [completedUrl("https://a.example"), { url: "https://b.example", processingStatus: "processing" }] });
    const first = await request(topic._id, at(1));
    duringBuild = async () => {
      duringBuild = null;
      await Topic.updateOne({ _id: topic._id }, { $set: { "urls.1.processingStatus": "completed", "urls.1.statusUpdatedAt": at(3) } });
      const second = await request(topic._id, at(3));
      // The second request finds the first build running: it only raises requestedAt.
      expect(await handleBankRequest(second, at(3))).toBe("ack");
    };

    await handleBankRequest(first, at(2));

    const followUps = published().filter((m) => m.reason === "follow_up");
    expect(followUps).toHaveLength(1);
    expect(followUps[0].requestedAt).toBe(at(3).toISOString());
    expect((await bankOf(topic._id)).state).toBe("queued");

    await handleBankRequest(followUps[0], at(5));

    expect(builds.map((b) => b.urls)).toEqual([["https://a.example"], ["https://a.example", "https://b.example"]]);
    expect(published().filter((m) => m.reason === "follow_up")).toHaveLength(1);
  });

  it("lets a message redelivered after a crash mid-build take over its own claim", async () => {
    const topic = await seedTopic({ urls: [completedUrl("https://a.example")] });
    const message = await request(topic._id, at(1));
    // The first delivery claimed the topic, then the worker died.
    await Topic.updateOne({ _id: topic._id }, { $set: { "questionBank.state": "building", "questionBank.claimedAt": at(2), "questionBank.claimRequestedAt": at(1) } });

    expect(await handleBankRequest(message, at(4))).toBe("ack");

    expect(builds).toHaveLength(1);
    expect((await bankOf(topic._id)).state).toBe("ready");
  });

  it("reclaims a building claim older than the stale timeout, but not a fresh one", async () => {
    const topic = await seedTopic({ urls: [completedUrl("https://a.example")] });
    await Topic.updateOne({ _id: topic._id }, { $set: { "questionBank.state": "building", "questionBank.claimedAt": at(0), "questionBank.claimRequestedAt": at(-1) } });
    const message: QuestionBankMessage = { topicId: topic._id.toString(), userId: USER, requestedAt: at(1).toISOString(), reason: "regenerate" };

    await handleBankRequest(message, at(5));
    expect(builds).toHaveLength(0);
    expect((await bankOf(topic._id)).requestedAt!.toISOString()).toBe(at(1).toISOString());

    const staleMinutes = QUESTION_BANK.STALE_CLAIM_MS / 60_000 + 1;
    await handleBankRequest(message, at(staleMinutes));
    expect(builds).toHaveLength(1);
  });

  it("keeps the previous questions readable while a rebuild is queued or building (AE11, service half)", async () => {
    const topic = await seedTopic({
      urls: [completedUrl("https://a.example")],
      questionBank: { state: "ready", usableCount: 15, questions: Array.from({ length: 15 }, (_, i) => ({ id: `q${i}`, key: `k${i}`, type: "fill_blank", prompt: `${i} ____`, answer: "a" })) },
    });

    await requestBankBuild({ topicId: topic._id.toString(), userId: USER, reason: "regenerate", now: at(1) });
    let bank = await bankOf(topic._id);
    expect(bank).toMatchObject({ state: "queued", usableCount: 15 });
    expect(bank.questions).toHaveLength(15);

    duringBuild = async () => {
      bank = await bankOf(topic._id);
    };
    await handleBankRequest(published()[0], at(2));
    expect(bank).toMatchObject({ state: "building", usableCount: 15 });
    expect(bank.questions).toHaveLength(15);
  });

  it("acks a request for a topic that no longer exists, rejects a malformed id, and requeues on a database error", async () => {
    const gone: QuestionBankMessage = { topicId: new Types.ObjectId().toString(), userId: USER, requestedAt: at(1).toISOString(), reason: "backfill" };
    expect(await handleBankRequest(gone, at(2))).toBe("ack");
    expect(await handleBankRequest({ ...gone, topicId: "not-an-id" }, at(2))).toBe("nack_reject");

    const spy = jest.spyOn(Topic, "findOne").mockImplementationOnce(() => {
      throw new Error("MongoNetworkError: connection reset");
    });
    expect(await handleBankRequest(gone, at(2))).toBe("nack_requeue");
    spy.mockRestore();
  });

  it("rejects malformed messages at the schema, which sends them to the DLQ", () => {
    expect(questionBankMessageSchema.safeParse({ topicId: "t", userId: "u", requestedAt: "yesterday", reason: "regenerate" }).success).toBe(false);
    expect(questionBankMessageSchema.safeParse({ topicId: "t", userId: "u", requestedAt: at(0).toISOString(), reason: "because" }).success).toBe(false);
    expect(questionBankMessageSchema.safeParse({ topicId: "t", userId: "u", requestedAt: at(0).toISOString(), reason: "regenerate" }).success).toBe(true);
  });
});

describe("sweep", () => {
  const staleClaim = QUESTION_BANK.STALE_CLAIM_MS / 60_000;
  /** The `question_bank` queue holds no ready messages: a queued bank's message was lost. */
  const queueEmpty = async () => 0;
  const passesAfter = (start: Date, passes: number) => Array.from({ length: passes }, (_, i) => new Date(start.getTime() + (i + 1) * (staleClaim + 1) * 60_000));

  async function queuedAt(now: Date) {
    const topic = await seedTopic({ urls: [completedUrl("https://a.example")] });
    await requestBankBuild({ topicId: topic._id.toString(), userId: USER, reason: "backfill", now });
    publish.mockClear();
    return topic;
  }

  it("republishes a bank left queued by a lost publish, and marks it failed at the attempt cap", async () => {
    const topic = await seedTopic({ urls: [completedUrl("https://a.example")] });
    publish.mockResolvedValueOnce(false);
    await requestBankBuild({ topicId: topic._id.toString(), userId: USER, reason: "materials_settled", now: at(0) });
    expect((await bankOf(topic._id)).state).toBe("queued");

    let now = at(0);
    for (let attempt = 1; attempt <= QUESTION_BANK.SWEEP_MAX_ATTEMPTS; attempt++) {
      now = new Date(now.getTime() + (staleClaim + 1) * 60_000);
      expect(await republishStalledBanks(queueEmpty, now)).toEqual({ republished: 1, failed: 0 });
      expect((await bankOf(topic._id)).attempts).toBe(attempt);
    }
    expect(published().filter((m) => m.reason === "sweep")).toHaveLength(QUESTION_BANK.SWEEP_MAX_ATTEMPTS);

    now = new Date(now.getTime() + (staleClaim + 1) * 60_000);
    expect(await republishStalledBanks(queueEmpty, now)).toEqual({ republished: 0, failed: 1 });
    expect(await bankOf(topic._id)).toMatchObject({ state: "failed", errorCode: "BUILD_STALLED" });
  });

  it("leaves a recently queued bank alone", async () => {
    const topic = await seedTopic({ urls: [completedUrl("https://a.example")] });
    await requestBankBuild({ topicId: topic._id.toString(), userId: USER, reason: "materials_settled", now: at(0) });
    expect(await republishStalledBanks(queueEmpty, at(1))).toEqual({ republished: 0, failed: 0 });
  });

  it("leaves a stale queued bank alone while the queue still has ready messages, past the attempt cap", async () => {
    const topic = await queuedAt(at(0));
    const backlog = jest.fn(async () => 3);

    for (const now of passesAfter(at(0), QUESTION_BANK.SWEEP_MAX_ATTEMPTS + 2)) {
      expect(await republishStalledBanks(backlog, now)).toEqual({ republished: 0, failed: 0 });
    }

    expect(backlog).toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(await bankOf(topic._id)).toMatchObject({ state: "queued", attempts: 0, requestedAt: at(0) });
  });

  it("republishes a stale queued bank once the queue has no ready messages", async () => {
    const topic = await queuedAt(at(0));

    expect(await republishStalledBanks(queueEmpty, at(staleClaim + 1))).toEqual({ republished: 1, failed: 0 });

    expect(published().map((m) => [m.topicId, m.reason])).toEqual([[topic._id.toString(), "sweep"]]);
    expect(await bankOf(topic._id)).toMatchObject({ state: "queued", attempts: 1 });
  });

  it("skips queued banks when the queue cannot be checked, but still republishes an abandoned building claim", async () => {
    const queued = await queuedAt(at(0));
    const building = await seedTopic({ urls: [completedUrl("https://b.example")], questionBank: { state: "building", claimedAt: at(0), claimRequestedAt: at(-1), requestedAt: at(-1), attempts: 0 } });
    const unreachable = async (): Promise<number> => {
      throw new Error("RabbitMQ channel is not available. Call connect() first.");
    };

    expect(await republishStalledBanks(unreachable, at(staleClaim + 1))).toEqual({ republished: 1, failed: 0 });

    expect(published().map((m) => m.topicId)).toEqual([building._id.toString()]);
    expect(await bankOf(queued._id)).toMatchObject({ state: "queued", attempts: 0 });
  });

  it("republishes an abandoned building claim without releasing it, and the request takes the claim over", async () => {
    const topic = await seedTopic({ urls: [completedUrl("https://a.example")], questionBank: { state: "building", claimedAt: at(0), claimRequestedAt: at(-1), requestedAt: at(-1) } });

    await republishStalledBanks(queueEmpty, at(staleClaim + 1));

    // The stale claim stays as it is; the republished request reclaims it on arrival.
    expect(await bankOf(topic._id)).toMatchObject({ state: "building", claimedAt: at(0), attempts: 1 });
    const message = published().at(-1)!;
    expect(message.reason).toBe("sweep");
    await handleBankRequest(message, at(staleClaim + 2));
    expect((await bankOf(topic._id)).state).toBe("ready");
  });

  it("fails attachments past the staleness window and builds the topic once nothing else is unsettled", async () => {
    const topic = await seedTopic({
      urls: [completedUrl("https://a.example", at(0)), { url: "https://b.example", processingStatus: "pending", statusUpdatedAt: at(0) }],
      // A legacy entry: no statusUpdatedAt, so its age comes from its _id.
      files: [{ _id: Types.ObjectId.createFromTime(Math.floor(at(0).getTime() / 1000)), fileName: "never-uploaded.pdf", fileType: "pdf", s3Path: "k", s3Bucket: "b", processingStatus: "pending" }],
    });
    const staleMinutes = ATTACHMENT_STALE_MS / 60_000 + 5;

    expect(await failStaleAttachments(at(10))).toBe(0);
    expect(publish).not.toHaveBeenCalled();

    expect(await failStaleAttachments(at(staleMinutes))).toBe(1);

    const after = await Topic.findById(topic._id).lean();
    expect(after!.urls[1]).toMatchObject({ processingStatus: "failed", errorReason: "Processing timed out" });
    expect(after!.files[0]).toMatchObject({ processingStatus: "failed", errorReason: "Processing timed out" });
    expect(after!.urls[0].processingStatus).toBe("completed");
    expect(published().map((m) => m.reason)).toEqual(["materials_settled"]);

    // A second pass finds nothing left to fail.
    expect(await failStaleAttachments(at(staleMinutes + 10))).toBe(0);
  });
});
