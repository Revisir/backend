// Mock amqplib
jest.mock("amqplib", () => ({
  connect: jest.fn(),
}));

// Mock logger to suppress console noise
jest.mock("@config/logger", () => ({
  logger: {
    child: () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
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

import { ConnectionManager } from "@services/rabbitmq/connectionManager";
import * as amqplib from "amqplib";

const mockConnect = amqplib.connect as jest.MockedFunction<typeof amqplib.connect>;

function createMockChannel() {
  return {
    close: jest.fn().mockResolvedValue(undefined),
    cancel: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
  };
}

function createMockConnection(mockChannel = createMockChannel()) {
  return {
    createChannel: jest.fn().mockResolvedValue(mockChannel),
    close: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
  };
}

describe("ConnectionManager", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("constructor - URL validation", () => {
    it("should throw immediately if URL is missing", () => {
      expect(() => new ConnectionManager({ url: "" })).toThrow(
        "RabbitMQ connection URL is missing",
      );
    });

    it("should throw immediately if URL is not a valid AMQP URL", () => {
      expect(() => new ConnectionManager({ url: "http://localhost:5672" })).toThrow(
        'Invalid AMQP URL scheme',
      );
    });

    it("should throw for completely unparseable URL", () => {
      expect(() => new ConnectionManager({ url: "not-a-url" })).toThrow(
        "Invalid AMQP URL",
      );
    });

    it("should accept a valid amqp:// URL", () => {
      expect(
        () => new ConnectionManager({ url: "amqp://guest:guest@localhost:5672" }),
      ).not.toThrow();
    });

    it("should accept a valid amqps:// URL", () => {
      expect(
        () => new ConnectionManager({ url: "amqps://guest:guest@broker.example.com" }),
      ).not.toThrow();
    });
  });

  describe("connect - successful connection", () => {
    it("should establish connection and report isConnected() as true", async () => {
      const mockChannel = createMockChannel();
      const mockConnection = createMockConnection(mockChannel);
      mockConnect.mockResolvedValue(mockConnection as any);

      const manager = new ConnectionManager({
        url: "amqp://localhost:5672",
      });

      await manager.connect();

      expect(manager.isConnected()).toBe(true);
      expect(mockConnect).toHaveBeenCalledWith("amqp://localhost:5672");
      expect(mockConnection.createChannel).toHaveBeenCalled();
    });

    it("should return the channel via getChannel() after connecting", async () => {
      const mockChannel = createMockChannel();
      const mockConnection = createMockConnection(mockChannel);
      mockConnect.mockResolvedValue(mockConnection as any);

      const manager = new ConnectionManager({
        url: "amqp://localhost:5672",
      });

      await manager.connect();

      expect(manager.getChannel()).toBe(mockChannel);
    });

    it("should throw from getChannel() if not connected", () => {
      const manager = new ConnectionManager({
        url: "amqp://localhost:5672",
      });

      expect(() => manager.getChannel()).toThrow(
        "RabbitMQ channel is not available. Call connect() first.",
      );
    });
  });

  describe("connect - max retry exhaustion", () => {
    it("should throw after max retries when connection always fails", async () => {
      jest.useRealTimers();
      mockConnect.mockRejectedValue(new Error("ECONNREFUSED"));

      const manager = new ConnectionManager({
        url: "amqp://localhost:5672",
        maxRetries: 3,
        initialRetryDelay: 1,
        maxRetryDelay: 10,
      });

      await expect(manager.connect()).rejects.toThrow(
        "Failed to connect to RabbitMQ after 3 attempts",
      );

      expect(mockConnect).toHaveBeenCalledTimes(3);
    });

    it("should include original error message in the thrown error", async () => {
      jest.useRealTimers();
      mockConnect.mockRejectedValue(new Error("Connection refused by peer"));

      const manager = new ConnectionManager({
        url: "amqp://localhost:5672",
        maxRetries: 1,
        initialRetryDelay: 1,
      });

      await expect(manager.connect()).rejects.toThrow("Connection refused by peer");
    });
  });

  describe("shutdown - ordering", () => {
    it("should cancel consumers first, then close channel, then close connection", async () => {
      const callOrder: string[] = [];

      const mockChannel = {
        close: jest.fn().mockImplementation(() => {
          callOrder.push("channel.close");
          return Promise.resolve();
        }),
        cancel: jest.fn().mockImplementation(() => {
          callOrder.push("channel.cancel");
          return Promise.resolve();
        }),
        on: jest.fn(),
      };

      const mockConnection = {
        createChannel: jest.fn().mockResolvedValue(mockChannel),
        close: jest.fn().mockImplementation(() => {
          callOrder.push("connection.close");
          return Promise.resolve();
        }),
        on: jest.fn(),
      };

      mockConnect.mockResolvedValue(mockConnection as any);

      const manager = new ConnectionManager({
        url: "amqp://localhost:5672",
        shutdownTimeout: 5000,
      });

      await manager.connect();

      // Register consumer tags to test cancel ordering
      manager.registerConsumerTag("consumer-1");
      manager.registerConsumerTag("consumer-2");

      await manager.shutdown();

      expect(callOrder).toEqual([
        "channel.cancel",
        "channel.cancel",
        "channel.close",
        "connection.close",
      ]);
    });

    it("should set isConnected() to false after shutdown", async () => {
      const mockChannel = createMockChannel();
      const mockConnection = createMockConnection(mockChannel);
      mockConnect.mockResolvedValue(mockConnection as any);

      const manager = new ConnectionManager({
        url: "amqp://localhost:5672",
      });

      await manager.connect();
      expect(manager.isConnected()).toBe(true);

      await manager.shutdown();
      expect(manager.isConnected()).toBe(false);
    });
  });

  describe("shutdown - timeout enforcement", () => {
    it("should force-close connection when shutdown exceeds timeout", async () => {
      const mockChannel = {
        close: jest.fn().mockImplementation(
          // Simulate a slow close that never resolves
          () => new Promise(() => {}),
        ),
        cancel: jest.fn().mockResolvedValue(undefined),
        on: jest.fn(),
      };

      const mockConnection = {
        createChannel: jest.fn().mockResolvedValue(mockChannel),
        close: jest.fn().mockResolvedValue(undefined),
        on: jest.fn(),
      };

      mockConnect.mockResolvedValue(mockConnection as any);

      const manager = new ConnectionManager({
        url: "amqp://localhost:5672",
        shutdownTimeout: 2000,
      });

      await manager.connect();

      const shutdownPromise = manager.shutdown();

      // Advance past the shutdown timeout
      await jest.advanceTimersByTimeAsync(2000);

      await shutdownPromise;

      // Force close should have been called on the connection
      expect(mockConnection.close).toHaveBeenCalled();
      expect(manager.isConnected()).toBe(false);
    });
  });
});
