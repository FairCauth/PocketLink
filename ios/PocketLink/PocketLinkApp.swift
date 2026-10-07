import SwiftUI

@main
struct PocketLinkApp: App {
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var phase
    var body: some Scene {
        WindowGroup {
            ContentView(model: model)
                .preferredColorScheme(.dark)
                .onChange(of: phase) { phase in
                    if phase == .background { model.enteredBackground() }
                    if phase == .active { model.enteredForeground() }
                }
        }
    }
}
