# CourseCorrectMCP

CourseCorrect helps a cook who runs out of an ingredient partway through a recipe.
- **At import:** it reads the recipe once and prepares checked alternatives for every ingredient use.
- **At the stove:** a deterministic engine re-checks those alternatives against the cook's reported progress, and changes the recipe only after explicit acceptance.

It is exposed as eight MCP tools and a browser companion that is itself an MCP client.

**Status:** a working local product

## How it works

**Prepare at import.** The cook uploads a recipe PDF (text layer only) or pastes recipe text.
1. **Read.** Amazon Nova 2 Lite, called through Amazon Bedrock Converse with one forced tool call, proposes a reading: ingredients, steps and every ingredient use, with copy-exact quotes. Code keeps only text found verbatim in the source and parses amounts from the source's own words.
2. **Give each use its job.** For example, liquid and fat in a dough, or aeration when whipped. The job comes from an owner-reviewed role table when code corroborates the ingredient and technique, never from the model's guess.
3. **Bind reviewed policies.** Reviewed substitution policies bind to those jobs, and code calculates their amounts.
4. **Draft AI alternatives.** Nova also drafts an alternative for each use, with one bounded correction round. Code validates each one, and drops it if it fails a check or contradicts a reviewed rule.
5. **Save.** Saving writes an immutable, versioned pack: the recipe model plus every executable plan. Reopening or cooking a saved recipe never calls the model again.

**Check and apply at the stove.** The cook reports progress, which is forward-only and never sensed, and then says or types what's missing.
1. **Interpret.** Nova turns free text into closed IDs only: which ingredient is missing, and what the cook proposes instead. Tapping the ingredient skips the model.
2. **Re-check.** The deterministic engine checks the saved plans against the live state:
   - this is the right step;
   - completed work is protected;
   - every other use of the ingredient is covered;
   - the result is still a valid recipe;
   - which amounts the cook must have on hand.
3. **Answer.** It returns one of three things:
   - a clarifying question;
   - a proposal, with its consequence;
   - a refusal that says why ("No, because…") and leaves the recipe unchanged.
4. **Accept.** Answering an availability question never applies anything. Only an explicit "use this change" applies, and the engine re-runs the whole check first. A change rewrites every affected instruction, and no step is ever marked done for the cook.

The same idea, milk and butter for cream, is accepted in scone dough and refused at the shortcake's whipping step. The decision follows the ingredient's job, not its name.

Spoken replies are Amazon Polly, synthesized server-side from text the service itself rendered.

## Technologies and dependencies

- **Node.js** `>=22.18` runs the TypeScript service natively (type stripping) and stores state in SQLite through `node:sqlite` (WAL).
- **`@modelcontextprotocol/sdk`** `1.30.1` serves the eight MCP tools over stateless Streamable HTTP (protocol `2025-11-25`).
- **Amazon Bedrock Converse** (`@aws-sdk/client-bedrock-runtime` `^3.1139.0`) with the US Amazon Nova 2 Lite inference profile `us.amazon.nova-2-lite-v1:0` in us-east-1.
  - **Used for:** recipe reading, AI alternatives, request interpretation, and optional refusal wording.
  - **Call discipline:** temperature 0, one forced tool call per request, never retried.
- **Amazon Polly** (`@aws-sdk/client-polly` `3.1145.0`): the neural voice Joanna, MP3, cached by the exact text.
- **AWS CLI v2**: the startup identity check before any live call (live mode only).
- **`pdfjs-dist`** `^6.3.289`: extracts PDF text layers in an isolated worker thread. There is no OCR.
- **`zod`** `4.6.5`: validates tool inputs and model-output schemas.
- **React** `19.3.0` and **Vite** `8.3.2`: build the companion.
- **The browser's Web Speech API** (desktop Chrome): speech input. Typed input is always available.
- **TypeScript** `7.0.2`, **Vitest** `4.1.11` and **Playwright** `1.63.0`: checks and browser journeys.

## Demo

- Demo video: not recorded yet; the link will be added here.
- Screenshots: to come.

## Run locally

### Prerequisites

