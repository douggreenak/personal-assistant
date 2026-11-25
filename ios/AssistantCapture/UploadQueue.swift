import Foundation
import Network

/// Durable offline-first upload queue. Every capture is `<id>.m4a` + `<id>.json` in Application Support/queue.
/// Files are deleted only after the server answers 200, so a dropped connection, a crash or a locked phone loses nothing.
/// The server de-duplicates on the capture id, so retrying a half-finished upload is always safe.
@MainActor
final class UploadQueue: NSObject, ObservableObject {
    static let shared = UploadQueue()
    @Published private(set) var pending = 0
    @Published private(set) var lastResult = ""
    var backgroundCompletion: (() -> Void)?

    nonisolated static let directory: URL = {
        let d = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("queue", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }()

    private struct Meta: Codable { var id: String; var recordedAt: Date }
    private var inFlight = Set<String>()
    private let monitor = NWPathMonitor()
    private lazy var session: URLSession = {
        let c = URLSessionConfiguration.background(withIdentifier: "assistant.capture.upload")
        c.waitsForConnectivity = true            // an unreachable server (offline, tailnet down) just waits instead of failing
        c.sessionSendsLaunchEvents = true
        c.isDiscretionary = false
        return URLSession(configuration: c, delegate: self, delegateQueue: nil)
    }()

    func start() {
        monitor.pathUpdateHandler = { [weak self] path in if path.status == .satisfied { Task { @MainActor in self?.kick() } } }
        monitor.start(queue: DispatchQueue(label: "assistant.capture.net"))
        Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in Task { @MainActor in self?.kick() } }
        refresh(); kick()
    }

    func enqueue(id: String, recordedAt: Date) {
        let meta = Meta(id: id, recordedAt: recordedAt)
        try? JSONEncoder().encode(meta).write(to: Self.directory.appendingPathComponent("\(id).json"))
        refresh(); kick()
    }

    /// Called for files that arrive from the Apple Watch.
    func adoptWatchFile(at src: URL, id: String, recordedAt: Date) {
        let dst = Self.directory.appendingPathComponent("\(id).m4a")
        if !FileManager.default.fileExists(atPath: dst.path) { try? FileManager.default.moveItem(at: src, to: dst) }
        enqueue(id: id, recordedAt: recordedAt)
    }

    private func refresh() {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: Self.directory.path)) ?? []
        pending = names.filter { $0.hasSuffix(".json") }.count
    }

    func kick() {
        guard let base = Settings.baseURL, !Settings.token.isEmpty else { lastResult = "Set the server address and token in Settings."; return }
        let names = (try? FileManager.default.contentsOfDirectory(atPath: Self.directory.path)) ?? []
        for n in names where n.hasSuffix(".json") {
            guard let meta = (try? Data(contentsOf: Self.directory.appendingPathComponent(n))).flatMap({ try? JSONDecoder().decode(Meta.self, from: $0) }),
                  !inFlight.contains(meta.id) else { continue }
            let audio = Self.directory.appendingPathComponent("\(meta.id).m4a")
            guard FileManager.default.fileExists(atPath: audio.path) else { try? FileManager.default.removeItem(at: Self.directory.appendingPathComponent(n)); continue }
            var req = URLRequest(url: base.appendingPathComponent("ingest/voice"))
            req.httpMethod = "POST"
            req.setValue("Bearer \(Settings.token)", forHTTPHeaderField: "Authorization")
            req.setValue(meta.id, forHTTPHeaderField: "X-Capture-Id")
            req.setValue("\(meta.id).m4a", forHTTPHeaderField: "X-Filename")
            req.setValue(ISO8601DateFormatter().string(from: meta.recordedAt), forHTTPHeaderField: "X-Recorded-At")
            req.setValue("audio/mp4", forHTTPHeaderField: "Content-Type")
            let task = session.uploadTask(with: req, fromFile: audio)
            task.taskDescription = meta.id
            inFlight.insert(meta.id); task.resume()
        }
    }

    fileprivate func finished(id: String, status: Int?, error: Error?) {
        inFlight.remove(id)
        if status == 200 {
            for ext in ["m4a", "json"] { try? FileManager.default.removeItem(at: Self.directory.appendingPathComponent("\(id).\(ext)")) }
            lastResult = "Uploaded ✓"
        } else {
            lastResult = error != nil ? "Waiting for connection…" : "Server said \(status ?? 0); will retry."
        }
        refresh()
    }
}

extension UploadQueue: URLSessionTaskDelegate, URLSessionDelegate {
    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let status = (task.response as? HTTPURLResponse)?.statusCode
        guard let id = task.taskDescription else { return }
        Task { @MainActor in self.finished(id: id, status: status, error: error) }
    }
    nonisolated func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        Task { @MainActor in self.backgroundCompletion?(); self.backgroundCompletion = nil }
    }
}
