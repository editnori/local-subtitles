import {
  DEFAULT_SETTINGS,
  IDLE_STATE,
  normalizeSettings,
  normalizeState,
  phaseLabel,
  phaseTone
} from "./shared.js";

const STATE_KEY = "runtimeState";
const SETTINGS_KEY = "settings";
const ACTIVE_PHASES = new Set([
  "starting",
  "capturing",
  "downloading",
  "warming",
  "listening",
  "stopping"
]);

const elements = {
  stateChip: document.getElementById("stateChip"),
  primaryStatus: document.getElementById("primaryStatus"),
  statusDetail: document.getElementById("statusDetail"),
  signal: document.getElementById("signal"),
  download: document.getElementById("download"),
  downloadBar: document.getElementById("downloadBar"),
  downloadLabel: document.getElementById("downloadLabel"),
  error: document.getElementById("errorMessage"),
  toggle: document.getElementById("toggleButton"),
  videoFact: document.getElementById("videoFact"),
  size: document.getElementById("sizeControl"),
  position: document.getElementById("positionControl"),
  opacity: document.getElementById("opacityControl"),
  opacityValue: document.getElementById("opacityValue"),
  partial: document.getElementById("partialControl"),
  theme: document.getElementById("themeButton"),
  moonIcon: document.querySelector(".moon-icon"),
  sunIcon: document.querySelector(".sun-icon"),
  engineDetail: document.getElementById("engineDetail")
};

const hasExtensionApi = Boolean(globalThis.chrome?.runtime?.id);
const stateStore = hasExtensionApi ? chrome.storage.session ?? chrome.storage.local : null;

let state = normalizeState(IDLE_STATE);
let settings = normalizeSettings(DEFAULT_SETTINGS);
let activeTab = null;
let actionPending = false;
let settingsWriteTimer;

function applyTheme() {
  const dark =
    settings.theme === "dark" ||
    (settings.theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.className = dark ? "theme-dark" : "theme-light";
  elements.moonIcon.hidden = dark;
  elements.sunIcon.hidden = !dark;
  elements.theme.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
}

function setPressed(group, value) {
  for (const button of group.querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.value === value));
  }
}

function activeOnCurrentTab() {
  return state.tabId !== null && state.tabId === activeTab?.id && ACTIVE_PHASES.has(state.phase);
}

function detailText() {
  if (state.phase === "idle") {
    return state.videoDetected
      ? "The largest video is ready. Audio will stay on this device."
      : "Start a video in this tab, then turn subtitles on.";
  }
  if (state.phase === "downloading") {
    return "Subtitles begin at Listening. The model is saved for later runs.";
  }
  if (state.phase === "warming") {
    return "The local engine is opening the cached model.";
  }
  if (state.phase === "listening") {
    return state.videoDetected
      ? "Subtitles will follow the largest playing video."
      : "Listening to tab audio; subtitles will use the bottom of the page.";
  }
  if (state.phase === "error") return "The tab audio session did not start.";
  return "Keep this video playing while the local engine gets ready.";
}

function render() {
  const chipText = elements.stateChip.querySelector("span");
  chipText.textContent = phaseLabel(state.phase);
  elements.stateChip.dataset.tone = phaseTone(state.phase);

  elements.primaryStatus.textContent = state.message || "Ready for a video";
  elements.statusDetail.textContent = detailText();
  elements.signal.classList.toggle("is-live", state.phase === "listening");

  const showProgress = state.phase === "downloading";
  elements.download.hidden = !showProgress;
  if (showProgress) {
    elements.downloadBar.style.width = `${Math.round((state.progress ?? 0) * 100)}%`;
    const file = state.progressFile ? state.progressFile.split("/").at(-1) : "model files";
    elements.downloadLabel.textContent = state.progress === null
      ? `Downloading ${file}`
      : `${Math.round(state.progress * 100)}% · ${file}`;
  }

  elements.error.hidden = !state.error;
  elements.error.textContent = state.error;

  const current = activeOnCurrentTab();
  const anyActive = state.tabId !== null && ACTIVE_PHASES.has(state.phase);
  const shouldStop = current || (anyActive && state.phase !== "stopping");
  elements.toggle.classList.toggle("is-stop", shouldStop);
  elements.toggle.querySelector(".play-icon").hidden = shouldStop;
  elements.toggle.querySelector(".stop-icon").hidden = !shouldStop;
  elements.toggle.querySelector("span").textContent = shouldStop
    ? "Stop subtitles"
    : anyActive
      ? "Use this tab"
      : state.phase === "error"
        ? "Try again"
        : "Start subtitles";
  elements.toggle.disabled = actionPending || state.phase === "stopping";

  const factDot = elements.videoFact.querySelector("i");
  const factText = elements.videoFact.querySelector("b");
  factDot.classList.toggle("live", state.videoDetected);
  factText.textContent = state.videoDetected ? "Video found" : "No video yet";

  setPressed(elements.size, settings.captionSize);
  setPressed(elements.position, settings.captionPosition);
  elements.opacity.value = String(settings.backgroundOpacity);
  elements.opacityValue.value = `${settings.backgroundOpacity}%`;
  elements.partial.checked = settings.showPartials;
  elements.engineDetail.textContent = state.passMs
    ? `WASM SIMD · ${Math.round(state.passMs)} ms pass`
    : "WASM SIMD · local CPU";
  applyTheme();
}

