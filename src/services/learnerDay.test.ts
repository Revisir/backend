import { learnerDayFromHeader, getLearnerDay, isReviewedToday, isDueToday, changedStudyDate } from "@services/learnerDay";
import type { Request } from "express";

describe("learnerDayFromHeader", () => {
  // 2026-03-10T01:30:00Z is 2026-03-09 21:30 in New York (EDT, UTC-4)
  const now = new Date("2026-03-10T01:30:00.000Z");

  it("returns the day bounds of a valid IANA zone", () => {
    const day = learnerDayFromHeader("America/New_York", now);

    expect(day.zone).toBe("America/New_York");
    expect(day.start.toISOString()).toBe("2026-03-09T04:00:00.000Z");
    expect(day.tomorrowStart.toISOString()).toBe("2026-03-10T04:00:00.000Z");
    expect(day.now.toISOString()).toBe(now.toISOString());
  });

  it("uses the first value when the header was sent twice", () => {
    const day = learnerDayFromHeader(["Asia/Kolkata", "America/New_York"], now);
    expect(day.zone).toBe("Asia/Kolkata");
    // 01:30Z is 07:00 IST on 2026-03-10
    expect(day.start.toISOString()).toBe("2026-03-09T18:30:00.000Z");
  });

  it.each([[undefined], [""], ["Not/AZone"], ["   "], ["Asia/Calcutta; drop table"]])("falls back to UTC for %p", (header) => {
    const day = learnerDayFromHeader(header as string | undefined, now);

    expect(day.zone).toBe("UTC");
    expect(day.start.toISOString()).toBe("2026-03-10T00:00:00.000Z");
    expect(day.tomorrowStart.toISOString()).toBe("2026-03-11T00:00:00.000Z");
  });

  it("handles a 23-hour DST day", () => {
    // 2026-03-08 is the spring-forward day in New York
    const day = learnerDayFromHeader("America/New_York", new Date("2026-03-08T15:00:00.000Z"));
    expect(day.tomorrowStart.getTime() - day.start.getTime()).toBe(23 * 3600 * 1000);
  });
});

describe("getLearnerDay", () => {
  it("reads the lowercase header Node produces", () => {
    const req = { headers: { "x-local-timezone": "America/New_York" } } as unknown as Request;
    const day = getLearnerDay(req, new Date("2026-03-10T01:30:00.000Z"));
    expect(day.zone).toBe("America/New_York");
  });

  it("falls back to UTC with no header", () => {
    const req = { headers: {} } as unknown as Request;
    expect(getLearnerDay(req).zone).toBe("UTC");
  });
});

describe("isReviewedToday / isDueToday", () => {
  const day = learnerDayFromHeader("America/New_York", new Date("2026-03-10T00:00:00.000Z")); // 20:00 EDT on the 9th

  it("counts a review earlier in the learner's day", () => {
    expect(isReviewedToday({ lastRevised: new Date("2026-03-09T13:00:00.000Z") }, day)).toBe(true); // 09:00 EDT
  });

  it("does not count a review from the previous learner day", () => {
    expect(isReviewedToday({ lastRevised: new Date("2026-03-09T03:59:00.000Z") }, day)).toBe(false); // 23:59 the 8th
    expect(isReviewedToday({ lastRevised: null }, day)).toBe(false);
    expect(isReviewedToday({}, day)).toBe(false);
  });

  it("is due when the revision date falls before tomorrow's start", () => {
    expect(isDueToday({ revisionDate: new Date("2026-03-10T03:59:00.000Z") }, day)).toBe(true);
    expect(isDueToday({ revisionDate: new Date("2026-03-01T00:00:00.000Z") }, day)).toBe(true);
    expect(isDueToday({ revisionDate: new Date("2026-03-10T04:00:00.000Z") }, day)).toBe(false);
  });
});

describe("changedStudyDate", () => {
  const day = learnerDayFromHeader("America/New_York", new Date("2026-03-10T12:00:00.000Z"));
  // Topic creation stores a date-only value as UTC midnight; New York shows it as 2026-01-14.
  const stored = new Date("2026-01-15T00:00:00.000Z");

  it("reports no change when the submitted date is the stored instant", () => {
    expect(changedStudyDate("2026-01-15", stored, day)).toBeNull();
  });

  it("reports no change when the submitted date is the stored date in the learner's zone", () => {
    expect(changedStudyDate("2026-01-14", stored, day)).toBeNull();
  });

  it("reports no change for a full ISO value equal to the stored instant", () => {
    expect(changedStudyDate("2026-01-15T00:00:00.000Z", stored, day)).toBeNull();
  });

  it("returns UTC midnight of a changed date-only value", () => {
    expect(changedStudyDate("2026-01-16", stored, day)).toEqual(new Date("2026-01-16T00:00:00.000Z"));
  });
});
