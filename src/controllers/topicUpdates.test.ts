/**
 * U2 — attachments keep a truthful status from the moment they are declared,
 * URL saves only touch what changed, and topic edits keep their history.
 */
import request from "supertest";
import { Types } from "mongoose";

jest.mock("@services/s3Storage", () => ({
  generatePresignedUploadUrl: jest.fn(async (userId: string, topicId: string, fileName: string) => `https://upload.example/${userId}/${topicId}/files/${fileName}`),
  getSignedContentUrl: jest.fn(async (path: string) => `https://signed.example/${path}`),
  deleteByPath: jest.fn(),
  deleteFile: jest.fn(),
  deleteTopicFiles: jest.fn(),
}));

import { useMongoMemoryServer, buildTestApp } from "../test/mongo";
import topicRoutes from "@routes/topicRoutes";
import { Topic } from "@models/Topic";
import { RevisionRecord } from "@models/RevisionRecord";
import { Publishers } from "@services/rabbitmq/index";
import { deleteByPath, deleteFile, generatePresignedUploadUrl } from "@services/s3Storage";

useMongoMemoryServer();

const app = buildTestApp({ "/api/topics": topicRoutes });
const USER = "user-1";
const publish = jest.fn();

beforeEach(() => {
  publish.mockReset().mockResolvedValue(true);
  Publishers.url = { publish } as unknown as typeof Publishers.url;
});

afterEach(() => jest.clearAllMocks());

function newTopic(body: Record<string, unknown> = {}) {
  return request(app)
    .post("/api/topics")
    .send({ topicName: "Cells", subjectName: "Biology", dateStudied: "2026-01-15", ...body });
}

async function seedTopic(overrides: Record<string, unknown> = {}) {
  return Topic.create({
    userId: USER,
    topicName: "Cells",
    subjectName: "Biology",
    dateStudied: new Date("2026-01-15T00:00:00.000Z"),
    revisionDate: new Date("2026-02-01T00:00:00.000Z"),
    eFactor: 2.36,
    repetitionNumber: 3,
    interval: 15,
    lastRevised: new Date("2026-01-17T10:00:00.000Z"),
    lastQuality: 4,
    ...overrides,
  });
}

async function seedHistory(topicId: Types.ObjectId, count: number) {
  for (let i = 0; i < count; i++) {
    await RevisionRecord.create({ userId: USER, topicId, revisionDate: new Date(Date.UTC(2026, 0, 16 + i)), userQuality: 4, llmQuality: 4, finalQuality: 4, newEFactor: 2.5, newInterval: 1, nextRevisionDate: new Date(Date.UTC(2026, 0, 17 + i)) });
  }
}

