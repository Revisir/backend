/**
 * The URL worker moves each URL entry to a truthful, timestamped status and
 * asks for a question-bank build once the topic's attachments have settled.
 */
import type { ConsumeMessage } from "amqplib";
import { setTimeout as sleep } from "node:timers/promises";

jest.mock("@services/jinaReader", () => ({ readUrl: jest.fn() }));
jest.mock("@services/s3Storage", () => ({ saveExtractedContentAtPath: jest.fn() }));

import { useMongoMemoryServer } from "../test/mongo";
import { Topic } from "@models/Topic";
import { handleUrlMessage } from "@/lambda/urlProcessor";
import { readUrl } from "@services/jinaReader";
import { saveExtractedContentAtPath } from "@services/s3Storage";
import { extractedKeyForUrl } from "@services/uploadKey";
import { Publishers } from "@services/rabbitmq/index";
import type { QuestionBankMessage } from "@/schemas/queue.schema";

useMongoMemoryServer();

const USER = "user-1";
const URL_A = "https://example.com/a";
const URL_B = "https://example.com/b";
const LONG_AGO = new Date("2026-01-01T00:00:00.000Z");
const publish = jest.fn();

function message(topicId: unknown, urls: string[]): ConsumeMessage {
  return { content: Buffer.from(JSON.stringify({ topicId: String(topicId), userId: USER, urls })) } as unknown as ConsumeMessage;
}

async function seedTopic(urls: Record<string, unknown>[]) {
  return Topic.create({ userId: USER, topicName: "Cells", subjectName: "Biology", dateStudied: new Date(), revisionDate: new Date(), urls });
}

async function urlEntry(topicId: unknown, url: string) {
  return (await Topic.findById(topicId).lean())!.urls.find((u) => u.url === url)!;
}

/**
 * Resolves readUrl with `result` a few milliseconds after the worker's
 * "processing" write, recording when; a status stamped at or after that time
 * came from the final write, not the "processing" one.
 */
function extractAfterProcessingWrite(result: { success: boolean; content: string; error?: string }) {
  const extracted = { at: 0 };
  (readUrl as jest.Mock).mockImplementation(async () => {
    await sleep(5);
    extracted.at = Date.now();
    return result;
  });
  return extracted;
}

function bankMessages(): QuestionBankMessage[] {
  return publish.mock.calls.map((call) => call[0].message);
}

beforeEach(() => {
  (readUrl as jest.Mock).mockReset().mockResolvedValue({ success: true, content: "# Notes" });
  (saveExtractedContentAtPath as jest.Mock).mockReset().mockImplementation(async (userId: string, topicId: string, name: string) => `${userId}/${topicId}/extracted/${name}`);
  publish.mockReset().mockResolvedValue(true);
  Publishers.questionBank = { publish } as unknown as typeof Publishers.questionBank;
});

describe("handleUrlMessage", () => {
  it("completes the entry with its extracted path, clears an earlier error and stamps the change", async () => {
    // A retry of a URL that failed before.
    const topic = await seedTopic([{ url: URL_A, processingStatus: "failed", statusUpdatedAt: LONG_AGO, errorReason: "Earlier failure" }]);
    const extracted = extractAfterProcessingWrite({ success: true, content: "# Notes" });

    expect(await handleUrlMessage(message(topic._id, [URL_A]))).toBe("ack");

    const entry = await urlEntry(topic._id, URL_A);
    expect(entry.processingStatus).toBe("completed");
    expect(entry.extractedContentPath).toBe(extractedKeyForUrl(USER, String(topic._id), URL_A));
    expect(entry.errorReason).toBeNull();
    expect(new Date(entry.statusUpdatedAt!).getTime()).toBeGreaterThanOrEqual(extracted.at);
    expect(saveExtractedContentAtPath).toHaveBeenCalledWith(USER, String(topic._id), expect.any(String), "# Notes");
  });

  it("fails an entry whose extraction returned no content", async () => {
    const topic = await seedTopic([{ url: URL_A, processingStatus: "pending", statusUpdatedAt: LONG_AGO }]);
    const extracted = extractAfterProcessingWrite({ success: false, content: "", error: "Jina Reader returned empty content" });

    expect(await handleUrlMessage(message(topic._id, [URL_A]))).toBe("nack_reject");

    const entry = await urlEntry(topic._id, URL_A);
    expect(entry).toMatchObject({ processingStatus: "failed", errorReason: "Extraction returned no content" });
    expect(new Date(entry.statusUpdatedAt!).getTime()).toBeGreaterThanOrEqual(extracted.at);
    expect(saveExtractedContentAtPath).not.toHaveBeenCalled();
  });

  it("fails an entry with the reason of a permanent extraction error and rejects when every URL failed", async () => {
    const topic = await seedTopic([{ url: URL_A, processingStatus: "pending" }]);
    (readUrl as jest.Mock).mockRejectedValue(new Error("Invalid URL format"));

    expect(await handleUrlMessage(message(topic._id, [URL_A]))).toBe("nack_reject");

    expect(await urlEntry(topic._id, URL_A)).toMatchObject({ processingStatus: "failed", errorReason: "Invalid URL format" });
  });

  it("acks when at least one URL in the message was extracted", async () => {
    const topic = await seedTopic([
      { url: URL_A, processingStatus: "pending" },
      { url: URL_B, processingStatus: "pending" },
    ]);
    (readUrl as jest.Mock).mockImplementation(async (url: string) => {
      if (url === URL_A) throw new Error("Invalid URL format");
      return { success: true, content: "# B" };
    });

    expect(await handleUrlMessage(message(topic._id, [URL_A, URL_B]))).toBe("ack");

    expect((await urlEntry(topic._id, URL_A)).processingStatus).toBe("failed");
    expect((await urlEntry(topic._id, URL_B)).processingStatus).toBe("completed");
  });

  it("requeues the message on a transient error without failing the entry or asking for a build", async () => {
    const topic = await seedTopic([{ url: URL_A, processingStatus: "pending" }]);
    (readUrl as jest.Mock).mockRejectedValue(new Error("Request timeout after 40000ms"));

    expect(await handleUrlMessage(message(topic._id, [URL_A]))).toBe("nack_requeue");

    expect((await urlEntry(topic._id, URL_A)).processingStatus).toBe("processing");
    expect(publish).not.toHaveBeenCalled();
  });

  it("asks for one bank build when the topic's last unsettled attachment completes", async () => {
    const topic = await seedTopic([{ url: URL_A, processingStatus: "pending" }]);

    await handleUrlMessage(message(topic._id, [URL_A]));

    expect(bankMessages()).toEqual([expect.objectContaining({ topicId: String(topic._id), userId: USER, reason: "materials_settled" })]);
  });

  it("asks for no build while another attachment is still pending", async () => {
    const topic = await seedTopic([
      { url: URL_A, processingStatus: "pending" },
      { url: URL_B, processingStatus: "pending" },
    ]);

    expect(await handleUrlMessage(message(topic._id, [URL_A]))).toBe("ack");

    expect((await urlEntry(topic._id, URL_B)).processingStatus).toBe("pending");
    expect(publish).not.toHaveBeenCalled();
  });
});
