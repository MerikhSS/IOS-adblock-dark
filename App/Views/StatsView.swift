import Charts
import SwiftUI

struct StatsView: View {
    @EnvironmentObject var store: SharedStore

    private struct DayPoint: Identifiable {
        let id: String
        let date: Date
        let kind: String
        let value: Int
    }

    private var points: [DayPoint] {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        let days = store.state?.stats?.days ?? [:]
        return days.sorted { $0.key < $1.key }.suffix(14).flatMap { key, c -> [DayPoint] in
            guard let d = f.date(from: key) else { return [] }
            return [DayPoint(id: key + "n", date: d, kind: "Requests", value: c.network ?? 0),
                    DayPoint(id: key + "c", date: d, kind: "Elements", value: c.cosmetic ?? 0)]
        }
    }

    private var totals: (Int, Int) {
        let days = store.state?.stats?.days ?? [:]
        return days.values.reduce((0, 0)) { ($0.0 + ($1.network ?? 0), $0.1 + ($1.cosmetic ?? 0)) }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack {
                        stat("Requests blocked", totals.0)
                        Divider()
                        stat("Elements hidden", totals.1)
                    }
                    if !points.isEmpty {
                        Chart(points) { p in
                            BarMark(x: .value("Day", p.date, unit: .day), y: .value("Count", p.value))
                                .foregroundStyle(by: .value("Kind", p.kind))
                        }
                        .frame(height: 180)
                    }
                } header: { Text("Last 30 days") } footer: {
                    Text("Counts come from Safari's matched-rule feedback plus the extension's site-specific element hiding. Generic element hiding and the overflow Content Blocker don't report counts.")
                }

                Section("Top sites") {
                    let sites = (store.state?.stats?.sites ?? [:]).sorted { $0.value.total > $1.value.total }.prefix(30)
                    if sites.isEmpty { Text("Nothing yet").foregroundStyle(.secondary) }
                    ForEach(Array(sites), id: \.key) { host, c in
                        HStack {
                            Text(host).lineLimit(1)
                            Spacer()
                            Text("\(c.network ?? 0) req · \(c.cosmetic ?? 0) el").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }

                Section {
                    Button("Reset stats", role: .destructive) { store.resetStats() }
                    SyncBanner()
                }
            }
            .navigationTitle("Stats")
            .refreshable { store.reload() }
        }
    }

    private func stat(_ title: String, _ value: Int) -> some View {
        VStack {
            Text(value.formatted()).font(.title2.bold())
            Text(title).font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }
}
