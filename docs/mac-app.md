# Mac app

A native menu-bar app that connects your Mac — and through iCloud, your iPhone and Apple Watch — to the assistant. It replaces the [Mac agent](mac-agent.md) script and adds Calendar, Reminders, Contacts and Shortcuts.

| Apple product | What the app does | Needs |
|---|---|---|
| **Messages** | Sends new texts and iMessages to the assistant (same rules as the agent: nothing from before you first ran it, one-time codes dropped, texts you send are treated as your own notes) | Full Disk Access |
| **Contacts** | Shows "Sam Rivera (+1907…)" instead of a bare number, so the assistant knows who is who. Names stay on your Mac except in the sender field | Contacts permission |
| **Calendar** | Sends events for the next 14 days (once per edit), so it can remind you about prep, conflicts and travel | Calendar permission |
| **Reminders** | *Inbox:* anything you add to the **Assistant Inbox** list is sent to the assistant and checked off. *Mirror:* the assistant's open reminders and tasks appear in the **Assistant** list with due times and alerts — on your iPhone and Watch too. Check one off in Reminders and it is completed in the assistant (and vice versa) | Reminders permission; mirror needs the full token |
| **Shortcuts / Siri / Spotlight** | **Capture to Assistant** and **Ask Assistant** actions — use them in any automation, or say "Ask Assistant" | — |
| **Menu bar** | Quick-capture box, live status of every source, update notice | — |

Every source except Messages is **off until you switch it on** (Settings → Sources), and macOS asks for each permission when you do.

## Install
1. Open the assistant's web UI → **System → Mac app → Download**. (The button asks GitHub for the newest release through your server; it works with any browser that can reach the UI.)
2. Unzip, drag **Assistant.app** to **Applications**.
3. The app is signed ad-hoc, not notarized by Apple, so the first time: **right-click → Open → Open** (or run `xattr -dr com.apple.quarantine /Applications/Assistant.app`).
4. In the web UI open **System → Mac app → Copy config**, then in the app click the menu-bar icon → **Paste config from clipboard** (or Settings → Connection → **Paste config**). That fills in the server address and token and tests the connection. Tailscale must be running on the Mac. (Manual entry still works: Settings → Connection → address and token → **Save & test**.)
5. **Messages:** System Settings → Privacy & Security → **Full Disk Access** → add **Assistant** (the menu shows a shortcut button), then it syncs within a minute.
6. Turn on Calendar / Reminders / Contacts in **Settings → Sources** as you like. Optionally switch on **Open at login**.

Requires macOS 14 (Sonoma) or newer; runs natively on Apple silicon and Intel.

### Which token?
| Token | Works for |
|---|---|
| `INGEST_TOKEN` (send-only, recommended for an always-on Mac) | Messages, Calendar, Reminders inbox, Capture, Shortcut "Capture" |
| `ASSISTANT_TOKEN` (full) | everything above **plus** the Reminders mirror, "Ask Assistant", and update notices |

The token is stored in the macOS Keychain. Rebuilt/updated copies of the app are signed ad-hoc, so macOS may ask once to allow Keychain access again — choose **Always Allow**.

### Replacing the old agent
Run it on only one: `launchctl unload ~/Library/LaunchAgents/com.assistant.agent.plist && rm ~/Library/LaunchAgents/com.assistant.agent.plist`. (If both run, nothing is duplicated — messages are stored once by their id — but the work is.)

### The config
**Copy config** puts `assistant-config:` + base64 of `{"v":1,"url":"<the address you opened the web UI at>","token":"<the token you're signed in with>"}` on the clipboard. That is the full `ASSISTANT_TOKEN`, so paste it only into your own Mac and don't share it. Open the web UI at the address the Mac can reach (the Tailscale name), since that is the address it copies.

## Connected Macs and updates
Each app checks in with the server once a minute (`POST /app/mac/heartbeat`, works with either token) with a per-Mac id, its name, macOS and app version. **System → Mac app → Connected Macs** lists them: online or last seen, version, and **update available** when the newest release is newer. Press **Update** on one Mac (or **Update all**) and the request is handed to that app on its next check-in. **Forget** removes a Mac that is offline.

