import SwiftUI

@main
struct AssistantApp: App {
    @ObservedObject private var engine = SyncEngine.shared

    init() {
        Task { @MainActor in
            SyncEngine.shared.start()
            if SyncEngine.shared.needsSetup { NSApp.activate(ignoringOtherApps: true) }
        }
    }

    var body: some Scene {
        MenuBarExtra {
            MenuView()
        } label: {
            Image(systemName: icon)
        }
        .menuBarExtraStyle(.window)

        Settings { SettingsView() }
    }

    /// The menu-bar glyph doubles as a health light.
    private var icon: String {
        let states = [engine.connection.state, engine.messages.state, engine.calendar.state, engine.reminders.state]
        if states.contains(where: { if case .error = $0 { return true }; if case .needsPermission = $0 { return !engine.needsSetup }; return false }) { return "exclamationmark.bubble" }
        return engine.update != nil ? "arrow.down.circle" : "checkmark.bubble"
    }
}
