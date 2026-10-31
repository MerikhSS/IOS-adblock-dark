// ContentBlockerRequestHandler.swift — OPTIONAL overflow Content Blocker.
// Only needed if you enable more filter lists than fit in the Safari web
// extension's ~150k-rule budget (set a list's "engine" to "contentBlocker"
// in filters/lists.json, then `make lists`).
//
// Safari asks this extension for its rules when it is enabled or reloaded
// (SFContentBlockerManager.reloadContentBlocker). We return the bundled
// blockerList.json plus a final allowlist rule built from the App Group.

import Foundation
import os.log

final class ContentBlockerRequestHandler: NSObject, NSExtensionRequestHandling {
    private let log = Logger(subsystem: "AdBlockDark", category: "Overflow")

    func beginRequest(with context: NSExtensionContext) {
        let item = NSExtensionItem()
        if let url = buildRulesFile() {
            item.attachments = [NSItemProvider(contentsOf: url)].compactMap { $0 }
        }
        context.completeRequest(returningItems: [item], completionHandler: nil)
    }

    /// Returns a URL to the JSON Safari should compile.
    private func buildRulesFile() -> URL? {
        guard let bundled = Bundle.main.url(forResource: "blockerList", withExtension: "json") else {
            log.error("blockerList.json missing from bundle")
            return nil
        }

        // Without App Group data we serve the bundled list unchanged.
        guard let allowData = AppGroup.readData(AppGroup.overflowAllowlistFile),
              let allow = try? JSONSerialization.jsonObject(with: allowData) as? [String: Any] else {
            return bundled
        }
        let paused = allow["paused"] as? Bool ?? false
        let hosts = allow["hosts"] as? [String] ?? []

        do {
            var rules: [Any]
            if paused {
                // Safari needs at least one rule; this one never matches.
                rules = [["trigger": ["url-filter": "^abd-paused:"], "action": ["type": "block"]]]
            } else {
                rules = try JSONSerialization.jsonObject(with: Data(contentsOf: bundled)) as? [Any] ?? []
                if let allowRule = ContentBlockerJSON.allowlistRule(hosts: hosts) { rules.append(allowRule) }
            }
            let data = try JSONSerialization.data(withJSONObject: rules)
            let out = FileManager.default.temporaryDirectory.appendingPathComponent("blockerList-merged.json")
            try data.write(to: out, options: .atomic)
            return out
        } catch {
            log.error("merging allowlist failed: \(error.localizedDescription, privacy: .public)")
            return bundled
        }
    }
}