describe("POST /api/topics — declared attachments", () => {
  it("covers AE16 (entry half): creates a pending entry per declared file, keyed by its storage path", async () => {
    const res = await newTopic({
      files: [
        { fileName: "notes.pdf", size: 1000, contentType: "application/pdf" },
        { fileName: "diagram.png", size: 500, contentType: "image/png" },
      ],
    });

    expect(res.status).toBe(201);
    expect(res.body.uploadUrls).toHaveLength(2);
    const topic = await Topic.findById(res.body.topicId).lean();
    expect(topic!.files).toHaveLength(2);
    expect(topic!.files.map((f) => ({ fileName: f.fileName, fileType: f.fileType, s3Path: f.s3Path, processingStatus: f.processingStatus, size: f.size }))).toEqual([
      { fileName: "notes.pdf", fileType: "pdf", s3Path: `${USER}/${res.body.topicId}/files/notes.pdf`, processingStatus: "pending", size: 1000 },
      { fileName: "diagram.png", fileType: "image", s3Path: `${USER}/${res.body.topicId}/files/diagram.png`, processingStatus: "pending", size: 500 },
    ]);
    topic!.files.forEach((f) => expect(f.statusUpdatedAt).toBeInstanceOf(Date));
  });

  it("saves nothing when a declared file is rejected", async () => {
    const issueUrl = jest.mocked(generatePresignedUploadUrl);
    const defaultIssue = issueUrl.getMockImplementation()!;
    issueUrl.mockImplementation(async (userId, topicId, fileName, contentType, size) => {
      if (fileName.includes("..")) throw new Error("S3 path contains invalid characters or patterns");
      return defaultIssue(userId, topicId, fileName, contentType, size);
    });

    try {
      const res = await newTopic({
        urls: ["https://example.com/a"],
        files: [
          { fileName: "notes.pdf", size: 1000, contentType: "application/pdf" },
          { fileName: "notes..v2.pdf", size: 1000, contentType: "application/pdf" },
        ],
      });

      expect(res.status).toBe(500);
      expect(await Topic.countDocuments()).toBe(0);
      expect(publish).not.toHaveBeenCalled();
    } finally {
      issueUrl.mockImplementation(defaultIssue);
    }
  });

  it("saves a URL that cannot be extracted as failed with a reason, and publishes only the rest", async () => {
    const res = await newTopic({ urls: ["https://example.com/a", "ftp://example.com/b"] });

    expect(res.status).toBe(201);
    const topic = await Topic.findById(res.body.topicId).lean();
    const byUrl = Object.fromEntries(topic!.urls.map((u) => [u.url, u]));
    expect(byUrl["https://example.com/a"].processingStatus).toBe("pending");
    expect(byUrl["ftp://example.com/b"].processingStatus).toBe("failed");
    expect(byUrl["ftp://example.com/b"].errorReason).toMatch(/http/i);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0].message.urls).toEqual(["https://example.com/a"]);
  });

  it("saves URLs as failed when they cannot be queued, and still returns 201", async () => {
    publish.mockResolvedValue(false);

    const res = await newTopic({ urls: ["https://example.com/a"] });

    expect(res.status).toBe(201);
    const topic = await Topic.findById(res.body.topicId).lean();
    expect(topic!.urls[0].processingStatus).toBe("failed");
    expect(topic!.urls[0].errorReason).toMatch(/queue/i);
  });
});

describe("POST /api/topics/:id/files", () => {
  it("creates pending entries, and a re-upload under the same name resets the entry instead of duplicating it", async () => {
    const topic = await seedTopic();
    const key = `${USER}/${topic._id}/files/notes.pdf`;
    await Topic.updateOne({ _id: topic._id }, { $push: { files: { fileName: "notes.pdf", fileType: "pdf", s3Path: key, s3Bucket: "b", processingStatus: "failed", errorReason: "boom" } } });

    const res = await request(app)
      .post(`/api/topics/${topic._id}/files`)
      .send({ files: [{ fileName: "notes.pdf", size: 2000, contentType: "application/pdf" }, { fileName: "more.txt", size: 10, contentType: "text/plain" }] });

    expect(res.status).toBe(200);
    expect(res.body.uploadUrls).toHaveLength(2);
    const after = await Topic.findById(topic._id).lean();
    expect(after!.files).toHaveLength(2);
    const notes = after!.files.find((f) => f.fileName === "notes.pdf")!;
    expect(notes).toMatchObject({ processingStatus: "pending", errorReason: null, size: 2000 });
    expect(after!.files.find((f) => f.fileName === "more.txt")).toMatchObject({ processingStatus: "pending", fileType: "text" });
  });

  it("deletes a file entry created at upload instead of returning FILE_NOT_FOUND", async () => {
    const topic = await seedTopic();
    await request(app).post(`/api/topics/${topic._id}/files`).send({ files: [{ fileName: "notes.pdf", size: 2000, contentType: "application/pdf" }] });
    const fileId = (await Topic.findById(topic._id).lean())!.files[0]._id!.toString();

    const res = await request(app).delete(`/api/topics/${topic._id}/files/${fileId}`);

    expect(res.status).toBe(200);
    expect(deleteFile).toHaveBeenCalledWith(USER, topic._id.toString(), "notes.pdf");
    expect((await Topic.findById(topic._id).lean())!.files).toHaveLength(0);
  });
});

