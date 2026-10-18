// End-to-end checks for the MV3 build. Loads this folder as an unpacked extension
// through the DevTools Extensions domain and checks each message type the userscript
// uses, the page scan, the gallery, the hover button and the right-click action.
//
// Two ways to run it:
//   node tests/run-tests.mjs                 starts a headless Chrome with a temporary
//                                            profile and download folder (CI, other people)
//   node tests/run-tests.mjs --attach [port] uses a Chrome that is already running with
//                                            --remote-debugging-port (default 9222) and
//                                            --enable-unsafe-extension-debugging. Nothing
//                                            else is started. The test tabs open in that
//                                            browser and are closed again; settings the
//                                            tests change are put back, and the test's
//                                            own downloads and cookie are removed.
// Environment: CHROME_PATH (default: Chrome under Program Files), CDP_PORT (default 9333).
// The checks that need no browser are in tests/unit.test.mjs.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makePng } from "./png.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const attachAt = process.argv.indexOf("--attach");
const ATTACH = attachAt !== -1;
const PORT = ATTACH ? Number(process.argv[attachAt + 1] || 9222) : Number(process.env.CDP_PORT || 9333);
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const outcomes = [];

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
    // Fourteen lazy-loading images: the page holds the real URL in data-original, so
    // the scan has no size for them and the gallery has to measure them.
    if (pathname === "/many-page") {
      const imgs = Array.from({ length: 14 }, (_, i) => {
        const w = 200 + i * 50;
        return `<img src="/img.png" data-original="/png?w=${w}&h=${Math.round(w * 0.66)}" width="30">`;
      }).join("");
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(`<!doctype html><title>many</title>${imgs}`);
    }
    // A picture that has a larger file in its srcset, and a video, for the hover button.
    if (pathname === "/hover-page") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(`<!doctype html><title>hover</title><body style="margin:0">
<img id="pic" src="/png?w=300&h=200" srcset="/png?w=300&h=200 300w, /png?w=900&h=600 900w" sizes="300px" width="300" height="200" style="display:block;margin:20px">
<video id="clip" src="/clip.mp4" width="300" height="200" muted style="display:block;margin:20px"></video>
<p id="away" style="margin:20px">text</p>`);
    }
    // The userscript's generic MediaWiki rule turns /thumb/a/ab/NAME/300px-NAME into the
    // original /a/ab/NAME, on any host. This pair lets the tests run the right-click
    // action end to end: the page shows the 300 px thumbnail, the larger file is 1200 px.
    if (pathname.startsWith("/thumb/a/ab/pic.png/")) {
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(makePng(300, 200));
    }
    if (pathname === "/a/ab/pic.png") {
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(makePng(1200, 800));
    }
    if (pathname === "/ctx-page") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(`<!doctype html><title>ctx</title><body style="margin:0">
<img id="pic" src="/thumb/a/ab/pic.png/300px-pic.png" width="300" height="200" style="display:block;margin:40px">`);
    }
    // A web component keeps its <img> in an open shadow root (Rotten Tomatoes' <rt-img>
    // does), where document.images and document.elementsFromPoint do not look. The
    // picture is the MediaWiki-style thumbnail, so the rules can name the 1200 px file.
    if (pathname === "/shadow-page") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(`<!doctype html><title>shadow</title><body style="margin:0">
<script>
class FakeImg extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = '<img src="' + this.getAttribute("src") + '" width="300" height="200" style="display:block">';
  }
}
customElements.define("fake-img", FakeImg);
</script>
<fake-img id="host" src="/thumb/a/ab/pic.png/300px-pic.png" style="display:block;margin:40px;width:300px;height:200px"></fake-img>`);
    }
    // Not decodable on purpose: the tests only need the request and its headers.
    if (pathname === "/clip.mp4") {
      res.writeHead(200, { "content-type": "video/mp4", "content-length": "2000" });
      return res.end(Buffer.alloc(2000, 1));
    }
    if (pathname === "/live.m3u8") {
      res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
      return res.end([
        "#EXTM3U",
        "#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360",
        "low.m3u8",
        "#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080",
        "high.m3u8",
        "",
      ].join("\n"));
    }
    if (pathname === "/media-page") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(`<!doctype html><title>media page</title>
<video src="/clip.mp4" muted preload="auto"></video>
<script>fetch("/live.m3u8").then((r) => r.text());</script>`);
    }
    // The same picture under two addresses, and a different one: the gallery must show two.
    if (pathname === "/dup-page") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(`<!doctype html><title>dup</title>
<img src="/png?w=500&h=300&copy=1"><img src="/png?w=500&h=300&copy=2"><img src="/png?w=400&h=300">`);
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

