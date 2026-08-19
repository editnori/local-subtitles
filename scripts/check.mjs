import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(await readFile(resolve(root, "src/manifest.json"), "utf8"));

const requiredPermissions = new Set(["activeTab", "offscreen", "storage", "tabCapture"]);
for (const permission of requiredPermissions) {
  if (!manifest.permissions.includes(permission)) {
    throw new Error(`Missing required permission: ${permission}`);
  }
}

if (manifest.manifest_version !== 3) throw new Error("Manifest V3 is required.");
if (manifest.minimum_chrome_version !== "116") {
  throw new Error("Chrome 116 is required for service-worker tab capture into an offscreen document.");
}
if (!manifest.content_scripts?.[0]?.all_frames) {
  throw new Error("The video overlay must run in embedded video frames.");
}

const csp = manifest.content_security_policy?.extension_pages ?? "";
for (const token of ["'wasm-unsafe-eval'", "worker-src 'self'", "https://download.moonshine.ai"]) {
  if (!csp.includes(token)) throw new Error(`Extension CSP is missing ${token}.`);
}
if (/worker-src[^;]*blob:/.test(csp)) {
  throw new Error("Extension CSP must not permit insecure blob workers.");
}
if (csp.includes("'unsafe-eval'")) {
  throw new Error("Extension CSP must not permit dynamic JavaScript evaluation.");
}
if (!csp.includes("object-src 'none'")) {
  throw new Error("Extension CSP must block plugin objects.");
}

const offscreen = await readFile(resolve(root, "src/offscreen.js"), "utf8");
if (/crossOriginIsolated|SharedArrayBuffer/.test(offscreen)) {
  throw new Error("The single-thread extension runtime must not require cross-origin isolation.");
}

console.log("Source contract checks passed.");
