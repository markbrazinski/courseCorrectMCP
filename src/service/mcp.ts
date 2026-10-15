// The MCP tools (ESOD §8.2): the six cooking tools, plus import_recipe and delete_recipe (owner amendment 2026-10-05).
// Static schemas; every mutating tool requires a stable commandId.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Authoring } from '../authoring/drafts.ts';
import type { Service } from './commands.ts';

const id = z.string().min(1);
const command = { commandId: id.describe('Client-generated UUID for this intended action; reuse it only to retry the identical request.') };
const runScope = { runId: id, epoch: z.number().int() };

type Out = Record<string, unknown> & { outcome?: string; code?: string; speech?: { text: string }; message?: string };

function statusOf(tool: string, out: Out): string {
  if (out.outcome === 'rejected') return 'failed';
  if (tool === 'apply_amendment') return 'applied';
  if (tool !== 'evaluate_rescue') return 'ok';
  return ({ needsInterpretation: 'needsFact', needsFacts: 'needsFact', proposal: 'proposed', refused: 'refused' } as Record<string, string>)[out.outcome ?? ''] ?? 'ok';
}
function summaryOf(tool: string, out: Out): string {
  if (out.outcome === 'rejected') return `Rejected · ${out.code}`;
  if (tool === 'evaluate_rescue') return out.speech?.text ?? String(out.outcome);
  if (tool === 'apply_amendment') return `${out.outcome} · ${(out.amendment as { changedStepIds?: string[] })?.changedStepIds?.length ?? 0} step(s) changed · not marked done`;
  if (tool === 'record_progress') return String(out.code ?? out.outcome);
  if (tool === 'import_recipe') return `${out.outcome} · draft only, not saved or reviewed`;
  if (tool === 'delete_recipe') return out.outcome === 'archived' ? 'Archived from the Recipe Book · history kept' : String(out.outcome);
  if (tool === 'get_active_recipe') return out.command ? `Status check · ${(out.command as { status: string }).status}` : 'Read active recipe';
  return String(out.outcome ?? 'ok');
}

export function buildMcp(svc: Service, authoring?: Authoring): McpServer {
  const server = new McpServer({ name: 'coursecorrect', version: '0.1.0' });
  const tool = <S extends z.ZodRawShape>(name: string, description: string, shape: S, fn: (args: z.infer<z.ZodObject<S>>) => Out | Promise<Out>) =>
    server.registerTool(name, { description, inputSchema: shape }, (async (args: z.infer<z.ZodObject<S>>) => {
      const t0 = performance.now();
      let out: Out;
      try { out = await fn(args); }
      catch (e) { out = { outcome: 'rejected', code: 'INTERNAL', message: (e as Error).message }; }
      const a = args as Record<string, unknown>;
      await svc.logActivity({
        runId: (a.runId as string) ?? ((out.run as { id?: string } | null)?.id ?? null), tool: name, correlationId: (a.commandId as string) ?? null,
        status: statusOf(name, out), summary: summaryOf(name, out), input: args,
        trace: name === 'evaluate_rescue' ? (out.trace ?? null) : null, durationMs: Math.round(performance.now() - t0),
      }).catch((e: Error) => console.error(`activity: ${e.name}: ${e.message}`.slice(0, 300)));   // the tool's result stands
      const text = out.speech?.text ?? out.message ?? summaryOf(name, out);
      return { content: [{ type: 'text' as const, text }], structuredContent: out };
    }) as never);

  tool('list_recipes', 'List saved recipes with whether each can be started and which recoveries are on file.', {}, () => svc.listRecipes() as unknown as Promise<Out>);
  tool('start_recipe', 'Start cooking a recipe. Refuses if another session is active unless `replace` names it exactly and confirms ending it.', {
    ...command, recipeId: id, recipeVersionId: id.optional(),
    replace: z.object({ runId: id, epoch: z.number().int(), expectedRevision: z.number().int(), confirm: z.literal(true) }).optional(),
  }, (a) => svc.startRecipe(a) as unknown as Promise<Out>);
  tool('get_active_recipe', 'Read the active cooking session. With commandId (and the evaluationId it applied), also reports whether that command applied (read-only reconciliation).', {
    runId: id.optional(), commandId: id.optional(), evaluationId: id.optional(),
  }, (a) => svc.getActiveRecipe(a) as unknown as Promise<Out>);
  tool('record_progress', 'Report progress on a step: started, partly (with the ingredient uses added) or done. Forward-only.', {
    ...command, ...runScope, expectedRevision: z.number().int(), stepId: id, progress: z.enum(['started', 'partly', 'done']),
    addedUseIds: z.array(id).optional(), partialUseIds: z.array(id).optional(),
  }, (a) => svc.recordProgress(a) as unknown as Promise<Out>);
  // structured ids skip the server's language-model reading of the words (latency audit 2026-10-11)
  tool('evaluate_rescue', 'Check what to do about a missing ingredient. Never changes the recipe; availability answers never apply anything. '
    + 'Fastest: pass missingIngredientId (an id from get_active_recipe recipe.ingredients) and, if the cook named a replacement, proposedKindIds. '
    + 'utterance.text without missingIngredientId is read by a language model on the server first, which is slower.', {
    ...command, ...runScope, expectedRevision: z.number().int(),
    utterance: z.object({ text: z.string().max(500), channel: z.enum(['voice', 'typed', 'tapped']) }).optional(),
    missingIngredientId: id.optional().describe('The missing ingredient: an id from get_active_recipe recipe.ingredients[].id.'),
    proposedKindIds: z.array(id).optional().describe("What the cook wants to use instead: reviewed ingredient kind ids from the recipe's vocabulary (for example whole-milk)."),
    answers: z.array(z.object({ questionId: id, value: z.enum(['yes', 'no']) })).optional(),
    previousEvaluationId: id.optional(),
  }, (a) => svc.evaluateRescue(a) as unknown as Promise<Out>);
  tool('apply_amendment', 'Apply the displayed change after the cook explicitly accepts it. Never marks a step done.', {
    ...command, ...runScope, expectedRevision: z.number().int(), evaluationId: id, candidateId: id, planId: id, accepted: z.literal(true),
  }, (a) => svc.applyAmendment(a) as unknown as Promise<Out>);
  tool('import_recipe', 'Import a recipe as an unsaved draft, the same way the companion does: pasted text, or the sourceDocId an earlier upload to POST /uploads returned (no paths or URLs). '
    + 'Returns as soon as the import is accepted (outcome importing, with job.id); the reading continues in the background. Call again with the same commandId and source for its current state: '
    + 'importing, imported (with the draft) or failed (with the reason); that never starts a second reading. Never saves, reviews or releases; the cook reviews and saves the draft in the companion.', {
    ...command,
    source: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('text'), text: z.string().min(1).max(100_000), title: z.string().max(200).optional() }),
      z.object({ kind: z.literal('upload'), sourceDocId: id }),
    ]),
  }, (a) => svc.importRecipe(a, authoring) as unknown as Promise<Out>);
  tool('delete_recipe', 'Archive a recipe from the Recipe Book (it is not erased): cooking history, receipts, saved versions and source files are kept. Needs the exact recipeId, its current recipeVersionId from list_recipes and confirm: true. Refused while that recipe is being cooked.', {
    ...command, recipeId: id, recipeVersionId: id, confirm: z.literal(true),
  }, (a) => svc.archiveRecipe(a) as unknown as Promise<Out>);
  return server;
}
