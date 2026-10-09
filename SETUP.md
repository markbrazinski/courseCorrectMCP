# Setup

## Prerequisites

- Node.js 22.18 or later (native TypeScript; `node:sqlite`)
- Git

## Install and check (works on a clean checkout; no paid calls)

```sh
npm ci
npm run typecheck
npm test                          # acceptance suite, including the product startup guards
npm run walkthrough               # M1: real MCP client over HTTP; writes .artifacts/walkthrough/ (ignored)
npx playwright install chromium   # once
npm run e2e                       # connected journeys in Chromium against the real service code
```

The browser suites start a **test-only** server, `tests/support/server.ts`, never the product entry point. It wires the labelled test doubles (recorded readings, swap cards and intents) and a fixture-scene route, `POST /admin/reset`.

## Evidence-dependent checks (optional)

These replay retained outputs of earlier live Amazon Nova probes. Those outputs are kept out of the repository, so these checks don't run on a clean checkout. Without the evidence, each check stops or skips with an `EVIDENCE-DEPENDENT` message naming the missing file.

| Check | Needs (git-ignored) |
|---|---|
| `npm run e2e` journey "A-2 lemon partial read" (skipped without it) | `.artifacts/probes/m2-replay.json` |
| `npm run walkthrough:m2` (M2: import, review and save over HTTP, cooking over MCP) | `private/probes/m2/inputs/`, `.artifacts/probes/m2-replay.json` |
| `npm run e2e:review` (import review → save → reload → cook → rescue on the real scone PDFs) | `.artifacts/probes/{cards,cards2,cards3}-replay.json`, `private/probes/cards/scones.pdf` |

## Paid checks (never run automatically)

These need an owner authorization and the `coursecorrect-nova` AWS profile:
- `npm run e2e:live`: live Nova interpretation and Polly speech through the companion.
- The probe scripts (`npm run probe:*`).

## Sample recipe

`samples/scones-explicit.pdf` is the supported sample for trying an import.
- **What it is:** an owner-authored ENGINEERING demo recipe (cream scones with 300 ML cream for the dough and 15 ML for brushing). The brushing amount follows America's Test Kitchen *Glazed Scones*.
- **What it isn't:** kitchen-tested or released cooking guidance.
- **Needs a live reader:** importing it needs `CC_EXTRACTOR=live`. With live reading off, the import reports that live reading is required.

## Run the companion and service

```sh
npm start   # builds src/web into dist/web, then serves http://127.0.0.1:8791/ (desktop Chrome for voice)
```

`npm run serve` starts the service without rebuilding.

**With nothing configured, every model and speech service is off:**
- The Recipe Book lists the owner-authored example recipes (risotto, scones, shortcake), and cooking, rescue, refusal and apply all work.
- A free-text request asks which ingredient is missing; tap it.
- Importing a recipe reports that live reading is required.
- Replies are text only.

**Each live service is a separate setting**, and needs `CC_LIVE=1`, the `coursecorrect-nova` AWS profile (a non-root IAM user; the service refuses to start otherwise) and an owner authorization record. For example:

```sh
CC_LIVE=1 CC_INTERPRETER=nova CC_SPEECH=polly CC_EXTRACTOR=live CC_ANALYZER=live CC_OWNER_TOKEN=<choose-a-key> npm start
```

**Spending:**
- Every live call is reserved and settled in `.artifacts/ledger/nova-ledger.jsonl` against that authorization's call and dollar caps, and is never retried automatically.
- Polly audio is cached by its exact text and settings in `.artifacts/speech-cache/`.
- Credentials stay server-side.
- `npm run e2e:live` is a small paid check; `npm run evidence:m3` collects a real-audio walkthrough's records.

The companion has no owner review screen (owner decision 2026-10-02). The owner routes below need `CC_OWNER_TOKEN`; without it they are unavailable.

| Endpoint | Purpose |
|---|---|
| `/mcp` | Streamable HTTP; the eight tools (six cooking tools, `import_recipe`, `delete_recipe` = archive) |
| `GET /activity` | Server-recorded MCP calls |
| `GET /health` | Health check |
| `GET /` | The companion (built files in `dist/web`) |
| `POST /speech {"evaluationId"} \| {"runId","stepId","amendmentId"?}` | Polly audio for text the service rendered ("Change applied." only for an amendment the run holds). It never accepts arbitrary text. Header `x-speech-id` names the cached clip; its exact text and settings are in `.artifacts/speech-cache/<id>.json` |
| `POST /uploads` | `application/pdf` body (header `x-filename`): stores the file and returns `{"sourceDocId"}`; nothing is read. The companion then imports it with the `import_recipe` MCP tool, and removes recipes with `delete_recipe` (archive) |
| `POST /imports` | `application/pdf` body (header `x-filename`) or `{"kind":"text","text":"…"}`; optional `Idempotency-Key` |
| `GET /imports/:jobId`, `GET /drafts/:id`, `POST /drafts/:id/{append-text,save}`, `GET /recipes/:id` | Import, pasted missing steps and save. Each ingredient use shows one analysis status (alternative available, no alternative found, checking, check failed, can't check yet, not checked yet), from the server's per-use `analysis` (FE–BE Contract v1 Amendment 1). |
| `GET /authoring/drafts/:id/requirements`, `GET /authoring/vocabulary`, `POST /authoring/drafts/:id/{assertions,revisions}` | Owner review and repair (bearer `CC_OWNER_TOKEN`) |
| `POST /admin/start-over` | Bearer `CC_OWNER_TOKEN`. Copies the database to `<db folder>/archive/`, then clears cooking sessions, imports and Activity. The example recipes stay. |

Environment variables (any value not listed stops startup):

| Variable | Default | Meaning |
|---|---|---|
| `CC_PORT` | `8791` | Listen port |
| `CC_DB` | `.artifacts/runtime/coursecorrect.db` | SQLite file (ignored) |
| `CC_OWNER_TOKEN` | unset | Bearer key for the owner routes |
| `CC_EXTRACTOR` | `none` | Reading a recipe at import. `none`: imports report that live reading is required. `live`: Nova. |
| `CC_ANALYZER` | `none` | AI swap cards at import. `none`: no AI alternatives (each use reads "not checked yet"; reviewed policies still apply). `live`: Nova, with one bounded correction round. |
| `CC_INTERPRETER` | `none` | `none`: free text falls back to an ingredient menu. `nova`: live. |
| `CC_EXPLAINER` | `none` | `none`: refusal answers use the template built from the engine's facts. `nova`: live wording of those facts (needs an authorization naming the `explanation` purpose; any rejected answer falls back to the template). |
| `CC_SPEECH` | `off` | `polly`: spoken replies (the AWS user needs `polly:SynthesizeSpeech`) |
| `CC_LIVE` | unset | `1` allows live calls at all |
| `CC_AUTHORIZATION` | `live-authorization-m3.json` | Owner authorization record under `private/architecture/` that live calls are charged against |

## Repository policy

`.gitignore` is default-deny: only explicitly allowlisted paths can be tracked. New file types or paths require a narrow, reviewed allow rule.
