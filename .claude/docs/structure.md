# Structure & conventions

## Layout

```
backend/
├── src/
│   ├── index.ts                  api-service entry: Express app, routes, boot, shutdown
│   ├── instrumentation.ts        OTel bootstrap — loaded via --import, never imported by app code
│   ├── config/
│   │   ├── database.ts           Mongoose connect + connection event logging
│   │   ├── logger.ts             the Bunyan singleton
│   │   ├── s3.ts                 s3Client / useSeaweedFS / S3_BUCKET_NAME
│   │   ├── rabbitmq.ts           RABBITMQ_CONFIG: exchange, queue, DLQ, routing-key names + limits
│   │   ├── prompts.ts            every LLM prompt in the codebase
│   │   ├── fileConstants.ts      ALLOWED_CONTENT_TYPES, MAX_FILE_SIZE, per-upload/topic caps
│   │   └── README.md             S3/SeaweedFS setup notes
│   ├── controllers/              HTTP handlers only
│   ├── lambda/
│   │   ├── fileProcessor.ts      file-processor process (consumer + legacy Lambda handler)
│   │   └── urlProcessor.ts       url-processor process (consumer + legacy Lambda handler)
│   ├── middleware/
│   │   ├── auth.ts               authenticateToken + optionalAuth, augments Express.Request
│   │   ├── aiConfigCheck.ts      requireAIConfig → 503 AI_NOT_CONFIGURED
│   │   └── upload.ts             multer memory storage — currently unused, see known-gaps
│   ├── models/                   Topic, ChatSession, RevisionRecord
│   ├── routes/                   Express routers; JSDoc above each route is the API contract
│   ├── schemas/                  Zod schemas, barrel-exported from index.ts
│   ├── scripts/seedData.ts       dev seeding
│   ├── services/                 all business logic
│   │   └── rabbitmq/             ConnectionManager, QueuePublisher, QueueConsumer, Publishers
│   └── types/                    shared response/DTO interfaces
├── .claude/docs/                 this documentation
├── apidog/                       API request collections (.http / yaml) per feature area
├── localDataScripts/             one-off dev scripts (createTopics.ts)
├── dist/                         esbuild output — 4 bundles, gitignored
├── Dockerfile                    api-service
├── Dockerfile.file-processor     file-processor
├── Dockerfile.url-extractor      url-processor
├── esbuild.config.ts             the 4-bundle build
├── jest.config.cjs               .cjs because the package is ESM
└── tsconfig.json / .test.json
```

Compose files, Caddyfile, SeaweedFS config (`seaweedfs/s3.json`,
`seaweedfs/notification.toml`), and observability config are **not here** — they
live in the sibling `../.github/` repo.

## Path aliases

Declared in `tsconfig.json` (`baseUrl: "./src"`) and mirrored in
`jest.config.cjs`'s `moduleNameMapper`. The jest mapper handles both the
`.js`-suffixed and bare forms.

| Alias | Target |
|-------|--------|
| `@/*` | `src/*` |
| `@models/*` | `src/models/*` |
| `@services/*` | `src/services/*` |
| `@controllers/*` | `src/controllers/*` |
| `@middleware/*` | `src/middleware/*` |
| `@config/*` | `src/config/*` |
| `@routes/*` | `src/routes/*` |
| `@utils/*` | `src/utils/*` — **the directory does not exist yet** |
| `$types/*` | `src/types/*` — note the `$`, not `@` |

**Adding an alias means editing two files.** A new alias in `tsconfig.json` that is
not added to `jest.config.cjs` compiles fine and fails at test runtime.

## The `.js` extension rule

ESM + `NodeNext` means runtime imports must carry the extension, even though the
source is `.ts`:

```ts
import { Topic } from "@models/Topic.js";        // correct
import { logger } from "@config/logger.js";      // correct
import { Topic } from "@models/Topic";           // compiles, fails at runtime
```

