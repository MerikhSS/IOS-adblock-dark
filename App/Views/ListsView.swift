import SwiftUI

struct ListsView: View {
    @EnvironmentObject var store: SharedStore
    @State private var budgetAlert: String?

    private var grouped: [(String, [ListInfo])] {
        let lists = store.state?.lists ?? []
        let order = ["ads", "privacy", "security", "regional", "annoyances"]
        let groups = Dictionary(grouping: lists, by: { $0.group ?? "other" })
        return groups.sorted { (order.firstIndex(of: $0.key) ?? 99) < (order.firstIndex(of: $1.key) ?? 99) }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    budgetView
                    SyncBanner()
                }
                ForEach(grouped, id: \.0) { group, lists in
                    Section(group.capitalized) {
                        ForEach(lists) { list in
                            Toggle(isOn: Binding(
                                get: { store.effectiveEnabledLists.contains(list.id) },
                                set: { on in toggle(list, on) })) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(list.name)
                                    Text("\((list.dnrRules ?? 0).formatted()) rules → \((list.webkitCost ?? 0).formatted()) Safari rules" + (list.engine == "contentBlocker" ? " · overflow blocker" : ""))
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                            }
                            .disabled(list.engine != "dnr")
                        }
                    }
                }
                if let built = store.state?.filtersBuiltAt {
                    Section {
                        Text("Filter lists were converted on \(built). To update them, run `make lists` on your Mac and rebuild in Xcode.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Filter lists")
            .refreshable { store.reload() }
            .alert("Over the rule budget", isPresented: Binding(get: { budgetAlert != nil }, set: { if !$0 { budgetAlert = nil } })) {
                Button("OK", role: .cancel) {}
            } message: { Text(budgetAlert ?? "") }
        }
    }

    private var budgetView: some View {
        let cost = store.projectedCost(withLists: store.effectiveEnabledLists)
        let cap = store.state?.budget?.hardCap ?? 150_000
        let soft = store.state?.budget?.budget ?? 135_000
        return VStack(alignment: .leading, spacing: 6) {
            ProgressView(value: Double(min(cost, cap)), total: Double(cap))
                .tint(cost > soft ? .orange : .green)
            Text("\(cost.formatted()) of \(cap.formatted()) Safari rules. Safari compiles every enabled list into one rule list; past the cap it blocks nothing.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private func toggle(_ list: ListInfo, _ on: Bool) {
        if on {
            let next = store.effectiveEnabledLists + [list.id]
            let soft = store.state?.budget?.budget ?? 135_000
            let cost = store.projectedCost(withLists: next)
            if cost > soft + 10_000 {
                budgetAlert = "Enabling \(list.name) would need \(cost.formatted()) Safari rules. Turn another list off first, or move this list to the overflow Content Blocker (see docs/ARCHITECTURE.md)."
                return
            }
        }
        store.setList(list.id, enabled: on)
    }
}
