// Shows the images the background worker found on a page, largest first. The list
// comes from chrome.storage.session under the key in ?k=. Sizes in the list come from
// the markup (srcset widths, rendered size) and are often missing, so each image is
// loaded here and ordered by its real pixel size.
const grid = document.getElementById("grid");
const title = document.getElementById("title");
const count = document.getElementById("count");
const empty = document.getElementById("empty");
const minSelect = /** @type {HTMLSelectElement} */ (document.getElementById("min"));
const scanKey = new URLSearchParams(location.search).get("k");

/** @type {{ item: { url: string, source: string, width: number, height: number }, card: HTMLElement, img: HTMLImageElement, failed: boolean, loaded: boolean, dim: HTMLElement }[]} */
const entries = [];
let pageUrl = "";
let renderQueued = false;

function sizeOf(entry) {
  if (entry.loaded) return { width: entry.img.naturalWidth, height: entry.img.naturalHeight };
  return { width: entry.item.width, height: entry.item.height };
}

function areaOf(entry) {
  const { width, height } = sizeOf(entry);
  return width * height;
}

// Sorts the cards by pixel area and hides those under the chosen size. An image whose
// size is still unknown stays visible until it has loaded.
function render() {
  renderQueued = false;
  const min = Number(minSelect.value);
  entries.sort((a, b) => areaOf(b) - areaOf(a));
  let shown = 0;
  for (const entry of entries) {
    const { width, height } = sizeOf(entry);
    const known = entry.loaded || entry.failed || (width > 0 && height > 0);
    entry.card.hidden = known && !entry.failed && Math.min(width, height) < min;
    if (!entry.card.hidden) shown++;
    grid.appendChild(entry.card); // moves the card into its sorted position
  }
  count.textContent = shown + " of " + entries.length + " images";
  empty.hidden = entries.length > 0;
}

function queueRender() {
  if (!renderQueued) {
    renderQueued = true;
    requestAnimationFrame(render);
  }
}

function makeCard(item) {
  const card = document.createElement("figure");
  card.className = "card";
  card.dataset.url = item.url;

  const thumb = document.createElement("a");
  thumb.className = "thumb";
  thumb.href = item.url;
  thumb.target = "_blank";
  thumb.rel = "noreferrer";
  const img = document.createElement("img");
  img.alt = "";
  // Many sites refuse a request whose Referer is another site; none is sent.
  img.referrerPolicy = "no-referrer";
  img.src = item.url;
  thumb.appendChild(img);

  const caption = document.createElement("figcaption");
  const dim = document.createElement("span");
  dim.className = "dim";
  dim.textContent = item.width && item.height ? item.width + " × " + item.height + " (declared)" : "size unknown";
  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = item.source + " · " + item.url;
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

  const entry = { item, card, img, failed: false, loaded: false, dim };
  img.addEventListener("load", () => {
    entry.loaded = true;
    dim.textContent = img.naturalWidth + " × " + img.naturalHeight;
    queueRender();
  });
  img.addEventListener("error", () => {
    entry.failed = true;
    card.classList.add("failed");
    // The image needs headers (usually the page as Referer). The viewer fetches it
    // through the worker's proxy, so Open goes there instead of a plain tab.
    open.addEventListener("click", (event) => {
      event.preventDefault();
      chrome.runtime.sendMessage({ type: "newtab", data: { imu: { url: item.url, headers: { Referer: pageUrl } } } });
    });
    queueRender();
  });
  return entry;
}

minSelect.addEventListener("change", render);

(async () => {
  const name = "scan:" + scanKey;
  const stored = await chrome.storage.session.get(name);
  const scan = /** @type {{ pageUrl: string, title: string, items: { url: string, source: string, width: number, height: number }[] } | undefined} */ (stored[name]);
  if (!scan) {
    title.textContent = "This list has expired. Run the scan again from the page.";
    empty.hidden = true;
    return;
  }
  pageUrl = scan.pageUrl;
  title.textContent = scan.title ? "Largest images on: " + scan.title : "Largest images on this page";
  document.title = title.textContent;
  for (const item of scan.items) {
    const entry = makeCard(item);
    entries.push(entry);
    grid.appendChild(entry.card);
  }
  render();
})();
