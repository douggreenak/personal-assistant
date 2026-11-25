import AppIntents

/// Shortcuts / Siri / Spotlight actions, so "Capture to Assistant" works from anywhere on the Mac (and from automations).
struct CaptureIntent: AppIntent {
    static var title: LocalizedStringResource = "Capture to Assistant"
    static var description = IntentDescription("Sends a note, task or reminder in your own words to your assistant.")
    static var openAppWhenRun = false

    @Parameter(title: "Text", requestValueDialog: "What should I tell your assistant?") var text: String

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return .result(dialog: "Nothing to send.") }
        try await Server.current().ingest(source: "mac-app", sourceId: UUID().uuidString, sender: "me", body: t)
        return .result(dialog: "Sent to your assistant.")
    }
}

struct AskIntent: AppIntent {
    static var title: LocalizedStringResource = "Ask Assistant"
    static var description = IntentDescription("Asks your assistant a question about your messages, items and files. Needs the full token.")
    static var openAppWhenRun = false

    @Parameter(title: "Question", requestValueDialog: "What do you want to know?") var question: String

    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        let a = try await Server.current().ask(question)
        return .result(value: a, dialog: IntentDialog(stringLiteral: a))
    }
}

struct AssistantShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: CaptureIntent(), phrases: ["Capture to \(.applicationName)", "Tell \(.applicationName) something"], shortTitle: "Capture", systemImageName: "text.bubble")
        AppShortcut(intent: AskIntent(), phrases: ["Ask \(.applicationName)"], shortTitle: "Ask", systemImageName: "questionmark.bubble")
    }
}
