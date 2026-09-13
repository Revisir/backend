import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { BunyanInstrumentation } from "@opentelemetry/instrumentation-bunyan";
import { AmqplibInstrumentation } from "@opentelemetry/instrumentation-amqplib";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";

// Set diagnostic logging level (useful for debugging OTel issues)
if (process.env.OTEL_DEBUG === "true") {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
}

const OTEL_EXPORTER_OTLP_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318";

const resource = resourceFromAttributes({
  [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || "reviser-api",
  [ATTR_SERVICE_VERSION]: process.env.npm_package_version || "0.1.0",
  "deployment.environment": process.env.NODE_ENV || "development",
});

const sdk = new NodeSDK({
  resource,

  // Traces → OTel Collector
  traceExporter: new OTLPTraceExporter({
    url: `${OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces`,
  }),

  // Metrics → OTel Collector
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      url: `${OTEL_EXPORTER_OTLP_ENDPOINT}/v1/metrics`,
    }),
    exportIntervalMillis: 15000,
  }),

  // Logs → OTel Collector
  logRecordProcessors: [
    new BatchLogRecordProcessor(
      new OTLPLogExporter({
        url: `${OTEL_EXPORTER_OTLP_ENDPOINT}/v1/logs`,
      }),
    ),
  ],

  // Auto-instrument Express, HTTP, MongoDB, etc.
  instrumentations: [
    getNodeAutoInstrumentations({
      "@opentelemetry/instrumentation-fs": { enabled: false },
      "@opentelemetry/instrumentation-dns": { enabled: false },
    }),
    new BunyanInstrumentation(),
    new AmqplibInstrumentation(),
  ],
});

sdk.start();
console.log("[OTel] Instrumentation started →", OTEL_EXPORTER_OTLP_ENDPOINT);

// Graceful shutdown
const shutdown = async () => {
  try {
    await sdk.shutdown();
    console.log("[OTel] SDK shut down successfully");
  } catch (err) {
    console.error("[OTel] Error shutting down SDK:", err);
  }
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
