import {
  ModelArch,
  SttWorkerHost
} from "./vendor/moonshine/index.js";
import { shouldPublishProgress } from "./shared.js";

const TRANSCRIBER_ID = "local-subtitles-model";
const STREAM_ID = "active-tab-audio";

let activeTabId = null;
let mediaStream;
let audioContext;
let sourceNode;
let captureNode;
let workerHost;
let acceptingAudio = false;
let stopping = false;
let lastQueueNotice = 0;
let lastPassNotice = 0;
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
    final,
    latencyMs:
      typeof line?.lastTranscriptionLatencyMs === "number"
        ? line.lastTranscriptionLatencyMs
        : null
  });
}

async function prepareModel() {
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
    void status("downloading", "Downloading the English model once", {
      progress,
      progressFile: file
    });
  };
  workerHost.onPass = (_streamId, passMs) => {
    if (!(passMs > 0)) return;
    const now = performance.now();
    if (now - lastPassNotice < 1200) return;
    lastPassNotice = now;
    void status("listening", "Creating subtitles on this device", {
      passMs
    });
  };

  await workerHost.loadTranscriber({
    transcriberId: TRANSCRIBER_ID,
    modelArch: ModelArch.TinyStreaming,
    source: { kind: "catalog", language: "en" }
  });

  await status("warming", "Preparing Moonshine Tiny Streaming", {
    progress: null,
    progressFile: ""
  });

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
  captureNode.port.onmessage = ({ data }) => {
    if (!acceptingAudio || !workerHost || !(data instanceof Float32Array)) return;

    const queued = workerHost.queuedSeconds(STREAM_ID);
    if (queued > 2.5 && performance.now() - lastQueueNotice > 2500) {
      lastQueueNotice = performance.now();
      void status("listening", "The model is catching up to the video", {
        passMs: null
      });
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
    await openTabAudio(streamId);
    await prepareModel();
    connectAudioToModel();
    acceptingAudio = true;
    await status("listening", "Creating subtitles on this device", {
      progress: null,
      progressFile: "",
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
