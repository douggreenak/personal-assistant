import AVFoundation
import Foundation

/// Records speech to a small AAC file (16 kHz mono ≈ 240 KB/minute) and hands it to the upload queue.
/// Recording never needs the network: the file is safe on disk before anything is sent.
@MainActor
final class Recorder: NSObject, ObservableObject {
    @Published var isRecording = false
    @Published var elapsed: TimeInterval = 0
    @Published var error: String?

    private var recorder: AVAudioRecorder?
    private var current: (id: String, url: URL, started: Date)?
    private var timer: Timer?

    func toggle() async { isRecording ? stop() : await start() }

    func start() async {
        error = nil
        guard await AVAudioApplication.requestRecordPermission() else { error = "Microphone access is off."; return }
        do {
            let s = AVAudioSession.sharedInstance()
            try s.setCategory(.playAndRecord, mode: .default, options: [.allowBluetoothHFP])
            try s.setActive(true)
            let id = UUID().uuidString.lowercased()
            let url = UploadQueue.directory.appendingPathComponent("\(id).m4a")
            let r = try AVAudioRecorder(url: url, settings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 16000, AVNumberOfChannelsKey: 1,
                AVEncoderBitRateKey: 32000, AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
            ])
            guard r.record() else { error = "Couldn't start recording."; return }
            recorder = r; current = (id, url, Date()); isRecording = true; elapsed = 0
            timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
                Task { @MainActor in self?.elapsed = self?.recorder?.currentTime ?? 0 }
            }
        } catch { self.error = error.localizedDescription }
    }

    func stop() {
        timer?.invalidate(); timer = nil
        recorder?.stop(); recorder = nil; isRecording = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        guard let c = current else { return }
        current = nil
        if (try? c.url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0) ?? 0 < 2000 {   // an accidental tap
            try? FileManager.default.removeItem(at: c.url); return
        }
        UploadQueue.shared.enqueue(id: c.id, recordedAt: c.started)
    }
}
