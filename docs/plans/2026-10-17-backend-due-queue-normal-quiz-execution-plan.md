---
title: Due Queue and Normal Quiz - Backend Execution Plan (U1-U7)
type: feat
date: 2026-10-17
source_plan: E:/Reviser/js/reviser-web/docs/plans/2026-09-26-0820-feat-due-queue-normal-quiz-plan.md
handoff: E:/Reviser/js/reviser-web/docs/plans/2026-10-15-backend-handoff-due-queue-normal-quiz.md
execution: code
---

# Due Queue and Normal Quiz: Backend Execution Plan

This plan turns units U1 to U7 of the source plan into an ordered build for this repo. The source plan's requirements, KTDs and the handoff's API contract still govern. This document adds three things: what the current code changes about the source plan, the values the source plan left to implementation, and the order and file ownership for the build, including which parts run in parallel.

The owner approved the source plan. The only change since is frontend styling (Tailwind and shadcn), which does not touch these units or the API contract.

## Gates

- `pnpm build` (tsc `--noEmit` under strict, then esbuild) must pass.
- `pnpm test`: every new test passes, and the 153 tests that pass today keep passing. Today 15 suites pass and 11 fail to compile. Any of the 11 that U1's harness fix lets compile is listed with its result, not repaired.
- Focused runs per unit: `npx jest <unit test files>`.
- Repair dry run: `npx tsx src/scripts/repairAndBackfill.ts --dry-run` against a seeded local database, run twice.

## What the code changes about the source plan

Found while checking the source plan against source on 2026-10-15/17:

1. **Time-zone header.** `getDueTopics` and `getStatistics` read `req.headers["X-Local-TimeZone"]?.[0]`. Node lowercases header names, so the read is always `undefined`, and on a string `[0]` would take the first character anyway. Every learner therefore gets `Asia/Calcutta`. The frontend sends `X-Local-TimeZone` (`reviser-web/src/service/AxiosInstance.mjs:30`). This matches KTD9 and needs no change to the plan.
2. **No transactions.** The deployed MongoDB is a standalone `mongo:noble` container (`../.github/docker-compose.yml`), not a replica set. The day claim therefore uses one conditional update followed by the record write, with compensation if the write fails. This settles the deferred "compensation or transaction" item.
3. **SM-2 inputs come from the last record, not the topic.** `recordRevision` reads `eFactor` and `interval` from the latest `RevisionRecord`. That only made sense alongside the undo toggle. Once the toggle is gone, the topic's fields are the source of truth, and the day claim reads them.
4. **`recordRevision` moves to a service.** `structure.md` already says to move it to `src/services/` if it is extended. The quiz controller is a third caller, so it moves to `src/services/reviewRecorder.ts`.
5. **Attachments have no status timestamp.** The staleness window (KTD13) needs to know when an attachment entered `pending` or `processing`. URL entries have `processedAt: null` and file entries have a creation default. Add `statusUpdatedAt` to both subdocuments, set it on every status write, and fall back to the subdocument `_id` timestamp for legacy entries.
6. **Stale attachments are written as failed.** The source plan says a stale attachment "counts as failed". The sweep also writes `failed` with `errorReason: "Processing timed out"`, so the topic page shows a truthful status (R40) and the sweep cannot republish the same topic forever. If the object is processed later, the worker moves the entry back to `completed` and fires the settle trigger. Availability treats a stale attachment as failed before the sweep runs, so the two agree.
7. **Files have no size field.** U2 says to take "type and size" from the HEAD response on upsert. Add an optional `size` to file entries.
8. **`QueuePublisher.publish` returns `false` instead of throwing.** The existing `try/catch` around `Publishers.url.publish` never fires. New code checks the boolean. A URL that cannot be queued is saved as `failed` (KTD13).
9. **Prefetch is per consumer.** `QueueConsumer.consume` calls `channel.prefetch(1)` with `global=false`, which RabbitMQ applies to each consumer on the channel separately. A second consumer on the file worker's channel therefore gets its own lane, as KTD4 assumes.
10. **Statistics aggregates are not scoped by `userId`.** The per-subject and per-day aggregates in `statisticsController.ts` have no `$match` on `userId`. The owner directed that this PR **not** fix it. It is listed at the top of the PR description and in `known-gaps.md`. U1 only changes the time-zone read there.
11. **One U1 harness step is already done.** `s3Storage.ts` already imports `@config/s3.js`. The relative imports that remain are in `chatContext.ts`, `fileExtractor.ts`, `mindMapGenerator.ts` and `questionAgent.ts`.
12. **The file worker validates before touching the database.** `processFile` throws on a bad content type before any database call, so the failure has no entry to land on. The upsert therefore moves ahead of validation, and a rejected upload then shows as `failed` with its reason.
13. **Mongoose 9.** Update pipelines need explicit opt-in, so bank and retirement writes use plain operators (`$pull` + `$inc` guarded by a filter), plus a denormalized `questionBank.usableCount`.

