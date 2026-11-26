import Foundation
import AppKit

/// Replaces this app with the newest release without you touching Finder:
/// download through your server → unpack → check it's really this app, signed → quit → a small script swaps the bundle and reopens it.
enum Updater {
    struct Failure: LocalizedError { let errorDescription: String?; init(_ m: String) { errorDescription = m } }

    private static var workDir: URL { Prefs.supportDir.appendingPathComponent("Update", isDirectory: true) }
    private static var failureFile: URL { workDir.appendingPathComponent("failure.txt") }

    /// If the swap script couldn't finish last time, it left a note; pick it up so the server can show why.
    static func collectFailure() {
        guard let msg = try? String(contentsOf: failureFile, encoding: .utf8), !msg.isEmpty else { return }
        Prefs.updateError = msg.trimmingCharacters(in: .whitespacesAndNewlines); Prefs.lastUpdateFrom = nil
        try? FileManager.default.removeItem(at: workDir)
    }

    @MainActor static func install(server: Server) async throws {
        let app = Bundle.main.bundleURL, fm = FileManager.default
        if app.path.contains("/AppTranslocation/") { throw Failure("Move Assistant.app into Applications (and open it from there) so it can update itself.") }
        guard fm.isWritableFile(atPath: app.deletingLastPathComponent().path) else { throw Failure("This Mac's user can't write to \(app.deletingLastPathComponent().path), so the app can't replace itself there.") }

        try? fm.removeItem(at: workDir)
        try fm.createDirectory(at: workDir, withIntermediateDirectories: true)

        var req = URLRequest(url: URL(string: "/app/mac/download", relativeTo: server.base)!.absoluteURL, timeoutInterval: 300)
        req.setValue("Bearer \(server.token)", forHTTPHeaderField: "authorization")
        let zip = workDir.appendingPathComponent("Assistant-Mac.zip")
        do {
            let (tmp, resp) = try await URLSession.shared.download(for: req)
            guard (resp as? HTTPURLResponse)?.statusCode == 200 else { throw Failure("The server couldn't fetch the update.") }
            try fm.moveItem(at: tmp, to: zip)
        } catch let e as Failure { throw e } catch { throw Failure("Download failed: \((error as NSError).localizedDescription)") }

        let unpacked = workDir.appendingPathComponent("new", isDirectory: true)
        guard try await run("/usr/bin/ditto", ["-x", "-k", zip.path, unpacked.path]) == 0 else { throw Failure("The downloaded update could not be unpacked.") }
        let newApp = unpacked.appendingPathComponent("Assistant.app")
        guard let b = Bundle(url: newApp), b.bundleIdentifier == Bundle.main.bundleIdentifier else { throw Failure("The download isn't the Assistant app.") }
        guard try await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", newApp.path]) == 0 else { throw Failure("The downloaded app's signature is invalid.") }

        let script = workDir.appendingPathComponent("swap.sh")
        try swapScript.write(to: script, atomically: true, encoding: .utf8)
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = [script.path, String(ProcessInfo.processInfo.processIdentifier), newApp.path, app.path, failureFile.path]
        p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice
        try p.run()
        NSApp.terminate(nil)          // the script waits for us to exit, swaps the bundle, and opens the new one
    }

    private static func run(_ tool: String, _ args: [String]) async throws -> Int32 {
        try await withCheckedThrowingContinuation { c in
            let p = Process(); p.executableURL = URL(fileURLWithPath: tool); p.arguments = args
            p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice
            p.terminationHandler = { c.resume(returning: $0.terminationStatus) }
            do { try p.run() } catch { c.resume(throwing: error) }
        }
    }

    /// Never leaves you without an app: the old bundle is only deleted once the new one is in place, and is put back otherwise.
    private static let swapScript = #"""
    #!/bin/bash
    PID="$1"; NEW="$2"; DEST="$3"; ERR="$4"
    for i in $(seq 1 100); do kill -0 "$PID" 2>/dev/null || break; sleep 0.3; done
    if kill -0 "$PID" 2>/dev/null; then echo "The app didn't quit, so it couldn't be replaced." > "$ERR"; exit 1; fi
    xattr -dr com.apple.quarantine "$NEW" 2>/dev/null
    OLD="$DEST.previous"
    rm -rf "$OLD"
    if mv "$DEST" "$OLD"; then
      if mv "$NEW" "$DEST"; then rm -rf "$OLD"
      else mv "$OLD" "$DEST"; echo "The new version couldn't be moved into place." > "$ERR"; fi
    else
      echo "The old version couldn't be replaced (is it in a protected folder?)." > "$ERR"
    fi
    open "$DEST"
    """#
}
