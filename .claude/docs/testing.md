# Testing

```bash
pnpm test              # jest
pnpm test:watch
pnpm test:coverage
npx jest path/to/file.test.ts       # single suite
npx jest -t "test name substring"   # single test
```

## Current state — read this before you trust a red run

As of the due-queue release: **9 of 43 suites fail, 34 pass; 502 tests pass,
16 fail.**

None of that is production-code breakage. Seven red suites never reach their
assertions — they fail at compile time because they were written against
earlier versions of the schemas, the LLM client and the publisher API. Two
(`statisticsController`, `fileExtractor`) compile but assert stale behaviour
(16 tests). A red suite here does not mean your change broke something. Diff the
failure against the list in [known-gaps.md](known-gaps.md#failing-test-suites)
first.

The 34 passing suites are the regression net: the 15 that passed before the
due-queue release (SM-2, `s3Storage`, the RabbitMQ property suites, …) plus the
release's own suites for learner days, review writes, attachments, the question
bank and its queue, the normal quiz, review availability and the launch repair.
**Keep them green, and keep the passing count at 502 or above.**

## Setup

`jest.config.cjs` (`.cjs` because the package is ESM):

- preset `ts-jest`, `testEnvironment: node`
- roots: `<rootDir>/src` — tests live next to the code they test
- matches `**/__tests__/**/*.ts` and `**/?(*.)+(spec|test).ts`
- ts-jest compiles against **`tsconfig.test.json`**, which extends the base config
  but relaxes `noUnusedLocals`/`noUnusedParameters` and includes only
  `src/**/*.test.ts` / `*.spec.ts`
- `moduleNameMapper` re-declares every path alias, in both bare and `.js`-suffixed
  form

- `setupFiles` runs `src/test/setupEnv.cjs`, which sets `LOG_LEVEL=fatal` unless a
  level is already set — Bunyan writes straight to stdout, so otherwise every
  log line lands in the run
- `tsconfig.test.json` also includes `src/types/**/*.d.ts` (the `req.userId`
  augmentation) and `src/test/**/*.ts` (helpers); the build excludes `src/test/`

Two consequences of that setup that bite regularly:

1. **A new path alias must be added to `jest.config.cjs` as well as `tsconfig.json`.**
2. **Relative `.js` imports in source files break the importing test suite.** The
   mapper only covers aliases, so `import { … } from "../config/s3.js"` is
   unresolvable under jest and takes the importing suite down with it — including
   via a barrel, so `src/schemas/index.ts` and `src/services/rabbitmq/index.ts` both
   re-export through aliases for this reason. Always use the alias form in source.
   (The only relative imports left are the rabbitmq classes' type-only imports,
   which erase at compile time, and `src/scripts/seedData.ts`, which no test loads.)

## Test kinds

**Unit tests** — `<module>.test.ts` beside the source. Straightforward
input/output; `sm2Algorithm.test.ts` is the cleanest example.

**Property-based tests** — `__properties__/<concern>.property.test.ts`, using
`fast-check`. These are the primary safety net for the queue layer. Each file has a
header comment naming the feature and the numbered property it validates:

```ts
/**
 * Feature: rabbitmq-message-queues, Property 9: Message serialization round trip
 * Validates: Requirements 7.1, 7.2
 */
```

Keep that convention — it links the test back to the spec it came from.

Existing property suites:

| File | Property |
|------|----------|
| `services/rabbitmq/__properties__/backoff.property.test.ts` | exponential backoff is monotonic and capped |
| `.../errorClassification.property.test.ts` | transient vs. permanent classification |
| `.../retryThreshold.property.test.ts` | delivery-limit behaviour |
| `.../serialization.property.test.ts` | message JSON round-trip — **currently failing, stale arbitrary** |
| `.../urlFiltering.property.test.ts` | only `http(s)` URLs are publishable |
| `.../validation.property.test.ts` | queue schema validation |
| `controllers/__properties__/webhookFiltering.property.test.ts` | webhook preserves bucket/key — **cannot compile, module missing** |
| `lambda/__properties__/extractedKeyFiltering.property.test.ts` | `/extracted/` keys are skipped |
| `models/__properties__/processingStatus.property.test.ts` | only legal status transitions |
| `services/__properties__/questionText.property.test.ts` | question-text normalization is idempotent and ignores case, spacing, trailing punctuation |
| `services/__properties__/quizScoring.property.test.ts` | quiz rating never falls as the share correct rises; band edges at 100/80/60/40/20% |

This is why so much logic is pulled out as small pure exports — `computeBackoffDelay`,
`isTransientError`, `shouldSkipExtractedKey`, `filterPublishableUrls`,
`isValidStatusTransition`, `truncateErrorReason`. If you add logic that deserves
exhaustive testing, export it the same way instead of burying it in a class method.

**`*.example.ts`** files are not tests. They are runnable usage samples
(`llmClient.example.ts`, `chatContext.example.ts`, `fileExtractor.example.ts`),
excluded from both the build and the test program.

## Available doubles

`@shelf/jest-mongodb` and `mongodb-memory-server` are installed for real in-memory
MongoDB in model and controller tests. `aws-sdk-client-mock` mocks the S3 client.
`supertest` is available for HTTP-level tests. `resetLLMClient()` exists specifically
so a test can swap the LLM singleton.

Note: `jest.config.cjs` does **not** set the `@shelf/jest-mongodb` preset. Use the
shared helper in `src/test/mongo.ts` instead (import it relatively,
`../test/mongo`):

- `useMongoMemoryServer()` — call at the top level of a suite: one in-memory
  mongod per suite, every collection wiped after each test, generous hook
  timeouts (mongod can take well over 5s to start when suites run in parallel).
- `buildTestApp({ "/api/topics": topicRoutes })` — an Express app with the
  routers mounted and a stand-in for auth: `req.userId` comes from the
  `x-test-user` header, defaulting to `"user-1"`.
- `freezeDate(date)` — fakes only `Date` (timers stay real, so Mongo and HTTP
  keep working); pair with `jest.useRealTimers()` in `afterEach`.

Time-dependent services take an explicit `now` (or a `LearnerDay`) so most
tests never need `freezeDate`. Mock the LLM with `jest.mock("@services/llmClient",
…)` and script `sendTextPrompt`; mock workers' S3 with `mockClient(S3Client)`.

## Writing a new test

- Put it beside the code. Use aliases, without the `.js` extension — that is what
  existing tests do and what the mapper expects.
- For logic with an input space worth sweeping, add a `__properties__` file with the
  feature/property header rather than a handful of examples.
- Do not import `src/index.ts` — it connects to MongoDB and RabbitMQ at module load.
- `pnpm build` does not type-check tests (`tsconfig.json` excludes them). A test can
  be type-broken while the build is green. Run `pnpm test` too.