## Values the source plan deferred

All live in `src/config/questionBank.ts` (no new env vars, per the source plan's operational notes):

| Name | Value | Why |
|---|---|---|
| `BANK_EXTRACTION_COUNT` | 25 | extract → review → format typically keeps 60–70%, which lands near 15 |
| `CHAT_EXTRACTION_COUNT` | 10 | chat unchanged |
| `MAX_BANK_SIZE` | 20 | headroom over the ~15 target without a runaway bank |
| `MATERIAL_CHAR_CAP` | 120,000 chars | ~30k tokens per prompt, and the material is sent three times per build |
| `LLM_ATTEMPTS` | 3 (backoff 1s, 2s) | bounded retries per pipeline step |
| `STALE_CLAIM_MS` | 15 min | a build is three LLM calls, so well under this |
| `ATTACHMENT_STALE_MS` | 60 min | file extraction takes minutes; leaves room for queue backlog during the backfill |
| `SWEEP_INTERVAL_MS` | 5 min | |
| `SWEEP_MAX_ATTEMPTS` | 3 | then `failed` with `errorCode: "BUILD_STALLED"` |
| `QUIZ_QUESTIONS` | 5 | R22 |
| `QUIZ_MIN_SCORED` | 3 | R37 |
| `QUIZ_SESSION_TTL_MS` | 24 h | unfinished sessions expire via a TTL index on `expiresAt` |
| `QUIZ_COMPLETED_TTL_MS` | 7 days | completed sessions stay long enough for idempotent repeats |

The formatter prompt's wording is written in U3 and tuned against fixture material until it meets the stop condition: at least five valid questions for typical fixture topics.

## Shared contracts (pinned before parallel work)

The foundation step (F, below) lands these so U3, U4, U5 and U6 can build against them at the same time.

**Topic model additions (`src/models/Topic.ts`)**

```ts
type BankState = "none" | "queued" | "building" | "ready" | "empty" | "failed";
interface IBankQuestion {
  id: string;              // random, stable within a build
  key: string;             // normalizeText(prompt): retirement and dedupe key
  type: "mcq" | "fill_blank";
  prompt: string;          // fill_blank prompts contain exactly one "____"
  options?: string[];      // mcq: four unique options, one equals answer
  answer: string;
  alternatives?: string[]; // fill_blank accepted alternatives (KTD19)
}
interface IQuestionBank {
  state: BankState;               // default "none"
  questions: IBankQuestion[];     // select: false — never in topic responses
  usableCount: number;            // denormalized questions.length
  requestedAt: Date | null;       // latest build request
  claimedAt: Date | null;         // claim time of the running build
  claimRequestedAt: Date | null;  // requestedAt of the message holding the claim
  sourcedAt: Date | null;         // claim time of the last successful (ready or empty) build
  builtAt: Date | null;
  attempts: number;               // sweep republish count, reset by a successful build or a new trigger
  errorCode: string | null;
  errorReason: string | null;
}
interface IRetiredQuestion { key: string; text: string; retiredAt: Date }
// ITopic gains: questionBank, retiredQuestions (select: false, append-only), lastQuality: number | null
// IAttachedFile gains: size?, statusUpdatedAt?;  IAttachedUrl gains: statusUpdatedAt?
```

**Helpers**

- `src/services/learnerDay.ts` (U1): `learnerDayFromHeader(header, now?)`, `getLearnerDay(req, now?)` → `{ zone, now, start, tomorrowStart }`; `isReviewedToday(topic, day)`; `isDueToday(topic, day)`.
- `src/services/questionText.ts` (F): `normalizeText(s)`, which lowercases, collapses whitespace, trims, and strips trailing `.,;:!?`. It serves both KTD6 retirement keys and KTD19 blank grading. Also exports `BLANK_MARKER = "____"`.
- `src/services/attachments.ts` (F): `fileTypeFor(contentType)`, `isInFlight(att, now)`, `isStale(att, now)`, `summarizeAttachments(topic, now)` → `{ total, completed, inFlight, failed }` (stale counts as failed), `allSettled(topic, now)`, `completedMaterialPaths(topic)`.
- `src/services/questionBankView.ts` (F): `toQuestionBankView(bank)` → `{ state, usableCount, rebuilding }`, where `rebuilding = (queued || building) && usableCount > 0`.
- `src/services/reviewRecorder.ts` (U1): `recordRevision({ userId, topicId, userQuality, llmQuality?, method, quizScored?, quizCorrect?, sessionId?, day })` → `{ nextRevisionDate, lastRevised, eFactor, interval, repetitionNumber, lastQuality, finalQuality }`. It throws `AlreadyReviewedTodayError` (code `ALREADY_REVIEWED_TODAY`).

**U3 service interface consumed by U4**

```ts
// src/services/questionBank.ts
export interface BuildResult { state: "ready" | "empty" | "failed"; questionCount: number; saved: boolean }
export async function buildQuestionBank(p: { topicId: string; userId: string; claimedAt: Date }): Promise<BuildResult>;
```

This call reads only completed attachments' recorded extracted paths, capped. It runs extract, review and format with bounded retries, validates, drops retired and duplicate keys, and saves conditional on `questionBank.claimedAt === claimedAt`. Saves by state:

- `ready`: replace `questions`, set `usableCount`, `builtAt` and `sourcedAt = claimedAt`, clear the claim, reset `attempts`, clear the error.
- `empty`: set `sourcedAt = claimedAt` and clear the claim; previous questions stay.
- `failed`: set `errorCode` and `errorReason` and clear the claim; previous questions stay.

`saved: false` means the claim was superseded. LLM and storage failures become `failed` and never throw. Only database errors throw, so the consumer can requeue.

**Queue message (`src/schemas/queue.schema.ts`)**: `questionBankMessageSchema = { topicId, userId, requestedAt: ISO datetime, reason: "materials_settled" | "material_removed" | "regenerate" | "backfill" | "sweep" | "follow_up" }`.

## Build order and ownership

```
U1 ─► F + U2 ─┬─► U3 (agent A) ──┐
              ├─► U5 (agent B) ──┼─► integrate ─► U7 ─► review ─► PR
              ├─► U6 (agent C) ──┤
              └─► U4 (main) ─────┘
```

The main agent owns U1, F, U2, U4, integration, U7, every gate run and every commit. Sub-agents A, B and C work in this worktree on disjoint files. They run only their own focused tests, judge `tsc` on their own files, and never commit, stash or touch git state. Shared-file edits are listed per unit, and nobody else edits those files during the parallel phase.

### U1. Learner day and single-review writes (main, test-first on the day claim)

Files:

- Create: `src/types/express.d.ts`, `src/services/learnerDay.ts` (+ test), `src/services/reviewRecorder.ts`, `src/controllers/reviewWrites.test.ts`.
- Modify: `src/middleware/auth.ts` (drop the augmentation), `tsconfig.test.json` (include `src/types/**/*.d.ts`), `src/services/{chatContext,fileExtractor,mindMapGenerator,questionAgent}.ts` (alias imports), `src/models/RevisionRecord.ts`, `src/models/Topic.ts` (`lastQuality`), `src/models/ChatSession.ts` (`result`), `src/schemas/topic.schema.ts` (`markRevisedSchema`, 0–5), `src/controllers/topicController.ts` (`markTopicRevised`, `getDueTopics` window, `resetTopicProgress` clears `lastQuality`, history reads `method ?? "self"`), `src/controllers/chatController.ts`, `src/controllers/statisticsController.ts` (zone read only), `src/services/sm2Algorithm.ts` (optional `now`).

Approach:

1. **Day claim.** Read the topic's SM-2 state. Refuse if `lastRevised >= day.start`. Compute SM-2 from the topic's fields, then run `findOneAndUpdate({ _id, userId, $or: [{ lastRevised: null }, { lastRevised: { $lt: day.start } }] }, { $set: schedule, lastRevised: now, lastQuality })`. If that update matches nothing, throw `AlreadyReviewedTodayError`. Otherwise create the `RevisionRecord` with `method`, quiz counts and `sessionId`. If the record write fails, restore the previous values with a filter on `lastRevised: now` and rethrow.
2. **`/revised`.** The same-day toggle is deleted. The body is `{ userQuality }` (0–5) and the method is `self`. The response is the contract shape. `409 ALREADY_REVIEWED_TODAY` on a second review.
3. **Chat.** Return after `CONTENT_NOT_FOUND`. `complete` follows these steps:
   - A session that already has `result` returns it.
   - A topic reviewed today returns 409 before any LLM call.
   - Otherwise assess and record with `ai_quiz` and `sessionId`.
   - If recording loses the day claim, a record carrying this `sessionId` means a concurrent finish won, so return that record's result. Otherwise return 409.
   - Store `result` on the session.
   - A legacy session completed before this change, with no `result`, returns `400 SESSION_INVALID`.
4. **Records.** `RevisionRecord` quality fields accept 0, and `llmQuality` uses a presence check instead of truthiness. New fields: `method` (enum, default `self`), `quizScored`, `quizCorrect`, `sessionId`.

Tests cover the U1 scenarios: header casing and fallback, AE13, concurrent completions against mongodb-memory-server, the 23:30/00:30 boundary, a 0 rating, 4+0 giving 2, chat idempotency, `CONTENT_NOT_FOUND` with no question generation, methods and `lastQuality`, AE14, and statistics in the learner's zone.

### F. Foundation for U2–U6 (main)

`Topic` model additions above, `src/config/questionBank.ts`, `questionText.ts`, `attachments.ts`, `questionBankView.ts`, `buildUploadKey` in `uploadKey.ts` (used by `generatePresignedUploadUrl` and U2's entries), and a nested-`select: false` model test.

### U2. Attachment status and topic edit fixes (main)

Files:

- Create: `src/services/topicMaterials.ts`, `src/lambda/fileProcessor.entries.test.ts`, `src/controllers/topicUpdates.test.ts`.
- Modify: `fileProcessor.ts`, `urlProcessor.ts` (`statusUpdatedAt` only), `createTopicController.ts`, `topicController.ts` (`updateTopic`, `uploadTopicFiles`, `getTopicById` statuses, `deleteTopicFile`), and `topic.schema.ts` (`updateTopicSchema` moves here and accepts `YYYY-MM-DD` or full ISO).

Approach:

- **Pending entries.** `createTopic` and `uploadTopicFiles` write a pending entry per declared file, keyed by its upload key. A re-upload under the same name resets the existing entry instead of duplicating it.
- **URL failures.** Non-`http(s)` URLs and URLs whose publish fails are saved as `failed` with a reason.
- **Worker upsert.** `processFile` HEADs the object, then runs `$push` guarded by `"files.s3Path": { $ne: key }`, taking type and size from the HEAD, then validates, then marks the entry processing.
- **URL saves.** `updateTopic` diffs the URL list with atomic `$pull`/`$push`, so a concurrent worker status write is never clobbered. It deletes removed entries' extracted files by recorded path and publishes only the new publishable URLs.
- **Study date.** The schedule and history reset only when the submitted date, read as a calendar day, differs from the stored date viewed in the learner's zone. A changed date-only value is stored as UTC midnight. A reset also clears `lastRevised` and `lastQuality`, matching `/reset`.
- **Bank hooks.** `topicMaterials.ts` exposes `afterMaterialRemoved(topicId, userId)`, which U4 implements. In U2 it only clears the mind map, as today.

### U3. Question bank pipeline (agent A)

Files:

- Create: `src/services/questionBank.ts` (+ test), `src/services/__properties__/questionText.property.test.ts`.
- Modify: `src/services/questionAgent.ts` (extraction count parameter; chat keeps 10) and `src/config/prompts.ts` (`PROMPTS.questionBank.formatter`, the extractor's count parameter).

The extractor is reused with a count parameter. The reviewer prompt is unchanged. Reads go through `getExtractedContent(userId, path)` per completed attachment, which already retries and checks the user prefix. The material cap truncates with a log line. Structural validation is a pure exported `validateFormattedItems(raw, retiredKeys)`. All U3 test scenarios are in scope.

### U4. Bank job, triggers, sweep, Regenerate (main)

Files:

- Create: `src/services/questionBankJobs.ts` (trigger and claim protocol), `src/lambda/questionBankProcessor.ts` (consumer and sweep), its test, `src/controllers/questionBankController.ts` (+ test).
- Modify: `src/config/rabbitmq.ts` (exchange, queue, DLQ, routing key), `src/schemas/queue.schema.ts`, `src/services/rabbitmq/index.ts` (`Publishers.questionBank`), `fileProcessor.ts` and `urlProcessor.ts` (settle trigger; the worker registers its own bank publisher), `topicMaterials.ts` (rebuild or clear on removal), and `src/routes/topicRoutes.ts` (`POST /:id/questions/regenerate` behind `requireAIConfig`, above `/:id`).

Claim protocol per message `m`:

1. Skip (ack) if `sourcedAt > m.requestedAt`.
2. If a fresh `building` claim exists and `claimRequestedAt !== m.requestedAt`, raise `requestedAt` to `max(requestedAt, m.requestedAt)` and ack.
3. Otherwise claim atomically. The filter is: not building, or a stale claim, or `claimRequestedAt === m.requestedAt` (a redelivery takes over its own claim).
4. Call `buildQuestionBank`.
5. If `requestedAt > claimedAt` afterwards, set `queued` and publish one `follow_up` carrying that `requestedAt`.

A database error before or during the build is requeued. The file-processor entry starts the bank consumer and the sweep whenever it starts the file consumer. The sweep does two things:

- It writes stale attachments as `failed` and fires the settle trigger.
- It republishes banks stuck `queued` or `building` past `STALE_CLAIM_MS` up to `SWEEP_MAX_ATTEMPTS`, then writes `failed`.

### U5. Normal quiz session API (agent B)

Files:

- Create: `src/models/QuizSession.ts`, `src/services/quizScoring.ts` (+ `__properties__/quizScoring.property.test.ts`), `src/services/quizSession.ts` (start, answer, flag, complete and retirement logic), `src/controllers/quizController.ts` (+ test), `src/routes/quizRoutes.ts`, `src/schemas/quiz.schema.ts`.
- Modify: `src/schemas/index.ts` and `src/index.ts` (mount `/api/quiz`, no AI gate).

Start checks run in availability order: `TOPIC_NOT_FOUND`, then `ALREADY_REVIEWED_TODAY`, then `NOT_DUE`, then `NOT_ENOUGH_QUESTIONS`. A reviewed topic is never due, so `done_today` has to come first. Start draws with `crypto.randomInt` Fisher–Yates and shuffles options.

Answers grade with a conditional positional update (`$elemMatch` on unanswered), so a repeat or race returns the stored result. Multiple-choice responses compare by normalized option text, blanks by KTD19.

Flag:

- `409 NOT_ANSWERED` before an answer.
- Otherwise it marks the question flagged, `$push`es the retired entry guarded by key, then `$pull`s the bank question by key with a guarded `$inc` of `usableCount`.
- Flagging after completion still retires the question but leaves the stored result alone. This is an unspecified edge, documented in `api.md`.

Complete:

- `409 INCOMPLETE` while any question is unanswered, and a completed session returns its stored result.
- With fewer than three scored questions, the rating is `null` and nothing is recorded.
- Otherwise the R29 band is applied with integer math (`correct * 100 >= 80 * scored`) and `recordRevision` runs with `normal_quiz`, the counts and `sessionId`.
- If the day claim is lost, a record with this `sessionId` means a concurrent finish won, so return the result. Otherwise return `409 ALREADY_REVIEWED_TODAY`.

An unknown `questionId` returns `404 QUESTION_NOT_FOUND`. This is an addition to the contract and is documented.

### U6. Review availability (agent C)

Files:

- Create: `src/services/reviewAvailability.ts` (+ test).
- Modify: `src/services/sm2Algorithm.ts` (`retentionAt(days, interval)`, `estimateRetention(topic, now)`, `previewIntervals(topic)`), `src/middleware/aiConfigCheck.ts` (export `isAIConfigured()`), `src/controllers/topicController.ts` (only `getDueTopics`, `getTopicById` decoration and `getForgettingCurve`'s formula), and `src/types/topic.types.ts`.

`computeReviewState(topic, { day, now, aiConfigured })` returns the contract fields, applying the source plan's ordered rules verbatim. "No files or URLs" counts entries. "Usable" is `usableCount`. The decorated responses replace the raw `questionBank` object with `toQuestionBankView`, and neither query loads `questionBank.questions` or `retiredQuestions`.

### U7. Repair, backfill and docs (main)

Files:

- Create: `src/services/launchRepair.ts` (pure planner plus executor), `src/services/launchRepair.test.ts`, `src/scripts/repairAndBackfill.ts` (entry: flags `--dry-run`, `--user`).
- Modify: `.claude/docs/{architecture,api,product,known-gaps,testing,structure}.md`.

Per topic:

- Files:
  - Each uploaded object without an entry gets a `completed` entry when its extracted object exists. Otherwise it gets a `pending` entry and is republished to the file queue.
  - A `pending` file entry whose extracted object exists becomes `completed`.
- URLs: a URL stuck `pending` becomes `completed` when `url_{sanitized}.md` exists. The rest are republished in one message per topic.
- `lastQuality` is set from the latest record, only when it is null.
- Topics with completed material, a `none` bank and all attachments settled are queued for a build, due first. Topics with republished attachments get their build from the settle trigger instead.

The script never deletes or overwrites learner data. A second run plans nothing. Dry run connects to Mongo and S3 read-only and publishes nothing.

## Ship

`/compound-engineering:ce-code-review` on the branch, fix findings, then commit and open a PR (not merged). The top of the PR description carries:

- any forced API change (also recorded in `.claude/docs/api.md`);
- the statistics `userId` leak, left unfixed by owner direction;
- the results of any previously failing suites that now compile;
- the additions to the contract: `QUESTION_NOT_FOUND`, flag-after-complete.
