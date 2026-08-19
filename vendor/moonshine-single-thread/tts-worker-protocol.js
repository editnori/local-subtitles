/**
 * Message protocol between {@link TextToSpeech} and the TTS Web Worker.
 *
 * The worker owns the WASM synthesizer so {@link TextToSpeech.say} can run
 * synthesis off the main thread. Sync {@link TextToSpeech.synthesize} stays on
 * the main thread and is out of scope here.
 */
export {};
//# sourceMappingURL=tts-worker-protocol.js.map