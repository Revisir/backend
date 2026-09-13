import * as fc from "fast-check";
import { QueueConsumer } from "@services/rabbitmq/consumer";
import type { ConnectionManager } from "@services/rabbitmq/connectionManager";
import type { Channel, ConsumeMessage } from "amqplib";

/**
 * Feature: rabbitmq-message-queues, Property 3: Transient errors trigger requeue
 * Validates: Requirements 3.3, 5.4
 *
 * With quorum queues and x-delivery-limit, the broker handles retry counting.
 * The consumer's job is to nack with requeue=true for transient errors, allowing
 * the broker to redeliver and eventually dead-letter after delivery limit is exceeded.
 */

jest.mock("@config/logger", () => ({
  logger: { child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) },
}));

jest.mock("@opentelemetry/api", () => ({
  metrics: { getMeter: () => ({ createCounter: () => ({ add: jest.fn() }) }) },
}));

describe("Feature: rabbitmq-message-queues, Property 3: Transient errors trigger requeue (quorum queues)", () => {
  function createMockMessage(content: object): ConsumeMessage {
    return {
      content: Buffer.from(JSON.stringify(content)),
      fields: {
        deliveryTag: 1,
        redelivered: false,
        exchange: "",
        routingKey: "test-queue",
        consumerTag: "consumer-1",
      },
      properties: {
        contentType: "application/json",
        contentEncoding: undefined,
        headers: {},
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

  function createMockChannel() {
    let consumeCallback: ((msg: ConsumeMessage | null) => void) | null = null;

    const channel = {
      prefetch: jest.fn().mockResolvedValue(undefined),
      consume: jest.fn().mockImplementation((_queue: string, callback: (msg: ConsumeMessage | null) => void) => {
        consumeCallback = callback;
        return Promise.resolve({ consumerTag: "test-consumer-tag" });
      }),
      ack: jest.fn(),
      nack: jest.fn(),
      sendToQueue: jest.fn().mockReturnValue(true),
      cancel: jest.fn().mockResolvedValue(undefined),
    };

    return {
      channel: channel as unknown as Channel,
      getConsumeCallback: () => consumeCallback,
    };
  }

  function createMockConnectionManager(channel: Channel): ConnectionManager {
    return {
      getChannel: () => channel,
      registerConsumerTag: jest.fn(),
      connect: jest.fn(),
      shutdown: jest.fn(),
      isConnected: jest.fn().mockReturnValue(true),
    } as unknown as ConnectionManager;
  }

  it("nack_requeue calls nack with requeue=true (broker handles delivery counting)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({ id: fc.string({ minLength: 1 }), value: fc.integer() }),
        async (payload) => {
          const { channel, getConsumeCallback } = createMockChannel();
          const connectionManager = createMockConnectionManager(channel);
          const consumer = new QueueConsumer(connectionManager);
          const queueName = "test-queue";

          const handler = jest.fn().mockResolvedValue("nack_requeue");

          await consumer.consume(queueName, handler);

          const callback = getConsumeCallback();
          expect(callback).not.toBeNull();

          const mockMsg = createMockMessage(payload);
          await callback!(mockMsg);

          // Verify: nack with requeue=true (broker tracks delivery count via x-delivery-limit)
          expect((channel.nack as jest.Mock)).toHaveBeenCalledWith(mockMsg, false, true);

          // Verify: no manual re-publish (quorum queue handles redelivery)
          expect((channel.sendToQueue as jest.Mock)).not.toHaveBeenCalled();

          // Verify: message was NOT acked
          expect((channel.ack as jest.Mock)).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("nack_reject calls nack with requeue=false (immediate DLQ routing)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({ id: fc.string({ minLength: 1 }), value: fc.integer() }),
        async (payload) => {
          const { channel, getConsumeCallback } = createMockChannel();
          const connectionManager = createMockConnectionManager(channel);
          const consumer = new QueueConsumer(connectionManager);
          const queueName = "test-queue";

          const handler = jest.fn().mockResolvedValue("nack_reject");

          await consumer.consume(queueName, handler);

          const callback = getConsumeCallback();
          const mockMsg = createMockMessage(payload);
          await callback!(mockMsg);

          // Verify: nack without requeue (routes directly to DLQ)
          expect((channel.nack as jest.Mock)).toHaveBeenCalledWith(mockMsg, false, false);

          // Verify: no manual re-publish
          expect((channel.sendToQueue as jest.Mock)).not.toHaveBeenCalled();

          // Verify: message was NOT acked
          expect((channel.ack as jest.Mock)).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("requeues to the same queue regardless of queue name (broker handles it)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0),
        async (queueName) => {
          const { channel, getConsumeCallback } = createMockChannel();
          const connectionManager = createMockConnectionManager(channel);
          const consumer = new QueueConsumer(connectionManager);

          const handler = jest.fn().mockResolvedValue("nack_requeue");

          await consumer.consume(queueName, handler);

          const callback = getConsumeCallback();
          const mockMsg = createMockMessage({ test: "data" });
          await callback!(mockMsg);

          // Verify nack with requeue=true — broker automatically redelivers to the same queue
          expect((channel.nack as jest.Mock)).toHaveBeenCalledWith(mockMsg, false, true);
          // No manual sendToQueue
          expect((channel.sendToQueue as jest.Mock)).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("unhandled handler exceptions default to requeue (transient error assumption)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 100 }),
        async (errorMessage) => {
          const { channel, getConsumeCallback } = createMockChannel();
          const connectionManager = createMockConnectionManager(channel);
          const consumer = new QueueConsumer(connectionManager);

          const handler = jest.fn().mockRejectedValue(new Error(errorMessage));

          await consumer.consume("test-queue", handler);

          const callback = getConsumeCallback();
          const mockMsg = createMockMessage({ test: "data" });
          await callback!(mockMsg);

          // Unhandled errors should default to requeue
          expect((channel.nack as jest.Mock)).toHaveBeenCalledWith(mockMsg, false, true);
          expect((channel.sendToQueue as jest.Mock)).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 100 },
    );
  });
});
