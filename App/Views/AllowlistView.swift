import SwiftUI

struct AllowlistView: View {
    @EnvironmentObject var store: SharedStore
    @State private var newHost = ""

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack {
                        TextField("example.com", text: $newHost)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.URL)
                            .onSubmit(add)
                        Button("Add", action: add).disabled(SharedStore.normalizeHost(newHost).isEmpty)
                    }
                } footer: {
                    Text("Blocking, element hiding and scriptlets are turned off on these sites and their subdomains. Dark mode is separate. Tip: the Safari popup toggles this for the current site in one tap.")
                }

                Section("Allowlisted sites") {
                    if store.effectiveAllowlist.isEmpty {
                        Text("None").foregroundStyle(.secondary)
                    }
                    ForEach(store.effectiveAllowlist, id: \.self) { host in
                        Text(host)
                    }
                    .onDelete { idx in
                        var list = store.effectiveAllowlist
                        list.remove(atOffsets: idx)
                        store.setAllowlist(list)
                    }
                }
                Section { SyncBanner() }
            }
            .navigationTitle("Allowlist")
            .toolbar { EditButton() }
            .refreshable { store.reload() }
        }
    }

    private func add() {
        let h = SharedStore.normalizeHost(newHost)
        guard !h.isEmpty else { return }
        store.setAllowlist(store.effectiveAllowlist + [h])
        newHost = ""
    }
}
