export const RABBITMQ_CONFIG = {
  // Exchanges
  FILE_PROCESSING_EXCHANGE: "file_processing-exchange",
  URL_PROCESSING_EXCHANGE: "url_processing-exchange",
  DLX_EXCHANGE: "dlx",

  // Queues
  FILE_PROCESSING_QUEUE: "file_processing",
  URL_PROCESSING_QUEUE: "url_processing",
  FILE_PROCESSING_DLQ: "file_processing.dlq",
  URL_PROCESSING_DLQ: "url_processing.dlq",

  // Routing keys
  FILE_PROCESSING_ROUTING_KEY: "file_processing",
  URL_PROCESSING_ROUTING_KEY: "url_processing",

  // Consumer settings
  MAX_RETRY_COUNT: 3,
  PREFETCH_COUNT: 1,
  MAX_URLS_PER_MESSAGE: 50,
  MAX_URLS_PER_REQUEST: 20,
} as const;

export const RABBITMQ_URL = process.env.RABBITMQ_URL || "amqp://localhost";
