# Architecture & honest comparison with uBlock Origin

## TL;DR

- **iOS has no blocking `webRequest`** (Apple: "webRequest — Not supported in iOS").
  Every iOS blocker, including uBlock Origin Lite for Safari, works by handing Safari
  **declarative rules** up front. Safari enforces them; your code never sees requests.
- This project ships **one Safari Web Extension** that does everything:
  - network blocking with **declarativeNetRequest (DNR)**;
  - element hiding, procedural filters and scriptlets with **content scripts**;
  - per-site **dark mode**.
  An optional classic **Content Blocker** extension adds rule capacity only if you need more lists.
- A **SwiftUI host app** manages settings through an **App Group** and shows stats.
  If App Groups don't work on your free account, the extension's own Settings page does the same job.

## Verified platform facts (checked against Apple docs + WebKit source, Oct 2026)

| Fact | Source |
|---|---|
| Content rule lists are capped at **150,000 rules** (`maxRuleCount = 150000`) | WebKit `ContentExtensionParser.cpp` |
| Safari compiles **all enabled DNR rules (static + dynamic + session) into ONE content rule list**, so a web extension effectively has ~150k *converted* rules in total | WebKit `WebExtensionContextCocoa.mm` (`loadDeclarativeNetRequestRules`) |
| Safari DNR limits: 100 static rulesets, 50 enabled, 30,000 dynamic + session rules | WebKit `WebExtensionConstants.h` |
| DNR→WebKit conversion: `requestDomains` → one WebKit rule per domain; `initiatorDomains` → `if-frame-url`; `allowAllRequests` → `if-top-url`; no `object`/`csp_report` types | WebKit `_WKWebExtensionDeclarativeNetRequestRule.mm` |
| WebKit regex subset: no `\|`, `{n,m}`, `\d`, `\b`, lookarounds, back-references | WebKit `URLFilterParser.cpp` |
| Safari 26.0 fixed DNR priority ordering, `allowAllRequests` overriding lower-priority blocks, and `registerContentScripts` `excludeMatches` | WebKit "Features in Safari 26.0" |
| DNR was unreliable before iOS 18.6 (uBlock Origin Lite requires 18.6+) | uBOL release coverage |
| `webRequest` not supported in iOS; `scripting.registerContentScripts` since Safari 16.4; `storage` 5 MB unless `unlimitedStorage` | Apple: "Assessing your Safari web extension's browser compatibility" |
| `SFSafariSettings.openExtensionsSettings(forIdentifiers:)` (iOS 26.0), `SFSafariExtensionManager.stateOfExtension` (iOS 26.2) | Apple SafariServices docs |
| Content Blocker triggers include `if-frame-url`/`unless-frame-url`; WebKit rejects lists that mix `if-domain` and `if-top-url` | Apple "Creating a content blocker", WebKit bug 207540 |

**Minimum iOS: 26.0.** The DNR fixes that per-site allowlisting depends on shipped in Safari 26.0.
The host app uses the 26.2 status API when available.

## Components

```
┌──────────────── iPhone ─────────────────────────────────────────────────────────┐
│ Safari                                                                         │
│  ├─ AdBlock Dark (Safari Web Extension, MV3)                                   │
│  │   ├─ static DNR rulesets (one per filter list, toggleable)  ──┐             │
│  │   ├─ dynamic DNR rules: allowlist (prio 10000) + my rules     ├─► ONE WebKit │
│  │   │                                                           │   rule list  │
│  │   ├─ registered content scripts (scripting API):              │   ≤150,000   │
│  │   │    • generic element-hiding CSS (all sites minus exceptions/allowlist)   │
│  │   │    • scriptlet shards, world:MAIN, document_start                         │
│  │   │    • dark-mode CSS+JS, matches = "dark on" hosts (no white flash)         │
│  │   ├─ cosmetic.js (manifest content script): site-specific + procedural hiding│
│  │   ├─ popup (per-site toggles) · options page (full management, probe)       │
│  │   └─ SafariWebExtensionHandler.swift ◄─ native messaging                     │
│  └─ AdBlock Dark Extra Lists (optional classic Content Blocker, +150k rules)    │
│                                                                                │
│ App Group container: state.json (ext→app) · inbox.json (app→ext) · overflow-allowlist.json │
│                                                                                │
│ AdBlock Dark app (SwiftUI): setup/status · lists · my rules · allowlist · dark · stats │
└────────────────────────────────────────────────────────────────────────────────┘
        ▲ build time (your Mac): filters/ (Node) downloads lists → converts → validates
```

