# Tech stack & commands

## Stack

| Concern | Choice |
|---------|--------|
| Runtime | Node.js — Volta pins `26.4.0`, `.nvmrc` says `24.13.1`, Docker images are `node:24-alpine`, esbuild targets `node24` |
| Language | TypeScript 5.9, ESM (`"type": "module"`), `module`/`moduleResolution`: `NodeNext` |
| Framework | Express 5 |
| Database | MongoDB via Mongoose 9 |
| Object storage | AWS S3 SDK v3 against either AWS S3 or the SeaweedFS S3 gateway |
| Message broker | RabbitMQ via `amqplib` 2, quorum queues |
| LLM | Vercel AI SDK (`ai` 6) with `@ai-sdk/google`, `@ai-sdk/openai`, `@ai-sdk/anthropic` |
| URL extraction | Jina Reader (HTTP, no SDK), Tavily, Exa, Firecrawl |
| Auth | `jose` — remote JWKS verification against Cognito |
| Validation | Zod 4 |
| Dates | Luxon (`recordRevision` uses UTC) |
| Logging | Bunyan, bridged to OTel |
| Telemetry | OpenTelemetry SDK + auto-instrumentations, OTLP/HTTP-proto |
| Build | esbuild — 4 bundles, ESM, minified, sourcemaps, `packages: "external"` |
| Test | Jest 30 + ts-jest, `@shelf/jest-mongodb`, supertest, `aws-sdk-client-mock`, fast-check |
| Package manager | pnpm 11 (Volta-pinned) |

## Commands

```bash
pnpm dev            # tsx --watch with OTel preloaded via --import
pnpm build          # tsc --noEmit  THEN  tsx esbuild.config.ts   ← the type-check gates the build
pnpm start          # node dist/index.js
pnpm test           # jest
pnpm test:watch
pnpm test:coverage

pnpm docker:build:be   # rjnishant530/revisir-be   (Dockerfile)
pnpm docker:build:fp   # rjnishant530/revisir-fp   (Dockerfile.file-processor)
```

Note: `docker:build:be` / `docker:build:fp` use `%npm_package_version%` — cmd.exe
variable syntax. They only expand correctly under a Windows `cmd` shell, not under
bash or PowerShell. There is no npm script for the url-extractor image; build it by
hand:

```bash
docker build . -f Dockerfile.url-extractor -t rjnishant530/revisir-be:latest
```

## Running the full stack

There is **no `docker-compose.yml` in this directory** — it was removed. Compose
lives one level up, in the sibling `.github/` repo:

```bash
cd ../.github/local && docker compose up      # builds backend + frontend from source
cd ../.github      && docker compose up       # pre-built images from Docker Hub
```

Optional profiles on both: `--profile observability` (OTel collector, Prometheus,
Loki, Tempo, Grafana) and `--profile firecrawl` (self-hosted Firecrawl + Playwright
+ Redis + Postgres).

Core services either way: Caddy (reverse proxy, **80 only** — local dev, plain
HTTP, no hostnames), MongoDB (27017), SeaweedFS (8333 S3 / 8888 filer / 9333 master),
RabbitMQ (5672 / 15672 management). A one-shot `seaweedfs-init` creates
`$S3_BUCKET_NAME` via `weed shell`.

Everything is reached through `http://localhost`: `/api` → api-service, `/storage`
→ SeaweedFS S3 (prefix stripped, `Host` restored so SigV4 still verifies), and
everything else → the frontend. Both compose files wire storage notifications the
same way now: the SeaweedFS filer webhooks `api-service`, which publishes to
`file_processing-exchange`.

SeaweedFS reads two mounted config files, shared by both compose files:
`../.github/seaweedfs/s3.json` (the S3 identity matching `S3_ACCESS_KEY`/
`S3_SECRET_KEY`) and `../.github/seaweedfs/notification.toml` (the filer webhook).

## Environment variables

`.env.example` is the starting point but is **incomplete** — several variables the
code actually reads are missing from it. Full list of what the source consumes:

### Required
| Var | Used by | Notes |
|-----|---------|-------|
| `MONGODB_URI` | all three processes | Default `mongodb://localhost:27017/revision-study-reminder` |
| `AUTH_AUTHORITY` | api-service | **Throws at import time if unset** (`src/middleware/auth.ts`). JWKS is fetched from `${AUTH_AUTHORITY}/.well-known/jwks.json`. Missing from `.env.example`. |
| `RABBITMQ_URL` | all three | Default `amqp://localhost`. Must be `amqp://` or `amqps://` or `ConnectionManager` throws. |

