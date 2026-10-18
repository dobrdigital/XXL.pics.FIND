// MV3 service worker. Replaces the MV2 persistent background page.
//
// Cross-origin request proxy: the content script sends {type: "request", data}
// and gets back {type: "id", data: reqid}. The result is pushed later to the
// requesting frame as {type: "request", data: {id, event, data, final}}, where
// event is onload | onerror | onabort | ontimeout.
//
// Custom request headers (Referer, Origin, ...) cannot be set on fetch() from
// an extension, so each request gets a temporary declarativeNetRequest session
// rule. Rules are removed as soon as the request settles.
//
// Message types come from the userscript's extension_send_message calls:
//   request / abort_request   cross-origin fetch proxy; results are pushed to the frame
//   download, newtab          chrome.downloads / chrome.tabs, keeping the image's headers
//   getcookies, getvalue, setvalue, get_lib, add_to_history, override_next_headers
//   context menu              "XXL Find This HiRes" sends {type: "context_imu"}
//
// Custom request headers (Referer, Origin, ...) cannot be set on fetch() from an
// extension, so they go through temporary declarativeNetRequest session rules.

// Reads image sizes from file headers (probeImageSize); shared with the gallery page.
importScripts("js/imagesize.js");

const MENU_ID = "imu-find-larger";
const SCAN_MENU_ID = "imu-scan-page";
const SCAN_PREFIX = "scan:";
const SCAN_TTL_MS = 60 * 60_000; // gallery data is dropped after an hour
const MAX_SCAN_ITEMS = 400;
const NET_PREFIX = "net:"; // video/stream files seen on the network, per tab
const MEDIA_PREFIX = "media:"; // media a site's own API returned (see js/media-hook.js), per tab
const MAX_CAPTURED = 300;
const RULE_TTL_MS = 60_000; // also the life of a pending viewer entry
const RULE_ALARM_PREFIX = "imu-rule-";
const VIEW_PREFIX = "view:";
const inflight = new Map(); // reqid -> { controller, target, ruleId }

// Requests the worker makes itself (the proxy).
const XHR_TYPES = ["xmlhttprequest", "other"];
// Requests the page makes after override_next_headers: <img> is "image", <video> and
// <audio> are "media". Without these types the headers would never reach the image.
const PAGE_TYPES = ["image", "media", "xmlhttprequest", "other"];

// ---- install and context menu ----------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  const { imu_enabled, extension_contextmenu } = await chrome.storage.sync.get(["imu_enabled", "extension_contextmenu"]);
  if (imu_enabled === undefined) await chrome.storage.sync.set({ imu_enabled: "true" });
  setContextMenu(parseFlag(extension_contextmenu, true));
});

function setContextMenu(enabled) {
  chrome.contextMenus.removeAll(() => {
    if (enabled) {
      // Chrome folds an extension's top-level items into one submenu as soon as there are
      // two of them shown together. Two flat lines are only possible if they never appear
      // at the same time, so the contexts are split: over a picture, video or link only
      // "Find This"; anywhere else on the page only "Find All". "Find All" over a picture
      // stays reachable with the keyboard shortcut (see chrome.commands below) and the
      // popup button.
      chrome.contextMenus.create({
        id: MENU_ID,
        title: "XXL Find This HiRes",
        contexts: ["link", "image", "video", "audio"],
      });
      chrome.contextMenus.create({
        id: SCAN_MENU_ID,
        title: "XXL Find All HiRes",
        contexts: ["page", "frame", "selection", "editable"],
      });
    }
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || tab.id === undefined) return;
  if (info.menuItemId === MENU_ID) {
    chrome.tabs.sendMessage(tab.id, { type: "context_imu" }).catch(() => {});
  } else if (info.menuItemId === SCAN_MENU_ID) {
    scanPage(tab.id).catch(() => {}); // pages Chrome does not allow scripts on do nothing
  }
});

// Keyboard shortcut for "XXL Find All HiRes", for when the pointer is over a picture and
// the right-click menu offers only "Find This". The key can be changed on
// chrome://extensions/shortcuts.
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "find-all") return;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab && tab.id !== undefined) scanPage(tab.id).catch(() => {});
});

// ---- session rules for request headers --------------------------------------

