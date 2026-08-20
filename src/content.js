import {
  DEFAULT_SETTINGS,
  captionLifetime,
  normalizeSettings
} from "./shared.js";

const HOST_ATTRIBUTE = "data-local-subtitles-root";
const isTopFrame = window === window.top;

let settings = normalizeSettings(DEFAULT_SETTINGS);
let activeVideo = null;
let host;
let shell;
let caption;
let previousLine;
let currentLine;
let currentLineId = "";
let statusPill;
let progressBar;
let clearTimer;
let statusTimer;
let frameLoop;
let nativeFullscreenVideo = null;

const watchedVideos = new WeakSet();
const nativeTracks = new WeakMap();
let reportTimer;
let heartbeatTimer;
let reportingVideoState = false;
let reportAgain = false;

function extensionAvailable() {
  return Boolean(chrome?.runtime?.id);
}

function collectVideos(root = document, output = []) {
  if (!root?.querySelectorAll) return output;
  for (const video of root.querySelectorAll("video")) output.push(video);
  for (const element of root.querySelectorAll("*")) {
    if (element.shadowRoot) collectVideos(element.shadowRoot, output);
  }
  return output;
}

function videoCandidate(video) {
  const rect = video.getBoundingClientRect();
  const style = getComputedStyle(video);
  const visible =
    rect.width >= 120 &&
    rect.height >= 68 &&
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < innerHeight &&
    rect.left < innerWidth &&
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    Number(style.opacity || 1) > 0;
  return {
    video,
    visible,
    playing: visible && !video.paused && !video.ended && video.readyState >= 2,
    area: visible ? rect.width * rect.height : 0
  };
}

function findActiveVideo(videos = collectVideos()) {
  const candidates = videos.map(videoCandidate).filter((item) => item.visible);
  candidates.sort((a, b) => {
    if (a.playing !== b.playing) return a.playing ? -1 : 1;
    return b.area - a.area;
  });
  return candidates[0] ?? null;
}

function watchVideo(video) {
  if (watchedVideos.has(video)) return;
  watchedVideos.add(video);
  for (const event of ["play", "pause", "loadedmetadata", "emptied", "resize"]) {
    video.addEventListener(event, reportVideoState, { passive: true });
  }
  video.addEventListener("webkitbeginfullscreen", () => {
    nativeFullscreenVideo = video;
    syncNativeCaption();
    positionOverlay();
  });
  video.addEventListener("webkitendfullscreen", () => {
    if (nativeFullscreenVideo === video) nativeFullscreenVideo = null;
    setNativeTrackMode(video, "hidden");
    positionOverlay();
  });
}

async function reportVideoState() {
  if (reportingVideoState) {
    reportAgain = true;
    return;
  }
  reportingVideoState = true;
  let hasVideos = false;
  try {
    if (!extensionAvailable()) return;
    const videos = collectVideos();
    hasVideos = videos.length > 0;
    videos.forEach(watchVideo);
    const best = findActiveVideo(videos);
    activeVideo = best?.video ?? null;
    await chrome.runtime.sendMessage({
      type: "VIDEO_CANDIDATE",
      visible: Boolean(best),
      playing: Boolean(best?.playing),
      area: best?.area ?? 0
    });
  } catch {
    // Reloading or removing the extension invalidates the content-script context.
  } finally {
    reportingVideoState = false;
    clearTimeout(heartbeatTimer);
    if (hasVideos) {
      heartbeatTimer = setTimeout(reportVideoState, document.hidden ? 7000 : 3200);
    }
    if (reportAgain) {
      reportAgain = false;
      scheduleVideoReport();
    }
  }
}

function scheduleVideoReport() {
  clearTimeout(reportTimer);
  reportTimer = setTimeout(reportVideoState, 180);
}

