/**
 * U7 — the launch repair gives existing topics truthful attachment status, a
 * last rating and a queued bank build, is idempotent, and writes nothing in a
 * dry run.
 */
import { Types } from "mongoose";
import { useMongoMemoryServer } from "../test/mongo";
import { Topic } from "@models/Topic";
import { RevisionRecord } from "@models/RevisionRecord";
import { runLaunchRepair, type RepairDeps } from "@services/launchRepair";
import { extractedKeyForFile, extractedKeyForUrl } from "@services/uploadKey";
import { STALE_ATTACHMENT_REASON } from "@services/attachments";

useMongoMemoryServer();

const BUCKET = "revision-study-content";
const USER = "user-1";
const NOW = new Date("2026-10-20T12:00:00.000Z");
const LONG_AGO = new Date("2026-05-01T00:00:00.000Z");
const oldId = () => Types.ObjectId.createFromTime(Math.floor(LONG_AGO.getTime() / 1000));

/** In-memory storage and queues. */
function fakeDeps(objects: Record<string, string>) {
  const calls = { files: [] as string[], urls: [] as { topicId: string; urls: string[] }[], banks: [] as string[] };
  const deps: RepairDeps = {
    listObjects: async (prefix) => Object.keys(objects).filter((k) => k.startsWith(prefix)).map((key) => ({ key, size: 10 })),
    contentTypeOf: async (key) => objects[key],
    publishFile: async (key) => {
      calls.files.push(key);
      return true;
    },
    publishUrls: async (topicId, _userId, urls) => {
      calls.urls.push({ topicId, urls });
      return true;
    },
    queueBankBuild: async (topicId) => {
      calls.banks.push(topicId);
    },
  };
  return { deps, calls };
}

async function seedTopic(overrides: Record<string, unknown> = {}) {
  return Topic.create({ userId: USER, topicName: "T", subjectName: "S", dateStudied: LONG_AGO, revisionDate: new Date("2026-10-25T00:00:00.000Z"), ...overrides });
}

const run = (deps: RepairDeps, dryRun = false) => runLaunchRepair({ dryRun, bucket: BUCKET, deps, now: NOW });

async function snapshot() {
  return JSON.stringify(await Topic.find({}).sort({ _id: 1 }).select("+questionBank.questions").lean());
}

