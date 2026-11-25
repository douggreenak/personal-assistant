# iPhone & Apple Watch capture

Record by voice anywhere — even with no signal — and it uploads when your server is reachable. The apps are deliberately tiny: a record button and a "N waiting to send" counter.

> The source files in `ios/` type-check against the iOS 27 and watchOS 27 SDKs but are **not packaged as an Xcode project** — you create the project (5 minutes, below) with your own signing team.

## How it works
- **Record first, send later.** Recordings are AAC, 16 kHz mono (~240 KB/minute), written to `Application Support/queue/<id>.m4a` with a small `<id>.json`. The file is safe on disk before any network is involved.
- **Durable upload queue.** A *background* `URLSession` (`waitsForConnectivity`) uploads each file to `POST /ingest/voice` with headers `X-Capture-Id`, `X-Recorded-At`, `X-Filename`. iOS keeps uploading when the app is closed and relaunches it to finish. The queue is also re-kicked when connectivity returns, at launch, and every 60 s while open.
- **Safe retries.** Files are deleted **only after the server answers 200**. The id is generated on the phone and the server de-duplicates on it (and never re-transcribes a known id), so a half-finished or repeated upload can't create duplicates. If the speech server is down the assistant answers 503 and the phone simply keeps the file.
- **Apple Watch.** The watch can't reach your tailnet on its own, so it records locally and hands the file to the iPhone with `WCSession.transferFile` — the system queues it and delivers whenever the phone is in reach (works fully offline). The phone then uploads it exactly like its own recordings.
- **Server side.** Audio → local Whisper → transcript → the normal pipeline (same as typing it).

## Build it
1. Xcode → **New Project → iOS App** (SwiftUI), name `AssistantCapture`. Delete the generated `ContentView.swift`/app file and add everything in `ios/AssistantCapture/`.
2. **File → New → Target → Watch App** (watchOS, "Watch App for Existing iOS App"), name `AssistantCaptureWatch`; replace its app file with `ios/AssistantCaptureWatch/WatchCaptureApp.swift`.
3. For both targets: pick your signing team, and add the Info key `NSMicrophoneUsageDescription` ("Records your voice notes"). No special capabilities are needed — recording happens with the app open, and background uploads work without one.
4. Install on your devices. (A free Apple ID works but re-signing is needed every 7 days; a paid developer account avoids that.)
5. Install **Tailscale** on the iPhone and stay signed in.
6. Open the app → **Settings** → server address (`http://<server-tailnet-name>:8090`) and the `INGEST_TOKEN` (send-input-only). The token is stored in the iOS Keychain (this device only).

## Using it
Tap the mic, talk, tap stop. The footer shows **Everything sent** or **N waiting to send**. On the watch, tap the mic to record; it says "Saved — will reach your phone". The assistant then posts what it understood in Google Chat.

## Files
| File | Role |
|---|---|
| `CaptureApp.swift` | app entry; hands the system's background-upload completion handler to the queue |
| `Recorder.swift` | AVAudioRecorder → file → enqueue (ignores accidental taps under ~2 KB) |
| `UploadQueue.swift` | on-disk queue, background uploads, retry, cleanup |
| `PhoneLink.swift` | receives files from the watch |
| `Settings.swift` | server URL (UserDefaults) and token (Keychain) |
| `ContentView.swift` | the UI and settings sheet |
| `../AssistantCaptureWatch/WatchCaptureApp.swift` | watch recorder + transfer |

## Troubleshooting
| Symptom | Fix |
|---|---|
| stuck at "waiting to send" | Tailscale isn't connected on the phone, wrong URL/token in Settings, or the server is down. It will keep retrying. |
| "Server said 401" | token mismatch. |
| "Server said 503" | the speech server isn't up yet (first model download) — it retries automatically. |
| watch recording never reaches the phone | the phone app must have been opened at least once to activate WatchConnectivity; keep the phone nearby. |
