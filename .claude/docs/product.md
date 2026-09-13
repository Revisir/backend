# Product

Reviser is a **spaced-repetition study tool**. A student records what they studied,
attaches the source material, and the system decides when they should revise it —
then quizzes them and re-schedules based on how they did.

## Core features

**Topic management**
Topics carry a name, a subject (free-text, used for grouping and filtering), a
description, and the date studied. Each topic owns two arrays of attachments:
`files` (uploaded to S3/SeaweedFS) and `urls` (web pages). Both are extracted
asynchronously and track their own `processingStatus`.

**Spaced-repetition scheduling (SM-2)**
`src/services/sm2Algorithm.ts` implements SuperMemo 2. Each topic holds three
scheduling fields — `eFactor` (easiness, clamped 1.3–2.5), `repetitionNumber`,
and `interval` (days). On each revision:

- `EF' = EF + (0.1 - (5-q) * (0.08 + (5-q) * 0.02))`, clamped to [1.3, 2.5]
- Interval: `I(1) = 1`, `I(2) = 6`, `I(n) = round(I(n-1) * EF)`
- `quality < 3` resets `repetitionNumber` to 0 and `interval` to 1

A topic is **due** when `revisionDate <= now` (the `isDue` virtual on the model).

**AI content extraction**
Uploaded PDFs, images, and text files are turned into markdown by an LLM
(`src/services/fileExtractor.ts`). URLs go through a pluggable reader —
Jina Reader (default), Tavily, Exa, or Firecrawl — selected by `URL_EXTRACTOR`.
All extracted markdown is written back to S3/SeaweedFS under
`{userId}/{topicId}/extracted/`.

**AI chat revision**
A three-agent pipeline in `src/services/questionAgent.ts`:

1. *extract* — pull question/answer pairs out of the study material
2. *review* — discard questions whose answers aren't actually in the material
3. *evaluate* — score the student's answer against the expected one

The reviewed question set is stored on the `ChatSession` up front, so the session
walks a fixed list rather than improvising per turn. At session end,
`assessStudentPerformance` (in `chatContext.ts`) reads the whole transcript and
returns an `llmQuality` score 0–5.

**Mind map generation**
`src/services/mindMapGenerator.ts` asks the LLM for a
[MindElixir](https://github.com/SSShooter/mind-elixir-core) `nodeData` tree built
from the topic's extracted material, validates it as JSON, and caches it on the
topic (`mindMap`, `mindMapGeneratedAt`).

**Statistics & forgetting curve**
`GET /api/statistics` returns totals, due-today, revised-this-week/month, and
upcoming revision counts. `GET /api/topics/:id/forgetting-curve` returns retention
curve points plus markers for each past revision, derived from the topic's SM-2 state.

## The revision loop

```
create topic ──► attach files / URLs ──► async extraction ──► material in S3
                                                                    │
        ┌───────────────────────────────────────────────────────────┘
        ▼
  topic becomes due (revisionDate <= now)
        │
        ▼
  POST /api/chat/start        extract + review questions, ask the first
        │
        ▼
  POST /api/chat/message  ◄──┐ evaluate answer, give feedback, ask the next
        │                    │
        └────────────────────┘
        ▼
  POST /api/chat/complete     LLM scores the transcript (llmQuality)
        │                     finalQuality = (userQuality + llmQuality) / 2
        ▼
  SM-2 recalculates ──► new revisionDate + a RevisionRecord row
```

`userQuality` is the student's own self-rating, sent in the request.
`llmQuality` is computed server-side from the transcript — it is **not** a
client input. When no `llmQuality` is available, `finalQuality` falls back to
`userQuality` alone.

A student can also skip the chat entirely and self-report via
`POST /api/topics/:id/revised`, or wipe a topic's progress with
`POST /api/topics/:id/reset`.

## Authentication

AWS Cognito over OIDC. `src/middleware/auth.ts` verifies the bearer JWT against
the JWKS at `${AUTH_AUTHORITY}/.well-known/jwks.json` using `jose`, then sets
`req.userId` (the `sub` claim) and `req.userEmail`. **An `email` claim is
required** — a token without one is rejected.

`optionalAuth` is what's actually mounted on `/api`. It bypasses verification and
injects `TEST_USER_ID` only when `NODE_ENV=development` **and** `SKIP_AUTH=true`;
otherwise it delegates to the real verifier.

## Domain vocabulary

| Term | Meaning |
|------|---------|
| **eFactor** | Easiness factor, 1.3–2.5. Higher = the student finds it easy = longer intervals. |
| **interval** | Days until the next revision. |
| **repetitionNumber** | Consecutive successful revisions. Reset to 0 by a `quality < 3`. |
| **quality** | Recall score 0–5. `userQuality` is self-reported, `llmQuality` is LLM-assessed, `finalQuality` is their mean. |
| **due** | `revisionDate <= now`. |
| **processingStatus** | Per-attachment extraction state: `pending → processing → completed \| failed`. |
| **extracted content** | LLM-produced markdown in S3 at `{userId}/{topicId}/extracted/`. The only thing the chat and mind map agents ever read. |