The app updates itself: it downloads the newest zip through your server, unpacks it, checks it is the Assistant app with a valid signature, quits, swaps the bundle in its current location and reopens. The old copy is only removed once the new one is in place. The same is available from the menu (**update now**) and Settings → About. Settings and permissions are kept. If it can't (app running from a quarantined Downloads folder, or an install location your user can't write to) it says why, and the web UI shows the error. Move the app to Applications once and open it from there.

macOS may ask once to allow Keychain access again after an update (the build is ad-hoc signed); choose **Always Allow**. An update started from the web UI on an unattended Mac waits at that prompt.

## Publishing a release (maintainers)
Releases are built by GitHub Actions ([`.github/workflows/mac-app.yml`](../.github/workflows/mac-app.yml)) on a macOS runner:
```bash
git tag mac-v1.0.0 && git push origin mac-v1.0.0     # builds the universal app and publishes release "mac-v1.0.0" with Assistant-Mac.zip
```
The server picks the newest non-draft, non-prerelease release whose tag starts with `mac-v` and has an `Assistant-Mac*.zip` asset (looked up at most every 10 minutes). Set `GITHUB_REPO` (default `douggreenak/personal-assistant`) if you fork, and `GITHUB_TOKEN` if the repository is private. Build locally with `./mac-app/build.sh 1.0.0` → `mac-app/dist/Assistant-Mac.zip`.

## How it works
- **Sync loop:** one timer, every 60 s. Order: connection check → Messages → Calendar → Reminders. A failure in one source never stops the others; the menu and Settings show each source's last result.
- **Messages:** read-only SQLite on `~/Library/Messages/chat.db`, the same query and wire format as the agent (`POST /ingest/mac`, decoding on the server). The saved row id advances only after the server confirms, so nothing is lost or repeated.
- **Calendar / Reminders / Capture** go through `POST /ingest/message` with sources `calendar`, `reminders` and `mac-app` (see [API](api.md)); the server de-duplicates on the id the app sends. Reminders-inbox and Capture items are sent as `sender: "me"` — your own words, so "call Sam Friday" becomes a task, not something to reply to.
- **Mirror:** `GET /items` + `POST /items/{id}/complete`. A map of item-to-reminder is kept in `~/Library/Application Support/Assistant/`. Delete a mirrored reminder in Reminders and it stays gone (the item itself is unaffected). Tickets are not mirrored.
- **Privacy:** the app talks only to your server. It contains no analytics and never sends anything on its own — it never replies to or contacts anyone.

## Source layout (`mac-app/`)
| File | Role |
|---|---|
| `project.yml` | XcodeGen project definition (`xcodegen generate` makes `Assistant.xcodeproj`) |
| `Assistant/AssistantApp.swift` | menu-bar scene, status glyph |
| `Assistant/SyncEngine.swift` | timer, per-source status, update check, launch at login |
| `Assistant/MessagesSync.swift` · `ContactsResolver.swift` · `CalendarSync.swift` · `RemindersSync.swift` | the Apple integrations |
| `Assistant/Server.swift` · `Prefs.swift` | API client; settings and Keychain |
| `Assistant/Views.swift` · `Intents.swift` | UI; Shortcuts/Siri actions |
| `build.sh` · `tools/make-icon.swift` | packaging; icon generator |

## Troubleshooting
| Symptom | Fix |
|---|---|
| Messages says "Needs Full Disk Access" | add **Assistant** (not `/bin/bash`) under Full Disk Access, then **Sync now** |
| "Can't reach the server" | Tailscale off, wrong address, or the server is down |
| "Server rejected the token" | use `INGEST_TOKEN` or `ASSISTANT_TOKEN` exactly as in `.env` |
| "needs the full ASSISTANT_TOKEN" | that feature (mirror / ask / updates) isn't allowed for the send-only token |
| Download button says "No Mac app has been released yet" | push a `mac-v*` tag (above); wait for the workflow to finish; press **Check again** |
| "No access to … (private repo?)" | set `GITHUB_TOKEN` (read access to the repo) in Settings → Mac app |
| macOS says the app "is damaged" or "can't be opened" | right-click → Open, or `xattr -dr com.apple.quarantine /Applications/Assistant.app` |
