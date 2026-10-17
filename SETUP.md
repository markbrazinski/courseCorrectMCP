# Setup reference

The [README](README.md) covers installing, running and deploying. This page lists every setting, route and command.

## Settings

The local service reads these environment variables. Any value not listed stops startup with a message naming the setting.

| Variable | Default | Meaning |
|---|---|---|
| `CC_PORT` | `8791` | Listen port (the service binds `127.0.0.1` only) |
| `CC_DB` | `.artifacts/runtime/coursecorrect-kv.db` | Local store, one SQLite file |
| `CC_KNOWLEDGE_DB` | `coursecorrect-knowledge.db` beside `CC_DB` | Local knowledge table. At startup `content/approved` is published to it as a release (unchanged content is a no-op) and made active; recipes and sessions already pinned keep their release |
| `CC_OWNER_TOKEN` | unset | Bearer key for the owner routes below |
| `CC_EXTRACTOR` | `none` | `live`: Nova reads recipes at import. `none`: imports report that live reading is required |
| `CC_ANALYZER` | `none` | `live`: Nova drafts AI alternatives at import, with one bounded correction round. `none`: reviewed policies only |
| `CC_INTERPRETER` | `none` | `nova`: free-text requests. `none`: the cook taps the missing ingredient |
| `CC_EXPLAINER` | `none` | `nova`: Nova words refusal reasons from the engine's facts (any rejected wording falls back to the template). Needs the `explanation` purpose in the authorization |
| `CC_SPEECH` | `off` | `polly`: spoken replies |
| `CC_LIVE` | unset | `1` allows live calls at all |
| `CC_AUTHORIZATION` | — | Live runs: the spending authorization file name under `private/architecture/` (for example `authorization.json`) |
| `CC_AWS_IDENTITY` | `user/coursecorrect-nova` | The only AWS identity live calls may use: `user/<name>` or `role/<name>`. Checked with STS before any live call; root is always refused |

## Spending authorization

Every live call is reserved against an authorization before it's made, then settled at its measured cost, and never retried. A failed call keeps its reservation. The ledger is `.artifacts/ledger/nova-ledger.jsonl`. Start from [`authorization.example.json`](authorization.example.json):

| Field | Meaning |
|---|---|
| `id`, `grantedBy`, `at` | Who granted it and when; recorded on every ledger entry |
| `profile` | The AWS CLI profile live calls use |
| `maxCalls` | Call caps per purpose: `extraction`, `swapAnalysis`, `interpretation`, `explanation`, `speech`, `ocr`. A purpose not listed is refused |
| `maxUsd` | Dollar cap for this authorization |
| `projectCeilingUsd`, `priorProjectUsd` | A ceiling across authorizations, and what earlier ones already spent |
| `maxUsdByPurpose` | Optional dollar cap per purpose inside `maxUsd` |
| `perWorkspace`, `maxNewWorkspacesPerDay`, `paused` | Deployed only: caps per signed-in workspace, sign-ins per UTC day, and a stop switch |
| `tiers` | Deployed only: a separate allowance per tier, for workspaces opened with that tier's code. `tiers.judge` (`maxCalls`, `maxUsd`, `perWorkspace`, `maxNewWorkspacesPerDay`) is the judge link's budget. The project ceiling and `paused` still apply |

Polly audio is cached by its exact text and settings in `.artifacts/speech-cache/`, so a repeated reply costs nothing.

## Routes

