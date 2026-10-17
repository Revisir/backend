# Architecture

## Three processes, one codebase

The same source tree builds three separately-deployed processes. `esbuild.config.ts`
emits four bundles into `dist/`:

| Bundle | Process | Entry | Started by |
|--------|---------|-------|-----------|
| `index.js` | **api-service** — Express HTTP API | `src/index.ts` | `Dockerfile` |
| `fileProcessor.js` | **file-processor** — file extraction worker, plus the question-bank consumer and sweep | `src/lambda/fileProcessor.ts` (bank: `src/lambda/questionBankProcessor.ts`) | `Dockerfile.file-processor`, `START_FILE_CONSUMER=true` |
| `urlProcessor.js` | **url-processor** — URL extraction worker | `src/lambda/urlProcessor.ts` | `Dockerfile.url-extractor`, `START_URL_CONSUMER=true` |
| `instrumentation.js` | OTel bootstrap, `--import`ed by the API | `src/instrumentation.ts` | — |

The file-processor also builds question banks (see "Question banks" below):
`startFileConsumer` starts a second consumer on the `question_bank` queue and the
periodic sweep, so no new deployable or env var is needed.

Both workers are dual-mode. Each file exports an AWS Lambda `handler` **and** a
`start*Consumer()` RabbitMQ consumer, and self-starts the consumer at module load
when its `START_*_CONSUMER` env var is `"true"`. The Lambda handlers are kept for
backward compatibility with the pre-queue AWS deployment; the containerised
consumers are the live path.

## Message flow

```
                        ┌───────────────────────────────┐
  POST /api/topics ───► │  api-service                  │
                        │  • save Topic (urls pending)  │
                        │  • publish url msg            │
                        │  • return presigned PUT URLs  │
                        └───────┬──────────────┬────────┘
                                │              │
                     url_processing        client PUTs files direct
                      -exchange            to S3/SeaweedFS at
                                │          {userId}/{topicId}/files/
                                │              │
                                │              ▼
                                │        SeaweedFS filer notification
                                │        (webhook → api-service
                                │         /internal/storage-webhook
                                │         → file_processing-exchange)
                                ▼              ▼
                        ┌───────────────┐  ┌───────────────────┐
                        │ url-processor │  │ file-processor    │
                        │ jina/tavily/  │  │ HEAD for type/size│
                        │ exa/firecrawl │  │ LLM extraction    │
                        └───────┬───────┘  └────────┬──────────┘
                                │                   │
                                ▼                   ▼
                     write markdown to S3: {userId}/{topicId}/extracted/
                     update the url/file subdoc: status + extracted path
                                │
                every attachment settled? ──► question_bank-exchange
                                                     │
                                                     ▼
                                       file-processor: bank consumer
                                       extract → review → format (LLM)
                                       save topic.questionBank
```

The API creates a `pending` file entry for each declared file when it issues
upload URLs (`src/services/topicMaterials.ts`), and the file worker upserts the
entry from the object's HEAD if it is missing, so an upload always has exactly
one entry with a truthful status. Every status write also stamps
`statusUpdatedAt`, which drives the staleness window.

`file-processor` derives `userId`, `topicId`, and `fileName` from the **object key**
(`parseUploadKey`), which `generatePresignedUploadUrl` always shapes as
`{userId}/{topicId}/files/{fileName}`. It deliberately does *not* read the object's
`x-amz-meta-*` metadata: the AWS SDK presigner hoists those headers into the URL's
query string, and SeaweedFS only stores user metadata that arrives as request
headers — so on a presigned browser upload that metadata never lands. It validates
content type against `ALLOWED_CONTENT_TYPES` and size against `MAX_FILE_SIZE` before
doing any LLM work.

Keys containing `/extracted/` are acked without processing — that is the loop-breaker,
since writing extracted markdown back to the same bucket fires another notification.
Both `shouldSkipExtractedKey` (fileProcessor) and the defensive check in
`handleUrlMessage` exist for this.

## Queue topology

Declared in `src/config/rabbitmq.ts`, asserted by `QueuePublisher.init()`:

