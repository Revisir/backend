import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { logger } from "@config/logger.js";
import type { UrlProcessorEvent } from "@/lambda/urlProcessor.js";

const log = logger.child({ module: "lambdaInvoker" });

const useLocalInvoke = process.env.BUCKET_TYPE === "seaweedfs" || process.env.NODE_ENV !== "production";

/**
 * Invokes the URL processor.
 * - AWS: Lambda.invoke()
 * - Local/Docker: direct in-process call (fire-and-forget)
 */
export function invokeUrlProcessor(event: UrlProcessorEvent): void {
  if (useLocalInvoke) {
    // Fire-and-forget: import and call handler directly
    import("@/lambda/urlProcessor.js").then(({ handler }) => {
      handler(event).catch((err) => log.error({ err }, "URL processor error"));
    });
  } else {
    const lambda = new LambdaClient({ region: process.env.AWS_REGION || "us-east-1" });
    lambda
      .send(
        new InvokeCommand({
          FunctionName: process.env.URL_PROCESSOR_LAMBDA_NAME || "url-processor",
          InvocationType: "Event", // async, fire-and-forget
          Payload: Buffer.from(JSON.stringify(event)),
        }),
      )
      .catch((err) => log.error({ err }, "Lambda invoke error"));
  }
}
