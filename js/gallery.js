// Shows the images, videos and streams the background worker found on a page, largest
// first, nine at a time. The list comes from chrome.storage.session under the key in
// ?k=. Loading every preview at once is slow and heavy, so cards are only created for
// the nine being shown; "Show next 9" adds the next nine.
//
// Sizes in the list come from the markup and are often missing. For images without
// one, the first 64 KB of the file is fetched and its size read from the header
// (js/imagesize.js), which is far cheaper than loading the whole picture.
const PAGE_SIZE = 9;
const MEASURE_LIMIT = 8; // concurrent size probes
const MEASURE_WAIT_MS = 4000; // the first page waits this long for sizes at most

const grid = document.getElementById("grid");
const title = document.getElementById("title");
const count = document.getElementById("count");
const empty = document.getElementById("empty");
const more = /** @type {HTMLButtonElement} */ (document.getElementById("more"));
const minSelect = /** @type {HTMLSelectElement} */ (document.getElementById("min"));
const scanKey = new URLSearchParams(location.search).get("k");

/** @typedef {{ url: string, kind?: string, source: string, width: number, height: number, bytes?: number, bitrate?: number, from?: string }} Item */
/** @type {Item[]} */
let items = [];
/** @type {Item[]} items that have no card yet */
let pending = [];
let shown = 0;
let pageUrl = "";
// Thumbnail URLs whose original (an item with `from` set) was found and measured. The
// thumbnail is then left out of the list, because the original replaces it.
const replaced = new Set();

// Video and stream files usually have no size in the list. They are ranked as if they
// were full HD so they appear on the first pages instead of at the very end.
const ASSUMED_VIDEO = 1920 * 1080;

function areaOf(item) {
  const area = item.width * item.height;
  if (area > 0) return area;
  return item.kind === "video" || item.kind === "stream" ? ASSUMED_VIDEO : 0;
}

// Largest first; the same area is ordered by file size, then bitrate.
function bySize(a, b) {
  return areaOf(b) - areaOf(a) || (b.bytes || 0) - (a.bytes || 0) || (b.bitrate || 0) - (a.bitrate || 0);
}

// An image is hidden by the size filter only when its size is known and too small.
function passesFilter(item) {
  const min = Number(minSelect.value);
  if (replaced.has(item.url)) return false;
  return !(item.width > 0 && item.height > 0 && Math.min(item.width, item.height) < min);
}

// Reads sizes for the images that have none, a few at a time. Resolves when all are done.
async function measureAll() {
  const todo = items.filter((item) => (item.kind || "image") === "image" && !(item.width > 0 && item.height > 0));
  let next = 0;
  async function worker() {
    while (next < todo.length) {
      const item = todo[next++];
      const size = await probeImageSize(item.url);
      if (size) {
        item.width = size.width;
        item.height = size.height;
        if (size.bytes) item.bytes = size.bytes;
        if (item.from) replaced.add(item.from);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(MEASURE_LIMIT, todo.length) }, worker));
}

function updateControls() {
  const left = pending.filter(passesFilter).length;
  count.textContent = shown + " shown" + (left ? ", " + left + " more" : "");
  more.hidden = left === 0;
  more.textContent = "SHOW NEXT " + Math.min(PAGE_SIZE, left);
  empty.hidden = items.length > 0;
}

// Adds the next nine cards. The pending list is ranked again each time, because sizes
// keep arriving while the user looks at the first page.
function showNext() {
  pending = pending.filter(passesFilter).sort(bySize);
  for (const item of pending.splice(0, PAGE_SIZE)) {
    grid.appendChild(makeCard(item));
    shown++;
  }
  updateControls();
}

// Starts again from the first nine, after the size filter changed.
function restart() {
  grid.replaceChildren();
  shown = 0;
  pending = items.slice();
  showNext();
}

// Reads a master playlist and shows the best variant it lists. The gallery is an
// extension page with host permissions, so it can fetch the playlist cross-origin.
function describeStream(url, label) {
  fetch(url, { credentials: "omit" }).then((response) => response.text()).then((text) => {
    /** @type {{ bandwidth: number, resolution: string } | null} */
    let best = null;
    // A plain for loop: TypeScript loses track of `best` when it is set inside a callback.
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;
      const bandwidth = Number((line.match(/BANDWIDTH=(\d+)/) || [])[1]) || 0;
      const resolution = (line.match(/RESOLUTION=(\d+x\d+)/) || [])[1] || "";
      if (!best || bandwidth > best.bandwidth) best = { bandwidth, resolution };
    }
    if (best) {
      label.textContent = "best variant: " + (best.resolution || "?") + " · " + Math.round(best.bandwidth / 1000) + " kbps";
    } else {
      label.textContent = "playlist (single quality)";
    }
  }).catch(() => {
    label.textContent = "playlist (could not read)";
  });
}

