import SwiftUI

@main
struct CaptureApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @StateObject private var queue = UploadQueue.shared
    @StateObject private var recorder = Recorder()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(queue)
                .environmentObject(recorder)
                .task { PhoneLink.shared.activate(); queue.start() }
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    /// iOS relaunches the app in the background to finish uploads; it hands us a completion handler to call when done.
    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String,
                     completionHandler: @escaping () -> Void) {
        UploadQueue.shared.backgroundCompletion = completionHandler
    }
}
