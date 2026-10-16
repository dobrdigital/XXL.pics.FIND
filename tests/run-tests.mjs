// End-to-end checks for the MV3 build. Starts a headless Chrome with a temporary
// profile and download folder, loads this folder as an unpacked extension through
// the DevTools Extensions domain, and checks each message type the userscript uses.
// Usage: node tests/run-tests.mjs
// Environment: CHROME_PATH (default: Chrome under Program Files), CDP_PORT (default 9333).
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = Number(process.env.CDP_PORT || 9333);
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const outcomes = [];

// A solid grey PNG of the given size, so the tests can tell images apart by real size.
function makePng(width, height) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(zlib.crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const row = Buffer.alloc(1 + width * 3, 0x80);
  row[0] = 0;
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function check(name, ok, detail = "") {
  outcomes.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

async function getJson(pathname, init) {
  return (await fetch(`http://127.0.0.1:${PORT}${pathname}`, init)).json();
}

// /json/close answers with plain text, so it gets its own helper.
async function closeTarget(id) {
  await fetch(`http://127.0.0.1:${PORT}/json/close/${id}`);
}

// Minimal DevTools Protocol client over the built-in WebSocket.
function openCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const listeners = [];
  let nextId = 0;
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method) {
      listeners.forEach((fn) => fn(msg));
    }
  };
  const ready = new Promise((resolve) => (ws.onopen = resolve));
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  return {
    ready,
    send,
    async eval(expression) {
      const reply = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      return reply.result.result.value;
    },
    onEvent: (fn) => listeners.push(fn),
    close: () => ws.close(),
  };
}

// Test site: an echo of request headers, a cookie setter, an image that needs a
// Referer, and a page with an image for the content script.
function startSite() {
  let lastReferer = null;
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, "http://site");
    if (pathname === "/headers") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(req.headers));
    }
    if (pathname === "/cookie") {
      res.writeHead(200, { "content-type": "text/html", "set-cookie": "imu_test=abc; Path=/" });
      return res.end("<p>cookie set</p>");
    }
    if (pathname === "/img.png") {
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(PNG);
    }
    if (pathname === "/protected.png") {
      lastReferer = req.headers.referer || null;
      if (!lastReferer) {
        res.writeHead(403);
        return res.end("no referer");
      }
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(PNG);
    }
    // Serves the image only for the exact Referer the tests set. A browser's own Referer
    // for a page on this site would differ, so an ordinary load of this URL gets a 403.
    if (pathname === "/strict.png") {
      if (req.headers.referer !== "https://example.org/page") {
        res.writeHead(403);
        return res.end("wrong referer");
      }
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(PNG);
    }
    if (pathname === "/last") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ referer: lastReferer }));
    }
    if (pathname === "/png" || pathname === "/full.png") {
      const params = new URL(req.url, "http://site").searchParams;
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(makePng(Number(params.get("w")), Number(params.get("h"))));
    }
    // One image per place a page can hide a larger version of a picture.
    if (pathname === "/scan-page") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(`<!doctype html><title>scan page</title>
<meta property="og:image" content="/png?w=1200&h=800">
<img src="/png?w=100&h=66" srcset="/png?w=100&h=66 100w, /png?w=800&h=533 800w" sizes="50px">
<a href="/full.png?w=1600&h=1066"><img src="/png?w=120&h=80"></a>
<div style="width:50px;height:50px;background-image:url(/png?w=400&h=266)"></div>`);
    }
    if (pathname === "/page") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end('<!doctype html><title>page</title><img src="/img.png" width="40" height="40">');
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function waitForChrome() {
  for (let i = 0; i < 60; i++) {
    try {
      return await getJson("/json/version");
    } catch (error) {
      await sleep(250);
    }
  }
  throw new Error(`Chrome did not open the DevTools port ${PORT}`);
}

function stopChrome(child) {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
}

