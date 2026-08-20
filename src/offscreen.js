import { ModelArch } from "./vendor/moonshine/enums.js";
import { SttWorkerHost } from "./vendor/moonshine/stt-worker-host.js";
import {
  CATCH_UP_MESSAGE,
  DEFAULT_SETTINGS,
  LIVE_MESSAGE,
  catchUpTransition,
  normalizeSettings,
  shouldPublishProgress
} from "./shared.js";

const TRANSCRIBER_ID = "local-subtitles-model";
const STREAM_ID = "active-tab-audio";
const MODEL_ARCHS = {
  tiny: ModelArch.TinyStreaming,
  small: ModelArch.SmallStreaming,
  medium: ModelArch.MediumStreaming
};

let activeTabId = null;
let mediaStream;
let audioContext;
let sourceNode;
let captureNode;
let workerHost;
let acceptingAudio = false;
let stopping = false;
let lastProgressNotice = 0;
let lastProgressPercent = -1;
let lastProgressFile = "";
const lastTextByLine = new Map();

async function notify(message) {
  try {
    await chrome.runtime.sendMessage(message);
  } catch {
    // The service worker can restart between progress events. The next event
    // rehydrates it from chrome.storage.session.
  }
}

function status(phase, message, patch = {}) {
  return notify({
    type: "OFFSCREEN_STATUS",
    tabId: activeTabId,
    phase,
    message,
    ...patch
  });
}

function cleanError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("WebAssembly") || message.includes("wasm")) {
    return "This browser could not open the local WebAssembly subtitle engine.";
  }
  if (message.includes("Permission denied") || message.includes("NotAllowedError")) {
    return "The browser did not allow this tab's audio to be captured.";
  }
  return message;
}

async function openTabAudio(streamId) {
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId
      }
    },
    video: false
  });

  const [track] = mediaStream.getAudioTracks();
  if (!track) throw new Error("The selected tab did not provide an audio track.");
  track.addEventListener("ended", () => {
    if (!stopping) void unexpectedEnd("The tab stopped sharing audio.");
  });

  audioContext = new AudioContext({ latencyHint: "interactive" });
  if (audioContext.state === "suspended") await audioContext.resume();
  if (audioContext.state === "suspended") {
    throw new Error("The browser kept the tab audio engine suspended.");
  }

  sourceNode = audioContext.createMediaStreamSource(mediaStream);

  // Chrome suppresses the tab's original audio while tabCapture is active.
  // Routing the captured stream back to the destination keeps the video audible.
  sourceNode.connect(audioContext.destination);

  await audioContext.audioWorklet.addModule(chrome.runtime.getURL("audio-worklet.js"));
  captureNode = new AudioWorkletNode(audioContext, "local-subtitles-capture", {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCountMode: "max",
    channelInterpretation: "speakers"
  });
  sourceNode.connect(captureNode);
}

function emitTranscript(line, final) {
  const text = String(line?.text ?? "").trim();
  const lineId = String(line?.id ?? "");
  if (!text || (!final && lastTextByLine.get(lineId) === text)) return;
  lastTextByLine.set(lineId, text);

  void notify({
    type: "OFFSCREEN_TRANSCRIPT",
    tabId: activeTabId,
    text,
    lineId,
    final
  });
}

