import Foundation
import Security

/// Everything the user can configure. The server address and switches live in UserDefaults;
/// the token lives in the Keychain (never in plain preferences or backups).
enum Prefs {
    private static let d = UserDefaults.standard

    static var baseURL: URL? {
        get { d.string(forKey: "baseURL").flatMap { URL(string: $0) } }
        set { d.set(newValue?.absoluteString, forKey: "baseURL") }
    }
    static func bool(_ key: String, default def: Bool) -> Bool { d.object(forKey: key) as? Bool ?? def }

    // Switches (the Settings window binds to the same keys with @AppStorage).
    static let messagesKey = "syncMessages", calendarKey = "syncCalendar", remindersKey = "syncReminders", mirrorKey = "mirrorItems", contactsKey = "useContacts"
    static var syncMessages: Bool { bool(messagesKey, default: true) }
    static var syncCalendar: Bool { bool(calendarKey, default: false) }
    static var syncReminders: Bool { bool(remindersKey, default: false) }      // "Assistant Inbox" list -> assistant
    static var mirrorItems: Bool { bool(mirrorKey, default: false) }           // assistant's reminders/tasks -> "Assistant" list
    static var useContacts: Bool { bool(contactsKey, default: false) }

    /// The last Messages row already sent. Absent on first run, when we start from "now" and never back-process history.
    static var lastRowid: Int64? {
        get { d.object(forKey: "lastRowid") as? Int64 }
        set { d.set(newValue, forKey: "lastRowid") }
    }

    /// Identifies this Mac to the server (the "Connected Macs" list). Made once, kept in preferences.
    static var clientId: String {
        if let id = d.string(forKey: "clientId") { return id }
        let id = UUID().uuidString.lowercased(); d.set(id, forKey: "clientId"); return id
    }
    /// Why the last self-update failed; reported to the server on the next check-in, then cleared.
    static var updateError: String? {
        get { d.string(forKey: "updateError") }
        set { d.set(newValue, forKey: "updateError") }
    }
    /// The app version that last tried to update; an attempt that left the version unchanged failed, so don't repeat it for a while.
    static var lastUpdateFrom: String? {
        get { d.string(forKey: "lastUpdateFrom") }
        set { d.set(newValue, forKey: "lastUpdateFrom") }
    }
    static var lastUpdateAttempt: Date {
        get { d.object(forKey: "lastUpdateAttempt") as? Date ?? .distantPast }
        set { d.set(newValue, forKey: "lastUpdateAttempt") }
    }

    private static let account = "assistant-token"
    static var token: String {
        get {
            let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: account,
                                    kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
            var out: AnyObject?
            guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return "" }
            return String(data: data, encoding: .utf8) ?? ""
        }
        set {
            let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: account]
            SecItemDelete(base as CFDictionary)
            guard !newValue.isEmpty else { return }
            var add = base
            add[kSecValueData as String] = Data(newValue.utf8)
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            SecItemAdd(add as CFDictionary, nil)
        }
    }

    /// Small JSON files (sent-event keys, reminder mapping) live here.
    static var supportDir: URL {
        let u = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Assistant", isDirectory: true)
        try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        return u
    }
}

extension URL {
    /// Accepts "host:8090", "http://host:8090/" etc. and returns a clean base URL, or nil if it can't be one.
    static func serverAddress(_ raw: String) -> URL? {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        while s.hasSuffix("/") { s.removeLast() }
        if s.isEmpty { return nil }
        if !s.contains("://") { s = "http://" + s }
        guard let u = URL(string: s), let scheme = u.scheme, ["http", "https"].contains(scheme), u.host != nil else { return nil }
        return u
    }
}

/// What the web UI's "Copy config" puts on the clipboard: `assistant-config:` + base64 of {"v":1,"url":…,"token":…}.
struct ConnectionConfig {
    let url: URL, token: String

    static func parse(_ raw: String) -> ConnectionConfig? {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("assistant-config:") { s.removeFirst("assistant-config:".count) }
        let data: Data?
        if s.hasPrefix("{") { data = Data(s.utf8) }
        else {
            var b = s.filter { !$0.isWhitespace }.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
            while b.count % 4 != 0 { b += "=" }
            data = Data(base64Encoded: b)
        }
        guard let data, let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let u = o["url"] as? String, let url = URL.serverAddress(u),
              let t = (o["token"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty else { return nil }
        return ConnectionConfig(url: url, token: t)
    }
}
