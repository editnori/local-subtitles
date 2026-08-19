/**
 * Web Worker that owns Moonshine speech-to-text transcribers and streams.
 *
 * Loaded as a module worker from {@link ./stt-worker-host.ts}. Keeps the heavy
 * `stream.transcribe()` work off the page's main thread.
 */
import { Transcriber } from './transcriber.js';
const transcribers = new Map();
const streams = new Map();
const streamPriority = new Map();
function reply(msg) {
    postMessage(msg);
}
function fail(id, err) {
    const message = err instanceof Error ? err.message : String(err);
    reply({ type: 'error', id, message });
}
function requireTranscriber(id) {
    const transcriber = transcribers.get(id);
    if (!transcriber) {
        throw new Error(`Unknown transcriber: ${id}`);
    }
    return transcriber;
}
function requireStream(id) {
    const stream = streams.get(id);
    if (!stream) {
        throw new Error(`Unknown stream: ${id}`);
    }
    return stream;
}
function listenerFor(streamId) {
    const emit = (name, line) => {
        reply({ type: 'event', streamId, name, line });
    };
    return {
        onLineStarted: (event) => emit('onLineStarted', event.line),
        onLineUpdated: (event) => emit('onLineUpdated', event.line),
        onLineTextChanged: (event) => emit('onLineTextChanged', event.line),
        onLineSpeakersChanged: (event) => emit('onLineSpeakersChanged', event.line),
        onLineCompleted: (event) => emit('onLineCompleted', event.line),
        onError: (event) => reply({
            type: 'errorEvent',
            streamId,
            message: event.error instanceof Error ? event.error.message : String(event.error),
        }),
    };
}
async function loadTranscriber(msg) {
    const options = {};
    for (let i = 0; i < msg.optionNames.length; i++) {
        options[msg.optionNames[i]] = msg.optionValues[i];
    }
    const moduleOptions = {
        locateFile: (path) => new URL(path, msg.wasmBaseUrl).href,
    };
    const onProgress = (loaded, total, file) => {
        reply({
            type: 'progress',
            transcriberId: msg.transcriberId,
            loaded,
            ...(total !== undefined ? { total } : {}),
            file,
        });
    };
    let next;
    if (msg.source.kind === 'urls') {
        next = await Transcriber.loadFromUrls(msg.source.files, {
            modelArch: msg.modelArch,
            options: Object.keys(options).length ? options : undefined,
            moduleOptions,
            onProgress,
        });
    }
    else {
        next = await Transcriber.load({
            language: msg.source.language,
            includeSpelling: msg.source.includeSpelling,
            modelArch: msg.modelArch,
            options: Object.keys(options).length ? options : undefined,
            moduleOptions,
            onProgress,
        });
    }
    transcribers.get(msg.transcriberId)?.close();
    transcribers.set(msg.transcriberId, next);
}
async function handle(msg) {
    switch (msg.type) {
        case 'loadTranscriber': {
            await loadTranscriber(msg);
            reply({ type: 'ok', id: msg.id });
            return;
        }
        case 'createStream': {
            const transcriber = requireTranscriber(msg.transcriberId);
            streams.get(msg.streamId)?.close();
            const stream = transcriber.createStream({
                flags: msg.flags,
                updateInterval: msg.updateInterval,
            });
            stream.addListener(listenerFor(msg.streamId));
            streams.set(msg.streamId, stream);
            streamPriority.set(msg.streamId, msg.priority ?? 0);
            reply({ type: 'ok', id: msg.id });
            return;
        }
        case 'start': {
            requireStream(msg.streamId).start();
            reply({ type: 'ok', id: msg.id });
            return;
        }
        case 'addAudio': {
            ingestAudio(msg);
            return;
        }
        case 'stop': {
            needsPass.delete(msg.streamId);
            requireStream(msg.streamId).stop();
            reply({ type: 'ok', id: msg.id });
            return;
        }
        case 'closeStream': {
            streams.get(msg.streamId)?.close();
            streams.delete(msg.streamId);
            streamPriority.delete(msg.streamId);
            needsPass.delete(msg.streamId);
            reply({ type: 'ok', id: msg.id });
            return;
        }
        case 'closeTranscriber': {
            transcribers.get(msg.transcriberId)?.close();
            transcribers.delete(msg.transcriberId);
            reply({ type: 'ok', id: msg.id });
            return;
        }
        case 'close': {
            for (const stream of streams.values())
                stream.close();
            streams.clear();
            streamPriority.clear();
            needsPass.clear();
            for (const transcriber of transcribers.values())
                transcriber.close();
            transcribers.clear();
            reply({ type: 'ok', id: msg.id });
            return;
        }
        default: {
            const neverMsg = msg;
            throw new Error(`Unknown worker message: ${neverMsg.type}`);
        }
    }
}
function ingestAudio(msg) {
    const stream = requireStream(msg.streamId);
    const audio = new Float32Array(msg.audioBuffer);
    const seconds = msg.sampleRate > 0 ? audio.length / msg.sampleRate : 0;
    stream.addAudio(audio, msg.sampleRate);
    reply({ type: 'ingested', streamId: msg.streamId, seconds });
}
function transcribeStream(streamId) {
    const stream = requireStream(streamId);
    const started = performance.now();
    try {
        stream.transcribe();
    }
    catch {
        // Stream already dispatched onError to the page.
    }
    finally {
        reply({ type: 'pass', streamId, ms: performance.now() - started });
    }
}
/**
 * addAudio is cheap and runs as soon as the worker is not inside WASM.
 * Transcription is coalesced onto one pass per stream so a backlog cannot
 * become one pass per chunk.
 */
const needsPass = new Set();
let passQueued = false;
let opChain = Promise.resolve();
function queuePasses() {
    if (passQueued)
        return;
    passQueued = true;
    opChain = opChain.then(() => {
        passQueued = false;
        const ids = [...needsPass].sort((a, b) => (streamPriority.get(b) ?? 0) - (streamPriority.get(a) ?? 0));
        needsPass.clear();
        for (const id of ids) {
            if (streams.has(id))
                transcribeStream(id);
        }
    }).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        reply({ type: 'errorEvent', streamId: 'unknown', message });
    });
}
function failOp(msg, err) {
    if ('id' in msg && typeof msg.id === 'number') {
        fail(msg.id, err);
        return;
    }
    if (msg.type === 'addAudio') {
        const message = err instanceof Error ? err.message : String(err);
        reply({ type: 'errorEvent', streamId: msg.streamId, message });
    }
}
onmessage = (event) => {
    const msg = event.data;
    if (msg.type === 'addAudio') {
        try {
            ingestAudio(msg);
            if (msg.enqueuePass !== false) {
                needsPass.add(msg.streamId);
                queuePasses();
            }
        }
        catch (err) {
            failOp(msg, err);
        }
        return;
    }
    if (msg.type === 'loadTranscriber') {
        void handle(msg).catch((err) => failOp(msg, err));
        return;
    }
    opChain = opChain.then(() => handle(msg)).catch((err) => failOp(msg, err));
};
//# sourceMappingURL=stt-worker.js.map