function ensureOverlay() {
  if (host?.isConnected) return;
  host = document.createElement("div");
  host.setAttribute(HOST_ATTRIBUTE, "");
  host.style.cssText = [
    "position:fixed",
    "left:0",
    "top:0",
    "width:100vw",
    "height:100vh",
    "z-index:2147483647",
    "pointer-events:none",
    "display:none",
    "contain:layout style"
  ].join(";");

  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .shell {
      --caption-bg: 0.76;
      position: absolute;
      inset: 0;
      display: flex;
      justify-content: center;
      align-items: flex-end;
      padding: 0 clamp(14px, 4vw, 48px) max(calc(env(safe-area-inset-bottom, 0px) + 5%), 34px);
      color: #fff;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      text-align: center;
      text-rendering: optimizeLegibility;
      transition: padding-bottom 200ms cubic-bezier(.22, 1, .36, 1);
    }
    .shell[data-position="raised"] {
      padding-bottom: max(calc(env(safe-area-inset-bottom, 0px) + 20%), 92px);
    }
    .stack {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 9px;
      width: min(920px, 92%);
    }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      max-width: min(86vw, 520px);
      min-height: 30px;
      padding: 6px 11px;
      border-radius: 999px;
      color: rgb(247 247 245 / .92);
      background: rgb(18 18 20 / .78);
      box-shadow: 0 8px 26px rgb(0 0 0 / .22);
      backdrop-filter: blur(14px) saturate(1.15);
      -webkit-backdrop-filter: blur(14px) saturate(1.15);
      font-size: clamp(11px, 1.4vw, 13px);
      font-weight: 600;
      line-height: 1.25;
      opacity: 0;
      transform: translateY(6px) scale(.98);
      transition: opacity 160ms ease, transform 200ms cubic-bezier(.22, 1, .36, 1);
    }
    .status.is-visible { opacity: 1; transform: none; }
    .dot {
      width: 7px;
      height: 7px;
      flex: none;
      border-radius: 999px;
      background: #d2a500;
      box-shadow: 0 0 0 3px rgb(210 165 0 / .16);
    }
    .status[data-phase="listening"] .dot { background: #43d97f; box-shadow: 0 0 0 3px rgb(67 217 127 / .16); }
    .status[data-phase="error"] .dot { background: #ff9a78; box-shadow: 0 0 0 3px rgb(255 154 120 / .16); }
    .progress {
      width: 44px;
      height: 3px;
      overflow: hidden;
      border-radius: 999px;
      background: rgb(255 255 255 / .16);
    }
    .progress > i {
      display: block;
      width: 0;
      height: 100%;
      border-radius: inherit;
      background: #87a3ff;
      transition: width 160ms ease;
    }
    .caption {
      display: flex;
      flex-direction: column;
      justify-content: flex-end;
      max-width: 100%;
      max-height: calc(3 * 1.32em + .73em);
      overflow: hidden;
      padding: .33em .62em .4em;
      border-radius: 12px;
      color: white;
      background: rgb(10 10 12 / var(--caption-bg));
      box-shadow: 0 8px 30px rgb(0 0 0 / .24);
      backdrop-filter: blur(7px) saturate(1.1);
      -webkit-backdrop-filter: blur(7px) saturate(1.1);
      font-size: clamp(18px, 3.1vw, 34px);
      font-weight: 600;
      line-height: 1.32;
      letter-spacing: -.018em;
      text-shadow: 0 1px 2px rgb(0 0 0 / .5);
      opacity: 0;
      transform: translateY(8px) scale(.985);
      transition: opacity 140ms ease, transform 200ms cubic-bezier(.22, 1, .36, 1);
    }
    .caption.is-visible { opacity: 1; transform: none; }
    .caption div { flex: none; text-wrap: balance; }
    .cap-prev:empty { display: none; }
    .cap-now.is-partial { color: rgb(255 255 255 / .82); }
    .shell[data-size="small"] .caption { font-size: clamp(15px, 2.5vw, 26px); }
    .shell[data-size="large"] .caption { font-size: clamp(22px, 3.8vw, 42px); }
    @media (max-width: 520px) {
      .shell { padding-inline: 12px; }
      .stack { width: 96%; gap: 7px; }
      .caption { border-radius: 10px; line-height: 1.28; }
    }
    @media (prefers-reduced-motion: reduce) {
      .shell, .status, .caption, .progress > i { transition: none !important; }
    }
  `;

  shell = document.createElement("div");
  shell.className = "shell";
  const stack = document.createElement("div");
  stack.className = "stack";

  statusPill = document.createElement("div");
  statusPill.className = "status";
  statusPill.setAttribute("role", "status");
  const dot = document.createElement("span");
  dot.className = "dot";
  const statusText = document.createElement("span");
  statusText.className = "status-text";
  progressBar = document.createElement("span");
  progressBar.className = "progress";
  progressBar.hidden = true;
  progressBar.append(document.createElement("i"));
  statusPill.append(dot, statusText, progressBar);

  caption = document.createElement("div");
  caption.className = "caption";
  caption.setAttribute("role", "status");
  caption.setAttribute("aria-live", "polite");
  caption.setAttribute("aria-atomic", "true");
  previousLine = document.createElement("div");
  previousLine.className = "cap-prev";
  currentLine = document.createElement("div");
  currentLine.className = "cap-now";
  caption.append(previousLine, currentLine);

  stack.append(statusPill, caption);
  shell.append(stack);
  shadow.append(style, shell);
  document.documentElement.append(host);
  applySettings();
}

function applySettings() {
  if (!shell) return;
  shell.dataset.size = settings.captionSize;
  shell.dataset.position = settings.captionPosition;
  shell.style.setProperty("--caption-bg", String(settings.backgroundOpacity / 100));
}

function shouldUseNativeTrack() {
  return Boolean(
    activeVideo &&
      (nativeFullscreenVideo === activeVideo || document.fullscreenElement === activeVideo)
  );
}

function ensureNativeTrack(video) {
  let record = nativeTracks.get(video);
  if (record) return record;
  const track = video.addTextTrack("captions", "Local Subtitles", "en");
  track.mode = "hidden";
  record = { track, cue: null, text: "" };
  nativeTracks.set(video, record);
  return record;
}

function setNativeTrackMode(video, mode) {
  const record = nativeTracks.get(video);
  if (record) record.track.mode = mode;
}

function overlayText() {
  return [previousLine?.textContent, currentLine?.textContent]
    .filter(Boolean)
    .join("\n");
}

function syncNativeCaption(text = overlayText()) {
  if (!activeVideo || !shouldUseNativeTrack()) return;
  const Cue = globalThis.VTTCue;
  if (!Cue) return;
  const record = ensureNativeTrack(activeVideo);
  record.track.mode = "showing";
  if (record.cue) {
    try {
      record.track.removeCue(record.cue);
    } catch {
      // The browser can remove expired cues itself.
    }
  }
  if (!text) {
    record.cue = null;
    return;
  }
  const currentTime = Number.isFinite(activeVideo.currentTime) ? activeVideo.currentTime : 0;
  record.cue = new Cue(Math.max(0, currentTime - 0.1), currentTime + 8, text);
  record.cue.align = "center";
  record.cue.line = -3;
  record.track.addCue(record.cue);
  record.text = text;
}

function mountOverlayForFullscreen() {
  if (!host) return;
  const fullscreen = document.fullscreenElement;
  const canContainOverlay = fullscreen && fullscreen !== activeVideo && fullscreen.tagName !== "IFRAME";
  const target = canContainOverlay ? fullscreen : document.documentElement;
  if (host.parentNode !== target) target.append(host);
}

function positionOverlay() {
  if (!host) return;
  mountOverlayForFullscreen();

  if (shouldUseNativeTrack()) {
    host.style.display = "none";
    syncNativeCaption();
    return;
  }

  if (activeVideo?.isConnected) {
    const rect = activeVideo.getBoundingClientRect();
    host.style.left = `${Math.max(0, rect.left)}px`;
    host.style.top = `${Math.max(0, rect.top)}px`;
    host.style.width = `${Math.max(1, Math.min(innerWidth, rect.right) - Math.max(0, rect.left))}px`;
    host.style.height = `${Math.max(1, Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top))}px`;
  } else if (isTopFrame) {
    host.style.left = "0";
    host.style.top = "0";
    host.style.width = "100vw";
    host.style.height = "100vh";
  } else {
    host.style.display = "none";
    return;
  }

  const visible = caption?.classList.contains("is-visible") || statusPill?.classList.contains("is-visible");
  host.style.display = visible ? "block" : "none";
}

function keepOverlayAligned() {
  if (frameLoop) return;
  const tick = () => {
    frameLoop = undefined;
    positionOverlay();
    if (host?.style.display !== "none" || shouldUseNativeTrack()) {
      frameLoop = requestAnimationFrame(tick);
    }
  };
  frameLoop = requestAnimationFrame(tick);
}

function showStatus(message) {
  ensureOverlay();
  const text = statusPill.querySelector(".status-text");
  text.textContent = String(message.message || "Preparing subtitles");
  statusPill.dataset.phase = String(message.phase || "starting");
  const progress = typeof message.progress === "number" ? message.progress : null;
  progressBar.hidden = progress === null;
  if (progress !== null) progressBar.firstElementChild.style.width = `${Math.round(progress * 100)}%`;
  statusPill.classList.add("is-visible");
  clearTimeout(statusTimer);
  if (message.phase === "listening") {
    statusTimer = setTimeout(() => {
      statusPill.classList.remove("is-visible");
      positionOverlay();
    }, 1800);
  }
  positionOverlay();
  keepOverlayAligned();
}

function showCaption(message) {
  const text = String(message.text ?? "").trim();
  if (!text || (!message.final && !settings.showPartials)) return;
  ensureOverlay();
  clearTimeout(clearTimer);
  clearTimeout(statusTimer);
  statusPill.classList.remove("is-visible");

  // A new line id rolls the finished line up one slot so it stays readable
  // while the next line forms below it.
  const lineId = String(message.lineId ?? "");
  if (lineId !== currentLineId) {
    previousLine.textContent = currentLine.textContent;
    currentLineId = lineId;
  }
  currentLine.textContent = text;
  currentLine.classList.toggle("is-partial", !message.final);
  caption.classList.add("is-visible");
  syncNativeCaption();
  positionOverlay();
  keepOverlayAligned();

  clearTimer = setTimeout(() => clearCaption(), captionLifetime(text, Boolean(message.final)));
}

function clearCaption() {
  clearTimeout(clearTimer);
  clearTimeout(statusTimer);
  if (caption) {
    caption.classList.remove("is-visible");
    previousLine.textContent = "";
    currentLine.textContent = "";
    currentLineId = "";
  }
  if (statusPill) statusPill.classList.remove("is-visible");
  for (const video of collectVideos()) setNativeTrackMode(video, "hidden");
  setTimeout(positionOverlay, 220);
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "CAPTION_UPDATE") showCaption(message);
  if (message?.type === "CAPTION_STATUS") showStatus(message);
  if (message?.type === "CAPTION_CLEAR") clearCaption();
});

chrome.storage.local.get("settings").then((stored) => {
  settings = normalizeSettings(stored.settings ?? DEFAULT_SETTINGS);
  applySettings();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.settings) return;
  settings = normalizeSettings(changes.settings.newValue);
  applySettings();
});

document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement && activeVideo) setNativeTrackMode(activeVideo, "hidden");
  positionOverlay();
});
document.addEventListener("visibilitychange", scheduleVideoReport);
window.addEventListener("resize", positionOverlay, { passive: true });
window.addEventListener("scroll", positionOverlay, { passive: true, capture: true });

const observer = new MutationObserver(scheduleVideoReport);
observer.observe(document.documentElement, { childList: true, subtree: true });

void reportVideoState();
