import type { Config } from './config.ts';
import type { Action } from './actions.ts';

export interface Decision { mode: 'apply' | 'ask'; reason: string }

/**
 * Lean toward just adding things; ask before anything that changes or removes existing work on a guess,
 * and always ask about money, other people's deadlines, or anything that would reach out to someone.
 */
export function decide(a: Action, cfg: Pick<Config, 'autoApplyMinConfidence'>, autoOk = false): Decision {
  if (a.op === 'connector_call') {   // writes to outside services: ask, unless the owner pre-allowed this exact action AND the request came from the owner themself
    const risky = a.flags.filter((f) => f !== 'uncertain');
    if (risky.length) return { mode: 'ask', reason: `involves ${risky.join(', ').replace('_', ' ')}` };
    return autoOk && a.confidence >= cfg.autoApplyMinConfidence ? { mode: 'apply', reason: 'you allowed this action without asking' } : { mode: 'ask', reason: 'writes to an outside service' };
  }
  const risky = a.flags.filter((f) => f !== 'uncertain');
  if (risky.length) return { mode: 'ask', reason: `involves ${risky.join(', ').replace('_', ' ')}` };
  if (a.op === 'drop') return { mode: 'ask', reason: 'dropping an item is never automatic' };
  if (a.op === 'create') return { mode: 'apply', reason: 'new item' };
  if (a.flags.includes('uncertain')) return { mode: 'ask', reason: 'model was unsure which item this affects' };
  if (a.confidence < cfg.autoApplyMinConfidence) return { mode: 'ask', reason: `low confidence (${a.confidence.toFixed(2)})` };
  return { mode: 'apply', reason: 'confident match' };
}
