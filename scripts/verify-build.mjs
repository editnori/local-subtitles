import { createHash } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
const required = [
  "manifest.json",
  "background.js",
  "content.js",
  "popup.html",
  "popup.css",
  "popup.js",
  "offscreen.html",
  "offscreen.js",
  "audio-worklet.js",
  "vendor/moonshine/asset-downloader.js",
  "vendor/moonshine/enums.js",
  "vendor/moonshine/errors.js",
  "vendor/moonshine/events.js",
  "vendor/moonshine/module.js",
  "vendor/moonshine/stream.js",
  "vendor/moonshine/stt-worker-host.js",
  "vendor/moonshine/stt-worker.js",
  "vendor/moonshine/transcriber.js",
  "vendor/moonshine/types.js",
  "vendor/moonshine/moonshine.mjs",
  "vendor/moonshine/moonshine.wasm",
  "vendor/moonshine/BUILD_RECEIPT.md",
  "vendor/moonshine/LICENSE",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "icons/icon-128.png"
];

for (const file of required) await access(resolve(dist, file));

// The unused TTS, voice-clone, embedding, and agent modules must stay out of
// the shipped extension.
for (const excluded of [
  "vendor/moonshine/index.js",
  "vendor/moonshine/text-to-speech.js",
  "vendor/moonshine/tts-worker.js",
  "vendor/moonshine/voice-clone.js",
  "vendor/moonshine/embedding-model.js",
  "vendor/moonshine/agent-flow.js"
]) {
  const present = await access(resolve(dist, excluded)).then(() => true, () => false);
  if (present) throw new Error(`Build shipped an unused Moonshine module: ${excluded}`);
}

const manifest = JSON.parse(await readFile(resolve(dist, "manifest.json"), "utf8"));
if (manifest.version !== "0.3.0") throw new Error("Unexpected build version.");

const wasm = await stat(resolve(dist, "vendor/moonshine/moonshine.wasm"));
if (wasm.size < 10_000_000) throw new Error("Moonshine WASM artifact is incomplete.");

const moonshineModule = await readFile(resolve(dist, "vendor/moonshine/moonshine.mjs"), "utf8");
if (moonshineModule.includes("PThread") || moonshineModule.includes("SharedArrayBuffer")) {
  throw new Error("The packaged Moonshine native runtime must be the single-thread build.");
}
if (moonshineModule.includes("new Function") || /\beval\s*\(/.test(moonshineModule)) {
  throw new Error("The packaged Moonshine runtime contains dynamic JavaScript evaluation.");
}
const moduleHash = createHash("sha256").update(moonshineModule).digest("hex");
if (moduleHash !== "9da0518702484050a1bebed39a9b5bc9d4e27f6bef582201805970bf89bfdbfb") {
  throw new Error(`Unexpected Moonshine module hash: ${moduleHash}`);
}
const wasmHash = createHash("sha256")
  .update(await readFile(resolve(dist, "vendor/moonshine/moonshine.wasm")))
  .digest("hex");
if (wasmHash !== "aeb726b721f34f7e03d112cd32d229e98503af90d399e368a63c1120c50158ed") {
  throw new Error(`Unexpected Moonshine WASM hash: ${wasmHash}`);
}

const background = await readFile(resolve(dist, "background.js"), "utf8");
if (background.includes("node_modules")) throw new Error("Build leaked a local dependency path.");

const downloader = await readFile(resolve(dist, "vendor/moonshine/asset-downloader.js"), "utf8");
if (!downloader.includes("new Response(buf.slice(0)")) {
  throw new Error("The extension-safe model cache path is missing.");
}

console.log(`Build checks passed: ${required.length} required files, ${(wasm.size / 1_048_576).toFixed(1)} MB single-thread SIMD engine.`);
