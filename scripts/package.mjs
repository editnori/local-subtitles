import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const artifacts = resolve(root, "artifacts");
const archive = resolve(artifacts, "local-subtitles-0.2.0.zip");

await mkdir(artifacts, { recursive: true });
await rm(archive, { force: true });

const result = spawnSync("zip", ["-qr", archive, "."], {
  cwd: resolve(root, "dist"),
  stdio: "inherit"
});
if (result.status !== 0) throw new Error("zip failed");

console.log(`Packaged ${archive}`);
