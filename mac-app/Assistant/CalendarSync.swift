import EventKit

/// Upcoming Calendar events (next 14 days) become messages from "calendar", so the assistant can remind you
/// about prep, conflicts and travel. Each event is sent once per edit; what was already sent is remembered locally.
final class CalendarSync {
    private let store: EKEventStore
    private let sentFile = Prefs.supportDir.appendingPathComponent("calendar-sent.json")
    private var sent: Set<String>

    init(store: EKEventStore) {
        self.store = store
        sent = Set((try? JSONDecoder().decode([String].self, from: Data(contentsOf: sentFile))) ?? [])
    }

    static func requestAccess(_ store: EKEventStore) async -> Bool { (try? await store.requestFullAccessToEvents()) ?? false }
    static var authorized: Bool { EKEventStore.authorizationStatus(for: .event) == .fullAccess }

    func sync(server: Server) async throws -> Int {
        let now = Date(), end = now.addingTimeInterval(14 * 86400)
        let events = store.events(matching: store.predicateForEvents(withStart: now, end: end, calendars: nil))
        let fmt = DateFormatter(); fmt.dateStyle = .full; fmt.timeStyle = .short
        var count = 0
        for e in events {
            if e.status == .canceled { continue }
            if e.attendees?.first(where: \.isCurrentUser)?.participantStatus == .declined { continue }
            let key = "\(e.calendarItemExternalIdentifier ?? e.eventIdentifier ?? e.title ?? "event")|\(Int(e.startDate.timeIntervalSince1970))|\(Int((e.lastModifiedDate ?? .distantPast).timeIntervalSince1970))"
            if sent.contains(key) { continue }
            var lines = ["Calendar event: \(e.title ?? "(untitled)")",
                         e.isAllDay ? "When: \(DateFormatter.localizedString(from: e.startDate, dateStyle: .full, timeStyle: .none)) (all day)" : "When: \(fmt.string(from: e.startDate)) – \(DateFormatter.localizedString(from: e.endDate, dateStyle: .none, timeStyle: .short))",
                         "Calendar: \(e.calendar.title)"]
            if let loc = e.location, !loc.isEmpty { lines.append("Where: \(loc)") }
            if let notes = e.notes, !notes.isEmpty { lines.append("Notes: \(notes.prefix(500))") }
            try await server.ingest(source: "calendar", sourceId: key, sender: "calendar", subject: e.title ?? "", body: lines.joined(separator: "\n"))
            sent.insert(key); count += 1
        }
        // Forget events that have long passed so the file doesn't grow forever.
        let cutoff = Int(now.addingTimeInterval(-86400).timeIntervalSince1970)
        sent = sent.filter { Int($0.split(separator: "|").dropFirst().first ?? "0") ?? 0 >= cutoff }
        if let data = try? JSONEncoder().encode(Array(sent)) { try? data.write(to: sentFile, options: .atomic) }
        return count
    }
}
