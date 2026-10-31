import SwiftUI

struct SetupView: View {
    @EnvironmentObject var store: SharedStore

    var body: some View {
        NavigationStack {
            List {
                Section {
                    statusRow("Safari extension",
                              value: store.extensionEnabled.map { $0 ? "Enabled" : "Turned off" } ?? (store.state != nil ? "Active" : "Not seen yet"),
                              ok: store.extensionEnabled ?? (store.state != nil))
                    statusRow("App ↔ extension sync",
                              value: store.appGroupAvailable ? (store.state?.generatedAt.map(Self.relative) ?? "Waiting for Safari") : "Unavailable (free account?)",
                              ok: store.appGroupAvailable && store.state != nil)
                    if let b = store.state?.budget, let cost = b.cost, let cap = b.hardCap {
                        statusRow("Rule budget", value: "\(cost.formatted()) / \(cap.formatted())", ok: b.ok ?? true)
                    }
                    ForEach(AppGroup.overflowIdentifiers, id: \.self) { id in
                        statusRow("Overflow blocker", value: (store.overflowEnabled[id] ?? false) ? "Enabled" : "Turned off", ok: store.overflowEnabled[id] ?? false)
                    }
                } header: { Text("Status") }

                Section {
                    Button {
                        store.openSafariExtensionSettings()
                    } label: {
                        Label("Open Safari Extensions settings", systemImage: "gear")
                    }
                    step(1, "Turn on **AdBlock Dark** in Settings › Apps › Safari › Extensions.")
                    step(2, "Tap **AdBlock Dark** there and set **All Websites** (or “Other Websites”) to **Allow**. Blocking works without this, but element hiding, scriptlets and dark mode need it.")
                    step(3, "Optionally allow it in **Private Browsing**.")
                    step(4, "In Safari, tap the **puzzle-piece / ᴀA** icon in the address bar › AdBlock Dark to toggle blocking or dark mode per site.")
                    step(5, "Visit any site once so the extension can publish its state here.")
                } header: { Text("Enable in Safari") } footer: {
                    Text("The first launch after an install or rebuild takes a few seconds while Safari compiles about 120,000 rules.")
                }

                Section {
                    step(1, "Free Apple ID builds expire after 7 days. Re-run from Xcode weekly (your settings are kept).")
                    step(2, "Before re-running, refresh filter lists on your Mac: `make lists`.")
                    step(3, "If the app won't open: Settings › General › VPN & Device Management › trust your developer profile.")
                } header: { Text("Weekly maintenance") }

                Section {
                    Toggle("Pause all blocking", isOn: Binding(get: { store.effectivePaused }, set: { store.setPaused($0) }))
                    SyncBanner()
                }
            }
            .navigationTitle("AdBlock Dark")
            .refreshable { store.reload() }
        }
    }

    private func statusRow(_ title: String, value: String, ok: Bool) -> some View {
        HStack {
            Image(systemName: ok ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                .foregroundStyle(ok ? .green : .orange)
            Text(title)
            Spacer()
            Text(value).foregroundStyle(.secondary).multilineTextAlignment(.trailing)
        }
    }

    private func step(_ n: Int, _ text: LocalizedStringKey) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text("\(n)").font(.caption.bold()).frame(width: 20, height: 20).background(Circle().fill(Color.accentColor.opacity(0.2)))
            Text(text)
        }
    }

    static func relative(_ iso: String) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let d = f.date(from: iso) else { return iso }
        return "Synced " + d.formatted(.relative(presentation: .named))
    }
}
