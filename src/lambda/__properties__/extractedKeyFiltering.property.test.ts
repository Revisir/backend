import * as fc from "fast-check";

// Mock heavy dependencies that fileProcessor imports
jest.mock("@models/Topic", () => ({
  Topic: { updateOne: jest.fn() },
  truncateErrorReason: (s: string) => s.slice(0, 500),
}));
jest.mock("@services/fileExtractor", () => ({
  extractContent: jest.fn(),
}));
jest.mock("@config/logger", () => ({
  logger: { child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn() }) },
}));
jest.mock("@/config/s3", () => ({
  s3Client: { send: jest.fn() },
}));
jest.mock("@/config/fileConstants", () => ({
  ALLOWED_CONTENT_TYPES: ["application/pdf", "image/png", "text/plain"],
  MAX_FILE_SIZE: 10 * 1024 * 1024,
}));
jest.mock("@services/rabbitmq/connectionManager", () => ({
  ConnectionManager: jest.fn(),
}));
jest.mock("@services/rabbitmq/publisher", () => ({
  QueuePublisher: jest.fn(),
}));
jest.mock("@services/rabbitmq/consumer", () => ({
  QueueConsumer: jest.fn(),
}));
jest.mock("@config/rabbitmq", () => ({
  RABBITMQ_CONFIG: {
    FILE_PROCESSING_QUEUE: "file-processing",
    MAX_RETRY_COUNT: 3,
    PREFETCH_COUNT: 1,
  },
  RABBITMQ_URL: "amqp://localhost",
}));
jest.mock("@/schemas/queue.schema", () => ({
  fileProcessingMessageSchema: { safeParse: jest.fn() },
}));
jest.mock("mongoose", () => ({
  default: { connect: jest.fn() },
  connect: jest.fn(),
}));

import { shouldSkipExtractedKey } from "../fileProcessor";

/**
 * Feature: rabbitmq-message-queues, Property 8: Consumer skips "/extracted/" keys
 * Validates: Requirements 5.8
 *
 * For any message consumed from Queue B where the object key contains the
 * substring "/extracted/", the File Processor SHALL acknowledge the message
 * without invoking file processing logic.
 *
 * We test this via the pure helper `shouldSkipExtractedKey(key)` which returns
 * true when the key contains "/extracted/" (meaning ack without processing),
 * and false otherwise (meaning proceed with processing).
 */
describe("Feature: rabbitmq-message-queues, Property 8: Consumer skips /extracted/ keys", () => {
  // Arbitrary for keys that DO contain "/extracted/" at various positions
  const keyWithExtractedArb = fc
    .tuple(
      fc.string({ minLength: 0, maxLength: 30 }),
      fc.string({ minLength: 0, maxLength: 30 }),
    )
    .map(([prefix, suffix]) => `${prefix}/extracted/${suffix}`);

  // Arbitrary for path segments that do NOT contain "/extracted/"
  const safeSegmentArb = fc
    .string({ minLength: 1, maxLength: 20 })
    .filter(
      (s) => !s.includes("/extracted/") && !s.includes("extracted"),
    );

  // Arbitrary for keys that do NOT contain "/extracted/"
  const keyWithoutExtractedArb = fc
    .array(safeSegmentArb, { minLength: 1, maxLength: 5 })
    .map((parts) => parts.join("/"))
    .filter((key) => !key.includes("/extracted/"));

  it("returns true for any key containing '/extracted/' substring", async () => {
    await fc.assert(
      fc.property(keyWithExtractedArb, (key) => {
        expect(shouldSkipExtractedKey(key)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it("returns false for any key NOT containing '/extracted/' substring", async () => {
    await fc.assert(
      fc.property(keyWithoutExtractedArb, (key) => {
        expect(shouldSkipExtractedKey(key)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it("detects '/extracted/' regardless of position in the key", async () => {
    await fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.string({ minLength: 1, maxLength: 20 }),
        (prefix, suffix) => {
          const key = `${prefix}/extracted/${suffix}`;
          // The key always contains "/extracted/" so it should always be skipped
          expect(shouldSkipExtractedKey(key)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});
