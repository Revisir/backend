import { Types } from "mongoose";
import type { ConsumeMessage } from "amqplib";
import { Topic } from "@models/Topic.js";
import { buildQuestionBank } from "@services/questionBank.js";
import { onAttachmentSettled, publishBankMessage, requestBankBuild } from "@services/questionBankJobs.js";
import { STALE_ATTACHMENT_REASON } from "@services/attachments.js";
import { ConnectionManager } from "@services/rabbitmq/connectionManager.js";
import { QueueConsumer, type MessageOutcome } from "@services/rabbitmq/consumer.js";
import { Publishers, initQuestionBankPublisher } from "@services/rabbitmq/index.js";
import { RABBITMQ_CONFIG } from "@config/rabbitmq.js";
import { ATTACHMENT_STALE_MS, QUESTION_BANK } from "@config/questionBank.js";
import { questionBankMessageSchema, type QuestionBankMessage } from "@/schemas/queue.schema.js";
import { logger } from "@config/logger.js";

const log = logger.child({ module: "questionBankProcessor" });

/**
 * The question-bank consumer and sweep. Both run inside the file-processor
 * process (KTD4), so deployment config stays unchanged; the consumer has its
 * own prefetch of one and runs beside file extraction rather than behind it.
 */

/**
 * Handles one build request. The claim protocol makes every request produce
 * at most one build:
 *
 * 1. Skip when the last successful build was claimed after this request.
 * 2. While a fresh build runs, raise `requestedAt` and ack — that build
 *    publishes one follow-up when it finishes.
 * 3. Otherwise claim the topic as `building` and build. A redelivery of the
 *    message holding the claim (the worker died mid-build) takes it over, and
 *    a claim older than the stale-claim timeout may be taken by anyone.
 */
export async function handleBankRequest(message: QuestionBankMessage, now: Date = new Date()): Promise<MessageOutcome> {
  const { topicId, userId } = message;
  const requestedAt = new Date(message.requestedAt);
  if (!Types.ObjectId.isValid(topicId)) return "nack_reject";

  try {
    const topic = await Topic.findOne({ _id: topicId, userId }).select("questionBank").lean();
    if (!topic) {
      log.info({ topicId }, "Topic no longer exists, dropping bank request");
      return "ack";
    }

    const bank = topic.questionBank;
    if (bank?.sourcedAt && new Date(bank.sourcedAt).getTime() > requestedAt.getTime()) {
      log.debug({ topicId, reason: message.reason }, "Request already covered by a later build, skipping");
      return "ack";
    }

    const staleBefore = new Date(now.getTime() - QUESTION_BANK.STALE_CLAIM_MS);
    const ownClaim = bank?.claimRequestedAt != null && new Date(bank.claimRequestedAt).getTime() === requestedAt.getTime();
    const freshBuild = bank?.state === "building" && bank.claimedAt != null && new Date(bank.claimedAt).getTime() >= staleBefore.getTime();
    if (freshBuild && !ownClaim) {
      await raiseRequestedAt(topicId, userId, requestedAt);
      return "ack";
    }

    const claimedAt = now;
    const claimed = await Topic.findOneAndUpdate(
      {
        _id: topicId,
        userId,
        $or: [
          { "questionBank.state": { $ne: "building" } },
          { "questionBank.claimedAt": null },
          { "questionBank.claimedAt": { $lt: staleBefore } },
          { "questionBank.claimRequestedAt": requestedAt },
        ],
      },
      {
        $set: { "questionBank.state": "building", "questionBank.claimedAt": claimedAt, "questionBank.claimRequestedAt": requestedAt },
        $max: { "questionBank.requestedAt": requestedAt },
      },
      { new: true, projection: { _id: 1 } },
    ).lean();
    if (!claimed) {
      // Another consumer claimed it between the read and the claim.
      await raiseRequestedAt(topicId, userId, requestedAt);
      return "ack";
    }

    log.info({ topicId, reason: message.reason, takeover: ownClaim }, "Building question bank");
    const result = await buildQuestionBank({ topicId, userId, claimedAt });
    log.info({ topicId, ...result }, "Question bank build finished");

    if (result.saved) await publishFollowUpIfRequested(topicId, userId, claimedAt);
    return "ack";
  } catch (err) {
    // Database trouble: requeue. A redelivery takes over its own claim.
    log.error({ err, topicId }, "Question bank request failed, requeueing");
    return "nack_requeue";
  }
}

async function raiseRequestedAt(topicId: string, userId: string, requestedAt: Date): Promise<void> {
  await Topic.updateOne({ _id: topicId, userId }, { $max: { "questionBank.requestedAt": requestedAt } });
}

/** A request that arrived during the build gets exactly one follow-up build. */
async function publishFollowUpIfRequested(topicId: string, userId: string, claimedAt: Date): Promise<void> {
  const topic = await Topic.findOne({ _id: topicId, userId }).select("questionBank").lean();
  const requestedAt = topic?.questionBank?.requestedAt;
  if (!requestedAt || new Date(requestedAt).getTime() <= claimedAt.getTime()) return;

  await Topic.updateOne({ _id: topicId, userId, "questionBank.state": { $ne: "building" } }, { $set: { "questionBank.state": "queued" } });
  await publishBankMessage({ topicId, userId, requestedAt: new Date(requestedAt).toISOString(), reason: "follow_up" });
}

async function handleBankMessage(msg: ConsumeMessage): Promise<MessageOutcome> {
  const message = JSON.parse(msg.content.toString()) as QuestionBankMessage;
  return handleBankRequest(message);
}

