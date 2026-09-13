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
    DLX_EXCHANGE: "dlx",
    MAX_RETRY_COUNT: 3,
  },
}));

import { QueuePublisher } from "@services/rabbitmq/publisher";
import type { ConnectionManager } from "@services/rabbitmq/connectionManager";

function createMockChannel() {
  return {
    assertQueue: jest.fn().mockResolvedValue({ queue: "test-queue" }),
    assertExchange: jest.fn().mockResolvedValue({}),
    bindQueue: jest.fn().mockResolvedValue({}),
    publish: jest.fn().mockReturnValue(true),
    sendToQueue: jest.fn().mockReturnValue(true),
  };
}

function createMockConnectionManager(mockChannel = createMockChannel()) {
  return {
    getChannel: jest.fn().mockReturnValue(mockChannel),
  } as unknown as ConnectionManager;
}

const DEFAULT_CONFIG = {
  queue: "url_processing",
  exchange: "url_processing-exchange",
  routingKey: "url_processing",
  dlqName: "url_processing.dlq",
};

describe("QueuePublisher", () => {
  let mockChannel: ReturnType<typeof createMockChannel>;
  let mockConnectionManager: ConnectionManager;
  let publisher: QueuePublisher;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockChannel = createMockChannel();
    mockConnectionManager = createMockConnectionManager(mockChannel);
    QueuePublisher.setConnectionManager(mockConnectionManager);
    publisher = await new QueuePublisher(DEFAULT_CONFIG).init();
  });

  describe("create() - queue declaration", () => {
    it("should declare the main queue as quorum with durable: true", () => {
      const mainQueueCall = mockChannel.assertQueue.mock.calls.find(
        (call) => call[0] === "url_processing",
      );

      expect(mainQueueCall).toBeDefined();
      expect(mainQueueCall![1]).toEqual(
        expect.objectContaining({
          durable: true,
          arguments: expect.objectContaining({
            "x-queue-type": "quorum",
          }),
        }),
      );
    });

    it("should declare the main queue with DLX and delivery limit arguments", () => {
      const mainQueueCall = mockChannel.assertQueue.mock.calls.find(
        (call) => call[0] === "url_processing",
      );

      expect(mainQueueCall![1].arguments).toEqual(
        expect.objectContaining({
          "x-dead-letter-exchange": "dlx",
          "x-dead-letter-routing-key": "url_processing.dlq",
          "x-delivery-limit": 3,
        }),
      );
    });

    it("should declare the DLQ as a quorum queue", () => {
      const dlqCall = mockChannel.assertQueue.mock.calls.find(
        (call) => call[0] === "url_processing.dlq",
      );

      expect(dlqCall).toBeDefined();
      expect(dlqCall![1]).toEqual({
        durable: true,
        arguments: { "x-queue-type": "quorum" },
      });
    });

    it("should assert DLX exchange as direct and durable", () => {
      expect(mockChannel.assertExchange).toHaveBeenCalledWith(
        "dlx",
        "direct",
        { durable: true },
      );
    });

    it("should assert the named exchange as direct and durable", () => {
      expect(mockChannel.assertExchange).toHaveBeenCalledWith(
        "url_processing-exchange",
        "direct",
        { durable: true },
      );
    });

    it("should bind the main queue to the named exchange with routing key", () => {
      expect(mockChannel.bindQueue).toHaveBeenCalledWith(
        "url_processing",
        "url_processing-exchange",
        "url_processing",
      );
    });

    it("should bind the DLQ to the DLX exchange", () => {
      expect(mockChannel.bindQueue).toHaveBeenCalledWith(
        "url_processing.dlq",
        "dlx",
        "url_processing.dlq",
      );
    });

    it("should default dlqName to queue.dlq when not provided", async () => {
      mockChannel = createMockChannel();
      mockConnectionManager = createMockConnectionManager(mockChannel);
      QueuePublisher.setConnectionManager(mockConnectionManager);

      await QueuePublisher.create({
        queue: "file_processing",
        exchange: "file_processing-exchange",
        routingKey: "file_processing",
      });

      const dlqCall = mockChannel.assertQueue.mock.calls.find(
        (call) => call[0] === "file_processing.dlq",
      );
      expect(dlqCall).toBeDefined();
    });
  });

  describe("publish() - persistent delivery mode", () => {
    it("should publish messages with persistent: true", async () => {
      const result = await publisher.publish({
        message: { topicId: "t1", userId: "u1", urls: ["https://example.com"] },
      });

      expect(result).toBe(true);
      expect(mockChannel.publish).toHaveBeenCalledWith(
        "url_processing-exchange",
        "url_processing",
        expect.any(Buffer),
        expect.objectContaining({ persistent: true }),
      );
    });
  });

  describe("publish() - content-type header", () => {
    it("should publish messages with contentType: application/json", async () => {
      await publisher.publish({
        message: { bucket: "uploads", key: "file.pdf" },
      });

      expect(mockChannel.publish).toHaveBeenCalledWith(
        "url_processing-exchange",
        "url_processing",
        expect.any(Buffer),
        expect.objectContaining({ contentType: "application/json" }),
      );
    });
  });

  describe("publish() - message serialization", () => {
    it("should serialize message to JSON Buffer", async () => {
      const message = { topicId: "t1", userId: "u1", urls: ["https://example.com"] };

      await publisher.publish({ message });

      const sentBuffer = mockChannel.publish.mock.calls[0][2] as Buffer;
      expect(JSON.parse(sentBuffer.toString())).toEqual(message);
    });

    it("should pass custom headers when provided", async () => {
      await publisher.publish({
        message: { topicId: "t1" },
        headers: { "x-custom": "value" },
      });

      expect(mockChannel.publish).toHaveBeenCalledWith(
        "url_processing-exchange",
        "url_processing",
        expect.any(Buffer),
        expect.objectContaining({ headers: { "x-custom": "value" } }),
      );
    });

    it("should default headers to empty object when not provided", async () => {
      await publisher.publish({
        message: { topicId: "t1" },
      });

      expect(mockChannel.publish).toHaveBeenCalledWith(
        "url_processing-exchange",
        "url_processing",
        expect.any(Buffer),
        expect.objectContaining({ headers: {} }),
      );
    });
  });

  describe("publish() - uses configured exchange and routing key", () => {
    it("should always publish to the configured exchange and routing key", async () => {
      await publisher.publish({ message: { data: "test" } });

      expect(mockChannel.publish).toHaveBeenCalledWith(
        "url_processing-exchange",
        "url_processing",
        expect.any(Buffer),
        expect.any(Object),
      );
    });
  });

  describe("publish() - failure handling", () => {
    it("should return false when channel.publish throws an error", async () => {
      mockChannel.publish.mockImplementation(() => {
        throw new Error("Channel closed");
      });

      const result = await publisher.publish({
        message: { topicId: "t1" },
      });

      expect(result).toBe(false);
    });

    it("should not throw when channel.publish throws", async () => {
      mockChannel.publish.mockImplementation(() => {
        throw new Error("Channel closed");
      });

      await expect(
        publisher.publish({ message: { topicId: "t1" } }),
      ).resolves.not.toThrow();
    });

    it("should return true when channel.publish returns false (buffer full)", async () => {
      mockChannel.publish.mockReturnValue(false);

      const result = await publisher.publish({
        message: { topicId: "t1" },
      });

      expect(result).toBe(true);
    });
  });

  describe("constructor + init() - validation", () => {
    it("should throw if setConnectionManager was not called", () => {
      // Reset the static by setting to undefined
      (QueuePublisher as any).connectionManager = undefined;

      expect(() => new QueuePublisher(DEFAULT_CONFIG)).toThrow(
        "QueuePublisher.setConnectionManager() must be called before creating instances",
      );
    });
  });
});
