// Loads this folder as an unpacked extension into a Chrome that is already running with
// --remote-debugging-port and --enable-unsafe-extension-debugging (Chrome 137+ ignores
// --load-extension, so the DevTools command Extensions.loadUnpacked is used instead).
// Usage: node tools/load-extension.mjs [port]      (default port 9222)
// Run it again after changing the code: loading the same folder reloads the extension.
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.argv[2] || 9222);

const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve) => (ws.onopen = resolve));
ws.send(JSON.stringify({ id: 1, method: "Extensions.loadUnpacked", params: { path: ROOT } }));
const reply = await new Promise((resolve) => {
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id === 1) resolve(message);
  };
});
console.log(reply.error ? "failed: " + JSON.stringify(reply.error) : "loaded " + ROOT + " as " + reply.result.id);
ws.close();
