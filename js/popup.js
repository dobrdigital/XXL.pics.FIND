// Global enable/disable toggle. The userscript reads the same "imu_enabled" key.
const enable = /** @type {HTMLInputElement} */ (document.getElementById("global-enable"));
const disable = /** @type {HTMLInputElement} */ (document.getElementById("global-disable"));

chrome.storage.sync.get(["imu_enabled"], (data) => {
  (data.imu_enabled === "false" ? disable : enable).checked = true;
});

for (const input of [enable, disable]) {
  input.addEventListener("change", () => {
    chrome.storage.sync.set({ imu_enabled: String(input === enable) });
  });
}

// "Download button on hover" (js/hover-button.js). On unless it was turned off.
const hoverButton = /** @type {HTMLInputElement} */ (document.getElementById("hover-button"));
chrome.storage.sync.get(["xxl_hover_button"], (data) => {
  hoverButton.checked = data.xxl_hover_button !== "false";
});
hoverButton.addEventListener("change", () => {
  chrome.storage.sync.set({ xxl_hover_button: String(hoverButton.checked) });
});

// Scan the active tab for its largest pictures. The worker opens the gallery page.
const scan = /** @type {HTMLButtonElement} */ (document.getElementById("scan"));
const scanStatus = /** @type {HTMLElement} */ (document.getElementById("scan-status"));
scan.addEventListener("click", async () => {
  scan.disabled = true;
  scanStatus.textContent = "Scanning…";
  // The popup knows which tab it was opened on; the worker's own "current window" can be
  // another window when several are open.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.runtime.sendMessage({ type: "scan_page", data: { tabId: tab && tab.id } }, (reply) => {
    if (chrome.runtime.lastError || !reply || reply.error) {
      scan.disabled = false;
      scanStatus.textContent = "This page cannot be scanned.";
      return;
    }
    window.close();
  });
});
