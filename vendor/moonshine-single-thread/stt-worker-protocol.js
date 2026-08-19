/**
 * Message protocol between {@link SttWorkerHost} and the STT Web Worker.
 *
 * The worker owns {@link Transcriber} and {@link Stream} so live transcription
 * can run off the main thread. Sync {@link Stream.transcribe} on the page stays
 * on the main thread and is out of scope here.
 */
export {};
//# sourceMappingURL=stt-worker-protocol.js.map