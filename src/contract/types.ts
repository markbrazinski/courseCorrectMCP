// Engine-internal contract (ESOD v0.4 §4.1). Wire shapes (FE–BE Contract v1) live in project.ts.
import type { Rational } from '../domain/rational.ts';
export type { Rational };

/** Bump ONLY when evaluation semantics change. Code refactors never change pack identity (B27). */
export const ENGINE_SEMANTICS = 3;   // 2: up to MAX_CHANGES_PER_RUN changes per run; a later change may not touch what an earlier one changed
                                     // 3: a refusal binding with no proposal classes (an import card's "no") refuses any replacement for its use
export const MAX_CHANGES_PER_RUN = 4;   // owner decision 2026-10-02

export type Id = string;
export type Sha256 = string;
export type Unit = 'G' | 'ML' | 'COUNT';
export type StepStatus = 'NOT_STARTED' | 'STARTED' | 'COMPLETED';
export type UseStatus = 'UNADDED' | 'PARTIAL' | 'ADDED';
// SOURCE_VERIFIED: an amount code parsed from words found verbatim in the source; ranks with CONFIRMED (owner decision 2026-10-02).
export type FactStatus = 'PROPOSED' | 'SOURCE_VERIFIED' | 'CONFIRMED' | 'REVIEWED';
export interface Provenance { status: FactStatus; by: 'MODEL' | 'CODE' | 'CONTENT' | 'COOK' | 'OWNER'; ref: string | null }

export type Amount =
  | { kind: 'EXACT'; value: Rational; unit: Unit; asWritten: string | null }
  | { kind: 'RANGE'; min: Rational; max: Rational; unit: Unit; asWritten: string | null }
  | { kind: 'AS_WRITTEN'; text: string }
  | { kind: 'UNSPECIFIED' }
  | { kind: 'NOT_QUANTITY_BEARING'; reason: 'TO_TASTE' | 'FOR_SERVING' | 'AS_NEEDED'; text: string };
export interface Allowance { max: Rational; unit: Unit; stopCondition: string; ifExhausted: string }

// ---------- vocabulary (content) ----------
export interface Vocabulary {
  schema: 'cc-vocabulary/1'; version: number;
  functions: { functionId: Id; label: string }[];
  techniques: { techniqueId: Id; label: string }[];
  classes: { classId: Id; label: string }[];
  kinds: { kindId: Id; label: string; short: string; aliases: string[]; classes: Id[] }[];
}

/** Reviewed import authority (content/approved/roles.json): roles per kind × technique, and technique cues for step text. */
export interface RoleTable {
  schema: 'cc-roles/1'; decisionRef: string;
  roles: { kindId: Id; techniqueId: Id; functions: Id[]; note: string }[];
  cues: Record<Id, string[]>;
}

// ---------- recipe ----------
export interface Recipe {
  schema: 'cc-recipe/2';
  recipeId: Id; revision: number; title: string; meta: string;
  volumeSystem: 'US' | 'METRIC';
  source: { label: string; rights: 'OWNER_AUTHORED' | 'PUBLIC_DOMAIN' | 'PRIVATE_REFERENCE' | 'UNKNOWN' } | null;
  ingredients: Ingredient[];
  steps: Step[];               // array order = display order
  uses: IngredientUse[];
}
export interface Ingredient {
  ingredientId: Id; name: string;
  kind: { kindId: Id; prov: Provenance } | null;
  listed: Amount; listedProv: Provenance;
}
export interface Step {
  stepId: Id; title: string | null; text: string;      // text holds {use:<id>} / {allowance:<id>} tokens
  technique: { techniqueId: Id; prov: Provenance } | null;
  dependsOn: Id[];
  duration: { seconds: number; display: string; sourceText: string | null } | null;
  prov: Provenance;
  /** Imports only (closure 2026-10-08): whether this step's wording was found, in order, in the source text, and the
   *  source text left unaccounted for between it and the previous step ('' = none). Absent: not assessed. */
  source?: { located: boolean; gapBefore: string };
}
export interface IngredientUse {
  useId: Id; ingredientId: Id; stepId: Id;
  kind: 'ADD' | 'PREPARE'; preparesUseId: Id | null;
  amount: Amount; amountProv: Provenance;
  displayText: string | null;   // original wording rendered by {use:id}; null → amount + prepNote + name
  prepNote: string | null;
  functions: { functionId: Id; label: string | null; prov: Provenance }[];
  optional: boolean; allowance: Allowance | null;
}

