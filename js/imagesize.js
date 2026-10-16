// Finds the pixel size of an image without downloading all of it. Image formats put
// their width and height in the first bytes, so a range request for the first 64 KB is
// enough. A classic script, shared by the background worker (importScripts) and the
// gallery page (<script>). Defines two globals: imageSizeFromBytes and probeImageSize.

// Reads the size from the start of a PNG, GIF, JPEG, WebP or AVIF file. Returns
// { width, height } or null when the format is not recognised (SVG, for example).
function imageSizeFromBytes(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (start, length) => String.fromCharCode(...bytes.subarray(start, start + length));
  if (bytes.length < 24) return null;

  if (ascii(1, 3) === "PNG") {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (ascii(0, 3) === "GIF") {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    // Walk the segments until a start-of-frame marker (SOF0..SOF15, not DHT/JPG/DAC).
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = bytes[i + 1];
      if (marker === 0xff) {
        i++; // padding
        continue;
      }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: view.getUint16(i + 7), height: view.getUint16(i + 5) };
      }
      i += 2 + view.getUint16(i + 2);
    }
    return null;
  }
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const chunk = ascii(12, 4);
    if (chunk === "VP8X") {
      return { width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)), height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) };
    }
    if (chunk === "VP8L") {
      return {
        width: 1 + (bytes[21] | ((bytes[22] & 0x3f) << 8)),
        height: 1 + ((bytes[22] >> 6) | (bytes[23] << 2) | ((bytes[24] & 0x0f) << 10)),
      };
    }
    if (chunk === "VP8 ") {
      return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    }
    return null;
  }
  if (ascii(4, 4) === "ftyp") {
    // AVIF/HEIF: the image spatial extents box "ispe" holds version+flags, width, height.
    for (let i = 8; i + 16 < bytes.length; i++) {
      if (ascii(i, 4) === "ispe") return { width: view.getUint32(i + 8), height: view.getUint32(i + 12) };
    }
  }
  return null;
}

// Fetches the first 64 KB of an image and returns { width, height, bytes, type }, where
// bytes is the full file size when the server tells it. Returns null on any failure.
// Works from the worker and from extension pages, which may fetch cross-origin with
// the extension's host permissions. Cookies are not sent.
async function probeImageSize(url, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: { Range: "bytes=0-65535" }, signal: controller.signal, credentials: "omit" });
    if (!response.ok || !response.body) return null;
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (total < 65536) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    controller.abort(); // stop the rest of the download
    const head = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      head.set(chunk, offset);
      offset += chunk.length;
    }
    const size = imageSizeFromBytes(head);
    if (!size || !size.width || !size.height) return null;
    const range = (response.headers.get("content-range") || "").match(/\/(\d+)$/);
    return {
      width: size.width,
      height: size.height,
      bytes: range ? Number(range[1]) : Number(response.headers.get("content-length")) || 0,
      type: response.headers.get("content-type") || "",
    };
  } catch (error) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
