import Foundation
import EventKit
import AppKit
import ServiceManagement

enum SourceState: Equatable { case off, idle, ok, needsPermission(String), error(String) }
struct SourceStatus: Equatable { var state: SourceState = .off; var last: Date?; var detail = "" }

struct UpdateInfo: Equatable { let version: String, notes: String }

/// Runs every source on a timer and publishes what happened for the menu and Settings.
@MainActor final class SyncEngine: ObservableObject {
    static let shared = SyncEngine()

    @Published var messages = SourceStatus()
    @Published var calendar = SourceStatus()
    @Published var reminders = SourceStatus()
    @Published var connection = SourceStatus()
    @Published var update: UpdateInfo?
    @Published var syncing = false

    private let store = EKEventStore()
    private lazy var calendarSync = CalendarSync(store: store)
    private lazy var remindersSync = RemindersSync(store: store)
    private var contacts: ContactsResolver?
    private var contactsLoadedAt = Date.distantPast
    private var timer: Timer?
    private var lastUpdateCheck = Date.distantPast

    static var appVersion: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0" }

    func start() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in Task { @MainActor in await self?.syncNow() } }
        Task { await syncNow() }
    }

    var needsSetup: Bool { Prefs.baseURL == nil || Prefs.token.isEmpty }

    func syncNow() async {
        guard !syncing else { return }
        syncing = true; defer { syncing = false }
        guard let server = try? Server.current() else { connection = SourceStatus(state: .needsPermission("Open Settings to connect to your server.")); return }
        do { try await server.ping(); connection = SourceStatus(state: .ok, last: Date()) }
        catch { connection = SourceStatus(state: .error(error.localizedDescription)); return }   // nothing else can work; keep retrying quietly

        await run(\.messages, enabled: Prefs.syncMessages) {
            guard MessagesSync.hasAccess() else { throw MessagesError.needsFullDiskAccess }
            let n = try await MessagesSync.sync(server: server, contacts: await self.contactsIfEnabled())
            return n == 0 ? "Up to date" : "Sent \(n) new message\(n == 1 ? "" : "s")"
        }
        await run(\.calendar, enabled: Prefs.syncCalendar) {
            guard await CalendarSync.requestAccess(self.store) || CalendarSync.authorized else { throw PermissionError("Allow Calendar access in System Settings → Privacy & Security → Calendars.") }
            let n = try await self.calendarSync.sync(server: server)
            return n == 0 ? "Up to date" : "Sent \(n) event\(n == 1 ? "" : "s")"
        }
        await run(\.reminders, enabled: Prefs.syncReminders || Prefs.mirrorItems) {
            guard await RemindersSync.requestAccess(self.store) || RemindersSync.authorized else { throw PermissionError("Allow Reminders access in System Settings → Privacy & Security → Reminders.") }
            var parts: [String] = []
            if Prefs.syncReminders { let n = try await self.remindersSync.pushInbox(server: server); if n > 0 { parts.append("captured \(n) from “\(RemindersSync.inboxName)”") } }
            if Prefs.mirrorItems { let n = try await self.remindersSync.mirror(server: server); if n > 0 { parts.append("updated \(n) in “\(RemindersSync.mirrorName)”") } }
            return parts.isEmpty ? "Up to date" : parts.joined(separator: ", ").capitalizedFirst
        }
        await checkForUpdate(server: server)
    }

    private struct PermissionError: LocalizedError { let errorDescription: String?; init(_ m: String) { errorDescription = m } }

    private func run(_ key: ReferenceWritableKeyPath<SyncEngine, SourceStatus>, enabled: Bool, _ work: () async throws -> String) async {
        guard enabled else { self[keyPath: key] = SourceStatus(); return }
        do { self[keyPath: key] = SourceStatus(state: .ok, last: Date(), detail: try await work()) }
        catch MessagesError.needsFullDiskAccess { self[keyPath: key] = SourceStatus(state: .needsPermission(MessagesError.needsFullDiskAccess.localizedDescription)) }
        catch let e as PermissionError { self[keyPath: key] = SourceStatus(state: .needsPermission(e.localizedDescription)) }
        catch { self[keyPath: key] = SourceStatus(state: .error(error.localizedDescription), last: self[keyPath: key].last) }
    }

    private func contactsIfEnabled() async -> ContactsResolver? {
        guard Prefs.useContacts else { contacts = nil; return nil }
        guard await ContactsResolver.requestAccess() || ContactsResolver.authorized else { return nil }
        if contacts == nil || Date().timeIntervalSince(contactsLoadedAt) > 1800 {
            let c = contacts ?? ContactsResolver()
            if (try? c.reload()) != nil { contacts = c; contactsLoadedAt = Date() }
        }
        return contacts
    }

    // MARK: updates

    private func checkForUpdate(server: Server) async {
        guard Date().timeIntervalSince(lastUpdateCheck) > 6 * 3600 else { return }
        lastUpdateCheck = Date()
        guard let data = try? await server.get("/app/mac/latest"),
              let rel = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["release"] as? [String: Any],
              rel["available"] as? Bool == true, let v = rel["version"] as? String else { return }   // ingest-only token: no update notice, no problem
        update = v.compare(Self.appVersion, options: .numeric) == .orderedDescending ? UpdateInfo(version: v, notes: rel["notes"] as? String ?? "") : nil
    }

    /// Downloads the newest zip through your server into Downloads and reveals it in Finder.
    func downloadUpdate() async -> String? {
        do {
            let server = try Server.current()
            var req = URLRequest(url: URL(string: "/app/mac/download", relativeTo: server.base)!.absoluteURL, timeoutInterval: 120)
            req.setValue("Bearer \(server.token)", forHTTPHeaderField: "authorization")
            let (tmp, resp) = try await URLSession.shared.download(for: req)
            guard (resp as? HTTPURLResponse)?.statusCode == 200 else { return "The server couldn't fetch the update." }
            let dir = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
            var dest = dir.appendingPathComponent("Assistant-Mac.zip"), i = 1
            while FileManager.default.fileExists(atPath: dest.path) { dest = dir.appendingPathComponent("Assistant-Mac \(i).zip"); i += 1 }
            try FileManager.default.moveItem(at: tmp, to: dest)
            NSWorkspace.shared.activateFileViewerSelecting([dest])
            return nil
        } catch { return error.localizedDescription }
    }

    // MARK: launch at login

    static var launchAtLogin: Bool {
        get { SMAppService.mainApp.status == .enabled }
        set { do { if newValue { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() } } catch { NSLog("Launch at login: \(error)") } }
    }
}

private extension String { var capitalizedFirst: String { prefix(1).uppercased() + dropFirst() } }
