// Mock logger to suppress console noise
jest.mock("@config/logger", () => ({
  logger: {
    child: () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    }),
  },
}));

// Mock OpenTelemetry metrics
jest.mock("@opentelemetry/api", () => ({
  metrics: {
    getMeter: () => ({
      createCounter: () => ({
        add: jest.fn(),
      }),
    }),
  },
}));

// Mock the rabbitmq config
jest.mock("@config/rabbitmq", () => ({
  RABBITMQ_CONFIG: {
    MAX_RETRY_COUNT: 3,
    PREFETCH_COUNT: 1,
  },
}));

import { z } from "zod";
import { QueueConsumer } from "@services/rabbitmq/consumer";
import type { ConnectionManager } from "@services/rabbitmq/connectionManager";
import type { ConsumeMessage } from "amqplib";

function createMockChannel() {
  return {
    prefetch: jest.fn().mockResolvedValue(undefined),
    consume: jest.fn().mockResolvedValue({ consumerTag: "test-consumer-tag" }),
    ack: jest.fn(),
    nack: jest.fn(),
    cancel: jest.fn().mockResolvedValue(undefined),
    sendToQueue: jest.fn().mockReturnValue(true),
  };
}

function createMockConnectionManager(mockChannel = createMockChannel()) {
  return {
    getChannel: jest.fn().mockReturnValue(mockChannel),
    registerConsumerTag: jest.fn(),
  } as unknown as ConnectionManager;
}

