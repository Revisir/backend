import * as fc from "fast-check";
import type { Channel, ConsumeMessage, Replies } from "amqplib";
import { QueueConsumer } from "@services/rabbitmq/consumer";
import type { ConnectionManager } from "@services/rabbitmq/connectionManager";
import {
  urlProcessingMessageSchema,
  fileProcessingMessageSchema,
} from "../../../schemas/queue.schema";

/**
 * Feature: rabbitmq-message-queues, Property 10: Invalid messages are rejected without requeue
 * Validates: Requirements 7.4, 7.5
 *
 * For any message consumed from Queue A or Queue B that fails schema validation
 * (not valid JSON, missing required fields, wrong types, or empty values),
 * the consumer SHALL reject the message with requeue set to false.
 */
describe("Feature: rabbitmq-message-queues, Property 10: Invalid messages are rejected without requeue", () => {
  let mockChannel: jest.Mocked<Channel>;
  let mockConnectionManager: jest.Mocked<ConnectionManager>;
  let consumer: QueueConsumer;
  let capturedConsumerCallback: ((msg: ConsumeMessage | null) => void) | null;

  beforeEach(() => {
    capturedConsumerCallback = null;

    mockChannel = {
      prefetch: jest.fn().mockResolvedValue(undefined),
      consume: jest.fn().mockImplementation((_queue, callback) => {
        capturedConsumerCallback = callback;
        return Promise.resolve({ consumerTag: "test-tag" } as Replies.Consume);
      }),
      ack: jest.fn(),
      nack: jest.fn(),
      sendToQueue: jest.fn(),
      cancel: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<Channel>;

    mockConnectionManager = {
      getChannel: jest.fn().mockReturnValue(mockChannel),
      registerConsumerTag: jest.fn(),
    } as unknown as jest.Mocked<ConnectionManager>;

    consumer = new QueueConsumer(mockConnectionManager);
  });

  function createMockMessage(content: string | Buffer): ConsumeMessage {
    const buffer = typeof content === "string" ? Buffer.from(content) : content;
    return {
      content: buffer,
      fields: {
        deliveryTag: 1,
        redelivered: false,
        exchange: "",
        routingKey: "test-queue",
        consumerTag: "test-tag",
      },
      properties: {
        headers: {},
        contentType: "application/json",
        contentEncoding: undefined,
        deliveryMode: 2,
        priority: undefined,
        correlationId: undefined,
        replyTo: undefined,
        expiration: undefined,
        messageId: undefined,
        timestamp: undefined,
        type: undefined,
        userId: undefined,
        appId: undefined,
        clusterId: undefined,
      },
    } as unknown as ConsumeMessage;
  }

  async function consumeAndDispatch(
    schema: typeof urlProcessingMessageSchema | typeof fileProcessingMessageSchema,
    msgContent: string,
  ): Promise<void> {
    const handler = jest.fn().mockResolvedValue("ack");

    await consumer.consume("test-queue", handler, { schema });

    expect(capturedConsumerCallback).not.toBeNull();

    const msg = createMockMessage(msgContent);
    await capturedConsumerCallback!(msg);

    // Assert: message rejected without requeue
    expect(mockChannel.nack).toHaveBeenCalledWith(msg, false, false);
    // Assert: handler was NOT invoked
    expect(handler).not.toHaveBeenCalled();
  }

  // Arbitrary: invalid JSON strings (random text that cannot be parsed as JSON)
  const invalidJsonArb = fc.oneof(
    // Random alphanumeric strings that aren't valid JSON
    fc.string({ minLength: 1, maxLength: 100 }).filter((s) => {
      try {
        JSON.parse(s);
        return false;
      } catch {
        return true;
      }
    }),
    // Binary-like content
    fc.uint8Array({ minLength: 1, maxLength: 50 }).map((arr) =>
      String.fromCharCode(...arr),
    ),
    // Truncated/malformed JSON
    fc.constantFrom(
      "{",
      '{"topicId":',
      "[1,2,",
      '{"key": "val"',
      "undefined",
      "NaN",
      "{{}",
    ),
  );

  // Arbitrary: Queue A messages missing required fields
  const queueAMissingFieldsArb = fc.oneof(
    // Missing topicId
    fc.record({
      userId: fc.string({ minLength: 1, maxLength: 20 }),
      urls: fc.array(
        fc.webUrl({ withFragments: false }),
        { minLength: 1, maxLength: 5 },
      ),
    }),
    // Missing userId
    fc.record({
      topicId: fc.string({ minLength: 1, maxLength: 20 }),
      urls: fc.array(
        fc.webUrl({ withFragments: false }),
        { minLength: 1, maxLength: 5 },
      ),
    }),
    // Missing urls
    fc.record({
      topicId: fc.string({ minLength: 1, maxLength: 20 }),
      userId: fc.string({ minLength: 1, maxLength: 20 }),
    }),
    // Empty object
    fc.constant({}),
  );

  // Arbitrary: Queue A messages with wrong types
  const queueAWrongTypesArb = fc.oneof(
    // topicId as number
    fc.record({
      topicId: fc.integer(),
      userId: fc.string({ minLength: 1, maxLength: 20 }),
      urls: fc.array(
        fc.webUrl({ withFragments: false }),
        { minLength: 1, maxLength: 5 },
      ),
    }),
    // userId as number
    fc.record({
      topicId: fc.string({ minLength: 1, maxLength: 20 }),
      userId: fc.integer(),
      urls: fc.array(
        fc.webUrl({ withFragments: false }),
        { minLength: 1, maxLength: 5 },
      ),
    }),
    // urls as a string instead of array
    fc.record({
      topicId: fc.string({ minLength: 1, maxLength: 20 }),
      userId: fc.string({ minLength: 1, maxLength: 20 }),
      urls: fc.string({ minLength: 1, maxLength: 50 }),
    }),
    // urls as a number
    fc.record({
      topicId: fc.string({ minLength: 1, maxLength: 20 }),
      userId: fc.string({ minLength: 1, maxLength: 20 }),
      urls: fc.integer(),
    }),
  );

  // Arbitrary: Queue A messages with empty values
  const queueAEmptyValuesArb = fc.oneof(
    // Empty string topicId
    fc.record({
      topicId: fc.constant(""),
      userId: fc.string({ minLength: 1, maxLength: 20 }),
      urls: fc.array(
        fc.webUrl({ withFragments: false }),
        { minLength: 1, maxLength: 5 },
      ),
    }),
    // Empty string userId
    fc.record({
      topicId: fc.string({ minLength: 1, maxLength: 20 }),
      userId: fc.constant(""),
      urls: fc.array(
        fc.webUrl({ withFragments: false }),
        { minLength: 1, maxLength: 5 },
      ),
    }),
    // Empty urls array
    fc.record({
      topicId: fc.string({ minLength: 1, maxLength: 20 }),
      userId: fc.string({ minLength: 1, maxLength: 20 }),
      urls: fc.constant([]),
    }),
  );

  // Arbitrary: Queue B messages missing required fields
  const queueBMissingFieldsArb = fc.oneof(
    // Missing bucket
    fc.record({
      key: fc.string({ minLength: 1, maxLength: 50 }),
    }),
    // Missing key
    fc.record({
      bucket: fc.string({ minLength: 1, maxLength: 50 }),
    }),
    // Empty object
    fc.constant({}),
  );

  // Arbitrary: Queue B messages with wrong types
  const queueBWrongTypesArb = fc.oneof(
    // bucket as number
    fc.record({
      bucket: fc.integer(),
      key: fc.string({ minLength: 1, maxLength: 50 }),
    }),
    // key as number
    fc.record({
      bucket: fc.string({ minLength: 1, maxLength: 50 }),
      key: fc.integer(),
    }),
    // bucket as array
    fc.record({
      bucket: fc.array(fc.string(), { minLength: 1, maxLength: 3 }),
      key: fc.string({ minLength: 1, maxLength: 50 }),
    }),
  );

  // Arbitrary: Queue B messages with empty values
  const queueBEmptyValuesArb = fc.oneof(
    // Empty string bucket
    fc.record({
      bucket: fc.constant(""),
      key: fc.string({ minLength: 1, maxLength: 50 }),
    }),
    // Empty string key
    fc.record({
      bucket: fc.string({ minLength: 1, maxLength: 50 }),
      key: fc.constant(""),
    }),
  );

  describe("Queue A (url_processing) - invalid messages are rejected", () => {
    it("rejects messages that are not valid JSON", async () => {
      await fc.assert(
        fc.asyncProperty(invalidJsonArb, async (invalidJson) => {
          // Reset mocks between iterations
          mockChannel.nack.mockClear();
          mockChannel.ack.mockClear();
          mockChannel.consume.mockClear();
          capturedConsumerCallback = null;

          const handler = jest.fn().mockResolvedValue("ack");
          await consumer.consume("url_processing", handler, {
            schema: urlProcessingMessageSchema,
          });

          const msg = createMockMessage(invalidJson);
          await capturedConsumerCallback!(msg);

          expect(mockChannel.nack).toHaveBeenCalledWith(msg, false, false);
          expect(handler).not.toHaveBeenCalled();
        }),
        { numRuns: 100 },
      );
    });

    it("rejects messages missing required fields", async () => {
      await fc.assert(
        fc.asyncProperty(queueAMissingFieldsArb, async (invalidObj) => {
          mockChannel.nack.mockClear();
          mockChannel.ack.mockClear();
          mockChannel.consume.mockClear();
          capturedConsumerCallback = null;

          const handler = jest.fn().mockResolvedValue("ack");
          await consumer.consume("url_processing", handler, {
            schema: urlProcessingMessageSchema,
          });

          const msg = createMockMessage(JSON.stringify(invalidObj));
          await capturedConsumerCallback!(msg);

          expect(mockChannel.nack).toHaveBeenCalledWith(msg, false, false);
          expect(handler).not.toHaveBeenCalled();
        }),
        { numRuns: 100 },
      );
    });

    it("rejects messages with wrong field types", async () => {
      await fc.assert(
        fc.asyncProperty(queueAWrongTypesArb, async (invalidObj) => {
          mockChannel.nack.mockClear();
          mockChannel.ack.mockClear();
          mockChannel.consume.mockClear();
          capturedConsumerCallback = null;

          const handler = jest.fn().mockResolvedValue("ack");
          await consumer.consume("url_processing", handler, {
            schema: urlProcessingMessageSchema,
          });

          const msg = createMockMessage(JSON.stringify(invalidObj));
          await capturedConsumerCallback!(msg);

          expect(mockChannel.nack).toHaveBeenCalledWith(msg, false, false);
          expect(handler).not.toHaveBeenCalled();
        }),
        { numRuns: 100 },
      );
    });

    it("rejects messages with empty values", async () => {
      await fc.assert(
        fc.asyncProperty(queueAEmptyValuesArb, async (invalidObj) => {
          mockChannel.nack.mockClear();
          mockChannel.ack.mockClear();
          mockChannel.consume.mockClear();
          capturedConsumerCallback = null;

          const handler = jest.fn().mockResolvedValue("ack");
          await consumer.consume("url_processing", handler, {
            schema: urlProcessingMessageSchema,
          });

          const msg = createMockMessage(JSON.stringify(invalidObj));
          await capturedConsumerCallback!(msg);

          expect(mockChannel.nack).toHaveBeenCalledWith(msg, false, false);
          expect(handler).not.toHaveBeenCalled();
        }),
        { numRuns: 100 },
      );
    });
  });

  describe("Queue B (file-processing) - invalid messages are rejected", () => {
    it("rejects messages that are not valid JSON", async () => {
      await fc.assert(
        fc.asyncProperty(invalidJsonArb, async (invalidJson) => {
          mockChannel.nack.mockClear();
          mockChannel.ack.mockClear();
          mockChannel.consume.mockClear();
          capturedConsumerCallback = null;

          const handler = jest.fn().mockResolvedValue("ack");
          await consumer.consume("file-processing", handler, {
            schema: fileProcessingMessageSchema,
          });

          const msg = createMockMessage(invalidJson);
          await capturedConsumerCallback!(msg);

          expect(mockChannel.nack).toHaveBeenCalledWith(msg, false, false);
          expect(handler).not.toHaveBeenCalled();
        }),
        { numRuns: 100 },
      );
    });

    it("rejects messages missing required fields", async () => {
      await fc.assert(
        fc.asyncProperty(queueBMissingFieldsArb, async (invalidObj) => {
          mockChannel.nack.mockClear();
          mockChannel.ack.mockClear();
          mockChannel.consume.mockClear();
          capturedConsumerCallback = null;

          const handler = jest.fn().mockResolvedValue("ack");
          await consumer.consume("file-processing", handler, {
            schema: fileProcessingMessageSchema,
          });

          const msg = createMockMessage(JSON.stringify(invalidObj));
          await capturedConsumerCallback!(msg);

          expect(mockChannel.nack).toHaveBeenCalledWith(msg, false, false);
          expect(handler).not.toHaveBeenCalled();
        }),
        { numRuns: 100 },
      );
    });

    it("rejects messages with wrong field types", async () => {
      await fc.assert(
        fc.asyncProperty(queueBWrongTypesArb, async (invalidObj) => {
          mockChannel.nack.mockClear();
          mockChannel.ack.mockClear();
          mockChannel.consume.mockClear();
          capturedConsumerCallback = null;

          const handler = jest.fn().mockResolvedValue("ack");
          await consumer.consume("file-processing", handler, {
            schema: fileProcessingMessageSchema,
          });

          const msg = createMockMessage(JSON.stringify(invalidObj));
          await capturedConsumerCallback!(msg);

          expect(mockChannel.nack).toHaveBeenCalledWith(msg, false, false);
          expect(handler).not.toHaveBeenCalled();
        }),
        { numRuns: 100 },
      );
    });

    it("rejects messages with empty values", async () => {
      await fc.assert(
        fc.asyncProperty(queueBEmptyValuesArb, async (invalidObj) => {
          mockChannel.nack.mockClear();
          mockChannel.ack.mockClear();
          mockChannel.consume.mockClear();
          capturedConsumerCallback = null;

          const handler = jest.fn().mockResolvedValue("ack");
          await consumer.consume("file-processing", handler, {
            schema: fileProcessingMessageSchema,
          });

          const msg = createMockMessage(JSON.stringify(invalidObj));
          await capturedConsumerCallback!(msg);

          expect(mockChannel.nack).toHaveBeenCalledWith(msg, false, false);
          expect(handler).not.toHaveBeenCalled();
        }),
        { numRuns: 100 },
      );
    });
  });
});
