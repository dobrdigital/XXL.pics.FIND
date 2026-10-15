// Global enable/disable toggle. The userscript reads the same "imu_enabled" key.
const enable = document.getElementById("global-enable");
const disable = document.getElementById("global-disable");

chrome.storage.sync.get(["imu_enabled"], (data) => {
  (data.imu_enabled === "false" ? disable : enable).checked = true;
});

for (const input of [enable, disable]) {
  input.addEventListener("change", () => {
    chrome.storage.sync.set({ imu_enabled: String(input === enable) });
  });
}