### Network blocking (DNR)
- `filters/scripts/build.js` converts each list into `rules/<list>.json`. The conversion handles:
  - `||host^`, wildcards, anchors, `$script/image/…`, `$third-party`, `$domain=`, `$to=`, `$denyallow=`, `$method=`, `$match-case`;
  - `$important`, `@@` exceptions, `@@…$document`, `$badfilter` (applied across lists);
  - `$redirect=` (DNR redirect to bundled surrogates in `surrogates/`), `$removeparam=` (`queryTransform`), `$csp=` (`modifyHeaders`);
  - regex filters (rewritten into WebKit's subset, small alternations expanded).
- Rules that Safari can't express are **skipped, not mangled**. The build report lists skip reasons:
  `$popup` (~4k), `$redirect-rule`, `$urlskip`, HTML filtering, entity-only `$domain=google.*`, unsupported regexes.
- **Budget:** the default lists cost **~124k of the 150k** converted-rule cap. That leaves room for your own rules and the allowlist.
  - The background page and both UIs refuse to enable lists past the budget.
  - Exceeding the cap makes Safari reject the whole list, so **nothing** would be blocked.
- **Priorities** (higher wins):
  - 10000 allowlist
  - 5200 / 5100 / 5000 your rules (`$important` / exception / block)
  - 4000 `$important`
  - 3000 list exceptions
  - 2000 redirects
  - 1500 removeparam
  - 1000 blocks and csp

### Cosmetic filtering
- **Generic** `##.ad` selectors go into a static stylesheet per list. The extension registers these
  stylesheets with `registerContentScripts`, so Safari applies them before first paint.
  - Hosts with generic exceptions (`#@#`, `$generichide`, `$elemhide`, `$document`) and allowlisted hosts are in
    `excludeMatches`.
  - On those hosts `cosmetic.js` asks the background for "generic minus exceptions".
- **Site-specific** rules are copied into `storage.local` as `c:<list>:<host>` on install or update.
  - `cosmetic.js` runs at `document_start` in all frames and does two small storage reads (no background wake-up).
  - It then injects CSS, `:style()` and `:remove()`, and starts the procedural engine.
- **Procedural** operators (`content/procedural.js`): `:has-text`/`:contains`, `:upward`, `:xpath`, `:matches-css(-before/-after)`,
  `:matches-attr`, `:matches-path`, `:min-text-length`, `:-abp-has`/procedural `:has`/`:if`/`:if-not`/`:not`,
  `:remove-attr`, `:remove-class`.
  Native `:has()` is left to WebKit.
- **Scriptlets** (`lib/scriptlet-runner.js`, written from scratch): 26 of the most used ones.
  - The full list: `set-constant`, `abort-on-property-read/write`, `abort-current-script`, `no-setTimeout-if`/`no-setInterval-if`, `json-prune`,
    `json-prune-fetch-response`/`json-prune-xhr-response`, `no-fetch-if`, `no-xhr-if`, `addEventListener-defuser`, `no-window-open-if`,
    `nowebrtc`, `noeval(-if)`, `remove-attr`, `remove-class`, `remove-node-text`, `set-cookie`, `remove-cookie`,
    `set-local/session-storage-item`, `nano-setTimeout/setInterval-booster`, `no-requestAnimationFrame-if`.
  - Bundles are sharded by host (~120 KB each) and registered in the **MAIN world at `document_start`**, so they run before page scripts.
  - Your own scriptlet rules are injected after navigation with `executeScript`. That is best effort, because it may run after the page's first scripts.

### Dark mode
- **No white flash.** "Dark on/off for this host" is encoded in the **match patterns** of a registered content script.
  - Default **on**: `<all_urls>` minus "off" sites. Default **off**: only "on" sites.
  - Safari injects that CSS before first paint, so no async storage read sits on the critical path.
  - Changing a toggle re-registers the script and reloads the tab.
- **Filter engine** (default):
  - `html { filter: invert(.9) hue-rotate(180deg) }`, then re-inverts media and embedded players:
    `img`, `picture`, `video`, `canvas`, YouTube/Vimeo iframes, and large CSS background images (tagged by `dark.js`).
  - SVG images stay inverted, because icons look right that way.
  - Brightness, contrast and sepia are applied through CSS variables.
  - Sites that are already dark are detected and switched off automatically, then remembered for next time.
- **Dynamic engine**: the vendored **Dark Reader** library (MIT). It recolours stylesheets instead of inverting,
  which looks better but is heavier. Cross-origin CSS is fetched through the background page.
- **iframes**:
  - Filter engine: runs in the top frame only, because child frames are already inverted with their parent.
    Video embeds are re-inverted.
  - Dynamic engine: runs in every frame.

### Data sharing (App Group)
- **Source of truth:** the extension's `browser.storage.local`.
- **Extension → app:** the background calls `sendNativeMessage({type:'sync', state})`.
  `SafariWebExtensionHandler` writes `state.json`, reads `inbox.json` and returns it.
  Sync runs at most every 20 s: on startup, on page loads, and when the popup opens.
- **App → extension:** the app writes edits into `inbox.json` with an increasing `rev`.
  The extension merges a new rev once and records `hostRevApplied`. The app shows "pending" until that happens.
- **Overflow Content Blocker:** reads `overflow-allowlist.json` and appends an `ignore-previous-rules` rule
  (with `if-top-url`, never `if-domain`). Either the handler or the app reloads it.
- **Without App Groups** (possible on free accounts): `AppGroup.containerURL` is `nil` and everything still works.
  The host app shows "unavailable"; manage settings from **popup › All settings**.

## Parity with uBlock Origin

| uBO feature | Possible on iOS Safari? | What this project does |
|---|---|---|
| Blocking via `webRequest` | **No** (no webRequest on iOS) | DNR static + dynamic rules |
| Unlimited rules | **No** — ~150k converted rules per extension | Budget guard; optional overflow Content Blocker adds 150k each (one App ID each) |
| Automatic list updates | **Partly.** Static rulesets ship inside the app; dynamic rules are capped at 30k | `make lists` + rebuild, ideally at your weekly re-sign |
| Generic and specific cosmetic filters | Yes | Static CSS + storage-backed content script |
| Procedural cosmetic filters | Yes (JS) | Large subset (see above); `:watch-attr`, `:others`, `:matches-media` skipped |
| Scriptlets (~100) | Yes, in MAIN world (Safari 16.4+) | 26 common ones; `trusted-*`, `rpnt`, `aost`, `href-sanitizer` etc. skipped (see build report) |
| `redirect=` | Partly (DNR redirect + web-accessible resources) | 15 surrogates; unknown resource → plain block; `redirect-rule=` skipped |
| `removeparam=` | Partly | Literal names only (no regex, no negation) |
| `csp=` | Partly (`modifyHeaders`) | Site-scoped only; generic csp rules skipped |
| `$header=`, `$replace=`, `$urlskip=`, HTML filtering `##^`, CNAME uncloaking | **No** (needs response/body access) | Skipped |
| `$popup` / popunder blocking | **No** DNR equivalent | Skipped (Safari's own popup blocker helps) |
| Dynamic filtering matrix | No UI equivalent | Write rules instead: `\|\|cdn.example^$3p,domain=site.com` |
| Logger | **No** (`onRuleMatchedDebug` is compiled out of Safari) | Per-tab matched-rule counts (`getMatchedRules`), badge count, daily stats |
| Element picker | Yes | Basic picker (tap › Wider/Narrower › Hide) |
| Per-site off switch | Yes | Allowlist = top-priority `allowAllRequests` + cosmetics/scriptlets excluded |
| Strict blocking page | Partly | `$document` blocks → Safari error page |
| YouTube | Arms race | Best effort via `json-prune` and the other scriptlets; expect breakage |
| System-wide blocking outside Safari | Needs Network Extension (paid) | Not included. Free alternative: an encrypted-DNS profile (NextDNS, AdGuard DNS…) |

## Known trade-offs to watch on the device
- **Scriptlet match patterns:** about 44k patterns across 24 shards. Wildcard-TLD rules (`site.*`) are expanded to 14 common TLDs.
  If Safari feels slow to start loading pages, reduce the `tlds` list in `filters/scripts/build.js`,
  or disable the scriptlet-heavy lists.
- **First run after install:** Safari compiles about 124k rules, which takes a few seconds. Blocking starts after that.
- **Storage:** site-specific cosmetic data is about 4 MB in `storage.local` (`unlimitedStorage`).
- **Generic CSS:** about 15k selectors applied to every frame, which is the same model Safari content blockers use.