| | URL path | File path | Question bank |
|---|---|---|---|
| Exchange (direct, durable) | `url_processing-exchange` | `file_processing-exchange` | `question_bank-exchange` |
| Routing key | `url_processing` | `file_processing` | `question_bank` |
| Queue (quorum, durable) | `url_processing` | `file_processing` | `question_bank` |
| DLQ (quorum, durable) | `url_processing.dlq` | `file_processing.dlq` | `question_bank.dlq` |
| Message | `{ topicId, userId, urls }` | `{ bucket, key }` | `{ topicId, userId, requestedAt, reason }` |
| Consumer | url-processor | file-processor | file-processor |

All DLQs bind to a shared direct exchange `dlx`, keyed by DLQ name.

**Retries are the broker's job, not ours.** Main queues are declared with
`x-delivery-limit: 3` (`MAX_RETRY_COUNT`), so a quorum queue counts deliveries
natively and dead-letters on its own. Application code never tracks a retry header.

## The three RabbitMQ classes

`src/services/rabbitmq/` — all three are transport-only. No business logic.

**`ConnectionManager`** — owns one connection and one channel. Validates the AMQP URL
scheme up front, connects with exponential backoff (`computeBackoffDelay`, exported
separately so it can be property-tested), auto-reconnects on `error`/`close` unless
shutting down, and does an ordered graceful shutdown (cancel consumers → close
channel → close connection) behind a 10s timeout. Emits the
`rabbitmq.connection.reconnects` counter.

**`QueuePublisher`** — one instance per queue. The shared `ConnectionManager` is
injected once via the static `setConnectionManager()`; the constructor throws if
that has not happened. `init()` asserts the DLX, the DLQ, the main queue (with
dead-letter args and delivery limit), the exchange, and the binding — then returns
`this` so you can write `await new QueuePublisher(cfg).init()`. Publishes are
`persistent`. Emits `rabbitmq.messages.published`.

**`QueueConsumer`** — sets prefetch to 1, parses JSON, optionally validates against
a Zod schema, then dispatches to a `MessageHandler` that returns one of three
outcomes:

| Outcome | Effect |
|---------|--------|
| `ack` | Done. |
| `nack_requeue` | Requeue — broker increments delivery count, dead-letters past the limit. **Use for transient errors.** |
| `nack_reject` | Reject without requeue — straight to the DLQ. **Use for permanent errors.** |

Unparseable JSON and schema-validation failures are `nack_reject`ed (a malformed
message will never become valid). A handler that *throws* is treated as
`nack_requeue`. Emits `rabbitmq.messages.consumed` tagged with the outcome.

**Error classification** is what decides requeue vs. reject. Both workers define
their own `isTransientError(err)` — message-substring matching on `timeout`,
`econnrefused`, `econnreset`, `network`, `etimedout`, `ehostunreach`, and mongo
connection errors. `fileProcessor` additionally treats S3 errors as transient
*except* `nosuchbucket`. On a permanent error the worker best-effort writes
`processingStatus: "failed"` and a truncated `errorReason` onto the subdocument
before rejecting.

## The `Publishers` registry

The API does not thread publishers through function arguments. `src/index.ts` calls
`initRabbitMQ()` at boot, which populates a static registry:

```ts
import { Publishers } from "@services/rabbitmq/index.js";
await Publishers.url.publish({ message: { topicId, userId, urls } });
```

`Publishers.questionBank` is set in the API by `initRabbitMQ()` and in each
worker by its consumer startup (both workers publish bank requests when a
topic's attachments settle). Publish failures return `false` rather than
throwing — check the boolean.

Controllers **must** guard on it (`if (Publishers.url)`) and treat a publish failure
as non-fatal — `createTopicController` logs and still returns 201, so a broker
outage does not lose the topic. The URL publish is deliberately fire-and-forget.

## Question banks

The normal quiz draws from a per-topic bank of checked questions
(`topic.questionBank`, with `questions` `select: false` so answer keys never
reach a topic response). `src/services/questionBank.ts` builds it:

1. Read each **completed** attachment's recorded extracted path (never the whole
   folder; orphaned objects are ignored), capped at `MATERIAL_CHAR_CAP`.
