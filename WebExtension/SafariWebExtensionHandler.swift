// SafariWebExtensionHandler.swift — native side of the Safari web extension.
// JavaScript calls browser.runtime.sendNativeMessage("application.id", {...});
// Safari launches this extension process and delivers the message here.
//
// Messages:
//   {type:"sync", state:{...}}  → write state.json, return {ok, appGroup, inbox}
//   {type:"probe"}              → report App Group + content-blocker capabilities

import SafariServices
import os.log

final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    private let log = Logger(subsystem: "AdBlockDark", category: "NativeHandler")

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem
        let message = request?.userInfo?[SFExtensionMessageKey] as? [String: Any] ?? [:]
        let type = message["type"] as? String ?? ""
        log.debug("native message: \(type, privacy: .public)")

        let finish: ([String: Any]) -> Void = { reply in
            let response = NSExtensionItem()
            response.userInfo = [SFExtensionMessageKey: reply]
            context.completeRequest(returningItems: [response], completionHandler: nil)
        }

        switch type {
        case "sync":
            handleSync(message, completion: finish)
        case "probe":
            handleProbe(completion: finish)
        default:
            finish(["ok": false, "error": "unknown message type \(type)"])
        }
    }

    // MARK: - sync

    private func handleSync(_ message: [String: Any], completion: @escaping ([String: Any]) -> Void) {
        guard AppGroup.isAvailable else {
            completion(["ok": true, "appGroup": false,
                        "appGroupError": AppGroup.identifier == nil ? "ABDAppGroupIdentifier missing in Info.plist" : "container unavailable (entitlement not granted?)"])
            return
        }

        var allowlistChanged = false
        if let state = message["state"],
           JSONSerialization.isValidJSONObject(state),
           let data = try? JSONSerialization.data(withJSONObject: state, options: [.sortedKeys]) {
            AppGroup.write(data, to: AppGroup.stateFile)

            // Keep the overflow Content Blocker's allowlist in step with the extension.
            if let settings = (state as? [String: Any])?["settings"] as? [String: Any] {
                let hosts = (settings["allowlist"] as? [String] ?? []).sorted()
                let paused = settings["blockingPaused"] as? Bool ?? false
                let payload: [String: Any] = ["hosts": hosts, "paused": paused]
                if let newData = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
                   newData != AppGroup.readData(AppGroup.overflowAllowlistFile) {
                    AppGroup.write(newData, to: AppGroup.overflowAllowlistFile)
                    allowlistChanged = true
                }
            }
        }

        var reply: [String: Any] = ["ok": true, "appGroup": true]
        if let inboxData = AppGroup.readData(AppGroup.inboxFile),
           let inbox = try? JSONSerialization.jsonObject(with: inboxData) {
            reply["inbox"] = inbox
        }

        let ids = AppGroup.overflowIdentifiers
        guard allowlistChanged, !ids.isEmpty else {
            completion(reply)
            return
        }
        // Reload overflow blockers so the new allowlist takes effect.
        let group = DispatchGroup()
        var reloadErrors: [String] = []
        let lock = NSLock()
        for id in ids {
            group.enter()
            SFContentBlockerManager.reloadContentBlocker(withIdentifier: id) { error in
                if let error {
                    lock.lock(); reloadErrors.append("\(id): \(error.localizedDescription)"); lock.unlock()
                }
                group.leave()
            }
        }
        group.notify(queue: .global()) {
            reply["overflowReloaded"] = reloadErrors.isEmpty
            if !reloadErrors.isEmpty { reply["overflowErrors"] = reloadErrors }
            completion(reply)
        }
    }

    // MARK: - probe

    private func handleProbe(completion: @escaping ([String: Any]) -> Void) {
        var reply: [String: Any] = ["ok": true]
        reply["appGroupId"] = AppGroup.identifier ?? "missing"
        if AppGroup.isAvailable, let probe = "probe \(Date())".data(using: .utf8) {
            let wrote = AppGroup.write(probe, to: "probe.txt")
            reply["appGroup"] = wrote
            if !wrote { reply["appGroupError"] = "container exists but is not writable" }
        } else {
            reply["appGroup"] = false
            reply["appGroupError"] = "containerURL(forSecurityApplicationGroupIdentifier:) returned nil"
        }

        guard let blocker = AppGroup.overflowIdentifiers.first else {
            reply["contentBlockerDetail"] = "no overflow Content Blocker configured (optional)"
            completion(reply)
            return
        }
        SFContentBlockerManager.getStateOfContentBlocker(withIdentifier: blocker) { state, error in
            if let error {
                reply["contentBlockerManager"] = false
                reply["contentBlockerDetail"] = error.localizedDescription
            } else {
                reply["contentBlockerManager"] = true
                reply["contentBlockerDetail"] = "overflow blocker enabled in Settings: \(state?.isEnabled ?? false)"
            }
            completion(reply)
        }
    }
}