// ---------- patterns (content, reviewed) ----------
export type SlotRef = string;                       // '$target' | '$<slot>'
export interface UseSelector { ingredientClass: Id; performsAll: Id[]; stepTechnique: Id }
export type SlotSelector =
  | { slot: Id; kind: 'STEP_AFTER_TARGET' | 'STEP_BEFORE_TARGET'; technique: Id }
  | { slot: Id; kind: 'USE_AFTER_TARGET'; ingredientClass: Id; performsAll: Id[]; stepTechnique: Id | null }
  | { slot: Id; kind: 'USE_OF_CLASS'; ingredientClass: Id };
export type Predicate =
  | { kind: 'AMOUNT_IN_RANGE'; slot: SlotRef; unit: Unit; min: Rational; max: Rational }
  | { kind: 'USE_PERFORMS'; slot: SlotRef; functionId: Id }
  | { kind: 'STEP_TECHNIQUE'; slot: SlotRef; techniqueId: Id }
  // G1 (commission 2026-10-08). Presence/absence over the whole recipe: absence PASSes only when every other ADD use's kind
  // is REVIEWED; an unconfirmed kind is UNKNOWN (missing extraction is never proven absence).
  | { kind: 'RECIPE_HAS_USE_OF_CLASS'; classId: Id; expect: boolean }
  // No hold between two steps: every step after `from` up to and including `to` has a REVIEWED technique outside
  // `techniques`, and no `cues` match its text. An unrecognized step is UNKNOWN, never PASS.
  | { kind: 'NO_HOLD_BETWEEN'; from: SlotRef; to: SlotRef; techniques: Id[]; cues: string[] };
export interface Exception { exceptionId: Id; when: Predicate; reason: string }
export type QuantityExpr =
  | { kind: 'LITERAL'; value: Rational; unit: Unit }
  | { kind: 'SCALE'; from: SlotRef | { listedTotalOf: SlotRef }; sourceUnit: Unit; factor: Rational; resultUnit: Unit;
      inputDomain: [Rational, Rational]; increment: Rational; maxAbsError: Rational; outputDomain: [Rational, Rational];
      /** show a volume result in the recipe's spoons ("¾ tsp"); the value stays in ML */ display?: 'SPOONS' }
  | { kind: 'UNRESOLVED'; unresolvedId: Id; question: string };
export interface NewUseSpec {
  local: Id; ingredient: { slot: SlotRef } | { introduce: Id };
  at: SlotRef;
  qty: Id | 'CARRY_AS_WRITTEN';
  prepNote: string | null; functions: Id[];
  allowance: { maxQty: Id; stopCondition: string; ifExhausted: string } | null;
}
export type PatternOp =
  | { op: 'REPLACE_USE'; use: SlotRef; with: NewUseSpec }
  // G6: `beside` writes the new use right after another plan use's token ("{use:a} mixed with {use:b}"); fails closed if absent
  | { op: 'ADD_USE'; use: NewUseSpec; placement: 'JOIN_USE_LIST' | 'APPEND_SENTENCE' | 'NONE' | { beside: Id; joiner: string } }
  | { op: 'REMOVE_USE'; use: SlotRef; placement?: 'FROM_USE_LIST' }   // FROM_USE_LIST: drop it from "A, B and C" (fails closed if not in one)
  | { op: 'SET_STEP_TEXT'; step: SlotRef; text: string }
  /** an authored sentence after the step's own wording (no amounts); the step counts as touched (protected work) */
  | { op: 'APPEND_STEP_NOTE'; step: SlotRef; text: string }
  | { op: 'SET_STEP_TITLE'; step: SlotRef; title: string }
  | { op: 'SET_RESUME'; step: SlotRef }
  // Specified, deferred (ESOD §4.1): the binder fails closed with UNSUPPORTED_OP for any binding that uses them.
  | { op: 'INSERT_STEP_BEFORE'; before: SlotRef; local: Id; title: string; text: string; techniqueId: Id }
  | { op: 'REMOVE_STEP'; step: SlotRef };
