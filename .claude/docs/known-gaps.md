# Known gaps & drift

Things that look like bugs and are, or look like bugs and aren't. Check here before
"fixing" something — several of these are deliberate mid-migration states, and a
couple are real.

The working tree is mid-migration from **direct/Lambda processing to RabbitMQ
queues**. Most of what follows is fallout from that.

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

`markRevisedSchema`, `updateTopicSchema`, `fileInfoSchema`, and `uploadFilesSchema`
are declared inline at the top of `topicController.ts` — including an `import`
statement halfway down the declaration block. The convention elsewhere is
`src/schemas/*.schema.ts` re-exported through `index.ts`. Move them there if you
touch them.

`updateTopicSchema` also accepts `urls`, which the route's JSDoc does not mention,
and `updateTopic` gives no indication that newly added URLs are queued for extraction.

## Route JSDoc drift

`chatRoutes.ts` documents `POST /api/chat/complete` as taking `llmQuality` in the
body. It does not — `completeChatSessionSchema` accepts only
`{ sessionId, topicId, userQuality }`, and the controller computes `llmQuality`
itself from the transcript. The schema is authoritative.

## Quality range mismatch

`completeChatSessionSchema` accepts `userQuality` 0–5, but `RevisionRecord` requires
`min: 1` on `userQuality`, `llmQuality`, and `finalQuality`. A self-rating of 0 —
which SM-2 treats as a legitimate total blackout — passes request validation and then
fails Mongoose validation inside `recordRevision`, surfacing as a 500. The topic
route's `markRevisedSchema` uses 1–5 and is consistent with the model.

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

---

## Failing test suites

Full detail in [testing.md](testing.md). Causes, grouped:

**Relative `.js` imports jest cannot resolve** — the source file uses a relative
`.js` import instead of an alias, so the test importing it dies:
- `s3Storage.test.ts` ← `s3Storage.ts` imports `../config/s3.js`
- `fileExtractor.test.ts` ← `fileExtractor.ts` imports `./llmClient.js`
- `mindMapGenerator.test.ts` ← `mindMapGenerator.ts` imports `./s3Storage.js`

Switching those source imports to aliases (`@config/s3.js`, `@services/llmClient.js`)
fixes all three.

**`req.userId` not on `Express.Request`** — `createTopicController.test.ts`,
`statisticsController.test.ts`. The `declare global` augmentation lives in
`src/middleware/auth.ts`, which `tsconfig.test.json` only includes when something
transitively imports it. Moving the augmentation to a standalone
`src/types/express.d.ts` would fix it globally.

**Tests reference fields the schemas no longer have**:
- `RevisionRecord.test.ts`, `topicController.test.ts`, `chatController.test.ts` —
  `previousEFactor`, `previousInterval` (never defined on `IRevisionRecord`)
- `Topic.test.ts` — `fileUrl` on `IAttachedFile` (commented out in `Topic.ts` in
  favour of `s3Path` + `s3Bucket`)

**Tests reference APIs that no longer exist**:
- `llmClient.test.ts` — `@google/generative-ai`, replaced by the Vercel AI SDK
- `publisher.test.ts` — `QueuePublisher.create`; the API is
  `await new QueuePublisher(cfg).init()`

**Mongoose 9 typing** — `chatContext.test.ts` casts plain mock objects to `ITopic`;
`Types.DocumentArray` no longer overlaps a bare array. Needs `as unknown as ITopic`
or a real document factory.

**No assertion failures.** As of the SeaweedFS migration the suites that *do* run
are all green (153 tests). `fileProcessingMessageSchema` is now the flat
`{ bucket, key }` the property tests always generated, which is also what
`storageWebhookController` publishes.
