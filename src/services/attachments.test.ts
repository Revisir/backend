import { Types } from "mongoose";
import { ATTACHMENT_STALE_MS } from "@config/questionBank";
import { allSettled, completedMaterialSources, fileTypeFor, isInFlight, isStale, statusTime, summarizeAttachments } from "@services/attachments";

const now = new Date("2026-03-10T12:00:00.000Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const objectIdAt = (date: Date) => Types.ObjectId.createFromTime(Math.floor(date.getTime() / 1000));

describe("staleness", () => {
  it("treats a fresh pending or processing attachment as in flight", () => {
    expect(isInFlight({ processingStatus: "pending", statusUpdatedAt: ago(60_000) }, now)).toBe(true);
    expect(isInFlight({ processingStatus: "processing", statusUpdatedAt: ago(ATTACHMENT_STALE_MS - 1) }, now)).toBe(true);
  });

  it("treats one past the window as stale, not in flight", () => {
    const att = { processingStatus: "processing" as const, statusUpdatedAt: ago(ATTACHMENT_STALE_MS + 1) };
    expect(isStale(att, now)).toBe(true);
    expect(isInFlight(att, now)).toBe(false);
  });

  it("never treats a settled attachment as stale", () => {
    expect(isStale({ processingStatus: "completed", statusUpdatedAt: ago(10 * ATTACHMENT_STALE_MS) }, now)).toBe(false);
    expect(isStale({ processingStatus: "failed" }, now)).toBe(false);
  });

  it("falls back to the subdocument's creation time for legacy entries", () => {
    expect(statusTime({ _id: objectIdAt(ago(5_000)) })!.getTime()).toBe(Math.floor(ago(5_000).getTime() / 1000) * 1000);
    expect(isStale({ _id: objectIdAt(ago(ATTACHMENT_STALE_MS * 2)), processingStatus: "pending" }, now)).toBe(true);
    expect(isInFlight({ _id: objectIdAt(ago(60_000)), processingStatus: "pending" }, now)).toBe(true);
  });

  it("reads a missing status as pending", () => {
    expect(isInFlight({ statusUpdatedAt: ago(1_000) }, now)).toBe(true);
  });
});

describe("summarizeAttachments / allSettled", () => {
  it("counts completed, in-flight and failed (stale included) across files and URLs", () => {
    const topic = {
      files: [
        { processingStatus: "completed" as const, statusUpdatedAt: ago(1) },
        { processingStatus: "processing" as const, statusUpdatedAt: ago(1) },
      ],
      urls: [
        { processingStatus: "failed" as const },
        { processingStatus: "pending" as const, statusUpdatedAt: ago(ATTACHMENT_STALE_MS * 3) },
      ],
    };

    expect(summarizeAttachments(topic, now)).toEqual({ total: 4, completed: 1, inFlight: 1, failed: 2 });
    expect(allSettled(topic, now)).toBe(false);
  });

  it("is settled with no attachments, or with only settled and stale ones", () => {
    expect(allSettled({}, now)).toBe(true);
    expect(allSettled({ files: [{ processingStatus: "completed" }], urls: [{ processingStatus: "pending", statusUpdatedAt: ago(ATTACHMENT_STALE_MS * 2) }] }, now)).toBe(true);
  });
});

describe("completedMaterialSources", () => {
  it("lists only completed attachments' recorded extracted paths, files first", () => {
    const topic = {
      urls: [
        { url: "https://a.example", processingStatus: "completed" as const, extractedContentPath: "u/t/extracted/url_a.md" },
        { url: "https://b.example", processingStatus: "pending" as const, extractedContentPath: "u/t/extracted/url_b.md" },
      ],
      files: [
        { fileName: "notes.pdf", processingStatus: "completed" as const, extractedContentUrl: "u/t/extracted/notes.pdf.md" },
        { fileName: "draft.pdf", processingStatus: "completed" as const },
        { fileName: "bad.pdf", processingStatus: "failed" as const, extractedContentUrl: "u/t/extracted/bad.pdf.md" },
      ],
    };

    expect(completedMaterialSources(topic)).toEqual([
      { path: "u/t/extracted/notes.pdf.md", label: "notes.pdf" },
      { path: "u/t/extracted/url_a.md", label: "https://a.example" },
    ]);
  });
});

describe("fileTypeFor", () => {
  it.each([
    ["image/png", "image"],
    ["application/pdf", "pdf"],
    ["text/plain", "text"],
    ["application/octet-stream", "text"],
  ])("%s → %s", (contentType, expected) => {
    expect(fileTypeFor(contentType)).toBe(expected);
  });
});