// A rule is removed when its request settles. An alarm removes it after RULE_TTL_MS
// as a backstop: the worker can be stopped mid-request, and a setTimeout would die
// with it, while alarms survive a worker restart. Session rules are also cleared by
// Chrome when the browser closes. Rule ids are random, so nothing has to be kept in
// memory and a restarted worker cannot reuse an id that is still in use.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith(RULE_ALARM_PREFIX)) {
    chrome.declarativeNetRequest
      .updateSessionRules({ removeRuleIds: [Number(alarm.name.slice(RULE_ALARM_PREFIX.length))] })
      .catch(() => {});
  }
});

function newRuleId() {
  return (crypto.getRandomValues(new Uint32Array(1))[0] % 0x7fffffff) + 1;
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");
}

// Only web URLs go through the proxy and the header rules. Without this the proxy
// could be asked to read chrome-extension:// or other internal URLs.
function webUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("only http(s) URLs are supported");
  }
  return parsed;
}

// URLs a content script may ask the worker to open in a tab or download. A content script
// runs inside every page, so chrome://, file:// and extension pages are refused here.
function openableUrl(url) {
  const protocol = new URL(url).protocol;
  if (!["http:", "https:", "data:", "blob:"].includes(protocol)) {
    throw new Error("unsupported URL scheme " + protocol);
  }
  return url;
}

// Matches exactly one URL. urlFilter has no size limit and no regex-rule quota
// (Chrome allows 1000 regex rules); regexFilter is the fallback for URLs that contain
// urlFilter's own wildcard characters. Rules must be ASCII, so the URL is normalised
// first (this percent-encodes non-ASCII characters). A #fragment is kept: Chrome
// matches rules against the URL with the fragment (tested), so dropping it would
// make the rule miss.
function urlCondition(url) {
  const href = webUrl(url).href;
  return /[*^|]/.test(href)
    ? { regexFilter: "^" + escapeRegex(href) + "$" }
    : { urlFilter: "|" + href + "|" };
}

// Returns the rule id, or null when there is nothing to change.
// Adds a rule that sets (or removes, for null/"") the given headers on requests
// matching url. Returns the rule id, or null when there are no headers.
async function addHeaderRule(url, headers, condition) {
  /** @type {chrome.declarativeNetRequest.ModifyHeaderInfo[]} */
  const requestHeaders = Object.entries(headers || {}).map(([name, value]) =>
    value === null || value === undefined || value === ""
      ? { header: name, operation: "remove" }
      : { header: name, operation: "set", value: String(value) });
  if (requestHeaders.length === 0) return null;

  const id = newRuleId();
  await chrome.declarativeNetRequest.updateSessionRules({
    addRules: [{
      id,
      priority: 1,
      action: { type: "modifyHeaders", requestHeaders },
      condition: { ...urlCondition(url), ...condition },
    }],
  });
  chrome.alarms.create(RULE_ALARM_PREFIX + id, { when: Date.now() + RULE_TTL_MS });
  return id;
}

async function releaseHeaderRule(ruleId) {
  if (ruleId === null || ruleId === undefined) return;
  chrome.alarms.clear(RULE_ALARM_PREFIX + ruleId);
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] }).catch(() => {});
}

// ---- cross-origin request proxy ---------------------------------------------

function headersToString(headers) {
  let out = "";
  headers.forEach((value, name) => {
    out += name + ": " + value + "\r\n";
  });
  return out;
}

// The content script decodes this with charCodeAt, so keep one byte per char.
function bytesToBinaryString(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return out;
}

function sendEvent(reqid, entry, event, data) {
  const message = { type: "request", data: { id: reqid, event, data, final: true } };
  const sent = entry.target
    ? chrome.tabs.sendMessage(entry.target.tabId, message, { frameId: entry.target.frameId })
    : chrome.runtime.sendMessage(message);
  sent.catch(() => {}); // the tab or page may have closed
}

