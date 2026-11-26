import Foundation

enum ServerError: LocalizedError {
    case notConfigured, unauthorized, forbidden(String), http(Int, String), network(String)
    var errorDescription: String? {
        switch self {
        case .notConfigured: return "Enter the server address and token in Settings."
        case .unauthorized: return "The server rejected the token."
        case .forbidden(let what): return "\(what) needs the full ASSISTANT_TOKEN (the send-only ingest token isn't enough)."
        case .http(let code, let msg): return "Server said \(code): \(msg)"
        case .network(let m): return "Can't reach the server (\(m)). Is Tailscale connected?"
        }
    }
}

/// Thin client for the assistant's HTTP API (docs/api.md).
struct Server {
    let base: URL, token: String

    static func current() throws -> Server {
        guard let base = Prefs.baseURL, !Prefs.token.isEmpty else { throw ServerError.notConfigured }
        return Server(base: base, token: Prefs.token)
    }

    private func request(_ method: String, _ path: String, body: Data? = nil, timeout: TimeInterval = 30) -> URLRequest {
        var r = URLRequest(url: URL(string: path, relativeTo: base)!.absoluteURL, timeoutInterval: timeout)
        r.httpMethod = method
        r.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        if let body { r.httpBody = body; r.setValue("application/json", forHTTPHeaderField: "content-type") }
        return r
    }

    /// `needsFullToken` names the feature in the error shown when the ingest-only token gets a 401.
    @discardableResult
    func send(_ method: String, _ path: String, json: Any? = nil, needsFullToken: String? = nil, timeout: TimeInterval = 30) async throws -> Data {
        let body = try json.map { try JSONSerialization.data(withJSONObject: $0) }
        do {
            let (data, resp) = try await URLSession.shared.data(for: request(method, path, body: body, timeout: timeout))
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            if (200..<300).contains(code) { return data }
            if code == 401 { throw needsFullToken.map(ServerError.forbidden) ?? ServerError.unauthorized }
            let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String ?? HTTPURLResponse.localizedString(forStatusCode: code)
            throw ServerError.http(code, msg)
        } catch let e as ServerError { throw e }
        catch { throw ServerError.network((error as NSError).localizedDescription) }
    }

    func get(_ path: String, needsFullToken: String? = nil) async throws -> Data { try await send("GET", path, needsFullToken: needsFullToken) }

    /// Works with either token, so it's the connection test: a batch of zero Mac rows.
    func ping() async throws { try await send("POST", "/ingest/mac", json: ["rows": [Any]()], timeout: 10) }

    struct CheckIn { let updateRequested: Bool, latestVersion: String? }

    /// Tells the server this Mac is alive and which version it runs; the answer says whether someone asked it to update.
    /// Works with either token. A server too old to know the route just yields nil.
    func checkIn(updateError: String?) async -> CheckIn? {
        let host = Host.current().localizedName ?? ProcessInfo.processInfo.hostName
        let v = ProcessInfo.processInfo.operatingSystemVersion
        var body: [String: Any] = ["id": Prefs.clientId, "name": host, "version": SyncEngine.appVersion, "os": "macOS \(v.majorVersion).\(v.minorVersion)"]
        if let updateError { body["updateError"] = updateError }
        guard let data = try? await send("POST", "/app/mac/heartbeat", json: body, timeout: 15),
              let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        let latest = (o["latest"] as? [String: Any]).flatMap { $0["available"] as? Bool == true ? $0["version"] as? String : nil }
        return CheckIn(updateRequested: o["updateRequested"] as? Bool ?? false, latestVersion: latest)
    }

    /// Free text from you (Capture box, Shortcuts, "Assistant Inbox" reminders): treated as your own words.
    func ingest(source: String, sourceId: String, sender: String, subject: String = "", body: String, receivedAt: Date = Date()) async throws {
        try await send("POST", "/ingest/message", json: [
            "source": source, "sourceId": sourceId, "sender": sender, "subject": subject, "body": body,
            "receivedAt": ISO8601DateFormatter().string(from: receivedAt),
        ])
    }

    func ask(_ question: String) async throws -> String {
        let data = try await send("POST", "/ask", json: ["question": question], needsFullToken: "Asking questions", timeout: 200)
        return ((try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["answer"] as? String) ?? ""
    }
}
