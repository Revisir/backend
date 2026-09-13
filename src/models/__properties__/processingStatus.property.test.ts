import * as fc from "fast-check";
import { Topic } from "../Topic";

/**
 * Property 13: isProcessingComplete virtual correctness
 * Validates: Requirements 8.11
 *
 * For any topic with zero or more URL subdocuments and zero or more file subdocuments,
 * `isProcessingComplete` SHALL return `true` if and only if every subdocument has a
 * `processingStatus` of "completed" or "failed" (including the case where both arrays are empty).
 */

type ProcessingStatus = "pending" | "processing" | "completed" | "failed";

const processingStatuses: ProcessingStatus[] = ["pending", "processing", "completed", "failed"];
const terminalStatuses: ProcessingStatus[] = ["completed", "failed"];
const nonTerminalStatuses: ProcessingStatus[] = ["pending", "processing"];

interface UrlSubdoc {
  url: string;
  processingStatus: ProcessingStatus;
}

interface FileSubdoc {
  fileName: string;
  fileType: "image" | "pdf" | "text";
  s3Path: string;
  s3Bucket: string;
  processingStatus: ProcessingStatus;
}

/**
 * Generator for a URL subdocument with a given processingStatus arbitrary.
 */
const urlSubdocArb = (status: fc.Arbitrary<ProcessingStatus>): fc.Arbitrary<UrlSubdoc> =>
  fc.record({
    url: fc.constant("https://example.com/page") as fc.Arbitrary<string>,
    processingStatus: status,
  });

/**
 * Generator for a file subdocument with a given processingStatus arbitrary.
 */
const fileSubdocArb = (status: fc.Arbitrary<ProcessingStatus>): fc.Arbitrary<FileSubdoc> =>
  fc.record({
    fileName: fc.string({ minLength: 1, maxLength: 50 }),
    fileType: fc.constantFrom("image" as const, "pdf" as const, "text" as const),
    s3Path: fc.constant("some/path/file.pdf") as fc.Arbitrary<string>,
    s3Bucket: fc.constant("test-bucket") as fc.Arbitrary<string>,
    processingStatus: status,
  });

/**
 * Helper to create a topic document (in-memory, no DB required) with given url/file arrays.
 */
function createTopic(urls: UrlSubdoc[], files: FileSubdoc[]) {
  return new Topic({
    topicName: "Test Topic",
    subjectName: "Test Subject",
    userId: "user-123",
    dateStudied: new Date(),
    revisionDate: new Date(),
    urls,
    files,
  });
}

