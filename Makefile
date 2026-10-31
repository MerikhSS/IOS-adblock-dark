# AdBlock Dark — common tasks (run on your Mac; needs Node 20+ for filters).
#
#   make lists             download filter lists + rebuild rules (weekly)
#   make project           generate AdBlockDark.xcodeproj with XcodeGen
#   make project-overflow  same, plus the optional overflow Content Blocker target
#   make test              run converter + background unit tests
#   make smoke             run content scripts in Chromium (needs: npm i -g playwright)
#   make vendor            update vendored Dark Reader
#   make icons             regenerate icons (needs Pillow: pip3 install pillow)

.PHONY: lists fetch build test smoke project project-overflow vendor icons check

lists: fetch build

fetch:
	cd filters && node scripts/fetch.js

build:
	cd filters && node scripts/build.js && node scripts/validate.js

test:
	cd filters && node --test test/*.test.js

smoke:
	cd filters && node test-browser/smoke.js

project:
	@command -v xcodegen >/dev/null || { echo "Install XcodeGen first: brew install xcodegen"; exit 1; }
	@test -f Local.xcconfig || { cp Local.xcconfig.example Local.xcconfig; echo ">> Created Local.xcconfig — edit ABD_BUNDLE_PREFIX (and DEVELOPMENT_TEAM) then re-run."; }
	xcodegen generate --spec project.yml

project-overflow:
	@command -v xcodegen >/dev/null || { echo "Install XcodeGen first: brew install xcodegen"; exit 1; }
	@test -f Local.xcconfig || cp Local.xcconfig.example Local.xcconfig
	sed 's/^#OVERFLOW#//' project.yml > .project-overflow.yml
	xcodegen generate --spec .project-overflow.yml --project .
	rm -f .project-overflow.yml

vendor:
	rm -rf /tmp/abd-dr && mkdir -p /tmp/abd-dr && cd /tmp/abd-dr && npm pack darkreader --silent && tar xzf darkreader-*.tgz
	cp /tmp/abd-dr/package/darkreader.js WebExtension/Resources/vendor/darkreader.js
	cp /tmp/abd-dr/package/LICENSE WebExtension/Resources/vendor/darkreader.LICENSE.txt
	@grep -m1 -o 'Dark Reader v[0-9.]*' WebExtension/Resources/vendor/darkreader.js

icons:
	python3 scripts/make_icons.py

check:
	cd filters && node --test test/*.test.js && node scripts/validate.js
