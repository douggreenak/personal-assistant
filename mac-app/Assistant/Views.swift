import SwiftUI
import AppKit

private func symbol(_ s: SourceState) -> (String, Color) {
    switch s {
    case .off: return ("circle", .secondary)
    case .idle: return ("circle.dotted", .secondary)
    case .ok: return ("checkmark.circle.fill", .green)
    case .needsPermission: return ("lock.circle.fill", .orange)
    case .error: return ("exclamationmark.triangle.fill", .red)
    }
}
private func message(_ s: SourceStatus, off: String) -> String {
    switch s.state {
    case .off: return off
    case .idle: return "Waiting…"
    case .ok: return s.detail + (s.last.map { " · " + $0.formatted(date: .omitted, time: .shortened) } ?? "")
    case .needsPermission(let m), .error(let m): return m
    }
}

struct StatusRow: View {
    let title: String, status: SourceStatus, off: String
    var body: some View {
        let (name, color) = symbol(status.state)
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: name).foregroundStyle(color).frame(width: 18)
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.system(size: 13, weight: .medium))
                Text(message(status, off: off)).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
    }
}

/// The menu-bar popover: status of every source, quick capture, and the few actions you need day to day.
struct MenuView: View {
    @ObservedObject var engine = SyncEngine.shared
    @State private var text = ""
    @State private var sending = false
    @State private var note: String?
    @State private var updateNote: String?
    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if engine.needsSetup {
                Text("Connect to your assistant").font(.headline)
                Text("Enter the server address and token to start.").font(.callout).foregroundStyle(.secondary)
                Button("Paste config from clipboard") { Task { note = await engine.applyConfig(NSPasteboard.general.string(forType: .string) ?? "") } }.buttonStyle(.borderedProminent)
                Text("In the web UI: System → Mac app → Copy config.").font(.caption).foregroundStyle(.secondary)
                if let note { Text(note).font(.caption).foregroundStyle(note.hasPrefix("✓") ? Color.green : Color.red) }
                SettingsLink { Text("Enter address and token manually…") }.buttonStyle(.link).font(.caption)
            } else {
                HStack {
                    TextField("Tell the assistant something…", text: $text).textFieldStyle(.roundedBorder).onSubmit(send)
                    Button(action: send) { Image(systemName: "arrow.up.circle.fill") }.buttonStyle(.plain).font(.title2).disabled(text.trimmingCharacters(in: .whitespaces).isEmpty || sending)
                }
                if let note { Text(note).font(.caption).foregroundStyle(.secondary) }
                Divider()
                StatusRow(title: "Server", status: engine.connection, off: "")
                StatusRow(title: "Messages", status: engine.messages, off: "Off")
                StatusRow(title: "Calendar", status: engine.calendar, off: "Off")
                StatusRow(title: "Reminders", status: engine.reminders, off: "Off")
                if case .needsPermission = engine.messages.state {
                    Button("Open Full Disk Access settings") { open("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles") }.font(.caption)
                }
            }
            if let u = engine.update {
                Divider()
                Button { Task { updateNote = await engine.installUpdate() } } label: {
                    Label(engine.updating ? "Updating… the app will reopen" : "Version \(u.version) is available — update now", systemImage: "arrow.down.circle")
                }.disabled(engine.updating)
                if let updateNote { Text(updateNote).font(.caption).foregroundStyle(.red) }
            }
            Divider()
            HStack {
                Button { Task { await engine.syncNow() } } label: { Label(engine.syncing ? "Syncing…" : "Sync now", systemImage: "arrow.triangle.2.circlepath") }.disabled(engine.syncing || engine.needsSetup)
                Button { if let u = Prefs.baseURL { openURL(u) } } label: { Label("Open web UI", systemImage: "safari") }.disabled(Prefs.baseURL == nil)
                Spacer()
                SettingsLink { Image(systemName: "gearshape") }
                Button { NSApp.terminate(nil) } label: { Image(systemName: "power") }.help("Quit")
            }.buttonStyle(.borderless)
        }
        .padding(14).frame(width: 340)
    }

    private func open(_ s: String) { if let u = URL(string: s) { NSWorkspace.shared.open(u) } }

    private func send() {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines); guard !t.isEmpty, !sending else { return }
        sending = true; note = nil
        Task {
            do { try await Server.current().ingest(source: "mac-app", sourceId: UUID().uuidString, sender: "me", body: t); text = ""; note = "Sent — you'll see what it understood in your usual notifications." }
            catch { note = error.localizedDescription }
            sending = false
        }
    }
}

struct SettingsView: View {
    @ObservedObject var engine = SyncEngine.shared
    @State private var address = Prefs.baseURL?.absoluteString ?? ""
    @State private var token = Prefs.token
    @State private var testResult: String?
    @State private var testing = false
    @State private var updateNote: String?
    @State private var launchAtLogin = SyncEngine.launchAtLogin
    @AppStorage(Prefs.messagesKey) private var messages = true
    @AppStorage(Prefs.calendarKey) private var calendar = false
    @AppStorage(Prefs.remindersKey) private var reminders = false
    @AppStorage(Prefs.mirrorKey) private var mirror = false
    @AppStorage(Prefs.contactsKey) private var contacts = false

