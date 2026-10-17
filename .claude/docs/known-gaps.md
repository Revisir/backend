# Known gaps & drift

Things that look like bugs and are, or look like bugs and aren't. Check here before
"fixing" something — several of these are deliberate mid-migration states, and a
couple are real.

The working tree is mid-migration from **direct/Lambda processing to RabbitMQ
queues**. Most of what follows is fallout from that.

## Statistics aggregates are not scoped by `userId`

**A real data leak, deliberately left unfixed.** In `statisticsController.ts`,
the `perSubject` aggregate (`Topic.aggregate` grouped by subject and due state)
and the `revisionPerDay` aggregate (`RevisionRecord.aggregate` grouped by day)
have no `$match` on `userId`, so `GET /api/statistics` returns every learner's
per-subject counts and daily revision counts, not just the caller's. The other
statistics queries are scoped. This breaks the `CLAUDE.md` scoping rule. It was
found during the due-queue work and left alone on the owner's direction, to be
fixed separately; the fix is a `{ $match: { userId } }` stage at the head of
both pipelines.

## Date-only values stored as UTC midnight are compared as instants

`dateStudied` arrives as `YYYY-MM-DD` and is stored as UTC midnight of that day.
`revisionDate` is also UTC midnight after a changed study date (KTD20 in
`updateTopic`) and after `POST /:id/reset` (which copies `dateStudied`). A new
topic's first `revisionDate` and every reviewed topic's are full timestamps
(the creation or review instant plus the interval).

The learner-day rules (`isDueToday`, `isReviewedToday` in
`src/services/learnerDay.ts`) compare those stored instants with the learner's
day bounds and do not treat a UTC-midnight value as a calendar date. So for a
learner west of UTC, a topic whose `revisionDate` is UTC midnight of day D
becomes due on the evening of D−1 local time (e.g. 19:00 or 20:00 in New
York), and on D the frontend shows it as "Overdue 1 day". East of UTC it falls
due in the early hours of D, which is the intended day. Left as is in this
release (no behavior change beyond the plan); a fix would read UTC-midnight
date-only values as calendar dates in the learner's zone, or store them as the
learner's local midnight.

## The question-bank formatter has not been run against a real LLM

