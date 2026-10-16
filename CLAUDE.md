# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Rules for this project

- Keep every existing comment and code explanation. Do not strip comments, and do not run a minifier that drops them. When code changes, update the comment next to it instead of deleting it.
- When a block of upstream code is disabled, keep the original lines commented out with a note saying why. See the "MV3 fork" comment in `userscript.user.js`, next to `extension_error_handler();`.
- `userscript.user.js` is a vendored build of upstream maxurl. Keep edits to it minimal and say so in a comment.

## What this is

The extension's display name is "XXL.pics.FIND" (set in `_locales/*/messages.json`, key `name`, and in the popup and viewer page titles). The folder name and the original project name are unchanged. It is a Chrome Manifest V3 port of "Larger image finder" 0.8.0, which was MV2 and is no longer maintained. The original lives in the sibling folder `Larger_image_finder/` and is not modified here.

## Commands

- Run the end-to-end checks: `node tests/run-tests.mjs`. It starts a headless Chrome with a temporary profile and download folder, loads this folder through the DevTools `Extensions.loadUnpacked` command, and removes the temporary folders afterwards. Set `CHROME_PATH` if Chrome is not under Program Files, and `CDP_PORT` if port 9333 is busy.
- Type-check the worker, popup, viewer and tests: `npm install` once, then `npm run typecheck` (`tsc` with `checkJs` and `@types/chrome`, see `jsconfig.json`). `userscript.user.js` is excluded. The packages are development tools only. The extension has no dependencies and no build step.
- Regenerate the icons (green leaf, 16/48/128/300 px): `node tools/make-icons.mjs`. It has no dependencies and writes `icons/icon-*.png`.
- Load it by hand: `chrome://extensions`, enable Developer mode, "Load unpacked", and select this folder.
- Checkpoints: this folder is a local git repository. Commit after each change that passes `node tests/run-tests.mjs` and `npm run typecheck`.

## Architecture

- `manifest.json`: MV3. Background is the `background.js` service worker. Content script is `userscript.user.js` on `<all_urls>` in all frames. Toolbar popup is `html/popup.html`. Options page is `html/options.html`.
- `userscript.user.js`: upstream maxurl, about 5 MB, mostly site rules. It runs as the content script and talks to the worker with `chrome.runtime.sendMessage`. It also renders the options UI into `#options`.
- `background.js`: one dispatch table (`handlers`) for every message type the userscript sends.
  - `request` / `abort_request`: cross-origin fetch proxy for http(s) and `data:` URLs. Headers go through temporary `declarativeNetRequest` session rules scoped to the worker's own requests (`tabIds: [TAB_ID_NONE]`), and results are pushed back to the requesting frame.
  - `override_next_headers`: the same kind of rule, but for the page's next `<img>` / media load of that URL, so it matches `image` and `media` as well as XHR types.
  - `download`, `newtab`: images that need headers are handed to the viewer page. Others use `chrome.downloads` or `chrome.tabs` directly.
  - `getcookies`, `getvalue`, `setvalue`, `get_lib`, `add_to_history`.
  - `scan_page`: "Find largest images on this page" (context menu item and popup button). `collectImages` is injected on demand with `chrome.scripting` into all frames, so it costs nothing on ordinary pages. It gathers img/srcset/lazy attributes, links to image files, og:image, video posters and CSS backgrounds. `html/gallery.html` + `js/gallery.js` load them and sort by real pixel size.
  - Video and streams: `chrome.webRequest.onResponseStarted` (observe only, `media` requests plus `.m3u8/.mpd/.mp4/.webm` URLs) records files per tab under `net:<tabId>` in session storage. `scan_page` merges them with the page's `<video>` elements. Cards in the gallery play video files and read an HLS master playlist for its best variant.
  - x.com / twitter.com: `js/media-hook.js` (MAIN world) reads the page's own `/i/api/graphql` and `/i/api/2` responses and reports every video variant and the original photo (`name=orig`). It walks the JSON without assuming a path, so it does not depend on X's query ids or tokens. `js/media-relay.js` forwards the result to the worker (`media_found`, stored as `media:<tabId>`). The parser is unit-tested against a fixture in the shape yt-dlp documents. It has not been run against live x.com (login wall), so check it by hand after X changes its API.
  - Service worker state: nothing is kept only in memory. Pending viewer entries are in `chrome.storage.session` (`view:<key>`, one-time, 60 s). Rule ids are random and rules expire through `chrome.alarms`, so a stopped and restarted worker loses nothing.
  - Context menu "Try to find larger image", which sends `{type: "context_imu"}` to the tab.
- `html/viewer.html` + `js/viewer.js`: opened for images that need headers. It fetches them through the proxy and either shows the image or saves it from a blob URL (download mode), then closes itself.
- `html/popup.html` + `js/popup.js`: Global Enable/Disable toggle, stored as `imu_enabled` in `chrome.storage.sync`.

## Verified in Chrome 155

- DNR header rules apply to fetch and XHR subresource requests. `Referer` is set correctly.
- DNR header rules did not apply to top-level tab navigations in this build, including with `tabIds` and an explicit `main_frame` type. That is why headers-protected images open through the viewer page.
- An idle service worker is not kept alive by an open `runtime.connect` port. The userscript's port was therefore removed. See the "MV3 fork" comment.
- DNR rules are matched against the URL including its `#fragment`, so a rule built from a fetched URL must keep it. Rules must be ASCII: normalise with `new URL(url).href`.
- A `urlFilter` of `|<url>|` matches exactly one URL. Use it instead of `regexFilter`, which is capped at 1000 rules and 2 KB per rule. `regexFilter` stays as the fallback for URLs that contain `*`, `^` or `|`.
- `tabIds: [chrome.tabs.TAB_ID_NONE]` matches the service worker's own `fetch()` and excludes page requests.
- Headless Chrome 155 ignores `--load-extension`. Use the DevTools `Extensions.loadUnpacked` command with `--enable-unsafe-extension-debugging`, as `tests/run-tests.mjs` does.

## Known gaps and dead code

- The `bg_redirect` branch in `userscript.user.js` calls `chrome.tabs.update` from the content script, which Chrome does not allow. The worker never sends `bg_redirect`, and `redirect` is a no-op, so the branch is unreachable.
- `notification` returns `null`. `permission` and `remote` / `remote_reply` (opt-in via `allow_remote`) are not handled and reply with "not ported to MV3 yet".
- There is no `lib/` folder, the same as in the original build. `get_lib` returns `null`.
- The context menu and its `setvalue` toggle are not covered by `tests/run-tests.mjs`.
- The content script is still about 5 MB. Making it smaller without removing comments needs a different approach, such as loading site rules per domain.
