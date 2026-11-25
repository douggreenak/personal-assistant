import Foundation
import SQLite3

/// Reads new rows from Messages' chat.db (read-only) and forwards them to the server — the same protocol as the old
/// `mac/agent.sh`. All decoding of `attributedBody` happens on the server. The row id is only advanced after the server confirms.
struct MessageRow: Encodable {
    let rowid: Int64, guid: String, text: String?, attr_hex: String?, date: String, is_from_me: Int, handle: String?
}

enum MessagesError: LocalizedError {
    case needsFullDiskAccess, sqlite(String)
    var errorDescription: String? {
        switch self {
        case .needsFullDiskAccess: return "Needs Full Disk Access to read Messages."
        case .sqlite(let m): return "Messages database: \(m)"
        }
    }
}

enum MessagesSync {
    static let dbPath = ProcessInfo.processInfo.environment["ASSISTANT_MESSAGES_DB"] ?? NSHomeDirectory() + "/Library/Messages/chat.db"   // override is for tests
    static let batch = 200

    /// Date is nanoseconds since 2001-01-01 on modern macOS, seconds on old ones.
    private static let sql = """
        SELECT m.ROWID, m.guid, m.text,
               CASE WHEN m.text IS NULL OR m.text = '' THEN hex(m.attributedBody) END,
               strftime('%Y-%m-%dT%H:%M:%SZ', (CASE WHEN m.date > 1000000000000 THEN m.date/1000000000 ELSE m.date END) + 978307200, 'unixepoch'),
               m.is_from_me, h.id
        FROM message m LEFT JOIN handle h ON h.ROWID = m.handle_id
        WHERE m.ROWID > ? ORDER BY m.ROWID LIMIT ?
        """

    private static func open() throws -> OpaquePointer {
        var db: OpaquePointer?
        let rc = sqlite3_open_v2(dbPath, &db, SQLITE_OPEN_READONLY, nil)
        if rc != SQLITE_OK {
            sqlite3_close(db)
            // macOS answers "authorization denied"/"unable to open" until Full Disk Access is granted.
            if !FileManager.default.isReadableFile(atPath: dbPath) { throw MessagesError.needsFullDiskAccess }
            throw MessagesError.sqlite(String(cString: sqlite3_errstr(rc)))
        }
        sqlite3_busy_timeout(db, 3000)
        return db!
    }

    static func hasAccess() -> Bool { FileManager.default.isReadableFile(atPath: dbPath) }

    static func maxRowid() throws -> Int64 {
        let db = try open(); defer { sqlite3_close(db) }
        var st: OpaquePointer?
        guard sqlite3_prepare_v2(db, "SELECT COALESCE(MAX(ROWID),0) FROM message", -1, &st, nil) == SQLITE_OK else { throw MessagesError.sqlite(String(cString: sqlite3_errmsg(db))) }
        defer { sqlite3_finalize(st) }
        return sqlite3_step(st) == SQLITE_ROW ? sqlite3_column_int64(st, 0) : 0
    }

    static func rows(after last: Int64, limit: Int = batch) throws -> [MessageRow] {
        let db = try open(); defer { sqlite3_close(db) }
        var st: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &st, nil) == SQLITE_OK else { throw MessagesError.sqlite(String(cString: sqlite3_errmsg(db))) }
        defer { sqlite3_finalize(st) }
        sqlite3_bind_int64(st, 1, last); sqlite3_bind_int(st, 2, Int32(limit))
        func str(_ i: Int32) -> String? { sqlite3_column_text(st, i).map { String(cString: $0) } }
        var out: [MessageRow] = []
        while true {
            let rc = sqlite3_step(st)
            if rc == SQLITE_DONE { break }
            guard rc == SQLITE_ROW else { throw MessagesError.sqlite(String(cString: sqlite3_errmsg(db))) }
            out.append(MessageRow(rowid: sqlite3_column_int64(st, 0), guid: str(1) ?? "", text: str(2), attr_hex: str(3), date: str(4) ?? "",
                                  is_from_me: Int(sqlite3_column_int(st, 5)), handle: str(6)))
        }
        return out
    }

    /// One pass: send everything newer than the saved row id. Returns how many rows the server accepted as new.
    static func sync(server: Server, contacts: ContactsResolver?) async throws -> Int {
        guard let last = Prefs.lastRowid else { Prefs.lastRowid = try maxRowid(); return 0 }   // first run: start from now
        var cursor = last, accepted = 0
        while true {
            var rows = try rows(after: cursor)
            if rows.isEmpty { break }
            let lastInBatch = rows.last!.rowid
            if let contacts {
                rows = rows.map { r in
                    guard let h = r.handle, let name = contacts.name(for: h) else { return r }
                    return MessageRow(rowid: r.rowid, guid: r.guid, text: r.text, attr_hex: r.attr_hex, date: r.date, is_from_me: r.is_from_me, handle: "\(name) (\(h))")
                }
            }
            let payload = try JSONSerialization.jsonObject(with: JSONEncoder().encode(rows))
            let resp = try await server.send("POST", "/ingest/mac", json: ["rows": payload])
            let obj = try? JSONSerialization.jsonObject(with: resp) as? [String: Any]
            accepted += (obj?["accepted"] as? NSNumber)?.intValue ?? 0
            cursor = max(cursor, (obj?["maxRowid"] as? NSNumber)?.int64Value ?? 0, lastInBatch)
            Prefs.lastRowid = cursor                        // only after the server confirmed
            if rows.count < batch { break }
        }
        return accepted
    }
}
