import SwiftUI

struct ContentView: View {
    @EnvironmentObject var queue: UploadQueue
    @EnvironmentObject var recorder: Recorder
    @State private var showSettings = false

    var body: some View {
        VStack(spacing: 28) {
            Spacer()
            Button { Task { await recorder.toggle() } } label: {
                ZStack {
                    Circle().fill(recorder.isRecording ? Color.red : Color.accentColor).frame(width: 180, height: 180)
                    Image(systemName: recorder.isRecording ? "stop.fill" : "mic.fill").font(.system(size: 64)).foregroundStyle(.white)
                }
            }
            .accessibilityLabel(recorder.isRecording ? "Stop recording" : "Start recording")
            if recorder.isRecording {
                Text(String(format: "%d:%02d", Int(recorder.elapsed) / 60, Int(recorder.elapsed) % 60)).font(.title2.monospacedDigit())
            } else {
                Text("Say anything. It's saved here first and sent when your server is reachable.").font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center).padding(.horizontal)
            }
            if let e = recorder.error { Text(e).foregroundStyle(.red) }
            Spacer()
            VStack(spacing: 4) {
                Label(queue.pending == 0 ? "Everything sent" : "\(queue.pending) waiting to send", systemImage: queue.pending == 0 ? "checkmark.circle" : "clock")
                    .foregroundStyle(queue.pending == 0 ? .green : .orange)
                if !queue.lastResult.isEmpty { Text(queue.lastResult).font(.caption).foregroundStyle(.secondary) }
            }
            Button("Settings") { showSettings = true }.font(.footnote)
        }
        .padding()
        .sheet(isPresented: $showSettings) { SettingsView() }
    }
}

struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var url = Settings.baseURL?.absoluteString ?? ""
    @State private var token = Settings.token
    var body: some View {
        NavigationStack {
            Form {
                Section("Server (over Tailscale)") {
                    TextField("http://server.tailnet.ts.net:8090", text: $url).textInputAutocapitalization(.never).keyboardType(.URL).autocorrectionDisabled()
                    SecureField("Token", text: $token)
                }
                Section { Text("Install the Tailscale app and stay signed in so this phone can reach the server.").font(.footnote) }
            }
            .navigationTitle("Settings")
            .toolbar { Button("Save") {
                Settings.baseURL = URL(string: url.trimmingCharacters(in: .whitespaces)); Settings.token = token
                UploadQueue.shared.kick(); dismiss()
            } }
        }
    }
}
