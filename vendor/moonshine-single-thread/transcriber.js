/**
 * High-level speech-to-text entry point, mirroring the Python/Swift/Android
 * `Transcriber`. Load it with the async {@link Transcriber.load} factory (which
 * fetches the model from the CDN), then either transcribe a whole buffer or
 * drive a streaming {@link Stream}.
 */
import { AssetDownloader } from './asset-downloader.js';
import { ModelArch, TranscribeFlags, modelArchToString } from './enums.js';
import { MoonshineInvalidArgumentError, wrapErrors } from './errors.js';
import { loadMoonshineModule, } from './module.js';
import { Stream } from './stream.js';
import { normalizeTranscript } from './types.js';
const ENCODER_FILE = 'encoder_model.ort';
const DECODER_FILE = 'decoder_model_merged.ort';
const TOKENIZER_FILE = 'tokenizer.bin';
const SPELLING_FILE = 'spelling_cnn.ort';
const DIARIZATION_FILES = ['segmentation.ort', 'embedding.ort'];
function wantsSpeakerIds(options) {
    const value = options?.identify_speakers?.trim().toLowerCase();
    return value === 'true' || value === '1';
}
/**
 * Adds the speaker diarization models to `files` when the caller asked for
 * speaker IDs and has not supplied them already. They are an 8.2 MB download
 * rather than part of the WASM binary, and without them the native transcriber
 * refuses to construct.
 */
