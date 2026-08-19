# Third-party notices

Local Subtitles includes a compiled Moonshine Voice browser runtime from commit `db88bffd14574212b6094a2e230d4f328029c31b`. Moonshine Voice is licensed under the MIT License. Its source is available at <https://github.com/moonshine-ai/moonshine>.

The runtime uses Moonshine's supported `MOONSHINE_WASM_SINGLE_THREAD` configuration with WebAssembly SIMD and ONNX Runtime's reduced operator build. Its embind bridge is generated ahead of time with dynamic JavaScript execution disabled for Manifest V3. Moonshine's JavaScript speech worker still keeps model loading and inference off the extension UI thread. Build flags and artifact hashes are recorded in `vendor/moonshine/BUILD_RECEIPT.md`.

The English Moonshine Tiny Streaming model downloads from `download.moonshine.ai` when subtitles start for the first time. The model is licensed under the MIT License and remains in the browser model cache for later offline use.

The extension sends no tab audio to Moonshine AI or another service. The network request downloads model files only.
