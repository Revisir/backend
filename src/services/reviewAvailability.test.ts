/**
 * U6 — review availability, the recall estimate and the interval previews
 * that due-list and topic-detail responses carry (KTD10, KTD12).
 *
 * Pure: every case builds a plain topic and a fixed learner day.
 */
import { Types } from "mongoose";
import { computeReviewState, type ReviewTopic, type ReviewContext } from "@services/reviewAvailability";
import { calculateNextReview, retentionAt, estimateRetention, previewIntervals } from "@services/sm2Algorithm";
import { learnerDayFromHeader } from "@services/learnerDay";
import { ATTACHMENT_STALE_MS } from "@config/questionBank";

const DAY_MS = 86_400_000;
const MIN_MS = 60_000;
// 15:00 UTC; the learner day (UTC) runs from 2026-03-10T00:00Z to 2026-03-11T00:00Z.
const NOW = new Date("2026-03-10T15:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

function ctx(overrides: Partial<ReviewContext> = {}): ReviewContext {
  return { day: learnerDayFromHeader(undefined, NOW), now: NOW, aiConfigured: true, ...overrides };
}

const file = (processingStatus: "pending" | "processing" | "completed" | "failed", statusUpdatedAt: Date | null = ago(5 * MIN_MS)) => ({ fileName: "notes.pdf", processingStatus, statusUpdatedAt });
const url = (processingStatus: "pending" | "processing" | "completed" | "failed", statusUpdatedAt: Date | null = ago(5 * MIN_MS)) => ({ url: "https://example.com/a", processingStatus, statusUpdatedAt });

/** A topic due today (revision date this morning), never reviewed, no materials and no bank. */
function topic(overrides: Partial<ReviewTopic> = {}): ReviewTopic {
  return {
    revisionDate: new Date("2026-03-10T00:00:00.000Z"),
    lastRevised: null,
    createdAt: new Date("2026-03-01T00:00:00.000Z"),
    interval: 1,
    eFactor: 2.5,
    repetitionNumber: 0,
    lastQuality: null,
    files: [],
    urls: [],
    questionBank: { state: "none", usableCount: 0 },
    ...overrides,
  };
}

const unavailable = (reason: string) => ({ available: false, reason });
const AVAILABLE = { available: true, reason: null };

describe("computeReviewState — quiz availability", () => {
  it("reports both quizzes unavailable with no_materials for a due topic with no files or URLs", () => {
    const { review } = computeReviewState(topic(), ctx());

    expect(review).toEqual({ doneToday: false, normalQuiz: { ...unavailable("no_materials"), questionCount: 0 }, aiQuiz: unavailable("no_materials") });
  });

  it("reports no_materials even when a bank remains after every attachment was removed", () => {
    const { review } = computeReviewState(topic({ questionBank: { state: "ready", usableCount: 12 } }), ctx());

    expect(review.normalQuiz).toEqual({ ...unavailable("no_materials"), questionCount: 5 });
    expect(review.aiQuiz).toEqual(unavailable("no_materials"));
  });

  it("covers AE7: a new topic whose only material is a processing PDF reports materials_processing for both", () => {
    const { review } = computeReviewState(topic({ files: [file("processing")] }), ctx());

    expect(review.normalQuiz).toEqual({ ...unavailable("materials_processing"), questionCount: 0 });
    expect(review.aiQuiz).toEqual(unavailable("materials_processing"));
  });

  it("covers AE11: a ready 15-question bank stays usable while a newly added PDF processes", () => {
    const state = computeReviewState(topic({ files: [file("completed", ago(3 * DAY_MS)), file("processing")], questionBank: { state: "ready", usableCount: 15 } }), ctx());

    expect(state.review.normalQuiz).toEqual({ ...AVAILABLE, questionCount: 5 });
    expect(state.review.aiQuiz).toEqual(AVAILABLE);
  });

  it("covers AE12: with no LLM key, a due topic without a bank reports ai_not_configured for both", () => {
    const { review } = computeReviewState(topic({ files: [file("completed")] }), ctx({ aiConfigured: false }));

    expect(review.normalQuiz).toEqual({ ...unavailable("ai_not_configured"), questionCount: 0 });
    expect(review.aiQuiz).toEqual(unavailable("ai_not_configured"));
  });

  it("keeps the normal quiz available without an LLM key when a usable bank exists", () => {
    const { review } = computeReviewState(topic({ files: [file("completed")], questionBank: { state: "ready", usableCount: 3 } }), ctx({ aiConfigured: false }));

    expect(review.normalQuiz).toEqual({ ...AVAILABLE, questionCount: 3 });
    expect(review.aiQuiz).toEqual(unavailable("ai_not_configured"));
  });

  it("covers AE3: a ready bank whose questions were all retired reports no_questions", () => {
    const { review } = computeReviewState(topic({ files: [file("completed")], questionBank: { state: "ready", usableCount: 0 } }), ctx());

    expect(review.normalQuiz).toEqual({ ...unavailable("no_questions"), questionCount: 0 });
    expect(review.aiQuiz).toEqual(AVAILABLE);
  });

  it.each([[1], [2]])("reports not_enough_questions for a bank with %p usable question(s), ahead of the AI and processing checks", (usableCount) => {
    const { review } = computeReviewState(topic({ files: [file("processing")], questionBank: { state: "ready", usableCount } }), ctx({ aiConfigured: false }));

    expect(review.normalQuiz).toEqual({ ...unavailable("not_enough_questions"), questionCount: usableCount });
  });

  it("makes three usable questions the smallest available quiz", () => {
    const { review } = computeReviewState(topic({ files: [file("completed")], questionBank: { state: "ready", usableCount: 3 } }), ctx());

    expect(review.normalQuiz).toEqual({ ...AVAILABLE, questionCount: 3 });
  });

  it("reports done_today for both quizzes on a topic reviewed today, even with a usable bank", () => {
    const state = computeReviewState(
      topic({ lastRevised: ago(2 * 60 * MIN_MS), revisionDate: new Date("2026-03-25T13:00:00.000Z"), lastQuality: 4, files: [file("completed")], questionBank: { state: "ready", usableCount: 15 } }),
      ctx(),
    );

    expect(state.review).toEqual({ doneToday: true, normalQuiz: { ...unavailable("done_today"), questionCount: 5 }, aiQuiz: unavailable("done_today") });
    expect(state.lastQuality).toBe(4);
  });

  it("reports not_due for a topic due tomorrow", () => {
    const { review } = computeReviewState(topic({ revisionDate: new Date("2026-03-11T00:00:00.000Z"), lastRevised: new Date("2026-03-05T10:00:00.000Z"), files: [file("completed")], questionBank: { state: "ready", usableCount: 15 } }), ctx());

    expect(review.doneToday).toBe(false);
    expect(review.normalQuiz).toEqual({ ...unavailable("not_due"), questionCount: 5 });
    expect(review.aiQuiz).toEqual(unavailable("not_due"));
  });

  it("treats a topic due later today in the learner's zone as due", () => {
    const { review } = computeReviewState(topic({ revisionDate: new Date("2026-03-10T23:30:00.000Z"), files: [file("completed")], questionBank: { state: "ready", usableCount: 4 } }), ctx());

    expect(review.normalQuiz).toEqual({ ...AVAILABLE, questionCount: 4 });
  });

  it("makes the AI quiz available when one attachment is extracted and another is still processing", () => {
    const { review } = computeReviewState(topic({ files: [file("completed")], urls: [url("processing")] }), ctx());

    expect(review.aiQuiz).toEqual(AVAILABLE);
    expect(review.normalQuiz).toEqual({ ...unavailable("materials_processing"), questionCount: 0 });
  });

  it("stops reporting materials_processing once an attachment has been pending past the staleness window", () => {
    const stale = ago(ATTACHMENT_STALE_MS + MIN_MS);
    const { review } = computeReviewState(topic({ files: [file("pending", stale)] }), ctx());

    expect(review.normalQuiz).toEqual({ ...unavailable("extraction_failed"), questionCount: 0 });
    expect(review.aiQuiz).toEqual(unavailable("extraction_failed"));
  });

  it("dates a legacy attachment without statusUpdatedAt from its subdocument id", () => {
    const legacyId = Types.ObjectId.createFromTime(Math.floor(ago(3 * DAY_MS).getTime() / 1000));
    const freshId = Types.ObjectId.createFromTime(Math.floor(ago(5 * MIN_MS).getTime() / 1000));

    expect(computeReviewState(topic({ urls: [{ _id: legacyId, url: "https://example.com/a", processingStatus: "pending" }] }), ctx()).review.aiQuiz).toEqual(unavailable("extraction_failed"));
    expect(computeReviewState(topic({ urls: [{ _id: freshId, url: "https://example.com/a", processingStatus: "pending" }] }), ctx()).review.aiQuiz).toEqual(unavailable("materials_processing"));
  });

  it("reports extraction_failed for both quizzes when every attachment failed", () => {
    const { review } = computeReviewState(topic({ files: [file("failed")], urls: [url("failed")] }), ctx());

    expect(review.normalQuiz).toEqual({ ...unavailable("extraction_failed"), questionCount: 0 });
    expect(review.aiQuiz).toEqual(unavailable("extraction_failed"));
  });

  it.each([["queued"], ["building"]] as const)("reports preparing_questions while the first bank is %s over settled material", (state) => {
    const { review, questionBank } = computeReviewState(topic({ files: [file("completed")], urls: [url("failed")], questionBank: { state, usableCount: 0 } }), ctx());

    expect(review.normalQuiz).toEqual({ ...unavailable("preparing_questions"), questionCount: 0 });
    expect(review.aiQuiz).toEqual(AVAILABLE);
    expect(questionBank).toEqual({ state, usableCount: 0, rebuilding: false });
  });

  it("reports materials_processing ahead of preparing_questions while an attachment is still in flight", () => {
    const { review } = computeReviewState(topic({ files: [file("completed"), file("processing")], questionBank: { state: "queued", usableCount: 0 } }), ctx());

    expect(review.normalQuiz.reason).toBe("materials_processing");
  });

  it("keeps a usable bank available and marks it rebuilding while a rebuild is queued over it", () => {
    const state = computeReviewState(topic({ files: [file("completed")], questionBank: { state: "queued", usableCount: 12 } }), ctx());

    expect(state.questionBank).toEqual({ state: "queued", usableCount: 12, rebuilding: true });
    expect(state.review.normalQuiz).toEqual({ ...AVAILABLE, questionCount: 5 });
  });

  it.each([["failed"], ["empty"]] as const)("keeps the previous questions usable after a rebuild that ended %s", (state) => {
    const result = computeReviewState(topic({ files: [file("completed")], questionBank: { state, usableCount: 7 } }), ctx());

    expect(result.review.normalQuiz).toEqual({ ...AVAILABLE, questionCount: 5 });
    expect(result.questionBank).toEqual({ state, usableCount: 7, rebuilding: false });
  });

  it.each([["none"], ["empty"], ["failed"]] as const)("reports no_questions for a %s bank over extracted material", (state) => {
    const { review } = computeReviewState(topic({ files: [file("completed")], urls: [url("failed")], questionBank: { state, usableCount: 0 } }), ctx());

    expect(review.normalQuiz).toEqual({ ...unavailable("no_questions"), questionCount: 0 });
    expect(review.aiQuiz).toEqual(AVAILABLE);
  });

  it("counts URL entries as materials", () => {
    const { review } = computeReviewState(topic({ urls: [url("completed")] }), ctx());

    expect(review.aiQuiz).toEqual(AVAILABLE);
    expect(review.normalQuiz.reason).toBe("no_questions");
  });

  it("reads a legacy topic with no bank subdocument as state none", () => {
    const { questionBank, review } = computeReviewState(topic({ files: [file("completed")], questionBank: undefined }), ctx());

    expect(questionBank).toEqual({ state: "none", usableCount: 0, rebuilding: false });
    expect(review.normalQuiz.reason).toBe("no_questions");
  });
});

describe("computeReviewState — response fields", () => {
  it("returns exactly the contract fields, and only the three-field bank view", () => {
    const state = computeReviewState(
      topic({
        files: [file("completed")],
        questionBank: { state: "ready", usableCount: 4, requestedAt: NOW, claimedAt: null, sourcedAt: NOW, attempts: 2, errorCode: "X", errorReason: "boom", questions: [{ id: "q1", key: "k", type: "fill_blank", prompt: "p ____", answer: "SECRET" }] },
      }),
      ctx(),
    );

    expect(Object.keys(state).sort()).toEqual(["estimatedRecall", "lastQuality", "nextIntervals", "questionBank", "review"]);
    expect(state.questionBank).toEqual({ state: "ready", usableCount: 4, rebuilding: false });
    expect(JSON.stringify(state)).not.toContain("SECRET");
  });

  it.each([[null], [3.5], [0]])("passes lastQuality %p through", (lastQuality) => {
    expect(computeReviewState(topic({ lastQuality }), ctx()).lastQuality).toBe(lastQuality);
  });

  it("reads a missing lastQuality as null", () => {
    expect(computeReviewState(topic({ lastQuality: undefined }), ctx()).lastQuality).toBeNull();
  });

  it("previews the next interval for every rating 0–5 from the topic's current state", () => {
    const state = { eFactor: 2.36, repetitionNumber: 2, interval: 6 };
    const { nextIntervals } = computeReviewState(topic(state), ctx());

    expect(nextIntervals).toEqual([0, 1, 2, 3, 4, 5].map((quality) => calculateNextReview({ ...state, quality }).interval));
    expect(nextIntervals).toEqual([1, 1, 1, 13, 14, 15]);
  });

  it("estimates recall from the topic's interval and last review", () => {
    const { estimatedRecall } = computeReviewState(topic({ interval: 6, lastRevised: ago(6 * DAY_MS) }), ctx());
    expect(estimatedRecall).toBeCloseTo(0.9, 6);
  });
});

describe("sm2Algorithm — retention and interval previews", () => {
  it("retentionAt is 1 at the review and 0.9 one interval later", () => {
    expect(retentionAt(0, 6)).toBe(1);
    expect(retentionAt(6, 6)).toBeCloseTo(0.9, 10);
    expect(retentionAt(1, 1)).toBeCloseTo(0.9, 10);
  });

  it("retentionAt matches the forgetting curve's original formula bit for bit", () => {
    const stabilityFactor = -1 / Math.log(0.9);
    for (const interval of [1, 2, 6, 13, 15, 38, 250]) {
      for (let d = 0; d <= 400; d += 7) {
        expect(retentionAt(d, interval)).toBe(Math.exp(-d / (interval * stabilityFactor)));
      }
    }
  });

  it("is about 0.90 on the due date and lower when overdue", () => {
    const reviewed = new Date("2026-03-01T09:00:00.000Z");
    const due = new Date(reviewed.getTime() + 6 * DAY_MS);
    const onDue = estimateRetention({ interval: 6, lastRevised: reviewed, createdAt: new Date("2026-02-01T00:00:00.000Z") }, due);
    const overdue = estimateRetention({ interval: 6, lastRevised: reviewed, createdAt: new Date("2026-02-01T00:00:00.000Z") }, new Date(due.getTime() + 4 * DAY_MS));

    expect(onDue).toBeCloseTo(0.9, 6);
    expect(overdue).toBeLessThan(onDue);
    expect(overdue).toBeCloseTo(retentionAt(10, 6), 10);
  });

  it("counts a never-reviewed topic from its creation", () => {
    const createdAt = new Date("2026-03-01T00:00:00.000Z");

    expect(estimateRetention({ interval: 1, lastRevised: null, createdAt }, new Date(createdAt.getTime() + DAY_MS))).toBeCloseTo(0.9, 6);
    expect(estimateRetention({ interval: 1, lastRevised: undefined, createdAt }, new Date(createdAt.getTime() + 3 * DAY_MS))).toBeCloseTo(retentionAt(3, 1), 10);
  });

  it("counts from the later of the last review and the creation", () => {
    const createdAt = new Date("2026-03-09T00:00:00.000Z");
    const lastRevised = new Date("2026-03-01T00:00:00.000Z");

    expect(estimateRetention({ interval: 1, lastRevised, createdAt }, new Date("2026-03-10T00:00:00.000Z"))).toBeCloseTo(0.9, 6);
  });

  it("is 1 right after a review and never leaves [0, 1]", () => {
    const at = new Date("2026-03-10T00:00:00.000Z");

    expect(estimateRetention({ interval: 6, lastRevised: at, createdAt: at }, at)).toBe(1);
    // A clock behind the anchor never reports more than 1.
    expect(estimateRetention({ interval: 6, lastRevised: at, createdAt: at }, new Date(at.getTime() - DAY_MS))).toBe(1);
    const late = estimateRetention({ interval: 1, lastRevised: at, createdAt: at }, new Date(at.getTime() + 10_000 * DAY_MS));
    expect(late).toBeGreaterThanOrEqual(0);
    expect(late).toBeLessThan(0.001);
  });

  it("is 1 when the topic has no anchor date at all", () => {
    expect(estimateRetention({ interval: 3, lastRevised: null, createdAt: null }, NOW)).toBe(1);
  });

  it.each([
    [{ eFactor: 2.5, repetitionNumber: 0, interval: 1 }, [1, 1, 1, 1, 1, 1]],
    [{ eFactor: 2.5, repetitionNumber: 1, interval: 1 }, [1, 1, 1, 6, 6, 6]],
    [{ eFactor: 2.5, repetitionNumber: 2, interval: 6 }, [1, 1, 1, 14, 15, 15]],
    [{ eFactor: 1.3, repetitionNumber: 5, interval: 40 }, [1, 1, 1, 52, 52, 56]],
  ])("previewIntervals(%p) matches calculateNextReview for ratings 0–5", (state, expected) => {
    const preview = previewIntervals(state);

    expect(preview).toHaveLength(6);
    expect(preview).toEqual([0, 1, 2, 3, 4, 5].map((quality) => calculateNextReview({ ...state, quality }).interval));
    expect(preview).toEqual(expected);
  });
});