async function addDiarizationModels(module, files, options) {
    if (!wantsSpeakerIds(options.options))
        return files;
    if (DIARIZATION_FILES.every((name) => files.has(name)))
        return files;
    const downloader = options.downloader ?? new AssetDownloader({ onProgress: options.onProgress });
    const downloaded = await downloader.downloadManifest(module.diarizationDependencies());
    for (const [name, bytes] of downloaded) {
        if (!files.has(name))
            files.set(name, bytes);
    }
    return files;
}
function isFromBytes(o) {
    return 'encoder' in o && 'decoder' in o && 'tokenizer' in o;
}
function isFromFiles(o) {
    return 'files' in o;
}
function toFileMap(files) {
    return files instanceof Map ? files : new Map(Object.entries(files));
}
export class Transcriber {
    raw;
    module;
    defaultStream;
    closed = false;
    constructor(raw, module) {
        this.raw = raw;
        this.module = module;
    }
    /**
     * Loads a transcriber. Pass raw non-streaming bytes ({@link
     * TranscriberFromBytes}), a keyed map of model files ({@link
     * TranscriberFromFiles}, which also supports streaming), or a `language` to
     * fetch the model from the Moonshine CDN ({@link TranscriberFromCatalog},
     * cached for next time). All paths load the model purely in memory — the
     * browser has no natural filesystem.
     */
    static async load(options) {
        const module = options.module ?? (await loadMoonshineModule(options.moduleOptions));
        if (isFromBytes(options)) {
            const files = new Map([
                [ENCODER_FILE, options.encoder],
                [DECODER_FILE, options.decoder],
                [TOKENIZER_FILE, options.tokenizer],
            ]);
            if (options.spelling)
                files.set(SPELLING_FILE, options.spelling);
            return Transcriber.construct(module, await addDiarizationModels(module, files, options), options.modelArch ?? ModelArch.Base, options.options);
        }
        if (isFromFiles(options)) {
            return Transcriber.construct(module, await addDiarizationModels(module, toFileMap(options.files), options), options.modelArch ?? ModelArch.Base, options.options);
        }
        // Catalog path: resolve the manifest via the C ABI, then download every
        // file it lists and hand the whole set to the in-memory loader. Passing all
        // files (rather than a hardcoded encoder/decoder/tokenizer trio) is what
        // lets streaming architectures — whose manifests list different filenames —
        // load correctly.
        const arch = options.modelArch ?? ModelArch.Base;
        const downloader = options.downloader ??
            new AssetDownloader({ onProgress: options.onProgress });
        const manifest = module.sttDependencies(options.language, String(arch), options.includeSpelling ?? false);
        const files = await downloader.downloadManifest(manifest);
        return Transcriber.construct(module, await addDiarizationModels(module, files, options), arch, options.options);
    }
    /**
     * Loads a transcriber from a map of canonical filename -> URL. Downloads each
     * remote file into a buffer (with caching, via {@link AssetDownloader}) and
     * feeds the buffers through the in-memory loader. Convenient when you host the
     * model files yourself instead of using the Moonshine CDN catalog.
     *
     * @example
     * const t = await Transcriber.loadFromUrls({
     *   'encoder_model.ort': '/models/encoder_model.ort',
     *   'decoder_model_merged.ort': '/models/decoder_model_merged.ort',
     *   'tokenizer.bin': '/models/tokenizer.bin',
     * }, { modelArch: ModelArch.Base });
     */
    static async loadFromUrls(files, options = {}) {
        const module = options.module ?? (await loadMoonshineModule(options.moduleOptions));
        const downloader = options.downloader ??
            new AssetDownloader({ onProgress: options.onProgress });
        const downloaded = await downloader.downloadNamedFiles(files);
        return Transcriber.construct(module, await addDiarizationModels(module, downloaded, options), options.modelArch ?? ModelArch.Base, options.options);
    }
    /** Builds the raw WASM transcriber from a keyed, in-memory file map. */
    static construct(module, files, arch, options) {
        const keys = [...files.keys()];
        const buffers = keys.map((k) => files.get(k));
        const optionNames = options ? Object.keys(options) : [];
        const optionValues = optionNames.map((k) => options[k]);
        const raw = wrapErrors(() => new module.Transcriber(keys, buffers, arch, optionNames, optionValues));
        return new Transcriber(raw, module);
    }
    /** Transcribes a complete buffer of PCM audio (non-streaming). */
    transcribe(audio, options = {}) {
        const sampleRate = options.sampleRate ?? 16000;
        const flags = options.flags ?? TranscribeFlags.None;
        return wrapErrors(() => normalizeTranscript(this.raw.transcribe(audio, sampleRate, flags)));
    }
    /**
     * Biases the decoder towards a list of terms, replacing any previous list.
     *
     * Useful for jargon, product names and proper nouns the model would otherwise
     * be unlikely to produce. No retraining is involved, so the list can follow
     * whatever the user is looking at and can be changed while a stream is
     * running; it takes effect on the next transcription and does not rewrite text
     * already emitted.
     *
     * Match the capitalization and spelling you want to see in the output. Pass an
     * empty array to turn biasing off, and set the strength with the
     * `keyterm_boost` option at load time. Only the streaming architectures can
     * apply this; the others throw.
     *
     * @param keyterms Terms to bias towards, e.g. `['Kubernetes', 'Ceph']`. Commas
     *   are the delimiter used internally, so terms must not contain them.
     */
    setKeyterms(keyterms) {
        for (const term of keyterms) {
            if (term.includes(',')) {
                throw new MoonshineInvalidArgumentError(`Key terms cannot contain commas, which separate them: ${term}`);
            }
        }
        wrapErrors(() => this.raw.setKeyterms(keyterms.join(',')));
    }
    /**
     * Picks the key terms out of a passage of text and biases towards them,
     * replacing any previous list.
     *
     * Where {@link setKeyterms} wants a list, this wants context: pass the
     * document on screen, the agenda for the meeting, the last few messages in the
     * thread, and the unusual words in it are found for you. A word counts as
     * unusual when the model's own tokenizer has no single symbol for it, which is
     * the case biasing helps with, so the judgment follows the language of the
     * loaded model with no word lists involved.
     *
     * Like {@link setKeyterms}, this can be called while a stream is running,
     * takes effect on the next transcription, and does not rewrite text already
     * emitted. The capitalization in the passage is what gets asked for in the
     * transcript. Only the streaming architectures can apply this; the others
     * throw.
     *
     * @param context The passage to read terms out of. Pass an empty string to
     *   turn biasing off.
     * @param maxTerms Most terms to take, 200 by default. Worth keeping modest: a
     *   long list costs accuracy on the words you did not ask for, so the terms
     *   the passage leans on hardest are kept and its long tail is dropped.
     */
    setContext(context, maxTerms = 0) {
        wrapErrors(() => this.raw.setContext(context, maxTerms));
    }
    /**
     * Creates a new streaming session.
     *
     * `updateInterval` is the seconds of new audio the stream collects before
     * {@link Stream.transcribe} will make another pass over the engine; see there
     * for why asking more often than that costs more than it returns.
     */
    createStream(options = {}) {
        const flags = options.flags ?? TranscribeFlags.None;
        const rawStream = wrapErrors(() => new this.module.Stream(this.raw, flags));
        return new Stream(rawStream, options.updateInterval);
    }
    // --- Convenience: a built-in default stream, matching Python's Transcriber. ---
    ensureDefaultStream() {
        if (!this.defaultStream)
            this.defaultStream = this.createStream();
        return this.defaultStream;
    }
    addListener(listener) {
        this.ensureDefaultStream().addListener(listener);
    }
    removeAllListeners() {
        this.defaultStream?.removeAllListeners();
    }
    start() {
        this.ensureDefaultStream().start();
    }
    addAudio(audio, sampleRate, flags = TranscribeFlags.None) {
        const stream = this.ensureDefaultStream();
        stream.addAudio(audio, sampleRate, flags);
        stream.transcribe(flags);
    }
    stop() {
        this.defaultStream?.stop();
    }
    /** Architecture-name helper for logging/UX. */
    archName(arch) {
        return modelArchToString(arch);
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        this.defaultStream?.close();
        wrapErrors(() => this.raw.close());
    }
    [Symbol.dispose]() {
        this.close();
    }
}
//# sourceMappingURL=transcriber.js.map