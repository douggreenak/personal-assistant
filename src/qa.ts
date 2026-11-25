import type { Ctx } from './ctx.ts';
import { ftsQuery } from './db.ts';
import { ANSWER_SCHEMA, ANSWER_SYSTEM } from './prompts.ts';

export interface Hit { kind: string; ref: string; title: string; snippet: string }

export function search(ctx: Ctx, question: string, limit = 8): Hit[] {
  const q = ftsQuery(question);
  if (!q) return [];
  const rows = ctx.db.prepare(`SELECT kind, ref, title, snippet(search, 3, '[', ']', ' … ', 40) AS snip, body
    FROM search WHERE search MATCH ? ORDER BY bm25(search, 0, 0, 3, 1) LIMIT ?`).all(q, limit) as { kind: string; ref: string; title: string; snip: string; body: string }[];
  return rows.map((r) => ({ kind: r.kind, ref: r.ref, title: r.title, snippet: r.body.slice(0, 700) }));
}

const label = (h: Hit): string => (h.kind === 'doc' ? `file ${h.title}` : h.kind === 'message' ? `message ${h.title}` : `open item`);

/** Answers from the owner's own indexed messages, files and items, with citations. */
export async function ask(ctx: Ctx, question: string): Promise<string> {
  const hits = search(ctx, question);
  if (!hits.length) return "I couldn't find anything about that in your messages, files or open items.";
  const ctxText = hits.map((h, i) => `[${i + 1}] (${label(h)})\n${h.snippet}`).join('\n\n');
  const out = await ctx.llm.json({
    system: ANSWER_SYSTEM, prompt: `Question: ${question}\n\nContext snippets:\n<snippets>\n${ctxText}\n</snippets>`,
    schema: ANSWER_SCHEMA as unknown as Record<string, unknown>,
  }) as { answer?: string; cited?: number[] };
  const cited = [...new Set((out.cited ?? []).filter((n) => Number.isInteger(n) && n >= 1 && n <= hits.length))];
  const src = cited.map((n) => `[${n}] ${label(hits[n - 1])}${hits[n - 1].kind === 'doc' ? '' : ''}`).join('; ');
  return `${String(out.answer ?? '').trim() || "I'm not sure."}${src ? `\n\nSources: ${src}` : ''}`;
}
