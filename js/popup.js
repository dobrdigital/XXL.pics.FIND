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

// Scan the active tab for its largest pictures. The worker opens the gallery page.
const scan = /** @type {HTMLButtonElement} */ (document.getElementById("scan"));
const scanStatus = /** @type {HTMLElement} */ (document.getElementById("scan-status"));
scan.addEventListener("click", () => {
  scan.disabled = true;
  scanStatus.textContent = "Scanning…";
  chrome.runtime.sendMessage({ type: "scan_page" }, (reply) => {
    if (chrome.runtime.lastError || !reply || reply.error) {
      scan.disabled = false;
      scanStatus.textContent = "This page cannot be scanned.";
      return;
    }
    window.close();
  });
});
