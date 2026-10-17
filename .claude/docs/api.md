# HTTP API

Base URL: `http://localhost:5000` (the `PORT` default in `src/index.ts`).

All `/api/*` routes go through `optionalAuth`, so every handler can rely on
`req.userId`. `/health` is the only unauthenticated route.

| | |
|---|---|
| Auth header | `Authorization: Bearer <cognito-jwt>` |
| Learner time zone | `X-Local-TimeZone: <IANA zone>` (e.g. `America/New_York`), sent by the frontend on every request. Missing or invalid → UTC. |
| Content type | `application/json` on every route (no multipart — file uploads are presigned direct-to-S3) |
| Error shape | `{ "error": { "code": string, "message": string, "details"?: any } }` |

**"Today" is the learner's local day.** `src/services/learnerDay.ts` reads
`X-Local-TimeZone` (Node lowercases header names, so it is read as
`x-local-timezone`), validates it as an IANA zone and falls back to UTC. The due
list, statistics, the done-today flag, the one-review-per-day rule and the
topic-edit date check all use it.

## Contract changes against the frontend handoff

The handoff contract (`reviser-web/docs/plans/2026-10-15-backend-handoff-due-queue-normal-quiz.md`)
is implemented as written: no field, code or status was changed. These are
additions for cases the contract left unspecified:

| Endpoint | Addition |
|---|---|
| `POST /api/quiz/:sessionId/answer`, `/flag` | `404 QUESTION_NOT_FOUND` when `questionId` is not in the session |
| `POST /api/quiz/:sessionId/flag` | Flagging after completion still retires the question and returns `200`; the stored completion result is unchanged |
| `POST /api/quiz/:sessionId/complete` | `404 TOPIC_NOT_FOUND` when the topic was deleted during the quiz |
| `/api/quiz/:sessionId/*` | An expired session (past its TTL, before MongoDB deletes it) returns `404 SESSION_NOT_FOUND` |
| all `/api/quiz/*` | `400 VALIDATION_ERROR` for a malformed body or a `:sessionId` that is not an ObjectId |
| `POST /api/chat/complete` | `400 SESSION_INVALID` for a session completed before results were stored on sessions (no stored result to replay) |

## Health

**`GET /health`** — no auth. `200 { status: "ok", message: "..." }`.

## Topics — `/api/topics`

Router: `src/routes/topicRoutes.ts` · Controllers: `topicController.ts`,
`createTopicController.ts`, `questionBankController.ts`

### Review fields

`GET /api/topics/due` items and `GET /api/topics/:id` carry these computed
fields (`src/services/reviewAvailability.ts`). Neither ever includes bank
questions, answers or the retired list.

```ts
lastQuality: number | null            // final rating of the latest review; older AI reviews may hold halves
estimatedRecall: number               // 0..1: e^(-t/S), S = interval / -ln(0.9), t = days since the later of lastRevised and createdAt
nextIntervals: number[]               // length 6; index = rating 0..5; days until the next review if rated that now
questionBank: {
  state: "none" | "queued" | "building" | "ready" | "empty" | "failed"
  usableCount: number                 // questions available to draw now (previous questions count during a rebuild)
  rebuilding: boolean                 // queued or building while usableCount > 0
}
review: {
  doneToday: boolean                  // reviewed in the learner's current day
  normalQuiz: { available: boolean; reason: ReasonCode | null; questionCount: number } // questionCount = min(5, usableCount)
  aiQuiz: { available: boolean; reason: ReasonCode | null }
}

type ReasonCode =
  | "done_today" | "not_due" | "no_materials" | "not_enough_questions"
  | "ai_not_configured" | "materials_processing" | "preparing_questions"
  | "extraction_failed" | "no_questions"
```

Reasons are evaluated in order; the first match wins.

