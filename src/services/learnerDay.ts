import type { Request } from "express";
import { DateTime, IANAZone } from "luxon";

/**
 * Header the frontend sends with the browser's IANA time zone
 * (`reviser-web/src/service/AxiosInstance.mjs`). Node lowercases incoming header
 * names, so it is always read through its lowercase form.
 */
const LOCAL_TIMEZONE_HEADER = "x-local-timezone";

const FALLBACK_ZONE = "UTC";

/**
 * Zones already confirmed valid. Luxon's check builds an Intl formatter on
 * every call; only valid IANA names are cached, so the set stays small.
 */
const validZones = new Set<string>();

function isValidZone(zone: string): boolean {
  if (validZones.has(zone)) return true;
  if (!IANAZone.isValidZone(zone)) return false;
  validZones.add(zone);
  return true;
}

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
  const zone = candidate && isValidZone(candidate) ? candidate : FALLBACK_ZONE;

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

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The new study date when a topic edit changes it, or null when it does not.
 *
 * The edit form shows the stored timestamp as a date in the browser's zone and
 * sends that date back unchanged, so the comparison is made in the learner's
 * zone (KTD20). A changed date-only value is stored as UTC midnight of that
 * day, as topic creation does; a full ISO value is stored as given.
 */
export function changedStudyDate(submitted: string, stored: Date, day: LearnerDay): Date | null {
  const next = DATE_ONLY.test(submitted) ? new Date(`${submitted}T00:00:00.000Z`) : new Date(submitted);
  const nextLocal = DATE_ONLY.test(submitted) ? submitted : localDateOf(next, day);
  return nextLocal === localDateOf(stored, day) ? null : next;
}

/**
 * The calendar date (`YYYY-MM-DD`) an instant falls on in the learner's zone.
 * Used to compare a date-only form value against a stored timestamp.
 */
function localDateOf(date: Date, day: LearnerDay): string {
  return DateTime.fromJSDate(date).setZone(day.zone).toISODate()!;
}
