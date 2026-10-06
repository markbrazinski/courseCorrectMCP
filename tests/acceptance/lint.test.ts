// No hero branch: no content identifier appears as a string literal in source (ESOD §9.5).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT, content } from '../helpers.ts';

const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(p) ? [p] : [];
});

describe('ID-literal lint', () => {
  // Library code only. src/walkthrough.ts is a demo script that must name its fixtures.
  it('engine, compiler, service, domain, contract, authoring and companion code contain no content id literal', () => {
    const ids = new Set<string>();
    for (const p of content.packs.values()) {
      ids.add(p.recipe.recipeId);
      p.recipe.steps.forEach((s) => ids.add(s.stepId));
      p.recipe.uses.forEach((u) => ids.add(u.useId));
      p.recipe.ingredients.forEach((i) => ids.add(i.ingredientId));
    }
    content.patterns.forEach((p) => ids.add(p.patternId));
    const v = content.vocab;
    [...v.kinds.map((k) => k.kindId), ...v.classes.map((c) => c.classId), ...v.functions.map((f) => f.functionId), ...v.techniques.map((t) => t.techniqueId)].forEach((x) => ids.add(x));
    const hits: string[] = [];
    for (const f of ['contract', 'domain', 'compile', 'engine', 'service', 'authoring', 'web'].flatMap((d) => files(join(ROOT, 'src', d)))) {
      const text = readFileSync(f, 'utf8');
      for (const id of ids) if (new RegExp(`['"\`]${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`).test(text)) hits.push(`${f.slice(ROOT.length)}: ${id}`);
    }
    expect(hits).toEqual([]);
  });
});
