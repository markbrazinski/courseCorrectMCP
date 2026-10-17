# CourseCorrect: friction log

Every entry records friction we hit while building CourseCorrect between Oct 1 and Oct 14, 2026, or a default we caught in review before it could cost money. Each one has a matching workaround in our code, infrastructure or deploy notes.

**Severity**
- **Blocker:** stopped work until resolved.
- **Major:** needed a redesign or a significant workaround, or put correctness or spending at risk.
- **Minor:** cost time or money, with a small workaround.

---

### 1. Bedrock throttling during a batch of imports, with charges we couldn't check
- **Tool:** Amazon Bedrock (Converse API), Amazon Nova 2 Lite, US inference profile. Oct 13.
- **Task:** import a set of 27 real-world recipes through our deployed import worker (AWS Lambda), to measure reading quality.
- **Steps:** started the imports in batches, with the worker's reserved concurrency set to 2. Each import makes one reading call and then batched alternative calls.
- **Expected:** calls succeed, or fail with enough information to plan a retry and know the cost.
- **Actual:**
  - 3 imports failed with `ThrottlingException: Too many requests, please wait before trying again`.
  - Our project role had no access to CloudWatch metrics, Cost Explorer or Service Quotas, so we couldn't confirm whether the throttled calls were billed. $0.074 of reservations stayed counted against our cap until we could rule that out.
- **Severity:** Major.
- **Workaround:**
  - A bounded retry inside the import job: up to 3 attempts, about 4 s and then 12 s apart, each reserved in our ledger separately.
  - A worker concurrency cap.
  - Throttled calls are now settled at $0 and marked "refused before inference".
- **Suggestion:**
  - State plainly on the Bedrock pricing page that throttled requests are not billed.
  - Return a `Retry-After` value with `ThrottlingException`.
  - Publish a read-only "quotas and spend" permission set, so a narrowly scoped project role can see its own Nova quotas and charges.

### 2. Default retries can charge twice for one paid call
- **Tool:** AWS SDK for JavaScript v3 (`client-bedrock-runtime`, `client-textract`), and AWS Lambda asynchronous invocation. Oct 9.
- **Task:** guarantee at most one billed call per reservation in our spending ledger.
- **Steps:** reviewed client and Lambda defaults before the first cloud deploy.
- **Expected:** a call that costs money is sent once unless the code asks for a retry.
- **Actual:**
  - The SDK retries a failed call up to 3 times by default (`maxAttempts`).
  - Lambda retries an asynchronous invocation twice.

  Either can turn one reserved call into several billed ones, and neither default is mentioned in the Bedrock or Textract quick starts. We caught this in review, before it cost anything.
- **Severity:** Major (a silent overspend risk).
- **Workaround:**
  - `maxAttempts: 1` on every paid client.
  - `MaximumRetryAttempts: 0` on the import worker.
  - All retries go through our ledger, so each attempt is reserved and capped.
- **Suggestion:**
  - Call out retry defaults in the getting-started guides for paid APIs.
  - Add an idempotency token to the Converse API, like Textract's `ClientRequestToken`, so a retried call can't bill twice.

### 3. No straightforward least-privilege identity for a first serverless deploy
- **Tool:** AWS IAM, AWS CloudFormation, AWS CLI v2. Oct 9.
- **Task:** deploy two CloudFormation stacks (DynamoDB, S3, two Lambda functions with an IAM role, and a Function URL) from a non-root identity.
- **Steps:**
  1. Ran the deploy with our project's IAM user, which was scoped to Nova and Polly.
  2. Tried the default CLI profile.
  3. Designed a dedicated deployer role.
- **Expected:** a documented, least-privilege policy for deploying a small Lambda + DynamoDB + S3 application.
- **Actual:**
  - The project user got `AccessDenied` on CloudFormation and Lambda.
  - The default profile was an expired console session.
  - We had to write a scoped deployer policy covering CloudFormation, Lambda, IAM role creation with `CAPABILITY_NAMED_IAM`, DynamoDB, S3 and Logs, limited to our resource prefix. Creating that role required one root sign-in.
- **Severity:** Blocker, until the role existed.
- **Workaround:** an operator user that assumes a deployer role limited to `cc-*` resources. Deploys now take under a minute.
- **Suggestion:** publish least-privilege deployer policy templates for common serverless shapes, or a guided IAM Access Analyzer flow for "the permissions this template needs to deploy".

### 4. Bedrock inference-profile permissions span several resources
- **Tool:** Amazon Bedrock, US inference profile `us.amazon.nova-2-lite-v1:0`, with IAM. Oct 8–9, during design.
- **Task:** give the Lambda execution role exactly the permission to call Nova 2 Lite through the US inference profile.
- **Steps:** wrote the role policy for the deployment design.
- **Expected:** one resource ARN per model.
- **Actual:** `bedrock:InvokeModel` needs the inference-profile ARN *and* the foundation-model ARN in every Region the profile routes to (us-east-1, us-east-2, us-west-2). We had to assemble this from the inference-profile and IAM pages.
- **Severity:** Minor.
- **Workaround:** a policy listing all four ARNs.
- **Suggestion:** a copy-ready IAM policy on each inference profile's console or docs page.

