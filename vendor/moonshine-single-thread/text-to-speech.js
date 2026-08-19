/**
 * Text to speech, including zero-shot voice cloning.
 *
 * ```ts
 * const tts = new TextToSpeech().language('en_us').voice('kokoro_af_heart');
 * await tts.load();
 * await tts.say('Hello world!');
 * ```
 *
 * Cloning is a create-time mode, like choosing a catalog voice. Call
 * {@link cloning} before {@link load} so every ZipVoice + clone-ASR asset is
 * fetched up front; then {@link cloneFrom} only swaps the reference clip:
 *
 * ```ts
 * const tts = new TextToSpeech().language('en_us').cloning();
 * await tts.load();
 * await tts.cloneFrom(recording);
 * await tts.say('Hello in your voice!');
 * ```
 */
import { AssetDownloader } from './asset-downloader.js';
import { ModelArch } from './enums.js';
import { wrapErrors } from './errors.js';
import { wrapProgress } from './mic-transcriber.js';
import { loadMoonshineModule, } from './module.js';
import { Transcriber } from './transcriber.js';
import { TtsWorkerHost, ttsWorkerSupported, } from './tts-worker-host.js';
import { extractSpeechClip, VoiceClone, } from './voice-clone.js';
const DEFAULT_TTS_ASSET_BASE = 'https://download.moonshine.ai/tts';
const DEFAULT_LANGUAGE = 'en';
/** Canonical asset key under which a ZipVoice clone reference clip is supplied. */
const ZIPVOICE_CLONE_AUDIO_KEY = 'zipvoice/clone_audio';
/** Engine name used when creating ZipVoice from a captured clone clip. */
const CLONE_ENGINE = 'zipvoice';
/** Built-in ZipVoice voice used by {@link TextToSpeech.cloning} before a clip exists. */
const CLONE_PRESET_VOICE = 'zipvoice_american_female';
export class TextToSpeech {
    raw;
    mod;
    moduleOpts;
    downloader;
    languageCode = DEFAULT_LANGUAGE;
    voiceId;
    assetBase;
    suppliedAssets;
    /** Assets fetched by {@link load}; reused by {@link cloneFrom} with no re-download. */
    loadedAssets;
    extraOptions = {};
    progressCallback;
    context;
    ownsContext = false;
    cloningWanted = false;
    /** The clip the current voice was cloned from, if any. */
    cloneAudio;
    cloneTranscript;
    /** Last {@link say} output, keyed by the spoken text, for instant replay. */
    sayCache;
    /**
     * Browser worker that owns a synthesizer for {@link say}. Absent in Node
     * tests, which keep synthesis on the main thread.
     */
    workerHost;
    /** Snapshot used to recreate a main-thread synthesizer for {@link synthesize}. */
    mainEngine;
    /** Synthesis language, e.g. `"en"` or `"en_us"`. Defaults to `"en"`. */
    language(code) {
        this.languageCode = code;
        return this;
    }
    /**
     * Catalog voice id, e.g. `"kokoro_af_heart"`. Clears {@link cloning} — a
     * synthesizer is either a catalog voice or a cloning engine, not both.
     */
    voice(id) {
        this.voiceId = id;
        this.cloningWanted = false;
        return this;
    }
    /**
     * Fetches the voice and G2P assets from a base URL you host instead of the
     * Moonshine CDN. Canonical names (e.g. `kokoro/model.ort`) are appended.
     */
    modelsFrom(baseUrl) {
        this.assetBase = baseUrl;
        return this;
    }
    /**
     * Supplies voice assets directly, keyed by canonical name (e.g.
     * `kokoro/model.ort`). Nothing is downloaded when this is set.
     */
    assets(assets) {
        this.suppliedAssets = assets;
        return this;
    }
    /**
     * Create this synthesizer as a ZipVoice cloning engine. Call before
     * {@link load} so ZipVoice and clone-ASR assets are fetched up front.
     * Clears {@link voice}. Only then may {@link cloneFrom} / {@link startCloning}
     * be used.
     */
    cloning(enabled = true) {
        this.cloningWanted = enabled;
        if (enabled)
            this.voiceId = undefined;
        return this;
    }
    /** Model download progress, as a `0..1` fraction. */
    onProgress(callback) {
        this.progressCallback = callback;
        return this;
    }
    /** Reuses an AudioContext for playback rather than creating one per call. */
    audioContext(context) {
        this.context = context;
        this.ownsContext = false;
        return this;
    }
    /** Shares an already-initialised WASM module. */
    useModule(module) {
        this.mod = module;
        return this;
    }
    /** Shares a downloader, so several engines report progress together. */
    useDownloader(downloader) {
        this.downloader = downloader;
        return this;
    }
    /** Escape hatch for `moonshine_option_t` entries the builder doesn't cover. */
    nativeOptions(options) {
        this.extraOptions = { ...this.extraOptions, ...options };
        return this;
    }
    /**
     * Downloads every asset this synthesizer needs and prepares it. With
     * {@link cloning}, that includes ZipVoice and clone ASR — afterwards
     * {@link cloneFrom} does not go back to the network.
     */
    async load() {
        this.mod ??= await loadMoonshineModule(this.moduleOpts);
        if (!this.mod.TextToSpeech) {
            throw new Error('This Moonshine WASM build was compiled without TTS support.');
        }
        const voice = this.cloningWanted
            ? CLONE_PRESET_VOICE
            : (this.voiceId ?? '');
        await this.build(voice, { allowDownload: true });
        return this;
    }
    /**
     * Clones the voice in `source` and uses it for subsequent synthesis. Accepts
     * a URL or path, a `File` / `Blob`, an `AudioBuffer`, raw 16 kHz mono PCM, or
     * a {@link VoiceClone} captured with {@link startCloning}.
     *
     * Requires {@link cloning} before {@link load}. The library trims the
     * recording and transcribes it for the vocoder (using assets already fetched
     * by `load`) unless you pass `transcript`.
     */
    async cloneFrom(source, options = {}) {
        this.requireCloningMode('cloneFrom()');
        if (!this.isEngineReady()) {
            throw new Error('Call load() before cloneFrom().');
        }
        const { audio, sampleRate, transcript } = await this.resolveCloneSource(source);
        // Prefer a main-thread handle for extract; create lazily if say() has been
        // using the worker-only engine so far.
        this.ensureMainThreadEngine();
        const ttsHandle = this.raw.handle();
        const clip = sampleRate === 16000 && audio.length <= 16000 * 10
            ? audio
            : await extractSpeechClip(audio, sampleRate, {
                module: this.mod,
                ttsHandle,
            });
        this.cloneAudio = clip;
        this.cloneTranscript =
            options.transcript ?? transcript ?? undefined;
        // Let the UI paint before sync rebuild work on the main thread.
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });
        await this.build(CLONE_ENGINE, { allowDownload: false });
        return this;
    }
    /**
     * Starts capturing a reference voice incrementally, for cloning from a live
     * microphone. Requires {@link cloning} before {@link load}.
     */
    startCloning(options = {}) {
        this.requireCloningMode('startCloning()');
        if (!this.isEngineReady()) {
            throw new Error('Call load() before startCloning().');
        }
        this.ensureMainThreadEngine();
        return new VoiceClone(this.mod, this.raw.handle(), options);
    }
    /** True once a voice has been cloned into this instance. */
    get isCloned() {
        return this.cloneAudio !== undefined;
    }
    /** Synthesizes `text` to mono PCM without playing it. */
    synthesize(text) {
        this.ensureMainThreadEngine();
        const result = wrapErrors(() => this.raw.say(text));
        return { audio: result.audio, sampleRate: result.sampleRate };
    }
    /**
     * Concatenated PCM from the last {@link say} call, if any. Handy for a
     * download link or for tests; replay uses the per-sentence cache instead.
     */
    get lastSaid() {
        const chunks = this.sayCache?.chunks;
        if (!chunks?.length)
            return undefined;
        if (chunks.length === 1)
            return chunks[0];
        const sampleRate = chunks[0].sampleRate;
        let total = 0;
        for (const chunk of chunks)
            total += chunk.audio.length;
        const audio = new Float32Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            audio.set(chunk.audio, offset);
            offset += chunk.audio.length;
        }
        return { audio, sampleRate };
    }
    /**
     * Speaks `text` out loud, resolving when playback finishes.
     *
     * Long strings are split on an approximate sentence boundary (`.`, `!`,
     * `?`, or `:` followed by whitespace). The first sentence starts playing as soon
     * as it is ready; later sentences synthesize on a Web Worker while the
     * previous one plays (main-thread fallback where Workers are unavailable).
     * Calling again with the same text replays the cached audio instantly.
     */
    async say(text) {
        if (!this.isEngineReady()) {
            throw new Error('Call load() before say().');
        }
        const sentences = splitSayUtterances(text);
        if (!sentences.length)
            return;
        if (this.sayCache?.text === text && this.sayCache.chunks.length > 0) {
            await this.playChunks(this.sayCache.chunks);
            return;
        }
        // Let the caller paint (disabled button, status text) before work starts.
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });
        const synthesizeOne = (sentence) => this.workerHost
            ? this.workerHost.synthesize(sentence)
            : Promise.resolve(this.synthesize(sentence));
        const chunks = [];
        let pending;
        for (let i = 0; i < sentences.length; i++) {
            const result = await (pending ?? synthesizeOne(sentences[i]));
            pending = undefined;
            chunks.push(result);
            const playing = this.playOne(result);
            if (i + 1 < sentences.length) {
                // Kick off the next sentence on the worker while this one plays.
                pending = synthesizeOne(sentences[i + 1]);
            }
            await playing;
        }
        this.sayCache = { text, chunks };
    }
    async playChunks(chunks) {
        for (const chunk of chunks) {
            await this.playOne(chunk);
        }
    }
    playOne(result) {
        if (result.audio.length === 0)
            return Promise.resolve();
        const ctx = this.ensureContext();
        const buffer = ctx.createBuffer(1, result.audio.length, result.sampleRate);
        buffer.copyToChannel(result.audio, 0);
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        return new Promise((resolve) => {
            source.onended = () => resolve();
            source.start();
        });
    }
    /**
     * Lists the voices known for a language, with availability state. Pass a
     * `voice` whose prefix selects the engine to enumerate: `kokoro_*` (the
     * default), `piper_*`, or `zipvoice_*`.
     */
    static async voices(options = {}) {
        const module = options.module ?? (await loadMoonshineModule(options.moduleOptions));
        if (!module.ttsVoices) {
            throw new Error('TTS voice listing is unavailable in this build.');
        }
        const languages = options.languages ?? options.language ?? '';
        const names = options.voice ? ['voice'] : [];
        const values = options.voice ? [options.voice] : [];
        const json = module.ttsVoices(languages, names, values);
        const parsed = JSON.parse(json);
        // The native API returns a map of language -> voices; flatten to a single
        // list (deduping by id) since callers query one language/engine at a time.
        const seen = new Map();
        for (const entries of Object.values(parsed)) {
            for (const entry of entries) {
                if (!seen.has(entry.id))
                    seen.set(entry.id, entry);
            }
        }
        return [...seen.values()];
    }
    close() {
        this.workerHost?.close();
        this.workerHost = undefined;
        if (this.raw)
            wrapErrors(() => this.raw.close());
        this.raw = undefined;
        this.mainEngine = undefined;
        this.loadedAssets = undefined;
        this.sayCache = undefined;
        if (this.ownsContext)
            void this.context?.close();
        this.context = undefined;
    }
    [Symbol.dispose]() {
        this.close();
    }
    // --- Internals ---
    requireCloningMode(what) {
        if (!this.cloningWanted) {
            throw new Error(`Call cloning() before load() to use ${what}. ` +
                'Catalog voices and cloning are separate synthesizer modes.');
        }
    }
    isEngineReady() {
        return this.workerHost !== undefined || this.raw !== undefined || this.mainEngine !== undefined;
    }
    /**
     * Creates (or recreates) the main-thread synthesizer used by
     * {@link synthesize} and {@link startCloning}. No-op when one already exists
     * matching {@link mainEngine}.
     */
    ensureMainThreadEngine() {
        if (this.raw)
            return;
        if (!this.mod?.TextToSpeech || !this.mainEngine) {
            throw new Error('Call load() before synthesizing.');
        }
        const { language, keys, buffers, optionNames, optionValues } = this.mainEngine;
        this.raw = wrapErrors(() => new this.mod.TextToSpeech(language, keys, buffers, optionNames, optionValues));
    }
    /**
     * (Re)creates the native synthesizer. `allowDownload` is true for
     * {@link load}; {@link cloneFrom} reuses {@link loadedAssets}.
     *
     * When Workers are available the engine used by {@link say} is built on a
     * worker (main thread stays free). A main-thread copy is created lazily for
     * {@link synthesize} / {@link startCloning}.
     */
    async build(voice, options) {
        const assets = await this.resolveAssets(voice, options.allowDownload);
        if (this.cloneAudio && !this.cloneTranscript) {
            await new Promise((resolve) => setTimeout(resolve, 0));
            this.cloneTranscript = await this.autotranscribeCloneClip(this.cloneAudio, assets);
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        const createAssets = new Map(assets);
        const nativeOptions = { ...this.extraOptions };
        if (this.cloneAudio) {
            createAssets.set(ZIPVOICE_CLONE_AUDIO_KEY, floatPcmToBytes(this.cloneAudio));
            nativeOptions.voice = CLONE_ENGINE;
            nativeOptions.zipvoice_clone_sample_rate = '16000';
            if (this.cloneTranscript) {
                nativeOptions.zipvoice_clone_transcript = this.cloneTranscript;
            }
        }
        else if (voice) {
            nativeOptions.voice = voice;
        }
        // Native create does not need clone_asr once the transcript is known (or
        // when there is no clip yet). Keep them in loadedAssets for later.
        for (const key of [...createAssets.keys()]) {
            if (key.startsWith('clone_asr/'))
                createAssets.delete(key);
        }
        const keys = [...createAssets.keys()];
        const buffers = [...createAssets.values()].map((b) => new Uint8Array(b));
        const optionNames = Object.keys(nativeOptions);
        const optionValues = optionNames.map((name) => nativeOptions[name]);
        this.mainEngine = {
            language: this.languageCode,
            keys,
            buffers,
            optionNames,
            optionValues,
        };
        // Drop any previous main-thread engine; recreate on demand.
        this.raw?.close();
        this.raw = undefined;
        this.sayCache = undefined;
        if (ttsWorkerSupported()) {
            this.workerHost ??= new TtsWorkerHost();
            await this.workerHost.setEngine(this.mainEngine);
        }
        else {
            this.ensureMainThreadEngine();
        }
    }
    async resolveAssets(voice, allowDownload) {
        if (this.suppliedAssets) {
            this.loadedAssets = new Map(this.suppliedAssets);
            return new Map(this.suppliedAssets);
        }
        if (this.loadedAssets && this.loadedAssets.size > 0) {
            return new Map(this.loadedAssets);
        }
        if (!allowDownload) {
            throw new Error('Clone assets were not loaded. Call cloning() before load() so ' +
                'ZipVoice and clone ASR are fetched up front.');
        }
        const downloaded = await this.downloadAssets(voice);
        this.loadedAssets = downloaded;
        return new Map(downloaded);
    }
    /** One-shot STT of a clone clip using the advertised clone_asr assets. */
    async autotranscribeCloneClip(clip, assets) {
        const asrFiles = new Map();
        for (const [key, bytes] of assets) {
            if (key.startsWith('clone_asr/')) {
                asrFiles.set(key.slice('clone_asr/'.length), bytes);
            }
        }
        if (asrFiles.size === 0)
            return undefined;
        const arch = asrFiles.has('frontend.ort')
            ? ModelArch.MediumStreaming
            : ModelArch.Base;
        const transcriber = await Transcriber.load({
            files: asrFiles,
            modelArch: arch,
            module: this.mod,
            options: { word_timestamps: 'true' },
        });
        try {
            await new Promise((resolve) => setTimeout(resolve, 0));
            const result = transcriber.transcribe(clip, { sampleRate: 16000 });
            const text = result.lines
                .map((line) => line.text.trim())
                .filter(Boolean)
                .join(' ')
                .trim();
            return text || undefined;
        }
        finally {
            transcriber.close();
        }
    }
    async downloadAssets(voice) {
        const module = this.mod;
        if (!module.ttsDependencies) {
            throw new Error('TTS manifests are unavailable in this build.');
        }
        const depsJson = module.ttsDependencies(this.languageCode, voice);
        const parsed = JSON.parse(depsJson);
        const urls = new Map();
        const ttsBase = (this.assetBase ?? DEFAULT_TTS_ASSET_BASE).replace(/\/+$/, '');
        for (const group of parsed.groups ?? []) {
            const isCloneAsr = group.role === 'clone_asr';
            const base = (group.base_url ?? DEFAULT_TTS_ASSET_BASE).replace(/\/+$/, '');
            for (const file of group.files ?? []) {
                const name = file.name?.trim();
                if (!name || !name.includes('/'))
                    continue;
                let url = file.url?.trim() || `${base}/${name.replace(/^\/+/, '')}`;
                if (!isCloneAsr && this.assetBase) {
                    url = `${ttsBase}/${name.replace(/^\/+/, '')}`;
                }
                urls.set(name, url);
            }
        }
        if (urls.size === 0) {
            throw new Error('TTS dependency manifest listed no downloadable files.');
        }
        const downloader = this.downloader ??
            new AssetDownloader({ onProgress: wrapProgress(this.progressCallback) });
        return downloader.downloadNamedFiles(urls);
    }
    async resolveCloneSource(source) {
        if (source instanceof VoiceClone) {
            const audio = source.audio;
            if (!audio) {
                throw new Error('That VoiceClone has not captured enough speech yet — wait for onReady.');
            }
            return {
                audio,
                sampleRate: source.sampleRate,
                transcript: source.transcript,
            };
        }
        if (source instanceof Float32Array) {
            return { audio: source, sampleRate: 16000 };
        }
        if (typeof source === 'object' && 'audio' in source && 'sampleRate' in source) {
            return { audio: source.audio, sampleRate: source.sampleRate };
        }
        if (isAudioBuffer(source)) {
            return {
                audio: source.getChannelData(0),
                sampleRate: source.sampleRate,
            };
        }
        let bytes;
        if (typeof source === 'string' || source instanceof URL) {
            const response = await fetch(String(source));
            if (!response.ok) {
                throw new Error(`Failed to fetch clone audio: ${response.status}`);
            }
            bytes = await response.arrayBuffer();
        }
        else if (source instanceof Blob) {
            bytes = await source.arrayBuffer();
        }
        else {
            bytes = source;
        }
        const decoded = await this.ensureContext().decodeAudioData(bytes.slice(0));
        return {
            audio: decoded.getChannelData(0),
            sampleRate: decoded.sampleRate,
        };
    }
    ensureContext() {
        if (!this.context) {
            this.context = new AudioContext();
            this.ownsContext = true;
        }
        return this.context;
    }
}
/** `AudioBuffer` is a browser global, so guard the check for other runtimes. */
function isAudioBuffer(value) {
    return typeof AudioBuffer !== 'undefined' && value instanceof AudioBuffer;
}
/**
 * Approximate sentence split for {@link TextToSpeech.say}: break on `.` / `!`
 * / `?` / `:` followed by whitespace so the first clause can start sooner.
 */
export function splitSayUtterances(text) {
    const stripped = text.trim();
    if (!stripped)
        return [];
    const parts = [];
    let start = 0;
    let i = 0;
    while (i < stripped.length) {
        const ch = stripped[i];
        if ((ch === '.' || ch === '!' || ch === '?' || ch === ':') &&
            i + 1 < stripped.length &&
            /\s/.test(stripped[i + 1])) {
            const end = i + 1;
            let j = i + 1;
            while (j < stripped.length && /\s/.test(stripped[j]))
                j += 1;
            const piece = stripped.slice(start, end).trim();
            if (piece)
                parts.push(piece);
            start = j;
            i = j;
            continue;
        }
        i += 1;
    }
    const tail = stripped.slice(start).trim();
    if (tail)
        parts.push(tail);
    return parts;
}
/** Views a mono Float32 PCM buffer as little-endian raw bytes (no copy). */
function floatPcmToBytes(pcm) {
    return new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
}
//# sourceMappingURL=text-to-speech.js.map