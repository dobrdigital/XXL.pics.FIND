// Checks that need no browser: the X response parser and reading image sizes from the
// first bytes of a file. Run with `npm run test:unit` (node --test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { makePng } from "./png.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("X parser finds every video variant, the original photo and quoted media", () => {
  // A response shaped like TweetResultByRestId (yt-dlp's reference).
  const hookContext = { module: { exports: {} }, window: { location: { hostname: "example.test" } } };
  vm.runInNewContext(readFileSync(path.join(ROOT, "js", "media-hook.js"), "utf8"), hookContext);
  const tweet = { data: { tweetResult: { result: { legacy: {
    extended_entities: { media: [
      { type: "video", media_url_https: "https://pbs.twimg.com/amplify_video_thumb/1/img/a.jpg", video_info: { variants: [
        { content_type: "application/x-mpegURL", url: "https://video.twimg.com/amplify_video/1/pl/x.m3u8?tag=14" },
        { bitrate: 832000, content_type: "video/mp4", url: "https://video.twimg.com/amplify_video/1/vid/avc1/480x270/a.mp4?tag=14" },
        { bitrate: 2176000, content_type: "video/mp4", url: "https://video.twimg.com/amplify_video/1/vid/avc1/1280x720/b.mp4?tag=14" },
      ] } },
      { type: "photo", media_url_https: "https://pbs.twimg.com/media/ABCdef.jpg", original_info: { width: 4096, height: 2731 } },
    ] },
  }, quoted_status_result: { result: { legacy: { extended_entities: { media: [
    { type: "animated_gif", video_info: { variants: [{ bitrate: 0, content_type: "video/mp4", url: "https://video.twimg.com/tweet_video/G.mp4" }] } },
  ] } } } } } } } };
  const parsed = hookContext.module.exports.extractMedia(tweet);
  const best = parsed.filter((m) => m.kind === "video").sort((a, b) => b.bitrate - a.bitrate)[0];
  const photo = parsed.find((m) => m.kind === "image");
  assert.equal(parsed.length, 5);
  assert.deepEqual([best.width, best.height, best.bitrate], [1280, 720, 2176000]);
  assert.equal(photo.url, "https://pbs.twimg.com/media/ABCdef?format=jpg&name=orig");
  assert.equal(photo.width, 4096);
  assert.ok(parsed.some((m) => m.kind === "stream"));
  assert.ok(parsed.some((m) => m.url.endsWith("/G.mp4")));
});

test("image size is read from PNG, JPEG, GIF, WebP (3 kinds) and AVIF headers", () => {
  const sizeContext = {};
  vm.createContext(sizeContext);
  vm.runInContext(readFileSync(path.join(ROOT, "js", "imagesize.js"), "utf8"), sizeContext);
  const readSize = (bytes) => JSON.stringify(sizeContext.imageSizeFromBytes(bytes));
  const padTo = (parts, length = 64) => Buffer.concat([...parts, Buffer.alloc(Math.max(0, length - Buffer.concat(parts).length))]);
  const u16 = (n) => Buffer.from([n >> 8, n & 255]);
  const u32 = (n) => Buffer.from([n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255]);
  const le24 = (n) => Buffer.from([n & 255, (n >> 8) & 255, (n >> 16) & 255]);
  const jpeg = padTo([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(14), Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08]), u16(1066), u16(1600), Buffer.from([3])]);
  const gif = padTo([Buffer.from("GIF89a"), Buffer.from([0x20, 0x03, 0x58, 0x02])]);
  const webpX = padTo([Buffer.from("RIFF"), u32(0), Buffer.from("WEBPVP8X"), u32(10), Buffer.alloc(4), le24(1919), le24(1079)]);
  const lossless = (1279) | (719 << 14);
  const webpL = padTo([Buffer.from("RIFF"), u32(0), Buffer.from("WEBPVP8L"), u32(5), Buffer.from([0x2f, lossless & 255, (lossless >> 8) & 255, (lossless >> 16) & 255, (lossless >> 24) & 255])]);
  const webpLossy = padTo([Buffer.from("RIFF"), u32(0), Buffer.from("WEBPVP8 "), u32(10), Buffer.from([0, 0, 0, 0x9d, 0x01, 0x2a, 640 & 255, 640 >> 8, 480 & 255, 480 >> 8])]);
  const avif = padTo([u32(24), Buffer.from("ftypavif"), Buffer.alloc(4), Buffer.from("avifmif1"), u32(20), Buffer.from("ispe"), Buffer.alloc(4), u32(3000), u32(2000)]);
  assert.equal(readSize(makePng(321, 123)), '{"width":321,"height":123}');
  assert.equal(readSize(jpeg), '{"width":1600,"height":1066}');
  assert.equal(readSize(gif), '{"width":800,"height":600}');
  assert.equal(readSize(webpX), '{"width":1920,"height":1080}');
  assert.equal(readSize(webpL), '{"width":1280,"height":720}');
  assert.equal(readSize(webpLossy), '{"width":640,"height":480}');
  assert.equal(readSize(avif), '{"width":3000,"height":2000}');
  assert.equal(sizeContext.imageSizeFromBytes(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>")), null);
  // A cut-off file must not throw: the probe reads only the first 64 KB.
  assert.equal(sizeContext.imageSizeFromBytes(jpeg.subarray(0, 26)), null);
});
