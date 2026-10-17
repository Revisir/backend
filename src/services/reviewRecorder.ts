import { Types } from "mongoose";
import { Topic } from "@models/Topic.js";
import { RevisionRecord, type RevisionMethod } from "@models/RevisionRecord.js";
import { calculateNextReview } from "@services/sm2Algorithm.js";
import { setTimeout as sleep } from "node:timers/promises";
import { isReviewedToday, type LearnerDay } from "@services/learnerDay.js";
import { logger } from "@config/logger.js";

const log = logger.child({ module: "reviewRecorder" });

/** Thrown when the topic already has a review in the learner's current day. */
export class AlreadyReviewedTodayError extends Error {
  readonly code = "ALREADY_REVIEWED_TODAY";
  readonly status = 409;
  constructor() {
    super("This topic has already been reviewed today");
    this.name = "AlreadyReviewedTodayError";
  }
}

/** Thrown when the topic does not exist or belongs to another user. */
export class TopicNotFoundError extends Error {
  readonly code = "TOPIC_NOT_FOUND";
  readonly status = 404;
  constructor() {
    super("Topic not found or access denied");
    this.name = "TopicNotFoundError";
  }
}

export interface RecordRevisionInput {
  userId: string;
  topicId: string | Types.ObjectId;
  /** The learner's rating (Done, the AI chat's closing rating) or the normal quiz's score band. 0–5. */
  userQuality: number;
  /** The AI's assessment of a chat transcript, averaged with `userQuality` when present. 0–5. */
  llmQuality?: number | null;
  method: RevisionMethod;
  quizScored?: number;
  quizCorrect?: number;
  sessionId?: string | Types.ObjectId;
  day: LearnerDay;
}

export interface RevisionResult {
  nextRevisionDate: Date;
  lastRevised: Date;
  eFactor: number;
  interval: number;
  repetitionNumber: number;
  lastQuality: number;
  finalQuality: number;
}

/** The rating SM-2 sees: the mean of the learner's and the AI's when the AI scored, else the learner's. */
function finalQualityOf(userQuality: number, llmQuality?: number | null): number {
  return llmQuality != null ? (userQuality + llmQuality) / 2 : userQuality;
}

/**
 * Records one review and reschedules the topic, at most once per topic per learner-day.
 *
 * Every path that finishes a review (Done, AI chat completion, normal quiz
 * completion) goes through here. The day is claimed and the SM-2 result applied
 * in a single conditional update on the topic, so two concurrent finishes can
 * never both land. The revision record is written after the claim; if that
 * write fails, the topic is restored to its previous schedule. MongoDB runs as
 * a standalone server in deployment, so there is no transaction to lean on.
 *
 * Idempotent per session: when the day was claimed by the same chat or quiz
 * session (a retry, a second tab, or two near-simultaneous finishes), the
 * review that session recorded is returned instead of an error.
 *
 * @throws AlreadyReviewedTodayError when the learner-day is already claimed by another review
 * @throws TopicNotFoundError when the topic is missing or not the user's
 */
export async function recordRevision(input: RecordRevisionInput): Promise<RevisionResult> {
  const { userId, topicId, userQuality, llmQuality, method, quizScored, quizCorrect, sessionId, day } = input;
  const now = day.now;

  const topic = await Topic.findOne({ _id: topicId, userId })
    .select("eFactor interval repetitionNumber revisionDate lastRevised lastQuality lastReviewSessionId")
    .lean();
  if (!topic) throw new TopicNotFoundError();
  if (isReviewedToday(topic, day)) return sameSessionReview(userId, topicId, sessionId);

  const finalQuality = finalQualityOf(userQuality, llmQuality);
  const schedule = calculateNextReview(
    { eFactor: topic.eFactor, repetitionNumber: topic.repetitionNumber, interval: topic.interval, quality: finalQuality },
    now,
  );

  const claimed = await Topic.findOneAndUpdate(
    { _id: topicId, userId, $or: [{ lastRevised: null }, { lastRevised: { $lt: day.start } }] },
    {
      $set: {
        eFactor: schedule.eFactor,
        interval: schedule.interval,
        repetitionNumber: schedule.repetitionNumber,
        revisionDate: schedule.nextRevisionDate,
        lastRevised: now,
        lastQuality: finalQuality,
        lastReviewSessionId: sessionId ?? null,
      },
    },
    { new: true, projection: { _id: 1 } },
  ).lean();
  if (!claimed) return sameSessionReview(userId, topicId, sessionId);

  try {
    await RevisionRecord.create({
      userId,
      topicId,
      revisionDate: now,
      userQuality,
      llmQuality: llmQuality ?? userQuality,
      finalQuality,
      newEFactor: schedule.eFactor,
      newInterval: schedule.interval,
      nextRevisionDate: schedule.nextRevisionDate,
      method,
      quizScored: quizScored ?? null,
      quizCorrect: quizCorrect ?? null,
      sessionId: sessionId ?? null,
    });
  } catch (err) {
    log.error({ err, topicId: String(topicId), method }, "Revision record write failed; restoring the topic's schedule");
    await Topic.updateOne(
      { _id: topicId, userId, lastRevised: now },
      {
        $set: {
          eFactor: topic.eFactor,
          interval: topic.interval,
          repetitionNumber: topic.repetitionNumber,
          revisionDate: topic.revisionDate,
          lastRevised: topic.lastRevised ?? null,
          lastQuality: topic.lastQuality ?? null,
          lastReviewSessionId: topic.lastReviewSessionId ?? null,
        },
      },
    );
    throw err;
  }

  return {
    nextRevisionDate: schedule.nextRevisionDate,
    lastRevised: now,
    eFactor: schedule.eFactor,
    interval: schedule.interval,
    repetitionNumber: schedule.repetitionNumber,
    lastQuality: finalQuality,
    finalQuality,
  };
}

/** How long a same-session completion waits for the winning completion's record. */
const SESSION_REVIEW_WAIT_MS = 2_000;
const SESSION_REVIEW_POLL_MS = 50;

/**
 * The day is already claimed. When this session holds the claim, returns the
 * review it recorded, waiting briefly for a concurrent completion to finish
 * writing it. Otherwise, or if that record never appears, the topic was
 * reviewed by something else today.
 */
async function sameSessionReview(userId: string, topicId: string | Types.ObjectId, sessionId?: string | Types.ObjectId): Promise<RevisionResult> {
  if (!sessionId) throw new AlreadyReviewedTodayError();
  const holder = await Topic.findOne({ _id: topicId, userId }).select("lastReviewSessionId repetitionNumber").lean();
  if (!holder?.lastReviewSessionId || String(holder.lastReviewSessionId) !== String(sessionId)) throw new AlreadyReviewedTodayError();

  const deadline = Date.now() + SESSION_REVIEW_WAIT_MS;
  for (;;) {
    const record = await RevisionRecord.findOne({ userId, topicId, sessionId }).lean();
    if (record) {
      return {
        nextRevisionDate: record.nextRevisionDate,
        lastRevised: record.revisionDate,
        eFactor: record.newEFactor,
        interval: record.newInterval,
        repetitionNumber: holder.repetitionNumber,
        lastQuality: record.finalQuality,
        finalQuality: record.finalQuality,
      };
    }
    // The winner claimed the day but has not written its record (or failed and is restoring).
    if (Date.now() >= deadline) throw new AlreadyReviewedTodayError();
    await sleep(SESSION_REVIEW_POLL_MS);
  }
}
