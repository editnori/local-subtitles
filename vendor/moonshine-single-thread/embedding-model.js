/**
 * Text embeddings: turns text into vectors and scores them against each other.
 *
 * This is internal to the binding. {@link AgentFlow} is the supported way to
 * match spoken phrases; it owns a model and compares utterances to phrases
 * itself, so nothing here is exported from the package entry point.
 *
 * The embedding model ships as a single all-in-one `.ort` file (plus
 * `tokenizer.bin`) and is loaded entirely from in-memory buffers via the
 * `moonshine_create_embedding_model_from_memory` C ABI — the browser has no
 * natural filesystem, so nothing is staged to disk.
 */
import { AssetDownloader } from './asset-downloader.js';
import { EmbeddingModelArch } from './enums.js';
import { wrapErrors } from './errors.js';
import { loadMoonshineModule, } from './module.js';
export class EmbeddingModel {
    raw;
    constructor(raw) {
        this.raw = raw;
    }
    static async load(options = {}) {
        const module = options.module ?? (await loadMoonshineModule(options.moduleOptions));
        const arch = options.modelArch ?? EmbeddingModelArch.Gemma300M;
        const variant = options.variant ?? '';
        const downloader = options.downloader ?? new AssetDownloader({ onProgress: options.onProgress });
        const manifest = module.embeddingDependencies(options.modelName ?? '', variant);
        const files = await downloader.downloadManifest(manifest);
        return EmbeddingModel.construct(module, files, arch, variant);
    }
    /**
     * Loads the embedding model from a caller-supplied map of canonical filename
     * -> URL (e.g. `{ 'model_q4.ort': '...', 'tokenizer.bin': '...' }`), for
     * self-hosting the model files instead of using the Moonshine CDN.
     */
    static async loadFromUrls(files, options = {}) {
        const module = options.module ?? (await loadMoonshineModule(options.moduleOptions));
        const arch = options.modelArch ?? EmbeddingModelArch.Gemma300M;
        const downloader = options.downloader ?? new AssetDownloader({ onProgress: options.onProgress });
        const bytes = await downloader.downloadNamedFiles(files);
        return EmbeddingModel.construct(module, bytes, arch, options.variant ?? '');
    }
    static construct(module, files, arch, variant) {
        const keys = [...files.keys()];
        const buffers = keys.map((k) => files.get(k));
        const raw = wrapErrors(() => new module.EmbeddingModel(keys, buffers, arch, variant));
        return new EmbeddingModel(raw);
    }
    /** The embedding vector for `sentence`. */
    calculateEmbedding(sentence) {
        return wrapErrors(() => this.raw.calculateEmbedding(sentence));
    }
    /** Cosine similarity between two embeddings of equal length, in `[-1, 1]`. */
    distance(embeddingA, embeddingB) {
        return wrapErrors(() => this.raw.distance(embeddingA, embeddingB));
    }
    close() {
        wrapErrors(() => this.raw.close());
    }
    [Symbol.dispose]() {
        this.close();
    }
}
/**
 * Matches an utterance to one of several phrase groups by meaning.
 *
 * Each phrase is embedded once and cached, the utterance is embedded once per
 * call, and the key of the best-scoring phrase at or above `threshold` wins.
 * Without an {@link EmbeddingModel} it falls back to case-insensitive substring
 * matching, which is what keeps dialogs working before {@link AgentFlow.load}.
 */
export class PhraseMatcher {
    model;
    cache = new Map();
    constructor(model) {
        this.model = model;
    }
    /** The best-matching key, or undefined when nothing clears `threshold`. */
    match(utterance, groups, threshold) {
        if (!utterance || groups.length === 0)
            return undefined;
        const model = this.model;
        if (!model) {
            const lower = utterance.toLowerCase();
            return groups.find((group) => group.phrases.some((phrase) => {
                const needle = phrase.toLowerCase();
                return needle.length > 0 && lower.includes(needle);
            }))?.key;
        }
        let utteranceEmbedding;
        try {
            utteranceEmbedding = model.calculateEmbedding(utterance);
        }
        catch {
            return undefined;
        }
        let bestKey;
        let bestScore = -1;
        for (const group of groups) {
            for (const phrase of group.phrases) {
                if (!phrase)
                    continue;
                try {
                    const score = model.distance(utteranceEmbedding, this.embeddingFor(phrase, model));
                    if (score > bestScore) {
                        bestScore = score;
                        bestKey = group.key;
                    }
                }
                catch {
                    // A phrase we cannot embed simply does not match.
                }
            }
        }
        return bestScore >= threshold ? bestKey : undefined;
    }
    /** The best-matching phrase, treating each phrase as its own key. */
    matchPhrases(utterance, phrases, threshold) {
        return this.match(utterance, phrases.map((phrase) => ({ key: phrase, phrases: [phrase] })), threshold);
    }
    embeddingFor(phrase, model) {
        const cached = this.cache.get(phrase);
        if (cached)
            return cached;
        const computed = model.calculateEmbedding(phrase);
        this.cache.set(phrase, computed);
        return computed;
    }
}
//# sourceMappingURL=embedding-model.js.map