### LLM (missing from `.env.example`)
| Var | Notes |
|-----|-------|
| `LLM_PROVIDER` | `openai` \| `google` (default) \| `anthropic` \| `local` |
| `LLM_MODEL` | Per-provider default if unset — `gpt-4o-mini` / `gemini-3.1-flash-lite` / `claude-3-sonnet-20240229` / `llama3` |
| `LLM_API_KEY` | Required unless provider is `local`. `requireAIConfig` returns 503 without it. |
| `LLM_BASE_URL` | Required for `local` (e.g. `http://localhost:11434/v1`) |

`.env.example` still lists `GEMINI_API_KEY`, which no code reads — the AI SDK path
uses `LLM_API_KEY`.

### Storage
| Var | Notes |
|-----|-------|
| `BUCKET_TYPE` | `seaweedfs` points the S3 client at the SeaweedFS gateway. **This, not `NODE_ENV`, is the switch.** |
| `S3_BUCKET_NAME` | Default `revision-study-content` |
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | AWS mode |
| `S3_ENDPOINT`, `S3_PORT`, `S3_USE_SSL`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | SeaweedFS mode. Defaults `localhost:8333` / `seaweedfsadmin`. Credentials must match an identity in `../.github/seaweedfs/s3.json`. |
| `S3_PUBLIC_URL` | Browser-facing rewrite target for presigned URLs (`http://localhost/storage`). Whatever serves it must send the internal `Host` upstream. |

### URL extraction
| Var | Notes |
|-----|-------|
| `URL_EXTRACTOR` | `jina` (default) \| `tavily` \| `exa` \| `firecrawl` |
| `JINA_API_KEY`, `TAVILY_API_KEY`, `EXA_API_KEY` | Per-provider |
| `FIRECRAWL_API_KEY`, `FIRECRAWL_API_URL` | Set `FIRECRAWL_API_URL` for self-hosted |

Watch out: in `.env.example`, `URL_EXTRACTOR=jina  # "tavily" | ...` puts the
comment on the same line as the value. Many dotenv-style parsers would fold that
into the value.

### Workers
| Var | Notes |
|-----|-------|
| `START_FILE_CONSUMER` | `"true"` makes `fileProcessor.ts` self-start its consumer. Missing from `.env.example`. |
| `START_URL_CONSUMER` | Same for `urlProcessor.ts`. Missing from `.env.example`. |
| `URL_PROCESSOR_LAMBDA_NAME` | Only for the legacy AWS Lambda invocation path |

### Server & telemetry
| Var | Notes |
|-----|-------|
| `PORT` | `src/index.ts` defaults to **5000** (`.env.example` says 3000; Docker `EXPOSE`s 5000 and the healthcheck hits 5000) |
| `NODE_ENV` | `development` + `SKIP_AUTH=true` is the only way to bypass auth |
| `SKIP_AUTH`, `TEST_USER_ID` | Dev auth bypass; `TEST_USER_ID` defaults to `test-user-123` |
| `LOG_LEVEL` | Bunyan level, default `info`. Missing from `.env.example`. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Default `http://localhost:4318` |
| `OTEL_SERVICE_NAME` | Default `reviser-api`; compose overrides per process |
| `OTEL_DEBUG` | `"true"` enables OTel diagnostic logging |

## Build details worth knowing

- `packages: "external"` means dependencies are **not** bundled — the runtime images
  copy `node_modules` from a `pnpm install --prod` stage. Adding a runtime dep means
  it must survive `--prod` (i.e. be in `dependencies`, not `devDependencies`).
- The Dockerfiles copy specific bundles by prefix: `dist/file*` and `dist/url*`.
  Renaming an esbuild `outfile` silently breaks the corresponding image.
- `tsconfig.json` **excludes** `**/*.test.ts` and `**/*.example.ts`, so `pnpm build`
  does not type-check tests. `tsconfig.test.json` covers those (with
  `noUnusedLocals`/`noUnusedParameters` relaxed) and is what ts-jest uses.
- `pnpm-workspace.yaml` carries a `minimumReleaseAgeExclude` allowlist for the AI SDK
  and Mongoose packages — pinned exact versions there bypass the release-age gate.
  Bumping those versions in `package.json` means updating that list too.
