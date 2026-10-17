/**
 * Launch repair and backfill for the due queue and normal quiz release.
 *
 *   npx tsx src/scripts/repairAndBackfill.ts --dry-run          # plan only: writes and publishes nothing
 *   npx tsx src/scripts/repairAndBackfill.ts                    # apply
 *   npx tsx src/scripts/repairAndBackfill.ts --user <userId>    # one learner only
 *
 * Run after the backend is deployed, dry run first. Idempotent: a second run
 * plans nothing. Never deletes objects or records. See
 * `src/services/launchRepair.ts` for exactly what it changes.
 *
 * Reads MONGODB_URI, the S3/SeaweedFS variables (BUCKET_TYPE, S3_*), and for a
 * real run RABBITMQ_URL.
 */
import "dotenv/config";

import mongoose from "mongoose";
import { HeadObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { connectDatabase } from "@config/database.js";
import { s3Client, S3_BUCKET_NAME } from "@config/s3.js";
import { RABBITMQ_CONFIG, RABBITMQ_URL } from "@config/rabbitmq.js";
import { logger } from "@config/logger.js";
import { ConnectionManager } from "@services/rabbitmq/connectionManager.js";
import { QueuePublisher } from "@services/rabbitmq/publisher.js";
import { Publishers, initQuestionBankPublisher } from "@services/rabbitmq/index.js";
import { requestBankBuild } from "@services/questionBankJobs.js";
import { runLaunchRepair, type RepairDeps, type UploadedObject } from "@services/launchRepair.js";

const log = logger.child({ module: "repairAndBackfill" });

function parseArgs(argv: string[]): { dryRun: boolean; userId?: string } {
  const dryRun = argv.includes("--dry-run");
  const userIndex = argv.indexOf("--user");
  const userId = userIndex >= 0 ? argv[userIndex + 1] : undefined;
  if (userIndex >= 0 && !userId) throw new Error("--user needs a user id");
  return { dryRun, userId };
}

async function listObjects(prefix: string): Promise<UploadedObject[]> {
  const objects: UploadedObject[] = [];
  let token: string | undefined;
  do {
    const page = await s3Client.send(new ListObjectsV2Command({ Bucket: S3_BUCKET_NAME, Prefix: prefix, ContinuationToken: token }));
    for (const obj of page.Contents ?? []) if (obj.Key) objects.push({ key: obj.Key, size: obj.Size });
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return objects;
}

async function contentTypeOf(key: string): Promise<string | undefined> {
  const head = await s3Client.send(new HeadObjectCommand({ Bucket: S3_BUCKET_NAME, Key: key }));
  return head.ContentType;
}

/** Dry run: storage reads only; every publish is a no-op. */
const dryDeps: RepairDeps = {
  listObjects,
  contentTypeOf,
  publishFile: async () => true,
  publishUrls: async () => true,
  queueBankBuild: async () => undefined,
};

async function liveDeps(): Promise<{ deps: RepairDeps; connectionManager: ConnectionManager }> {
  const connectionManager = new ConnectionManager({ url: RABBITMQ_URL });
  await connectionManager.connect();
  QueuePublisher.setConnectionManager(connectionManager);

  const filePublisher = await new QueuePublisher({
    queue: RABBITMQ_CONFIG.FILE_PROCESSING_QUEUE,
    exchange: RABBITMQ_CONFIG.FILE_PROCESSING_EXCHANGE,
    routingKey: RABBITMQ_CONFIG.FILE_PROCESSING_ROUTING_KEY,
    dlqName: RABBITMQ_CONFIG.FILE_PROCESSING_DLQ,
  }).init();
  const urlPublisher = await new QueuePublisher({
    queue: RABBITMQ_CONFIG.URL_PROCESSING_QUEUE,
    exchange: RABBITMQ_CONFIG.URL_PROCESSING_EXCHANGE,
    routingKey: RABBITMQ_CONFIG.URL_PROCESSING_ROUTING_KEY,
    dlqName: RABBITMQ_CONFIG.URL_PROCESSING_DLQ,
  }).init();
  Publishers.questionBank = await initQuestionBankPublisher();

  const deps: RepairDeps = {
    listObjects,
    contentTypeOf,
    publishFile: (key) => filePublisher.publish({ message: { bucket: S3_BUCKET_NAME, key } }),
    publishUrls: async (topicId, userId, urls) => {
      let ok = true;
      for (let i = 0; i < urls.length; i += RABBITMQ_CONFIG.MAX_URLS_PER_MESSAGE) {
        ok = (await urlPublisher.publish({ message: { topicId, userId, urls: urls.slice(i, i + RABBITMQ_CONFIG.MAX_URLS_PER_MESSAGE) } })) && ok;
      }
      return ok;
    },
    queueBankBuild: async (topicId, userId) => {
      await requestBankBuild({ topicId, userId, reason: "backfill" });
    },
  };
  return { deps, connectionManager };
}

async function main(): Promise<void> {
  const { dryRun, userId } = parseArgs(process.argv.slice(2));
  await connectDatabase();

  let connectionManager: ConnectionManager | null = null;
  let deps = dryDeps;
  if (!dryRun) ({ deps, connectionManager } = await liveDeps());

  log.info({ dryRun, userId: userId ?? "all", bucket: S3_BUCKET_NAME }, "Launch repair starting");
  const report = await runLaunchRepair({ dryRun, bucket: S3_BUCKET_NAME, deps, userId });

  for (const plan of report.plans) {
    log.info(
      {
        topicId: plan.topicId,
        topicName: plan.topicName,
        newFileEntries: plan.newFileEntries.map((e) => `${e.fileName} (${e.status})`),
        filesCompleted: plan.completeFiles.length,
        filesRepublished: plan.republishFiles.length,
        urlsCompleted: plan.completeUrls.map((u) => u.url),
        urlsRepublished: plan.republishUrls,
        lastQuality: plan.lastQuality,
        queueBank: plan.queueBank,
      },
      dryRun ? "Would repair topic" : "Repaired topic",
    );
  }
  const { plans: _plans, ...summary } = report;
  log.info(summary, dryRun ? "Launch repair dry run finished; nothing was written" : "Launch repair finished");

  await connectionManager?.shutdown();
  await mongoose.disconnect();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    log.fatal({ err }, "Launch repair failed");
    process.exit(1);
  });