async function runRequest(reqid, request) {
  const entry = inflight.get(reqid);
  const { controller } = entry;
  const url = request.url;
  const method = (request.method || "GET").toUpperCase();
  const empty = { status: 0, statusText: "", finalUrl: url, responseHeaders: "", responseText: "" };
  let timedOut = false;
  const timer = request.timeout
    ? setTimeout(() => { timedOut = true; controller.abort(); }, request.timeout)
    : null;

  try {
    // data: URLs need no network and no headers. Everything else must be http(s);
    // webUrl throws for other schemes, which is reported as onerror below.
    if (!/^data:/i.test(url)) {
      webUrl(url);
      // tabIds [TAB_ID_NONE] limits the rule to requests that do not come from a tab,
      // which is how a service worker's fetch() is seen, so a page's own request to the
      // same URL is never changed by this rule.
      entry.ruleId = await addHeaderRule(url, request.headers, {
        resourceTypes: XHR_TYPES,
        tabIds: [chrome.tabs.TAB_ID_NONE],
      });
    }

    /** @type {RequestInit} */
    const init = {
      method,
      credentials: request.anonymous ? "omit" : "include",
      redirect: request.redirect === "manual" ? "manual" : "follow",
      cache: "no-store",
      signal: controller.signal,
    };
    if (request.data != null && method !== "GET" && method !== "HEAD") {
      init.body = request.data;
    }

    const response = await fetch(url, init);
    const base = {
      status: response.status,
      statusText: response.statusText,
      finalUrl: response.url || url,
      responseHeaders: headersToString(response.headers),
    };

    let payload;
    const responseType = request.responseType || "text";
    if (responseType === "blob" || responseType === "arraybuffer") {
      const buffer = await response.arrayBuffer();
      payload = {
        ...base,
        responseType: "blob",
        _wanted_responseType: responseType === "arraybuffer" ? "arraybuffer" : "blob",
        _responseEncoded: {
          value: bytesToBinaryString(buffer),
          type: response.headers.get("content-type") || "",
        },
      };
    } else {
      payload = { ...base, responseType, responseText: await response.text() };
    }
    sendEvent(reqid, entry, "onload", payload);
  } catch (error) {
    if (timedOut) {
      sendEvent(reqid, entry, "ontimeout", empty);
    } else if (controller.signal.aborted) {
      sendEvent(reqid, entry, "onabort", empty);
    } else {
      sendEvent(reqid, entry, "onerror", { ...empty, error: String(error && error.message) });
    }
  } finally {
    if (timer) clearTimeout(timer);
    await releaseHeaderRule(entry.ruleId);
    inflight.delete(reqid);
  }
}

// ---- downloads and new tabs --------------------------------------------------

async function downloadImage(imu, saveAs) {
  openableUrl(imu.url);
  // Images that need headers are fetched by the viewer page through the proxy and
  // saved from a blob URL there (chrome.downloads only accepts a few request headers).
  if (Object.keys(imu.headers || {}).length > 0) {
    const key = await stashView({ url: imu.url, headers: imu.headers, mode: "download", saveAs });
    await chrome.tabs.create({ url: chrome.runtime.getURL("html/viewer.html?k=" + key), active: false });
    return;
  }
  try {
    await chrome.downloads.download({ url: imu.url, saveAs });
  } catch (error) {
    // downloads.download rejects some headers; open the image so the user still gets it.
    await chrome.tabs.create({ url: imu.url, active: false });
  }
}

// Earlier design, replaced: start the new tab on about:blank so the header rule
// covers the image's first request. That does not work in Chrome (see below).
// Chrome does not apply DNR header rules to top-level navigations (tested), so an
// image that needs headers opens in html/viewer.html, which fetches it through the
// proxy. The headers wait here under a one-time key until the viewer asks for them.
// They are kept in chrome.storage.session (memory only, cleared when the browser
// closes) and not in a Map, because the worker can be stopped between this message
// and the viewer's request, which would lose a Map.
async function stashView(view) {
  const key = crypto.randomUUID();
  await chrome.storage.session.set({ [VIEW_PREFIX + key]: { ...view, expires: Date.now() + RULE_TTL_MS } });
  return key;
}

// Reads and removes the entry. Returns null when it is missing or expired.
async function takeView(key) {
  const name = VIEW_PREFIX + key;
  const entry = /** @type {{ expires: number, url: string, headers: object, mode?: string, saveAs?: boolean } | undefined} */ (
    (await chrome.storage.session.get(name))[name]
  );
  await chrome.storage.session.remove(name);
  if (!entry || !(entry.expires > Date.now())) return null;
  const { expires, ...view } = entry;
  return view;
}

