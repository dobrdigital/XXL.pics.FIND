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
//   context menu              "Try to find larger image" sends {type: "context_imu"}
//
// Custom request headers (Referer, Origin, ...) cannot be set on fetch() from an
// extension, so they go through temporary declarativeNetRequest session rules.

const MENU_ID = "imu-find-larger";
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
      chrome.contextMenus.create({
        id: MENU_ID,
        title: "Try to find larger image",
        contexts: ["page", "link", "image", "video", "audio"],
      });
    }
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID && tab) {
    chrome.tabs.sendMessage(tab.id, { type: "context_imu" }).catch(() => {});
  }
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
    webUrl(url); // throws for anything but http(s); reported as onerror below
    // tabIds [TAB_ID_NONE] limits the rule to requests that do not come from a tab, which
    // is how a service worker's fetch() is seen, so a page's own request to the same URL
    // is never changed by this rule.
    entry.ruleId = await addHeaderRule(url, request.headers, {
      resourceTypes: XHR_TYPES,
      tabIds: [chrome.tabs.TAB_ID_NONE],
    });

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
  const stored = await chrome.storage.session.get(name);
  await chrome.storage.session.remove(name);
  const { expires, ...view } = stored[name] || {};
  return stored[name] && expires > Date.now() ? view : null;
}

async function openImageTab(imu, background, openerTabId) {
  const options = { openerTabId };
  if (background !== undefined) options.active = !background;

  if (Object.keys(imu.headers || {}).length === 0) {
    return chrome.tabs.create({ ...options, url: imu.url });
  }
  const key = await stashView({ url: imu.url, headers: imu.headers });
  return chrome.tabs.create({ ...options, url: chrome.runtime.getURL("html/viewer.html?k=" + key) });
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message && message.type];
  if (!handler) {
    sendResponse({ error: "not ported to MV3 yet", type: message && message.type });
    return false;
  }
  Promise.resolve()
    .then(() => handler(message, sender))
    .then(sendResponse, (error) => sendResponse({ error: String(error && error.message) }));
  return true; // reply is sent asynchronously
});
