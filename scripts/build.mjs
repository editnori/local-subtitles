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
    external: ["./vendor/moonshine/index.js"],
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

await cp(
  resolve(root, "vendor/moonshine-single-thread"),
  resolve(output, "vendor/moonshine"),
  { recursive: true }
);

const iconSvg = await readFile(resolve(source, "icons/icon.svg"), "utf8");
for (const size of [16, 32, 48, 128]) {
  const rendered = new Resvg(iconSvg, {
    fitTo: { mode: "width", value: size }
  }).render();
  await writeFile(resolve(output, `icons/icon-${size}.png`), rendered.asPng());
}

console.log("Built dist/ with local extension code and the extension-safe Moonshine SIMD runtime.");
