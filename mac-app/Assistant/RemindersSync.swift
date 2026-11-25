import EventKit

/// Two small, separate bridges to the Reminders app (which syncs with iPhone and Apple Watch through iCloud):
///  • "Assistant Inbox" list → anything you add there is sent to the assistant, then checked off (it was captured).
///  • "Assistant" list ← the assistant's open reminders and tasks appear there with due times and alerts;
///    checking one off in Reminders completes it on the server; finishing it elsewhere checks it off here.
final class RemindersSync {
    static let inboxName = "Assistant Inbox", mirrorName = "Assistant"
    private let store: EKEventStore
    private let mapFile = Prefs.supportDir.appendingPathComponent("reminder-map.json")
    /// server item id -> reminder identifier ("" = you deleted it in Reminders; don't bring it back)
    private var map: [String: String]

    init(store: EKEventStore) {
        self.store = store
        map = (try? JSONDecoder().decode([String: String].self, from: Data(contentsOf: mapFile))) ?? [:]
    }

    static func requestAccess(_ store: EKEventStore) async -> Bool { (try? await store.requestFullAccessToReminders()) ?? false }
    static var authorized: Bool { EKEventStore.authorizationStatus(for: .reminder) == .fullAccess }

    private func saveMap() { if let d = try? JSONEncoder().encode(map) { try? d.write(to: mapFile, options: .atomic) } }

    private func list(named name: String) throws -> EKCalendar {
        if let c = store.calendars(for: .reminder).first(where: { $0.title == name && $0.allowsContentModifications }) { return c }
        let c = EKCalendar(for: .reminder, eventStore: store); c.title = name
        guard let source = store.defaultCalendarForNewReminders()?.source ?? store.sources.first(where: { $0.sourceType == .calDAV || $0.sourceType == .local }) else {
            throw NSError(domain: "Assistant", code: 1, userInfo: [NSLocalizedDescriptionKey: "No Reminders account to put the \"\(name)\" list in."])
        }
        c.source = source
        try store.saveCalendar(c, commit: true)
        return c
    }

    private func fetch(_ calendars: [EKCalendar], incomplete: Bool) async -> [EKReminder] {
        let p = incomplete ? store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: calendars) : store.predicateForReminders(in: calendars)
        return await withCheckedContinuation { cont in store.fetchReminders(matching: p) { cont.resume(returning: $0 ?? []) } }
    }

    // MARK: inbox -> assistant

    func pushInbox(server: Server) async throws -> Int {
        let inbox = try list(named: Self.inboxName)
        var n = 0
        for r in await fetch([inbox], incomplete: true) {
            let title = (r.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !title.isEmpty else { continue }
            var body = title
            if let notes = r.notes, !notes.isEmpty { body += "\n" + notes }
            if let due = r.dueDateComponents?.date { body += "\n(due \(DateFormatter.localizedString(from: due, dateStyle: .medium, timeStyle: .short)))" }
            // 'me' = your own words, so it is treated as a request/commitment rather than something someone sent you.
            try await server.ingest(source: "reminders", sourceId: r.calendarItemIdentifier, sender: "me", subject: title, body: body, receivedAt: r.creationDate ?? Date())
            r.isCompleted = true                               // captured; checked off only after the server accepted it
            try store.save(r, commit: true); n += 1
        }
        return n
    }

    // MARK: assistant -> Reminders (and back when you check one off)

    private struct ServerItem: Decodable { let id: String; let kind: String; let title: String; let detail: String; let dueAt: String?; let priority: String }

    private static let iso: ISO8601DateFormatter = { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f }()
    private static func parse(_ s: String?) -> Date? { s.flatMap { iso.date(from: $0) ?? ISO8601DateFormatter().date(from: $0) } }

    func mirror(server: Server) async throws -> Int {
        let data = try await server.get("/items?state=open&limit=200", needsFullToken: "Showing the assistant's items in Reminders")
        let items = try JSONDecoder().decode([String: [ServerItem]].self, from: data)["items"]?.filter { $0.kind != "ticket" } ?? []
        let openIds = Set(items.map(\.id))
        let cal = try list(named: Self.mirrorName)
        let existing = Dictionary(uniqueKeysWithValues: await fetch([cal], incomplete: false).map { ($0.calendarItemIdentifier, $0) })
        var changes = 0

        // 1) You checked one off in Reminders -> complete it on the server.
        for it in items {
            guard let rid = map[it.id], !rid.isEmpty, let r = existing[rid], r.isCompleted else { continue }
            try await server.send("POST", "/items/\(it.id)/complete")
            map[it.id] = nil; changes += 1; saveMap()
        }
        // 2) Create or update what is still open.
        for it in items {
            switch map[it.id] {
            case "": continue                                                 // you deleted it; leave it gone
            case let rid?:
                guard let r = existing[rid] else { map[it.id] = ""; continue } // deleted since last time
                if apply(it, to: r) { try store.save(r, commit: false); changes += 1 }
            case nil:
                let r = EKReminder(eventStore: store); r.calendar = cal
                _ = apply(it, to: r)
                try store.save(r, commit: false); map[it.id] = r.calendarItemIdentifier; changes += 1
            }
        }
        // 3) Done/dropped on the server (or anywhere else) -> check off here; forget the mapping.
        for (id, rid) in map where !openIds.contains(id) {
            if !rid.isEmpty, let r = existing[rid], !r.isCompleted { r.isCompleted = true; try store.save(r, commit: false); changes += 1 }
            map[id] = nil
        }
        try store.commit(); saveMap()
        return changes
    }

    /// Sets title/notes/due/priority/alarm from the server item; returns whether anything changed.
    private func apply(_ it: ServerItem, to r: EKReminder) -> Bool {
        var changed = false
        func set<T: Equatable>(_ cur: T, _ new: T, _ write: (T) -> Void) { if cur != new { write(new); changed = true } }
        set(r.title ?? "", it.title) { r.title = $0 }
        set(r.notes ?? "", it.detail) { r.notes = $0.isEmpty ? nil : $0 }
        let prio = ["urgent": 1, "high": 1, "low": 9][it.priority] ?? 0
        set(r.priority, prio) { r.priority = $0 }
        let due = Self.parse(it.dueAt)
        let comps = due.map { Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: $0) }
        if r.dueDateComponents != comps {
            r.dueDateComponents = comps; changed = true
            (r.alarms ?? []).forEach { r.removeAlarm($0) }
            if let due { r.addAlarm(EKAlarm(absoluteDate: due)) }
        }
        return changed
    }
}
