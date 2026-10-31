// SharedStore.swift — the host app's view of the extension.
//
// Reads state.json (published by the extension) and writes inbox.json (edits).
// Edits are applied by the extension the next time its background page wakes
// (any page load in Safari, or opening the extension popup), so the UI shows
// "pending" until state.settings.hostRevApplied catches up.

import Foundation
import SafariServices
import SwiftUI

@MainActor
final class SharedStore: ObservableObject {
    @Published private(set) var state: ExtensionState?
    @Published private(set) var inbox: Inbox = Inbox()
    @Published private(set) var lastLoaded: Date?
    @Published var lastError: String?
    @Published private(set) var extensionEnabled: Bool?
    @Published private(set) var overflowEnabled: [String: Bool] = [:]

    let appGroupAvailable = AppGroup.isAvailable

    private var timer: Timer?

    init() { reload() }

    // MARK: - loading

    func reload() {
        if let data = AppGroup.readData(AppGroup.stateFile) {
            do {
                state = try JSONDecoder().decode(ExtensionState.self, from: data)
                lastError = nil
            } catch {
                lastError = "Couldn't read extension state: \(error.localizedDescription)"
            }
        }
        if let data = AppGroup.readData(AppGroup.inboxFile), let i = try? JSONDecoder().decode(Inbox.self, from: data) {
            inbox = i
        }
        lastLoaded = Date()
        refreshExtensionStates()
    }

    func startPolling() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.reload() }
        }
    }

    func stopPolling() {
        timer?.invalidate()
        timer = nil
    }

    func refreshExtensionStates() {
        if #available(iOS 26.2, *), let id = AppGroup.extensionIdentifier {
            Task {
                let enabled = try? await SFSafariExtensionManager.stateOfExtension(withIdentifier: id).isEnabled
                self.extensionEnabled = enabled
            }
        }
        for id in AppGroup.overflowIdentifiers {
            SFContentBlockerManager.getStateOfContentBlocker(withIdentifier: id) { state, _ in
                let on = state?.isEnabled ?? false
                Task { @MainActor in self.overflowEnabled[id] = on }
            }
        }
    }

    // MARK: - derived

    var settings: ExtensionSettings { state?.settings ?? ExtensionSettings() }
    var appliedRev: Int { settings.hostRevApplied ?? 0 }
    var hasPendingEdits: Bool { inbox.rev > appliedRev }

    /// Values shown in the UI: pending inbox edits win over the last published state.
    var effectiveEnabledLists: [String] {
        if hasPendingEdits, let l = inbox.enabledLists { return l }
        return (state?.lists ?? []).filter { $0.enabled == true }.map(\.id)
    }
    var effectiveAllowlist: [String] {
        if hasPendingEdits, let a = inbox.allowlist { return a }
        return settings.allowlist ?? []
    }
    var effectiveCustomRules: String {
        if hasPendingEdits, let r = inbox.customRules { return r }
        return settings.customRules ?? ""
    }
    var effectiveDark: DarkSettings {
        if hasPendingEdits, let d = inbox.dark { return d }
        return settings.dark ?? DarkSettings()
    }
    var effectiveSites: [String: SiteSetting] {
        if hasPendingEdits, let s = inbox.sites { return s }
        return settings.sites ?? [:]
    }
    var effectivePaused: Bool {
        if hasPendingEdits, let p = inbox.blockingPaused { return p }
        return settings.blockingPaused ?? false
    }

    // MARK: - editing

    private func edit(_ change: (inout Inbox) -> Void) {
        var next = hasPendingEdits ? inbox : Inbox()
        next.rev = max(inbox.rev, appliedRev) + 1
        change(&next)
        do {
            let data = try JSONEncoder().encode(next)
            guard AppGroup.write(data, to: AppGroup.inboxFile) else {
                lastError = "App Group not available — use the extension's Settings page in Safari instead."
                return
            }
            inbox = next
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
    }

    func setList(_ id: String, enabled: Bool) {
        var lists = Set(effectiveEnabledLists)
        if enabled { lists.insert(id) } else { lists.remove(id) }
        let ordered = (state?.lists ?? []).map(\.id).filter { lists.contains($0) }
        edit { $0.enabledLists = ordered }
    }

    func projectedCost(withLists ids: [String]) -> Int {
        (state?.lists ?? []).filter { ids.contains($0.id) }.reduce(0) { $0 + ($1.webkitCost ?? 0) }
    }

    func setCustomRules(_ text: String) { edit { $0.customRules = text } }

    func setAllowlist(_ hosts: [String]) {
        let cleaned = Array(Set(hosts.map(Self.normalizeHost).filter { !$0.isEmpty })).sorted()
        edit { $0.allowlist = cleaned }
        writeOverflowAllowlist(cleaned)
    }

    func setDark(_ dark: DarkSettings) { edit { $0.dark = dark } }

    func setSites(_ sites: [String: SiteSetting]) { edit { $0.sites = sites } }

    func setPaused(_ paused: Bool) { edit { $0.blockingPaused = paused } }

    func resetStats() { edit { $0.resetStats = true } }

    static func normalizeHost(_ input: String) -> String {
        var s = input.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if let u = URL(string: s), let h = u.host { s = h }
        if s.hasPrefix("www.") { s.removeFirst(4) }
        return s.trimmingCharacters(in: CharacterSet(charactersIn: "/."))
    }

    // MARK: - overflow content blocker

    private func writeOverflowAllowlist(_ hosts: [String]) {
        guard !AppGroup.overflowIdentifiers.isEmpty else { return }
        let payload: [String: Any] = ["hosts": hosts, "paused": effectivePaused]
        if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) {
            AppGroup.write(data, to: AppGroup.overflowAllowlistFile)
        }
        reloadOverflowBlockers()
    }

    func reloadOverflowBlockers() {
        for id in AppGroup.overflowIdentifiers {
            SFContentBlockerManager.reloadContentBlocker(withIdentifier: id) { error in
                if let error {
                    Task { @MainActor in self.lastError = "Reload \(id): \(error.localizedDescription)" }
                }
            }
        }
    }

    // MARK: - settings deep link (iOS 26+)

    func openSafariExtensionSettings() {
        var ids: [String] = []
        if let e = AppGroup.extensionIdentifier { ids.append(e) }
        ids += AppGroup.overflowIdentifiers
        SFSafariSettings.openExtensionsSettings(forIdentifiers: ids) { error in
            if let error {
                Task { @MainActor in
                    self.lastError = "Couldn't open Safari settings (\(error.localizedDescription)). Open Settings › Apps › Safari › Extensions manually."
                }
            }
        }
    }
}
