// AdBlockDarkApp.swift — SwiftUI host app.

import SwiftUI

@main
struct AdBlockDarkApp: App {
    @StateObject private var store = SharedStore()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(store)
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active {
                        store.reload()
                        store.startPolling()
                    } else {
                        store.stopPolling()
                    }
                }
        }
    }
}

struct ContentView: View {
    @EnvironmentObject var store: SharedStore

    var body: some View {
        TabView {
            Tab("Setup", systemImage: "checklist") { SetupView() }
            Tab("Lists", systemImage: "list.bullet.rectangle") { ListsView() }
            Tab("Rules", systemImage: "chevron.left.forwardslash.chevron.right") { CustomRulesView() }
            Tab("Allowlist", systemImage: "hand.raised") { AllowlistView() }
            Tab("Dark", systemImage: "moon") { DarkModeView() }
            Tab("Stats", systemImage: "chart.bar") { StatsView() }
        }
    }
}

/// Banner shown on management screens when edits haven't reached the extension yet.
struct SyncBanner: View {
    @EnvironmentObject var store: SharedStore

    var body: some View {
        if !store.appGroupAvailable {
            Label("App Group unavailable — manage everything from the extension's Settings page in Safari (popup › All settings).", systemImage: "exclamationmark.triangle")
                .font(.footnote)
                .foregroundStyle(.orange)
        } else if store.state == nil {
            Label("No data from the extension yet. Enable it in Safari and open any web page.", systemImage: "hourglass")
                .font(.footnote)
                .foregroundStyle(.secondary)
        } else if store.hasPendingEdits {
            Label("Saved. Applies the next time Safari loads a page (or open the extension popup).", systemImage: "arrow.triangle.2.circlepath")
                .font(.footnote)
                .foregroundStyle(.blue)
        }
        if let err = store.lastError {
            Text(err).font(.footnote).foregroundStyle(.red)
        }
    }
}
