import SwiftUI

struct CustomRulesView: View {
    @EnvironmentObject var store: SharedStore
    @State private var text = ""
    @State private var loaded = false
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextEditor(text: $text)
                        .font(.system(.footnote, design: .monospaced))
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .frame(minHeight: 260)
                        .focused($focused)
                } header: {
                    Text("My filters")
                } footer: {
                    Text("""
                    uBlock Origin / AdBlock syntax, one per line:
                    ||ads.example.com^            block a domain
                    example.com##.banner          hide an element
                    @@||example.com^$document     allow a whole site
                    example.com##+js(set-constant, adsOn, false)
                    """).font(.system(.caption2, design: .monospaced))
                }

                Section {
                    Button("Save") {
                        store.setCustomRules(text)
                        focused = false
                    }
                    .disabled(text == store.effectiveCustomRules)
                    SyncBanner()
                }

                if let errors = store.state?.errors?.customRules, !errors.isEmpty, !store.hasPendingEdits {
                    Section("Problems reported by Safari") {
                        ForEach(errors, id: \.self) { e in
                            VStack(alignment: .leading) {
                                Text(e.line.map { "Line \($0)" } ?? "Rules").font(.caption.bold())
                                Text(e.reason ?? "").font(.caption)
                                if let t = e.text, !t.isEmpty { Text(t).font(.system(.caption2, design: .monospaced)).foregroundStyle(.secondary) }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Custom rules")
            .toolbar {
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") { focused = false }
                }
            }
            .onAppear {
                if !loaded { text = store.effectiveCustomRules; loaded = true }
            }
        }
    }
}
