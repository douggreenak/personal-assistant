# Development

Node **24+** (built-in SQLite, native TypeScript). No build step, no runtime dependencies.
```bash
npm install            # dev only: typescript + @types/node
npm test               # node:test — 25 tests, in-memory SQLite, no network, no model
npm run typecheck      # tsc --noEmit
npm start              # needs ASSISTANT_TOKEN (see docs/configuration.md)
```
Rules of the TypeScript dialect (Node strips types, it doesn't compile them): import with the `.ts` extension, no `enum`, no constructor parameter properties (`constructor(private x)`), no `namespace`. `tsconfig` enforces this with `erasableSyntaxOnly`.

## How tests work
`test/helpers.ts → makeCtx()` builds a full context in memory with:
- `FakeLlm` — returns scripted JSON or computes it from the prompt, so the pipeline is tested without a model;
- fake Ticketing and Canopy servers implemented as `fetch` stubs;
- a `MemoryNotifier` that records what would have been sent;
- an injectable clock (`ctx.now`) for nagging, quiet hours and backoff.

`test/pipeline.test.ts` covers extraction → policy → approvals → backends and concurrency; `test/rest.test.ts` covers nagging, time zones, Mac decoding, Gmail/Chat parsing, JWT signing, connectors (incl. SSRF), Canopy sync, search/Q&A, commands and the HTTP layer.

To see real model behaviour, run the app against a local Ticketing instance and `POST /chat` (see [Getting started](getting-started.md#4-try-it)).

## Adding a source
A source only has to produce messages:
```ts
import { storeMessage } from './pipeline.ts';
storeMessage(ctx, { source: 'mything', sourceId: uniqueIdFromTheSource, sender, subject, body, receivedAt });
```
Idempotency is handled for you (`source` + `sourceId`). Then run it on a timer in `src/main.ts` with `every('mything', ms, () => poll(ctx))`. Set `sender: 'me'` for things you wrote. For a quick one without code, use a [connector](connectors.md) or `POST /ingest/message`.

## Adding an action or a field
1. `src/actions.ts`: extend `Action`, `ACTIONS_SCHEMA`, `parseActions` (validate!), `applyAction` and `describeAction`.
2. `src/policy.ts`: decide when it needs approval.
3. `src/prompts.ts`: teach the model when to use it.
4. Add a test in `test/pipeline.test.ts` using `FakeLlm`.

## Adding a backend
Mirror `src/backends/ticketing.ts` (a small `fetch` client taking an injectable `fetchImpl`), add it to `Ctx`, wire it in `main.ts`, and branch on `item.backend` inside `applyAction`.

## Conventions
- Anything that comes from outside (messages, model output, documents, HTTP bodies) is validated at the boundary; nothing from the model is trusted.
- Side effects go through `applyAction`, never directly from the model's output.
- Keep secrets out of logs and out of prompts.
- Update the docs when behaviour changes; the [configuration reference](configuration.md) and [API](api.md) are the contract.

## Web UI tests
- `npm test` includes `test/webui.test.ts`: static serving, password login, settings, inbox, items, connectors, admin endpoints (no model calls).
- `npm run e2e` drives the real UI in Chromium against a throwaway assistant (temp data dir; the model binary is stubbed out). Needs `cd web-src && npm install` and a Chromium, e.g. `CHROMIUM=/usr/bin/chromium npm run e2e`.

## Running the tests fast
`npm run test:all` runs the unit tests (one process per file, all cores) and the browser test (three parts, each with its own throwaway server and browser) at the same time — under a minute instead of two and a half. `npm test` is unit tests only; `npm run e2e` is the parallel browser test; `npm run e2e:serial` runs it in one piece (`E2E_GROUP=a|b|c` runs one part).

`npm run test:layout` is the screen-size test (about 3 minutes, so it is not part of `test:all`): it opens every page, dialog and menu in a real browser at 12 screen sizes (320 px phones to 2560 px desktops, plus a landscape phone) in light and dark, scrolled and not, and measures where things actually are — sideways scrolling, controls hidden under the top or bottom bar, dialogs taller than the screen, a chat box you cannot reach, a stuck page after a dialog closes. Run it after any CSS or layout change. `LAYOUT_WORKERS=n` sets how many run at once.
