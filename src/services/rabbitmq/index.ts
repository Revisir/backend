export { ConnectionManager, computeBackoffDelay } from "@services/rabbitmq/connectionManager.js";
export type { ConnectionManagerOptions } from "@services/rabbitmq/connectionManager.js";
export { QueuePublisher } from "@services/rabbitmq/publisher.js";
export type { PublishOptions, QueueConfig } from "@services/rabbitmq/publisher.js";
export { QueueConsumer } from "@services/rabbitmq/consumer.js";
export type { MessageHandler, MessageOutcome, ConsumeOptions } from "@services/rabbitmq/consumer.js";

import { ConnectionManager } from "@services/rabbitmq/connectionManager.js";
import { QueuePublisher } from "@services/rabbitmq/publisher.js";
import { RABBITMQ_CONFIG, RABBITMQ_URL } from "@config/rabbitmq.js";

/**
 * Static registry holding initialized publisher instances.
 * Access publishers from anywhere without passing them around.
 *
 * Usage:
 *   await initRabbitMQ();
 *   Publishers.url.publish({ message: { ... } });
 */
export class Publishers {
  static url: QueuePublisher;
  static file: QueuePublisher;
  /** Set in the API by initRabbitMQ, and in each worker process by its consumer startup. */
  static questionBank?: QueuePublisher;
  static connectionManager: ConnectionManager;
}

/** Declares the question-bank queue and returns its publisher. */
export async function initQuestionBankPublisher(): Promise<QueuePublisher> {
  return new QueuePublisher({
    queue: RABBITMQ_CONFIG.QUESTION_BANK_QUEUE,
    exchange: RABBITMQ_CONFIG.QUESTION_BANK_EXCHANGE,
    routingKey: RABBITMQ_CONFIG.QUESTION_BANK_ROUTING_KEY,
    dlqName: RABBITMQ_CONFIG.QUESTION_BANK_DLQ,
  }).init();
}

/**
 * Connects to RabbitMQ, declares all queues, and populates the Publishers registry.
 */
export async function initRabbitMQ(): Promise<void> {
  const connectionManager = new ConnectionManager({ url: RABBITMQ_URL });
  await connectionManager.connect();

  QueuePublisher.setConnectionManager(connectionManager);

  Publishers.connectionManager = connectionManager;

  Publishers.url = await new QueuePublisher({
    queue: RABBITMQ_CONFIG.URL_PROCESSING_QUEUE,
    exchange: RABBITMQ_CONFIG.URL_PROCESSING_EXCHANGE,
    routingKey: RABBITMQ_CONFIG.URL_PROCESSING_ROUTING_KEY,
    dlqName: RABBITMQ_CONFIG.URL_PROCESSING_DLQ,
  }).init();

  Publishers.file = await new QueuePublisher({
    queue: RABBITMQ_CONFIG.FILE_PROCESSING_QUEUE,
    exchange: RABBITMQ_CONFIG.FILE_PROCESSING_EXCHANGE,
    routingKey: RABBITMQ_CONFIG.FILE_PROCESSING_ROUTING_KEY,
    dlqName: RABBITMQ_CONFIG.FILE_PROCESSING_DLQ,
  }).init();

  Publishers.questionBank = await initQuestionBankPublisher();
}