async function prepareModel(modelArch) {
  if (typeof WebAssembly === "undefined" || typeof Worker === "undefined") {
    throw new Error("This browser does not provide the WebAssembly worker runtime.");
  }

  workerHost = new SttWorkerHost();
  workerHost.onProgress = (_transcriberId, loaded, total, file) => {
    const progress = total ? Math.min(1, loaded / total) : null;
    const percent = progress === null ? null : Math.floor(progress * 100);
    const now = performance.now();
    if (!shouldPublishProgress({
      now,
      previousAt: lastProgressNotice,
      percent,
      previousPercent: lastProgressPercent,
      file,
      previousFile: lastProgressFile
    })) return;
    lastProgressNotice = now;
    lastProgressPercent = percent;
    lastProgressFile = file;
    void status("downloading", "Downloading the English model", { progress });
  };

  await workerHost.loadTranscriber({
    transcriberId: TRANSCRIBER_ID,
    modelArch,
    source: { kind: "catalog", language: "en" }
  });

  await status("warming", "Opening the cached model", { progress: null });

  await workerHost.createStream(TRANSCRIBER_ID, STREAM_ID, {
    updateInterval: 0.5,
    priority: 10
  });
  workerHost.setListener(STREAM_ID, {
    onLineStarted: ({ line }) => emitTranscript(line, false),
    onLineTextChanged: ({ line }) => emitTranscript(line, false),
    onLineUpdated: ({ line }) => emitTranscript(line, false),
    onLineCompleted: ({ line }) => emitTranscript(line, true),
    onError: ({ error }) => {
      void status("error", "The local model stopped", {
        error: cleanError(error)
      });
    }
  });
  await workerHost.start(STREAM_ID);
}

function connectAudioToModel() {
  let behind = false;
  captureNode.port.onmessage = ({ data }) => {
    if (!acceptingAudio || !workerHost || !(data instanceof Float32Array)) return;

    const wasBehind = behind;
    behind = catchUpTransition(workerHost.queuedSeconds(STREAM_ID), behind);
    if (behind !== wasBehind) {
      void status("listening", behind ? CATCH_UP_MESSAGE : LIVE_MESSAGE);
    }

    workerHost.addAudio(STREAM_ID, data, audioContext.sampleRate);
  };
}

async function startSession({ tabId, streamId }) {
  if (!Number.isInteger(tabId) || !streamId) {
    throw new Error("The tab audio request was incomplete.");
  }
  if (activeTabId !== null) await stopSession(false);

  activeTabId = tabId;
  stopping = false;
  lastProgressNotice = 0;
  lastProgressPercent = -1;
  lastProgressFile = "";
  lastTextByLine.clear();
  await status("capturing", "Opening this tab's audio");

  try {
    const stored = await chrome.storage.local.get("settings");
    const settings = normalizeSettings(stored.settings ?? DEFAULT_SETTINGS);
    await openTabAudio(streamId);
    await prepareModel(MODEL_ARCHS[settings.modelArch]);
    connectAudioToModel();
    acceptingAudio = true;
    await status("listening", LIVE_MESSAGE, {
      progress: null,
      error: ""
    });
  } catch (error) {
    await status("error", "Could not start local subtitles", {
      error: cleanError(error),
      progress: null
    });
    await stopSession(false);
    throw error;
  }
}

async function stopSession(sendEnded = true) {
  if (stopping) return;
  stopping = true;
  acceptingAudio = false;
  const endedTabId = activeTabId;

  try {
    captureNode?.disconnect();
    sourceNode?.disconnect();
    if (workerHost) {
      await workerHost.stop(STREAM_ID).catch(() => {});
      await workerHost.closeStream(STREAM_ID).catch(() => {});
      workerHost.close();
    }
    mediaStream?.getTracks().forEach((track) => track.stop());
    await audioContext?.close().catch(() => {});
  } finally {
    workerHost = undefined;
    captureNode = undefined;
    sourceNode = undefined;
    mediaStream = undefined;
    audioContext = undefined;
    activeTabId = null;
    lastTextByLine.clear();
    stopping = false;
  }

  if (sendEnded && endedTabId !== null) {
    await notify({
      type: "OFFSCREEN_ENDED",
      tabId: endedTabId,
      message: "Ready for a video"
    });
  }
}

async function unexpectedEnd(message) {
  const endedTabId = activeTabId;
  await stopSession(false);
  if (endedTabId !== null) {
    await notify({ type: "OFFSCREEN_ENDED", tabId: endedTabId, message });
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen") return false;

  const operation =
    message.type === "START_SESSION"
      ? startSession(message)
      : message.type === "STOP_SESSION"
        ? stopSession(false)
        : Promise.resolve();

  operation
    .then(() => sendResponse({ ok: true }))
    .catch((error) => {
      sendResponse({ ok: false, error: cleanError(error) });
    });
  return true;
});
