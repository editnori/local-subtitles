import {
  DEFAULT_SETTINGS,
  IDLE_STATE,
  normalizeSettings,
  normalizeState,
  selectCaptionFrame
} from "./shared.js";

const STATE_KEY = "runtimeState";
const SETTINGS_KEY = "settings";
const OFFSCREEN_PATH = "offscreen.html";

const frameCandidates = new Map();
const lastCaptionFrame = new Map();
const stateStore = chrome.storage.session ?? chrome.storage.local;

let runtimeState = normalizeState(IDLE_STATE);
let stateLoaded;
let creatingOffscreen;
let operationChain = Promise.resolve();

function queueOperation(operation) {
  const next = operationChain.then(operation, operation);
  operationChain = next.catch(() => {});
  return next;
}

async function loadState() {
  if (!stateLoaded) {
    stateLoaded = stateStore.get(STATE_KEY).then((stored) => {
      runtimeState = normalizeState(stored[STATE_KEY] ?? IDLE_STATE);
    });
  }
  await stateLoaded;
  return runtimeState;
}

async function setState(patch) {
  await loadState();
  const previousPhase = runtimeState.phase;
  runtimeState = normalizeState({
    ...runtimeState,
    ...patch,
    updatedAt: Date.now()
  });
  await stateStore.set({ [STATE_KEY]: runtimeState });
  if (runtimeState.phase !== previousPhase) await updateBadge(runtimeState.phase);
  return runtimeState;
}

async function updateBadge(phase) {
  const active = phase === "listening";
  await chrome.action.setBadgeText({ text: active ? "ON" : "" });
  if (active) {
    await chrome.action.setBadgeBackgroundColor({ color: "#4b74e2" });
    await chrome.action.setBadgeTextColor?.({ color: "#ffffff" });
  }
}

async function hasOffscreenDocument() {
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)]
    });
    return contexts.length > 0;
  }
  const controlled = await clients.matchAll();
  return controlled.some((client) => client.url === chrome.runtime.getURL(OFFSCREEN_PATH));
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: ["USER_MEDIA"],
        justification: "Capture tab audio and run the on-device subtitle model."
      })
      .finally(() => {
        creatingOffscreen = undefined;
      });
  }
  await creatingOffscreen;
}

async function closeOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    await chrome.offscreen.closeDocument();
  }
}

async function sendToOffscreen(message) {
  await ensureOffscreenDocument();
  return chrome.runtime.sendMessage({ ...message, target: "offscreen" });
}