`PROMPTS.questionBank.formatter` and the bank pipeline are covered by tests
with a scripted LLM, and the code validates every item's structure, but no
build has run against a real model yet. The owner's stop condition — at least
five valid questions for typical topics — still needs checking: build a bank
for a few typical topics after deploy (Regenerate on the topic page, or the
repair script's backfill) and look at `questionBank.usableCount` and the
file-processor's "Question bank pipeline finished" log line, which records
extracted, reviewed, formatted and valid counts.

## RabbitMQ consumers are not re-subscribed after a reconnect

`ConnectionManager.handleReconnection` (`src/services/rabbitmq/connectionManager.ts`)
re-establishes the connection and a fresh channel, but nothing re-registers the
consumers that were on the old channel. A worker whose channel closes — a broker
restart, a network drop, or a delivery left unacked past the broker's
`consumer_timeout` (RabbitMQ default 30 min) — stays connected and silently stops
consuming until the process restarts. Pre-existing for the file and URL consumers;
the file-processor now runs two consumers (file extraction and question banks) on
one channel, so a closed channel stops both. A long bank build can approach that
timeout in a pathological case: each of its three LLM steps is retried up to three
times, bounded only by fetch's default 300s timeouts. Fix by having consumers
re-register on reconnect, or exiting the process so the orchestrator restarts it.

## Extracted URL names can collide

`extractedFileNameForUrl` keeps the first 100 sanitized characters of a URL, so
two URLs on the same topic that share a long prefix write the same extracted
object, and removing one of them deletes the object the other still points to.
Pre-existing naming (the URL worker always did this); a hash suffix would fix it.

## `tsx` is a global, not a dependency

`pnpm build`, `pnpm dev` and the one-off scripts (`src/scripts/*.ts`, including
`repairAndBackfill.ts`) run under `tsx`, which `package.json` does not list. The
Dockerfile's build stage installs it globally (`npm i -g tsx`); locally it needs
a global install, or `npx tsx …` downloads it on demand. The runtime images ship
only `dist/`, so the scripts run from a source checkout pointed at the target
environment.

## Storage notifications go over HTTP, by necessity

Object storage is **SeaweedFS**, not MinIO. There is no direct
storage → RabbitMQ path any more, and that is not an oversight:

- SeaweedFS has no S3 bucket-notification API, so `PutBucketNotificationConfiguration`
  and MinIO's `mc event add` equivalents do not exist.
- Its filer notification sinks are Kafka, SQS, Google Pub/Sub, gocloud
  (`rabbit://…`, which does reach RabbitMQ) and webhook. Every one but the webhook
  publishes a protobuf `filer_pb.EventNotification`, which would mean adding
  protobuf decoding to the workers.

So the filer webhooks `POST /internal/storage-webhook`, and
`storageWebhookController` normalises the filer path into `{ bucket, key }` and
publishes that to `file_processing-exchange`. Both compose files wire it the same
way; the transport no longer differs between them.

Consequence worth knowing: the webhook retries a non-2xx three times with backoff
and then drops the event. In practice nothing uploads before the API is up (uploads
are triggered by an API call), but a long api-service outage mid-upload can lose an
extraction. The old MinIO AMQP notifier had an on-disk queue dir that survived a
broker outage; the webhook has no equivalent.

## Presigned uploads lose `x-amz-meta-*`

The AWS SDK presigner hoists `x-amz-meta-*` into the URL's **query string**, and
SeaweedFS only stores user metadata that arrives as request **headers**. So the
`topicid`/`userid`/`filename` metadata attached in `generatePresignedUploadUrl`
never lands on the object.

`fileProcessor.parseUploadKey` therefore derives all three from the object key,
which `generatePresignedUploadUrl` always shapes as
`{userId}/{topicId}/files/{fileName}`. **Do not "fix" the file processor by reading
`headResponse.Metadata` again** — it is empty under SeaweedFS.

Same root cause, different symptom: the SDK also hoists `x-amz-checksum-crc32` (of
the empty presign body) into the query, and SeaweedFS *does* read checksums from the
query and verify them, so every upload 403s until
`requestChecksumCalculation: "WHEN_REQUIRED"` turns it off. `src/config/s3.ts` sets it.

## `BUCKET_TYPE`, not `NODE_ENV`

`src/config/s3.ts` switches on `BUCKET_TYPE === "seaweedfs"`. Anything else,
including unset, means real AWS S3.

## `.env.example` is incomplete and partly wrong

Missing but read by the code: `AUTH_AUTHORITY` (throws at import if unset),
`LLM_PROVIDER`, `LLM_MODEL`, `LLM_API_KEY`, `LLM_BASE_URL`,
`START_FILE_CONSUMER`, `START_URL_CONSUMER`, `LOG_LEVEL`. (`BUCKET_TYPE` is now
there.)

Wrong: `GEMINI_API_KEY` is listed but nothing reads it (the AI SDK path uses
`LLM_API_KEY`); `PORT=3000` while `src/index.ts` defaults to 5000 and both the
Dockerfile `EXPOSE` and the compose healthcheck use 5000.

Fragile: `URL_EXTRACTOR=jina  # "tavily" | "jina" | ...` puts a comment on the value
line. Some dotenv parsers fold that into the value.

## Node version disagreement

Volta pins `26.4.0`. `.nvmrc` says `24.13.1`. Docker images are `node:24-alpine`
and esbuild targets `node24`. Docker is the source of truth for what actually runs.

## Multipart upload path is dead code

`src/middleware/upload.ts` configures multer for in-memory uploads, but the
`upload.array("files", 10)` call in `topicRoutes.ts` is commented out and nothing
else imports it. Uploads go presigned-direct-to-S3 now. Either the middleware goes
or it stays as a fallback — right now it is neither.

`fileConstants.ts` and `upload.ts` also disagree: multer allows 10 files per request
while `MAX_FILES_PER_UPLOAD` is 5, and multer's allowlist omits `image/gif` and
`image/webp`, which `ALLOWED_CONTENT_TYPES` permits. (The constants themselves *are*
enforced — `uploadFilesSchema` caps a request at `MAX_FILES_PER_UPLOAD` and
`uploadTopicFiles` checks `MAX_FILES_PER_TOPIC` — just not by multer.)

## File validation is asymmetric between the two upload entry points

`POST /api/topics/:id/files` validates each file against `MAX_FILE_SIZE` and
`ALLOWED_CONTENT_TYPES` (`fileInfoSchema` in `topicController.ts`).
`POST /api/topics` does not — `createTopicSchema`'s own `fileInfoSchema` in
`src/schemas/topic.schema.ts` only requires `fileName`, a positive `size`, and a
non-empty `contentType`. An oversized or disallowed file declared at topic-creation
time gets a presigned URL anyway, and is only rejected later by `file-processor`,
which marks it `failed`. Not a security hole (the worker does validate), but the
failure surfaces late and asynchronously.

## Some Zod schemas live in the controller, not in `src/schemas/`

`fileInfoSchema` and `uploadFilesSchema` are still declared inline at the top of
`topicController.ts` — including an `import` statement halfway down the
declaration block. The convention elsewhere is `src/schemas/*.schema.ts`
re-exported through `index.ts` (`markRevisedSchema` and `updateTopicSchema` have
moved there). Move them if you touch them.

## `urls` cannot be an empty array

`createTopicSchema` marks `urls` optional but sets `.min(1, "URLs list cannot be
empty")`. Omitting the field is fine; sending `[]` is a 400. Intentional, but easy to
trip over from the client.

## Duplicated URL extraction logic

`urlProcessor.ts` has `extractUrl` with a `URL_EXTRACTOR` switch across
jina/tavily/exa/firecrawl. `fileExtractor.ts` has its own `extractFromURL` that goes
straight to Jina, ignoring `URL_EXTRACTOR`. The worker path uses the former;
`extractFromURL` is only reachable via `extractContent(fileType: "url")`, and no
production caller passes `"url"` — `fileProcessor`'s `getFileType` only ever returns
`image`, `pdf`, or `text`. So it is live code on a dead branch, with tests and an
example still pointed at it. Consolidating means picking `extractUrl` and deleting
the other, not merging them.

`isTransientError` is also defined twice, separately in each worker, with slightly
different bodies — `fileProcessor`'s adds the S3 clause. Worth consolidating; be
careful, both have property tests.

## `@utils/*` alias points nowhere

Declared in `tsconfig.json` and `jest.config.cjs`; `src/utils/` does not exist.
Harmless, but do not assume the directory is there.

## `docker-compose.yml` deleted from this directory

It used to live here. Compose now lives in `../.github/` (production) and
`../.github/local/` (source builds). Referenced in stale docs and possibly in
scripts.

## Missing npm script for the url-extractor image

`package.json` has `docker:build:be` and `docker:build:fp` but nothing for
`Dockerfile.url-extractor`. Also, both existing scripts use `%npm_package_version%`
— cmd.exe syntax that will not expand under bash or PowerShell.

## `tsc_check.txt`

An empty file at the repo root, untracked. Scratch output from a type-check run.
Safe to delete.

## Resolved in the due-queue release

Kept briefly so older notes and commits make sense:

- **Quality range mismatch.** `RevisionRecord` now accepts 0 on all three quality
  fields, and `/revised` takes 0–5, so a total-blackout rating saves.
- **Same-day undo toggle.** A second `POST /:id/revised` on the same day used to
  delete the first review — including an AI-chat review the page had just
  recorded. Reviews are now one per learner-day, recorded once, never undone;
  the second attempt gets `409 ALREADY_REVIEWED_TODAY`.
- **Time zone always `Asia/Calcutta`.** The due list and statistics read
  `req.headers["X-Local-TimeZone"]?.[0]` (an always-undefined, mixed-case key).
  They now use the learner-day helper.
- **Uploaded files had no entries** (the `$push` was removed in `b014bc4`), so they
  never appeared on the topic page. Entries are created at upload-URL time and
  upserted by the worker.
- **Saving the URL list reset every URL to pending.** It now diffs the list.
- **Chat start kept going after `CONTENT_NOT_FOUND`.** It now returns.
- **Route JSDoc drift** on `POST /api/chat/complete` (`llmQuality` is not a
  request field) is fixed in `chatRoutes.ts`.
- **`mindMapGenerator.ts` relative import** — all services use aliases now.

---

## Failing test suites

Full detail in [testing.md](testing.md). As of the due-queue release: **9 of 43
suites fail, 34 pass; 502 tests pass, 16 fail.** No production code is broken by
any of these; none has been repaired (out of scope for that release).

**Compile now, but assert stale behaviour** (they started compiling once the
`req.userId` augmentation moved to `src/types/express.d.ts` and services used
aliases):
- `statisticsController.test.ts` — 11 tests create topics without the required
  `userId`, so `Topic.create` fails validation.
- `fileExtractor.test.ts` — 5 URL tests expect the old LLM formatting path;
  `extractFromURL` now returns Jina output (and is a dead branch anyway, see
  "Duplicated URL extraction logic").

`createTopicController.test.ts` and `mindMapGenerator.test.ts` compiled for the
same reasons and pass.

**Still fail to compile:**
- `RevisionRecord.test.ts`, `topicController.test.ts`, `chatController.test.ts` —
  `previousEFactor`, `previousInterval` (never defined on `IRevisionRecord`)
- `Topic.test.ts` — `fileUrl` on `IAttachedFile` (commented out in `Topic.ts` in
  favour of `s3Path` + `s3Bucket`)
- `llmClient.test.ts` — `@google/generative-ai`, replaced by the Vercel AI SDK
- `publisher.test.ts` — `QueuePublisher.create`; the API is
  `await new QueuePublisher(cfg).init()`
- `chatContext.test.ts` — Mongoose 9 typing: casts plain mock objects to
  `ITopic`; `Types.DocumentArray` no longer overlaps a bare array. Needs
  `as unknown as ITopic` or a real document factory.
