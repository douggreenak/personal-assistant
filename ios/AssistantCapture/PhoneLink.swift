import Foundation
import WatchConnectivity

/// Receives recordings from the Apple Watch. WatchConnectivity file transfers are queued by the system and
/// delivered whenever the watch and phone can talk, so recording on the watch works with no connection at all.
final class PhoneLink: NSObject, WCSessionDelegate {
    static let shared = PhoneLink()
    func activate() { guard WCSession.isSupported() else { return }; WCSession.default.delegate = self; WCSession.default.activate() }

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {}
    func sessionDidBecomeInactive(_ session: WCSession) {}
    func sessionDidDeactivate(_ session: WCSession) { session.activate() }

    func session(_ session: WCSession, didReceive file: WCSessionFile) {
        // The system deletes `file` when this method returns, so move it synchronously.
        guard let id = file.metadata?["id"] as? String, id.range(of: "^[a-f0-9-]{8,64}$", options: .regularExpression) != nil else { return }
        let keep = FileManager.default.temporaryDirectory.appendingPathComponent("\(id).m4a")
        try? FileManager.default.removeItem(at: keep)
        guard (try? FileManager.default.moveItem(at: file.fileURL, to: keep)) != nil else { return }
        let when = (file.metadata?["recordedAt"] as? Double).map { Date(timeIntervalSince1970: $0) } ?? Date()
        Task { @MainActor in UploadQueue.shared.adoptWatchFile(at: keep, id: id, recordedAt: when) }
    }
}