export interface SiblingHandler { match: { performsAll: Id[]; stepTechnique: Id }; replaceWith: Omit<NewUseSpec, 'at'> }
export type Disposition = 'RETAINED' | 'MOVED' | 'DROPPED_WITH_TRADEOFF';
export interface FunctionDisposition { from: SlotRef | { sibling: number }; functionId: Id; disposition: Disposition; to: Id | null }
export interface Consequence {
  outcomeClass: 'SUBSTITUTED' | 'FUNCTION_MOVED' | 'ALTERNATE_FINISH';
  equivalence: 'EQUIVALENT' | 'NOT_EQUIVALENT'; headline: string; reason: string; tradeoff: string;
}
export interface ProposalClaim { classes: Id[]; relation: 'REALIZED_AS_PROPOSED' | 'ADAPTED'; text: string }
export interface Guard { kind: 'CURRENT_STEP_IS'; step: SlotRef }
interface PatternBase {
  schema: 'cc-pattern/1'; patternId: Id; version: number; title: string;
  target: UseSelector; slots: SlotSelector[];
  applicability: Predicate[]; exceptions: Exception[];
  evidence: { quantityStatus: 'NONE' | 'PROVISIONAL' | 'SOURCED' | 'TRIALED'; basis: string };
}
export interface RecoveryPattern extends PatternBase {
  kind: 'RECOVERY';
  introduces: { local: Id; kindId: Id; name: string }[];
  quantities: Record<Id, QuantityExpr>;
  ops: PatternOp[]; siblingHandlers: SiblingHandler[];
  functionAccounting: FunctionDisposition[]; introducedFunctions: { local: Id; functionId: Id }[];
  consequence: Consequence; proposal: ProposalClaim | null; guards: Guard[];
}
export interface RefusalPattern extends PatternBase {
  kind: 'REFUSAL';
  /** EQUALS: refuses exactly that replacement. OMISSION (classes []): refuses leaving the ingredient out; it never refuses a
   *  replacement, so it only removes omission plans (an import card's "omit"). */
  proposal: { classes: Id[]; match: 'EQUALS' | 'OMISSION' };
  response: 'NOT_FUNCTIONALLY_EQUIVALENT'; requiredFunctionLabel: string; text: string; scopeNote: string;
  /** authored ending for "<proposal> …" in a refusal's reasons ("can't make this dough rise on its own"); absent: "can't <technique>" */
  answer?: string;
}
export type Pattern = RecoveryPattern | RefusalPattern;

// ---------- compiled (immutable) ----------
export type Op =
  | { op: 'ADD_INGREDIENT'; ingredient: Ingredient }
  | { op: 'REPLACE_USE'; useId: Id; newUse: IngredientUse }
  | { op: 'ADD_USE'; newUse: IngredientUse }
  | { op: 'REMOVE_USE'; useId: Id }
  | { op: 'REPLACE_STEP_TEXT'; stepId: Id; text: string }
  | { op: 'SET_STEP_TITLE'; stepId: Id; title: string }
  | { op: 'SET_RESUME'; stepId: Id };
