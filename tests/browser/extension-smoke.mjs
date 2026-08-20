import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "../..");
const extensionPath = resolve(root, "dist");
const artifacts = resolve(root, "artifacts/browser");
const wavFixturePath = process.env.MOONSHINE_WAV_FIXTURE || "";
const puppeteerModule = process.env.PUPPETEER_MODULE || "puppeteer-core";
const moduleSpecifier = puppeteerModule.startsWith("/")
  ? pathToFileURL(puppeteerModule).href
  : puppeteerModule;
const { default: puppeteer } = await import(moduleSpecifier);

await mkdir(artifacts, { recursive: true });

const fixtureHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Subtitle extension fixture</title>
  <style>
    html,body { height:100%; margin:0; background:#111; }
    main { height:100%; display:grid; place-items:center; }
    video { display:block; width:min(900px, 88vw); aspect-ratio:16/9; background:#202127; border-radius:18px; }
  </style>
</head>
<body><main><video controls preload="auto" ${wavFixturePath ? 'src="/fixture.wav"' : ""} aria-label="Test video"></video></main></body>
</html>`;

const server = createServer(async (request, response) => {
  const headers = {
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-embedder-policy": "require-corp",
    "cache-control": "no-store"
  };
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (pathname === "/fixture.wav" && wavFixturePath) {
    const body = await readFile(wavFixturePath);
    const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
    const start = match ? Number(match[1]) : 0;
    const requestedEnd = match?.[2] ? Number(match[2]) : body.length - 1;
    const end = Math.min(body.length - 1, requestedEnd);
    const chunk = body.subarray(start, end + 1);
    response.writeHead(match ? 206 : 200, {
      ...headers,
      "content-type": "audio/wav",
      "accept-ranges": "bytes",
      "content-length": String(chunk.length),
      ...(match ? { "content-range": `bytes ${start}-${end}/${body.length}` } : {})
    });
    response.end(chunk);
    return;
  }
  if (pathname.startsWith("/vendor/moonshine/")) {
    const relative = pathname.slice("/vendor/moonshine/".length);
    if (!relative || relative.includes("..") || relative.includes("\\")) {
      response.writeHead(400, headers);
      response.end("Bad asset path");
      return;
    }
    try {
      const body = await readFile(resolve(extensionPath, "vendor/moonshine", relative));
      const mime = extname(relative) === ".wasm"
        ? "application/wasm"
        : extname(relative) === ".json" || extname(relative) === ".map"
          ? "application/json"
          : "text/javascript; charset=utf-8";
      response.writeHead(200, { ...headers, "content-type": mime });
      response.end(body);
    } catch {
      response.writeHead(404, headers);
      response.end("Not found");
    }
    return;
  }
  response.writeHead(200, {
    ...headers,
    "content-type": "text/html; charset=utf-8",
  });
  response.end(fixtureHtml);
});
await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const address = server.address();
const fixtureUrl = `http://127.0.0.1:${address.port}/`;

const browserErrors = [];
let browser;

function watchPage(page, label) {
  page.on("pageerror", (error) => browserErrors.push(`${label}: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(`${label}: ${message.text()}`);
    if (process.env.BROWSER_VERBOSE === "1") console.log(`${label}: ${message.text()}`);
  });
  page.on("workercreated", async (worker) => {
    if (process.env.BROWSER_VERBOSE !== "1") return;
    try {
      const state = await worker.evaluate(() => ({
        name: self.name,
        crossOriginIsolated: self.crossOriginIsolated,
        sharedArrayBuffer: typeof SharedArrayBuffer === "function",
        hardwareConcurrency: navigator.hardwareConcurrency
      }));
      console.log(`${label}: worker created ${worker.url()} ${JSON.stringify(state)}`);
    } catch (error) {
      console.log(`${label}: worker inspection failed ${worker.url()} ${error.message}`);
    }
  });
  page.on("workerdestroyed", (worker) => {
    if (process.env.BROWSER_VERBOSE === "1") console.log(`${label}: worker destroyed ${worker.url()}`);
  });
}

function readWavPcm16(buffer) {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Expected a RIFF/WAVE fixture.");
  }
  let offset = 12;
  let sampleRate;
  let channels;
  let bitsPerSample;
  let pcm;
  while (offset + 8 <= buffer.length) {
    const name = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (name === "fmt ") {
      channels = buffer.readUInt16LE(start + 2);
      sampleRate = buffer.readUInt32LE(start + 4);
      bitsPerSample = buffer.readUInt16LE(start + 14);
    }
    if (name === "data") pcm = buffer.subarray(start, start + size);
    offset = start + size + (size % 2);
  }
  if (!pcm || channels !== 1 || bitsPerSample !== 16 || !sampleRate) {
    throw new Error("The browser engine check needs mono 16-bit PCM WAV audio.");
  }
  return { pcmBase64: pcm.toString("base64"), sampleRate };
}

async function runEngineCheck(page, runtimeBaseUrl) {
  if (process.env.SKIP_ENGINE_CHECK === "1") return { skipped: "SKIP_ENGINE_CHECK was set" };
  const fixturePath = wavFixturePath;
  if (!fixturePath) return { skipped: "MOONSHINE_WAV_FIXTURE was not set" };
  const wav = readWavPcm16(await readFile(fixturePath));
  return page.evaluate(async ({ pcmBase64, sampleRate, runtimeBaseUrl }) => {
    console.log(`[engine] browser reports ${navigator.hardwareConcurrency} logical CPUs`);
    const launcher = await fetch(`${runtimeBaseUrl}moonshine.mjs`).then(
      (response) => response.text()
    );
    const singleThreadRuntime =
      !launcher.includes("PThread") && !launcher.includes("SharedArrayBuffer");
    console.log(`[engine] single-thread SIMD runtime: ${singleThreadRuntime}`);
    const binary = atob(pcmBase64);
    const pcmBytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      pcmBytes[index] = binary.charCodeAt(index);
    }
    const int16 = new Int16Array(pcmBytes.buffer);
    const audio = new Float32Array(int16.length);
    for (let index = 0; index < int16.length; index += 1) {
      audio[index] = int16[index] / 32768;
    }

    const [{ ModelArch }, { SttWorkerHost }] = await Promise.all([
      import(`${runtimeBaseUrl}enums.js`),
      import(`${runtimeBaseUrl}stt-worker-host.js`)
    ]);
    console.log("[engine] runtime imported");
    const host = new SttWorkerHost();
    console.log("[engine] STT worker created");
    const lines = new Map();
    let partialUpdates = 0;
    let progressEvents = 0;
    let lastPassMs = 0;
    let maxPassMs = 0;
    let inferencePasses = 0;
    let totalPassMs = 0;
    let engineError = "";
    host.onProgress = () => {
      progressEvents += 1;
    };

    const modelLoadStarted = performance.now();
    await Promise.race([
      host.loadTranscriber({
        transcriberId: "browser-check",
        modelArch: ModelArch.TinyStreaming,
        source: { kind: "catalog", language: "en" }
      }),
      new Promise((_, rejectLoad) =>
        setTimeout(() => rejectLoad(new Error("Moonshine model load timed out.")), 180_000)
      )
    ]);
    const modelLoadMs = performance.now() - modelLoadStarted;
    console.log("[engine] transcriber loaded");
    await host.createStream("browser-check", "fixture", { updateInterval: 4 });
    host.setListener("fixture", {
      onLineStarted: ({ line }) => {
        lines.set(line.id, line.text);
      },
      onLineTextChanged: ({ line }) => {
        partialUpdates += 1;
        lines.set(line.id, line.text);
      },
      onLineCompleted: ({ line }) => {
        lines.set(line.id, line.text);
      },
      onError: ({ error }) => {
        engineError = error instanceof Error ? error.message : String(error);
      }
    });
    await host.start("fixture");

    const chunkSize = sampleRate * 4;
    const inferenceStarted = performance.now();
    for (let offset = 0; offset < audio.length; offset += chunkSize) {
      const pass = new Promise((resolvePass, rejectPass) => {
        const timer = setTimeout(() => rejectPass(new Error("Moonshine pass timed out.")), 120_000);
        host.onPass = (_streamId, milliseconds) => {
          clearTimeout(timer);
          if (milliseconds > 0) {
            lastPassMs = milliseconds;
            maxPassMs = Math.max(maxPassMs, milliseconds);
            totalPassMs += milliseconds;
            inferencePasses += 1;
          }
          resolvePass();
        };
      });
      host.addAudio("fixture", audio.subarray(offset, Math.min(offset + chunkSize, audio.length)), sampleRate);
      await pass;
      if (engineError) throw new Error(engineError);
    }
    await host.stop("fixture");
    const inferenceWallMs = performance.now() - inferenceStarted;
    if (engineError) throw new Error(engineError);
    await host.closeStream("fixture");
    host.close();

    const modelCache = await caches.open("moonshine-models-v1");
    const cachedRequests = await modelCache.keys();
    let cachedBytes = 0;
    for (const request of cachedRequests) {
      const response = await modelCache.match(request);
      cachedBytes += Number(response?.headers.get("content-length") || 0);
    }

    const text = [...lines.values()].join(" ").toLowerCase();
    return {
      skipped: false,
      crossOriginIsolated,
      sharedArrayBuffer: typeof SharedArrayBuffer === "function",
      singleThreadRuntime,
      progressEvents,
      partialUpdates,
      completedLines: lines.size,
      cachedFiles: cachedRequests.length,
      cachedBytes,
      modelLoadMs: Math.round(modelLoadMs),
      inferenceWallMs: Math.round(inferenceWallMs),
      inferencePasses,
      lastPassMs,
      maxPassMs,
      totalPassMs,
      text,
      containsBestOfTimes: text.includes("best of times"),
      containsWorstOfTimes: text.includes("worst of times")
    };
  }, { ...wav, runtimeBaseUrl });
}

async function runModuleCheck(page, runtimeBaseUrl) {
  return page.evaluate(async (runtimeBaseUrl) => {
    console.log(`[module] browser reports ${navigator.hardwareConcurrency} logical CPUs`);
    const [{ default: createMoonshineModule }, { ModelArch }] = await Promise.all([
      import(`${runtimeBaseUrl}moonshine.mjs`),
      import(`${runtimeBaseUrl}enums.js`)
    ]);
    const started = performance.now();
    const module = await Promise.race([
      createMoonshineModule({
        locateFile: (path) => `${runtimeBaseUrl}${path}`,
        monitorRunDependencies: (count) => console.log(`[module] run dependencies: ${count}`),
        onAbort: (reason) => console.error(`[module] aborted: ${reason}`),
        print: (...args) => console.log("[module]", ...args),
        printErr: (...args) => console.error("[module]", ...args)
      }),
      new Promise((_, rejectLoad) =>
        setTimeout(() => rejectLoad(new Error("Moonshine module load timed out.")), 120_000)
      )
    ]);
    const manifest = JSON.parse(module.sttDependencies("en", String(ModelArch.TinyStreaming), false));
    return {
      skipped: "module-only diagnostic",
      moduleReady: true,
      loadMs: Math.round(performance.now() - started),
      files: manifest.groups.flatMap((group) => group.files.map((file) => file.name))
    };
  }, runtimeBaseUrl);
}

try {
  const executablePath = process.env.CHROMIUM_EXECUTABLE;
  if (!executablePath) throw new Error("CHROMIUM_EXECUTABLE must point to Chromium or Chrome for Testing.");

  console.log("browser: launching Chromium with extension debugging enabled");
  browser = await puppeteer.launch({
    executablePath,
    headless: false,
    pipe: true,
    enableExtensions: true,
    protocolTimeout: 600_000,
    env: {
      ...process.env,
      LD_LIBRARY_PATH: process.env.CHROMIUM_LIBRARY_PATH || process.env.LD_LIBRARY_PATH
    },
    args: [
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--autoplay-policy=no-user-gesture-required"
    ]
  });
  const extensionId = await browser.installExtension(extensionPath);
  const installed = await browser.extensions();
  const installedExtension = installed.get(extensionId);
  if (installedExtension?.name !== "Local Subtitles") {
    throw new Error(`Local Subtitles was not installed: ${JSON.stringify([...installed.keys()])}`);
  }
  console.log(`browser: installed Local Subtitles as ${extensionId}`);

  const videoPage = await browser.newPage();
  videoPage.setDefaultTimeout(10_000);
  console.log("browser: opened fixture tab");
  watchPage(videoPage, "video page");
  await videoPage.setViewport({ width: 1100, height: 760 });
  await videoPage.goto(fixtureUrl);
  console.log("browser: fixture loaded");
  await videoPage.bringToFront();
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 1800));

  const popup = await browser.newPage();
  popup.setDefaultTimeout(10_000);
  console.log("browser: opened popup tab");
  watchPage(popup, "popup");
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const videoTabId = await popup.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((tab) => tab.url === url)?.id ?? null;
  }, fixtureUrl);
  if (!Number.isInteger(videoTabId)) throw new Error("Could not resolve the fixture tab ID.");
  await popup.evaluate((tabId) => chrome.tabs.update(tabId, { active: true }), videoTabId);
  await popup.reload();
  console.log("browser: popup loaded with fixture active");
  await popup.setViewport({ width: 398, height: 720 });
  await popup.waitForSelector("#toggleButton");
  await popup.waitForFunction(() =>
    document.querySelector("#statusDetail")?.textContent.includes("largest video is ready")
  );
  console.log("browser: video detection visible in popup");

  const workerTarget = await browser.waitForTarget(
    (target) => target.type() === "service_worker" && target.url().includes(extensionId),
    { timeout: 10_000 }
  );
  const worker = await workerTarget.worker();
  if (!worker) throw new Error("The extension service worker target was not inspectable.");
  console.log(`browser: service worker ${workerTarget.url()}`);

  const runtime = await popup.evaluate(async () => {
    const launcher = await fetch(chrome.runtime.getURL("vendor/moonshine/moonshine.mjs")).then(
      (response) => response.text()
    );
    return {
      crossOriginIsolated,
      sharedArrayBuffer: typeof SharedArrayBuffer === "function",
      singleThreadRuntime:
        !launcher.includes("PThread") && !launcher.includes("SharedArrayBuffer"),
      manifestVersion: chrome.runtime.getManifest().manifest_version,
      minimumChromeVersion: chrome.runtime.getManifest().minimum_chrome_version,
      duplicateIds: [...document.querySelectorAll("[id]")]
        .map((element) => element.id)
        .filter((id, index, all) => all.indexOf(id) !== index),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      visibleToggleIcons: [...document.querySelectorAll("#toggleButton .icon")]
        .filter((icon) => getComputedStyle(icon).display !== "none").length,
      visibleThemeIcons: [...document.querySelectorAll("#themeButton .icon")]
        .filter((icon) => getComputedStyle(icon).display !== "none").length
    };
  });

  if (!runtime.singleThreadRuntime) {
    throw new Error(`Unexpected threaded WASM runtime: ${JSON.stringify(runtime)}`);
  }
  if (runtime.manifestVersion !== 3 || runtime.minimumChromeVersion !== "116") {
    throw new Error(`Unexpected manifest receipt: ${JSON.stringify(runtime)}`);
  }
  if (runtime.duplicateIds.length || runtime.horizontalOverflow) {
    throw new Error(`Popup structure failed: ${JSON.stringify(runtime)}`);
  }
  if (runtime.visibleToggleIcons !== 1 || runtime.visibleThemeIcons !== 1) {
    throw new Error(`Icon pairs must show exactly one glyph: ${JSON.stringify(runtime)}`);
  }

  await popup.screenshot({ path: resolve(artifacts, "popup-light.png"), fullPage: true });
  console.log("browser: light popup captured");
  await popup.evaluate(() => document.querySelector("#themeButton").click());
  await popup.waitForFunction(() => document.documentElement.classList.contains("theme-dark"));
  await popup.bringToFront();
  await popup.waitForFunction(
    () => getComputedStyle(document.querySelector(".canvas")).backgroundColor === "rgb(17, 17, 19)"
  );
  await popup.screenshot({ path: resolve(artifacts, "popup-dark.png"), fullPage: true });
  console.log("browser: dark popup captured");
  await popup.evaluate((tabId) => chrome.tabs.update(tabId, { active: true }), videoTabId);

  await worker.evaluate(
    ({ tabId }) => chrome.tabs.sendMessage(tabId, {
      type: "CAPTION_UPDATE",
      text: "It was the best of times, it was the worst of times.",
      final: true,
      lineId: "browser-smoke"
    }, { frameId: 0 }),
    { tabId: videoTabId }
  );
  await videoPage.waitForFunction(() => {
    const host = document.querySelector("[data-local-subtitles-root]");
    return host?.shadowRoot?.querySelector(".caption")?.textContent.includes("best of times");
  });
  console.log("browser: subtitle overlay received text");

  await worker.evaluate(
    ({ tabId }) => chrome.tabs.sendMessage(tabId, {
      type: "CAPTION_UPDATE",
      text: "It was the age of wisdom.",
      final: true,
      lineId: "browser-smoke-2"
    }, { frameId: 0 }),
    { tabId: videoTabId }
  );
  await videoPage.waitForFunction(() => {
    const shadow = document.querySelector("[data-local-subtitles-root]")?.shadowRoot;
    return shadow?.querySelector(".cap-prev")?.textContent.includes("best of times") &&
      shadow?.querySelector(".cap-now")?.textContent.includes("age of wisdom");
  });
  console.log("browser: finished line rolled up while the next line rendered");
  const overlay = await videoPage.evaluate(() => {
    const video = document.querySelector("video").getBoundingClientRect();
    const host = document.querySelector("[data-local-subtitles-root]");
    const bounds = host.getBoundingClientRect();
    const caption = host.shadowRoot.querySelector(".caption");
    return {
      text: caption.textContent,
      visible: caption.classList.contains("is-visible"),
      hostMatchesVideo:
        Math.abs(bounds.left - video.left) < 2 &&
        Math.abs(bounds.top - video.top) < 2 &&
        Math.abs(bounds.width - video.width) < 2 &&
        Math.abs(bounds.height - video.height) < 2
    };
  });
  if (!overlay.visible || !overlay.hostMatchesVideo) {
    throw new Error(`Subtitle overlay failed: ${JSON.stringify(overlay)}`);
  }
  await videoPage.screenshot({ path: resolve(artifacts, "video-overlay.png"), fullPage: true });

  await popup.evaluate(() => document.querySelector('#sizeControl button[data-value="large"]').click());
  await videoPage.waitForFunction(() => {
    const host = document.querySelector("[data-local-subtitles-root]");
    return host?.shadowRoot?.querySelector(".shell")?.dataset.size === "large";
  });
  console.log("browser: large caption setting reached the overlay");

  await popup.evaluate(() => document.querySelector('#modelControl button[data-value="small"]').click());
  await popup.waitForFunction(() =>
    document.querySelector("#modelHint")?.textContent.includes("165 MB") &&
    document.querySelector("#headMeta")?.textContent === "Moonshine Small · English"
  );
  await popup.evaluate(() => document.querySelector('#modelControl button[data-value="tiny"]').click());
  await popup.waitForFunction(() =>
    document.querySelector("#headMeta")?.textContent === "Moonshine Tiny · English"
  );
  console.log("browser: model choice updates the hint and header");

  await popup.setViewport({ width: 320, height: 680 });
  const narrow = await popup.evaluate(() => ({
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    toggleHeight: document.querySelector("#toggleButton").getBoundingClientRect().height
  }));
  if (narrow.horizontalOverflow || narrow.toggleHeight < 42) {
    throw new Error(`Narrow popup failed: ${JSON.stringify(narrow)}`);
  }
  await popup.screenshot({ path: resolve(artifacts, "popup-narrow.png"), fullPage: true });
  console.log("browser: narrow popup captured");

  const useHttpRuntime = process.env.MOONSHINE_HTTP_RUNTIME === "1";
  const enginePage = useHttpRuntime ? videoPage : popup;
  const runtimeBaseUrl = useHttpRuntime
    ? new URL("/vendor/moonshine/", fixtureUrl).href
    : `chrome-extension://${extensionId}/vendor/moonshine/`;
  const engine = process.env.MOONSHINE_MODULE_ONLY === "1"
    ? await runModuleCheck(enginePage, runtimeBaseUrl)
    : await runEngineCheck(enginePage, runtimeBaseUrl);
  console.log(`browser: engine ${engine.skipped ? "skipped" : "completed"}`);
  if (!engine.skipped && (!engine.containsBestOfTimes || !engine.containsWorstOfTimes)) {
    throw new Error(`Moonshine transcript missed the maintained phrases: ${engine.text}`);
  }
  if (!engine.skipped && (!engine.singleThreadRuntime || engine.completedLines < 1)) {
    throw new Error(`Moonshine worker did not return a completed line: ${JSON.stringify(engine)}`);
  }
  if (!engine.skipped && (engine.inferencePasses < 1 || !(engine.maxPassMs > 0))) {
    throw new Error(`Moonshine inference timing is missing: ${JSON.stringify(engine)}`);
  }
  if (!engine.skipped && (engine.cachedFiles < 7 || engine.cachedBytes < 50_000_000)) {
    throw new Error(`Moonshine model cache is incomplete: ${JSON.stringify(engine)}`);
  }

  let capture = { skipped: "TAB_CAPTURE_CHECK was not set" };
  if (process.env.TAB_CAPTURE_CHECK === "1") {
    if (!wavFixturePath) throw new Error("TAB_CAPTURE_CHECK requires MOONSHINE_WAV_FIXTURE.");
    await popup.evaluate((tabId) =>
      chrome.tabs.sendMessage(tabId, { type: "CAPTION_CLEAR" }, { frameId: 0 }),
    videoTabId);
    await videoPage.waitForFunction(() => {
      const host = document.querySelector("[data-local-subtitles-root]");
      return !host?.shadowRoot?.querySelector(".caption")?.classList.contains("is-visible");
    });
    await videoPage.waitForFunction(() => document.querySelector("video")?.readyState >= 2);
    await videoPage.evaluate(async () => {
      const video = document.querySelector("video");
      video.currentTime = 0;
      await video.play();
    });

    await popup.close();
    await videoPage.bringToFront();
    await installedExtension.triggerAction(videoPage);

    const popupDeadline = Date.now() + 10_000;
    let actionPopup;
    while (!actionPopup && Date.now() < popupDeadline) {
      actionPopup = (await installedExtension.pages()).find(
        (page) => page.url() === `chrome-extension://${extensionId}/popup.html`
      );
      if (!actionPopup) await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    if (!actionPopup) throw new Error("The toolbar action did not open its popup.");
    actionPopup.setDefaultTimeout(180_000);
    watchPage(actionPopup, "action popup");
    await actionPopup.waitForSelector("#toggleButton");
    await actionPopup.evaluate(() => {
      globalThis.__subtitleStateChanges = 0;
      chrome.storage.onChanged.addListener((changes, area) => {
        if ((area === "session" || area === "local") && changes.runtimeState) {
          globalThis.__subtitleStateChanges += 1;
        }
      });
    });
    await actionPopup.click("#toggleButton");
    await actionPopup.waitForFunction(
      () => document.querySelector("#primaryStatus")?.textContent === "Subtitles are live"
    );

    await videoPage.waitForFunction(() => {
      const host = document.querySelector("[data-local-subtitles-root]");
      const caption = host?.shadowRoot?.querySelector(".caption");
      return caption?.classList.contains("is-visible") &&
        caption.textContent.toLowerCase().includes("best of times");
    }, { timeout: 120_000 });
    const live = await videoPage.evaluate(() => {
      const shadow = document.querySelector("[data-local-subtitles-root]")?.shadowRoot;
      return {
        text: shadow?.querySelector(".caption")?.textContent.trim() ?? "",
        statusPillVisible: Boolean(shadow?.querySelector(".status")?.classList.contains("is-visible")),
        videoTime: document.querySelector("video")?.currentTime ?? 0
      };
    });
    if (live.statusPillVisible) {
      throw new Error("The overlay status pill must stay hidden while captions are flowing.");
    }
    const state = await actionPopup.evaluate(() => ({
      status: document.querySelector("#primaryStatus")?.textContent ?? "",
      button: document.querySelector("#toggleButton span")?.textContent ?? "",
      stateChanges: globalThis.__subtitleStateChanges ?? 0
    }));
    capture = { skipped: false, ...live, ...state };
    await videoPage.screenshot({ path: resolve(artifacts, "video-live-capture.png"), fullPage: true });
    await actionPopup.click("#toggleButton");
    await actionPopup.waitForFunction(
      () => document.querySelector("#primaryStatus")?.textContent === "Ready for a video"
    );
    capture.stopped = true;
    await actionPopup.close();
    console.log(`browser: tab capture completed with "${live.text}"`);
  }

  if (browserErrors.length) {
    throw new Error(`Browser console errors:\n${browserErrors.join("\n")}`);
  }

  const receipt = {
    extensionId,
    runtime,
    overlay,
    narrow,
    engineRuntime: useHttpRuntime ? "http fixture" : "extension page",
    engine,
    capture,
    screenshots: [
      "popup-light.png",
      "popup-dark.png",
      "popup-narrow.png",
      "video-overlay.png",
      ...(!capture.skipped ? ["video-live-capture.png"] : [])
    ]
  };
  await writeFile(resolve(artifacts, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  await browser?.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
