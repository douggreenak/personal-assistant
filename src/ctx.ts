import type { Config } from './config.ts';
import type { Db } from './db.ts';
import type { Llm } from './llm.ts';
import type { ItemStore } from './items.ts';
import type { Notifier } from './notify.ts';
import type { LocalTicketing } from './tickets/local.ts';
import type { CanopyClient } from './backends/canopy.ts';

export interface Ctx {
  cfg: Config; db: Db; llm: Llm; items: ItemStore; notify: Notifier;
  ticketing?: LocalTicketing; canopy?: CanopyClient;
  now: () => Date;
}