export interface MissingFact {
  subject: { kind: 'USE' | 'STEP' | 'INGREDIENT'; id: Id };
  predicate: 'FUNCTION' | 'TECHNIQUE' | 'KIND_CLASS' | 'AMOUNT_EXACT' | 'SOURCE_COVERAGE' | 'TIMING';
  expected: string; have: string | null; minStatus: FactStatus; who: 'COOK' | 'OWNER';
}
export type CoverageStatus = 'BOUND' | 'NEEDS_FACTS' | 'NOT_APPLICABLE' | 'AMBIGUOUS' | 'QUANTITY_UNRESOLVED' | 'DRY_RUN_FAILED' | 'CONFLICT';
export interface CoverageEntry {
  patternId: Id; patternVersion: number; patternTitle: string; kind: Pattern['kind']; targetUseId: Id | null;
  status: CoverageStatus; missing: MissingFact[]; failedCheck: { code: string; detail: string } | null;
}
export interface FunctionMapEntry { fromUseId: Id | null; functionId: Id; disposition: Disposition | 'INTRODUCED'; toUseId: Id | null }
export interface Binding {
  bindingId: Id; patternId: Id; patternVersion: number; patternHash: Sha256; patternTitle: string; kind: Pattern['kind'];
  targetUseId: Id; slots: Record<Id, Id>;
  ops: Op[]; quantities: Record<Id, { value: Rational; unit: Unit }>;
  functionMap: FunctionMapEntry[];
  coveredSiblingUseIds: Id[]; uncoveredSiblingUseIds: Id[];
  consequence: Consequence | null;
  proposal: ProposalClaim | null;                            // recovery claim
  refusal: { classes: Id[]; requiredFunctionLabel: string; text: string; scopeNote: string; omission?: true; answer?: string } | null;
  guards: { kind: 'CURRENT_STEP_IS'; stepId: Id }[];
  quantityStatus: PatternBase['evidence']['quantityStatus'];
  factsHash: Sha256;                                         // hash of the facts the binding read
  /** Set on bindings compiled from a validated import-time swap card (owner 2026-10-02); absent on reviewed-pattern bindings. */
  card?: CardSource;
}
/** What a card binding carries for honest labelling and "why": the card's own words, guarded at validation. */
export interface CardSource { role: string; opinion: string; tradeoff: string | null; siblingNotes: Record<Id, string> }
/** One import card's outcome for one ADD use, persisted with the pack (diagnostics included; never a half-plan). */
export interface CardEntry {
  useId: Id; verdict: 'swap' | 'omit' | 'no' | null; role: string | null; opinion: string | null;
  status: 'COMPILED' | 'SUPERSEDED' | 'INVALID'; reason: string | null;
  normalized?: string[];   // deterministic, meaning-preserving repairs applied before validation (the raw card is kept)
  roleNote?: string;       // R-1: where the card's roles differ from the approved table's (the table's were used)
  /** The one correction round (commission 2026-10-07), when this use was sent to it: why, and what came of it. */
  repair?: { originalReason: string; outcome: 'REPAIRED' | 'STILL_INVALID' | 'NOT_RETURNED' | 'DUPLICATE' | 'NOT_RUN' | 'RUNNING'; detail?: string };
  /** ccmcp-swaps-3: several ranked suggestions for this use, best first: each one's rejection reason, or the one used. */
  alternates?: { name: string; reason: string | null; used?: boolean }[];
}
export interface RecipePack {
  schema: 'cc-pack/1'; packHash: Sha256; engineSemantics: number;
  recipe: Recipe; recipeHash: Sha256; vocabularyHash: Sha256; patternSetHash: Sha256;
  bindings: Binding[]; coverage: CoverageEntry[]; warnings: string[];
  cards?: CardEntry[]; cardSetHash?: Sha256;                 // import-time swap cards (absent on approved content)
}

// ---------- runtime ----------
export interface RunSnapshot {
  runId: Id; epoch: number; packHash: Sha256; mode: 'COOK' | 'ENGINEERING';
  revision: number; version: number; appliedRescueCount: number;
  recipe: Recipe;                                  // current version
  stepStatus: Record<Id, StepStatus>; useStatus: Record<Id, UseStatus>;
}
export type Notice =
  | { kind: 'STATED_AMOUNT_IGNORED'; text: string }
  | { kind: 'CLAIMED_PROGRESS_NOT_RECORDED'; text: string }
  | { kind: 'UNMAPPED_PROPOSAL'; text: string };
export interface RescueRequest {
  missingIngredientId: Id | null;
  proposedKindIds: Id[];
  answers: { questionId: Id; choiceId: 'ENOUGH' | 'NOT_ENOUGH' | 'UNKNOWN' }[];
  notices: Notice[];
}
export interface Requirement {
  ingredientId: Id; name: string; qty: Rational | null; unit: Unit | null; display: string;
  forSteps: { stepId: Id; order: number }[];
  includesUpTo: Rational | null;
  alreadyReserved: { qty: Rational; display: string; forSteps: { stepId: Id; order: number }[] } | null;
  /** When the stated amounts serve several steps: each use's amount and purpose (from its step's technique, never its title). */
  parts?: { qty: Rational; purpose: string; noun: string | null; order: number; upTo: Rational | null }[];
}
export interface StepChange {
  stepId: Id; kind: 'CHANGED' | 'UNCHANGED' | 'REMOVED' | 'INSERTED';
  when: 'DONE' | 'NOW' | 'LATER'; prevOrder: number | null; newOrder: number | null;
  before: string | null; after: string | null; titleAfter: string | null;
  segments: { text: string; kind: 'same' | 'inserted' }[] | null;
  note: string | null;
}
export interface LedgerRow {
  ingredient: string; stepId: Id; order: number; before: string; after: string;
  kind: 'added' | 'removed' | 'replaced' | 'unchanged' | 'done'; roles: string;
}
export interface RoleRow { role: string; replacement: string; kind: 'replaced' | 'lost' | 'alreadyDone' }
export interface Candidate {
  candidateId: Id; planHash: Sha256; patternTitle: string;
  consequence: Consequence;
  changes: StepChange[]; ledger: LedgerRow[]; roleMap: RoleRow[];
  noLongerUsed: { ingredientId: Id; name: string }[];
  requirements: Requirement[];
  resume: { stepId: Id; order: number; title: string | null; text: string };
  quantityStatus: Binding['quantityStatus'];
  origin: 'REVIEWED' | 'IMPORT_CARD';
  ops: Op[]; resultRecipe: Recipe;               // internal; never on the cook wire
}
export type Question =
  | { questionId: Id; kind: 'REFERENCE'; prompt: string; choices: { choiceId: Id; label: string }[] }
  | { questionId: Id; kind: 'AVAILABILITY'; candidateId: Id; requirementHash: Sha256; prompt: string;
      requirements: Requirement[]; note: string | null };