describe("PATCH /api/topics/:id — URL list", () => {
  const extracted = (url: string, path: string) => ({ url, processingStatus: "completed", extractedContentPath: path, processedAt: new Date("2026-01-16T00:00:00.000Z") });

  it("covers AE15: adding a third URL keeps the first two as they were and publishes only the third", async () => {
    const topic = await seedTopic({ urls: [extracted("https://a.example", "u/t/extracted/url_a.md"), extracted("https://b.example", "u/t/extracted/url_b.md")] });

    const res = await request(app).patch(`/api/topics/${topic._id}`).send({ urls: ["https://a.example", "https://b.example", "https://c.example"] });

    expect(res.status).toBe(200);
    const after = await Topic.findById(topic._id).lean();
    expect(after!.urls.map((u) => [u.url, u.processingStatus, u.extractedContentPath])).toEqual([
      ["https://a.example", "completed", "u/t/extracted/url_a.md"],
      ["https://b.example", "completed", "u/t/extracted/url_b.md"],
      ["https://c.example", "pending", null],
    ]);
    expect(after!.urls[0]._id!.toString()).toBe(topic.urls[0]._id!.toString());
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0].message).toEqual({ topicId: topic._id.toString(), userId: USER, urls: ["https://c.example"] });
  });

  it("stores a saved URL that cannot be extracted as failed, not pending", async () => {
    const topic = await seedTopic();

    await request(app).patch(`/api/topics/${topic._id}`).send({ urls: ["ftp://files.example/x"] });

    const after = await Topic.findById(topic._id).lean();
    expect(after!.urls[0]).toMatchObject({ url: "ftp://files.example/x", processingStatus: "failed" });
    expect(publish).not.toHaveBeenCalled();
  });

  it("removing a URL deletes its extracted file by its recorded path", async () => {
    const topic = await seedTopic({ urls: [extracted("https://a.example", "u/t/extracted/url_a.md"), extracted("https://b.example", "u/t/extracted/url_b.md")] });

    await request(app).patch(`/api/topics/${topic._id}`).send({ urls: ["https://b.example"] });

    expect(deleteByPath).toHaveBeenCalledTimes(1);
    expect(deleteByPath).toHaveBeenCalledWith("u/t/extracted/url_a.md");
    const after = await Topic.findById(topic._id).lean();
    expect(after!.urls.map((u) => u.url)).toEqual(["https://b.example"]);
    expect(publish).not.toHaveBeenCalled();
  });

  it("returns the updated topic in the response", async () => {
    const topic = await seedTopic();
    const res = await request(app).patch(`/api/topics/${topic._id}`).send({ urls: ["https://c.example"], topicName: "Cell biology" });

    expect(res.body.success).toBe(true);
    expect(res.body.topic.topicName).toBe("Cell biology");
    expect(res.body.topic.urls.map((u: { url: string }) => u.url)).toEqual(["https://c.example"]);
  });
});

