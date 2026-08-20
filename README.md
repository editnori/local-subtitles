# Local Subtitles

Local Subtitles captures audio from the active Chrome tab, transcribes it locally with Moonshine Streaming Tiny, and places live English subtitles over the largest playing video.

The extension supports Chrome 116 and newer. Audio remains in the browser and is processed through single-thread SIMD WebAssembly. The first transcription downloads and caches a 51.4 MB model, so later runs reuse the local copy and can work offline.

Site behavior can differ because the extension depends on Chrome tab capture and the page's video elements. Other browsers and videos without capturable tab audio are not supported targets.

## Install and run

```sh
npm install
npm run build
```

Open `chrome://extensions`, enable Developer mode, choose Load unpacked, and select the generated `dist` directory. Play a video, open Local Subtitles from the toolbar, and press Start subtitles.

`npm run package` also creates `artifacts/local-subtitles-0.2.0.zip` after running every maintained check.

## What happens after Start subtitles

The popup asks Chrome for the current tab's audio stream. The service worker passes that stream to an offscreen extension page, which restores audible playback and sends mono audio chunks to Moonshine's speech worker. The worker returns changing and completed transcript lines, and the service worker routes each line to the frame holding the largest playing video.

On the first run, transcription starts when the popup shows Subtitles are live; audio that played while the model was downloading is not replayed. Later runs open the cached model and go live much sooner.

The page overlay uses a Shadow DOM so site styles cannot reshape it. When a browser puts the video element itself into native fullscreen, the content script switches the same text into a generated caption track because ordinary page overlays are hidden in that mode.

## Runtime choice

The default model is [Moonshine Tiny Streaming](https://huggingface.co/UsefulSensors/moonshine-streaming-tiny), a current 34 million parameter streaming speech model. The extension uses Moonshine's current [JavaScript and WebAssembly binding](https://github.com/moonshine-ai/moonshine/tree/main/language-bindings/wasm) rather than the older segment-at-a-time Moonshine or Whisper browser demos. A dedicated module worker performs incremental CPU inference with WebAssembly SIMD while a separate AudioWorklet keeps captured audio moving.

The vendored native runtime uses Moonshine's supported single-thread build. The upstream pthread build initialized over a normal cross-origin-isolated HTTP page but did not finish native initialization under the tested `chrome-extension://` origin. Keeping one SIMD inference thread inside the existing speech worker removes that extension-only deadlock and avoids a pool of native workers on mobile devices. The exact source commit, toolchain, flags, and hashes are in `vendor/moonshine-single-thread/BUILD_RECEIPT.md`.

This build does not require WebGPU. Moonshine's true-streaming browser path is CPU WebAssembly, and making WebGPU mandatory would exclude extension-capable mobile browsers that do not expose it. On the maintained test host, the engine processed a 44.37-second speech fixture in 9.5 seconds of wall time with a 1.05-second slowest pass. That proves headroom on that host, not a phone-wide performance guarantee; the popup reports when a device falls more than 2.5 seconds behind.

The current model is English-only. Moonshine's current streaming English model is materially smaller than a general multilingual model, which keeps the first download and mobile memory use bounded. A multilingual model can be added as an explicit second mode after the English path is measured on the target browser and phone.

## Browser support

The extension targets Chromium 116 or newer because Chrome 116 is the first version that can create a tab stream in a service worker and consume it in an offscreen document. The browser also needs these capabilities:

- `chrome.tabCapture`
- `chrome.offscreen`
- Manifest V3 service workers
- WebAssembly SIMD and module workers

Desktop Chrome supports this path. Chrome for Android itself does not install Chrome extensions, and extension-capable Android browsers differ in which Chrome APIs they implement. The popup and subtitle overlay are responsive and touch-sized, but a mobile browser still needs all four runtime capabilities above.

Protected browser pages, browser-internal URLs, Picture-in-Picture windows, and some DRM playback paths can prevent either tab capture or page overlay injection. The popup reports a concrete start error instead of showing a listening state in those cases.

## Verification

```sh
npm run check
npm test
npm run build
node scripts/verify-build.mjs
```

`npm run verify` runs that complete source-to-artifact sequence. Browser verification lives in `tests/browser/extension-smoke.mjs` and loads the unpacked extension through Puppeteer's extension debugging API because a normal web page cannot exercise `tabCapture` or the offscreen extension API. Set `CHROMIUM_EXECUTABLE` and, when Puppeteer is not installed in this project, `PUPPETEER_MODULE` to its module entry point. Set `MOONSHINE_WAV_FIXTURE` to a mono 16 kHz PCM WAV file to include real model inference.

## Privacy and permissions

`tabCapture` reads the sound from the tab the user explicitly starts. `<all_urls>` lets the overlay find videos on ordinary sites and inside embedded frames. `offscreen` keeps the audio graph and speech worker alive after the popup closes. `storage` keeps appearance settings, the current status, and Moonshine's cached model files.

The extension has no analytics, account, transcript history, or application server. Model files come from `https://download.moonshine.ai`; tab audio and transcript text are not sent there.
