# Moonshine browser runtime build receipt

- Source: `https://github.com/moonshine-ai/moonshine`
- Commit: `db88bffd14574212b6094a2e230d4f328029c31b`
- Upstream version: `0.1.3`
- Toolchain: Emscripten `4.0.8`
- ONNX Runtime: `1.23.2`, minimal operator build
- Moonshine flags: `-DMOONSHINE_WASM_SINGLE_THREAD=ON`, `-sDYNAMIC_EXECUTION=0`, `-sEMBIND_AOT=1`, release, WebAssembly SIMD
- `moonshine.mjs` SHA-256: `9da0518702484050a1bebed39a9b5bc9d4e27f6bef582201805970bf89bfdbfb`
- `moonshine.wasm` SHA-256: `aeb726b721f34f7e03d112cd32d229e98503af90d399e368a63c1120c50158ed`

The upstream JavaScript speech worker remains enabled, so model loading and inference stay off the extension UI thread. The compiled native runtime omits pthreads because the upstream threaded artifact does not finish native initialization under the tested `chrome-extension://` origin. The same threaded artifact did initialize over an ordinary cross-origin-isolated HTTP origin. Ahead-of-time embind invokers remove `eval` and `new Function`, which Manifest V3 forbids.

`asset-downloader.js` stores downloaded bytes in a new extension-owned `Response` after reading them. Chromium rejected `Cache.put(url, response.clone())` for the CDN response under the extension origin; this preserves Cache Storage reuse without turning a cache-write failure into a model-load failure.