Normal quiz: reviewed today → `done_today`; not due today → `not_due`; no
files or URLs → `no_materials`; `usableCount >= 3` → available (also while
rebuilding, and after an empty or failed rebuild that kept earlier questions);
1–2 usable → `not_enough_questions`; no LLM key → `ai_not_configured`; an
attachment pending or processing within the staleness window →
`materials_processing`; bank queued or building → `preparing_questions`; every
attachment failed (stale counts as failed) → `extraction_failed`; otherwise
→ `no_questions`.

AI quiz: the first three rules above; no LLM key → `ai_not_configured`; at
least one attachment completed → available; one in flight →
`materials_processing`; otherwise → `extraction_failed`.

### `GET /api/topics`
Paginated list. Query: `page` (≥1, default 1), `limit` (1–100, default 10),
`subject` (optional exact-match filter).
→ `200 { topics, total, page }`

### `POST /api/topics`
Creates the topic, publishes attached URLs to the extraction queue, and returns
presigned upload URLs for the declared files. Body (`createTopicSchema`):

```json
{
  "topicName":   "string, 1-200 chars",
  "subjectName": "string, 1-100 chars",
  "description": "string, max 1000 chars, optional",
  "dateStudied": "ISO date, must not be in the future",
  "urls":        ["valid URL", "..."],
  "files":       [{ "fileName": "...", "size": 1234, "contentType": "application/pdf" }]
}
```

`urls`: 1–20 entries when present. `files` entries are metadata only — no bytes.

→ `201 { topicId, topicName, subjectName, description, dateStudied, revisionDate, isDue, uploadUrls: [{ fileName, uploadUrl }] }`

The client then `PUT`s each file's bytes directly to its `uploadUrl`. Each
declared file gets a `pending` entry at once (keyed by its storage path,
`{userId}/{topicId}/files/{fileName}`), so it shows on the topic page and holds
back the question-bank build until it settles. The initial `revisionDate` comes
from a seed SM-2 run at `quality: 3`, so a fresh topic is due in 1 day.

Only `http://`/`https://` URLs are published. Any other URL is saved as
`failed` with a reason, and so is a URL whose publish fails. You still get a
201 either way.

### `GET /api/topics/due`
Topics due in the learner's current day (`revisionDate` before the start of
the learner's tomorrow), plus topics already reviewed today, so the queue can
keep showing them as done. Sorted by `revisionDate`, most overdue first. Each
topic carries the review fields above. → `200 { topics }`

### `GET /api/topics/:id`
→ `200` topic document (a lean read, so without the `isDue` and
`isProcessingComplete` virtuals) plus the review fields. Every `files[]` entry is
`{ _id, fileName, fileType, fileUrl, processingStatus, errorReason? }` and
every `urls[]` entry carries `processingStatus`; `errorReason` is present when
the status is `failed`.

### `PATCH /api/topics/:id`
Body: any of `topicName`, `subjectName`, `description`, `urls`, `dateStudied`.

- `urls` is the full list. Existing entries are left exactly as they were
  (status, extracted path); new `http(s)` URLs are added `pending` and
  published; other new URLs are saved `failed`. Removed URLs lose their entry
  and their extracted file, and the question bank is rebuilt from what remains
  (or cleared to `none` when no extracted material remains).
- `dateStudied` takes `YYYY-MM-DD` (what the edit form sends) or a full ISO
  date-time. The schedule and revision history reset only when the date
  differs from the stored one **as seen in the learner's zone**; a changed
  date-only value is stored as UTC midnight of that day.

→ `200 { success: true, topic }`

### `DELETE /api/topics/:id`
Deletes the topic and its revision records. → `200 { success: true }`

### `GET /api/topics/:id/history`
→ `200 { history: RevisionRecord[] }`. Each record has `method`
(`self` | `ai_quiz` | `normal_quiz`; records written before this field read as
`self`) and, for normal quizzes, `quizScored` / `quizCorrect`.

### `GET /api/topics/:id/forgetting-curve`
→ `200 { topicName, eFactor, interval, repetitionNumber, revisionDate, lastRevised, curvePoints, revisionMarkers }`.
Uses the same retention model as `estimatedRecall`.