2. Extract question-answer pairs with the AI chat's extractor (25 instead of
   the chat's 10), keep those the chat's reviewer finds answered in the material.
3. Format them into four-option multiple-choice or one-blank fill-in-the-blank
   items (`PROMPTS.questionBank.formatter`), passing the retired questions as
   exclusions; validate structure in code; drop retired and duplicate keys.
4. Save conditionally on the build claim: `ready` replaces the questions;
   `empty` and `failed` keep the previous questions (they stay usable).

Each LLM step retries with backoff (`LLM_ATTEMPTS`). Tunables live in
`src/config/questionBank.ts`.

**Triggers** (`src/services/questionBankJobs.ts`) record `requestedAt` and
publish one message:

| Trigger | When |
|---|---|
| `materials_settled` | a worker settles an attachment and every attachment of the topic is now completed, failed or stale, with material completed since the last build |
| `material_removed` | a URL save or file delete removes completed material (no completed material left → the bank is cleared to `none` instead) |
| `regenerate` | `POST /api/topics/:id/questions/regenerate` |
| `backfill` | the launch repair script |
| `sweep` / `follow_up` | see below |

**Claim protocol** (`handleBankRequest` in `src/lambda/questionBankProcessor.ts`):

- `sourcedAt` is the claim time of the last successful (ready or empty) build.
  A message whose `requestedAt` is older is already covered and is acked.
- While a fresh build is running, a new message only raises `requestedAt` and
  acks; when that build finishes it publishes exactly one `follow_up` if
  `requestedAt` is later than its own claim.
- Otherwise the consumer claims the topic as `building`. A redelivered message
  whose `requestedAt` matches the claim (`claimRequestedAt`) takes the claim
  over, and a claim older than `STALE_CLAIM_MS` may be taken by anyone.
- The build saves only while it still holds the claim, so a superseded build
  writes nothing. Database errors requeue; malformed messages are rejected to
  the DLQ by the schema.

**Sweep** (every `SWEEP_INTERVAL_MS`, in the file-processor):

- attachments pending or processing past `ATTACHMENT_STALE_MS` are written
  `failed` with `errorReason: "Processing timed out"`, then the settle check
  runs for the topic;
- banks left `queued` or `building` past `STALE_CLAIM_MS` (a lost publish, a dead
  worker) are republished, up to `SWEEP_MAX_ATTEMPTS`, then marked `failed`
  with `errorCode: "BUILD_STALLED"`.

Bank states: `none → queued → building → ready | empty | failed`, back to
`queued` on any trigger, and to `none` when the last material is removed.

**Retirement.** Flagging a quiz question appends `{ key, text, retiredAt }` to
the append-only `topic.retiredQuestions` (key = `normalizeText(prompt)`) and
pulls it from the bank. Builds exclude retired keys and re-check the list just
before saving, so a flag that lands mid-build still sticks.

## Review writes

Done (`POST /:id/revised`), AI chat completion and normal quiz completion all
call `recordRevision` (`src/services/reviewRecorder.ts`):

1. Read the topic's SM-2 state; refuse if `lastRevised` falls in the learner's
   current day (`src/services/learnerDay.ts`).
2. One conditional `findOneAndUpdate` (`lastRevised` null or before today's
   start) applies SM-2, `lastQuality` and `lastReviewSessionId`.
3. Write the `RevisionRecord` with `method` (`self` / `ai_quiz` /
   `normal_quiz`), quiz counts and `sessionId`. If that write fails, restore the
   topic's previous values.

MongoDB runs standalone in deployment (no replica set), so this is a
conditional update plus compensation rather than a transaction. A losing
completion of the same session waits briefly for the winner's record and
returns it; anything else gets `ALREADY_REVIEWED_TODAY`.

## Storage layout

One S3/SeaweedFS bucket (`S3_BUCKET_NAME`, default `revision-study-content`):

