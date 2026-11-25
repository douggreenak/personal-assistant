import SwiftUI
import AVFoundation
import WatchConnectivity

@main
struct WatchCaptureApp: App {
    @StateObject private var model = WatchRecorder()
    var body: some Scene {
        WindowGroup {
            VStack(spacing: 8) {
                Button { Task { await model.toggle() } } label: {
                    Image(systemName: model.isRecording ? "stop.fill" : "mic.fill").font(.system(size: 36))
                }
                .tint(model.isRecording ? .red : .blue).buttonStyle(.borderedProminent).controlSize(.large)
                Text(model.isRecording ? "Recording…" : model.status).font(.footnote).multilineTextAlignment(.center)
            }
            .task { model.activate() }
        }
    }
}

/// Records on the wrist, then queues the file for the iPhone with `transferFile` — the system keeps it and
/// delivers it whenever the phone is in reach, so this works fully offline. The phone does the uploading.
@MainActor
final class WatchRecorder: NSObject, ObservableObject, WCSessionDelegate {
    @Published var isRecording = false
    @Published var status = "Tap to record"
    private var recorder: AVAudioRecorder?
    private var current: (id: String, url: URL, started: Date)?

    func activate() { if WCSession.isSupported() { WCSession.default.delegate = self; WCSession.default.activate() } }
    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {}

    func toggle() async { isRecording ? stop() : await start() }

    private func start() async {
        guard await AVAudioApplication.requestRecordPermission() else { status = "Microphone is off"; return }
        do {
            try AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .default)
            try AVAudioSession.sharedInstance().setActive(true)
            let id = UUID().uuidString.lowercased()
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(id).m4a")
            let r = try AVAudioRecorder(url: url, settings: [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 16000, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 32000])
            guard r.record() else { status = "Couldn't record"; return }
            recorder = r; current = (id, url, Date()); isRecording = true
        } catch { status = error.localizedDescription }
    }

    private func stop() {
        recorder?.stop(); recorder = nil; isRecording = false
        try? AVAudioSession.sharedInstance().setActive(false)
        guard let c = current else { return }; current = nil
        WCSession.default.transferFile(c.url, metadata: ["id": c.id, "recordedAt": c.started.timeIntervalSince1970])
        status = "Saved — will reach your phone"
    }
}