### `POST /api/topics/:id/revised`
Done: the learner's own rating, no quiz. Body: `{ userQuality }` (0–5). Runs
SM-2 and writes a `RevisionRecord` with `method: "self"`.
→ `200 { success: true, nextRevisionDate, lastRevised, eFactor, interval, repetitionNumber, lastQuality }`

A second review of the topic in the same learner-day → `409 ALREADY_REVIEWED_TODAY`.
The old same-day undo toggle is gone.

### `POST /api/topics/:id/questions/regenerate`
Behind `requireAIConfig`. Queues a rebuild that replaces the question bank;
flagged questions stay retired and the current questions stay usable until the
new bank lands.
→ `202 { questionBank: { state, usableCount, rebuilding } }`
`503 AI_NOT_CONFIGURED` without an LLM key; `404 TOPIC_NOT_FOUND` for another
user's topic.

### `POST /api/topics/:id/reset`
Clears SM-2 state, `lastQuality` and revision history. → `200 { success: true, revisionDate }`

### `POST /api/topics/:id/files`
Presigned URLs for additional files on an existing topic, plus a `pending`
entry per file (a re-upload under the same name resets its entry).
Body: `files: [{ fileName, size, contentType }]`
→ `200 { uploadUrls: [{ fileName, uploadUrl }] }`

### `DELETE /api/topics/:id/files/:fileId`
→ `200 { success: true }`. Removing extracted material rebuilds the bank, or
clears it when none remains.

### `POST /api/topics/:id/mindmap` · `GET /api/topics/:id/mindmap`
Both behind `requireAIConfig`. `POST` generates and caches, `GET` reads the cache.
→ `200 { mindmap, generatedAt }` · `GET` returns `404` when none has been generated.

> Route ordering matters here: `/due` is registered before `/:id`, so it is not
> swallowed by the id param. Any new literal sub-path must go above `/:id` too.

## One review per topic per learner-day

Every way of finishing a review — Done, AI chat completion, normal quiz
completion — goes through `recordRevision` (`src/services/reviewRecorder.ts`).
It claims the learner's day and applies SM-2 in one conditional update on the
topic, then writes the revision record (restoring the topic if that write
fails). A second review that day returns `409 ALREADY_REVIEWED_TODAY` from
whichever endpoint attempted it, except that a repeated or concurrent
completion of the *same* chat or quiz session returns that session's review.

## Normal quiz — `/api/quiz`

Router: `src/routes/quizRoutes.ts` · Controller: `quizController.ts` · Logic:
`src/services/quizSession.ts`. No `requireAIConfig`: a ready bank needs no LLM.

### `POST /api/quiz/start`
Body `{ topicId }` →
`201 { sessionId, topicId, topicName, questions: [{ id, type: "mcq" | "fill_blank", prompt, options?: string[] }] }`.
Five random questions (or every remaining one when fewer remain), snapshotted
on a `QuizSession`. No answer fields. Multiple-choice options are shuffled; a
fill-in-the-blank `prompt` marks the blank with `____`.
Errors, checked in this order: `404 TOPIC_NOT_FOUND`,
`409 ALREADY_REVIEWED_TODAY`, `409 NOT_DUE`, `409 NOT_ENOUGH_QUESTIONS` (fewer
than three usable).

### `POST /api/quiz/:sessionId/answer`
Body `{ questionId, response }` — the chosen option's text, or the typed text
(max 1000 chars; empty is graded wrong). → `200 { questionId, correct, correctAnswer }`.
Graded once: a repeat returns the stored result. Blanks ignore case, extra
spaces and trailing punctuation and accept the formatter's listed alternatives.

### `POST /api/quiz/:sessionId/flag`
Body `{ questionId }` → `200 { questionId, flagged: true }`;
`409 NOT_ANSWERED` before the answer is revealed. The question is retired on the
topic immediately (append-only retired list, removed from the bank) and never
returns, even after a rebuild or Regenerate.

