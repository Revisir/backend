# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

`reviser_node_service` — the backend for **Reviser**, a spaced-repetition study tool.
Users add topics they've studied, attach source material (files and URLs), and the
system extracts that material with LLMs, quizzes them in an AI chat session, and
reschedules each topic using the **SM-2** algorithm based on how well they recalled it.

This directory is the backend only. The frontend (`reviser-web/`) and the deployment
config (`.github/`) live as siblings under `E:\Reviser\js\`.

## Reference docs

Read the doc that matches what you're doing — don't re-derive it from the source.

| Doc | Read it when |
|-----|--------------|
| [.claude/docs/product.md](.claude/docs/product.md) | You need the feature set, user flows, or domain vocabulary |
| [.claude/docs/architecture.md](.claude/docs/architecture.md) | You're touching queues, workers, file/URL processing, or the request→storage path |
| [.claude/docs/tech.md](.claude/docs/tech.md) | You need the stack, commands, env vars, or build/Docker layout |
| [.claude/docs/structure.md](.claude/docs/structure.md) | You're adding files, importing across layers, or need the path aliases |
| [.claude/docs/api.md](.claude/docs/api.md) | You're changing or calling an HTTP endpoint |
| [.claude/docs/testing.md](.claude/docs/testing.md) | You're writing or running tests |
| [.claude/docs/known-gaps.md](.claude/docs/known-gaps.md) | Something looks broken or inconsistent — check here before "fixing" it |

## Non-negotiables

- **ESM only.** `"type": "module"`. Every relative/aliased import needs a `.js`
  extension even though the source is `.ts` (`@models/Topic.js`).
- **Scope every query by `userId`.** It comes off the verified JWT as `req.userId`.
  A `Topic`/`ChatSession`/`RevisionRecord` query without it is a data leak.
- **Controllers do HTTP, services do logic.** Parse/validate/respond in the
  controller; put anything reusable in `src/services/`.
- **Validate with Zod at the controller boundary.** Schemas live in `src/schemas/`
  and are re-exported from `src/schemas/index.js`. Use `safeParse` and return
  `{ error: { code, message } }` on failure.
- **LLM prompts belong in `src/config/prompts.ts`.** Never inline a prompt string
  in a service or controller.
- **Log through Bunyan, never `console.*`.** `import { logger } from "@config/logger.js"`
  then `const log = logger.child({ module: "<name>" })`. Bunyan records are bridged
  to OpenTelemetry; `console.log` is not. (`src/instrumentation.ts` is the one
  deliberate exception — it runs before the logger exists.)
- **Errors go in the `err` field:** `log.error({ err }, "message")` — that's what
  `bunyan.stdSerializers` expects.

## Before you finish

```bash
pnpm build    # tsc --noEmit + esbuild bundle — the type-check is the gate
pnpm test     # jest
```

`tsconfig.json` runs `strict` plus `noUnusedLocals`, `noUnusedParameters`,
`noImplicitReturns`, and `noFallthroughCasesInSwitch`. Unused imports break the build.
