# Using a free Apple ID (Personal Team)

You can build and run everything here with a free Apple ID. The limits:

| Limit | Impact here | What to do |
|---|---|---|
| Apps expire after **7 days** | Safari stops loading the extension when the app expires | Re-run from Xcode once a week. Your settings survive, because they live in the extension's storage |
| **3 sideloaded apps** per device | This project is 1 app | — |
| **10 new App IDs per 7 days** | Default build = 2 App IDs (app + extension). `make project-overflow` adds 1 | Don't churn bundle prefixes; pick `ABD_BUNDLE_PREFIX` once |
| Bundle IDs must be globally unique | `com.example…` is taken | Use something personal, e.g. `com.yourname.adblock` |
| **App Groups** | Unconfirmed whether personal teams can register a group. Apple's capability table couldn't be read programmatically and community reports conflict | See below |

## App Groups

The project ships with the App Groups entitlement (`group.<prefix>.adblockdark`) on all targets.
The first build with your Personal Team tells you whether it works.

**If it works:** Xcode registers the group automatically. The host app's **Setup** tab shows
"App ↔ extension sync: Synced …" after you open any web page in Safari.

**If Xcode refuses the capability:** you'll see an error mentioning App Groups or the provisioning profile.
1. In Xcode, select each target › **Signing & Capabilities**, then click the trash icon on **App Groups**.
   - Alternatively, set `CODE_SIGN_ENTITLEMENTS` to empty for each target.
2. Build again. Everything works except host-app management.
3. Use **Safari › AdBlock Dark popup › All settings**, which has the same features: lists, my rules, allowlist, dark, stats and diagnostics.
4. Skip the overflow Content Blocker. Without the App Group it can't see your allowlist.

## Paid-only features and the free fallback

| Feature | Needs paid account? | Fallback used here |
|---|---|---|
| Run on your own iPhone | No (7-day profile) | — |
| Safari Web Extension, Content Blocker extension | No | — |
| App Groups | Possibly (see above) | Extension Settings page |
| iCloud / CloudKit settings sync across devices | Yes | Not used |
| Push notifications (e.g. "lists updated") | Yes | Not used |
| TestFlight / App Store / sharing with others | Yes | Not applicable (personal use) |
| Network Extension (system-wide DNS/VPN filtering) | Yes | Install an encrypted-DNS profile from a DNS filtering provider instead |
| Longer-lived signing (1 year) | Yes | Re-run weekly |

## Weekly routine (about 2 minutes)

```bash
cd IOS-adblock-dark
git pull                # if you keep the repo on GitHub
make lists              # fresh filter lists → rules (validates output)
open AdBlockDark.xcodeproj
```
Then in Xcode select your iPhone and press **Run** (⌘R).
