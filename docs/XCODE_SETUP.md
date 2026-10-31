# Xcode setup (exact steps)

Requirements:
- A Mac with **the current Xcode** (26 or newer; it must have the iOS 26+ SDK).
- An **iPhone on iOS 26.0 or later**.
- **Node.js 20+**, only needed to rebuild filter lists: `brew install node`.

The repo already contains generated rules, so you can build before installing Node.

---

## Option A — generated project (recommended, ~5 minutes)

[XcodeGen](https://github.com/yonaskolb/XcodeGen) creates `AdBlockDark.xcodeproj` from `project.yml`.
All targets, Info.plists, entitlements and resource folders come out configured correctly.

1. **Install the tools.**
   ```bash
   brew install xcodegen node
   ```
2. **Set your bundle prefix.**
   ```bash
   cd IOS-adblock-dark
   cp Local.xcconfig.example Local.xcconfig
   open -e Local.xcconfig
   ```
   Set `ABD_BUNDLE_PREFIX = com.<yourname>.adblock`. It must be unique to you.
   Leave `DEVELOPMENT_TEAM` empty; you'll pick the team in Xcode.
3. **Generate the project and open it.**
   ```bash
   make project
   open AdBlockDark.xcodeproj
   ```
4. **Add your Apple ID to Xcode.** Go to **Xcode › Settings… › Accounts**, click **+**, choose **Apple Account**, and sign in.
   A "(Your Name) (Personal Team)" entry appears.
5. **Set signing for each target.** In the left sidebar, click the blue **AdBlockDark** project icon, then do this for **each target**
   (`AdBlockDark` and `AdBlockDarkExtension`; also `AdBlockDarkOverflow1` if you generated it):
   1. Click the target and open the **Signing & Capabilities** tab.
   2. Tick **Automatically manage signing**.
   3. Set **Team** to *Your Name (Personal Team)*.
   4. Check that **Bundle Identifier** shows your prefix, e.g. `com.yourname.adblock.adblockdark.extension`.
   5. Under **App Groups**, the group `group.com.yourname.adblock.adblockdark` should be listed and ticked.
      - If it shows a red error, try ticking it once more or clicking **Try Again**.
      - If it still won't register, see [FREE_ACCOUNT.md › App Groups](FREE_ACCOUNT.md#app-groups).

   To avoid repeating this, put your team ID in `Local.xcconfig` as `DEVELOPMENT_TEAM = ABCDE12345`.
   The ID appears in the Signing tab after you pick the team, and in the Accounts panel.
6. **Connect the iPhone** with a cable and unlock it. Tap **Trust** on "Trust This Computer?".
   In Xcode's toolbar, choose the **AdBlockDark** scheme and your **iPhone** as the run destination.
7. **Press Run (⌘R).** On the first run:
   - **"Developer Mode disabled"**: on the iPhone go to **Settings › Privacy & Security › Developer Mode**, turn it on, and restart.
     After the restart, confirm **Turn On**. Then press Run again.
   - **"Untrusted Developer"** when the app opens: go to **Settings › General › VPN & Device Management**, tap your Apple ID
     under *Developer App*, then **Trust**. Run again.
8. Continue with **[TESTING.md](TESTING.md)** to enable the extension in Safari.

**Optional overflow Content Blocker.** Use it only if you move lists to `"engine": "contentBlocker"` in `filters/lists.json`.
It costs one more App ID.
```bash
make project-overflow && open AdBlockDark.xcodeproj
```
Sign the extra target the same way as in step 5.

---

## Option B — create the project by hand in Xcode

Use this if you'd rather not install XcodeGen. In step 11, remove `AdBlockDark.xcodeproj/` from `.gitignore` so your project gets committed.

1. **Create the project.** Go to **File › New › Project… › iOS › App › Next** and fill in:
   - Product Name: `AdBlockDark`
   - Team: *Your Name (Personal Team)*
   - Organization Identifier: `com.yourname.adblock`
   - Interface: **SwiftUI**, Language: **Swift**, Storage: **None**, untick Tests

   Save it **inside the repo folder** (the folder containing `project.yml`), with "Create Git repository" **unticked**.
2. **Add the extension target.** Go to **File › New › Target… › iOS › Safari Extension › Next** and set:
   - Product Name: `AdBlockDarkExtension`
   - Type: **Web Extension** (if asked)
   - Embed in: `AdBlockDark`

   Click **Finish**, then **Activate** if asked.
3. **Use the repo's source files instead of the template's.**
   1. In the navigator, delete the template's `AdBlockDarkApp.swift` and `ContentView.swift`.
      Also delete the extension's `SafariWebExtensionHandler.swift` and its `Resources` group. Choose **Move to Trash**.
   2. Drag the repo's `App/` folder onto the project and tick target **AdBlockDark**.
      Don't add `App/Info.plist` to Copy Bundle Resources; Xcode warns you if it is.
   3. Drag `Shared/` and tick **both** targets.
   4. Drag `WebExtension/SafariWebExtensionHandler.swift` and tick **AdBlockDarkExtension**.
   5. Drag `WebExtension/Resources/manifest.json` and tick **AdBlockDarkExtension**.
   6. Drag the 13 folders inside `WebExtension/Resources/` (`_locales`, `background`, `content`, `cosmetic`, `images`, `lib`, `options`, `popup`,
      `rules`, `scriptlets`, `surrogates`, `ui`, `vendor`).
      In the dialog choose **Create folder references** (blue folders), not groups, and tick **AdBlockDarkExtension**.
      Safari needs that folder structure inside the extension bundle.
4. **Attach the build settings.** Click the project (blue icon) › **Info** tab › **Configurations**.
   For both Debug and Release, set the base configuration of the *project* row to **Config**.
   If it isn't offered, drag `Config.xcconfig` into the project first.
5. **App target › Build Settings** (search box at the top right). Set:
   - `Info.plist File` = `App/Info.plist`
   - `Generate Info.plist File` = **No**
   - `Code Signing Entitlements` = `App/AdBlockDark.entitlements`
   - `Product Bundle Identifier` = `$(ABD_BUNDLE_PREFIX).adblockdark`
   - `iOS Deployment Target` = `26.0`
6. **Extension target › Build Settings.** Set:
   - `Info.plist File` = `WebExtension/Info.plist`
   - `Generate Info.plist File` = **No**
   - `Code Signing Entitlements` = `WebExtension/AdBlockDarkExtension.entitlements`
   - `Product Bundle Identifier` = `$(ABD_BUNDLE_PREFIX).adblockdark.extension`
   - `iOS Deployment Target` = `26.0`
7. **Signing & Capabilities for both targets.** Set Team = Personal Team. If App Groups isn't already listed, click **+ Capability › App Groups**.
   Make sure exactly one group is ticked: `group.<your prefix>.adblockdark`.
8. Copy `Local.xcconfig.example` to `Local.xcconfig` and set `ABD_BUNDLE_PREFIX` to the same prefix you used in step 1.
9. **Product › Clean Build Folder**, then **Run** on your iPhone, following step 7 of Option A.
10. When you change filter lists later, `make lists` rewrites files inside the folder references, so Xcode picks them up automatically.
11. Remove the `AdBlockDark.xcodeproj/` line from `.gitignore` if you want to commit your project.

---

## Build problems

| Symptom | Fix |
|---|---|
| "No profiles for '…' were found" / "Failed to register bundle identifier" | The prefix is taken or invalid. Change `ABD_BUNDLE_PREFIX`, run `make project`, and re-select the team |
| "Personal development teams … do not support the App Groups capability" | See [FREE_ACCOUNT.md](FREE_ACCOUNT.md#app-groups). Remove App Groups; the extension's Settings page replaces the host app |
| Extension missing from Safari settings | Check that the app target embeds `AdBlockDarkExtension.appex` (General › Frameworks, Libraries, and Embedded Content) and that the extension's deployment target is ≤ the phone's iOS |
| `manifest.json` not found / extension shows no popup | Resource folders were added as groups (yellow) instead of folder references (blue). Re-add them as folder references |
| "You have reached the maximum number of App IDs" | Free-account limit of 10 per 7 days. Wait, or reuse your previous prefix |
| Build error in `SharedStore.swift` about `SFSafariExtensionManager` | Your SDK is older than iOS 26.2. Update Xcode, or delete the `if #available(iOS 26.2, *)` block |