### 5. Textract's asynchronous API reads and bills whole documents
- **Tool:** Amazon Textract, `StartDocumentTextDetection` / `GetDocumentTextDetection`. Oct 13.
- **Task:** OCR only the pages of a recipe PDF that have no text layer.
- **Steps:**
  1. Classified pages by their text layer.
  2. Sent the document to Textract's asynchronous API (multi-page input).
- **Expected:** a page-range parameter, and the option to pass document bytes.
- **Actual:**
  - The asynchronous API processes and bills every page.
  - Input has to come from S3.
  - The two actions have no resource-level IAM ARNs, so the policy needs `Resource: "*"`.
- **Severity:** Minor (cost, plus extra infrastructure).
- **Workaround:**
  - Stage the PDF under a dedicated S3 prefix, delete it when the import ends, with a one-day expiry rule as a backstop.
  - Cache results by document hash.
  - Use a stable `ClientRequestToken`, so a repeated start reuses the job.
- **Suggestion:**
  - Add a page-range option to the asynchronous text-detection API.
  - Accept document bytes up to a few MB.
  - Add resource-level permissions.

### 6. OCR lines from two-column pages come back interleaved
- **Tool:** Amazon Textract `DetectDocumentText`. Oct 13.
- **Task:** read a scanned, two-column cookbook page (a fish chowder recipe) into ingredient lines.
- **Steps:**
  1. Ran OCR.
  2. Passed the lines to our reader.
  3. Compared the result with the printed page.
- **Expected:** lines in reading order, column by column.
- **Actual:**
  - Lines from the two columns came back interleaved.
  - Words hyphenated at the margin came back split.

  Read as given, an "or" at the end of one column's line could pair with an ingredient from the other column (for example "potatoes … or … salt").
- **Severity:** Major (a risk of joining the wrong ingredients). Our checks caught it.
- **Workaround:**
  - Our own column ordering, using line geometry.
  - Hyphen joining.
  - A printed "or" pairs only with a next line naming the same thing; otherwise we ask the cook.
- **Suggestion:** a reading-order hint in `DetectDocumentText` output, or a clear note in its docs that multi-column pages need Layout analysis (`AnalyzeDocument`, at a higher price).

### 7. Nova changed characters when asked to quote exactly
- **Tool:** Amazon Nova 2 Lite, forced tool call, temperature 0. Oct 13.
- **Task:** import a recipe whose ingredient list uses "▪" bullets. Our reader keeps a quote only if it appears word for word in the source.
- **Steps:**
  1. Live import.
  2. Verbatim check of each quoted line.
- **Expected:** quotes copied exactly.
- **Actual:** lines came back with "▷" in place of "▪", so they failed the verbatim check and the import couldn't use them.
- **Severity:** Minor.
- **Workaround:** treat list markers as interchangeable before matching. Everything else must still match exactly.
- **Suggestion:** guidance or a model option for exact copying in extraction tasks.

### 8. A field returned outside the forced tool's schema shape
- **Tool:** Amazon Nova 2 Lite, forced tool call with a JSON schema. Oct 13.
- **Task:** import our sample scone recipe PDF.
- **Steps:**
  1. Live import.
  2. Validated the tool input against our schema.
- **Expected:** the recipe title in the `title` field the schema defines.
- **Actual:** the title appeared only inside the nested recipes list. Our schema check failed, and the sample recipe couldn't be imported until we accepted that shape.
- **Severity:** Major (it blocked our sample recipe).
- **Workaround:** read the title from either location, and keep validating everything else strictly with zod.
- **Suggestion:** document how strictly tool-input schemas (`required`, `enum`, array bounds) are enforced, and offer a strict, constrained-decoding mode for tool inputs.

### 9. AI-drafted substitutions: correctly shaped, often wrong in substance
- **Tool:** Amazon Nova 2 Lite, forced tool call. Oct 4, one run of 3 recipes and 25 ingredient uses.
- **Task:** at import, draft one alternative per ingredient use, validated by our code.
- **Steps:**
  1. Ran the import pipeline.
  2. Validated each draft (references, amounts, rewritten steps).
- **Expected:** most drafts valid.
- **Actual:** 10 of 25 compiled. Failures:
  - 6 had no `swap` object;
  - 4 referenced their own use as a "sibling";
  - 3 rewrote a step without its amount;
  - 2 claimed a step the cook had already finished;
  - 1 used a word our guard rejected.

  Part of this was our schema: free-form IDs where per-request enums would have prevented self-references.
- **Severity:** Major. It drove our design: reviewed rules decide, and AI drafts are offered only after code checks pass.
- **Workaround:**
  - Fail closed.
  - A reviewed policy table for each ingredient's job.
  - Batched drafting with the whole recipe as context.
  - One bounded correction round.
- **Suggestion:** as in entry 8, documented schema enforcement and a strict mode, plus guidance for referential constraints in tool inputs.

