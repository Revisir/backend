# HTTP API

Base URL: `http://localhost:5000` (the `PORT` default in `src/index.ts`).

All `/api/*` routes go through `optionalAuth`, so every handler can rely on
`req.userId`. `/health` is the only unauthenticated route.

| | |
|---|---|
| Auth header | `Authorization: Bearer <cognito-jwt>` |
| Content type | `application/json` on every route (no multipart — file uploads are presigned direct-to-S3) |
| Error shape | `{ "error": { "code": string, "message": string, "details"?: any } }` |

## Health

**`GET /health`** — no auth. `200 { status: "ok", message: "..." }`.

## Topics — `/api/topics`

Router: `src/routes/topicRoutes.ts` · Controllers: `topicController.ts`,
`createTopicController.ts`

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

The client then `PUT`s each file's bytes directly to its `uploadUrl`. The initial
`revisionDate` comes from a seed SM-2 run at `quality: 3`, so a fresh topic is due
in 1 day.

Only `http://`/`https://` URLs are published to the queue (`filterPublishableUrls`).
A publish failure is logged, not surfaced — you still get a 201.

### `GET /api/topics/due`
Topics with `revisionDate <= now`. → `200 { topics }`

### `GET /api/topics/:id`
→ `200` topic document (with the `isDue` and `isProcessingComplete` virtuals)

### `PATCH /api/topics/:id`
Body: any of `topicName`, `subjectName`, `description`, `dateStudied`.
→ `200 { success: true, topic }`

### `DELETE /api/topics/:id`
Deletes the topic and its revision records. → `200 { success: true }`

### `GET /api/topics/:id/history`
→ `200 { history: RevisionRecord[] }`

### `GET /api/topics/:id/forgetting-curve`
→ `200 { topicName, eFactor, interval, repetitionNumber, revisionDate, lastRevised, curvePoints, revisionMarkers }`

### `POST /api/topics/:id/revised`
Self-reported revision, no chat session. Body: `userQuality` (1–5),
`llmQuality` (1–5, optional). Runs SM-2 and writes a `RevisionRecord`.
→ `200 { success: true, nextRevisionDate, newInterval, newEFactor }`

### `POST /api/topics/:id/reset`
Clears SM-2 state and revision history. → `200 { success: true, revisionDate }`

### `POST /api/topics/:id/files`
Presigned URLs for additional files on an existing topic.
Body: `files: [{ fileName, size, contentType }]`
→ `200 { uploadUrls: [{ fileName, uploadUrl }] }`

### `DELETE /api/topics/:id/files/:fileId`
→ `200 { success: true }`

### `POST /api/topics/:id/mindmap` · `GET /api/topics/:id/mindmap`
Both behind `requireAIConfig`. `POST` generates and caches, `GET` reads the cache.
→ `200 { mindmap, generatedAt }` · `GET` returns `404` when none has been generated.

> Route ordering matters here: `/due` is registered before `/:id`, so it is not
> swallowed by the id param. Any new literal sub-path must go above `/:id` too.

## Chat — `/api/chat`

Router: `src/routes/chatRoutes.ts` · Controller: `chatController.ts`
The whole router is behind `requireAIConfig` (`503 AI_NOT_CONFIGURED` without an LLM key).

### `POST /api/chat/start`
Body: `{ topicId }`. Builds context from the topic's extracted material, runs the
extract → review question pipeline, stores the question set on a new `ChatSession`.
→ `200 { sessionId, initialMessage, totalQuestions }`

`400 NO_MATERIALS` if the topic has neither files nor `http(s)` URLs.
`404 CONTENT_NOT_FOUND` if nothing has been extracted yet.

### `POST /api/chat/message`
Body: `{ sessionId, message }`. Evaluates the answer against the stored expected
answer, returns feedback and advances to the next question.
→ `200 { response }`

### `POST /api/chat/complete`
Body: `{ sessionId, topicId, userQuality }` — `userQuality` 0–5.
The LLM scores the transcript to produce `llmQuality` server-side;
`finalQuality = (userQuality + llmQuality) / 2` feeds SM-2. The session is closed
(`active: false`, `completedAt` set).
→ `200 { nextRevisionDate, finalQuality }`

> **`llmQuality` is not a request field.** The JSDoc above this route in
> `chatRoutes.ts` claims it is; `completeChatSessionSchema` does not accept it and
> the controller computes it. Trust the schema.

## Statistics — `GET /api/statistics`

→ `200 { totalTopics, dueToday, revisedThisWeek, revisedThisMonth, upcomingRevisions: [{ date, count }] }`

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