Test files are the exception — they import without the extension (ts-jest resolves
via `moduleNameMapper`), and existing tests do exactly that.

## Layer rules

**Controllers** (`src/controllers/`) — HTTP only. Validate with a Zod schema,
call services, shape the response, map errors to status codes. Never put reusable
logic here.

The one deliberate exception: `recordRevision` lives in `topicController.ts` and is
imported by `chatController.ts`. It is shared SM-2 + persistence logic that should
arguably be a service — if you extend it, consider moving it to `src/services/`.

**Services** (`src/services/`) — all business logic, no `Request`/`Response`. Services
may read models and call other services.

**Models** (`src/models/`) — Mongoose schemas plus the `I*` document interfaces, all
exported. Model files may also export pure domain helpers that belong with the schema
(`truncateErrorReason`, `isValidStatusTransition` in `Topic.ts`).

**Schemas** (`src/schemas/`) — Zod only. Export the schema *and* its `z.infer` type.
Re-export from `index.ts`. Note that `topicController.ts` currently declares four
schemas inline instead (`markRevisedSchema`, `updateTopicSchema`, `fileInfoSchema`,
`uploadFilesSchema`) — that is drift, not the pattern to copy.

**Routes** (`src/routes/`) — wiring plus the JSDoc contract block. Route-specific
middleware is applied here (`router.use(requireAIConfig)` in `chatRoutes.ts`,
per-route on the mind-map endpoints).

## Recurring patterns

**Error responses** always use the `ErrorResponse` shape from `$types/common.types.js`:

```ts
res.status(400).json({
  error: { code: "VALIDATION_ERROR", message: validation.error.issues[0].message },
} as ErrorResponse);
```

Codes seen across controllers: `VALIDATION_ERROR`, `TOPIC_NOT_FOUND`,
`SESSION_INVALID`, `NO_MATERIALS`, `CONTENT_NOT_FOUND`, `S3_ACCESS_ERROR`,
`LLM_UNAVAILABLE`, `AI_NOT_CONFIGURED`, `MONGODB_VALIDATION_ERROR`,
`INTERNAL_SERVER_ERROR`, and the auth codes `NO_TOKEN`, `TOKEN_EXPIRED`,
`INVALID_TOKEN`, `TOKEN_VERIFICATION_FAILED`, `AUTH_ERROR`.

**User scoping** — every query filters on `userId`:

```ts
const topic = await Topic.findOne({ _id: topicId, userId: req.userId });
```

`Topic` carries compound indexes to support exactly this:
`{userId, revisionDate}`, `{userId, subjectName}`, `{userId, createdAt: -1}`.

**Module loggers** — one child logger per file, at the top:

```ts
const log = logger.child({ module: "createTopicController" });
```

**Subdocument updates** use the positional operator against the array's identifying
field, never a read-modify-write:

```ts
await Topic.updateOne(
  { _id: topicId, userId, "files.s3Path": key },
  { $set: { "files.$.processingStatus": "completed" } },
);
```

For several URLs at once, `updateMany` with `arrayFilters` (see `handleUrlMessage`).

**Pure functions pulled out for testing.** Several modules export a small pure helper
purely so it can be property-tested in isolation: `computeBackoffDelay`,
`isTransientError`, `shouldSkipExtractedKey`, `filterPublishableUrls`,
`isValidStatusTransition`, `truncateErrorReason`. Follow that pattern when you add
logic worth testing exhaustively.

## File naming

| Kind | Convention | Example |
|------|-----------|---------|
| Models | PascalCase | `Topic.ts` |
| Everything else | camelCase | `createTopicController.ts` |
| Unit tests | alongside the source | `sm2Algorithm.test.ts` |
| Property tests | `__properties__/` subdir | `rabbitmq/__properties__/backoff.property.test.ts` |
| Usage examples | `*.example.ts` | `llmClient.example.ts` — excluded from the build |