### 10. A forced tool call picked an ingredient when "none" was the right answer
- **Tool:** Amazon Nova 2 Lite, forced tool call with an explicit `NONE` option. Oct 2.
- **Task:** classify a cook's spoken sentence as a missing-ingredient request, or as nothing.
- **Steps:**
  1. Spoke to the browser (Chrome speech).
  2. Our client sent the sentence to the interpreter.
- **Expected:** `NONE` for sentences that name nothing missing.
- **Actual:** "next one please" and "great let's turn on the timer" came back resolved to "stock". Three other non-requests correctly returned `NONE`.
- **Severity:** Minor. Our engine refused, so nothing changed.
- **Workaround:** progress and timer phrases are handled in the client before anything reaches the model.
- **Suggestion:** guidance for calibrated abstention in forced tool calls: making the model reliably choose an explicit "none" over a plausible option.

### 11. DynamoDB reads beside a transaction are read-committed
- **Tool:** Amazon DynamoDB (`GetItem`, `BatchGetItem`, `TransactWriteItems`). Oct 9.
- **Task:** serializable read-then-write transactions per workspace, safe across concurrent Lambda instances. These guard the spending ledger and the "apply a change once" rule.
- **Steps:** designed the store against the DynamoDB transactions documentation.
- **Expected:** a simple way to read a consistent snapshot and write it back atomically.
- **Actual:** reads made beside a transaction are read-committed, so a reader can see part of another transaction. Correctness depends on validating every item read inside the write transaction.
- **Severity:** Major (a correctness risk if missed).
- **Workaround:**
  - Every write transaction includes a version check on each item it read.
  - Large items are gzipped to stay under the 400 KB limit.
  - Racing-instance tests on DynamoDB Local.
- **Suggestion:** a prominent isolation example in the transactions guide, showing the optimistic-concurrency pattern with `ConditionCheck`.

### 12. Lambda Function URLs need a hand-written adapter for standard web requests
- **Tool:** AWS Lambda Function URLs (payload format 2.0), Node.js 24. Oct 9.
- **Task:** run the same web-standard `Request` → `Response` HTTP layer locally and on Lambda.
- **Steps:** wrote the Function URL handler.
- **Expected:** a supported adapter for web-standard handlers.
- **Actual:**
  - We wrote our own conversion: headers, cookies, base64 binary bodies.
  - Uploads count against the 6 MB request limit after base64 encoding.
- **Severity:** Minor.
- **Workaround:** a small adapter of our own, and a 4 MB cap on PDF uploads.
- **Suggestion:** native support in the Lambda Node.js runtime for handlers that take a `Request` and return a `Response`.

### 13. Slow cold starts when running TypeScript from source
- **Tool:** AWS Lambda, Node.js 24 with built-in type stripping. Oct 11–12.
- **Task:** keep a voice turn responsive on a cold function.
- **Steps:**
  1. Deployed the service as source files, as it runs locally.
  2. Measured initialization time.
- **Expected:** Node's built-in TypeScript support to work on Lambda as it does locally.
- **Actual:** cold-start initialization took 1.3–1.8 s, loading and type-stripping about 1,500 files.
- **Severity:** Major for a voice interface.
- **Workaround:** bundle the handler into one module with Rolldown. Initialization dropped to about 0.6 s.
- **Suggestion:** guidance in the Lambda Node.js docs on native TypeScript and when to bundle, and SnapStart for Node.js runtimes.

### 14. Speech permissions are separate from Bedrock
- **Tool:** Amazon Polly `SynthesizeSpeech`, IAM. Oct 2.
- **Task:** speak service-rendered replies from our Node server.
- **Steps:** turned on spoken replies with the IAM user we already used for Bedrock.
- **Expected:** audio.
- **Actual:** `AccessDeniedException` for `polly:SynthesizeSpeech`. The message named the exact missing action, so the fix was quick.
- **Severity:** Minor.
- **Workaround:**
  - An inline policy allowing only `polly:SynthesizeSpeech`, limited to us-east-1.
  - We also stopped forwarding provider error text to the browser, because it included an IAM ARN.
- **Suggestion:** a note in Nova voice examples that speech needs its own IAM action.

### 15. MCP TypeScript SDK: remote-server security left to us, and a dependency advisory
- **Tool:** Model Context Protocol TypeScript SDK 1.30.1 (open source). Oct 6–9.
- **Task:** serve MCP tools publicly on Lambda to outside clients, safely.
- **Steps:**
  1. Built a stateless Streamable HTTP server.
  2. Ran `npm audit`.
  3. Tested MCP Inspector, mcp-remote and the Python SDK.
- **Expected:** built-in options for authentication and origin checks.
- **Actual:**
  - Authentication and the browser `Origin` check (protection against DNS rebinding) are left to the server.
  - `npm audit` reports a high-severity advisory in the SDK's OAuth client (fixed in 1.32.1). It doesn't affect us, because we don't use that client.
- **Severity:** Minor.
- **Workaround:** our own signed bearer tokens per workspace, and an origin allow-list.
- **Suggestion:** reference middleware for authentication and origin checks on remote servers, and advisories surfaced in release notes.
