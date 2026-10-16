// Isolated-world half of js/media-hook.js. The hook runs in the page's world and cannot
// call extension APIs, so it posts what it finds to the window, and this script passes
// it to the background worker. The page can post too; the worker only keeps http(s)
// URLs and uses them for this tab's own gallery.
window.addEventListener("message", (event) => {
  if (event.source !== window || !event.data || event.data.__imu !== "media") return;
  if (!Array.isArray(event.data.items)) return;
  try {
    chrome.runtime.sendMessage({ type: "media_found", data: event.data.items }).catch(() => {});
  } catch (error) {
    // the extension was reloaded or updated while this page stayed open
  }
});
