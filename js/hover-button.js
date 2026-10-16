// Adds a small download button to a picture or video while the mouse is over it, but
// only when a source file can be downloaded. For a picture the worker reads the size of
// every candidate file (srcset entries, lazy-load attributes, a link to the original)
// and the button downloads the one with the most pixels. For a video it downloads the
// file the page plays, or the best one the tab has loaded (blob: players, X).
// Turned off by the popup switch "Download button on hover" or by Global Disable.
(() => {
  "use strict";

  const MIN_WIDTH = 120; // smaller pictures are icons and tracking pixels
  const MIN_HEIGHT = 80;
  const IMAGE_FILE = /\.(?:jpe?g|png|gif|webp|avif|bmp|tiff?)(?:[?#]|$)/i;
  const IMAGE_ATTRIBUTE = /src|original|large|full|zoom|lazy|img|image/i;
  const IMAGE_TTL_MS = 5 * 60_000;
  const VIDEO_TTL_MS = 3_000; // more files may have been captured since the last look

  let active = true;
  /** @type {Element | null} */
  let current = null;
  let lastX = 0;
  let lastY = 0;
  let queued = false;
  /** @type {Map<string, { time: number, promise: Promise<{ url: string, width: number, height: number, bytes: number } | null> }>} */
  const cache = new Map();

  function loadSettings() {
    try {
      chrome.storage.sync.get(["imu_enabled", "xxl_hover_button"], (data) => {
        active = data.imu_enabled !== "false" && data.xxl_hover_button !== "false";
        if (!active) hide();
      });
    } catch (error) {
      active = false; // the extension was reloaded while this page stayed open
    }
  }

  // ---- the button, in a shadow root so the page's CSS cannot touch it -------

  const host = document.createElement("div");
  host.style.cssText = "all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647;";
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    button { all: initial; position: fixed; display: block; cursor: pointer; white-space: nowrap;
      font: 600 12px/1 system-ui, sans-serif; color: #fff; padding: 7px 11px; border-radius: 999px;
      background: linear-gradient(135deg, #1d8a35, #5cc23d); box-shadow: 0 2px 8px rgba(0, 0, 0, .45); }
    button:hover { filter: brightness(1.12); }
    button[hidden] { display: none; }`;
  const button = document.createElement("button");
  button.type = "button";
  button.hidden = true;
  root.append(style, button);
  /** @type {{ url: string } | null} */
  let target = null;

  function hide() {
    button.hidden = true;
    target = null;
    current = null;
  }

  function describe(result, video) {
    const parts = [video ? "VIDEO" : ""];
    if (result.width && result.height) parts.push(result.width + "×" + result.height);
    if (result.bytes) parts.push(result.bytes < 1048576 ? Math.round(result.bytes / 1024) + " KB" : (result.bytes / 1048576).toFixed(1) + " MB");
    return "⬇ " + parts.filter(Boolean).join(" · ");
  }

  function show(media, result) {
    if (!host.isConnected) document.documentElement.appendChild(host);
    const rect = media.getBoundingClientRect();
    button.textContent = describe(result, media.tagName === "VIDEO");
    button.title = result.url;
    target = result;
    button.hidden = false;
    // Top right corner of the picture, kept inside the window.
    const width = button.offsetWidth;
    button.style.left = Math.max(4, Math.min(rect.right - width - 8, window.innerWidth - width - 4)) + "px";
    button.style.top = Math.max(4, Math.min(rect.top + 8, window.innerHeight - 40)) + "px";
  }

  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!target) return;
    const label = button.textContent;
    send({ type: "download", data: { imu: { url: target.url, headers: {} }, force_saveas: false } }).then(() => {
      button.textContent = "✓ Saved";
      setTimeout(() => {
        if (!button.hidden) button.textContent = label;
      }, 1500);
    });
  });
  // A click on the button must not reach the page (lightboxes, links around the picture).
  for (const type of ["mousedown", "mouseup", "dblclick"]) {
    button.addEventListener(type, (event) => event.stopPropagation());
  }

  function send(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (reply) => {
          void chrome.runtime.lastError; // the worker may be starting; treat as no answer
          resolve(reply || null);
        });
      } catch (error) {
        resolve(null);
      }
    });
  }

  // ---- finding the source files of one picture or video ---------------------

  function absolute(raw) {
    try {
      const url = new URL(raw.trim(), document.baseURI).href;
      return /^https?:/i.test(url) ? url : null;
    } catch (error) {
      return null;
    }
  }

  // Every URL a picture could be downloaded from. The worker measures them and keeps
  // the largest, so this does not have to guess which one is the original.
  // Like element.closest, but also climbs out of shadow roots into their host.
  function closestComposed(element, selector) {
    let node = element;
    while (node) {
      if (node.matches && node.matches(selector)) return node;
      const root = node.getRootNode();
      node = node.parentElement || (root instanceof ShadowRoot ? root.host : null);
    }
    return null;
  }

  function imageCandidates(img) {
    const urls = new Set();
    const add = (raw) => {
      const url = raw && absolute(raw);
      if (url) urls.add(url);
    };
    const addSrcset = (value) => {
      // Candidates end at a comma after a descriptor, or at a comma and a space.
      for (const part of value.split(/(?<=\d[wx]),\s*|,\s+/)) add(part.trim().split(/\s+/)[0]);
    };
    add(img.currentSrc);
    add(img.src);
    const addAttributes = (element) => {
      for (const attr of element.attributes) {
        if (attr.value.length > 2000) continue;
        if (/srcset/i.test(attr.name)) addSrcset(attr.value);
        else if (/^(?:https?:)?\/\/\S+$|^\/\S+$/.test(attr.value) && (IMAGE_FILE.test(attr.value) || IMAGE_ATTRIBUTE.test(attr.name))) add(attr.value);
      }
    };
    addAttributes(img);
    // A picture inside a web component: the host (<rt-img src=...>) often carries the URL.
    let root = img.getRootNode();
    for (let depth = 0; root instanceof ShadowRoot && depth < 4; depth++) {
      addAttributes(root.host);
      root = root.host.getRootNode();
    }
    const picture = closestComposed(img, "picture");
    if (picture) {
      for (const source of picture.querySelectorAll("source[srcset]")) addSrcset(source.getAttribute("srcset") || "");
    }
    const link = closestComposed(img, "a[href]");
    if (link && IMAGE_FILE.test(link.getAttribute("href") || "")) add(link.getAttribute("href"));
    return [...urls].slice(0, 12);
  }

  function videoCandidates(video) {
    const urls = new Set();
    for (const raw of [video.currentSrc, video.getAttribute("src"), ...[...video.querySelectorAll("source[src]")].map((s) => s.getAttribute("src"))]) {
      const url = raw && absolute(raw);
      if (url) urls.add(url);
    }
    return [...urls];
  }

  function upgradedByRules(url) {
    return new Promise((resolve) => {
      const imu = globalThis.$$IMU_EXPORT$$;
      if (typeof imu !== "function") return resolve([]);
      const timer = setTimeout(() => resolve([]), 1500);
      try {
        imu(url, {
          fill_object: true,
          cb: (results) => {
            clearTimeout(timer);
            resolve((results || []).map((result) => result && result.url && absolute(result.url)).filter((found) => found && found !== url));
          },
        });
      } catch (error) {
        clearTimeout(timer);
        resolve([]);
      }
    });
  }

  async function lookup(media) {
    if (media.tagName === "VIDEO") {
      const [direct] = videoCandidates(media);
      if (direct) return { url: direct, width: media.videoWidth || 0, height: media.videoHeight || 0, bytes: 0 };
      const reply = await send({ type: "best_video" });
      return reply && reply.data;
    }
    const urls = imageCandidates(media);
    if (!urls.length) return null;
    // The site rules of maxurl (the content script, same isolated world) may name the
    // original behind a thumbnail URL. The worker then measures it with the other files.
    urls.push(...await upgradedByRules(urls[0]));
    const reply = await send({ type: "best_source", data: { urls } });
    return reply && reply.data;
  }

  function resolve(media) {
    const video = media.tagName === "VIDEO";
    const key = (video ? "video:" : "image:") + (video ? videoCandidates(media).join("|") + (media.currentSrc ? "" : location.href) : imageCandidates(media).join("|"));
    const cached = cache.get(key);
    if (cached && Date.now() - cached.time < (video ? VIDEO_TTL_MS : IMAGE_TTL_MS)) return cached.promise;
    if (cache.size > 300) cache.clear();
    const promise = lookup(media).catch(() => null);
    cache.set(key, { time: Date.now(), promise });
    return promise;
  }

  // ---- following the mouse --------------------------------------------------

  // The picture or video under the pointer, even when a transparent link or overlay
  // covers it.
  // elementsFromPoint stops at a shadow host. This goes into every open shadow root under
  // the point as well, innermost elements first. A shadow root's own list repeats its host
  // and the host's ancestors, so elements already seen are skipped (without that the host
  // would be entered again and again).
  function elementsDeep(root, x, y, seen = new Set()) {
    const result = [];
    for (const element of root.elementsFromPoint(x, y)) {
      if (seen.has(element)) continue;
      seen.add(element);
      if (element.shadowRoot) result.push(...elementsDeep(element.shadowRoot, x, y, seen));
      result.push(element);
    }
    return result;
  }

  function mediaAt(x, y) {
    for (const element of elementsDeep(document, x, y)) {
      if (element === host) continue;
      if (element.tagName !== "IMG" && element.tagName !== "VIDEO") continue;
      const rect = element.getBoundingClientRect();
      if (rect.width >= MIN_WIDTH && rect.height >= MIN_HEIGHT) return element;
    }
    return null;
  }

  function check() {
    queued = false;
    if (!active) return;
    const media = mediaAt(lastX, lastY);
    if (media === current) return;
    hide();
    current = media;
    if (!media) return;
    resolve(media).then((result) => {
      if (current === media && result) show(media, result);
    });
  }

  document.addEventListener("mousemove", (event) => {
    lastX = event.clientX;
    lastY = event.clientY;
    if (!queued) {
      queued = true;
      setTimeout(check, 80);
    }
  }, { capture: true, passive: true });

  // Scrolling moves the picture away from the button; the next mouse move shows it again.
  window.addEventListener("scroll", hide, { capture: true, passive: true });
  window.addEventListener("resize", hide, { passive: true });

  try {
    chrome.storage.onChanged.addListener(loadSettings);
  } catch (error) {
    // the extension was reloaded while this page stayed open
  }
  loadSettings();
})();
