# Web UI

Open `http://<BIND_ADDR>:8090/` and sign in with `WEB_PASSWORD` (change it any time under **Settings → Security**; the changed password is stored hashed in `data/web-password.json`). If `WEB_PASSWORD` is unset you can sign in with `ASSISTANT_TOKEN` instead.

Built in Material 3 Expressive: a palette generated from one seed color (change it under **Settings → Appearance**), large rounded shapes that morph on hover/press, spring motion and heavy display type.

| Page | What you manage |
|---|---|
| Home | what needs attention, coming up, recent activity, quick capture |
| Items | create / edit / complete / drop / snooze / acknowledge tickets, reminders and tasks; set ticket stages; history |
| Chat | the same assistant as Google Chat — capture, commands, questions |
| Inbox | every message received and what happened to it; retry, skip, add one by hand |
| Approvals | approve or reject what the assistant asked about (history too) |
| Connectors | propose, approve, set credentials, dry-run, enable, disable, delete |
| System | version, integration health, message sources, logs, re-index files, restart |
| Settings | every setting that used to live in `.env` (saved to `data/settings.json`; applied on restart), Google service-account upload |

Search (top bar) runs the keyword search over messages, items and files.

## Developing the UI
The built UI is committed in `src/web/assets/`, so the server still has no runtime dependencies. Sources are in `web-src/`:
```bash
cd web-src && npm install && npm run build   # writes ../src/web/assets, then rebuild the image: docker compose up -d --build
```
It uses [Material Web](https://github.com/material-components/material-web) components, `@material/material-color-utilities` for the palette, Roboto Flex and Material Symbols (inlined as SVG).