async function saveSettings(patch, defer = false) {
  settings = normalizeSettings({ ...settings, ...patch });
  render();
  if (!hasExtensionApi) return;
  clearTimeout(settingsWriteTimer);
  if (defer) {
    settingsWriteTimer = setTimeout(() => {
      void chrome.storage.local.set({ [SETTINGS_KEY]: settings });
    }, 100);
    return;
  }
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

function bindSegmented(group, key) {
  group.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-value]");
    if (!button) return;
    void saveSettings({ [key]: button.dataset.value });
  });
}

async function startCapture() {
  if (!activeTab?.id) throw new Error("No active tab was found.");
  if (!chrome.tabCapture?.getMediaStreamId || !chrome.offscreen) {
    throw new Error("This browser is missing the tab audio or offscreen extension API.");
  }
  if (!/^(https?|file):/i.test(activeTab.url ?? "")) {
    throw new Error("Chrome does not allow extensions to subtitle this browser page.");
  }

  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: activeTab.id });
  const response = await chrome.runtime.sendMessage({
    type: "START_CAPTURE",
    tabId: activeTab.id,
    tabTitle: activeTab.title ?? "Current tab",
    streamId
  });
  if (!response?.ok) throw new Error(response?.error || "The subtitle session did not start.");
}

async function toggleCapture() {
  if (!hasExtensionApi || actionPending) return;
  actionPending = true;
  render();
  try {
    if (state.tabId !== null && ACTIVE_PHASES.has(state.phase)) {
      const response = await chrome.runtime.sendMessage({ type: "STOP_CAPTURE" });
      if (!response?.ok) throw new Error(response?.error || "Subtitles did not stop.");
    } else {
      await startCapture();
    }
  } catch (error) {
    state = normalizeState({
      ...state,
      phase: "error",
      message: "Could not start local subtitles",
      error: error instanceof Error ? error.message : String(error)
    });
  } finally {
    actionPending = false;
    render();
  }
}

async function loadInitialState() {
  if (!hasExtensionApi) {
    state = normalizeState({
      ...IDLE_STATE,
      videoDetected: true,
      message: "Ready for a video"
    });
    render();
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab ?? null;
  const [stateResponse, stored] = await Promise.all([
    chrome.runtime.sendMessage({ type: "GET_STATE", tabId: activeTab?.id }),
    chrome.storage.local.get(SETTINGS_KEY)
  ]);
  state = normalizeState(stateResponse?.state ?? IDLE_STATE);
  settings = normalizeSettings(stored[SETTINGS_KEY] ?? DEFAULT_SETTINGS);
  render();
}

bindSegmented(elements.size, "captionSize");
bindSegmented(elements.position, "captionPosition");

elements.opacity.addEventListener("input", () => {
  elements.opacityValue.value = `${elements.opacity.value}%`;
  void saveSettings({ backgroundOpacity: Number(elements.opacity.value) }, true);
});
elements.opacity.addEventListener("change", () => {
  void saveSettings({ backgroundOpacity: Number(elements.opacity.value) });
});
elements.partial.addEventListener("change", () => {
  void saveSettings({ showPartials: elements.partial.checked });
});
elements.theme.addEventListener("click", () => {
  const resolvedDark = document.documentElement.classList.contains("theme-dark");
  void saveSettings({ theme: resolvedDark ? "light" : "dark" });
});
elements.toggle.addEventListener("click", toggleCapture);

matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (settings.theme === "system") applyTheme();
});

if (hasExtensionApi) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if ((area === "session" || area === "local") && changes[STATE_KEY]) {
      state = normalizeState(changes[STATE_KEY].newValue);
      render();
    }
    if (area === "local" && changes[SETTINGS_KEY]) {
      settings = normalizeSettings(changes[SETTINGS_KEY].newValue);
      render();
    }
  });
}

void loadInitialState().catch((error) => {
  state = normalizeState({
    ...IDLE_STATE,
    phase: "error",
    message: "Could not read the extension state",
    error: error instanceof Error ? error.message : String(error)
  });
  render();
});