describe("Feature: rabbitmq-message-queues, Property 13: isProcessingComplete virtual correctness", () => {
  it("should return true when all subdocuments have 'completed' or 'failed' status", () => {
    fc.assert(
      fc.property(
        fc.array(urlSubdocArb(fc.constantFrom(...terminalStatuses)), { minLength: 0, maxLength: 10 }),
        fc.array(fileSubdocArb(fc.constantFrom(...terminalStatuses)), { minLength: 0, maxLength: 10 }),
        (urls, files) => {
          const topic = createTopic(urls, files);
          expect(topic.isProcessingComplete).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("should return false when any subdocument has 'pending' or 'processing' status", () => {
    fc.assert(
      fc.property(
        fc.array(urlSubdocArb(fc.constantFrom(...processingStatuses)), { minLength: 0, maxLength: 10 }),
        fc.array(fileSubdocArb(fc.constantFrom(...processingStatuses)), { minLength: 0, maxLength: 10 }),
        fc.constantFrom(...nonTerminalStatuses),
        fc.boolean(),
        (urls, files, nonTerminalStatus, injectInUrl) => {
          // Ensure at least one subdocument has a non-terminal status
          const mutableUrls: UrlSubdoc[] = [...urls];
          const mutableFiles: FileSubdoc[] = [...files];

          if (injectInUrl || mutableFiles.length === 0) {
            mutableUrls.push({ url: "https://example.com/test", processingStatus: nonTerminalStatus });
          } else {
            mutableFiles.push({
              fileName: "test.pdf",
              fileType: "pdf",
              s3Path: "some/path",
              s3Bucket: "bucket",
              processingStatus: nonTerminalStatus,
            });
          }

          const topic = createTopic(mutableUrls, mutableFiles);
          expect(topic.isProcessingComplete).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("should return true when both arrays are empty", () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const topic = createTopic([], []);
        expect(topic.isProcessingComplete).toBe(true);
      }),
      { numRuns: 100 }
    );
  });
});


/**
 * Property 11: New subdocuments initialize with "pending" status
 * Validates: Requirements 8.3, 8.4
 *
 * For any topic created with one or more URLs or files WITHOUT explicitly setting
 * `processingStatus`, every URL subdocument and every file subdocument SHALL have
 * a `processingStatus` of "pending" immediately after creation.
 */
describe("Feature: rabbitmq-message-queues, Property 11: New subdocuments initialize with \"pending\" status", () => {
  /**
   * Generator for URL subdocuments without processingStatus set.
   */
  const urlWithoutStatusArb = fc.record({
    url: fc.webUrl({ validSchemes: ["https", "http"] }),
  });

  /**
   * Generator for file subdocuments with required fields but no processingStatus.
   */
  const fileWithoutStatusArb = fc.record({
    fileName: fc.string({ minLength: 1, maxLength: 50 }),
    fileType: fc.constantFrom("image" as const, "pdf" as const, "text" as const),
    s3Path: fc.string({ minLength: 1, maxLength: 100 }),
    s3Bucket: fc.string({ minLength: 1, maxLength: 50 }),
  });

  it("every URL subdocument initializes with processingStatus 'pending' when not explicitly set", () => {
    fc.assert(
      fc.property(
        fc.array(urlWithoutStatusArb, { minLength: 1, maxLength: 10 }),
        (urls) => {
          const topic = new Topic({
            topicName: "Test Topic",
            subjectName: "Test Subject",
            userId: "user-123",
            dateStudied: new Date(),
            revisionDate: new Date(),
            urls,
          });

          for (const urlDoc of topic.urls) {
            expect(urlDoc.processingStatus).toBe("pending");
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it("every file subdocument initializes with processingStatus 'pending' when not explicitly set", () => {
    fc.assert(
      fc.property(
        fc.array(fileWithoutStatusArb, { minLength: 1, maxLength: 10 }),
        (files) => {
          const topic = new Topic({
            topicName: "Test Topic",
            subjectName: "Test Subject",
            userId: "user-123",
            dateStudied: new Date(),
            revisionDate: new Date(),
            files,
          });

          for (const fileDoc of topic.files) {
            expect(fileDoc.processingStatus).toBe("pending");
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it("every URL and file subdocument initializes with 'pending' when both are provided without explicit status", () => {
    fc.assert(
      fc.property(
        fc.array(urlWithoutStatusArb, { minLength: 1, maxLength: 5 }),
        fc.array(fileWithoutStatusArb, { minLength: 1, maxLength: 5 }),
        (urls, files) => {
          const topic = new Topic({
            topicName: "Test Topic",
            subjectName: "Test Subject",
            userId: "user-123",
            dateStudied: new Date(),
            revisionDate: new Date(),
            urls,
            files,
          });

          for (const urlDoc of topic.urls) {
            expect(urlDoc.processingStatus).toBe("pending");
          }
          for (const fileDoc of topic.files) {
            expect(fileDoc.processingStatus).toBe("pending");
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});


/**
 * Property 12: Error reason truncation
 * Validates: Requirements 8.7, 8.10
 *
 * For any error string of arbitrary length, when stored as the `errorReason` on a URL
 * or file subdocument, the persisted value SHALL be at most 500 characters.
 *
 * Tests that:
 * 1. truncateErrorReason always returns a string <= 500 characters
 * 2. Strings <= 500 characters are preserved as-is (no unnecessary truncation)
 */

import { truncateErrorReason } from "../Topic";

describe("Feature: rabbitmq-message-queues, Property 12: Error reason truncation", () => {
  it("truncateErrorReason always returns a string of at most 500 characters", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 5000 }),
        (errorString) => {
          const result = truncateErrorReason(errorString);
          expect(result.length).toBeLessThanOrEqual(500);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("strings of 500 characters or fewer are preserved exactly", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 500 }),
        (shortString) => {
          const result = truncateErrorReason(shortString);
          expect(result).toBe(shortString);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("strings longer than 500 characters are truncated to exactly 500 characters from the start", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 501, maxLength: 5000 }),
        (longString) => {
          const result = truncateErrorReason(longString);
          expect(result.length).toBe(500);
          expect(result).toBe(longString.substring(0, 500));
        }
      ),
      { numRuns: 100 }
    );
  });
});


import { isValidStatusTransition } from "../Topic";

/**
 * Property 14: Processing status transition validation
 * Validates: Requirements 8.13
 *
 * For any attempted status transition on a URL or file subdocument, the transition
 * SHALL succeed only if it follows one of the allowed sequences:
 * "pending" → "processing", "processing" → "completed", or "processing" → "failed".
 * All other transitions SHALL be rejected.
 */

type StatusType = "pending" | "processing" | "completed" | "failed";

const allStatuses: StatusType[] = ["pending", "processing", "completed", "failed"];

const validTransitions: Array<[StatusType, StatusType]> = [
  ["pending", "processing"],
  ["processing", "completed"],
  ["processing", "failed"],
];

function isKnownValidTransition(from: StatusType, to: StatusType): boolean {
  return validTransitions.some(([f, t]) => f === from && t === to);
}

describe("Feature: rabbitmq-message-queues, Property 14: Processing status transition validation", () => {
  it("all valid transitions (pending→processing, processing→completed, processing→failed) return true", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...validTransitions),
        ([from, to]) => {
          expect(isValidStatusTransition(from, to)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("all invalid transitions return false", () => {
    // Generate all possible (from, to) pairs and filter to only invalid ones
    const allPairs: Array<[StatusType, StatusType]> = [];
    for (const from of allStatuses) {
      for (const to of allStatuses) {
        if (!isKnownValidTransition(from, to)) {
          allPairs.push([from, to]);
        }
      }
    }

    fc.assert(
      fc.property(
        fc.constantFrom(...allPairs),
        ([from, to]) => {
          expect(isValidStatusTransition(from, to)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("for any arbitrary (from, to) pair, the result matches the defined valid transitions exactly", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...allStatuses),
        fc.constantFrom(...allStatuses),
        (from, to) => {
          const result = isValidStatusTransition(from, to);
          const expected = isKnownValidTransition(from, to);
          expect(result).toBe(expected);
        }
      ),
      { numRuns: 100 }
    );
  });
});