describe("PATCH /api/topics/:id — study date", () => {
  it("covers AE17: renaming with the form's unchanged YYYY-MM-DD date keeps the schedule and history", async () => {
    const topic = await seedTopic();
    await seedHistory(topic._id, 3);

    const res = await request(app).patch(`/api/topics/${topic._id}`).send({ topicName: "Cell structure", dateStudied: "2026-01-15" });

    expect(res.status).toBe(200);
    const after = await Topic.findById(topic._id).lean();
    expect(after).toMatchObject({ topicName: "Cell structure", repetitionNumber: 3, interval: 15, eFactor: 2.36, lastQuality: 4 });
    expect(after!.revisionDate.toISOString()).toBe("2026-02-01T00:00:00.000Z");
    expect(await RevisionRecord.countDocuments({ topicId: topic._id })).toBe(3);
  });

  it("keeps the schedule for a New York learner whose form shows the UTC-midnight date as the previous day", async () => {
    const topic = await seedTopic();
    await seedHistory(topic._id, 3);

    // 2026-01-15T00:00Z is 2026-01-14 19:00 in New York, which is what the date input shows.
    const res = await request(app).patch(`/api/topics/${topic._id}`).set("X-Local-TimeZone", "America/New_York").send({ topicName: "Renamed", dateStudied: "2026-01-14" });

    expect(res.status).toBe(200);
    const after = await Topic.findById(topic._id).lean();
    expect(after!.repetitionNumber).toBe(3);
    expect(after!.dateStudied.toISOString()).toBe("2026-01-15T00:00:00.000Z");
    expect(await RevisionRecord.countDocuments({ topicId: topic._id })).toBe(3);
  });

  it("keeps the schedule when a New York learner types the stored UTC date, which is the same instant", async () => {
    const topic = await seedTopic();
    await seedHistory(topic._id, 3);

    // The form shows 2026-01-14; "correcting" it to 2026-01-15 stores the instant already stored.
    const res = await request(app).patch(`/api/topics/${topic._id}`).set("X-Local-TimeZone", "America/New_York").send({ dateStudied: "2026-01-15" });

    expect(res.status).toBe(200);
    const after = await Topic.findById(topic._id).lean();
    expect(after).toMatchObject({ repetitionNumber: 3, interval: 15, eFactor: 2.36, lastQuality: 4 });
    expect(after!.revisionDate.toISOString()).toBe("2026-02-01T00:00:00.000Z");
    expect(after!.dateStudied.toISOString()).toBe("2026-01-15T00:00:00.000Z");
    expect(await RevisionRecord.countDocuments({ topicId: topic._id })).toBe(3);
  });

  it("accepts a full ISO value for an unchanged date", async () => {
    const topic = await seedTopic();
    const res = await request(app).patch(`/api/topics/${topic._id}`).send({ dateStudied: "2026-01-15T00:00:00.000Z" });

    expect(res.status).toBe(200);
    expect((await Topic.findById(topic._id).lean())!.repetitionNumber).toBe(3);
  });

  it("changing the study date resets the schedule and clears history, storing UTC midnight of the new day", async () => {
    const topic = await seedTopic();
    await seedHistory(topic._id, 3);

    const res = await request(app).patch(`/api/topics/${topic._id}`).send({ dateStudied: "2026-01-20" });

    expect(res.status).toBe(200);
    const after = await Topic.findById(topic._id).lean();
    expect(after).toMatchObject({ eFactor: 2.5, interval: 1, repetitionNumber: 0, lastRevised: null, lastQuality: null });
    expect(after!.dateStudied.toISOString()).toBe("2026-01-20T00:00:00.000Z");
    expect(after!.revisionDate.toISOString()).toBe("2026-01-20T00:00:00.000Z");
    expect(await RevisionRecord.countDocuments({ topicId: topic._id })).toBe(0);
  });

  it.each([["15/01/2026"], ["yesterday"], ["2026-13-01"]])("rejects the date %p", async (dateStudied) => {
    const topic = await seedTopic();
    const res = await request(app).patch(`/api/topics/${topic._id}`).send({ dateStudied });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("GET /api/topics/:id — attachment statuses", () => {
  it("returns each attachment's processing status, and the reason when it failed", async () => {
    const topic = await seedTopic({
      files: [
        { fileName: "a.pdf", fileType: "pdf", s3Path: "user-1/t/files/a.pdf", s3Bucket: "b", processingStatus: "completed", extractedContentUrl: "user-1/t/extracted/a.pdf.md" },
        { fileName: "b.pdf", fileType: "pdf", s3Path: "user-1/t/files/b.pdf", s3Bucket: "b", processingStatus: "failed", errorReason: "Unreadable PDF" },
      ],
      urls: [
        { url: "https://a.example", processingStatus: "processing" },
        { url: "https://b.example", processingStatus: "failed", errorReason: "404" },
      ],
    });

    const res = await request(app).get(`/api/topics/${topic._id}`);

    expect(res.status).toBe(200);
    expect(res.body.files.map((f: Record<string, unknown>) => [f.fileName, f.processingStatus, f.errorReason])).toEqual([
      ["a.pdf", "completed", undefined],
      ["b.pdf", "failed", "Unreadable PDF"],
    ]);
    expect(res.body.files[0].fileUrl).toBe("https://signed.example/user-1/t/files/a.pdf");
    expect(res.body.urls.map((u: Record<string, unknown>) => [u.url, u.processingStatus, u.errorReason])).toEqual([
      ["https://a.example", "processing", undefined],
      ["https://b.example", "failed", "404"],
    ]);
  });
});
