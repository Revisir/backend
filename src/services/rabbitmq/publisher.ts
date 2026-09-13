import { metrics } from "@opentelemetry/api";
import { logger } from "@config/logger.js";
import { RABBITMQ_CONFIG } from "@config/rabbitmq.js";
import type { ConnectionManager } from "./connectionManager.js";

export interface QueueConfig {
  queue: string;
  exchange: string;
  routingKey: string;
  dlqName?: string;
}

export interface PublishOptions {
  message: object;
  headers?: Record<string, string | number>;
}

const log = logger.child({ module: "QueuePublisher" });

/**
 * Publishes messages to a specific RabbitMQ quorum queue.
 *
 * Each instance is bound to a single queue (configured at construction time).
 * The shared ConnectionManager is set once via the static method.
 *
 * Usage:
 *   QueuePublisher.setConnectionManager(cm);
 *   const publisher = await new QueuePublisher({ queue, exchange, routingKey }).init();
 *   await publisher.publish({ message: { ... } });
 */
export class QueuePublisher {
  private static connectionManager: ConnectionManager;

  private readonly queue: string;
  private readonly exchange: string;
  private readonly routingKey: string;
  private readonly dlqName: string;
  private readonly publishedCounter;

  /**
   * Sets the shared ConnectionManager for all QueuePublisher instances.
   * Must be called once before creating any publisher.
   */
  static setConnectionManager(cm: ConnectionManager): void {
    QueuePublisher.connectionManager = cm;
  }

  constructor(config: QueueConfig) {
    if (!QueuePublisher.connectionManager) {
      throw new Error("QueuePublisher.setConnectionManager() must be called before creating instances");
    }

    this.queue = config.queue;
    this.exchange = config.exchange;
    this.routingKey = config.routingKey;
    this.dlqName = config.dlqName ?? `${config.queue}.dlq`;

    const meter = metrics.getMeter("rabbitmq-publisher");
    this.publishedCounter = meter.createCounter("rabbitmq.messages.published", {
      description: "Number of messages published to RabbitMQ queues",
    });
  }

  /**
   * Declares the quorum queue with built-in dead-letter routing and delivery limits.
   * Must be awaited after construction before publishing.
   *
   * Returns `this` for chaining: `await new QueuePublisher(config).init()`
   */
  async init(): Promise<this> {
    const channel = QueuePublisher.connectionManager.getChannel();
    const dlxExchange = RABBITMQ_CONFIG.DLX_EXCHANGE;

    // 1. Assert the dead-letter exchange (direct, durable)
    await channel.assertExchange(dlxExchange, "direct", { durable: true });

    // 2. Assert the DLQ as a quorum queue
    await channel.assertQueue(this.dlqName, {
      durable: true,
      arguments: {
        "x-queue-type": "quorum",
      },
    });

    // 3. Bind the DLQ to the DLX exchange
    await channel.bindQueue(this.dlqName, dlxExchange, this.dlqName);

    // 4. Assert the main queue as a quorum queue with DLX and delivery limit
    await channel.assertQueue(this.queue, {
      durable: true,
      arguments: {
        "x-queue-type": "quorum",
        "x-dead-letter-exchange": dlxExchange,
        "x-dead-letter-routing-key": this.dlqName,
        "x-delivery-limit": RABBITMQ_CONFIG.MAX_RETRY_COUNT,
      },
    });

    // 5. Assert the named exchange and bind the main queue
    await channel.assertExchange(this.exchange, "direct", { durable: true });
    await channel.bindQueue(this.queue, this.exchange, this.routingKey);

    log.info(
      { queue: this.queue, exchange: this.exchange, routingKey: this.routingKey, dlqName: this.dlqName, dlxExchange, deliveryLimit: RABBITMQ_CONFIG.MAX_RETRY_COUNT },
      "Quorum queue declared",
    );

    return this;
  }

  /**
   * Publishes a message to this publisher's configured exchange/queue.
   *
   * @returns true on success, false on failure
   */
  async publish(options: PublishOptions): Promise<boolean> {
    const { message, headers } = options;

    try {
      const channel = QueuePublisher.connectionManager.getChannel();
      const content = Buffer.from(JSON.stringify(message));

      const published = channel.publish(this.exchange, this.routingKey, content, {
        persistent: true,
        contentType: "application/json",
        headers: headers ?? {},
      });

      if (!published) {
        log.warn({ queue: this.queue, exchange: this.exchange }, "Channel write buffer full, message may be buffered");
      }

      this.publishedCounter.add(1, { queue: this.queue, success: "true" });
      log.debug({ queue: this.queue, exchange: this.exchange, routingKey: this.routingKey, messageSize: content.length }, "Message published");
      return true;
    } catch (err) {
      log.error({ err, queue: this.queue, exchange: this.exchange }, "Failed to publish message");
      this.publishedCounter.add(1, { queue: this.queue, success: "false" });
      return false;
    }
  }
}
