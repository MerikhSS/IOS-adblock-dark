# Testing on your iPhone & debugging

## 1. Enable the extension

1. Open the **AdBlock Dark** app once, then tap **Open Safari Extensions settings**.
   - Or go there manually: **Settings › Apps › Safari › Extensions**.
2. Tap **AdBlock Dark**. Turn on **Allow Extension**.
3. Under *Permissions*, set **All Websites** (sometimes shown as *Other Websites*) to **Allow**.
   - Network blocking works without this permission.
   - Element hiding, scriptlets and dark mode need it, because they run content scripts on pages.
4. Optional: turn on **Allow in Private Browsing**.
5. If you built the overflow blocker, turn on **AdBlock Dark Extra Lists** in the same list.
6. Open Safari and load any page. Wait 5–10 seconds the first time while Safari compiles about 124k rules.

In Safari, the extension's popup is under the page-menu button in the address bar
(the "aA"/puzzle-piece menu, then **AdBlock Dark**).

## 2. Run the capability probe (Milestone 0)

Go to **popup › All settings › Diagnostics › Run probe**, then **Copy**. You want ✓ on these:

| Probe line | Why it matters | If ✗ |
|---|---|---|
| getEnabledRulesets / getDynamicRules | DNR works | Update iOS to 26+ |
| rule budget | Enabled lists fit in 150k | Disable a list |
| registerContentScripts world:MAIN | Scriptlets run before page scripts | Scriptlets fall back to nothing; everything else works |
| registerContentScripts excludeMatches | Allowlist and exceptions for generic CSS and dark mode | Needs Safari 26.0+ |
| getMatchedRules | Blocked-request counts | Counts show only hidden elements |
| native messaging | Host app sync | Check that the extension target embeds the handler |
| App Group container | Host app management | See FREE_ACCOUNT.md; use the Settings page instead |
| cosmetic data loaded | Site-specific hiding | Wait a few seconds after install, then re-run |

## 3. Functional checklist

| Test | How | Expected |
|---|---|---|
| Network blocking | Open an ad-block test page such as `https://d3ward.github.io/toolz/adblock` | Most ad/tracker hosts blocked; popup shows "N requests blocked" |
| Element hiding | Open a news site you know shows banners | Banner slots collapse |
| Per-site allowlist | Popup › turn **Block ads on this site** off | Page reloads with ads; turning it back on removes them |
| Custom rule | Settings › My rules: `example.com##h1` › Save, then open `https://example.com` | Heading hidden |
| Element picker | Popup › **Hide an element…** › tap something › **Hide** | Element disappears and a rule appears in My rules |
| Dark mode per site | Popup › Dark mode **On** on `https://en.wikipedia.org` | Page reloads dark, photos keep their real colours |
| No white flash | With dark **On**, reload and navigate between Wikipedia articles | No white frame before the dark page (Safari's blank start page aside) |
| Dark default | Settings › Dark › **Dark mode by default** on | Every site is dark except ones set to **Off** |
| Native-dark detection | Default on, then visit a site that's already dark | It isn't inverted to light; the popup says "(site is already dark)" |
| Dynamic engine | Popup › Dark engine **Dynamic** | Recoloured instead of inverted |
| Host app sync | App › Allowlist › add `example.org`, then load any page in Safari | App shows "Saved…" until applied; the extension's Settings › Allowlist lists it |
| Persistence | Force-quit Safari, reopen | Toggles and dark sites remembered |

## 4. Debugging with Safari Web Inspector

One-time setup:
- **iPhone:** Settings › Apps › Safari › Advanced › turn on **Web Inspector**.
- **Mac:** Safari › Settings… › Advanced › tick **Show features for web developers**.
- Connect the iPhone by cable. For Wi-Fi, turn on **Develop › [iPhone] › Connect via Network** after the first cable connection.

What to inspect:
- **Content scripts (cosmetic, dark mode, picker):** **Develop › [your iPhone] › [the page]**.
  - In **Sources**, look under *Extension Scripts* for `cosmetic.js`, `dark.js`, `procedural.js`.
  - In **Elements**, hidden nodes carry `abd-h`, and dark mode sets `data-abd-dark` / `data-abd-dark-off` on `<html>`.
- **Background page (rules, registrations, sync):** **Develop › [your iPhone] › AdBlock Dark — Extension Background Content**.
  The name varies slightly between Safari versions.
  - Useful console commands:
    ```js
    await browser.declarativeNetRequest.getEnabledRulesets()
    await browser.declarativeNetRequest.getDynamicRules()
    await browser.scripting.getRegisteredContentScripts()
    (await browser.storage.local.get(['registrationErrors','customRuleErrors','lastNativeSync']))
    await browser.declarativeNetRequest.getMatchedRules({})
    ```
- **Popup / Settings page:** open it on the phone, then pick it under **Develop › [iPhone]** while it is visible.
- **Native handler (Swift):**
  - In Xcode: **Debug › Attach to Process by PID or Name… › `AdBlockDarkExtension`**, then trigger a sync (open the popup).
  - Or open **Console.app**, select the iPhone, and filter by subsystem `AdBlockDark`.
- **Host app:** run it from Xcode as usual; breakpoints in `SharedStore.swift` work.

## 5. Troubleshooting

| Problem | Likely cause / fix |
|---|---|
| Nothing is blocked at all | Rules still compiling (wait), or over the 150k cap (probe › rule budget). Disable lists and reload |
| Blocking works but no element hiding or dark mode | "All Websites" permission not set to Allow |
| Dark mode doesn't apply until reload | Expected: toggles take effect on the next page load (the popup reloads the tab for you) |
| White flash on dark sites | Check Diagnostics › registration errors. The filter engine must be registered (`abd-dark-filter`) |
| A site breaks | Popup › turn blocking off for that site, or add an exception in My rules, e.g. `@@\|\|cdn.site.com^` or `site.com#@#.selector` |
| App says "No data from the extension yet" | Load any page in Safari (the extension syncs on page loads), then pull to refresh |
| App stuck on "Saved. Applies…" | Open the extension popup once; it forces a sync |
| After a week the extension disappears | The free provisioning profile expired. Re-run from Xcode |

## 6. Tests you can run on the Mac

```bash
make test     # unit tests: converter, cosmetic compiler, scriptlets, background logic (mocked Safari API)
make build    # rebuild + validate every generated DNR rule against Safari's constraints
make smoke    # content scripts in Chromium via Playwright
              # one-time: cd filters && npm i --no-save playwright && npx playwright install chromium
```
The smoke tests run in Chromium, not Safari. They catch logic errors, but only the iPhone checklist above proves Safari behaviour.
