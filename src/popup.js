import {
  DEFAULT_SETTINGS,
  IDLE_STATE,
  normalizeSettings,
  normalizeState,
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
  card: document.getElementById("listenCard"),
  primaryStatus: document.getElementById("primaryStatus"),
  statusDetail: document.getElementById("statusDetail"),
  download: document.getElementById("download"),
  downloadTrack: document.getElementById("downloadTrack"),
  downloadBar: document.getElementById("downloadBar"),
  downloadLabel: document.getElementById("downloadLabel"),
  error: document.getElementById("errorMessage"),
  toggle: document.getElementById("toggleButton"),
  size: document.getElementById("sizeControl"),
  position: document.getElementById("positionControl"),
  opacity: document.getElementById("opacityControl"),
  opacityValue: document.getElementById("opacityValue"),
  partial: document.getElementById("partialControl"),
  theme: document.getElementById("themeButton")
};

const hasExtensionApi = Boolean(globalThis.chrome?.runtime?.id);

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
      ? "The largest video is ready. Audio stays on this device."
      : "Start a video in this tab, then turn subtitles on.";
  }
  if (state.phase === "downloading") {
    return "One-time download. Subtitles start as soon as it finishes.";
  }
  if (state.phase === "warming") {
    return "Almost ready. Audio stays on this device.";
  }
  if (state.phase === "listening") {
    return state.videoDetected
      ? "Subtitles follow the largest playing video."
      : "No video found yet, so subtitles will use the bottom of the page.";
  }
  if (state.phase === "error") return "Try again once the video is playing.";
  return "Keep the video playing while the local engine gets ready.";
}

function render() {
  const anyActive = state.tabId !== null && ACTIVE_PHASES.has(state.phase);
  const elsewhere = anyActive && !activeOnCurrentTab();

  elements.card.dataset.tone = phaseTone(state.phase);
  elements.primaryStatus.textContent = elsewhere
    ? "Subtitles are on in another tab"
    : state.message || "Ready for a video";
  elements.statusDetail.textContent = elsewhere
    ? (state.tabTitle
        ? `They are following “${state.tabTitle}”.`
        : "Stop them to start subtitles here.")
    : detailText();

  const showProgress = state.phase === "downloading";
  elements.download.hidden = !showProgress;
  if (showProgress) {
    const percent = state.progress === null ? null : Math.round(state.progress * 100);
    elements.downloadBar.style.width = `${percent ?? 0}%`;
    elements.downloadLabel.textContent = percent === null ? "Starting" : `${percent}%`;
    if (percent === null) {
      elements.downloadTrack.removeAttribute("aria-valuenow");
    } else {
      elements.downloadTrack.setAttribute("aria-valuenow", String(percent));
    }
  }

  elements.error.hidden = !state.error;
  elements.error.textContent = state.error;

  elements.toggle.classList.toggle("is-stop", anyActive);
  elements.toggle.querySelector("span").textContent = anyActive
    ? state.phase === "stopping"
      ? "Stopping"
      : "Stop subtitles"
    : state.phase === "error"
      ? "Try again"
      : "Start subtitles";
  elements.toggle.disabled = actionPending || state.phase === "stopping";

  setPressed(elements.size, settings.captionSize);
  setPressed(elements.position, settings.captionPosition);
  elements.opacity.value = String(settings.backgroundOpacity);
  elements.opacityValue.value = `${settings.backgroundOpacity}%`;
  elements.partial.checked = settings.showPartials;
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
