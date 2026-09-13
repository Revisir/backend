# Testing

```bash
pnpm test              # jest
pnpm test:watch
pnpm test:coverage
npx jest path/to/file.test.ts       # single suite
npx jest -t "test name substring"   # single test
```

## Current state — read this before you trust a red run

As of the last full run: **11 of 26 suites fail to run, 15 pass; 153 tests pass,
0 fail.**

None of that is production-code breakage. All 11 red suites never reach their
assertions — they fail at compile or module-resolution time because the tests were
written against earlier versions of the schemas, the LLM client, and the publisher
API. A red suite here does not mean your change broke something. Diff the failure
against the list in [known-gaps.md](known-gaps.md#failing-test-suites) first.

The 15 suites that do pass — including the SM-2 unit tests, `s3Storage`, and all six
RabbitMQ property suites — are the real regression net. **Keep those green, and
keep the test count at 153 or above.**

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

Two consequences of that setup that bite regularly:

1. **A new path alias must be added to `jest.config.cjs` as well as `tsconfig.json`.**
2. **Relative `.js` imports in source files break the importing test suite.** The
   mapper only covers aliases, so `import { … } from "../config/s3.js"` is
   unresolvable under jest and takes the importing suite down with it — including
   via a barrel, so `src/schemas/index.ts` and `src/services/rabbitmq/index.ts` both
   re-export through aliases for this reason. Always use the alias form in source.
   `mindMapGenerator.ts` (`./s3Storage.js`) is the one remaining offender.

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

Note: `jest.config.cjs` does **not** set the `@shelf/jest-mongodb` preset — the
ts-jest preset is used instead — so suites needing a live Mongo wire it up
themselves. Follow whatever the nearest existing model test does.

## Writing a new test

- Put it beside the code. Use aliases, without the `.js` extension — that is what
  existing tests do and what the mapper expects.
- For logic with an input space worth sweeping, add a `__properties__` file with the
  feature/property header rather than a handful of examples.
- Do not import `src/index.ts` — it connects to MongoDB and RabbitMQ at module load.
- `pnpm build` does not type-check tests (`tsconfig.json` excludes them). A test can
  be type-broken while the build is green. Run `pnpm test` too.
