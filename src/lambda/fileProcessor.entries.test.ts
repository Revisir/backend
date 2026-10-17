/**
 * U2 — the file worker keeps exactly one truthful entry per uploaded object,
 * creating it when the API never did.
 */
import { mockClient } from "aws-sdk-client-mock";
import { S3Client, HeadObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import type { ConsumeMessage } from "amqplib";

jest.mock("@services/fileExtractor", () => ({ extractContent: jest.fn() }));

import { useMongoMemoryServer } from "../test/mongo";
import { Topic } from "@models/Topic";
import { handleFileMessage } from "@/lambda/fileProcessor";
import { extractContent } from "@services/fileExtractor";

useMongoMemoryServer();

const s3 = mockClient(S3Client);
const USER = "user-1";
const BUCKET = "revision-study-content";

function message(key: string): ConsumeMessage {
  return { content: Buffer.from(JSON.stringify({ bucket: BUCKET, key })) } as unknown as ConsumeMessage;
}

function stubObject(contentType = "application/pdf", size = 1234) {
  s3.on(HeadObjectCommand).resolves({ ContentType: contentType, ContentLength: size });
  s3.on(GetObjectCommand).resolves({ Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) } } as never);
  s3.on(PutObjectCommand).resolves({});
}

async function seedTopic(files: Record<string, unknown>[] = []) {
  return Topic.create({ userId: USER, topicName: "Cells", subjectName: "Biology", dateStudied: new Date(), revisionDate: new Date(), files });
}

beforeEach(() => {
  s3.reset();
  (extractContent as jest.Mock).mockReset().mockResolvedValue({ success: true, content: "# Notes" });
});

describe("handleFileMessage", () => {
  it("covers AE16 (entry half): moves each declared pending entry to completed with its extracted path", async () => {
    const topic = await seedTopic();
    const keys = ["notes.pdf", "more.pdf"].map((name) => `${USER}/${topic._id}/files/${name}`);
    await Topic.updateOne({ _id: topic._id }, { $push: { files: { $each: keys.map((key, i) => ({ fileName: ["notes.pdf", "more.pdf"][i], fileType: "pdf", s3Path: key, s3Bucket: BUCKET, processingStatus: "pending" })) } } });
    stubObject();

    for (const key of keys) expect(await handleFileMessage(message(key))).toBe("ack");

    const after = await Topic.findById(topic._id).lean();
    expect(after!.files).toHaveLength(2);
    expect(after!.files.map((f) => [f.processingStatus, f.extractedContentUrl])).toEqual([
      ["completed", `${USER}/${topic._id}/extracted/notes.pdf.md`],
      ["completed", `${USER}/${topic._id}/extracted/more.pdf.md`],
    ]);
  });

  it("creates the entry when an upload arrives for a file with none", async () => {
    const topic = await seedTopic();
    const key = `${USER}/${topic._id}/files/lecture.png`;
    stubObject("image/png", 4321);

    expect(await handleFileMessage(message(key))).toBe("ack");

    const after = await Topic.findById(topic._id).lean();
    expect(after!.files).toHaveLength(1);
    expect(after!.files[0]).toMatchObject({ fileName: "lecture.png", fileType: "image", s3Path: key, s3Bucket: BUCKET, size: 4321, processingStatus: "completed" });
  });

  it("updates the existing entry on a second event for the same key instead of adding a duplicate", async () => {
    const topic = await seedTopic();
    const key = `${USER}/${topic._id}/files/notes.pdf`;
    stubObject();

    await handleFileMessage(message(key));
    await handleFileMessage(message(key));

    expect((await Topic.findById(topic._id).lean())!.files).toHaveLength(1);
  });

  it("leaves a failed extraction failed with a truncated reason", async () => {
    const topic = await seedTopic();
    const key = `${USER}/${topic._id}/files/notes.pdf`;
    stubObject();
    (extractContent as jest.Mock).mockResolvedValue({ success: false, error: "x".repeat(900) });

    expect(await handleFileMessage(message(key))).toBe("nack_reject");

    const file = (await Topic.findById(topic._id).lean())!.files[0];
    expect(file.processingStatus).toBe("failed");
    expect(file.errorReason!.length).toBeLessThanOrEqual(500);
  });

  it("records a rejected upload as failed with its reason", async () => {
    const topic = await seedTopic();
    const key = `${USER}/${topic._id}/files/movie.mp4`;
    stubObject("video/mp4");

    expect(await handleFileMessage(message(key))).toBe("nack_reject");

    const file = (await Topic.findById(topic._id).lean())!.files[0];
    expect(file).toMatchObject({ fileName: "movie.mp4", processingStatus: "failed" });
    expect(file.errorReason).toMatch(/content type/i);
    expect(extractContent).not.toHaveBeenCalled();
  });

  it("acks without extracting when the topic no longer exists", async () => {
    stubObject();
    const key = `${USER}/650000000000000000000000/files/notes.pdf`;

    expect(await handleFileMessage(message(key))).toBe("ack");
    expect(extractContent).not.toHaveBeenCalled();
  });
});
