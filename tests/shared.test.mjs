import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SETTINGS,
  captionLifetime,
  catchUpTransition,
  normalizeSettings,
  normalizeState,
  phaseTone,
  selectCaptionFrame,
  shouldPublishProgress
} from "../src/shared.js";

test("settings keep supported values and clamp background opacity", () => {
  assert.deepEqual(
    normalizeSettings({
      captionSize: "large",
      captionPosition: "raised",
      backgroundOpacity: 120,
      showPartials: false,
      theme: "dark"
    }),
    {
      captionSize: "large",
      captionPosition: "raised",
      backgroundOpacity: 94,
      showPartials: false,
      theme: "dark"
    }
  );
});

test("invalid settings return the maintained defaults", () => {
  assert.deepEqual(
    normalizeSettings({
      captionSize: "giant",
      captionPosition: "left",
      backgroundOpacity: "none",
      showPartials: "yes",
      theme: "blue"
    }),
    DEFAULT_SETTINGS
  );
});

test("a playing video frame wins over a larger paused video", () => {
  const now = 10_000;
  const selected = selectCaptionFrame(
    [
      { frameId: 0, visible: true, playing: false, area: 900_000, updatedAt: now },
      { frameId: 7, visible: true, playing: true, area: 300_000, updatedAt: now }
    ],
    now
  );
  assert.equal(selected, 7);
});

test("stale and hidden video frames fall back to the top page", () => {
  const now = 20_000;
  assert.equal(
    selectCaptionFrame(
      [
        { frameId: 4, visible: true, playing: true, area: 500_000, updatedAt: now - 5001 },
        { frameId: 8, visible: false, playing: true, area: 700_000, updatedAt: now }
      ],
      now
    ),
    0
  );
});

test("caption lifetime gives final text a bounded reading window", () => {
  assert.equal(captionLifetime("forming", false), 1800);
  assert.equal(captionLifetime("short final", true), 2800);
  assert.equal(captionLifetime("x".repeat(300), true), 7000);
});

test("runtime state rejects invalid numeric values", () => {
  const state = normalizeState({ tabId: 4.2, progress: 4 });
  assert.equal(state.tabId, null);
  assert.equal(state.progress, 1);
});

test("phase tones preserve the visible state meaning", () => {
  assert.equal(phaseTone("listening"), "live");
  assert.equal(phaseTone("downloading"), "amber");
  assert.equal(phaseTone("error"), "coral");
  assert.equal(phaseTone("idle"), "neutral");
});

test("the catch-up notice enters late and leaves only once nearly drained", () => {
  assert.equal(catchUpTransition(2.5, false), false);
  assert.equal(catchUpTransition(2.6, false), true);
  assert.equal(catchUpTransition(1.2, true), true);
  assert.equal(catchUpTransition(0.7, true), false);
});

test("model progress publishes file changes and throttles repeated chunks", () => {
  const base = {
    previousAt: 1000,
    previousPercent: 12,
    previousFile: "encoder.ort"
  };
  assert.equal(shouldPublishProgress({ ...base, now: 1050, percent: 13, file: "encoder.ort" }), false);
  assert.equal(shouldPublishProgress({ ...base, now: 1249, percent: 13, file: "encoder.ort" }), false);
  assert.equal(shouldPublishProgress({ ...base, now: 1250, percent: 13, file: "encoder.ort" }), true);
  assert.equal(shouldPublishProgress({ ...base, now: 1010, percent: 12, file: "decoder.ort" }), true);
  assert.equal(shouldPublishProgress({ ...base, now: 1010, percent: 100, file: "encoder.ort" }), true);
});