| Route | Purpose |
|---|---|
| `POST /mcp` | Streamable HTTP, stateless: the eight MCP tools |
| `GET /` | The companion (built files in `dist/web`) |
| `GET /health` | Health check |
| `GET /activity` | MCP calls the server recorded |
| `POST /speech` | Polly audio for text the service rendered: `{"evaluationId"}` or `{"runId","stepId","amendmentId"?}`. It never accepts arbitrary text. Header `x-speech-id` names the cached clip |
| `POST /uploads` | A PDF body (header `x-filename`): stores it and returns `{"sourceDocId"}`, which the `import_recipe` tool then reads |
| `POST /imports` | A PDF body (header `x-filename`) or `{"kind":"text","text":"…"}`; optional `Idempotency-Key` |
| `GET /imports/:jobId`, `GET /drafts/:id`, `POST /drafts/:id/{append-text,save}`, `GET /recipes/:id` | Import status, pasting missing steps, saving, and a saved recipe with each ingredient use's analysis |
| `GET /authoring/drafts/:id/requirements`, `GET /authoring/vocabulary`, `POST /authoring/drafts/:id/{assertions,revisions}` | Owner review and repair of a draft (bearer `CC_OWNER_TOKEN`) |
| `POST /admin/start-over` | Local, bearer `CC_OWNER_TOKEN`: the kitchen moves to a new, empty workspace. The bundled recipes stay |
| `GET/POST /signin`, `POST /workspace/reset` | Deployed: the access-code sign-in (a new workspace per sign-in, in an HttpOnly signed cookie, or a bearer token for MCP clients), and start over for that workspace (it keeps the workspace's tier). Any page with `?code=` shows the sign-in form with that code filled in |

## Checks

Free, with no AWS account:

```sh
npm run typecheck
npm test                          # acceptance suite, including startup guards
npm run walkthrough               # a real MCP client over HTTP; writes .artifacts/walkthrough/
npx playwright install chromium   # once
npm run e2e                       # browser journeys
npm run test:dynamodb-local       # the acceptance suite on DynamoDB Local (port 8000)
```

The browser journeys start [`tests/support/server.ts`](tests/support/server.ts), a test server that wires recorded readings, alternatives and intents into the real service code. Its `POST /admin/reset` route sets up fixture scenes. The product entry point, `src/service/main.ts`, never loads test code; `tests/acceptance/startup.test.ts` enforces it.

Paid, with a spending authorization: `npm run e2e:live` (live interpretation and Polly through the companion).

Maintainer tooling: `npm run walkthrough:m2`, `npm run e2e:review`, `npm run probe:*`, `npm run evidence:m3` and `npm run transfer` replay or collect data kept outside the repository. Without that data they stop with a message naming the missing file, and the browser journey that needs it is skipped.

## Deploy to AWS Lambda

One environment is two CloudFormation stacks:
- **`cc-<env>-data`:** two on-demand DynamoDB tables (workspaces, and knowledge releases) and a private S3 bucket.
- **`cc-<env>-app`:** the web and import-worker functions, a public HTTPS Function URL, their IAM role and log groups.

Nothing charges while idle except stored data. The commands run with an AWS CLI profile for a non-root identity that may deploy, in `us-east-1`. Local files for each environment live in `private/deploy/<env>/` (git-ignored; override with `CC_DEPLOY_DIR`).

```sh
npm run cc -- init       --env <env> --profile <aws-profile>   # config.json, secrets.json (mode 600: access code, judge link code), a zero-cap authorization.json
npm run cc -- stage      --env <env>                           # build and zip the bundle (no AWS calls)
npm run cc -- deploy     --env <env>                           # stage, deploy both stacks, record the authorization; prints the URL
npm run cc -- verify     --env <env> [--paid]                  # smoke checks on the URL (--paid: one interpretation, one spoken reply, one import)
npm run cc -- status     --env <env>                           # stacks, version, URL, data, logs, spending
npm run cc -- usage | jobs | logs [--since 1h] --env <env>     # spending, import jobs, recent logs
npm run cc -- allowances --env <env> [--apply | --pause | --resume]   # show, record, pause or resume the deployed authorization
npm run cc -- maintenance --env <env> --on | --off             # 503 for new requests; running work finishes
npm run cc -- stop | start --env <env>                         # emergency: reserved concurrency 0 on both functions
npm run cc -- backup     --env <env> [--out <dir>] [--keep-frozen]          # every item and clip → ~/CourseCorrect-backups/<env>/<time>/
npm run cc -- restore    --env <env> --from <dir> --confirm <env>          # into a fresh deployment; spending carried, never doubled
npm run cc -- destroy    --env <env> --mode compute|full --confirm <env> [--backup <dir> | --no-backup]
npm run cc -- knowledge publish  --env <env> [--activate]      # content/approved → an immutable, verified knowledge release
npm run cc -- knowledge activate --env <env> --release <id>    # the release new recipes are pinned to (or roll back)
npm run cc -- knowledge list | refs | verify --env <env>       # releases, which ones saved recipes use, re-check every hash
```

The deployed functions read culinary knowledge only from the knowledge table, and may not write it. `deploy` updates the app stack only once a verified release is active, so a new environment runs `deploy`, `knowledge publish --activate`, then `deploy` again. Publishing never changes a recipe or session already pinned to a release. A restore brings back every release the restored recipes are pinned to, and checks each one before writing any recipe.

`config.json` holds the profile, the region, and the `modes` for the deployed services (`extractor`, `analyzer`, `interpreter`, `explainer`, `speech`, and `ocr`: `off` or `textract`). OCR reads PDF pages that have no text layer with Amazon Textract `DetectDocumentText`, at $0.0015 per page.

`node tests/support/bundle-check.ts .artifacts/deploy/<env>/stage` drives a staged bundle against DynamoDB Local.

## Repository policy

`.gitignore` is default-deny: only allowlisted paths can be tracked. Adding a new file type or path needs a narrow allow rule. Local state (`.artifacts/`) and private configuration (`private/`) are never tracked.
