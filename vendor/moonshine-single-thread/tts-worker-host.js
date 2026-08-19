/**
 * Main-thread host for {@link ./tts-worker.ts}.
 *
 * Spawns a module worker when the environment supports it (browsers). Node
 * tests fall back to main-thread synthesis inside {@link TextToSpeech}.
 */
/** True when we can run TTS synthesis off the main thread. */
export function ttsWorkerSupported() {
    // Node 18+ may expose `Worker` (worker_threads) with a different runtime;
    // only enable the off-thread path in a document / window environment.
    return (typeof window !== 'undefined' &&
        typeof document !== 'undefined' &&
        typeof Worker !== 'undefined' &&
        typeof URL !== 'undefined');
}
/**
 * Base URL for files next to this module (`moonshine.wasm`, the worker, …).
 * Trailing slash included so `new URL(path, base)` resolves correctly.
 */
export function moonshineWasmBaseUrl() {
    return new URL('./', import.meta.url).href;
}
/**
 * Spawns a module Worker for `scriptUrl`, using a same-origin blob bridge when
 * the script is cross-origin. Browsers reject `new Worker(crossOriginUrl)` even
 * when the URL is CORS-enabled (same restriction that hits Emscripten pthreads).
 */
function spawnModuleWorker(scriptUrl) {
    const href = scriptUrl.href;
    if (typeof location !== 'undefined' &&
        new URL(href).origin !== location.origin) {
        const bridge = `import ${JSON.stringify(href)};`;
        const blobUrl = URL.createObjectURL(new Blob([bridge], { type: 'text/javascript' }));
        return new Worker(blobUrl, { type: 'module' });
    }
    return new Worker(scriptUrl, { type: 'module' });
}
export class TtsWorkerHost {
    worker;
    nextId = 1;
    pending = new Map();
    wasmBaseUrl;
    closed = false;
    constructor(wasmBaseUrl = moonshineWasmBaseUrl()) {
        this.wasmBaseUrl = wasmBaseUrl;
        this.worker = spawnModuleWorker(new URL('./tts-worker.js', import.meta.url));
        this.worker.onmessage = (event) => {
            const msg = event.data;
            const slot = this.pending.get(msg.id);
            if (!slot)
                return;
            this.pending.delete(msg.id);
            if (msg.type === 'error') {
                slot.reject(new Error(msg.message));
            }
            else {
                slot.resolve(msg);
            }
        };
        this.worker.onerror = (event) => {
            const error = new Error(event.message || 'TTS worker failed');
            for (const slot of this.pending.values()) {
                slot.reject(error);
            }
            this.pending.clear();
        };
    }
    request(payload) {
        if (this.closed) {
            return Promise.reject(new Error('TTS worker is closed.'));
        }
        const id = this.nextId++;
        const message = { ...payload, id };
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.worker.postMessage(message);
        });
    }
    /** (Re)creates the worker-side synthesizer from asset buffers. */
    async setEngine(config) {
        const response = await this.request({
            type: 'setEngine',
            language: config.language,
            keys: config.keys,
            buffers: config.buffers,
            optionNames: config.optionNames,
            optionValues: config.optionValues,
            wasmBaseUrl: this.wasmBaseUrl,
        });
        if (response.type !== 'ok') {
            throw new Error('Unexpected TTS worker response to setEngine.');
        }
    }
    /** Runs `moonshine_text_to_speech` on the worker. */
    async synthesize(text) {
        const response = await this.request({ type: 'synthesize', text });
        if (response.type !== 'synthesized') {
            throw new Error('Unexpected TTS worker response to synthesize.');
        }
        return {
            audio: new Float32Array(response.audioBuffer),
            sampleRate: response.sampleRate,
        };
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        const id = this.nextId++;
        try {
            this.worker.postMessage({ type: 'close', id });
        }
        catch {
            /* worker may already be gone */
        }
        for (const slot of this.pending.values()) {
            slot.reject(new Error('TTS worker closed.'));
        }
        this.pending.clear();
        this.worker.terminate();
    }
}
//# sourceMappingURL=tts-worker-host.js.map