async function beginCapture({ tabId, tabTitle, streamId }) {
  return queueOperation(async () => {
    await loadState();
    if (runtimeState.tabId !== null) {
      await stopCapture("switching tabs");
    }

    await setState({
      phase: "starting",
      tabId,
      tabTitle,
      progress: null,
      progressFile: "",
      message: "Opening this tab's audio",
      error: "",
      passMs: null,
      videoDetected: hasFreshVideo(tabId)
    });

    try {
      const response = await sendToOffscreen({
        type: "START_SESSION",
        tabId,
        streamId
      });
      if (!response?.ok) {
        throw new Error(response?.error || "The audio session did not start.");
      }
      return { ok: true };
    } catch (error) {
      await setState({
        phase: "error",
        message: "Could not start subtitles",
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  });
}

async function stopCapture(reason = "stopped") {
  await loadState();
  const tabId = runtimeState.tabId;
  if (tabId === null) {
    await closeOffscreenDocument().catch(() => {});
    return { ok: true };
  }

  await setState({ phase: "stopping", message: "Stopping subtitles" });
  try {
    if (await hasOffscreenDocument()) {
      await chrome.runtime.sendMessage({
        target: "offscreen",
        type: "STOP_SESSION",
        reason
      });
    }
  } finally {
    await clearCaptions(tabId);
    await closeOffscreenDocument().catch(() => {});
    lastCaptionFrame.delete(tabId);
    await setState({ ...IDLE_STATE, updatedAt: Date.now() });
  }
  return { ok: true };
}

function candidatesForTab(tabId) {
  const byFrame = frameCandidates.get(tabId);
  return byFrame ? [...byFrame.values()] : [];
}

function hasFreshVideo(tabId) {
  const now = Date.now();
  return candidatesForTab(tabId).some(
    (candidate) => candidate.visible && candidate.area > 0 && now - candidate.updatedAt <= 5000
  );
}

async function receiveVideoCandidate(message, sender) {
  const tabId = sender.tab?.id;
  if (!Number.isInteger(tabId)) return;
  const frameId = Number.isInteger(sender.frameId) ? sender.frameId : 0;
  const byFrame = frameCandidates.get(tabId) ?? new Map();
  const now = Date.now();
  for (const [candidateFrameId, candidate] of byFrame) {
    if (now - candidate.updatedAt > 30_000) byFrame.delete(candidateFrameId);
  }
  byFrame.set(frameId, {
    frameId,
    area: Math.max(0, Number(message.area) || 0),
    visible: Boolean(message.visible),
    playing: Boolean(message.playing),
    updatedAt: now
  });
  frameCandidates.set(tabId, byFrame);

  await loadState();
  if (runtimeState.tabId === tabId) {
    const detected = hasFreshVideo(tabId);
    if (detected !== runtimeState.videoDetected) {
      await setState({ videoDetected: detected });
    }
  }
}

async function sendToFrame(tabId, frameId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message, { frameId });
    return true;
  } catch {
    return false;
  }
}

async function dispatchCaption(message) {
  await loadState();
  const tabId = Number.isInteger(message.tabId) ? message.tabId : runtimeState.tabId;
  if (tabId === null || tabId !== runtimeState.tabId) return;

  const frameId = selectCaptionFrame(candidatesForTab(tabId));
  const previousFrame = lastCaptionFrame.get(tabId);
  if (previousFrame !== undefined && previousFrame !== frameId) {
    await sendToFrame(tabId, previousFrame, { type: "CAPTION_CLEAR" });
  }

  const delivered = await sendToFrame(tabId, frameId, {
    type: "CAPTION_UPDATE",
    text: String(message.text ?? ""),
    final: Boolean(message.final),
    lineId: String(message.lineId ?? ""),
    latencyMs: Number.isFinite(message.latencyMs) ? message.latencyMs : null
  });

  if (delivered) {
    lastCaptionFrame.set(tabId, frameId);
  } else if (frameId !== 0) {
    await sendToFrame(tabId, 0, {
      type: "CAPTION_UPDATE",
      text: String(message.text ?? ""),
      final: Boolean(message.final),
      lineId: String(message.lineId ?? ""),
      latencyMs: Number.isFinite(message.latencyMs) ? message.latencyMs : null
    });
    lastCaptionFrame.set(tabId, 0);
  }
}

async function dispatchOverlayStatus(message) {
  await loadState();
  const tabId = runtimeState.tabId;
  if (tabId === null) return;
  const frameId = selectCaptionFrame(candidatesForTab(tabId));
  const previousFrame = lastCaptionFrame.get(tabId);
  if (previousFrame !== undefined && previousFrame !== frameId) {
    await sendToFrame(tabId, previousFrame, { type: "CAPTION_CLEAR" });
  }
  const payload = {
    type: "CAPTION_STATUS",
    phase: message.phase,
    message: message.message,
    progress: message.progress
  };
  const delivered = await sendToFrame(tabId, frameId, payload);
  if (delivered) {
    lastCaptionFrame.set(tabId, frameId);
  } else if (frameId !== 0 && await sendToFrame(tabId, 0, payload)) {
    lastCaptionFrame.set(tabId, 0);
  }
}

async function clearCaptions(tabId) {
  const frameIds = new Set([0, ...candidatesForTab(tabId).map((candidate) => candidate.frameId)]);
  await Promise.all(
    [...frameIds].map((frameId) => sendToFrame(tabId, frameId, { type: "CAPTION_CLEAR" }))
  );
}

async function handleMessage(message, sender) {
  if (!message || typeof message.type !== "string") return undefined;

  switch (message.type) {
    case "GET_STATE": {
      await loadState();
      const requestedTabId = Number.isInteger(message.tabId) ? message.tabId : null;
      return {
        ok: true,
        state: requestedTabId === null
          ? runtimeState
          : { ...runtimeState, videoDetected: hasFreshVideo(requestedTabId) }
      };
    }
    case "START_CAPTURE":
      return beginCapture({
        tabId: message.tabId,
        tabTitle: String(message.tabTitle ?? ""),
        streamId: String(message.streamId ?? "")
      });
    case "STOP_CAPTURE":
      return queueOperation(() => stopCapture("user stopped"));
    case "VIDEO_CANDIDATE":
      await receiveVideoCandidate(message, sender);
      return { ok: true };
    case "OFFSCREEN_STATUS": {
      await loadState();
      if (message.tabId !== runtimeState.tabId) return { ok: false };
      await setState({
        phase: message.phase,
        message: String(message.message ?? ""),
        progress: typeof message.progress === "number" ? message.progress : null,
        progressFile: String(message.progressFile ?? ""),
        error: String(message.error ?? ""),
        passMs: typeof message.passMs === "number" ? message.passMs : runtimeState.passMs
      });
      if (["capturing", "downloading", "warming", "listening"].includes(message.phase)) {
        await dispatchOverlayStatus(message);
      }
      return { ok: true };
    }
    case "OFFSCREEN_TRANSCRIPT":
      await dispatchCaption(message);
      if (typeof message.latencyMs === "number") {
        await setState({ passMs: message.latencyMs });
      }
      return { ok: true };
    case "OFFSCREEN_ENDED": {
      await loadState();
      if (message.tabId === runtimeState.tabId) {
        await clearCaptions(message.tabId);
        await setState({ ...IDLE_STATE, message: String(message.message ?? "Ready for a video") });
      }
      return { ok: true };
    }
    default:
      return undefined;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === "offscreen") return false;
  handleMessage(message, sender)
    .then((response) => sendResponse(response))
    .catch((error) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
  return true;
});

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  await chrome.storage.local.set({
    [SETTINGS_KEY]: normalizeSettings(stored[SETTINGS_KEY] ?? DEFAULT_SETTINGS)
  });
  await stateStore.set({ [STATE_KEY]: normalizeState(IDLE_STATE) });
  runtimeState = normalizeState(IDLE_STATE);
  stateLoaded = Promise.resolve();
  await updateBadge("idle");
});

chrome.tabs.onRemoved.addListener((tabId) => {
  frameCandidates.delete(tabId);
  lastCaptionFrame.delete(tabId);
  void loadState().then(() => {
    if (runtimeState.tabId === tabId) {
      return queueOperation(() => stopCapture("tab closed"));
    }
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    frameCandidates.delete(tabId);
  }
});

chrome.tabCapture.onStatusChanged.addListener((info) => {
  if (!Number.isInteger(info.tabId) || !["stopped", "error"].includes(info.status)) return;
  void loadState().then(() => {
    if (runtimeState.tabId === info.tabId && runtimeState.phase !== "stopping") {
      return queueOperation(() => stopCapture(`tab capture ${info.status}`));
    }
  });
});

void loadState().then(() => updateBadge(runtimeState.phase));
