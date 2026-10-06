# Setup

## Prerequisites

- Node.js 22.18 or later (native TypeScript; `node:sqlite`)
- Git

## Install and check

```sh
npm ci
npm run typecheck
npm test
npm run walkthrough      # M1: real MCP client over HTTP; writes .artifacts/walkthrough/ (ignored)
npm run walkthrough:m2   # M2: import/review/save over HTTP + cooking over MCP (needs the retained probe replay; see below)
npx playwright install chromium   # once
npm run e2e              # M3: 15 connected journeys in Chromium against the real service (no paid calls)
```

The import journeys in `npm run e2e` need the retained M2 readings (`.artifacts/probes/m2-replay.json`). Without them, extraction reports that live extraction is required.

## Run the companion and service

```sh
CC_ADMIN_TOKEN=<choose-a-secret> CC_OWNER_TOKEN=<choose-a-key> npm start   # builds src/web into dist/web, then serves
```

Open `http://127.0.0.1:8791/` in desktop Chrome. `npm run serve` starts the service without rebuilding.

The companion has no owner review screen (owner decision 2026-10-02). The authoring routes below stay on the server for scripted owner work; without `CC_OWNER_TOKEN` (or `CC_ADMIN_TOKEN`) they are unavailable.

| Endpoint | Purpose |
|---|---|
| `/mcp` | Streamable HTTP; the eight tools (six cooking tools, `import_recipe`, `delete_recipe` = archive) |
| `POST /admin/reset {"fixtureId": "..."}` | Bearer `CC_ADMIN_TOKEN`; resets to a fixture |
| `GET /activity` | Server-recorded MCP calls |
| `GET /health` | Health check |
| `GET /` | The companion (built files in `dist/web`) |
| `POST /speech {"evaluationId"} \| {"runId","stepId","amendmentId"?}` | Polly audio for text the service rendered ("Change applied." only for an amendment the run holds). It never accepts arbitrary text. Header `x-speech-id` names the cached clip; its exact text and settings are in `.artifacts/speech-cache/<id>.json` |
| `POST /imports` | `application/pdf` body (header `x-filename`) or `{"kind":"text","text":"…"}`; optional `Idempotency-Key` |
| `GET /imports/:jobId`, `GET /drafts/:id`, `POST /drafts/:id/{append-text,save}`, `GET /recipes/:id` | Import, pasted missing steps and save |
| `GET /authoring/drafts/:id/requirements`, `GET /authoring/vocabulary`, `POST /authoring/drafts/:id/{assertions,revisions}` | Owner review and repair (bearer `CC_OWNER_TOKEN`, defaults to `CC_ADMIN_TOKEN`) |

Environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `CC_PORT` | `8791` | Listen port |
| `CC_DB` | `.artifacts/runtime/coursecorrect.db` | SQLite file (ignored) |
| `CC_EXPLAINER` | `none` | `none`: refusal answers use the template built from the engine's facts. `nova`: live wording of those facts (needs `CC_LIVE=1` and an authorization naming the `explanation` purpose; any rejected answer falls back to the template) |
| `CC_INTERPRETER` | `none` | `none`: free text falls back to an ingredient menu. `recorded`: replays the labeled fixtures in `tests/fixtures/recorded-intents.ts`. `nova`: live (needs `CC_LIVE=1`) |
| `CC_SPEECH` | `off` | `polly`: spoken replies (needs `CC_LIVE=1` and an AWS user allowed `polly:SynthesizeSpeech`) |
| `CC_AUTHORIZATION` | `live-authorization-m3.json` | Owner authorization record under `private/architecture/` that live calls are charged against |
| `CC_EXTRACTOR` | `replay` | `replay`: readings retained from the authorized M2 live probe (`.artifacts/probes/m2-replay.json`, built with `npm run probe:m2 -- replay`). `none`: offline only. `live`: Nova (needs `CC_LIVE=1`) |

Live Nova and Polly run only with `CC_LIVE=1`, the `coursecorrect-nova` AWS profile (non-root; the service refuses to start otherwise) and an owner authorization record. `npm run serve:live` starts the live configuration; `npm run e2e:live` is a small paid check; `npm run evidence:m3` collects a real-audio walkthrough's records. Every call is reserved and settled in `.artifacts/ledger/nova-ledger.jsonl` against that authorization's call and dollar caps, and is never retried automatically. Credentials stay server-side.

## Demo recording runner

```sh
npm run demo -- --label golden --interpreter nova --speech polly        # live take (paid; charged to the M3 authorization)
npm run demo                                                            # rehearsal: RECORDED interpreter, cached Polly replies
```

The runner starts its **own** service and a fresh database per take (`.artifacts/demo/takes/<take>/`; port 18793), so your ordinary session is never reset. It drives the companion through the canonical timeline (`private/demo/timeline.json`, ignored), records the screen (product viewport only), screenshots, MCP activity, server records and every Polly reply with its exact text, then writes an editing package to `.artifacts/demo/packages/<take>/` (`index.html` recorded playback, `script.md`, `timeline.json/csv`, `IMOVIE.md`, 48 kHz WAV and MP4 derivatives beside the originals).

Keys (in the terminal, never in the product): **space/enter/→** advance one cue (after a mismatch: check again; the action is repeated only if the server recorded nothing) · **p** auto pacing on/off · **r** replay the last CourseCorrect reply from the take folder (no request) · **s** restart the scene through the admin fixture path (fresh run) · **q** end the take.

Options: `--alice typed|mic|file` (typed is labelled as typed; `mic` uses Chrome speech recognition; `file` plays `private/demo/alice/<cueId>.wav|m4a` aloud into the microphone), `--upload manual|auto` (manual: you choose the PDF and press Upload and read), `--auto`, `--from <cueId>`, `--record-mic`, `--polly-speed 1.1` (speed-adjusted copies in `audio/derived/`). Re-export a take with `npm run demo:export -- <takeDir>`.

## Repository policy

`.gitignore` is default-deny: only explicitly allowlisted paths can be tracked. New file types or paths require a narrow, reviewed allow rule.