async function openImageTab(imu, background, openerTabId) {
  openableUrl(imu.url);
  const options = { openerTabId };
  if (background !== undefined) options.active = !background;

  if (Object.keys(imu.headers || {}).length === 0) {
    return chrome.tabs.create({ ...options, url: imu.url });
  }
  const key = await stashView({ url: imu.url, headers: imu.headers });
  return chrome.tabs.create({ ...options, url: chrome.runtime.getURL("html/viewer.html?k=" + key) });
}

// ---- page scan: find the largest pictures on the page ------------------------

// Runs inside the page: chrome.scripting.executeScript serialises this function, so it
// must not use anything else from this file. It returns every image URL the page
// offers, with the best size the markup gives. The gallery page measures real sizes.
// It is async: it waits for the site rules of the content script (maxurl) to name the
// original file behind a thumbnail URL.
async function collectImages() {
  const found = new Map(); // absolute URL -> { url, source, width, height, from? }
  const IMAGE_FILE = /\.(?:jpe?g|png|gif|webp|avif|bmp|svg|tiff?)(?:[?#]|$)/i;

  function add(raw, source, width = 0, height = 0, kind = "image", from = "") {
    if (!raw) return;
    let url;
    try {
      url = new URL(raw.trim(), document.baseURI).href;
    } catch (error) {
      return;
    }
    if (!/^https?:/i.test(url)) return;
    const known = found.get(url);
    if (!known || width * height > known.width * known.height) {
      const item = { url, kind, source: known ? known.source : source, width, height };
      if (from) item.from = from;
      found.set(url, item);
    }
  }

  // "a.jpg 480w, b.jpg 2x" -> [{ url, width }]. Commas inside a URL are kept: a
  // candidate ends at a comma that follows a descriptor, or at a comma and a space.
  function addSrcset(value, source) {
    for (const part of value.split(/(?<=\d[wx]),\s*|,\s+/)) {
      const match = part.trim().match(/^(\S+)(?:\s+(\d+(?:\.\d+)?)([wx]))?$/);
      if (match) add(match[1], source, match[3] === "w" ? Number(match[2]) : 0);
    }
  }

  // Every open shadow root on the page. Sites built from web components (Rotten
  // Tomatoes' <rt-img>, for one) keep their <img> elements inside them, where
  // document.querySelectorAll and document.images do not look. Closed roots cannot be
  // reached from a script and are skipped.
  /** @type {(Document | ShadowRoot)[]} */
  const roots = [document];
  for (let i = 0; i < roots.length && roots.length < 3000; i++) {
    for (const element of roots[i].querySelectorAll("*")) {
      if (element.shadowRoot) roots.push(element.shadowRoot);
    }
  }
  const queryAll = (selector) => roots.flatMap((root) => [...root.querySelectorAll(selector)]);

  // Lazy-loading sites keep the real URL in data-* attributes of every kind.
  function addAttributes(element) {
    for (const attr of element.attributes) {
      if (attr.value.length > 2000) continue;
      if (/srcset/i.test(attr.name)) {
        addSrcset(attr.value, "srcset");
      } else if (/^(?:https?:)?\/\/\S+$|^\/\S+$/.test(attr.value) &&
                 (IMAGE_FILE.test(attr.value) || /src|original|large|full|zoom|lazy|img|image/i.test(attr.name))) {
        add(attr.value, "attribute");
      }
    }
  }

  for (const img of queryAll("img")) {
    add(img.currentSrc || img.src, "img", img.naturalWidth, img.naturalHeight);
    addAttributes(img);
  }
  // The host element of a shadow root often carries the URL itself (<rt-img src=...>).
  for (const root of roots) {
    if (root instanceof ShadowRoot) addAttributes(root.host);
  }
  for (const source of queryAll("source[srcset], source[data-srcset]")) {
    addSrcset(source.getAttribute("srcset") || source.getAttribute("data-srcset") || "", "srcset");
  }
  // Links that go straight to an image file are usually the full-size original.
  for (const link of /** @type {HTMLAnchorElement[]} */ (queryAll("a[href]"))) {
    if (IMAGE_FILE.test(link.href)) add(link.href, "link");
  }
  for (const meta of document.querySelectorAll("meta[property^='og:image'], meta[name^='twitter:image'], link[rel='image_src']")) {
    add(meta.getAttribute("content") || meta.getAttribute("href"), "meta");
  }
  for (const video of queryAll("video[poster]")) add(video.getAttribute("poster"), "poster");
  // Video files. blob: sources (MSE players) are skipped: they only exist inside the page,
  // and the network capture below finds the real files behind them.
  for (const video of /** @type {HTMLVideoElement[]} */ (queryAll("video"))) {
    const sources = [video.currentSrc, video.getAttribute("src")];
    for (const child of video.querySelectorAll("source[src]")) sources.push(child.getAttribute("src"));
    for (const src of sources) add(src, "video", video.videoWidth, video.videoHeight, "video");
  }

  // CSS background images. Capped, because getComputedStyle on a huge page is slow.
  let scanned = 0;
  for (const element of document.querySelectorAll("body *")) {
    if (++scanned > 4000) break;
    const background = getComputedStyle(element).backgroundImage;
    if (!background || background === "none") continue;
    for (const match of background.matchAll(/url\((["']?)(.*?)\1\)/g)) add(match[2], "background");
  }

  // Thumbnail URLs often hide the original: /thumb/a/ab/pic.png/300px-pic.png, or a
  // resizing service that carries the real address inside its own. The site rules of
  // maxurl (the content script, same isolated world, so its global is visible here) know
  // many of these. Each answer is added as its own item with the thumbnail in `from`; the
  // gallery drops the thumbnail once the original has been measured. Capped in count and
  // time, because a rule can be slow and a page can have hundreds of images.
  const imu = /** @type {any} */ (globalThis).$$IMU_EXPORT$$;
  if (typeof imu === "function") {
    const todo = [...found.values()].filter((item) => item.kind === "image" && item.source !== "link").slice(0, 80);
    const deadline = Date.now() + 6000;
    let next = 0;
    const upgrade = (item) => new Promise((resolve) => {
      const timer = setTimeout(resolve, 1500);
      try {
        imu(item.url, {
          fill_object: true,
          cb: (results) => {
            clearTimeout(timer);
            for (const result of results || []) {
              if (result && result.url && result.url !== item.url && !result.is_original) add(result.url, "rule", 0, 0, "image", item.url);
            }
            resolve(undefined);
          },
        });
      } catch (error) {
        clearTimeout(timer);
        resolve(undefined);
      }
    });
    const worker = async () => {
      while (next < todo.length && Date.now() < deadline) await upgrade(todo[next++]);
    };
    await Promise.all(Array.from({ length: 6 }, worker));
  }
  return [...found.values()];
}

// Scans every frame of the tab, merges the results and opens the gallery page.
async function scanPage(tabId) {
  const frames = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: collectImages });
  const merged = new Map();
  const merge = (item) => {
    const candidate = { kind: "image", width: 0, height: 0, ...item };
    const known = merged.get(candidate.url);
    if (!known) {
      merged.set(candidate.url, candidate);
      return;
    }
    // The same file can come from the markup and from the network: keep the larger
    // size, and fill in the byte size and bitrate that only one of them knows.
    if (candidate.width * candidate.height > known.width * known.height) {
      known.width = candidate.width;
      known.height = candidate.height;
    }
    for (const field of ["bytes", "bitrate"]) {
      if (candidate[field] && !known[field]) known[field] = candidate[field];
    }
  };
  for (const frame of frames) {
    for (const item of frame.result || []) merge(item);
  }
  // Files the page loaded that are not in the markup: video and stream requests seen on
  // the network, and media a site's own API returned.
  const captured = await chrome.storage.session.get([NET_PREFIX + tabId, MEDIA_PREFIX + tabId]);
  for (const list of Object.values(captured)) {
    for (const item of /** @type {object[]} */ (list)) merge(item);
  }
  const weight = (item) => (item.bytes || 0) + (item.bitrate || 0);
  const items = [...merged.values()]
    .sort((a, b) => b.width * b.height - a.width * a.height || weight(b) - weight(a))
    .slice(0, MAX_SCAN_ITEMS);

  // Old scans are dropped here, so session storage does not fill up over a long session.
  const stored = await chrome.storage.session.get(null);
  const stale = Object.keys(stored).filter((name) => name.startsWith(SCAN_PREFIX) && /** @type {{ created: number }} */ (stored[name]).created < Date.now() - SCAN_TTL_MS);
  if (stale.length) await chrome.storage.session.remove(stale);

  const tab = await chrome.tabs.get(tabId);
  const key = crypto.randomUUID();
  await chrome.storage.session.set({
    [SCAN_PREFIX + key]: { created: Date.now(), pageUrl: tab.url || "", title: tab.title || "", items },
  });
  await chrome.tabs.create({ url: chrome.runtime.getURL("html/gallery.html?k=" + key), openerTabId: tabId });
  return { key, count: items.length };
}

// ---- network capture: video and stream files the page loads ------------------

// The worker can be stopped at any time, so captured items are kept in session storage.
// Writes to one list are chained, because each one reads the list and writes it back.
const mediaWrites = new Map(); // storage key -> promise of the last write
const seenMedia = new Set(); // "tabId url", so a video's many range requests write once

function rememberMedia(prefix, tabId, items) {
  const key = prefix + tabId;
  const next = (mediaWrites.get(key) || Promise.resolve()).then(async () => {
    const current = /** @type {{ url: string }[]} */ ((await chrome.storage.session.get(key))[key] || []);
    const byUrl = new Map(current.map((item) => [item.url, item]));
    for (const item of items) byUrl.set(item.url, { ...byUrl.get(item.url), ...item });
    await chrome.storage.session.set({ [key]: [...byUrl.values()].slice(-MAX_CAPTURED) });
  }).catch(() => {});
  mediaWrites.set(key, next);
  return next;
}

// Observe only: nothing is blocked or changed. The first filter covers <video> and
// <audio> loads. The second covers players that fetch playlists and files themselves
// (HLS/DASH), and is limited by URL so that ordinary requests do not wake the worker.
function captureResponse(details) {
  if (details.tabId < 0) return;
  const header = (name) => {
    const found = (details.responseHeaders || []).find((entry) => entry.name.toLowerCase() === name);
    return (found && found.value) || "";
  };
  const type = header("content-type").toLowerCase();
  let kind = null;
  if (/mpegurl|dash\+xml/.test(type) || /\.(?:m3u8|mpd)(?:[?#]|$)/i.test(details.url)) kind = "stream";
  else if (type.startsWith("video/") || /\.(?:mp4|webm|mov|m4v)(?:[?#]|$)/i.test(details.url)) kind = "video";
  if (!kind) return;
  const seen = details.tabId + " " + details.url;
  if (seenMedia.has(seen)) return;
  if (seenMedia.size > 5000) seenMedia.clear(); // only a shortcut against repeated writes
  seenMedia.add(seen);
  // A range request answers "bytes a-b/total"; the total is the size of the file.
  const range = header("content-range").match(/\/(\d+)$/);
  const bytes = range ? Number(range[1]) : Number(header("content-length")) || 0;
  rememberMedia(NET_PREFIX, details.tabId, [{ url: details.url, kind, source: "network", bytes, width: 0, height: 0 }]);
}

chrome.webRequest.onResponseStarted.addListener(captureResponse, { urls: ["<all_urls>"], types: ["media"] }, ["responseHeaders"]);
chrome.webRequest.onResponseStarted.addListener(captureResponse, {
  urls: ["*://*/*.m3u8*", "*://*/*.mpd*", "*://*/*.mp4*", "*://*/*.webm*"],
  types: ["xmlhttprequest", "other"],
}, ["responseHeaders"]);

// Forgets what a tab loaded. Goes through the same write chain as rememberMedia, so a
// write that is still running cannot put the old list back afterwards.
function forgetMedia(tabId) {
  for (const seen of seenMedia) {
    if (seen.startsWith(tabId + " ")) seenMedia.delete(seen);
  }
  for (const key of [NET_PREFIX + tabId, MEDIA_PREFIX + tabId]) {
    const next = (mediaWrites.get(key) || Promise.resolve())
      .then(() => chrome.storage.session.remove(key))
      .catch(() => {});
    mediaWrites.set(key, next);
  }
}

// A new document in the tab starts a new list. Without this a scan of page B also listed
// the videos of page A that was open in the same tab before. Same-document navigations
// (history.pushState on x.com) make no main_frame request and keep the list.
chrome.webRequest.onBeforeRequest.addListener((details) => {
  if (details.tabId >= 0) forgetMedia(details.tabId);
  return undefined; // observe only; the types want a BlockingResponse
}, { urls: ["<all_urls>"], types: ["main_frame"] });

chrome.tabs.onRemoved.addListener((tabId) => {
  forgetMedia(tabId);
  mediaWrites.delete(NET_PREFIX + tabId);
  mediaWrites.delete(MEDIA_PREFIX + tabId);
});

// ---- hover download button: the best source file for one picture or video -----

// url -> Promise of its size. A page's images are probed once per worker run.
const probeCache = new Map();
function probeCached(url) {
  if (probeCache.size > 500) probeCache.clear();
  if (!probeCache.has(url)) {
    // A failure (timeout, a server that was busy) is not kept, so the next hover tries again.
    const probe = probeImageSize(url).then((size) => {
      if (!size) probeCache.delete(url);
      return size;
    });
    probeCache.set(url, probe);
  }
  return probeCache.get(url);
}

// Of the candidate URLs for one image (srcset entries, lazy-load attributes, a link
// to the original), returns the one with the most pixels, or null if none can be read.
async function bestSource(urls) {
  const list = [...new Set(urls)].filter((url) => /^https?:/i.test(url)).slice(0, 12);
  const probed = await Promise.all(list.map(async (url) => ({ url, size: await probeCached(url) })));
  let best = null;
  for (const { url, size } of probed) {
    if (!size) continue;
    const area = size.width * size.height;
    if (!best || area > best.area || (area === best.area && size.bytes > best.bytes)) {
      best = { url, width: size.width, height: size.height, bytes: size.bytes, area };
    }
  }
  return best && { url: best.url, width: best.width, height: best.height, bytes: best.bytes };
}

// The best downloadable video this tab has loaded: from the network capture and from a
// site's own API (X). Streams are skipped, because they cannot be saved as one file.
async function bestVideo(tabId) {
  const stored = await chrome.storage.session.get([NET_PREFIX + tabId, MEDIA_PREFIX + tabId]);
  const captured = /** @type {{ url: string, kind?: string, width?: number, height?: number, bitrate?: number, bytes?: number }[]} */ (
    Object.values(stored).flat()
  );
  const videos = captured.filter((item) => item && item.kind === "video");
  videos.sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0)
    || (b.bitrate || 0) - (a.bitrate || 0) || (b.bytes || 0) - (a.bytes || 0));
  const best = videos[0];
  return best ? { url: best.url, width: best.width || 0, height: best.height || 0, bytes: best.bytes || 0 } : null;
}

// ---- cookies, storage, libraries, history ----------------------------------

async function cookieHeader(url) {
  const cookies = await chrome.cookies.getAll({ url });
  return cookies.map((cookie) => cookie.name + "=" + cookie.value).join("; ");
}

// Libraries live in lib/<name>.js inside the extension. Names are restricted so
// the message cannot reach other files.
async function getLib(name) {
  if (!/^[\w.-]+$/.test(name)) return null;
  try {
    const response = await fetch(chrome.runtime.getURL("lib/" + name + ".js"));
    return response.ok ? { text: await response.text() } : null;
  } catch (error) {
    return null; // this build ships no lib/ folder
  }
}

// Stored flags are JSON strings, e.g. "false".
function parseFlag(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== "string") return Boolean(value);
  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
}

// ---- message dispatch -------------------------------------------------------

const handlers = {
  ready: () => ({ ok: true }),

  request(message, sender) {
    const reqid = crypto.randomUUID();
    inflight.set(reqid, {
      controller: new AbortController(),
      target: sender.tab ? { tabId: sender.tab.id, frameId: sender.frameId } : null,
      ruleId: null,
    });
    runRequest(reqid, message.data || {});
    return { type: "id", data: reqid };
  },

  abort_request(message) {
    const entry = inflight.get(message.data);
    if (entry) entry.controller.abort();
  },

  async download(message) {
    await downloadImage(message.data.imu, Boolean(message.data.force_saveas));
    return { type: "download" };
  },

  async newtab(message, sender) {
    await openImageTab(message.data.imu, message.data.background, sender.tab && sender.tab.id);
    return { type: "newtab" };
  },

  // From js/media-relay.js: media that a site's own API returned (original photos, every
  // video variant). Only http(s) URLs are kept, and the fields are normalised.
  async media_found(message, sender) {
    if (sender.tab && Array.isArray(message.data)) {
      const items = message.data
        .filter((item) => item && typeof item.url === "string" && /^https?:/i.test(item.url))
        .map((item) => ({
          url: item.url,
          kind: ["image", "video", "stream"].includes(item.kind) ? item.kind : "video",
          source: String(item.source || "site").slice(0, 30),
          width: Number(item.width) || 0,
          height: Number(item.height) || 0,
          bitrate: Number(item.bitrate) || 0,
        }));
      await rememberMedia(MEDIA_PREFIX, sender.tab.id, items);
    }
    return { type: "media_found" };
  },

  // From js/hover-button.js. The result decides whether the button is shown at all.
  async best_source(message) {
    const urls = message.data && Array.isArray(message.data.urls) ? message.data.urls.filter((url) => typeof url === "string") : [];
    return { type: "best_source", data: await bestSource(urls) };
  },

  async best_video(message, sender) {
    return { type: "best_video", data: sender.tab ? await bestVideo(sender.tab.id) : null };
  },

  // Sent by the toolbar popup with the tab it was opened on. Without a tabId the active
  // tab of the current window is used.
  async scan_page(message) {
    let tabId = message.data && message.data.tabId;
    if (tabId === undefined) {
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
      tabId = active && active.id;
    }
    if (tabId === undefined) throw new Error("no active tab");
    return { type: "scan_page", data: await scanPage(tabId) };
  },

  async getcookies(message) {
    return { type: "cookies", data: await cookieHeader(message.data.url) };
  },

  async getvalue(message) {
    return { type: "getvalue", data: await chrome.storage.sync.get(message.data) };
  },

  async setvalue(message) {
    await chrome.storage.sync.set(message.data);
    if ("extension_contextmenu" in message.data) {
      setContextMenu(parseFlag(message.data.extension_contextmenu, true));
    }
    return { type: "setvalue" };
  },

  async get_lib(message) {
    return { type: "get_lib", data: await getLib(message.data.name) };
  },

  async get_view(message) {
    return { type: "get_view", data: await takeView(message.data.key) };
  },

  async add_to_history(message) {
    if (await chrome.permissions.contains({ permissions: ["history"] })) {
      await chrome.history.addUrl({ url: message.data.url });
    }
  },

  async override_next_headers(message) {
    // The rule is for the page's own next load of this URL (img.src, new Image()), not
    // for the proxy. It is removed by its alarm after RULE_TTL_MS.
    const { url, headers } = message.data;
    await addHeaderRule(url, headers, { resourceTypes: PAGE_TYPES });
    return { type: "override_next_headers" };
  },

  // Not ported: "bg_redirect" (showing the larger image in place of the page)
  // and notifications. The new tab simply shows the image.
  redirect: () => ({ type: "redirect" }),
  notification: () => ({ data: null }),
};

// Messages only the extension's own pages send (popup, gallery, viewer). Content scripts
// run inside every web page, so they must not start a scan of another tab or read a
// pending viewer entry.
const PAGE_ONLY = new Set(["scan_page", "get_view"]);

function fromExtensionPage(sender) {
  // The viewer and the gallery are tabs too, so sender.tab says nothing; the URL does.
  return sender.id === chrome.runtime.id && String(sender.url).startsWith(chrome.runtime.getURL(""));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message && message.type;
  // Object.hasOwn: a type such as "toString" must not reach Object.prototype.
  const handler = typeof type === "string" && Object.hasOwn(handlers, type) ? handlers[type] : null;
  if (handler && PAGE_ONLY.has(type) && !fromExtensionPage(sender)) {
    sendResponse({ error: "not allowed from a web page", type });
    return false;
  }
  if (!handler) {
    sendResponse({ error: "not ported to MV3 yet", type: message && message.type });
    return false;
  }
  Promise.resolve()
    .then(() => handler(message, sender))
    .then(sendResponse, (error) => sendResponse({ error: String(error && error.message) }));
  return true; // reply is sent asynchronously
});
