import * as amqplib from "amqplib";
import type { ChannelModel, Channel } from "amqplib";
import { metrics } from "@opentelemetry/api";
import { logger } from "@config/logger.js";

export interface ConnectionManagerOptions {
  url: string;
  initialRetryDelay?: number; // Default: 1000ms
  maxRetryDelay?: number; // Default: 30000ms
  maxRetries?: number; // Default: 5
  shutdownTimeout?: number; // Default: 10000ms
}

/**
 * Computes the exponential backoff delay for a given attempt.
 * Exported separately for independent property-based testing.
 *
 * @param attempt - The retry attempt number (1-based)
 * @param initialDelay - The initial delay in milliseconds
 * @param maxDelay - The maximum delay cap in milliseconds
 * @returns The computed delay in milliseconds
 */
export function computeBackoffDelay(
  attempt: number,
  initialDelay: number,
  maxDelay: number,
): number {
  const delay = initialDelay * Math.pow(2, attempt - 1);
  return Math.min(delay, maxDelay);
}

/**
 * Validates that a string is a parseable AMQP URL.
 * Accepts amqp:// and amqps:// schemes.
 */
function validateAmqpUrl(url: string): void {
  if (!url || typeof url !== "string") {
    throw new Error(
      "RabbitMQ connection URL is missing. Set the RABBITMQ_URL environment variable.",
    );
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "amqp:" && parsed.protocol !== "amqps:") {
      throw new Error(
        `Invalid AMQP URL scheme "${parsed.protocol}". Expected "amqp:" or "amqps:".`,
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("Invalid AMQP URL scheme")) {
      throw err;
    }
    throw new Error(
      `Invalid AMQP URL: "${url}". Must be a valid URL with amqp:// or amqps:// scheme.`,
    );
  }
}

const log = logger.child({ module: "ConnectionManager" });

export class ConnectionManager {
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;
  private readonly url: string;
  private readonly initialRetryDelay: number;
  private readonly maxRetryDelay: number;
  private readonly maxRetries: number;
  private readonly shutdownTimeout: number;
  private connected = false;
  private shuttingDown = false;
  private reconnecting = false;
  private consumerTags: string[] = [];

  private readonly reconnectCounter;

  constructor(options: ConnectionManagerOptions) {
    validateAmqpUrl(options.url);

    this.url = options.url;
    this.initialRetryDelay = options.initialRetryDelay ?? 1000;
    this.maxRetryDelay = options.maxRetryDelay ?? 30000;
    this.maxRetries = options.maxRetries ?? 5;
    this.shutdownTimeout = options.shutdownTimeout ?? 10000;

    // OpenTelemetry metric: connection reconnect counter
    const meter = metrics.getMeter("rabbitmq-connection-manager");
    this.reconnectCounter = meter.createCounter("rabbitmq.connection.reconnects", {
      description: "Number of RabbitMQ reconnection attempts",
    });
  }

  /**
   * Establishes an AMQP connection and creates a channel.
   * Retries with exponential backoff on failure.
   */
  async connect(): Promise<void> {
    await this.connectWithRetry();
  }

  /**
   * Returns the current AMQP channel.
   * Throws if not connected.
   */
  getChannel(): Channel {
    if (!this.channel) {
      throw new Error("RabbitMQ channel is not available. Call connect() first.");
    }
    return this.channel;
  }

  /**
   * Returns whether the connection manager is currently connected.
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Registers a consumer tag for graceful shutdown tracking.
   */
  registerConsumerTag(tag: string): void {
    this.consumerTags.push(tag);
  }

  /**
   * Graceful shutdown: cancel consumers → close channel → close connection.
   * Forces termination after the configured shutdown timeout.
   */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    log.info("Initiating graceful shutdown...");

    const shutdownPromise = this.performShutdown();
    const timeoutPromise = new Promise<void>((_, reject) =>
      setTimeout(
        () => reject(new Error("Shutdown timed out")),
        this.shutdownTimeout,
      ),
    );

    try {
      await Promise.race([shutdownPromise, timeoutPromise]);
      log.info("Graceful shutdown completed");
    } catch (err) {
      log.warn({ err }, "Shutdown timed out, forcing connection close");
      await this.forceClose();
    } finally {
      this.connected = false;
      this.connection = null;
      this.channel = null;
    }
  }

  private async performShutdown(): Promise<void> {
    // 1. Cancel all consumers
    if (this.channel && this.consumerTags.length > 0) {
      for (const tag of this.consumerTags) {
        try {
          await this.channel.cancel(tag);
          log.info({ consumerTag: tag }, "Consumer cancelled");
        } catch (err) {
          log.warn({ err, consumerTag: tag }, "Failed to cancel consumer");
        }
      }
      this.consumerTags = [];
    }

    // 2. Close channel
    if (this.channel) {
      try {
        await this.channel.close();
        log.info("Channel closed");
      } catch (err) {
        log.warn({ err }, "Error closing channel");
      }
      this.channel = null;
    }

    // 3. Close connection
    if (this.connection) {
      try {
        await this.connection.close();
        log.info("Connection closed");
      } catch (err) {
        log.warn({ err }, "Error closing connection");
      }
      this.connection = null;
    }
  }

  private async forceClose(): Promise<void> {
    try {
      if (this.connection) {
        await this.connection.close();
      }
    } catch {
      // Force close — ignore errors
    }
  }

  private async connectWithRetry(): Promise<void> {
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        await this.establishConnection();
        return;
      } catch (err) {
        const delay = computeBackoffDelay(
          attempt,
          this.initialRetryDelay,
          this.maxRetryDelay,
        );

        if (attempt === this.maxRetries) {
          log.error(
            { err, attempt, maxRetries: this.maxRetries },
            "Failed to connect to RabbitMQ after maximum retry attempts",
          );
          throw new Error(
            `Failed to connect to RabbitMQ after ${this.maxRetries} attempts: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        log.warn(
          { err, attempt, nextRetryIn: delay },
          "RabbitMQ connection attempt failed, retrying...",
        );

        this.reconnectCounter.add(1);
        await this.sleep(delay);
      }
    }
  }

  private async establishConnection(): Promise<void> {
    this.connection = await amqplib.connect(this.url);
    this.channel = await this.connection.createChannel();
    this.connected = true;

    this.setupEventHandlers();
    log.info("Connected to RabbitMQ");
  }

  private setupEventHandlers(): void {
    if (this.connection) {
      this.connection.on("error", (err) => {
        log.error({ err }, "RabbitMQ connection error");
        this.connected = false;
        this.handleReconnection();
      });

      this.connection.on("close", () => {
        if (!this.shuttingDown) {
          log.warn("RabbitMQ connection closed unexpectedly");
          this.connected = false;
          this.handleReconnection();
        }
      });
    }

    if (this.channel) {
      this.channel.on("error", (err) => {
        log.error({ err }, "RabbitMQ channel error");
        this.channel = null;
        this.handleReconnection();
      });

      this.channel.on("close", () => {
        if (!this.shuttingDown) {
          log.warn("RabbitMQ channel closed unexpectedly");
          this.channel = null;
          this.handleReconnection();
        }
      });
    }
  }

  private handleReconnection(): void {
    if (this.shuttingDown || this.reconnecting) return;
    this.reconnecting = true;

    log.info("Attempting to reconnect to RabbitMQ...");

    this.connectWithRetry()
      .then(() => {
        this.reconnecting = false;
        log.info("Successfully reconnected to RabbitMQ");
      })
      .catch((err) => {
        this.reconnecting = false;
        log.error({ err }, "Failed to reconnect to RabbitMQ");
      });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