### `POST /api/quiz/:sessionId/complete`
→ `200 { rating: number | null, scored, correct, nextRevisionDate: string | null, results: [{ questionId, correct, flagged, correctAnswer }] }`.
Flagged questions are not scored. With at least three scored, the rating is
100% → 5, 80–99% → 4, 60–79% → 3, 40–59% → 2, 20–39% → 1, under 20% → 0, and is
recorded as a `normal_quiz` review with its counts. With fewer, `rating` and
`nextRevisionDate` are null and the topic stays due. Errors: `409 INCOMPLETE`
while a question is unanswered, `409 ALREADY_REVIEWED_TODAY`. A repeat returns
the stored result.

`404 SESSION_NOT_FOUND` for an unknown, expired or another user's session on
answer, flag and complete. Unfinished sessions expire after 24 hours (TTL
index); completed ones are kept 7 days for repeat completions.

## Chat — `/api/chat`

Router: `src/routes/chatRoutes.ts` · Controller: `chatController.ts`
The whole router is behind `requireAIConfig` (`503 AI_NOT_CONFIGURED` without an LLM key).

### `POST /api/chat/start`
Body: `{ topicId }`. Builds context from the topic's extracted material, runs the
extract → review question pipeline (10 questions), stores the question set on a
new `ChatSession`.
→ `200 { sessionId, initialMessage, totalQuestions }`

`400 NO_MATERIALS` if the topic has neither files nor `http(s)` URLs.
`404 CONTENT_NOT_FOUND` if nothing has been extracted yet — and nothing else
runs.

### `POST /api/chat/message`
Body: `{ sessionId, message }`. Evaluates the answer against the stored expected
answer, returns feedback and advances to the next question.
→ `200 { response }`

### `POST /api/chat/complete`
Body: `{ sessionId, topicId, userQuality }` — `userQuality` 0–5.
The LLM scores the transcript to produce `llmQuality` server-side;
`finalQuality = (userQuality + llmQuality) / 2` feeds SM-2 (an AI score of 0
counts). Recorded once as an `ai_quiz` review, and the result is stored on the
session.
→ `200 { nextRevisionDate, finalQuality }`

Completing an already-completed session returns its stored result. A topic
already reviewed today → `409 ALREADY_REVIEWED_TODAY`, checked before any LLM
call.

## Statistics — `GET /api/statistics`

→ `200 { totalTopics, dueToday, revisedThisWeek, revisedThisMonth, upcomingRevisions, perSubject, revisionPerDay }`.
"Today" is the learner's day. Note the unscoped aggregates in
[known-gaps.md](known-gaps.md#statistics-aggregates-are-not-scoped-by-userid).

## Subjects — `GET /api/subjects`

Distinct subject names for the authenticated user, for filter dropdowns.

## Storage webhook — `POST /internal/storage-webhook`

Not part of the public API and **not behind auth**: it is the SeaweedFS filer's
notification sink, mounted before `optionalAuth` and reachable only inside the
compose network (Caddy proxies `/api` and `/storage`, never `/internal`).

Body is a SeaweedFS filer notification:

```json
{ "key": "/buckets/{bucket}/{objectKey}", "event_type": "create", "message": { "new_entry": { "name": "a.pdf", "is_directory": false } } }
```

→ `202 { status: "queued" }` when `{ bucket, key }` was published to the file queue
→ `204` when the event was deliberately ignored (not a create/update, a directory,
outside a bucket, under `/extracted/`, or not shaped like
`{userId}/{topicId}/files/{fileName}`)
→ `400 { error: { code: "VALIDATION_ERROR", ... } }` on an unparseable body
→ `503` when the queue is unavailable — SeaweedFS then retries with backoff

## Testing endpoints by hand

`apidog/` holds request collections organised by area (`topic/`, `chat/`,
`subjects/`, `statistics.http.yaml`) plus env files. For local work, set
`NODE_ENV=development` and `SKIP_AUTH=true` to skip the bearer token entirely —
requests then run as `TEST_USER_ID`.