```
{userId}/{topicId}/files/{fileName}                 uploaded originals
{userId}/{topicId}/extracted/{fileName}.md          extracted file content
{userId}/{topicId}/extracted/url_{sanitized}.md     extracted URL content
```

`src/config/s3.ts` picks the client from `BUCKET_TYPE`: `seaweedfs` gives an
`S3Client` pointed at `S3_ENDPOINT:S3_PORT` with `forcePathStyle: true`, anything
else gives real AWS S3. The SeaweedFS branch also sets
`requestChecksumCalculation: "WHEN_REQUIRED"` — without it the SDK hoists a CRC32 of
the *empty* presign body into the presigned query, and SeaweedFS reads checksums out
of the query and fails the upload against it.

Uploads never pass through the API. `generatePresignedUploadUrl` mints a presigned
PUT (default 1h); the file worker recovers `userId`/`topicId`/`fileName` from the key
rather than from object metadata (see "Message flow" above for why).
`src/services/s3Storage.ts` wraps operations in exponential-backoff retries and
throws typed `S3StorageError`s with `S3ErrorCode` values. `toPublicUrl()` rewrites
the internal SeaweedFS origin to `S3_PUBLIC_URL` so browsers can follow the link —
whatever serves that URL must send the internal `Host` upstream (Caddy does), since
the SigV4 signature covers it.

## Storage notifications

The SeaweedFS filer reads `../.github/seaweedfs/notification.toml` and POSTs one
JSON event per write to `POST /internal/storage-webhook`:

```json
{ "key": "/buckets/{bucket}/{objectKey}", "event_type": "create", "message": { "new_entry": { ... } } }
```

`storageWebhookController` splits that filer path into `{ bucket, key }` and
publishes it to `file_processing-exchange`. It drops non-create/update events,
directory entries, paths outside a bucket, and anything under `/extracted/`,
answering 204 — SeaweedFS retries non-2xx with backoff, and a filtered event is a
successful no-op.

This webhook hop exists because SeaweedFS has no S3 bucket-notification API: its
only queue sinks are Kafka, SQS, Pub/Sub and gocloud (`rabbit://`), and all of them
carry a protobuf `EventNotification` rather than an S3 event. The webhook sink is
the one that speaks JSON.

## LLM access

`src/services/llmClient.ts` is a singleton over the Vercel AI SDK. `LLM_PROVIDER`
selects `openai` | `google` (default) | `anthropic` | `local`; `local` is
OpenAI-compatible and requires `LLM_BASE_URL` (e.g. Ollama). Two methods:
`sendTextPrompt(prompt, system?)` and `sendMultimodalPrompt({ text, images, mimeTypes })`
— the latter routes PDFs as `file` parts and everything else as `image` parts.

`getLLMClient()` lazily constructs; `resetLLMClient()` clears the singleton and
exists for tests. `requireAIConfig` middleware pre-empts a missing key with a
`503 AI_NOT_CONFIGURED` on the chat, mind-map and Regenerate routes so the
frontend can degrade gracefully. Its condition is exported as `isAIConfigured()`,
which review availability uses for the `ai_not_configured` reason. The normal
quiz needs no LLM once a bank exists.

## Observability

OpenTelemetry, wired in `src/instrumentation.ts` and loaded via `--import` *before*
app code so auto-instrumentation can patch modules. Traces, metrics (15s interval),
and logs all go OTLP/HTTP-proto to `OTEL_EXPORTER_OTLP_ENDPOINT`. Auto-instrumentations
cover Express, HTTP, and MongoDB (`fs` and `dns` are explicitly disabled as noise);
Bunyan and amqplib instrumentation are added by hand. `OTEL_DEBUG=true` turns on
OTel's own diagnostic logging.

The collector fans out to Loki (logs), Tempo (traces), and Prometheus (metrics),
with Grafana on top — all under the `observability` compose profile in `../.github/`.

Because `BunyanInstrumentation` bridges log records into the OTel pipeline,
**anything written with `console.*` never reaches Loki.** That is the real reason
for the logger rule in `CLAUDE.md`.