export type RefusalCode =
  | 'NOT_FUNCTIONALLY_EQUIVALENT' | 'PROTECTED_WORK' | 'AFFECTED_USE_IN_PROGRESS' | 'AFFECTED_USE_UNACCOUNTED'
  | 'NO_SUPPORTED_RECOVERY' | 'NOT_APPLICABLE_NOW' | 'INSUFFICIENT_AVAILABILITY' | 'REFERENCE_NOT_IN_RECIPE'
  | 'NOTHING_TO_CHANGE' | 'SUCCESSIVE_RESCUE_UNSUPPORTED' | 'CONFLICTS_WITH_EARLIER_CHANGE' | 'NOT_RELEASED';
export type ProtectedFact =
  | { kind: 'STEP_STARTED' | 'STEP_COMPLETED'; stepId: Id; order: number }
  | { kind: 'USE_PARTIAL' | 'USE_ADDED'; useId: Id; label: string; order: number };
export interface Refusal {
  code: RefusalCode; message: string; reason: 'ALL_USES_DONE' | 'REPLACED_BY_AMENDMENT' | null;
  origin: 'REVIEWED' | 'IMPORT_CARD' | null;            // which kind of plan the refusal is about, when it is about one
  ingredientUses: { useId: Id; stepId: Id; order: number; label: string; functionLabels: string[]; status: UseStatus }[];
  requiredFunction: { label: string; stepId: Id; order: number; stepText: string } | null;
  protectedFacts: ProtectedFact[]; scopeNote: string | null;
  unchanged: string;
  nextAction: { kind: 'CONTINUE_STEP'; stepId: Id; order: number; text: string } | { kind: 'NONE' };
}
export interface ProposalResponse {
  proposed: { kindId: Id; label: string }[];
  response: 'REALIZED_AS_PROPOSED' | 'ADAPTED' | 'REFUSED' | 'NOT_COVERED';
  text: string | null; alternativeOffered: boolean;
}
export type Stage = 'MODE' | 'TARGET' | 'RESCUE_LIMIT' | 'SELECT' | 'FUNCTION' | 'HISTORY' | 'AFFECTED_USES'
  | 'GUARD' | 'PROPOSAL' | 'APPLY' | 'FUNCTION_ACCOUNTING' | 'RESULT_VALIDATION' | 'AVAILABILITY';
export interface TraceCheck { stage: Stage; check: string; result: 'PASS' | 'FAIL' | 'UNKNOWN'; code: string | null; detail: string | null }
export interface DecisionTrace {
  kind: 'cc-decision-trace/2'; engineSemantics: number; packHash: Sha256; stateHash: Sha256;
  global: TraceCheck[];
  bindings: { bindingId: Id; checks: TraceCheck[]; outcome: string }[];
}
export interface Target {
  ingredientId: Id; name: string; useId: Id; stepId: Id; order: number;
  allRemainingUses: { useId: Id; stepId: Id; order: number; label: string; status: UseStatus }[];
}
export interface EvaluationResult {
  status: 'CANDIDATES' | 'CLARIFY' | 'REFUSED' | 'NOT_RELEASED';
  target: Target | null;
  proposal: ProposalResponse | null;
  candidates: Candidate[];
  previews: Candidate[];
  questions: Question[];
  refusal: Refusal | null;
  notices: Notice[];
  speech: string;
  trace: DecisionTrace;
}
