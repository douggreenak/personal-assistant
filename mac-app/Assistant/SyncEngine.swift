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
    @Published var updating = false

    private let store = EKEventStore()
    private lazy var calendarSync = CalendarSync(store: store)
    private lazy var remindersSync = RemindersSync(store: store)
    private var contacts: ContactsResolver?
    private var contactsLoadedAt = Date.distantPast
    private var timer: Timer?

    nonisolated static var appVersion: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0" }

    func start() {
        Updater.collectFailure()
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
        await checkIn(server: server)
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

    // MARK: connecting

    /// Applies what the web UI's "Copy config" put on the clipboard: address + token, then tests the connection.
    func applyConfig(_ text: String) async -> String {
        guard let cfg = ConnectionConfig.parse(text) else { return "The clipboard doesn't hold a config. In the web UI open System → Mac app → Copy config." }
        Prefs.baseURL = cfg.url; Prefs.token = cfg.token
        do { try await Server.current().ping() } catch { return error.localizedDescription }
        await syncNow()
        return "✓ Connected to \(cfg.url.host ?? cfg.url.absoluteString)"
    }

    // MARK: updates

    /// Each minute: tell the server we're alive and which version this is. The answer says what the newest version is
    /// and whether someone pressed Update in the web UI for this Mac (then we do it; but not again within 15 minutes if the last attempt left this version unchanged without reporting an error, so a bad release can't loop).
    private func checkIn(server: Server) async {
        let err = Prefs.updateError
        guard let r = await server.checkIn(updateError: err) else { return }     // old server: no update notice, no problem
        if err != nil { Prefs.updateError = nil }
        if let v = r.latestVersion, v.compare(Self.appVersion, options: .numeric) == .orderedDescending { update = UpdateInfo(version: v, notes: "") } else { update = nil }
        let justFailed = Prefs.lastUpdateFrom == Self.appVersion && Date().timeIntervalSince(Prefs.lastUpdateAttempt) < 900
        if r.updateRequested, !updating, !justFailed { _ = await installUpdate() }
    }

    /// Downloads the newest version, swaps it in for this app and reopens. Returns an error message, or nil (the app is about to quit).
    func installUpdate() async -> String? {
        guard !updating else { return nil }
        updating = true; defer { updating = false }
        Prefs.lastUpdateAttempt = Date(); Prefs.lastUpdateFrom = Self.appVersion
        do { try await Updater.install(server: try Server.current()); return nil }
        catch { Prefs.updateError = error.localizedDescription; Prefs.lastUpdateFrom = nil; return error.localizedDescription }   // reported failures don't block a retry
    }

    // MARK: launch at login

    static var launchAtLogin: Bool {
        get { SMAppService.mainApp.status == .enabled }
        set { do { if newValue { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() } } catch { NSLog("Launch at login: \(error)") } }
    }
}

private extension String { var capitalizedFirst: String { prefix(1).uppercased() + dropFirst() } }
