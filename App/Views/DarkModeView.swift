import SwiftUI

struct DarkModeView: View {
    @EnvironmentObject var store: SharedStore
    @State private var draft = DarkSettings()
    @State private var loaded = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Toggle("Dark mode on every site by default", isOn: bind(\.defaultOn, false))
                    Picker("Engine", selection: Binding(get: { draft.engine ?? "filter" }, set: { draft.engine = $0; save() })) {
                        Text("Filter (fast)").tag("filter")
                        Text("Dynamic (Dark Reader)").tag("dynamic")
                    }
                    Toggle("Skip sites that are already dark", isOn: bind(\.autoNative, true))
                } footer: {
                    Text("Filter inverts the page and re-inverts photos and videos. It's instant, with no white flash, but occasionally imperfect. Dynamic recolors each site's styles (Dark Reader engine). It looks better but is heavier. You can choose per site in the Safari popup.")
                }

                Section("Fine-tuning") {
                    slider("Brightness", \.brightness, 100, 50...150)
                    slider("Contrast", \.contrast, 100, 50...150)
                    slider("Sepia", \.sepia, 0, 0...100)
                }

                Section("Per-site overrides") {
                    let sites = store.effectiveSites.sorted { $0.key < $1.key }
                    if sites.isEmpty { Text("None yet. Use the Safari popup on a site.").foregroundStyle(.secondary) }
                    ForEach(sites, id: \.key) { host, s in
                        HStack {
                            Text(host)
                            Spacer()
                            Text([s.dark.map { "dark \($0)" }, s.engine].compactMap { $0 }.joined(separator: " · "))
                                .foregroundStyle(.secondary)
                        }
                    }
                    .onDelete { idx in
                        var next = store.effectiveSites
                        for i in idx { next.removeValue(forKey: sites[i].key) }
                        store.setSites(next)
                    }
                }
                Section { SyncBanner() }
            }
            .navigationTitle("Dark mode")
            .onAppear {
                if !loaded { draft = store.effectiveDark; loaded = true }
            }
        }
    }

    private func bind(_ kp: WritableKeyPath<DarkSettings, Bool?>, _ def: Bool) -> Binding<Bool> {
        Binding(get: { draft[keyPath: kp] ?? def }, set: { draft[keyPath: kp] = $0; save() })
    }

    private func slider(_ title: String, _ kp: WritableKeyPath<DarkSettings, Int?>, _ def: Int, _ range: ClosedRange<Double>) -> some View {
        VStack(alignment: .leading) {
            Text("\(title): \(draft[keyPath: kp] ?? def)%")
            Slider(value: Binding(get: { Double(draft[keyPath: kp] ?? def) },
                                  set: { draft[keyPath: kp] = Int($0.rounded()) }),
                   in: range, step: 5,
                   onEditingChanged: { editing in if !editing { save() } })
        }
    }

    private func save() { store.setDark(draft) }
}