// Starts the headless Chrome of the default mode. Returns the process and its folders.
function launchChrome() {
  const profile = mkdtempSync(path.join(os.tmpdir(), "imu-profile-"));
  const downloads = mkdtempSync(path.join(os.tmpdir(), "imu-downloads-"));
  // Point Chrome's download folder at the temporary one through the profile. Do not use
  // Browser.setDownloadBehavior: that DevTools override makes Chrome ignore the filename
  // an extension passes to chrome.downloads.download.
  mkdirSync(path.join(profile, "Default"), { recursive: true });
  writeFileSync(path.join(profile, "Default", "Preferences"), JSON.stringify({
    download: { default_directory: downloads, prompt_for_download: false },
  }));
  const child = spawn(CHROME, [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    // CI runners (Ubuntu 24.04) do not allow Chrome's sandbox; it stays on everywhere else.
    ...(process.env.CI ? ["--no-sandbox"] : []),
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--enable-unsafe-extension-debugging",
    "about:blank",
  ], { stdio: "ignore" });
  return { child, folders: [profile, downloads] };
}

async function main() {
  const site = await startSite();
  const base = `http://127.0.0.1:${site.address().port}`;
  const started = Date.now();
  const launched = ATTACH ? null : launchChrome();
  // Targets that were open before the tests; an old gallery tab must not be taken for a new one.
  const before = new Set();

  try {
    const version = await waitForChrome();
    for (const target of await getJson("/json/list")) before.add(target.id);
    const browser = openCdp(version.webSocketDebuggerUrl);
    await browser.ready;
    const loaded = await browser.send("Extensions.loadUnpacked", { path: ROOT });
    if (!loaded.result) throw new Error("Extensions.loadUnpacked failed: " + JSON.stringify(loaded.error) + " (is Chrome started with --enable-unsafe-extension-debugging?)");
    const extId = loaded.result.id;

    // Opens a page target and returns a client for it.
    async function openTarget(url) {
      const target = await getJson(`/json/new?${url}`, { method: "PUT" });
      const cdp = openCdp(target.webSocketDebuggerUrl);
      await cdp.ready;
      return { target, cdp };
    }

    // Waits for a tab this run opened whose URL contains every given part.
    async function waitForTarget(...parts) {
      for (let i = 0; i < 50; i++) {
        const found = (await getJson("/json/list")).find((t) => !before.has(t.id) && parts.every((part) => t.url.includes(part)));
        if (found) return found;
        await sleep(100);
      }
      return null;
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
    let contentWorld = null; // the content scripts' isolated world in the top frame
    page.cdp.onEvent((msg) => {
      if (msg.method === "Runtime.exceptionThrown") problems.push((msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text).split("\n")[0]);
      if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") problems.push("console.error");
      const context = msg.method === "Runtime.executionContextCreated" ? msg.params.context : null;
      if (context && context.auxData?.type === "isolated" && (context.origin.includes(extId) || context.name === "XXL.pics.FIND")) contentWorld = context.id;
    });
    await page.cdp.send("Runtime.enable");
    await sleep(4000);
    check("content script loads on a normal page", problems.length === 0, problems.slice(0, 3).join("; "));

    // A content script runs inside every web page, so the worker must refuse it the
    // messages only the extension's own pages send.
    const refused = contentWorld === null ? null : (await page.cdp.send("Runtime.evaluate", {
      contextId: contentWorld,
      expression: `Promise.all(["scan_page", "get_view"].map((type) => chrome.runtime.sendMessage({ type, data: { key: "x" } })))`,
      awaitPromise: true,
      returnByValue: true,
    })).result.result.value;
    check("worker refuses scan_page and get_view from a content script", Array.isArray(refused) && refused.every((reply) => reply && /not allowed/.test(reply.error)), JSON.stringify(refused));
    const strange = await send({ type: "toString" });
    check("an unknown type such as toString gets an error, not Object.prototype", /not ported/.test(strange?.error || ""), JSON.stringify(strange));
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
    const menuOn = await send({ type: "setvalue", data: { extension_contextmenu: "true" } }); // put the menu back
    check("setvalue accepts the context-menu flag", menuOff.type === "setvalue" && menuOn.type === "setvalue");
    await popup.cdp.eval(`chrome.storage.sync.remove("imu_test_key").then(() => true)`);

    // Libraries: a missing or unsafe name must return null, not an error.
    const missing = await send({ type: "get_lib", data: { name: "missing" } });
    const unsafe = await send({ type: "get_lib", data: { name: "../manifest" } });
    check("get_lib returns null for missing and unsafe names", missing.data === null && unsafe.data === null);

    // New tab with headers: opens the viewer page, which shows the image.
    await send({ type: "newtab", data: { imu: { url: `${base}/protected.png`, headers: { Referer: "https://example.org/page" } }, background: true } });
    const viewerTarget = await waitForTarget("viewer.html");
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
    const size = saved ? statSync(item.filename).size : 0;
    // A real Downloads folder may hold an older protected.png; Chrome then adds " (1)".
    check("download with headers saves the image", /^protected(?: \(\d+\))?\.png$/.test(saved || "") && size === PNG.length, saved ? `${saved}, ${size} bytes` : "no completed download");

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
    // Only this extension's worker is stopped; stopAllWorkers would stop every site's
    // service worker in the browser.
    const workerVersions = [];
    popup.cdp.onEvent((msg) => {
      if (msg.method === "ServiceWorker.workerVersionUpdated") workerVersions.push(...msg.params.versions);
    });
    await popup.cdp.send("ServiceWorker.enable");
    await sleep(300);
    let stoppedWorkers = 0;
    for (const workerVersion of workerVersions.filter((v) => v.scriptURL.startsWith(`chrome-extension://${extId}/`) && v.runningStatus === "running")) {
      await popup.cdp.send("ServiceWorker.stopWorker", { versionId: workerVersion.versionId });
      stoppedWorkers++;
    }
    await popup.cdp.send("ServiceWorker.disable");
    await sleep(500);
    const first = await send({ type: "get_view", data: { key: "test-key" } });
    const second = await send({ type: "get_view", data: { key: "test-key" } });
    check("get_view survives a worker restart and is one-time", stoppedWorkers > 0 && first.data?.url === `${base}/img.png` && second.data === null, `${stoppedWorkers} worker stopped`);

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
    const galleryTarget = await waitForTarget("gallery.html", scanned.data?.key);
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

    // ---- video, streams and the X response parser --------------------------

    const mediaPage = await openTarget(`${base}/media-page`);
    await sleep(2500);
    const mediaTab = await popup.cdp.eval(`new Promise((r) => chrome.tabs.query({ url: ${JSON.stringify(base + "/media-page")} }, (tabs) => r(tabs.length ? tabs[0].id : -1)))`);
    const mediaScan = await send({ type: "scan_page", data: { tabId: mediaTab } });
    const mediaStored = await popup.cdp.eval(`new Promise((r) => chrome.storage.session.get(${JSON.stringify("scan:" + mediaScan.data?.key)}, r))`);
    const mediaItems = mediaStored[`scan:${mediaScan.data?.key}`]?.items ?? [];
    const video = mediaItems.find((item) => item.url.endsWith("/clip.mp4"));
    const stream = mediaItems.find((item) => item.url.endsWith("/live.m3u8"));
    check("scan lists a <video> file and its size from the network", video?.kind === "video" && video.bytes === 2000, JSON.stringify(video));
    check("scan lists an HLS playlist loaded by script", stream?.kind === "stream" && stream.source === "network", JSON.stringify(stream));

    const mediaGallery = await waitForTarget("gallery.html", mediaScan.data?.key);
    let streamText = "";
    let hasPlayer = false;
    if (mediaGallery) {
      const gallery = openCdp(mediaGallery.webSocketDebuggerUrl);
      await gallery.ready;
      for (let i = 0; i < 40 && !/best variant/.test(streamText); i++) {
        await sleep(150);
        streamText = await gallery.eval(`[...document.querySelectorAll(".card")].map((c) => c.textContent).filter((t) => t.includes("live.m3u8")).join(" ")`);
      }
      hasPlayer = await gallery.eval(`document.querySelectorAll(".card video").length > 0`);
      gallery.close();
      await closeTarget(mediaGallery.id);
    }
    check("gallery plays video files and reads the best stream variant", hasPlayer && /best variant: 1920x1080 · 5000 kbps/.test(streamText), streamText.slice(0, 80));
    // A new document in the same tab starts a new list: the video of the page before must
    // not appear in a scan of the next page.
    await mediaPage.cdp.send("Page.navigate", { url: `${base}/page` });
    await sleep(1500);
    const nextScan = await send({ type: "scan_page", data: { tabId: mediaTab } });
    const nextStored = await popup.cdp.eval(`new Promise((r) => chrome.storage.session.get(${JSON.stringify("scan:" + nextScan.data?.key)}, r))`);
    const nextItems = nextStored[`scan:${nextScan.data?.key}`]?.items ?? [];
    check("a scan after navigating away does not list the previous page's video", nextItems.length > 0 && !nextItems.some((item) => /clip.mp4|live.m3u8/.test(item.url)), nextItems.map((item) => item.url).join(" "));
    const nextGallery = await waitForTarget("gallery.html", nextScan.data?.key);
    if (nextGallery) await closeTarget(nextGallery.id);
    mediaPage.cdp.close();
    await closeTarget(mediaPage.target.id);

    // ---- gallery: the same file under two addresses is shown once ------------

    const dupPage = await openTarget(`${base}/dup-page`);
    await sleep(1000);
    const dupTab = await popup.cdp.eval(`new Promise((r) => chrome.tabs.query({ url: ${JSON.stringify(base + "/dup-page")} }, (tabs) => r(tabs.length ? tabs[0].id : -1)))`);
    const dupScan = await send({ type: "scan_page", data: { tabId: dupTab } });
    const dupGallery = await waitForTarget("gallery.html", dupScan.data?.key);
    let dupCards = [];
    if (dupGallery) {
      const gallery = openCdp(dupGallery.webSocketDebuggerUrl);
      await gallery.ready;
      await sleep(2500);
      dupCards = await gallery.eval(`[...document.querySelectorAll(".card")].map((c) => new URL(c.dataset.url).search)`);
      gallery.close();
      await closeTarget(dupGallery.id);
    }
    check("gallery shows a file served under two addresses once", dupCards.length === 2 && dupCards.some((q) => q.includes("w=400")), dupCards.join(" "));
    dupPage.cdp.close();
    await closeTarget(dupPage.target.id);

    // ---- gallery: nine at a time, sizes measured from the file header ---------

    const manyPage = await openTarget(`${base}/many-page`);
    await sleep(1000);
    const manyTab = await popup.cdp.eval(`new Promise((r) => chrome.tabs.query({ url: ${JSON.stringify(base + "/many-page")} }, (tabs) => r(tabs.length ? tabs[0].id : -1)))`);
    const manyScan = await send({ type: "scan_page", data: { tabId: manyTab } });
    const manyGallery = await waitForTarget("gallery.html", manyScan.data?.key);
    let firstPage = [];
    let moreLabel = "";
    let allCards = 0;
    let moreHiddenAtEnd = false;
    if (manyGallery) {
      const gallery = openCdp(manyGallery.webSocketDebuggerUrl);
      await gallery.ready;
      const cardWidths = `[...document.querySelectorAll(".card img")].filter((i) => i.complete && i.naturalWidth).map((i) => i.naturalWidth)`;
      for (let i = 0; i < 60 && firstPage.length < 9; i++) {
        await sleep(200);
        firstPage = await gallery.eval(cardWidths);
      }
      moreLabel = await gallery.eval(`document.getElementById("more").hidden ? "hidden" : document.getElementById("more").textContent`);
      await gallery.eval(`document.getElementById("more").click(), true`);
      await sleep(800);
      allCards = await gallery.eval(`document.querySelectorAll(".card").length`);
      moreHiddenAtEnd = await gallery.eval(`document.getElementById("more").hidden`);
      gallery.close();
      await closeTarget(manyGallery.id);
    }
    check("gallery shows only the 9 largest first, found by measuring file headers",
      firstPage.join(",") === "850,800,750,700,650,600,550,500,450", firstPage.join(","));
    check("SHOW NEXT adds the remaining images and then disappears", moreLabel === "SHOW NEXT 5" && allCards === 14 && moreHiddenAtEnd, `${moreLabel}, ${allCards} cards`);
    manyPage.cdp.close();
    await closeTarget(manyPage.target.id);

    // ---- hover download button ----------------------------------------------

    const bestSource = await send({ type: "best_source", data: { urls: [`${base}/png?w=100&h=66`, `${base}/png?w=900&h=600`, `${base}/png?w=300&h=200`, `chrome-extension://${extId}/manifest.json`] } });
    check("best_source returns the candidate with the most pixels", bestSource.data?.width === 900 && bestSource.data.height === 600 && bestSource.data.url.endsWith("w=900&h=600"), JSON.stringify(bestSource.data));

    const hoverPage = await openTarget(`${base}/hover-page`);
    await sleep(1500);
    const centre = (id) => hoverPage.cdp.eval(`(() => { const r = document.getElementById("${id}").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    const buttonText = () => hoverPage.cdp.eval(`(() => { for (const d of document.querySelectorAll("div")) { if (d.shadowRoot) { const b = d.shadowRoot.querySelector("button"); if (b && !b.hidden) return b.textContent; } } return null; })()`);
    const moveTo = async (x, y) => {
      for (let i = 0; i < 2; i++) {
        await hoverPage.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + i, y });
        await sleep(150);
      }
    };
    // Moves the mouse over an element and waits for the button to show.
    async function hoverOver(id, wait = 6000) {
      const point = await centre(id);
      await moveTo(point.x, point.y);
      for (let i = 0; i < wait / 150; i++) {
        const text = await buttonText();
        if (text) return text;
        await sleep(150);
      }
      return null;
    }
    const awayPoint = await centre("away");

    const imageButton = await hoverOver("pic");
    check("hovering a picture shows a button with the size of its largest file", /900.600/.test(imageButton || ""), imageButton || "no button");

    await hoverPage.cdp.eval(`(() => { for (const d of document.querySelectorAll("div")) { if (d.shadowRoot) { const b = d.shadowRoot.querySelector("button"); if (b && !b.hidden) b.click(); } } return true; })()`);
    let downloaded = null;
    for (let i = 0; i < 40 && !downloaded; i++) {
      await sleep(150);
      downloaded = await popup.cdp.eval(`new Promise((r) => chrome.downloads.search({ orderBy: ["-startTime"], limit: 3 }, (d) => r(d.map((x) => x.url).find((u) => u.includes("w=900&h=600")) || null)))`);
    }
    check("clicking the button downloads the largest file", Boolean(downloaded), downloaded || "no download");

    await moveTo(awayPoint.x, awayPoint.y);
    await sleep(400);
    check("the button disappears when the mouse leaves", (await buttonText()) === null);

    const videoButton = await hoverOver("clip");
    check("hovering a video shows a VIDEO download button", /VIDEO/.test(videoButton || ""), videoButton || "no button");

    // The popup switch turns the button off everywhere.
    await moveTo(awayPoint.x, awayPoint.y);
    await popup.cdp.eval(`new Promise((r) => chrome.storage.sync.set({ xxl_hover_button: "false" }, r))`);
    await sleep(500);
    const offButton = await hoverOver("pic", 2000);
    await popup.cdp.eval(`new Promise((r) => chrome.storage.sync.set({ xxl_hover_button: "true" }, r))`);
    check("the popup switch turns the hover button off", offButton === null, String(offButton));
    hoverPage.cdp.close();
    await closeTarget(hoverPage.target.id);

    // ---- right-click "XXL Find This HiRes" ------------------------------

    // The extension name is checked by the userscript to decide if it runs as an extension
    // (renaming it once broke this action), so this test runs the whole path: the mouse
    // is over a thumbnail, the worker sends context_imu, and a popup with the larger
    // image must appear.
    const ctxPage = await openTarget(`${base}/ctx-page`);
    await sleep(3500);
    const ctxTab = await popup.cdp.eval(`new Promise((r) => chrome.tabs.query({ url: ${JSON.stringify(base + "/ctx-page")} }, (tabs) => r(tabs.length ? tabs[0].id : -1)))`);
    const ctxPoint = await ctxPage.cdp.eval(`(() => { const r = document.getElementById("pic").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    for (let i = 0; i < 3; i++) {
      await ctxPage.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: ctxPoint.x + i, y: ctxPoint.y });
      await sleep(200);
    }
    await popup.cdp.eval(`chrome.tabs.sendMessage(${ctxTab}, { type: "context_imu" }).catch(() => {}), true`);
    let popupWidth = 0;
    for (let i = 0; i < 60 && !popupWidth; i++) {
      await sleep(200);
      popupWidth = await ctxPage.cdp.eval(`(() => { const big = [...document.images].find((i) => i.id !== "pic" && i.naturalWidth === 1200); return big ? big.naturalWidth : 0; })()`);
    }
    check("right-click \"XXL Find This HiRes\" opens a popup with the larger file", popupWidth === 1200, "popup image width " + popupWidth);
    ctxPage.cdp.close();
    await closeTarget(ctxPage.target.id);

    // ---- pictures inside shadow DOM ------------------------------------------

    const shadowPage = await openTarget(`${base}/shadow-page`);
    await sleep(3500);
    const shadowTab = await popup.cdp.eval(`new Promise((r) => chrome.tabs.query({ url: ${JSON.stringify(base + "/shadow-page")} }, (tabs) => r(tabs.length ? tabs[0].id : -1)))`);
    const shadowScan = await send({ type: "scan_page", data: { tabId: shadowTab } });
    const shadowStored = await popup.cdp.eval(`new Promise((r) => chrome.storage.session.get(${JSON.stringify("scan:" + shadowScan.data?.key)}, r))`);
    const shadowItems = shadowStored[`scan:${shadowScan.data?.key}`]?.items ?? [];
    check("scan finds a picture inside a shadow root", shadowItems.some((item) => item.url.endsWith("/thumb/a/ab/pic.png/300px-pic.png")), shadowItems.map((item) => item.url).join(" "));
    const upgraded = shadowItems.find((item) => item.url.endsWith("/a/ab/pic.png"));
    check("scan adds the original named by the site rules, marked with its thumbnail", upgraded?.source === "rule" && String(upgraded.from).includes("/thumb/a/ab/pic.png/"), JSON.stringify(upgraded));

    // The gallery measures both files and shows only the original: it replaces the thumbnail.
    const shadowGallery = await waitForTarget("gallery.html", shadowScan.data?.key);
    let shadowCards = [];
    if (shadowGallery) {
      const gallery = openCdp(shadowGallery.webSocketDebuggerUrl);
      await gallery.ready;
      for (let i = 0; i < 60 && shadowCards.length < 1; i++) {
        await sleep(150);
        shadowCards = await gallery.eval(`[...document.querySelectorAll(".card")].map((c) => c.dataset.url)`);
      }
      await sleep(1500); // the thumbnail may still be listed until the original is measured
      shadowCards = await gallery.eval(`[...document.querySelectorAll(".card")].map((c) => c.dataset.url)`);
      gallery.close();
      await closeTarget(shadowGallery.id);
    }
    check("gallery shows the original instead of its thumbnail", shadowCards.length === 1 && shadowCards[0].endsWith("/a/ab/pic.png"), shadowCards.join(" "));

    const shadowCentre = await shadowPage.cdp.eval(`(() => { const r = document.getElementById("host").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    let shadowButton = null;
    for (let i = 0; i < 40 && !shadowButton; i++) {
      await shadowPage.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: shadowCentre.x + (i % 3), y: shadowCentre.y });
      await sleep(200);
      shadowButton = await shadowPage.cdp.eval(`(() => { for (const d of document.querySelectorAll("div")) { if (d.shadowRoot) { const b = d.shadowRoot.querySelector("button"); if (b && !b.hidden) return b.textContent; } } return null; })()`);
    }
    check("hovering a picture inside a shadow root shows the button with the original's size", /1200.800/.test(shadowButton || ""), shadowButton || "no button");
    shadowPage.cdp.close();
    await closeTarget(shadowPage.target.id);

    // What the tests left in the browser: their downloads (files and list entries) and the
    // test cookie. In the default mode the whole temporary profile goes anyway; in attach
    // mode this keeps the real profile clean. Only items this run created are touched.
    await popup.cdp.eval(`(async () => {
      const mine = (await chrome.downloads.search({ startedAfter: new Date(${started}).toISOString() }))
        .filter((d) => d.url.startsWith(${JSON.stringify(base)}) || d.url.startsWith("blob:chrome-extension://${extId}/"));
      for (const d of mine) {
        if (d.exists && d.state === "complete") await chrome.downloads.removeFile(d.id).catch(() => {});
        await chrome.downloads.erase({ id: d.id });
      }
      await chrome.cookies.remove({ url: ${JSON.stringify(base + "/")}, name: "imu_test" });
      return true;
    })()`);
    popup.cdp.close();
    await closeTarget(popup.target.id);
    browser.close();
  } finally {
    if (launched) stopChrome(launched.child);
    site.close();
    await sleep(500);
    for (const dir of launched ? launched.folders : []) {
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
