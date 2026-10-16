# XXL.pics.FIND

Chrome extension (Manifest V3) that finds the largest version of a picture, and the largest
pictures on a page, and lets you download them.

Copyright: DEV + DESIGN = REAILISM

It is a Manifest V3 port of the unmaintained MV2 extension "Larger image finder" 0.8.0. The
site rules come from [Image Max URL (maxurl)](https://github.com/qsniyg/maxurl) by qsniyg
(Apache-2.0), vendored as `userscript.user.js`. See `NOTICE`.

## What it does

- **Hover download button.** A green pill on pictures and videos under the mouse, labelled
  with the size of the largest file it found (`⬇ 1920×1080 · 454 KB`). One click saves it.
  The popup has a switch for it.
- **Right-click menu.**
  - `XXL Find This HiRes` over a picture, video, audio or link: opens the larger file.
  - `XXL Find All HiRes` anywhere else on the page: opens a gallery of every picture on the
    page, largest first, nine at a time (`SHOW NEXT 9`). Also on `Alt+Shift+A` (change it on
    `chrome://extensions/shortcuts`), and as a button in the toolbar popup.
- **Pictures inside web components** (open shadow DOM, for example Rotten Tomatoes) are found.
- **Original behind a thumbnail.** The site rules name the original file; the gallery shows
  the original instead of the thumbnail once it has been measured.
- **Video and streams.** Video files, HLS/DASH playlists the page loads, and the video
  variants X (x.com) returns are listed too. The X part is only tested against a fixture, not
  against live x.com.
- Sizes are read from the first 64 KB of each file (PNG, JPEG, GIF, WebP, AVIF), so nothing
  has to be downloaded in full to rank it.

## Install (from source)

1. Download or clone this folder.
2. Open `chrome://extensions`, turn on Developer mode, press "Load unpacked" and choose the
   folder. Chrome 120 or newer.

The extension id depends on the folder path unless the manifest gets a `key`.

## Develop

```
npm install            # development tools only; the extension has no dependencies
npm run typecheck      # tsc with checkJs
npm test               # node tests/run-tests.mjs
```

`npm test` starts a hidden headless Chrome with a temporary profile and loads the folder with
the DevTools command `Extensions.loadUnpacked`, then runs 40 end-to-end checks against a
local test site. Set `CHROME_PATH` if Chrome is not in Program Files and `CDP_PORT` if port
9333 is busy. `node tools/load-extension.mjs [port]` loads the folder into a Chrome you
started yourself with `--remote-debugging-port` and `--enable-unsafe-extension-debugging`.

Rules for changes are in `CLAUDE.md` (keep comments, keep edits to the vendored
`userscript.user.js` minimal and documented, update the name string there if the extension is
renamed again).

## Known gaps

- `userscript.user.js` is about 5 MB; it is loaded on every page.
- Pictures that need a Referer cannot be size-probed, so they get no hover button.
- Closed shadow roots cannot be read.
- The context menu is not covered by the automated tests (Chrome offers no way to click it
  from a script); `scan_page` and `context_imu`, which it sends, are.

## License

Apache License 2.0 (`LICENSE`). The vendored maxurl code is Apache-2.0 by its authors; see
`NOTICE`.