/** @param {Item} item */
function makeCard(item) {
  const card = document.createElement("figure");
  card.className = "card";
  card.dataset.url = item.url;

  const thumb = document.createElement("a");
  thumb.className = "thumb";
  thumb.href = item.url;
  thumb.target = "_blank";
  thumb.rel = "noreferrer";
  const kind = item.kind || "image";
  // img for pictures, video for files the browser can play, and a plain label for
  // HLS/DASH playlists, which a browser cannot play from a link.
  const img = /** @type {HTMLImageElement} */ (document.createElement(kind === "video" ? "video" : "img"));
  if (kind === "stream") {
    const label = document.createElement("span");
    label.className = "stream";
    label.textContent = "Stream playlist";
    thumb.appendChild(label);
  } else {
    // Many sites refuse a request whose Referer is another site; none is sent.
    img.referrerPolicy = "no-referrer";
    if (kind === "video") {
      const player = /** @type {HTMLVideoElement} */ (/** @type {unknown} */ (img));
      player.controls = true;
      player.muted = true;
      player.preload = "metadata";
    } else {
      img.alt = "";
    }
    img.src = item.url;
    thumb.appendChild(img);
  }

  const caption = document.createElement("figcaption");
  const dim = document.createElement("span");
  dim.className = "dim";
  dim.textContent = item.width && item.height ? item.width + " × " + item.height : "size unknown";
  const extra = [];
  if (item.bytes) extra.push(item.bytes < 1048576 ? Math.round(item.bytes / 1024) + " KB" : (item.bytes / 1048576).toFixed(1) + " MB");
  if (item.bitrate) extra.push(Math.round(item.bitrate / 1000) + " kbps");
  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = [kind, item.source, ...extra].join(" · ") + " · " + item.url;
  const actions = document.createElement("div");
  actions.className = "actions";

  const open = document.createElement("a");
  open.textContent = "Open";
  open.href = item.url;
  open.target = "_blank";
  open.rel = "noreferrer";

  const save = document.createElement("button");
  save.textContent = "Download";
  save.addEventListener("click", () => {
    chrome.downloads.download({ url: item.url });
  });

  const copy = document.createElement("button");
  copy.textContent = "Copy URL";
  copy.addEventListener("click", () => {
    navigator.clipboard.writeText(item.url).then(() => {
      copy.textContent = "Copied";
    }, () => {
      copy.textContent = "Copy failed";
    });
  });

  actions.append(open, save, copy);
  caption.append(dim, meta, actions);
  card.append(thumb, caption);

  if (kind === "stream") {
    describeStream(item.url, dim);
    return card;
  }
  img.addEventListener(kind === "video" ? "loadedmetadata" : "load", () => {
    const player = /** @type {HTMLVideoElement} */ (/** @type {unknown} */ (img));
    const width = kind === "video" ? player.videoWidth : img.naturalWidth;
    const height = kind === "video" ? player.videoHeight : img.naturalHeight;
    dim.textContent = width + " × " + height;
  });
  img.addEventListener("error", () => {
    card.classList.add("failed");
    // The image needs headers (usually the page as Referer). The viewer fetches it
    // through the worker's proxy, so Open goes there instead of a plain tab.
    open.addEventListener("click", (event) => {
      event.preventDefault();
      chrome.runtime.sendMessage({ type: "newtab", data: { imu: { url: item.url, headers: { Referer: pageUrl } } } });
    });
  });
  return card;
}

more.addEventListener("click", showNext);
minSelect.addEventListener("change", restart);

(async () => {
  const name = "scan:" + scanKey;
  const stored = await chrome.storage.session.get(name);
  const scan = /** @type {{ pageUrl: string, title: string, items: Item[] } | undefined} */ (stored[name]);
  if (!scan) {
    title.textContent = "This list has expired. Run the scan again from the page.";
    empty.hidden = true;
    return;
  }
  pageUrl = scan.pageUrl;
  title.textContent = scan.title ? "Largest images on: " + scan.title : "Largest images on this page";
  document.title = title.textContent;
  items = scan.items;

  // The first nine wait for sizes, but not for long. Probes that are still running keep
  // going and improve the order of the nine after that.
  count.textContent = "Measuring " + items.length + " images…";
  const measuring = measureAll();
  await Promise.race([measuring, new Promise((resolve) => setTimeout(resolve, MEASURE_WAIT_MS))]);
  restart();
  await measuring;
  updateControls();
})();
