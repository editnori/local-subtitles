import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Resvg } from "@resvg/resvg-js";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "src");
const output = resolve(root, "dist");

await rm(output, { recursive: true, force: true });
await mkdir(resolve(output, "icons"), { recursive: true });

const entries = [
  ["background.js", "esm"],
  ["popup.js", "esm"],
  ["offscreen.js", "esm"],
  ["content.js", "iife"],
  ["audio-worklet.js", "iife"]
];

for (const [entry, format] of entries) {
  await build({
    entryPoints: [resolve(source, entry)],
    outfile: resolve(output, entry),
    bundle: true,
    format,
    platform: "browser",
    target: "chrome116",
    external: ["./vendor/moonshine/*"],
    legalComments: "none",
    sourcemap: false
  });
}

for (const file of [
  "manifest.json",
  "popup.html",
  "popup.css",
  "offscreen.html",
  "THIRD_PARTY_NOTICES.md"
]) {
  await cp(resolve(source, file), resolve(output, file));
}

// Ship only the speech-to-text import closure. The vendored build also
// contains TTS, voice-clone, embedding, and agent modules the extension
// never loads.
const moonshineSttFiles = [
  "asset-downloader.js",
  "enums.js",
  "errors.js",
  "events.js",
  "module.js",
  "moonshine.mjs",
  "moonshine.wasm",
  "stream.js",
  "stt-worker-host.js",
  "stt-worker.js",
  "transcriber.js",
  "types.js",
  "BUILD_RECEIPT.md",
  "LICENSE"
];
await mkdir(resolve(output, "vendor/moonshine"), { recursive: true });
for (const file of moonshineSttFiles) {
  await cp(
    resolve(root, "vendor/moonshine-single-thread", file),
    resolve(output, "vendor/moonshine", file)
  );
}

const iconSvg = await readFile(resolve(source, "icons/icon.svg"), "utf8");
for (const size of [16, 32, 48, 128]) {
  const rendered = new Resvg(iconSvg, {
    fitTo: { mode: "width", value: size }
  }).render();
  await writeFile(resolve(output, `icons/icon-${size}.png`), rendered.asPng());
}

console.log("Built dist/ with local extension code and the extension-safe Moonshine SIMD runtime.");
