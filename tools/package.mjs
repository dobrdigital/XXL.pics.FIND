// Builds the installable package: dist/XXL.pics.FIND-<version>.zip. It holds only what the
// browser needs to run the extension (no tests, tools, CI files or development packages),
// so the same zip can be unpacked by people or uploaded to a store. No dependencies: the
// zip is written here with Node's zlib.
// Usage: node tools/package.mjs
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Top-level files and folders that go into the package. Everything else stays in the repo.
const INCLUDE = ["manifest.json", "background.js", "userscript.user.js", "js", "html", "extension", "icons", "_locales", "LICENSE", "LICENSE-APACHE-2.0", "NOTICE"];

function listFiles(relative) {
  const absolute = path.join(ROOT, relative);
  if (!statSync(absolute).isDirectory()) return [relative];
  return readdirSync(absolute).sort().flatMap((name) => listFiles(path.join(relative, name)));
}

// Zip with deflate (method 8) and UTF-8 names (flag bit 11). Timestamps are fixed so the
// same source always gives the same bytes.
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const DOS_TIME = 0;
  const DOS_DATE = (2026 - 1980) << 9 | 10 << 5 | 18; // 2026-10-18
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const packed = zlib.deflateRawSync(data, { level: 9 });
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    const record = Buffer.concat([local, nameBytes, packed]);
    locals.push(record);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBytes]));
    offset += record.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

const manifest = JSON.parse(readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const files = INCLUDE.flatMap(listFiles).map((file) => file.split(path.sep).join("/")).sort();
const entries = files.map((name) => ({ name, data: readFileSync(path.join(ROOT, name)) }));
const outDir = path.join(ROOT, "dist");
mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `XXL.pics.FIND-${manifest.version}.zip`);
writeFileSync(out, makeZip(entries));
console.log(`wrote ${out} (${entries.length} files)`);
