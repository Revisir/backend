import { Types } from "mongoose";
import { Topic } from "@models/Topic.js";
import { RevisionRecord, type RevisionMethod } from "@models/RevisionRecord.js";
import { calculateNextReview } from "@services/sm2Algorithm.js";
import type { LearnerDay } from "@services/learnerDay.js";
import { logger } from "@config/logger.js";

const log = logger.child({ module: "reviewRecorder" });

/** Thrown when the topic already has a review in the learner's current day. */
export class AlreadyReviewedTodayError extends Error {
  readonly code = "ALREADY_REVIEWED_TODAY";
  constructor() {
    super("This topic has already been reviewed today");
    this.name = "AlreadyReviewedTodayError";
  }
}

/** Thrown when the topic does not exist or belongs to another user. */
export class TopicNotFoundError extends Error {
  readonly code = "TOPIC_NOT_FOUND";
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
export function finalQualityOf(userQuality: number, llmQuality?: number | null): number {
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
 * @throws AlreadyReviewedTodayError when the learner-day is already claimed
 * @throws TopicNotFoundError when the topic is missing or not the user's
 */
export async function recordRevision(input: RecordRevisionInput): Promise<RevisionResult> {
  const { userId, topicId, userQuality, llmQuality, method, quizScored, quizCorrect, sessionId, day } = input;
  const now = day.now;

  const topic = await Topic.findOne({ _id: topicId, userId })
    .select("eFactor interval repetitionNumber revisionDate lastRevised lastQuality")
    .lean();
  if (!topic) throw new TopicNotFoundError();
  if (topic.lastRevised && topic.lastRevised.getTime() >= day.start.getTime()) throw new AlreadyReviewedTodayError();

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
      },
    },
    { new: true, projection: { _id: 1 } },
  ).lean();
  if (!claimed) throw new AlreadyReviewedTodayError();

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

/**
 * The review a chat or quiz session already recorded, if any. A completion that
 * loses the day claim to a concurrent completion of the *same* session uses
 * this to return the winner's result instead of an error.
 */
export async function findSessionRevision(userId: string, sessionId: string | Types.ObjectId) {
  return RevisionRecord.findOne({ userId, sessionId }).lean();
}