    var body: some View {
        TabView {
            Form {
                Section("Server") {
                    TextField("Address", text: $address, prompt: Text("http://your-server.tailnet-name.ts.net:8090"))
                    SecureField("Token", text: $token, prompt: Text("INGEST_TOKEN or ASSISTANT_TOKEN"))
                    HStack {
                        Button("Paste config") { Task { await pasteConfig() } }.disabled(testing)
                        Text("from the web UI: System → Mac app → Copy config").font(.caption).foregroundStyle(.secondary)
                    }
                    HStack {
                        Button("Save & test") { Task { await saveAndTest() } }.disabled(testing)
                        if testing { ProgressView().controlSize(.small) }
                        if let testResult { Text(testResult).font(.caption).foregroundStyle(testResult.hasPrefix("✓") ? Color.green : Color.red) }
                    }
                    Text("The send-only INGEST_TOKEN is enough for Messages, Calendar, Reminders inbox and Capture. Showing the assistant's items in Reminders, asking questions and update checks need the full ASSISTANT_TOKEN. Your Mac must be on the same Tailscale network.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Section("General") {
                    Toggle("Open at login", isOn: $launchAtLogin).onChange(of: launchAtLogin) { _, v in SyncEngine.launchAtLogin = v }
                }
            }.formStyle(.grouped).tabItem { Label("Connection", systemImage: "network") }

            Form {
                Section("Messages") {
                    Toggle("Send new texts and iMessages to the assistant", isOn: $messages)
                    Toggle("Show contact names instead of numbers", isOn: $contacts)
                    Text("Needs Full Disk Access (System Settings → Privacy & Security → Full Disk Access → add Assistant). Only messages that arrive after you first run the app are sent; history is never back-processed. One-time codes are dropped.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Section("Calendar") {
                    Toggle("Send upcoming events (next 14 days)", isOn: $calendar)
                }
                Section("Reminders") {
                    Toggle("Capture from the “\(RemindersSync.inboxName)” list", isOn: $reminders)
                    Toggle("Show the assistant's reminders and tasks in the “\(RemindersSync.mirrorName)” list", isOn: $mirror)
                    Text("Reminders sync to your iPhone and Apple Watch through iCloud. Checking a task off in Reminders completes it in the assistant.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Section {
                    ForEach([("Messages", engine.messages), ("Calendar", engine.calendar), ("Reminders", engine.reminders)], id: \.0) { StatusRow(title: $0.0, status: $0.1, off: "Off") }
                }
            }.formStyle(.grouped).tabItem { Label("Sources", systemImage: "tray.and.arrow.down") }
                .onChange(of: messages) { _, _ in resync() }.onChange(of: calendar) { _, _ in resync() }
                .onChange(of: reminders) { _, _ in resync() }.onChange(of: mirror) { _, _ in resync() }.onChange(of: contacts) { _, _ in resync() }

            Form {
                Section("About") {
                    LabeledContent("Version", value: SyncEngine.appVersion)
                    if let u = engine.update {
                        LabeledContent("Update", value: "\(u.version) available")
                        HStack {
                            Button(engine.updating ? "Updating…" : "Update now") { Task { updateNote = await engine.installUpdate() } }.disabled(engine.updating)
                            if let updateNote { Text(updateNote).font(.caption).foregroundStyle(.red) }
                        }
                    } else { LabeledContent("Update", value: "Up to date") }
                    Text("You can also update from the web UI (System → Mac app → Connected Macs); the app downloads the new version, replaces itself and reopens. Settings and permissions are kept.").font(.caption).foregroundStyle(.secondary)
                    Text("Shortcuts and Siri: open the Shortcuts app and search for “Assistant” to find Capture to Assistant and Ask Assistant.").font(.caption).foregroundStyle(.secondary)
                }
            }.formStyle(.grouped).tabItem { Label("About", systemImage: "info.circle") }
        }
        .frame(width: 520, height: 470)
    }

    private func resync() { Task { await engine.syncNow() } }

    private func pasteConfig() async {
        testing = true; testResult = nil; defer { testing = false }
        testResult = await engine.applyConfig(NSPasteboard.general.string(forType: .string) ?? "")
        address = Prefs.baseURL?.absoluteString ?? address; token = Prefs.token
    }

    private func saveAndTest() async {
        guard let url = URL.serverAddress(address) else { testResult = "That isn't a valid address."; return }
        Prefs.baseURL = url; Prefs.token = token.trimmingCharacters(in: .whitespacesAndNewlines)
        address = url.absoluteString
        testing = true; testResult = nil; defer { testing = false }
        do { try await Server.current().ping(); testResult = "✓ Connected"; await engine.syncNow() }
        catch { testResult = error.localizedDescription }
    }
}