describe("runLaunchRepair", () => {
  it("creates missing file entries: completed where the extracted object exists, pending and republished where not", async () => {
    const topic = await seedTopic();
    const id = topic._id.toString();
    const done = `${USER}/${id}/files/done.pdf`;
    const waiting = `${USER}/${id}/files/waiting.png`;
    const { deps, calls } = fakeDeps({ [done]: "application/pdf", [waiting]: "image/png", [extractedKeyForFile(USER, id, "done.pdf")]: "text/plain" });

    const report = await run(deps);

    const files = (await Topic.findById(id).lean())!.files;
    expect(files.map((f) => [f.fileName, f.fileType, f.processingStatus, f.extractedContentUrl ?? null, f.s3Bucket])).toEqual([
      ["done.pdf", "pdf", "completed", extractedKeyForFile(USER, id, "done.pdf"), BUCKET],
      ["waiting.png", "image", "pending", null, BUCKET],
    ]);
    expect(calls.files).toEqual([waiting]);
    expect(report).toMatchObject({ fileEntriesCreated: 2, filesRepublished: 1 });
    // A republished attachment builds the bank when it settles, not now.
    expect(calls.banks).toEqual([]);
  });

  it("completes a URL stuck in pending when its extracted object exists, and republishes the rest", async () => {
    const topic = await seedTopic({
      urls: [
        { _id: oldId(), url: "https://a.example/x", processingStatus: "pending" },
        { _id: oldId(), url: "https://b.example/y", processingStatus: "pending" },
        { _id: oldId(), url: "https://c.example/z", processingStatus: "failed", errorReason: STALE_ATTACHMENT_REASON },
        { _id: oldId(), url: "https://d.example/w", processingStatus: "failed", errorReason: "404 Not Found" },
      ],
    });
    const id = topic._id.toString();
    const { deps, calls } = fakeDeps({ [extractedKeyForUrl(USER, id, "https://a.example/x")]: "text/plain", [extractedKeyForUrl(USER, id, "https://c.example/z")]: "text/plain" });

    await run(deps);

    const urls = (await Topic.findById(id).lean())!.urls;
    expect(urls.map((u) => [u.url, u.processingStatus, u.extractedContentPath ?? null])).toEqual([
      ["https://a.example/x", "completed", extractedKeyForUrl(USER, id, "https://a.example/x")],
      ["https://b.example/y", "pending", null],
      ["https://c.example/z", "completed", extractedKeyForUrl(USER, id, "https://c.example/z")],
      ["https://d.example/w", "failed", null],
    ]);
    expect(urls[1].statusUpdatedAt!.toISOString()).toBe(NOW.toISOString());
    expect(calls.urls).toEqual([{ topicId: id, urls: ["https://b.example/y"] }]);
  });

  it("backfills lastQuality from the latest revision, including half ratings, and never overwrites one", async () => {
    const withHalf = await seedTopic();
    const alreadySet = await seedTopic({ lastQuality: 2 });
    for (const [topicId, finalQuality, day] of [
      [withHalf._id, 4, 1],
      [withHalf._id, 3.5, 2],
      [alreadySet._id, 5, 2],
    ] as const) {
      await RevisionRecord.create({ userId: USER, topicId, revisionDate: new Date(Date.UTC(2026, 9, day)), userQuality: 4, llmQuality: 3, finalQuality, newEFactor: 2.5, newInterval: 1, nextRevisionDate: new Date() });
    }

    const report = await run(fakeDeps({}).deps);

    expect((await Topic.findById(withHalf._id).lean())!.lastQuality).toBe(3.5);
    expect((await Topic.findById(alreadySet._id).lean())!.lastQuality).toBe(2);
    expect(report.lastQualityBackfilled).toBe(1);
  });

  it("queues bank builds for topics with completed material and no bank, due first", async () => {
    const material = (url: string) => ({ url, processingStatus: "completed", extractedContentPath: `${USER}/x/extracted/${url.length}.md`, statusUpdatedAt: LONG_AGO });
    const later = await seedTopic({ topicName: "Later", revisionDate: new Date("2026-11-30T00:00:00.000Z"), urls: [material("https://later.example")] });
    const overdue = await seedTopic({ topicName: "Overdue", revisionDate: new Date("2026-09-01T00:00:00.000Z"), urls: [material("https://overdue.example")] });
    await seedTopic({ topicName: "Has bank", urls: [material("https://bank.example")], questionBank: { state: "ready", usableCount: 9 } });
    await seedTopic({ topicName: "No material" });
    await seedTopic({ topicName: "Only failed", urls: [{ url: "https://f.example", processingStatus: "failed", errorReason: "boom" }] });

    const { deps, calls } = fakeDeps({});
    const report = await run(deps);

    expect(calls.banks).toEqual([overdue._id.toString(), later._id.toString()]);
    expect(report.bankBuildsQueued).toBe(2);
  });

  it("changes nothing on a second run", async () => {
    const topic = await seedTopic({
      urls: [
        { _id: oldId(), url: "https://a.example/x", processingStatus: "pending" },
        { _id: oldId(), url: "https://b.example/y", processingStatus: "pending" },
      ],
    });
    const id = topic._id.toString();
    await RevisionRecord.create({ userId: USER, topicId: topic._id, revisionDate: LONG_AGO, userQuality: 4, llmQuality: 4, finalQuality: 4, newEFactor: 2.5, newInterval: 1, nextRevisionDate: new Date() });
    const objects = { [`${USER}/${id}/files/notes.pdf`]: "application/pdf", [extractedKeyForUrl(USER, id, "https://a.example/x")]: "text/plain" };

    // queueBankBuild here stands in for requestBankBuild, which marks the bank queued.
    const first = fakeDeps(objects);
    first.deps.queueBankBuild = async (topicId) => {
      await Topic.updateOne({ _id: topicId }, { $set: { "questionBank.state": "queued" } });
    };
    await run(first.deps);
    const afterFirst = await snapshot();

    const second = fakeDeps(objects);
    const report = await run(second.deps);

    expect(await snapshot()).toBe(afterFirst);
    expect(report).toMatchObject({ topicsChanged: 0, fileEntriesCreated: 0, urlsRepublished: 0, filesRepublished: 0, lastQualityBackfilled: 0, bankBuildsQueued: 0 });
    expect(second.calls).toEqual({ files: [], urls: [], banks: [] });
  });

  it("writes and publishes nothing in a dry run, and reports the same plan a real run makes", async () => {
    const topic = await seedTopic({ urls: [{ _id: oldId(), url: "https://a.example/x", processingStatus: "pending" }] });
    const id = topic._id.toString();
    await RevisionRecord.create({ userId: USER, topicId: topic._id, revisionDate: LONG_AGO, userQuality: 4, llmQuality: 4, finalQuality: 4, newEFactor: 2.5, newInterval: 1, nextRevisionDate: new Date() });
    const objects = { [`${USER}/${id}/files/notes.pdf`]: "application/pdf", [extractedKeyForFile(USER, id, "notes.pdf")]: "text/plain" };
    const before = await snapshot();

    const dry = fakeDeps(objects);
    const dryReport = await run(dry.deps, true);

    expect(await snapshot()).toBe(before);
    expect(dry.calls).toEqual({ files: [], urls: [], banks: [] });
    expect(dryReport).toMatchObject({ dryRun: true, topicsChanged: 1, fileEntriesCreated: 1, urlsRepublished: 1, lastQualityBackfilled: 1 });

    const real = fakeDeps(objects);
    const realReport = await run(real.deps);
    const { dryRun: _a, ...dryRest } = dryReport;
    const { dryRun: _b, ...realRest } = realReport;
    expect(realRest).toEqual(dryRest);
  });

  it("never deletes entries, and leaves fresh in-flight attachments alone", async () => {
    const topic = await seedTopic({
      files: [{ fileName: "kept.pdf", fileType: "pdf", s3Path: `${USER}/whatever/files/kept.pdf`, s3Bucket: BUCKET, processingStatus: "processing", statusUpdatedAt: new Date(NOW.getTime() - 60_000) }],
      urls: [{ url: "https://fresh.example", processingStatus: "pending", statusUpdatedAt: new Date(NOW.getTime() - 60_000) }],
    });
    const { deps, calls } = fakeDeps({});

    const report = await run(deps);

    const after = (await Topic.findById(topic._id).lean())!;
    expect(after.files).toHaveLength(1);
    expect(after.files[0].processingStatus).toBe("processing");
    expect(after.urls[0].processingStatus).toBe("pending");
    expect(report.topicsChanged).toBe(0);
    expect(calls).toEqual({ files: [], urls: [], banks: [] });
  });

  it("counts a topic whose storage listing fails, and still repairs the others and queues their bank builds", async () => {
    // Created first, so a run that is not isolated per topic stops before the others.
    const broken = await seedTopic({ topicName: "Broken", urls: [{ url: "https://broken.example", processingStatus: "completed", extractedContentPath: "p", statusUpdatedAt: LONG_AGO }] });
    const fine = await seedTopic({ topicName: "Fine", urls: [{ _id: oldId(), url: "https://a.example/x", processingStatus: "pending" }] });
    const fineId = fine._id.toString();
    const { deps, calls } = fakeDeps({ [extractedKeyForUrl(USER, fineId, "https://a.example/x")]: "text/plain" });
    const list = deps.listObjects;
    deps.listObjects = async (prefix) => {
      if (prefix.includes(broken._id.toString())) throw new Error("SlowDown: Please reduce your request rate.");
      return list(prefix);
    };

    const report = await run(deps);

    expect(report).toMatchObject({ topicsScanned: 2, topicsFailed: 1, topicsChanged: 1, urlsCompleted: 1, bankBuildsQueued: 1 });
    expect(report.plans.map((p) => p.topicId)).toEqual([fineId]);
    expect((await Topic.findById(fineId).lean())!.urls[0].processingStatus).toBe("completed");
    expect(calls.banks).toEqual([fineId]);
  });

  it("counts a topic whose bank build cannot be queued, and still queues the rest", async () => {
    const material = (url: string) => ({ url, processingStatus: "completed", extractedContentPath: "p", statusUpdatedAt: LONG_AGO });
    const first = await seedTopic({ revisionDate: new Date("2026-09-01T00:00:00.000Z"), urls: [material("https://first.example")] });
    const second = await seedTopic({ revisionDate: new Date("2026-09-02T00:00:00.000Z"), urls: [material("https://second.example")] });
    const { deps, calls } = fakeDeps({});
    deps.queueBankBuild = async (topicId) => {
      if (topicId === first._id.toString()) throw new Error("MongoNetworkError: connection reset");
      calls.banks.push(topicId);
    };

    const report = await run(deps);

    expect(report).toMatchObject({ topicsFailed: 1, bankBuildsQueued: 1 });
    expect(calls.banks).toEqual([second._id.toString()]);
  });

  it("does not overwrite an entry a worker settled between planning and applying", async () => {
    const topic = await seedTopic({
      urls: [
        { _id: oldId(), url: "https://a.example/x", processingStatus: "pending" },
        { _id: oldId(), url: "https://b.example/y", processingStatus: "pending" },
      ],
    });
    const id = topic._id.toString();
    const toComplete = `${USER}/${id}/files/done.pdf`;
    const toRepublish = `${USER}/${id}/files/waiting.pdf`;
    await Topic.updateOne(
      { _id: topic._id },
      { $push: { files: { $each: [toComplete, toRepublish].map((s3Path) => ({ _id: oldId(), fileName: s3Path.split("/").at(-1), fileType: "pdf", s3Path, s3Bucket: BUCKET, processingStatus: "pending" })) } } },
    );
    const objects = {
      [toComplete]: "application/pdf",
      [toRepublish]: "application/pdf",
      [extractedKeyForFile(USER, id, "done.pdf")]: "text/plain",
      [extractedKeyForUrl(USER, id, "https://a.example/x")]: "text/plain",
    };
    const { deps, calls } = fakeDeps(objects);
    // The run has read the topic; workers settle every entry before the repair is applied.
    const WORKER_AT = new Date(NOW.getTime() - 1_000);
    const list = deps.listObjects;
    deps.listObjects = async (prefix) => {
      await Topic.updateOne(
        { _id: topic._id },
        {
          $set: {
            "urls.0.processingStatus": "completed",
            "urls.0.extractedContentPath": "worker/a.md",
            "urls.0.statusUpdatedAt": WORKER_AT,
            "urls.1.processingStatus": "completed",
            "urls.1.extractedContentPath": "worker/b.md",
            "urls.1.statusUpdatedAt": WORKER_AT,
            "files.0.processingStatus": "failed",
            "files.0.errorReason": "Unsupported file contents",
            "files.0.statusUpdatedAt": WORKER_AT,
            "files.1.processingStatus": "completed",
            "files.1.extractedContentUrl": "worker/waiting.md",
            "files.1.statusUpdatedAt": WORKER_AT,
          },
        },
      );
      return list(prefix);
    };

    const report = await run(deps);

    // The plan was made from the stale read...
    expect(report).toMatchObject({ filesCompleted: 1, filesRepublished: 1, urlsCompleted: 1, urlsRepublished: 1 });
    // ...but no write landed on an entry that had settled since, and nothing was republished.
    const after = (await Topic.findById(id).lean())!;
    expect(after.urls.map((u) => [u.processingStatus, u.extractedContentPath, u.statusUpdatedAt?.toISOString()])).toEqual([
      ["completed", "worker/a.md", WORKER_AT.toISOString()],
      ["completed", "worker/b.md", WORKER_AT.toISOString()],
    ]);
    expect(after.files.map((f) => [f.processingStatus, f.errorReason ?? null, f.extractedContentUrl ?? null, f.statusUpdatedAt?.toISOString()])).toEqual([
      ["failed", "Unsupported file contents", null, WORKER_AT.toISOString()],
      ["completed", null, "worker/waiting.md", WORKER_AT.toISOString()],
    ]);
    expect(calls.files).toEqual([]);
    expect(calls.urls).toEqual([]);
  });

  it("limits the run to one user when asked", async () => {
    await seedTopic({ userId: "someone-else", urls: [{ url: "https://a.example", processingStatus: "completed", extractedContentPath: "p" }] });
    const mine = await seedTopic({ urls: [{ url: "https://b.example", processingStatus: "completed", extractedContentPath: "q" }] });
    const { deps, calls } = fakeDeps({});

    await runLaunchRepair({ dryRun: false, bucket: BUCKET, deps, userId: USER, now: NOW });

    expect(calls.banks).toEqual([mine._id.toString()]);
  });
});