- Git.
- Node.js 22.18 or later, plus npm.
- Desktop Chrome for voice input. Any current browser works with typed input.
- A free local port `8791`, or another port set with `CC_PORT`.
- **Only for live model and speech calls:**
  - an AWS account with Amazon Bedrock access to Amazon Nova 2 Lite and Amazon Polly in us-east-1;
  - a non-root IAM user named `coursecorrect-nova`, configured as the AWS CLI profile `coursecorrect-nova`. The service refuses any other identity.
  - AWS CLI v2;
  - a spending authorization file (see [Troubleshooting](#troubleshooting-and-shutdown)).
  - Live calls cost money: Nova per token and Polly per character.

Clone, install and start:

```bash
git clone https://github.com/markbrazinski/courseCorrectMCP.git
cd courseCorrectMCP
npm ci
npm start
```

`npm start` builds the companion into `dist/web`, then serves it. Successful startup ends with:

```text
CourseCorrectMCP on http://127.0.0.1:8791/ (MCP at /mcp) · interpreter NONE · explainer NONE · extractor OFF · swaps OFF · speech off · ENGINEERING · packs …
```

In a second terminal:

```bash
curl -fsS http://127.0.0.1:8791/health
```

It should report `{"ok":true,"interpreter":"NONE","speech":"off"}`.

Open [http://127.0.0.1:8791/](http://127.0.0.1:8791/) in desktop Chrome. With nothing configured, every model and speech service is off:
- The Recipe Book lists three owner-authored examples: **Risotto with Parmesan**, **Cream Scones** and **Strawberry Shortcake**.
- Cooking, rescue, refusal and apply all work.
- When you say what's missing, CourseCorrect asks which ingredient it is; tap it.
- Replies are text only.
- Importing a recipe reports that live reading is required.

To try a rescue, open an example and select **Start cooking**. Select **Done** on each step until you reach the one that uses the missing ingredient, then ask. With interpretation on:
- **Risotto, step 5:** "I don't have any white wine. Can I use lemon juice?" CourseCorrect asks about hot stock and lemon juice, then splits the wine's two jobs; steps 5 and 7 change.
- **Scones, step 3:** "I'm out of heavy cream. Can I use milk and butter?" The dough step and the brushing step both change.
- **Shortcake, step 6:** "I'm out of heavy cream. Can I use milk and butter to whip instead?" A refusal that says why; the recipe is unchanged.

To turn on live services, set each one separately. Any subset works:

```bash
CC_LIVE=1 CC_AUTHORIZATION=<your-authorization>.json \
CC_INTERPRETER=nova CC_SPEECH=polly CC_EXTRACTOR=live CC_ANALYZER=live \
CC_OWNER_TOKEN=<choose-a-key> npm start
```

Live startup prints `live AWS identity IAM_USER(coursecorrect-nova) · authorization <id>` before the server line. To try an import with live reading on:
1. Select **Add a recipe**.
2. Choose [`samples/scones-explicit.pdf`](samples/scones-explicit.pdf).
3. Select **Upload and read**, review the reading, and **Save to Recipe Book**.

**Costs, at list price in earlier runs:**

| Item | Cost |
|---|---|
| One import (reading, AI alternatives and the correction round) | About $0.01 |
| One interpreted request | About $0.001 |
| Polly | $16 per 1M characters, about $0.0014 for a typical reply |

Every setting is described in [SETUP.md](SETUP.md).

### Verification

These checks need no AWS account and make no paid calls:

```bash
npm run typecheck
npm test                          # acceptance suite, including the product startup guards
npm run walkthrough               # M1: a real MCP client over HTTP
npx playwright install chromium   # once
npm run e2e                       # browser journeys through the companion
```

- **What `npm run e2e` runs against:** a **test-only** server (`tests/support/server.ts`) that wires labelled recorded readings, swap cards and intents. The product entry point has no recorded or replay mode.
- **On a fresh clone:** one journey is skipped, because it needs retained evidence that isn't in the repository.
- **Evidence-dependent checks:** `npm run walkthrough:m2`, `npm run e2e:review` and that journey replay outputs of earlier live Nova probes, which are kept out of git. Without them, each stops or skips with an `EVIDENCE-DEPENDENT` message.
- **Paid checks:** `npm run e2e:live` and the probe scripts need a spending authorization.

To clear the local state, archive the database first, then clear cooking sessions, imports and Activity. **This is destructive.**

```bash
curl -fsS -X POST -H "Authorization: Bearer <your-owner-token>" http://127.0.0.1:8791/admin/start-over
```

### Troubleshooting and shutdown

- **`CC_EXTRACTOR=<value>: expected none or live`** (or the same for another setting): the product accepts only the values listed in SETUP.md, and has no replay or recorded mode.
- **`refusing live calls: AWS identity is …`:** live settings need the `coursecorrect-nova` IAM user through the `coursecorrect-nova` profile. Root and other identities are refused.
- **A missing authorization file on a live start:** create one under `private/architecture/` (git-ignored) and name it with `CC_AUTHORIZATION`. The ledger refuses any purpose the file doesn't list.

  ```json
  { "id": "local-1", "grantedBy": "<you>", "at": "<date>", "profile": "coursecorrect-nova",
    "maxCalls": { "interpretation": 50, "speech": 100, "extraction": 5, "swapAnalysis": 10, "explanation": 0 },
    "maxUsd": 1, "projectCeilingUsd": 5, "priorProjectUsd": 0 }
  ```

- **Spending and caps:**
  - Every live call is reserved first in `.artifacts/ledger/nova-ledger.jsonl`. A failed call keeps its reservation, and nothing is retried.
  - **"Spoken reply unavailable" or `BUDGET_EXCEEDED`:** a cap was reached. Raise it in the authorization file and restart.
- **The import says live reading is required:** `CC_EXTRACTOR` is `none`, which is the default.
- **"That PDF has no readable text":** it's probably a scan, and there's no OCR. Paste the recipe text instead. PDFs can be up to 10 MB and 20 pages.
- **"Microphone unavailable":** the browser has no speech recognition (for example, Firefox), or microphone permission was denied. Type instead.
- **Port `8791` is busy:** set `CC_PORT` and open the companion on that same port. The server listens on `127.0.0.1` only, and accepts browser requests only from `http://127.0.0.1:<port>` or `http://localhost:<port>`.
- **Owner routes return 401:** set `CC_OWNER_TOKEN` and send it as a bearer token.
- **To stop:** press Ctrl-C.
  - **Where state lives:** `.artifacts/runtime/coursecorrect.db` (set with `CC_DB`), Polly clips in `.artifacts/speech-cache/`, and the ledger in `.artifacts/ledger/`. All of it is git-ignored.
  - **On restart:** state is kept. An import or check that was interrupted is reported as interrupted, and never re-applied.

## Repository structure

```text
src/authoring/       import: PDF and text intake (pdf.js worker), Nova reading and swap-card analysis, drafts, save
src/compile/         reviewed policies → executable plans with calculated quantities; AI card validation
src/engine/          deterministic evaluation, apply and progress (no I/O, no clock, no model)
src/contract/        wire projections: per-use analysis, refusal "why" facts, candidates
src/domain/          recipe, vocabulary and exact-number helpers
src/service/         product entry point, MCP tools, HTTP routes, SQLite store, interpretation, explanation, Polly
src/web/             React companion (an MCP client)
src/probes/          owner-authorized live probe and evidence scripts (not used by the product)
src/walkthrough*.ts  scripted M1 and M2 walkthroughs over real MCP
content/approved/    owner-approved vocabulary, role table, policies, example recipes and test fixture scenes
samples/             the owner-authored sample recipe PDF
tests/               acceptance (Vitest), e2e and review (Playwright), live (paid), fixtures, test-only server
```

`.artifacts/` holds local databases, caches, the ledger, test output and retained probe evidence. `private/` holds the owner's documents and evidence. Both are git-ignored. The product creates its own database, cache and ledger, and reads only a spending authorization from `private/`, and only in live mode.

## Sample outputs

- [`samples/scones-explicit.pdf`](samples/scones-explicit.pdf) is an owner-authored ENGINEERING demo recipe: cream scones with 300 ML of cream for the dough and 15 ML for brushing. The brushing amount follows America's Test Kitchen *Glazed Scones*.
- `content/approved/recipes/` holds the three owner-authored example recipes. They're compiled at startup.
- `tests/fixtures/` holds the hand-written recorded readings, swap cards and intents the tests use, labelled `RECORDED`. The product never loads them.
- Sanitized example outputs aren't in the repository yet: a proposal, a refusal with its reasons, an applied change, and a saved recipe's per-use analysis.

## License

None has been chosen yet. No license file is included, so no license is granted.

## Honest boundaries

**What it is.** A local product: it listens on `127.0.0.1`.
- It isn't hosted.
- There is no authentication, account or multi-user isolation: one kitchen per server.
- The MCP endpoint is unauthenticated on localhost, behind an Origin check.

**All content is ENGINEERING content.**
- Quantities are provisional.
- The recipes are owner-authored demos.
- Nothing is kitchen-tested or released as cooking guidance.

**Nova proposes; code decides.**
- Model output is untrusted until code validates it.
- The model never selects a plan, computes a reviewed amount, judges eligibility or applies a change.
- AI alternatives fail closed, and a failed check is shown as failed.
- If a live service is off or unavailable, the product says so. It never substitutes recorded or replayed results; those exist only in the test-only server.

**Input.**
- Speech input relies on the browser; Chrome sends audio to its own speech service.
- There is no server-side speech recognition and no OCR.

**Alexa.** No Alexa or Alexa+ integration exists. The MCP tools are designed for an assistant client, and the companion is the only client so far.

