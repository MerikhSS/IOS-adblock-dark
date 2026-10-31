// SharedModels.swift — Codable mirrors of the JSON the extension writes
// (background/native-sync.js → state.json) and the app writes (inbox.json).
// Every field is optional/defaulted so schema drift never crashes the app.

import Foundation

struct DarkSettings: Codable, Equatable {
    var defaultOn: Bool? = false
    var engine: String? = "filter"
    var brightness: Int? = 100
    var contrast: Int? = 100
    var sepia: Int? = 0
    var autoNative: Bool? = true
}

struct SiteSetting: Codable, Equatable {
    var dark: String?      // "on" | "off" | nil (default)
    var engine: String?    // "filter" | "dynamic" | nil
}

struct ExtensionSettings: Codable {
    var blockingPaused: Bool?
    var enabledLists: [String]?
    var dark: DarkSettings?
    var sites: [String: SiteSetting]?
    var nativeDark: [String]?
    var allowlist: [String]?
    var customRules: String?
    var hostRevApplied: Int?
    var rev: Int?
}

struct ListInfo: Codable, Identifiable, Equatable {
    var id: String
    var name: String
    var group: String?
    var engine: String?
    var defaultEnabled: Bool?
    var enabled: Bool?
    var webkitCost: Int?
    var dnrRules: Int?
    var builtAt: String?
}

struct Budget: Codable {
    var ok: Bool?
    var cost: Int?
    var budget: Int?
    var hardCap: Int?
}

struct Counts: Codable {
    var network: Int?
    var cosmetic: Int?
    var total: Int { (network ?? 0) + (cosmetic ?? 0) }
}

struct StatsData: Codable {
    var days: [String: Counts]?
    var sites: [String: Counts]?
    var since: String?
}

struct RuleError: Codable, Hashable {
    var line: Int?
    var text: String?
    var reason: String?
}

struct StateErrors: Codable {
    var customRules: [RuleError]?
    var registrations: [String]?
}

/// state.json — snapshot published by the extension.
struct ExtensionState: Codable {
    var schema: Int?
    var extensionVersion: String?
    var generatedAt: String?
    var settings: ExtensionSettings?
    var lists: [ListInfo]?
    var budget: Budget?
    var filtersBuiltAt: String?
    var stats: StatsData?
    var errors: StateErrors?
}

/// inbox.json — edits from the host app. Only non-nil fields are applied.
/// `rev` must increase; the extension records the last applied rev in
/// settings.hostRevApplied.
struct Inbox: Codable {
    var rev: Int = 0
    var enabledLists: [String]?
    var customRules: String?
    var allowlist: [String]?
    var dark: DarkSettings?
    var sites: [String: SiteSetting]?
    var blockingPaused: Bool?
    var resetStats: Bool?
}

/// Content Blocker JSON helpers for the optional overflow blocker.
enum ContentBlockerJSON {
    /// One `ignore-previous-rules` rule that switches the blocker off on allowlisted sites.
    /// Uses `if-top-url` (not `if-domain`) to match what the converter emits (WebKit
    /// rejects lists that mix if-domain and if-top-url).
    static func allowlistRule(hosts: [String]) -> [String: Any]? {
        let patterns = hosts.compactMap { host -> String? in
            let h = host.lowercased().trimmingCharacters(in: .whitespaces)
            guard !h.isEmpty, h.allSatisfy({ $0.isASCII }) else { return nil }
            let escaped = NSRegularExpression.escapedPattern(for: h)
            return "^[^:]+://+([^:/]+\\.)?\(escaped)[:/]"
        }
        guard !patterns.isEmpty else { return nil }
        return ["trigger": ["url-filter": ".*", "if-top-url": patterns],
                "action": ["type": "ignore-previous-rules"]]
    }
}
