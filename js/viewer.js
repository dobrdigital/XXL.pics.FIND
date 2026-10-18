// Opens an image that needs request headers. The background worker keeps the
// headers under a one-time key; the image is fetched through the same proxy the
// content script uses, then shown from a blob URL.
// In download mode (view.mode === "download") the same fetch is saved to disk
// from a blob URL instead, and this tab closes when the download finishes.
// Not named "status": that clashes with window.status in a classic script.
const statusLine = /** @type {HTMLElement} */ (document.getElementById("status"));
const image = /** @type {HTMLImageElement} */ (document.getElementById("image"));
const key = new URLSearchParams(location.search).get("k");
const events = new Map(); // proxy events by request id
let requestId = null;
let view = null;

const EXTENSIONS = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif", "image/svg+xml": "svg" };

function fail(message) {
  statusLine.textContent = message;
  image.hidden = true;
}

// Turns a proxy onload event into a Blob. Anything else is reported to the user.
function readBlob(event) {
  if (event.event !== "onload") {
    fail(event.event === "onabort" ? "Cancelled." : "Could not load the image.");
    return null;
  }
  const encoded = event.data._responseEncoded;
  if (!encoded || !encoded.value) {
    fail(event.data.status ? "Server returned HTTP " + event.data.status + "." : "Could not load the image.");
    return null;
  }
  const bytes = new Uint8Array(encoded.value.length);
  for (let i = 0; i < encoded.value.length; i++) bytes[i] = encoded.value.charCodeAt(i);
  return new Blob([bytes], { type: encoded.type || "image/*" });
}

function show(event) {
  const blob = readBlob(event);
  if (!blob) return;
  image.onerror = () => fail("This link is not an image.");
  image.onload = () => { statusLine.textContent = ""; };
  image.src = URL.createObjectURL(blob);
  image.hidden = false;
}

// File name from the URL path, with an extension taken from the MIME type if missing.
function fileName(url, type) {
  let last = (new URL(url).pathname.split("/").pop() || "").replace(/[\\/:*?"<>|]/g, "_");
  try {
    last = decodeURIComponent(last).replace(/[\\/:*?"<>|]/g, "_");
  } catch (error) {
    // keep the raw segment when it is not valid percent-encoding
  }
  if (/\.\w{2,5}$/.test(last)) return last;
  return (last || "image") + "." + (EXTENSIONS[type] || "bin");
}

function save(event) {
  const blob = readBlob(event);
  if (!blob) return;
  const objectUrl = URL.createObjectURL(blob);
  statusLine.textContent = "Saving…";
  chrome.downloads.download({ url: objectUrl, filename: fileName(view.url, blob.type), saveAs: view.saveAs }, (downloadId) => {
    if (chrome.runtime.lastError || downloadId === undefined) {
      return fail(chrome.runtime.lastError ? chrome.runtime.lastError.message : "Download failed.");
    }
    const done = (delta) => {
      if (delta.id === downloadId && delta.state && delta.state.current !== "in_progress") {
        chrome.downloads.onChanged.removeListener(done);
        URL.revokeObjectURL(objectUrl);
        chrome.tabs.getCurrent((tab) => tab && chrome.tabs.remove(tab.id));
      }
    };
    chrome.downloads.onChanged.addListener(done);
  });
}

function handle(event) {
  return view.mode === "download" ? save(event) : show(event);
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== "request" || !message.data) return;
  events.set(message.data.id, message.data);
  if (message.data.id === requestId) handle(message.data);
});

chrome.runtime.sendMessage({ type: "get_view", data: { key } }, (reply) => {
  view = reply && reply.data;
  if (!view) return fail("This image link has expired. Open the image again from the page.");
  chrome.runtime.sendMessage(
    { type: "request", data: { url: view.url, headers: view.headers, responseType: "blob" } },
    (started) => {
      // No reply when the worker failed to start the request (it answers { error }).
      if (chrome.runtime.lastError || !started || !started.data) return fail("Could not load the image.");
      requestId = started.data;
      if (events.has(requestId)) handle(events.get(requestId));
    },
  );
});
