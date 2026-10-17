import type { Request } from "express";
import { DateTime, IANAZone } from "luxon";

/**
 * Header the frontend sends with the browser's IANA time zone
 * (`reviser-web/src/service/AxiosInstance.mjs`). Node lowercases incoming header
 * names, so it is always read through its lowercase form.
 */
export const LOCAL_TIMEZONE_HEADER = "x-local-timezone";

const FALLBACK_ZONE = "UTC";

/**
 * The learner's current calendar day.
 *
 * "Today" everywhere in the product — which topics are due, which were finished
 * today, the one-review-per-day claim, and the topic-edit date check — means the
 * learner's local day, not the server's.
 */
export interface LearnerDay {
  zone: string;
  /** The instant the day was computed for. */
  now: Date;
  /** Start of the learner's current day. */
  start: Date;
  /** Start of the learner's next day (exclusive end of today). */
  tomorrowStart: Date;
}

/**
 * Builds the learner day from a raw `X-Local-TimeZone` header value.
 * A missing, empty, or non-IANA value falls back to UTC.
 */
export function learnerDayFromHeader(header: string | string[] | undefined, now: Date = new Date()): LearnerDay {
  const raw = Array.isArray(header) ? header[0] : header;
  const candidate = raw?.trim();
  const zone = candidate && IANAZone.isValidZone(candidate) ? candidate : FALLBACK_ZONE;

  const local = DateTime.fromJSDate(now).setZone(zone);
  const start = local.startOf("day");

  return {
    zone,
    now,
    start: start.toJSDate(),
    tomorrowStart: start.plus({ days: 1 }).toJSDate(),
  };
}

/** The learner day for an incoming request. */
export function getLearnerDay(req: Request, now: Date = new Date()): LearnerDay {
  return learnerDayFromHeader(req.headers[LOCAL_TIMEZONE_HEADER], now);
}

/** True when the topic was last reviewed during the learner's current day. */
export function isReviewedToday(topic: { lastRevised?: Date | null }, day: LearnerDay): boolean {
  return topic.lastRevised != null && new Date(topic.lastRevised).getTime() >= day.start.getTime();
}

/** True when the topic's revision date falls on or before the learner's current day. */
export function isDueToday(topic: { revisionDate: Date }, day: LearnerDay): boolean {
  return new Date(topic.revisionDate).getTime() < day.tomorrowStart.getTime();
}

/**
 * The calendar date (`YYYY-MM-DD`) an instant falls on in the learner's zone.
 * Used to compare a date-only form value against a stored timestamp.
 */
export function localDateOf(date: Date, day: LearnerDay): string {
  return DateTime.fromJSDate(date).setZone(day.zone).toISODate()!;
}
