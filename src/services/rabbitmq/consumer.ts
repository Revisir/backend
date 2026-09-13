import type { Channel, ConsumeMessage } from "amqplib";
import type { z } from "zod";
import { metrics } from "@opentelemetry/api";
import { logger } from "@config/logger.js";
import { RABBITMQ_CONFIG } from "@config/rabbitmq.js";
import type { ConnectionManager } from "./connectionManager.js";

export type MessageOutcome = "ack" | "nack_requeue" | "nack_reject";

export type MessageHandler = (
  msg: ConsumeMessage,
) => Promise<MessageOutcome>;

export interface ConsumeOptions {
  schema?: z.ZodSchema;
}

const log = logger.child({ module: "QueueConsumer" });

/**
 * Subscribes to a RabbitMQ quorum queue and dispatches messages to a handler.
 *
 * Quorum queues track delivery count natively via x-delivery-limit.
 * After exceeding the limit, messages are automatically dead-lettered by the broker.
 *
 * Responsibilities:
 * - Set prefetch to 1
 * - Parse JSON messages, validate with provided schema, pass to handler
 * - Ack/nack based on handler result
 * - On nack_requeue: requeue the message (broker increments delivery count)
 * - On nack_reject: reject without requeue (immediately routes to DLQ)
 * - Record `rabbitmq.messages.consumed` metric with queue name and outcome
 */
export class QueueConsumer {
  private readonly connectionManager: ConnectionManager;
  private readonly consumedCounter;
  private consumerTag: string | null = null;

  constructor(connectionManager: ConnectionManager) {
    this.connectionManager = connectionManager;

    const meter = metrics.getMeter("rabbitmq-consumer");
    this.consumedCounter = meter.createCounter("rabbitmq.messages.consumed", {
      description: "Number of messages consumed from RabbitMQ queues",
    });
  }

  /**
   * Begins consuming messages from the specified quorum queue.
   *
   * 1. Sets prefetch to PREFETCH_COUNT (1) on the channel
   * 2. Calls channel.consume() with a wrapper that:
   *    a. Parses the message content as JSON
   *    b. If schema provided, validates with it — on failure, nack without requeue (to DLQ)
   *    c. Calls the handler with the message
   *    d. Based on handler return: ack, nack+requeue (broker tracks delivery count), or nack+reject
   * 3. Records rabbitmq.messages.consumed metric with queue name and outcome
   * 4. Registers the consumer tag with the ConnectionManager
   * 5. Returns the consumer tag
   */
  async consume(
    queue: string,
    handler: MessageHandler,
    options?: ConsumeOptions,
  ): Promise<string> {
    const channel = this.connectionManager.getChannel();
    const schema = options?.schema;

    // 1. Set prefetch
    await channel.prefetch(RABBITMQ_CONFIG.PREFETCH_COUNT);

    // 2. Start consuming
    const response = await channel.consume(queue, async (msg) => {
      if (!msg) {
        // Consumer was cancelled by the broker
        log.warn({ queue }, "Consumer cancelled by broker (null message)");
        return;
      }

      await this.handleMessage(channel, msg, handler, queue, schema);
    });

    this.consumerTag = response.consumerTag;

    // 4. Register consumer tag with ConnectionManager
    this.connectionManager.registerConsumerTag(this.consumerTag);

    log.info({ queue, consumerTag: this.consumerTag }, "Consumer started");
    return this.consumerTag;
  }

  /**
   * Cancels the consumer via its tag.
   */
  async cancel(): Promise<void> {
    if (!this.consumerTag) {
      log.warn("No active consumer to cancel");
      return;
    }

    try {
      const channel = this.connectionManager.getChannel();
      await channel.cancel(this.consumerTag);
      log.info({ consumerTag: this.consumerTag }, "Consumer cancelled");
    } catch (err) {
      log.error({ err, consumerTag: this.consumerTag }, "Failed to cancel consumer");
      throw err;
    } finally {
      this.consumerTag = null;
    }
  }

  private async handleMessage(
    channel: Channel,
    msg: ConsumeMessage,
    handler: MessageHandler,
    queue: string,
    schema?: z.ZodSchema,
  ): Promise<void> {
    // a. Parse JSON
    let parsedContent: unknown;
    try {
      parsedContent = JSON.parse(msg.content.toString());
    } catch (err) {
      log.error({ err, queue }, "Failed to parse message as JSON");
      this.nackReject(channel, msg, queue);
      return;
    }

    // b. Validate with schema if provided
    if (schema) {
      const result = schema.safeParse(parsedContent);
      if (!result.success) {
        log.error(
          { queue, errors: result.error.issues },
          "Message failed schema validation",
        );
        this.nackReject(channel, msg, queue);
        return;
      }
    }

    // c. Call the handler
    let outcome: MessageOutcome;
    try {
      outcome = await handler(msg);
    } catch (err) {
      log.error({ err, queue }, "Handler threw an unexpected error");
      outcome = "nack_requeue";
    }

    // d. Act on outcome
    switch (outcome) {
      case "ack":
        channel.ack(msg);
        this.recordMetric(queue, "ack");
        break;
      case "nack_requeue":
        // Requeue the message — quorum queue tracks delivery count internally
        // and will auto-dead-letter after x-delivery-limit is reached
        channel.nack(msg, false, true);
        this.recordMetric(queue, "nack_requeue");
        log.debug({ queue }, "Message requeued (broker tracks delivery count)");
        break;
      case "nack_reject":
        this.nackReject(channel, msg, queue);
        break;
    }
  }

  /**
   * Nack without requeue — routes message to DLQ via dead-letter exchange.
   */
  private nackReject(channel: Channel, msg: ConsumeMessage, queue: string): void {
    channel.nack(msg, false, false);
    this.recordMetric(queue, "nack_reject");
  }

  /**
   * Records the rabbitmq.messages.consumed metric.
   */
  private recordMetric(queue: string, outcome: MessageOutcome): void {
    this.consumedCounter.add(1, {
      queue,
      outcome,
    });
  }
}
