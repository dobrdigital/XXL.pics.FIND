// Runs in the page's own JavaScript world on x.com / twitter.com (see manifest.json).
// X does not put video files in the markup: the player gets a list of variants from its
// own GraphQL API and plays them through MSE (blob: URLs). This script reads the same
// API responses the page already fetched, so it does not depend on query ids, tokens or
// headers, which X changes often. It reports the original photo URLs and every video
// variant; js/media-relay.js forwards them to the extension.
//
// Reference for the response shape: yt-dlp's twitter extractor
// (extended_entities.media[] -> video_info.variants[], media_url_https).
(function () {
  "use strict";

  // Walks any JSON value and returns the media it contains. The path is not assumed,
  // because timelines, tweet details, search and quoted tweets nest it differently.
  function extractMedia(root) {
    const items = [];
    const seen = new Set();
    const push = (item) => {
      if (!seen.has(item.url)) {
        seen.add(item.url);
        items.push(item);
      }
    };

    function walk(node, depth) {
      if (!node || typeof node !== "object" || depth > 40) return;
      if (Array.isArray(node)) {
        for (const child of node) walk(child, depth + 1);
        return;
      }
      if (node.video_info && Array.isArray(node.video_info.variants)) {
        for (const variant of node.video_info.variants) {
          if (!variant || typeof variant.url !== "string") continue;
          // Progressive files carry their size in the path: .../vid/avc1/1280x720/x.mp4
          const size = variant.url.match(/\/(\d+)x(\d+)\//);
          const stream = /\.m3u8(?:[?#]|$)/i.test(variant.url) || /mpegurl/i.test(variant.content_type || "");
          push({
            url: variant.url,
            kind: stream ? "stream" : "video",
            source: "x.com",
            width: size ? Number(size[1]) : 0,
            height: size ? Number(size[2]) : 0,
            bitrate: Number(variant.bitrate || variant.bit_rate) || 0,
          });
        }
      }
      if (node.type === "photo" && typeof node.media_url_https === "string") {
        // name=orig is the original upload, not the 680px or 1200px version the page shows.
        const base = node.media_url_https.replace(/\.(jpg|jpeg|png|webp)$/i, "");
        const format = (node.media_url_https.match(/\.(jpg|jpeg|png|webp)$/i) || [null, "jpg"])[1];
        const info = node.original_info || {};
        push({
          url: base + "?format=" + format + "&name=orig",
          kind: "image",
          source: "x.com",
          width: Number(info.width) || 0,
          height: Number(info.height) || 0,
          bitrate: 0,
        });
      }
      for (const key of Object.keys(node)) walk(node[key], depth + 1);
    }

    walk(root, 0);
    return items;
  }

  function report(text) {
    let json;
    try {
      json = JSON.parse(text);
    } catch (error) {
      return;
    }
    const items = extractMedia(json);
    if (items.length) window.postMessage({ __imu: "media", items }, window.location.origin);
  }

  function install() {
    // Only API calls are read: /i/api/graphql/<id>/<Operation> and /i/api/2/...
    const isApi = (url) => typeof url === "string" && /\/i\/api\/(?:graphql|2)\//.test(url);

    const originalFetch = window.fetch;
    window.fetch = function (...args) {
      const promise = originalFetch.apply(this, args);
      promise.then((response) => {
        if (response && isApi(response.url)) response.clone().text().then(report, () => {});
      }, () => {});
      return promise;
    };

    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (...args) {
      this.addEventListener("load", function () {
        if (isApi(this.responseURL) && (this.responseType === "" || this.responseType === "text")) {
          report(this.responseText);
        }
      });
      return originalSend.apply(this, args);
    };
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { extractMedia }; // used by the tests; never true in a browser
  } else if (/^(?:.+\.)?(?:x|twitter)\.com$/.test(window.location.hostname)) {
    install();
  }
})();
