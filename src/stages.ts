import type { Stage } from './backends/ticketing.ts';
/** Used in prompts when the Ticketing app is unreachable; mirrors its default "IT ticket" pipeline. */
export const DEFAULT_STAGES: Stage[] = [
  { id: 'reported', label: 'Reported' }, { id: 'diagnosing', label: 'Diagnosing' }, { id: 'waiting_on_parts', label: 'Waiting on parts' },
  { id: 'fix_applied', label: 'Fix applied' }, { id: 'verified', label: 'Verified' }, { id: 'closed', label: 'Closed' },
];
