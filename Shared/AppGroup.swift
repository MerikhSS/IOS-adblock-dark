// AppGroup.swift — compiled into the host app, the Safari web extension and the
// optional overflow Content Blocker. Everything the three processes share
// lives in the App Group container as small JSON files.
//
//   state.json               written by the extension (via SafariWebExtensionHandler), read by the app
//   inbox.json               written by the app, read (and applied) by the extension
//   overflow-allowlist.json  allowlisted hosts, read by the overflow Content Blocker
//
// FREE APPLE ID NOTE: App Groups are scoped to your (personal) team. If Xcode
// refuses to register the group with a free account, everything still works
// except host-app management: use the extension's Settings page instead.

import Foundation
import os.log

enum AppGroup {
    static let log = Logger(subsystem: "AdBlockDark", category: "AppGroup")

    /// Read from Info.plist key `ABDAppGroupIdentifier` (set via build settings).
    static var identifier: String? {
        guard let id = Bundle.main.object(forInfoDictionaryKey: "ABDAppGroupIdentifier") as? String,
              !id.isEmpty, !id.contains("$(") else { return nil }
        return id
    }

    static var containerURL: URL? {
        guard let id = identifier else { return nil }
        return FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: id)
    }

    static var isAvailable: Bool { containerURL != nil }

    static func url(_ name: String) -> URL? { containerURL?.appendingPathComponent(name) }

    static func readData(_ name: String) -> Data? {
        guard let u = url(name) else { return nil }
        return try? Data(contentsOf: u)
    }

    @discardableResult
    static func write(_ data: Data, to name: String) -> Bool {
        guard let u = url(name) else { return false }
        do {
            try data.write(to: u, options: .atomic)
            return true
        } catch {
            log.error("write \(name, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    static let stateFile = "state.json"
    static let inboxFile = "inbox.json"
    static let overflowAllowlistFile = "overflow-allowlist.json"

    /// Bundle identifiers, from Info.plist (so they follow your bundle prefix).
    static var extensionIdentifier: String? {
        Bundle.main.object(forInfoDictionaryKey: "ABDExtensionIdentifier") as? String
    }
    static var overflowIdentifiers: [String] {
        (Bundle.main.object(forInfoDictionaryKey: "ABDOverflowIdentifiers") as? [String] ?? [])
            .filter { !$0.isEmpty && !$0.contains("$(") }
    }
}