/**
 * Attachments left pending or processing past the staleness window are
 * written as failed, then each affected topic gets the settle check.
 */
export async function failStaleAttachments(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - ATTACHMENT_STALE_MS);
  const cutoffId = Types.ObjectId.createFromTime(Math.floor(cutoff.getTime() / 1000));
  const unsettled = { $in: ["pending", "processing"] };
  /**
   * Pending or processing past the cutoff, by `statusUpdatedAt`, or by `_id`
   * creation time for legacy entries without one. `field` prefixes each path
   * for use inside an array filter.
   */
  const stalePredicate = (field: (name: string) => string) => ({
    $or: [
      { [field("processingStatus")]: unsettled, [field("statusUpdatedAt")]: { $lt: cutoff } },
      { [field("processingStatus")]: unsettled, [field("statusUpdatedAt")]: null, [field("_id")]: { $lt: cutoffId } },
    ],
  });
  const staleEntry = stalePredicate((name) => name);

  const topics = await Topic.find({ $or: [{ files: { $elemMatch: staleEntry } }, { urls: { $elemMatch: staleEntry } }] })
    .select("_id userId")
    .lean();

  const failed = { processingStatus: "failed", errorReason: STALE_ATTACHMENT_REASON, statusUpdatedAt: now };
  for (const { _id, userId } of topics) {
    for (const array of ["files", "urls"] as const) {
      const $set = Object.fromEntries(Object.entries(failed).map(([field, value]) => [`${array}.$[stale].${field}`, value]));
      await Topic.updateOne({ _id, userId }, { $set }, { arrayFilters: [stalePredicate((name) => `stale.${name}`)] });
    }
    log.warn({ topicId: _id.toString() }, "Marked stalled attachments as failed");
    await onAttachmentSettled(_id.toString(), userId, now);
  }
  return topics.length;
}

/**
 * Banks left queued or building past the stale-claim timeout (a lost publish,
 * or a worker that died) are republished, up to the attempt cap; then failed.
 */
export async function republishStalledBanks(now: Date = new Date()): Promise<{ republished: number; failed: number }> {
  const staleBefore = new Date(now.getTime() - QUESTION_BANK.STALE_CLAIM_MS);
  const topics = await Topic.find({
    $or: [
      { "questionBank.state": "queued", $or: [{ "questionBank.requestedAt": { $lt: staleBefore } }, { "questionBank.requestedAt": null }] },
      { "questionBank.state": "building", $or: [{ "questionBank.claimedAt": { $lt: staleBefore } }, { "questionBank.claimedAt": null }] },
    ],
  })
    .select("_id userId questionBank.state questionBank.attempts")
    .lean();

  let republished = 0;
  let failed = 0;
  for (const topic of topics) {
    const topicId = topic._id.toString();
    if ((topic.questionBank?.attempts ?? 0) >= QUESTION_BANK.SWEEP_MAX_ATTEMPTS) {
      await Topic.updateOne(
        { _id: topic._id, userId: topic.userId, "questionBank.state": topic.questionBank.state },
        {
          $set: {
            "questionBank.state": "failed",
            "questionBank.errorCode": "BUILD_STALLED",
            "questionBank.errorReason": `No build completed after ${QUESTION_BANK.SWEEP_MAX_ATTEMPTS} retries`,
            "questionBank.claimedAt": null,
            "questionBank.claimRequestedAt": null,
          },
        },
      );
      log.error({ topicId }, "Question bank build stalled past the attempt cap, marked failed");
      failed += 1;
      continue;
    }
    if (topic.questionBank.state === "building") {
      // Release the abandoned claim so the republished request can take it.
      await Topic.updateOne({ _id: topic._id, userId: topic.userId, "questionBank.state": "building" }, { $set: { "questionBank.state": "queued" } });
    }
    await requestBankBuild({ topicId, userId: topic.userId, reason: "sweep", now });
    republished += 1;
  }
  return { republished, failed };
}

/** One sweep pass. */
async function sweepQuestionBanks(now: Date = new Date()): Promise<void> {
  const staleTopics = await failStaleAttachments(now);
  const banks = await republishStalledBanks(now);
  if (staleTopics || banks.republished || banks.failed) log.info({ staleTopics, ...banks }, "Question bank sweep finished");
}

let sweepTimer: NodeJS.Timeout | null = null;

/** Starts the periodic sweep. Overlapping passes are skipped. */
export function startQuestionBankSweep(intervalMs: number = QUESTION_BANK.SWEEP_INTERVAL_MS): void {
  if (sweepTimer) return;
  let running = false;
  sweepTimer = setInterval(() => {
    if (running) return;
    running = true;
    sweepQuestionBanks()
      .catch((err) => log.error({ err }, "Question bank sweep failed"))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  sweepTimer.unref();
}

/**
 * Starts the bank consumer on the given connection and registers this
 * process's bank publisher (used by the settle trigger and follow-ups).
 */
export async function startQuestionBankConsumer(connectionManager: ConnectionManager): Promise<void> {
  Publishers.questionBank = await initQuestionBankPublisher();

  const consumer = new QueueConsumer(connectionManager);
  await consumer.consume(RABBITMQ_CONFIG.QUESTION_BANK_QUEUE, handleBankMessage, {
    schema: questionBankMessageSchema,
  });

  startQuestionBankSweep();
  log.info("Question bank consumer and sweep started");
}
