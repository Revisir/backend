import { Topic } from "@models/Topic.js";
import { Publishers } from "@services/rabbitmq/index.js";
import { allSettled, attachmentsOf, hasCompletedMaterial, statusTime } from "@services/attachments.js";
import { toQuestionBankView, type QuestionBankView } from "@services/questionBankView.js";
import type { QuestionBankBuildReason, QuestionBankMessage } from "@/schemas/queue.schema.js";
import { logger } from "@config/logger.js";

const log = logger.child({ module: "questionBankJobs" });

/**
 * Triggers for question-bank builds (KTD4). Every trigger — materials
 * settling, material removed, Regenerate, the launch backfill and the sweep —
 * records the request on the topic and publishes one message to the
 * `question_bank` queue, where the file-processor process builds it.
 */

/**
 * Records a build request and publishes it.
 *
 * The bank goes to `queued`, unless a build is already running: then only
 * `requestedAt` rises, and that build publishes one follow-up when it
 * finishes. A failed publish leaves the bank queued for the sweep to retry.
 * Returns the bank's public view, or null when the topic does not exist.
 */
export async function requestBankBuild(params: { topicId: string; userId: string; reason: QuestionBankBuildReason; now?: Date }): Promise<QuestionBankView | null> {
  const { topicId, userId, reason, now = new Date() } = params;
  // The sweep counts its republishes toward the attempt cap; any other trigger starts the count over.
  const sweep = reason === "sweep";
  const countAttempt = sweep ? { $inc: { "questionBank.attempts": 1 } } : {};
  const resetAttempts = sweep ? {} : { "questionBank.attempts": 0 };
  const options = { new: true, projection: { questionBank: 1 } } as const;

  const queued = await Topic.findOneAndUpdate(
    { _id: topicId, userId, "questionBank.state": { $ne: "building" } },
    { ...countAttempt, $set: { ...resetAttempts, "questionBank.state": "queued" }, $max: { "questionBank.requestedAt": now } },
    options,
  ).lean();
  // A build is running: leave it building and raise requestedAt so it publishes one follow-up.
  const topic =
    queued ??
    (await Topic.findOneAndUpdate(
      { _id: topicId, userId },
      { ...countAttempt, ...(sweep ? {} : { $set: resetAttempts }), $max: { "questionBank.requestedAt": now } },
      options,
    ).lean());
  if (!topic) return null;

  await publishBankMessage({ topicId, userId, requestedAt: now.toISOString(), reason });
  return toQuestionBankView(topic.questionBank);
}

/** Publishes a bank message. Never throws; a lost publish is retried by the sweep. */
export async function publishBankMessage(message: QuestionBankMessage): Promise<boolean> {
  if (!Publishers.questionBank) {
    log.error({ topicId: message.topicId, reason: message.reason }, "Question bank publisher not initialised; build left queued");
    return false;
  }
  try {
    const published = await Publishers.questionBank.publish({ message });
    if (!published) log.error({ topicId: message.topicId, reason: message.reason }, "Failed to publish question bank message");
    return published;
  } catch (err) {
    log.error({ err, topicId: message.topicId, reason: message.reason }, "Failed to publish question bank message");
    return false;
  }
}

/**
 * Called after an attachment settles (completed, failed, timed out, or
 * removed while unsettled). Publishes a build once every attachment has
 * settled, when material has completed since the last successful build.
 */
export async function onAttachmentSettled(topicId: string, userId: string, now: Date = new Date()): Promise<boolean> {
  const topic = await Topic.findOne({ _id: topicId, userId }).select("files urls questionBank").lean();
  if (!topic || !allSettled(topic, now) || !hasCompletedMaterial(topic)) return false;

  const sourcedAt = topic.questionBank?.sourcedAt ?? null;
  const newMaterial = attachmentsOf(topic).some((att) => {
    if (att.processingStatus !== "completed") return false;
    const at = statusTime(att);
    return sourcedAt === null || at === null || at.getTime() > new Date(sourcedAt).getTime();
  });
  if (!newMaterial) return false;

  await requestBankBuild({ topicId, userId, reason: "materials_settled", now });
  return true;
}

/**
 * Called after completed material was removed: rebuilds from what remains,
 * or clears the bank to `none` when no completed material remains.
 */
export async function afterMaterialRemoved(topicId: string, userId: string, now: Date = new Date()): Promise<void> {
  const topic = await Topic.findOne({ _id: topicId, userId }).select("files urls").lean();
  if (!topic) return;
  if (hasCompletedMaterial(topic)) {
    await requestBankBuild({ topicId, userId, reason: "material_removed", now });
  } else {
    await clearBank(topicId, userId);
  }
}

/** Empties the bank. A build still running loses its claim and saves nothing. */
export async function clearBank(topicId: string, userId: string): Promise<void> {
  await Topic.updateOne(
    { _id: topicId, userId },
    {
      $set: {
        "questionBank.state": "none",
        "questionBank.questions": [],
        "questionBank.usableCount": 0,
        "questionBank.requestedAt": null,
        "questionBank.claimedAt": null,
        "questionBank.claimRequestedAt": null,
        "questionBank.attempts": 0,
        "questionBank.errorCode": null,
        "questionBank.errorReason": null,
      },
    },
  );
}

/** Runs a trigger without letting its failure fail the caller's own write. */
export async function bestEffort(label: string, topicId: string, trigger: () => Promise<unknown>): Promise<void> {
  try {
    await trigger();
  } catch (err) {
    log.error({ err, topicId, trigger: label }, "Question bank trigger failed");
  }
}