function createMockMessage(
  content: object | string,
  headers: Record<string, unknown> = {},
): ConsumeMessage {
  const contentStr = typeof content === "string" ? content : JSON.stringify(content);
  return {
    content: Buffer.from(contentStr),
    fields: {
      deliveryTag: 1,
      redelivered: false,
      exchange: "",
      routingKey: "test-queue",
      consumerTag: "test-consumer-tag",
    },
    properties: {
      headers,
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

describe("QueueConsumer", () => {
  let mockChannel: ReturnType<typeof createMockChannel>;
  let mockConnectionManager: ConnectionManager;
  let consumer: QueueConsumer;

  beforeEach(() => {
    jest.clearAllMocks();
    mockChannel = createMockChannel();
    mockConnectionManager = createMockConnectionManager(mockChannel);
    consumer = new QueueConsumer(mockConnectionManager);
  });

  describe("consume() - prefetch configuration", () => {
    it("should set channel.prefetch(1) when consume() starts", async () => {
      const handler = jest.fn().mockResolvedValue("ack");

      await consumer.consume("test-queue", handler);

      expect(mockChannel.prefetch).toHaveBeenCalledWith(1);
    });

    it("should call prefetch before starting to consume", async () => {
      const callOrder: string[] = [];
      mockChannel.prefetch.mockImplementation(() => {
        callOrder.push("prefetch");
        return Promise.resolve(undefined);
      });
      mockChannel.consume.mockImplementation(() => {
        callOrder.push("consume");
        return Promise.resolve({ consumerTag: "tag" });
      });

      await consumer.consume("test-queue", jest.fn().mockResolvedValue("ack"));

      expect(callOrder[0]).toBe("prefetch");
      expect(callOrder[1]).toBe("consume");
    });
  });

  describe("consume() - ack on success", () => {
    it("should call channel.ack(msg) when handler returns 'ack'", async () => {
      const handler = jest.fn().mockResolvedValue("ack");
      let consumeCallback: (msg: ConsumeMessage | null) => Promise<void>;

      mockChannel.consume.mockImplementation((_queue, cb) => {
        consumeCallback = cb;
        return Promise.resolve({ consumerTag: "test-consumer-tag" });
      });

      await consumer.consume("test-queue", handler);

      const msg = createMockMessage({ topicId: "t1", userId: "u1", urls: ["https://example.com"] });
      await consumeCallback!(msg);

      expect(mockChannel.ack).toHaveBeenCalledWith(msg);
    });

    it("should not call nack when handler returns 'ack'", async () => {
      const handler = jest.fn().mockResolvedValue("ack");
      let consumeCallback: (msg: ConsumeMessage | null) => Promise<void>;

      mockChannel.consume.mockImplementation((_queue, cb) => {
        consumeCallback = cb;
        return Promise.resolve({ consumerTag: "test-consumer-tag" });
      });

      await consumer.consume("test-queue", handler);

      const msg = createMockMessage({ data: "valid" });
      await consumeCallback!(msg);

      expect(mockChannel.nack).not.toHaveBeenCalled();
    });
  });

  describe("consume() - schema validation failure", () => {
    it("should nack without requeue when message fails schema validation", async () => {
      const schema = z.object({
        topicId: z.string().min(1),
        userId: z.string().min(1),
      });
      const handler = jest.fn().mockResolvedValue("ack");
      let consumeCallback: (msg: ConsumeMessage | null) => Promise<void>;

      mockChannel.consume.mockImplementation((_queue, cb) => {
        consumeCallback = cb;
        return Promise.resolve({ consumerTag: "test-consumer-tag" });
      });

      await consumer.consume("test-queue", handler, { schema });

      // Message with invalid data (missing userId)
      const msg = createMockMessage({ topicId: "t1" });
      await consumeCallback!(msg);

      expect(mockChannel.nack).toHaveBeenCalledWith(msg, false, false);
    });

    it("should not call the handler when schema validation fails", async () => {
      const schema = z.object({
        topicId: z.string().min(1),
        userId: z.string().min(1),
      });
      const handler = jest.fn().mockResolvedValue("ack");
      let consumeCallback: (msg: ConsumeMessage | null) => Promise<void>;

      mockChannel.consume.mockImplementation((_queue, cb) => {
        consumeCallback = cb;
        return Promise.resolve({ consumerTag: "test-consumer-tag" });
      });

      await consumer.consume("test-queue", handler, { schema });

      const msg = createMockMessage({ topicId: "" }); // empty string fails min(1)
      await consumeCallback!(msg);

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("consume() - nack_requeue behavior", () => {
    it("should nack with requeue=true when handler returns 'nack_requeue'", async () => {
      const handler = jest.fn().mockResolvedValue("nack_requeue");
      let consumeCallback: (msg: ConsumeMessage | null) => Promise<void>;

      mockChannel.consume.mockImplementation((_queue, cb) => {
        consumeCallback = cb;
        return Promise.resolve({ consumerTag: "test-consumer-tag" });
      });

      await consumer.consume("test-queue", handler);

      const msg = createMockMessage({ data: "valid" });
      await consumeCallback!(msg);

      // Quorum queue handles delivery count tracking — consumer just requeues
      expect(mockChannel.nack).toHaveBeenCalledWith(msg, false, true);
    });

    it("should not call sendToQueue when requeuing (broker handles redelivery)", async () => {
      const handler = jest.fn().mockResolvedValue("nack_requeue");
      let consumeCallback: (msg: ConsumeMessage | null) => Promise<void>;

      mockChannel.consume.mockImplementation((_queue, cb) => {
        consumeCallback = cb;
        return Promise.resolve({ consumerTag: "test-consumer-tag" });
      });

      await consumer.consume("test-queue", handler);

      const msg = createMockMessage({ data: "valid" });
      await consumeCallback!(msg);

      expect(mockChannel.sendToQueue).not.toHaveBeenCalled();
    });
  });

  describe("consume() - consumer tag registration", () => {
    it("should register consumer tag with ConnectionManager", async () => {
      const handler = jest.fn().mockResolvedValue("ack");

      await consumer.consume("test-queue", handler);

      expect(
        (mockConnectionManager as any).registerConsumerTag,
      ).toHaveBeenCalledWith("test-consumer-tag");
    });

    it("should return the consumer tag from consume()", async () => {
      const handler = jest.fn().mockResolvedValue("ack");

      const tag = await consumer.consume("test-queue", handler);

      expect(tag).toBe("test-consumer-tag");
    });
  });

  describe("cancel()", () => {
    it("should call channel.cancel(consumerTag) when cancelling", async () => {
      const handler = jest.fn().mockResolvedValue("ack");
      await consumer.consume("test-queue", handler);

      await consumer.cancel();

      expect(mockChannel.cancel).toHaveBeenCalledWith("test-consumer-tag");
    });

    it("should not throw when no active consumer exists", async () => {
      // cancel without prior consume
      await expect(consumer.cancel()).resolves.not.toThrow();
    });
  });

  describe("consume() - invalid JSON", () => {
    it("should nack without requeue when message content is not valid JSON", async () => {
      const handler = jest.fn().mockResolvedValue("ack");
      let consumeCallback: (msg: ConsumeMessage | null) => Promise<void>;

      mockChannel.consume.mockImplementation((_queue, cb) => {
        consumeCallback = cb;
        return Promise.resolve({ consumerTag: "test-consumer-tag" });
      });

      await consumer.consume("test-queue", handler);

      // Create a message with invalid JSON content
      const msg = {
        content: Buffer.from("not valid json {{{"),
        fields: {
          deliveryTag: 1,
          redelivered: false,
          exchange: "",
          routingKey: "test-queue",
          consumerTag: "test-consumer-tag",
        },
        properties: {
          headers: {},
          contentType: "application/json",
        },
      } as unknown as ConsumeMessage;

      await consumeCallback!(msg);

      expect(mockChannel.nack).toHaveBeenCalledWith(msg, false, false);
    });

    it("should not call the handler when message is invalid JSON", async () => {
      const handler = jest.fn().mockResolvedValue("ack");
      let consumeCallback: (msg: ConsumeMessage | null) => Promise<void>;

      mockChannel.consume.mockImplementation((_queue, cb) => {
        consumeCallback = cb;
        return Promise.resolve({ consumerTag: "test-consumer-tag" });
      });

      await consumer.consume("test-queue", handler);

      const msg = {
        content: Buffer.from("not valid json"),
        fields: {
          deliveryTag: 1,
          redelivered: false,
          exchange: "",
          routingKey: "test-queue",
          consumerTag: "test-consumer-tag",
        },
        properties: {
          headers: {},
          contentType: "application/json",
        },
      } as unknown as ConsumeMessage;

      await consumeCallback!(msg);

      expect(handler).not.toHaveBeenCalled();
    });
  });
});
