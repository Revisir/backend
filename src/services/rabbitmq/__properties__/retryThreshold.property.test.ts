import * as fc from "fast-check";
import type { Channel, ConsumeMessage, Replies } from "amqplib";
import { QueueConsumer } from "@services/rabbitmq/consumer";
import type { ConnectionManager } from "@services/rabbitmq/connectionManager";

/**
 * Feature: rabbitmq-message-queues, Property 5: Quorum queue requeue behavior
 * Validates: Requirements 3.5, 5.6
 *
 * With quorum queues and x-delivery-limit, the broker tracks delivery count internally
 * and automatically dead-letters messages after the limit is exceeded. The consumer's
 * responsibility is to nack with requeue=true for retryable failures, and nack with
 * requeue=false for non-retryable failures (immediate DLQ routing).
 */
describe("Feature: rabbitmq-message-queues, Property 5: Quorum queue requeue behavior", () => {
  function createMockChannel(): Channel {
    return {
      prefetch: jest.fn().mockResolvedValue(undefined),
      consume: jest.fn().mockImplementation((_queue, callback) => {
        return Promise.resolve({ consumerTag: "test-tag" } as Replies.Consume);
      }),
      ack: jest.fn(),
      nack: jest.fn(),
      sendToQueue: jest.fn().mockReturnValue(true),
      cancel: jest.fn().mockResolvedValue(undefined),
    } as unknown as Channel;
  }

  function createMockConnectionManager(channel: Channel): ConnectionManager {
    return {
      getChannel: () => channel,
      registerConsumerTag: jest.fn(),
    } as unknown as ConnectionManager;
  }

  function createMessage(content: object): ConsumeMessage {
    return {
      content: Buffer.from(JSON.stringify(content)),
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

  it("nack_requeue always requeues the message (broker tracks delivery count)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({ id: fc.string({ minLength: 1 }), value: fc.integer() }),
        async (payload) => {
          const mockChannel = createMockChannel();
          const mockConnectionManager = createMockConnectionManager(mockChannel);
          const consumer = new QueueConsumer(mockConnectionManager);

          const handler = jest.fn().mockResolvedValue("nack_requeue");

          await consumer.consume("test-queue", handler);

          const consumeCallback = (mockChannel.consume as jest.Mock).mock.calls[0][1];
          const msg = createMessage(payload);
          await consumeCallback(msg);

          // Consumer should nack with requeue=true, letting broker handle delivery count
          expect(mockChannel.nack).toHaveBeenCalledWith(msg, false, true);
          // Should NOT re-publish manually (no sendToQueue)
          expect(mockChannel.sendToQueue).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("nack_reject always rejects without requeue (immediate DLQ)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({ id: fc.string({ minLength: 1 }), value: fc.integer() }),
        async (payload) => {
          const mockChannel = createMockChannel();
          const mockConnectionManager = createMockConnectionManager(mockChannel);
          const consumer = new QueueConsumer(mockConnectionManager);

          const handler = jest.fn().mockResolvedValue("nack_reject");

          await consumer.consume("test-queue", handler);

          const consumeCallback = (mockChannel.consume as jest.Mock).mock.calls[0][1];
          const msg = createMessage(payload);
          await consumeCallback(msg);

          // Consumer should nack with requeue=false, routing to DLQ immediately
          expect(mockChannel.nack).toHaveBeenCalledWith(msg, false, false);
          expect(mockChannel.sendToQueue).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("handler exceptions cause requeue (retryable by default)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 200 }),
        async (errorMessage) => {
          const mockChannel = createMockChannel();
          const mockConnectionManager = createMockConnectionManager(mockChannel);
          const consumer = new QueueConsumer(mockConnectionManager);

          const handler = jest.fn().mockRejectedValue(new Error(errorMessage));

          await consumer.consume("test-queue", handler);

          const consumeCallback = (mockChannel.consume as jest.Mock).mock.calls[0][1];
          const msg = createMessage({ test: "data" });
          await consumeCallback(msg);

          // Unhandled exceptions default to nack_requeue
          expect(mockChannel.nack).toHaveBeenCalledWith(msg, false, true);
          expect(mockChannel.sendToQueue).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 100 },
    );
  });
});
