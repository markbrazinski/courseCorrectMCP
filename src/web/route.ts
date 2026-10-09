// Client navigation router (FE contract §6.2). Pure: no DOM, so it is unit-tested.
// Only navigation and explicit control phrases. Everything else is a free-text rescue request for the server.
export type Routed =
  | { kind: 'done' } | { kind: 'started' } | { kind: 'whatsNext' } | { kind: 'read' } | { kind: 'ingredients' }
  | { kind: 'startTimer' } | { kind: 'stopTimer' } | { kind: 'accept' } | { kind: 'yes' } | { kind: 'no' } | { kind: 'checkStatus' } | { kind: 'stepPreview'; n: number }
  | { kind: 'rescue'; text: string };
const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
/** A spoken or typed reply to an open yes/no question ("yes I have that", "no, not enough"). Negations win. */
export function answerOf(raw: string): 'yes' | 'no' | null {
  const t = raw.toLowerCase().replace(/[’']/g, "'").replace(/[.!?,]/g, ' ').replace(/\s+/g, ' ').trim();
  if (/^(no|nope|nah)\b/.test(t) || /\b(don't|do not|haven't|have not|not enough|none|ran out|out of)\b/.test(t)) return 'no';
  if (/^(yes|yeah|yep|yup|sure|ok|okay|i do|i have|i've got|got (it|them|both|that))\b/.test(t) || /\bi (have|do|got|'ve got) (it|them|that|those|both|everything|all)\b/.test(t)) return 'yes';
  return null;
}

/** "yes to both", "I have everything": the reply covers every open question, not just the first. */
export const answersAll = (raw: string) => /\b(both|all|everything|all of (it|them))\b/i.test(raw);

export function route(raw: string): Routed {
  const t = raw.toLowerCase().replace(/[’']/g, "'").replace(/[.!?,]+$/g, '').replace(/^(hey,? )?course ?correct[, ]*/, '').trim();
  if (/^(next step|i'm done|i am done|done|finished|move on)$/.test(t)) return { kind: 'done' };
  // natural phrasings ("I'm done with this, next one please"): a progress cue, and nothing missing, swapped or asked
  if (/\b(next (step|one)|i'm done|i am done|all done|done with|move on|moving on|finished|on to the next)\b/.test(t)
    && !/\b(not|\w+n't|yet|almost|out of|ran out|run out|missing|no more|instead|substitute|replace|use|what|which|how|when|read|repeat|show)\b/.test(t)) return { kind: 'done' };
  if (/^(i've started|i have started|started|starting)$/.test(t)) return { kind: 'started' };
  // the step timer is client-local and never reports progress (FE I-16)
  if (/\btimer\b/.test(t) && !/\b(don't have|out of|ran out|missing|instead|use)\b/.test(t)) {
    if (/\b(stop|cancel|turn off|end|kill)\b/.test(t)) return { kind: 'stopTimer' };
    return { kind: 'startTimer' };   // "create the timer for me", "timer please": any other timer mention starts it
  }
  if (/^what'?s next$/.test(t)) return { kind: 'whatsNext' };
  if (/^(read( it)?( again)?|repeat( that)?|again|say (it|that) again)$/.test(t)) return { kind: 'read' };
  if (/^what do i need$/.test(t)) return { kind: 'ingredients' };
  // explicit acceptance only: a "use/apply/accept this change" phrase, never with a negation, never a bare yes
  // speech recognition often hears the short command a little off ("used this change", "use this chain", "use the changes")
  if (/\b(use[sd]?|using|apply|accept|take) (?:(this|the|that|these) )?(change|changes|chain)\b/.test(t) && !/\b(not|\w+n't|never|no)\b/.test(t)) return { kind: 'accept' };
  if (/^(yes|yeah|yep|yes please|ok|okay|sure|i do|i have them|i have it)$/.test(t)) return { kind: 'yes' };   // FE §6.2: never an acceptance
  if (/^(no|nope|i don't|not enough)$/.test(t)) return { kind: 'no' };
  if (/^check (the )?status$/.test(t)) return { kind: 'checkStatus' };
  const step = /^(?:show |go to )?step (\d+|\w+)$/.exec(t);
  if (step && (Number(step[1]) || WORDS[step[1]])) return { kind: 'stepPreview', n: Number(step[1]) || WORDS[step[1]] };
  return { kind: 'rescue', text: raw.trim() };
}
