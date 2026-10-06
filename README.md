# CourseCorrectMCP

A deliberate restart of CourseCorrect: a deterministic service that reconciles a missing ingredient with a recipe already in progress.

**Status: Milestone 3 checkpoint (companion UI and voice; held-out transfer still pending).** One TypeScript service exposes eight MCP tools:
- cooking: `list_recipes`, `start_recipe`, `get_active_recipe`, `record_progress`, `evaluate_rescue`, `apply_amendment`;
- recipe management: `import_recipe` (pasted text, or the handle of a file already uploaded to `POST /imports`; it makes an unsaved draft and never saves, reviews or releases) and `delete_recipe` (archives a recipe from the Recipe Book; history, receipts, saved versions and sources are kept).

- Reviewed rules bind to a recipe by the job an ingredient does at a step. They do not bind by its name.
- Completed and started work is protected.
- Every change needs explicit acceptance and applies at most once.

All content is **engineering content**:
- quantities are provisional;
- the recipes are owner-authored demos;
- nothing is kitchen-tested or released as cooking guidance.

Recipes can be added from PDF (text layer only, no OCR) or pasted text:
- a model proposes the structure; amounts are parsed by code from words found verbatim in the source;
- ingredient roles come from a reviewed role table (`content/approved/roles.json`), never from the model's guesses, and a guessed kind or technique counts only when code corroborates it;
- the import pre-computes a swap plan per ingredient use, with exact amounts, and nobody is asked to confirm anything;
- saving computes eligibility, and never reviews or releases anything.

The companion (React, served by the same process at `/`) is itself an MCP client, so its Activity column shows real tool calls recorded by the server. It covers:
- the Recipe Book;
- PDF or text import, with a staged reading review;
- an "If you run out" swap plan per ingredient, on the import canvas and the recipe page;
- cooking with progress reporting;
- changing course: interpretation with a correction route, availability questions, the proposed change with its consequence beside acceptance, refusals that say "No, because …" (the engine's reasons; a model may only word them), and lost-response reconciliation.

Voice: the browser's speech recognition with a typed fallback; spoken replies are Amazon Polly, synthesized server-side from service-rendered text.

Live model and speech calls run only under an explicit, capped owner authorization.
