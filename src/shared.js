export const DEFAULT_SETTINGS = Object.freeze({
  captionSize: "medium",
  captionPosition: "low",
  backgroundOpacity: 76,
  showPartials: true,
  theme: "system"
});

export const IDLE_STATE = Object.freeze({
  phase: "idle",
  tabId: null,
  tabTitle: "",
  progress: null,
  progressFile: "",
  message: "Ready for a video",
  videoDetected: false,
  engine: "Moonshine Tiny Streaming",
  passMs: null,
  error: "",
  updatedAt: 0
});

const CAPTION_SIZES = new Set(["small", "medium", "large"]);
const CAPTION_POSITIONS = new Set(["low", "raised"]);
const THEMES = new Set(["light", "dark", "system"]);

export function normalizeSettings(value = {}) {
  const opacity = Number(value.backgroundOpacity);
  return {
    captionSize: CAPTION_SIZES.has(value.captionSize)
      ? value.captionSize
      : DEFAULT_SETTINGS.captionSize,
    captionPosition: CAPTION_POSITIONS.has(value.captionPosition)
      ? value.captionPosition
      : DEFAULT_SETTINGS.captionPosition,
    backgroundOpacity: Number.isFinite(opacity)
      ? Math.min(94, Math.max(24, Math.round(opacity)))
      : DEFAULT_SETTINGS.backgroundOpacity,
    showPartials:
      typeof value.showPartials === "boolean"
        ? value.showPartials
        : DEFAULT_SETTINGS.showPartials,
    theme: THEMES.has(value.theme) ? value.theme : DEFAULT_SETTINGS.theme
  };
}

export function normalizeState(value = {}) {
  return {
    ...IDLE_STATE,
    ...value,
    tabId: Number.isInteger(value.tabId) ? value.tabId : null,
    progress:
      typeof value.progress === "number"
        ? Math.min(1, Math.max(0, value.progress))
        : null,
    passMs:
      typeof value.passMs === "number" && value.passMs >= 0
        ? value.passMs
        : null
  };
}

export function selectCaptionFrame(candidates, now = Date.now()) {
  const fresh = candidates.filter(
    (candidate) =>
      candidate.visible &&
      candidate.area > 0 &&
      now - candidate.updatedAt <= 5000
  );
  if (!fresh.length) return 0;
  fresh.sort((a, b) => {
    if (a.playing !== b.playing) return a.playing ? -1 : 1;
    return b.area - a.area;
  });
  return fresh[0].frameId;
}

export function captionLifetime(text, final) {
  if (!final) return 1800;
  const readingTime = String(text).trim().length * 58;
  return Math.min(7000, Math.max(2800, readingTime));
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function shouldPublishProgress({
  now,
  previousAt,
  percent,
  previousPercent,
  file,
  previousFile
}) {
  if (percent === 100) return true;
  if (file !== previousFile) return true;
  if (percent === previousPercent) return false;
  return now - previousAt >= 250;
}

export function phaseLabel(phase) {
  const labels = {
    idle: "Ready",
    starting: "Starting",
    capturing: "Opening audio",
    downloading: "Downloading",
    warming: "Warming up",
    listening: "Listening",
    stopping: "Stopping",
    error: "Needs attention"
  };
  return labels[phase] ?? "Ready";
}

export function phaseTone(phase) {
  if (phase === "listening") return "live";
  if (["starting", "capturing", "downloading", "warming", "stopping"].includes(phase)) {
    return "amber";
  }
  if (phase === "error") return "coral";
  return "neutral";
}

export function isBusyPhase(phase) {
  return ["starting", "capturing", "downloading", "warming", "stopping"].includes(phase);
}