async function main() {
  const site = await startSite();
  const base = `http://127.0.0.1:${site.address().port}`;
  const profile = mkdtempSync(path.join(os.tmpdir(), "imu-profile-"));
  const downloads = mkdtempSync(path.join(os.tmpdir(), "imu-downloads-"));
  // Point Chrome's download folder at the temporary one through the profile. Do not use
  // Browser.setDownloadBehavior: that DevTools override makes Chrome ignore the filename
  // an extension passes to chrome.downloads.download.
  mkdirSync(path.join(profile, "Default"), { recursive: true });
  writeFileSync(path.join(profile, "Default", "Preferences"), JSON.stringify({
    download: { default_directory: downloads, prompt_for_download: false },
  }));
  const chrome = spawn(CHROME, [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--enable-unsafe-extension-debugging",
    "about:blank",
  ], { stdio: "ignore" });

  try {
    const version = await waitForChrome();
    const browser = openCdp(version.webSocketDebuggerUrl);
    await browser.ready;
    const loaded = await browser.send("Extensions.loadUnpacked", { path: ROOT });
    const extId = loaded.result.id;

    // Opens a page target and returns a client for it.
    async function openTarget(url) {
      const target = await getJson(`/json/new?${url}`, { method: "PUT" });
      const cdp = openCdp(target.webSocketDebuggerUrl);
      await cdp.ready;
      return { target, cdp };
    }

    const popup = await openTarget(`chrome-extension://${extId}/html/popup.html`);
    await sleep(800);
    await popup.cdp.eval(`window.__events = []; chrome.runtime.onMessage.addListener((m) => { if (m && m.type === "request" && m.data && m.data.event) window.__events.push(m.data); }); true`);

    const send = (message) => popup.cdp.eval(`new Promise((resolve) => chrome.runtime.sendMessage(${JSON.stringify(message)}, resolve))`);

    // Starts a proxied request and waits for its pushed event.
    async function proxied(data) {
      const started = await send({ type: "request", data });
      for (let i = 0; i < 100; i++) {
        const event = await popup.cdp.eval(`window.__events.find((e) => e.id === ${JSON.stringify(started.data)}) || null`);
        if (event) return event;
        await sleep(100);
      }
      return null;
    }

    // Proxy: headers and blob payloads.
    const text = await proxied({ url: `${base}/headers`, headers: { Referer: "https://example.org/page", "X-Custom-Test": "1" }, responseType: "text" });
    const echoed = text && text.data.responseText ? JSON.parse(text.data.responseText) : {};
    check("proxy text request keeps custom headers", text?.event === "onload" && echoed.referer === "https://example.org/page" && echoed["x-custom-test"] === "1");

    const blob = await proxied({ url: `${base}/img.png`, responseType: "blob" });
    check("proxy blob request returns the image bytes", blob?.event === "onload" && blob.data._responseEncoded.value.length === PNG.length, `${blob?.data?._responseEncoded?.value?.length ?? "none"} bytes`);

    // Popup toggle.
    await popup.cdp.eval(`document.getElementById("global-disable").click(), true`);
    await sleep(300);
    const disabled = await popup.cdp.eval(`new Promise((r) => chrome.storage.sync.get(["imu_enabled"], r))`);
    await popup.cdp.eval(`document.getElementById("global-enable").click(), true`);
    await sleep(300);
    const enabled = await popup.cdp.eval(`new Promise((r) => chrome.storage.sync.get(["imu_enabled"], r))`);
    check("popup toggle writes imu_enabled", disabled.imu_enabled === "false" && enabled.imu_enabled === "true");
    // The popup stays open: extension messages below are sent from it.

    // Content script: the userscript must load on an ordinary page without errors.
    const page = await openTarget(`${base}/page`);
    const problems = [];
    page.cdp.onEvent((msg) => {
      if (msg.method === "Runtime.exceptionThrown") problems.push((msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text).split("\n")[0]);
      if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") problems.push("console.error");
    });
    await page.cdp.send("Runtime.enable");
    await sleep(4000);
    check("content script loads on a normal page", problems.length === 0, problems.slice(0, 3).join("; "));
    page.cdp.close();
    await closeTarget(page.target.id);

    // Cookies: visit the cookie page first so the browser stores the cookie.
    const cookiePage = await openTarget(`${base}/cookie`);
    await sleep(800);
    cookiePage.cdp.close();
    await closeTarget(cookiePage.target.id);
    const cookies = await send({ type: "getcookies", data: { url: `${base}/` } });
    check("getcookies returns the page cookies", cookies.data.includes("imu_test=abc"), cookies.data);

    // Storage and the context-menu flag.
    await send({ type: "setvalue", data: { imu_test_key: "xyz" } });
    const stored = await send({ type: "getvalue", data: ["imu_test_key"] });
    check("setvalue / getvalue round trip", stored.data.imu_test_key === "xyz");
    const menuOff = await send({ type: "setvalue", data: { extension_contextmenu: "false" } });
    check("setvalue accepts the context-menu flag", menuOff.type === "setvalue");

    // Libraries: a missing or unsafe name must return null, not an error.
    const missing = await send({ type: "get_lib", data: { name: "missing" } });
    const unsafe = await send({ type: "get_lib", data: { name: "../manifest" } });
    check("get_lib returns null for missing and unsafe names", missing.data === null && unsafe.data === null);

    // New tab with headers: opens the viewer page, which shows the image.
    await send({ type: "newtab", data: { imu: { url: `${base}/protected.png`, headers: { Referer: "https://example.org/page" } }, background: true } });
    let viewerTarget = null;
    for (let i = 0; i < 50 && !viewerTarget; i++) {
      const targets = await getJson("/json/list");
      viewerTarget = targets.find((t) => t.url.includes("viewer.html")) || null;
      if (!viewerTarget) await sleep(100);
    }
    let width = null;
    if (viewerTarget) {
      const viewer = openCdp(viewerTarget.webSocketDebuggerUrl);
      await viewer.ready;
      for (let i = 0; i < 50 && width !== 1; i++) {
        await sleep(100);
        width = await viewer.eval(`document.getElementById("image").naturalWidth`);
      }
      viewer.close();
      await closeTarget(viewerTarget.id);
    }
    const last = await (await fetch(`${base}/last`)).json();
    check("new tab with headers shows the image through the viewer", width === 1 && last.referer === "https://example.org/page", `naturalWidth ${width}`);

    // Download with headers: saved via the viewer's blob, into the temporary folder.
    await send({ type: "download", data: { imu: { url: `${base}/protected.png`, headers: { Referer: "https://example.org/page" } }, force_saveas: false } });
    // Waits for Chrome to report the download as complete, then checks the saved file.
    let item = null;
    for (let i = 0; i < 80; i++) {
      await sleep(100);
      item = await popup.cdp.eval(`new Promise((r) => chrome.downloads.search({ limit: 1, orderBy: ["-startTime"] }, (d) => r(d[0] ? { filename: d[0].filename, state: d[0].state } : null)))`);
      if (item && item.state === "complete") break;
    }
    const saved = item && item.state === "complete" ? path.basename(item.filename) : null;
    const size = saved ? statSync(path.join(downloads, saved)).size : 0;
    check("download with headers saves the image", saved === "protected.png" && size === PNG.length, saved ? `${saved}, ${size} bytes` : "no completed download");

    // ---- hardening checks ----------------------------------------------------

    // Page-initiated loads: override_next_headers must cover <img> requests, because the
    // userscript calls it right before it sets img.src or loads an Image.
    const imagePage = await openTarget(`${base}/page`);
    await sleep(800);
    const loadImage = (url) => imagePage.cdp.eval(`new Promise((resolve) => { const img = new Image(); img.onload = () => resolve(img.naturalWidth); img.onerror = () => resolve(0); img.src = ${JSON.stringify(url)}; })`);
    const spoofed = { Referer: "https://example.org/page" };

    const plain = await loadImage(`${base}/strict.png?plain=1`);
    await send({ type: "override_next_headers", data: { url: `${base}/strict.png?override=1`, headers: spoofed, method: "GET" } });
    const overridden = await loadImage(`${base}/strict.png?override=1`);
    check("override_next_headers applies to <img> loads", plain === 0 && overridden === 1, `without ${plain}, with ${overridden}`);

    // A rule made for the proxy must not outlive its request or leak into page loads.
    const viaProxy = await proxied({ url: `${base}/strict.png?proxy=1`, headers: spoofed, responseType: "blob" });
    const afterProxy = await loadImage(`${base}/strict.png?proxy=1`);
    check("proxy header rule is gone after the request", viaProxy?.event === "onload" && viaProxy.data.status === 200 && afterProxy === 0, `proxy ${viaProxy?.data?.status}, page ${afterProxy}`);
    imagePage.cdp.close();
    await closeTarget(imagePage.target.id);

    // URLs a plain regexFilter rule cannot hold: non-ASCII characters, a #fragment (never
    // sent to the server) and more than 2 KB.
    const unicode = await proxied({ url: `${base}/headers?name=${"é".repeat(5)}`, headers: spoofed, responseType: "text" });
    const unicodeHeaders = unicode?.data?.responseText ? JSON.parse(unicode.data.responseText) : {};
    check("proxy sets headers on a non-ASCII URL", unicode?.event === "onload" && unicodeHeaders.referer === spoofed.Referer, unicode?.event);
    const fragment = await proxied({ url: `${base}/headers?name=1#fragment`, headers: spoofed, responseType: "text" });
    const fragmentHeaders = fragment?.data?.responseText ? JSON.parse(fragment.data.responseText) : {};
    check("proxy sets headers on a URL with a #fragment", fragment?.event === "onload" && fragmentHeaders.referer === spoofed.Referer, fragment?.event);
    const longUrl = await proxied({ url: `${base}/headers?q=${"a".repeat(3000)}`, headers: spoofed, responseType: "text" });
    const longHeaders = longUrl?.data?.responseText ? JSON.parse(longUrl.data.responseText) : {};
    check("proxy sets headers on a URL longer than 2 KB", longUrl?.event === "onload" && longHeaders.referer === spoofed.Referer, longUrl?.event);

    // The proxy is for web images: it must not read extension or other internal URLs.
    const internal = await proxied({ url: `chrome-extension://${extId}/manifest.json`, responseType: "text" });
    check("proxy refuses non-http(s) URLs", internal?.event === "onerror", internal?.event);
    const dataUrl = await proxied({ url: `data:image/png;base64,${PNG.toString("base64")}`, responseType: "blob" });
    check("proxy still reads data: URLs", dataUrl?.event === "onload" && dataUrl.data._responseEncoded.value.length === PNG.length, dataUrl?.event);

    // Pending viewer data lives in chrome.storage.session, so it survives the worker
    // being stopped, and each key can be read once.
    const sessionKey = "view:test-key";
    await popup.cdp.eval(`new Promise((r) => chrome.storage.session.set({ "${sessionKey}": { url: "${base}/img.png", headers: {}, expires: Date.now() + 60000 } }, r))`);
    await popup.cdp.send("ServiceWorker.enable");
    await popup.cdp.send("ServiceWorker.stopAllWorkers");
    await sleep(500);
    const first = await send({ type: "get_view", data: { key: "test-key" } });
    const second = await send({ type: "get_view", data: { key: "test-key" } });
    check("get_view survives a worker restart and is one-time", first.data?.url === `${base}/img.png` && second.data === null);

    // ---- page scan and gallery ----------------------------------------------

    const scanPage = await openTarget(`${base}/scan-page`);
    await sleep(1000);
    const scanTab = await popup.cdp.eval(`new Promise((r) => chrome.tabs.query({ url: ${JSON.stringify(base + "/scan-page")} }, (tabs) => r(tabs.length ? tabs[0].id : -1)))`);
    const scanned = await send({ type: "scan_page", data: { tabId: scanTab } });
    const scanStored = await popup.cdp.eval(`new Promise((r) => chrome.storage.session.get(${JSON.stringify("scan:" + scanned.data?.key)}, r))`);
    const items = scanStored[`scan:${scanned.data?.key}`]?.items ?? [];
    const widths = items.map((item) => Number(new URL(item.url).searchParams.get("w"))).sort((a, b) => b - a);
    check("scan finds img, srcset, link, background and og:image", widths.join(",") === "1600,1200,800,400,120,100", widths.join(","));
    const sources = new Set(items.map((item) => item.source));
    check("scan records where each image came from", ["img", "srcset", "link", "meta", "background"].every((s) => sources.has(s)), [...sources].join(","));

    // The gallery opens by itself; it must list the images largest first, by real size.
    let galleryTarget = null;
    for (let i = 0; i < 50 && !galleryTarget; i++) {
      const targets = await getJson("/json/list");
      galleryTarget = targets.find((t) => t.url.includes("gallery.html")) || null;
      if (!galleryTarget) await sleep(100);
    }
    let order = [];
    let orderAll = [];
    if (galleryTarget) {
      const gallery = openCdp(galleryTarget.webSocketDebuggerUrl);
      await gallery.ready;
      const visibleWidths = `[...document.querySelectorAll(".card:not([hidden]) img")].filter((i) => i.complete && i.naturalWidth).map((i) => i.naturalWidth)`;
      for (let i = 0; i < 60 && order.length < 4; i++) {
        await sleep(150);
        order = await gallery.eval(visibleWidths);
      }
      // The default filter hides images whose smallest side is under 100 px; "any" shows all.
      await gallery.eval(`(() => { const s = document.getElementById("min"); s.value = "0"; s.dispatchEvent(new Event("change")); return true; })()`);
      await sleep(300);
      orderAll = await gallery.eval(visibleWidths);
      gallery.close();
      await closeTarget(galleryTarget.id);
    }
    check("gallery lists the images largest first, hiding tiny ones by default", order.join(",") === "1600,1200,800,400", order.join(","));
    check("gallery shows every image when the size filter is off", orderAll.join(",") === "1600,1200,800,400,120,100", orderAll.join(","));
    scanPage.cdp.close();
    await closeTarget(scanPage.target.id);

    browser.close();
  } finally {
    stopChrome(chrome);
    site.close();
    await sleep(500);
    for (const dir of [profile, downloads]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (error) {
        console.warn(`could not remove ${dir}: ${error.message}`);
      }
    }
  }

  const passed = outcomes.filter(Boolean).length;
  console.log(`\n${passed}/${outcomes.length} checks passed`);
  process.exitCode = passed === outcomes.length && outcomes.length > 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
