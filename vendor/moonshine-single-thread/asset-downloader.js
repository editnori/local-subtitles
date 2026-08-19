/**
 * Fetches model assets from the Moonshine CDN and caches them in the browser,
 * driven by the JSON manifest helpers in the C ABI (so we never re-implement
 * the file/URL layout in JS). Mirrors the download flow of the Python/Swift/
 * Android bindings, adapted to `fetch` + the Cache API.
 */
import { MoonshineDownloadError } from './errors.js';
const DEFAULT_CACHE = 'moonshine-models-v1';
/**
 * Downloads model files with transparent caching. A single instance can be
 * reused across models; entries are keyed by absolute URL.
 */
export class AssetDownloader {
    cacheName;
    onProgress;
    baseUrl;
    session;
    constructor(options = {}) {
        this.cacheName = options.cacheName ?? DEFAULT_CACHE;
        this.onProgress = options.onProgress;
        this.baseUrl = options.baseUrl;
    }
    /**
     * Downloads every file listed in a `{groups:[...]}` manifest (STT / embedding),
     * returning them keyed by canonical filename.
     */
    async downloadManifest(manifestJson) {
        let manifest;
        try {
            manifest = JSON.parse(manifestJson);
        }
        catch (err) {
            throw new MoonshineDownloadError(`Failed to parse model manifest: ${err.message}`);
        }
        const groups = manifest.groups ?? [];
        return this.inSession(declaredTotalBytes(groups), async () => {
            const out = new Map();
            for (const group of groups) {
                for (const file of group.files) {
                    const url = this.baseUrl
                        ? joinUrl(this.baseUrl, file.name)
                        : (file.url ?? joinUrl(group.base_url, file.name));
                    const bytes = await this.fetchFile(url);
                    if (typeof file.size === 'number' &&
                        file.size >= 0 &&
                        bytes.byteLength !== file.size) {
                        throw new MoonshineDownloadError(`Size mismatch for ${file.name}: expected ${file.size} bytes, ` +
                            `got ${bytes.byteLength} (from ${url})`);
                    }
                    out.set(file.name, bytes);
                }
            }
            return out;
        });
    }
    /** Downloads a flat list of URLs, returning bytes keyed by basename. */
    async downloadFiles(urls) {
        return this.inSession(undefined, async () => {
            const out = new Map();
            for (const url of urls) {
                out.set(basename(url), await this.fetchFile(url));
            }
            return out;
        });
    }
    /**
     * Downloads a map of canonical filename -> URL, returning bytes keyed by the
     * supplied filename (not the URL basename). Use this when the caller controls
     * the canonical keys, e.g. feeding a transcriber's in-memory loader.
     */
    async downloadNamedFiles(files) {
        const entries = files instanceof Map ? [...files.entries()] : Object.entries(files);
        return this.inSession(undefined, async () => {
            const out = new Map();
            for (const [name, url] of entries) {
                out.set(name, await this.fetchFile(url));
            }
            return out;
        });
    }
    /** Fetches a single URL, using the Cache API when available. */
    async fetchFile(url) {
        const cache = await this.openCache();
        if (cache) {
            const hit = await cache.match(url);
            if (hit) {
                const buf = await hit.arrayBuffer();
                this.reportProgress(buf.byteLength, buf.byteLength, basename(url));
                this.finishFile(buf.byteLength);
                return new Uint8Array(buf);
            }
        }
        const response = await fetch(url);
        if (!response.ok) {
            throw new MoonshineDownloadError(`Failed to download ${url}: ${response.status} ${response.statusText}`);
        }
        const buf = await this.readWithProgress(response, basename(url));
        if (cache) {
            // Chrome extension Cache Storage can reject a cloned cross-origin
            // response even after a successful CORS fetch. Store extension-owned
            // bytes instead, and never discard a valid model if caching fails.
            try {
                await cache.put(url, new Response(buf.slice(0), {
                    headers: {
                        'content-type': 'application/octet-stream',
                        'content-length': String(buf.byteLength),
                    },
                }));
            }
            catch (error) {
                console.warn(`Could not cache ${basename(url)}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        this.finishFile(buf.byteLength);
        return new Uint8Array(buf);
    }
    /**
     * Runs `body` as a single accounted download, so progress is reported
     * against the whole set of files rather than restarting at zero for each.
     * Nested calls (a shared downloader fetching several models) each get their
     * own accounting and restore the outer one when they finish.
     */
    async inSession(totalBytes, body) {
        const outer = this.session;
        this.session = { totalBytes, completedBytes: 0 };
        try {
            return await body();
        }
        finally {
            this.session = outer;
        }
    }
    /** Rolls a finished file's bytes into the running total. */
    finishFile(bytes) {
        if (this.session)
            this.session.completedBytes += bytes;
    }
    reportProgress(loadedInFile, fileTotal, file) {
        if (!this.onProgress)
            return;
        if (!this.session) {
            this.onProgress(loadedInFile, fileTotal, file);
            return;
        }
        this.onProgress(this.session.completedBytes + loadedInFile, this.session.totalBytes, file);
    }
    async readWithProgress(response, file) {
        const total = Number(response.headers.get('content-length')) || undefined;
        if (!response.body || !this.onProgress) {
            const buf = await response.arrayBuffer();
            this.reportProgress(buf.byteLength, total, file);
            return buf;
        }
        const reader = response.body.getReader();
        const chunks = [];
        let loaded = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                break;
            if (value) {
                chunks.push(value);
                loaded += value.byteLength;
                this.reportProgress(loaded, total, file);
            }
        }
        const merged = new Uint8Array(loaded);
        let offset = 0;
        for (const chunk of chunks) {
            merged.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return merged.buffer;
    }
    async openCache() {
        try {
            if (typeof caches !== 'undefined') {
                return await caches.open(this.cacheName);
            }
        }
        catch {
            // Cache API not available (e.g. non-secure context / Node) — skip.
        }
        return undefined;
    }
}
/**
 * Total size of a manifest, or undefined if any file leaves its size out.
 * Partial sums would understate the download and make the bar run backwards,
 * so an incomplete manifest is treated as no answer at all.
 */
function declaredTotalBytes(groups) {
    let total = 0;
    for (const group of groups) {
        for (const file of group.files ?? []) {
            if (typeof file.size !== 'number' || !(file.size >= 0))
                return undefined;
            total += file.size;
        }
    }
    return total;
}
function joinUrl(base, file) {
    return `${base.replace(/\/+$/, '')}/${file.replace(/^\/+/, '')}`;
}
function basename(url) {
    const clean = url.split(/[?#]/)[0];
    const idx = clean.lastIndexOf('/');
    return idx >= 0 ? clean.slice(idx + 1) : clean;
}
//# sourceMappingURL=asset-downloader.js.map
