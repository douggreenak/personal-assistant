# Web UI

Open `http://<BIND_ADDR>:8090/` and sign in with `WEB_PASSWORD` (change it any time under **Settings → Security**; the changed password is stored hashed in `data/web-password.json`). If `WEB_PASSWORD` is unset you can sign in with `ASSISTANT_TOKEN` instead.

Built in Material 3 Expressive: a palette generated from one seed color (change it under **Settings → Appearance**), large rounded shapes that morph on hover/press, spring motion and heavy display type.

| Page | What you manage |
|---|---|
| Home | what needs attention, coming up, recent activity, quick capture |
| Items | create / edit / complete / drop / snooze / acknowledge tickets, reminders and tasks; set ticket stages; history |
| Settings → Backup | a nightly automatic backup kept on the server (list, download, “Back up now”); download one file with everything (optionally without keys/passwords) and restore from such a file; a safety copy of the current data is saved before every restore |
| Chat | the same assistant as Google Chat — capture, commands, questions. Messages and replies are Markdown (headings, lists, tables, code, links); attach, paste or drag in up to 5 pictures and the assistant reads them (screenshots, receipts, photos). The Home “Tell the assistant” box does the same |
| Inbox | every message received and what happened to it; retry, skip, add one by hand |
| Approvals | approve or reject what the assistant asked about (history too) |
| Connectors | propose, approve, set credentials, dry-run, enable, disable, delete |
| System | version, integration health, **Mac app download** (newest GitHub release), message sources, logs, re-index files, restart |
| Settings | every setting that used to live in `.env` (saved to `data/settings.json`; applied on restart), Google service-account upload |

Search (top bar) runs the keyword search over messages, items and files.

## Developing the UI
The built UI is committed in `src/web/assets/`, so the server still has no runtime dependencies. Sources are in `web-src/`:
```bash
cd web-src && npm install && npm run build   # writes ../src/web/assets, then rebuild the image: docker compose up -d --build
```
It uses [Material Web](https://github.com/material-components/material-web) components, `@material/material-color-utilities` for the palette, Roboto Flex and Material Symbols (inlined as SVG).

## Keyboard shortcuts
Press `?` in the UI for the live list.

| Keys | Action |
|---|---|
| `/` | jump to the text box on the current page (Home: quick capture, Items/Inbox: filter, Chat: message, Settings: filter, System: log filter); opens search where there is none |
| `Ctrl/Cmd K` | search everything, even from inside a text box |
| `g` then `h` `i` `c` `b` `a` `o` `y` `s` | Home, Items, Chat, Inbox, Approvals, Connectors, System, Settings |
| `1`–`8` | the same pages by position |
| `n` | new item / inbox message / connector (depending on the page) |
| `j` `k` | select next / previous row; `Esc` clears |
| `Enter` `e` `h` | open / edit / history of the selected item |
| `x` | done (item), approve (approval), skip (message) |
| `s` | snooze the selected reminder 2 hours |
| `Delete` | drop (item, with confirmation), reject (approval) |
| `Shift R` | process the selected message again |
| `r` `t` | refresh, toggle light/dark |
| `Ctrl/Cmd Enter` | submit a dialog or the quick-capture box |
| `Esc` | leave a text box, close a dialog |

Shortcuts are ignored while you are typing in a field or a dialog is open (except `Ctrl K` and `Esc`).

## Connectors: paste, connect, done
**Add** opens one box: paste whatever the service gave you — docs, a curl example, the key, all mixed together (or a docs link). Keys are found in the paste, stored on the server and replaced with a placeholder before the model sees anything; it works out the login style (bearer, header, basic, or `?api_key=` in the URL) from the docs. **Connect** designs the connector, tests it against the real service, fixes what goes wrong using the service's actual response, and switches it on — you watch the steps live. If no key was given and one is needed, it asks right there. On failure the half-built connector is removed and the dialog keeps your text for another try. The old approve → set key → test → enable path still exists for connectors proposed from chat.

## Other behaviour worth knowing
Dialogs no longer close when you click outside them (Esc and Close still do). Items has sort, Overdue/Today/Next 7 days filters, quick-add, CSV/JSON export, and remembers your view. `Ctrl K` is also a command palette. Leaving Settings with unsaved changes asks first; a banner shows when the server is unreachable.

## MCP servers
Paste a remote MCP server's URL, its `mcpServers` JSON, or the `claude mcp add --transport http …` line (key included) into the same box. No model is involved: the assistant connects over Streamable HTTP, lists the server's tools and saves them as actions (up to 40, read-only tools first). Bearer tokens, a named header (`X-Api-Key`) or a `?key=` in the URL are supported; servers that only offer OAuth sign-in, or that need a local process (`npx …`/stdio), cannot be used and the wizard says so. Tools marked read-only ask first; tools not marked read-only (and not explicitly non-destructive) are treated like deletes — they always ask and have no "no need to ask" switch. As with other write connectors, tools are only offered for your own messages (Chat/voice), never for outside senders. A bare URL that is not an MCP server is read as API docs instead.

## Read and write connectors
A connector can read (polled into the inbox), write (create an invoice, close a ticket…), or both. Writes you ask for in Chat or by voice show up in **Approvals** first. On a connector's card, open *Can do N write actions* and flip **no need to ask** for the ones you trust; deletes always ask, and anything that came from someone else's message can never trigger a write.

### Live lookups

Besides the scheduled read (saved so search works), a connector can have **lookups**: extra read-only GET endpoints (for MCP servers, tools marked read-only). When you ask a question in Chat, Home or Google Chat, the assistant first picks the lookups the question needs (e.g. “what's due this week” → the service's *upcoming* endpoint with today's date), reads them **right now**, and answers from that fresh data plus what it has stored; the answer ends with `Sources: … Live: <service › lookup>`. Lookups never change anything and need no approval; results are treated as untrusted data. A connector without explicit lookups still gets one: its regular feed, fetched live. In a feed's query, `{today}`, `{today-14}` and `{today+30}` become dates, so the feed covers a recent window.
