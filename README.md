# AdBlock Dark (personal iOS Safari ad blocker + per-site dark mode)

A personal-use iOS app with a **Safari Web Extension** that does three things:
- blocks ads and trackers using the same filter lists as uBlock Origin (EasyList, EasyPrivacy, uBlock filters, Peter Lowe's, EasyList Germany and other regional lists);
- hides page elements, runs procedural filters and scriptlets;
- adds a **dark theme you toggle per website**, with no white flash.

A small **SwiftUI app** manages everything. It builds and runs with a **free Apple ID**.

> **Honest scope:** iOS gives extensions **no `webRequest` blocking**, caps rules at roughly **150k per extension**, and offers **no request logger**.
> This project goes about as far as uBlock Origin *Lite* can on Safari, plus extras: scriptlets, procedural filters, an element picker, and dark mode.
> See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full parity table and the Apple and WebKit sources behind each claim.

## Quick start

```bash
brew install xcodegen node
git clone <this repo> && cd IOS-adblock-dark
cp Local.xcconfig.example Local.xcconfig   # set ABD_BUNDLE_PREFIX = com.<you>.adblock
make project && open AdBlockDark.xcodeproj
```
Then in Xcode:
1. Pick your *Personal Team* on both targets.
2. Choose your iPhone and press **Run**.
3. On the iPhone: **Settings › Apps › Safari › Extensions › AdBlock Dark** › Allow, and set **All Websites › Allow**.

Full click-by-click instructions: [docs/XCODE_SETUP.md](docs/XCODE_SETUP.md). Testing and Web Inspector debugging: [docs/TESTING.md](docs/TESTING.md).

**Requirements:**
- iPhone on **iOS 26.0+**. Safari 26 fixed the declarativeNetRequest priority and allow-rule bugs that per-site allowlisting relies on.
- Current Xcode.
- Node 20+, only needed to refresh filter lists.

## Weekly routine (free Apple ID)

Free-account builds expire after **7 days**. Once a week:
```bash
make lists      # download lists → convert → validate (prints a rule-budget report)
```
Then press **Run** in Xcode. Your settings are kept. Details: [docs/FREE_ACCOUNT.md](docs/FREE_ACCOUNT.md).

## What's in the box

| Area | Where |
|---|---|
| Filter-list pipeline: download, uBO `!#if`/`!#include` preprocessing, conversion to Safari DNR, cosmetic and scriptlet compilation, budget report, validation | `filters/`, `WebExtension/Resources/lib/` |
| Safari Web Extension (MV3): DNR rulesets, allowlist, custom rules, cosmetic + procedural engine, 26 scriptlets, redirect surrogates, element picker | `WebExtension/Resources/` |
| Dark mode: fast CSS-filter engine (no flash) and Dark Reader "dynamic" engine (MIT, vendored), per site or global | `WebExtension/Resources/content/dark*` |
| Popup (per-site toggles) and Settings page (lists, rules, allowlist, dark, stats, diagnostics/probe) | `WebExtension/Resources/popup`, `options` |
| Native messaging handler and App Group sync | `WebExtension/SafariWebExtensionHandler.swift`, `Shared/` |
| SwiftUI host app: setup and status, lists with budget bar, custom rules, allowlist, dark defaults, stats chart | `App/` |
| Optional overflow Content Blocker (+150k rules, one more App ID) | `ContentBlockerOverflow1/` (`make project-overflow`) |
| Tests: converter + background logic (mocked Safari API), Chromium smoke tests | `filters/test`, `filters/test-browser` |

## Milestones

| # | Milestone | Status | Where to look / how to check |
|---|---|---|---|
| M0 | Project setup + capability probe | ✅ | `docs/XCODE_SETUP.md`; Settings › Diagnostics › Run probe |
| M1 | MVP: blocking + per-site dark toggle | ✅ | Popup on any site |
| M2 | Filter-list pipeline (14 lists, budget guard, validator) | ✅ | `make lists` |
| M3 | Cosmetic filtering (generic, specific, procedural, scriptlets) | ✅ | News sites; Web Inspector |
| M4 | Custom rules + per-site allowlist | ✅ | Settings › My rules / Allowlist; popup toggle |
| M5 | Host app management, App Group sync, stats | ✅ (needs App Groups) | App › Setup shows "Synced" |
| M6 | Polish: Dark Reader engine, element picker, overflow blocker | ✅ (overflow optional) | Popup › Dark engine / Hide an element… |

Everything is implemented. Some behaviour can only be confirmed on a real iPhone: MAIN-world scriptlet timing, App Groups on a free team,
and performance with about 44k scriptlet match patterns. The probe and the checklist in [docs/TESTING.md](docs/TESTING.md) cover those.

## Default rule budget

From the current lists (`make lists` prints this):

```
DNR WebKit cost of default-enabled lists: ~124,000 / budget 135,000 (Safari hard cap 150,000 incl. your rules)
```
The Settings page and the host app refuse to enable lists past the cap. Over 150k converted rules, Safari would block nothing at all.

## Licenses and credits
- Filter lists are downloaded at build time from their authors. Each list keeps its own license, e.g. EasyList (GPLv3/CC BY-SA) and uBlock filters (GPLv3).
  Generated rules are bundled for personal use only.
- `vendor/darkreader.js`: Dark Reader, MIT (see `vendor/darkreader.LICENSE.txt`).
- Scriptlets, the procedural engine, converters and the app were written for this project.
