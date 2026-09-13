import bunyan from "bunyan";

/**
 * Centralized application logger using Bunyan.
 *
 * When paired with @opentelemetry/instrumentation-bunyan,
 * all log records are automatically bridged to the OTel Logs pipeline
 * and exported to the collector → Loki.
 *
 * Usage:
 *   import { logger } from "@config/logger.js";
 *   logger.info("Server started");
 *   logger.error({ err }, "Something failed");
 *
 * Create child loggers for modules:
 *   const log = logger.child({ module: "s3Storage" });
 */
export const logger = bunyan.createLogger({
  name: process.env.OTEL_SERVICE_NAME || "reviser-api",
  level: (process.env.LOG_LEVEL as bunyan.LogLevelString) || "info",
  serializers: bunyan.stdSerializers,
});
