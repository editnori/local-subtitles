/**
 * Loads and caches the Emscripten module produced by the core build
 * (`moonshine.mjs` + `moonshine.wasm`). Everything else in the binding goes
 * through the singleton returned by {@link loadMoonshineModule}.
 */
import { toMoonshineError } from './errors.js';
let cached;
/**
 * ONNX Runtime warns "Unknown CPU vendor" the first time it builds a session
 * because browsers don't expose the host CPU vendor. The value only feeds
 * execution-provider device metadata, which the wasm CPU backend ignores.
 * Upstream stopped emitting it for wasm in ORT 1.24.3
 * (microsoft/onnxruntime#27399); drop this once the vendored ORT is newer.
 */
const SUPPRESSED_STDERR = /Unknown CPU vendor\. cpuinfo_vendor value:/;
function printErr(...args) {
    if (typeof args[0] === 'string' && SUPPRESSED_STDERR.test(args[0]))
        return;
    console.error(...args);
}
/** Absolute URL of the generated Emscripten ES module next to this file. */
function moonshineMjsUrl() {
    return new URL('./moonshine.mjs', import.meta.url).href;
}
/**
 * True when `url` is on a different origin than the current browsing context.
 * Node has no `location`, so this is always false there (no Workers involved).
 */
function isCrossOrigin(url) {
    if (typeof location === 'undefined')
        return false;
    try {
        return new URL(url, location.href).origin !== location.origin;
    }
    catch {
        return false;
    }
}
/**
 * Resolves the Emscripten factory. By default it dynamically imports the
 * sibling `./moonshine.mjs` emitted by the build; callers can inject their own
 * via {@link LoadModuleOptions.factory} for non-standard bundling.
 */
async function resolveFactory(options) {
    if (options.factory)
        return options.factory;
    // The generated ES module lives next to this file after bundling.
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - generated at build time, no types.
    const mod = await import('./moonshine.mjs');
    return (mod.default ?? mod);
}
/**
 * Module constructor args, including the cross-origin pthread workaround.
 *
 * The threaded build spawns `new Worker(moonshine.mjs)`. Browsers refuse that
 * when the script is cross-origin (e.g. jsDelivr), even with CORS — hence the
 * "cannot be accessed from origin" SecurityError. Fetching the script into a
 * Blob and passing it as `mainScriptUrlOrBlob` gives the Workers a same-origin
 * URL. `locateFile` must then pin `.wasm` (and friends) to the real script
 * directory, because `import.meta.url` inside the blob worker is `blob:`.
 */
async function emscriptenModuleArgs(options) {
    const moduleArgs = { printErr };
    const mjsUrl = moonshineMjsUrl();
    if (options.locateFile) {
        moduleArgs.locateFile = options.locateFile;
    }
    if (isCrossOrigin(mjsUrl)) {
        const response = await fetch(mjsUrl);
        if (!response.ok) {
            throw new Error(`Failed to fetch ${mjsUrl} for pthread workers (${response.status}).`);
        }
        moduleArgs.mainScriptUrlOrBlob = await response.blob();
        if (!options.locateFile) {
            moduleArgs.locateFile = (path) => new URL(path, mjsUrl).href;
        }
    }
    return moduleArgs;
}
/**
 * Loads (and memoizes) the Moonshine WASM module. Safe to call repeatedly; the
 * heavy compile happens once.
 */
export function loadMoonshineModule(options = {}) {
    if (!cached) {
        cached = (async () => {
            try {
                const factory = await resolveFactory(options);
                return await factory(await emscriptenModuleArgs(options));
            }
            catch (err) {
                cached = undefined; // allow retry on failure
                throw toMoonshineError(err);
            }
        })();
    }
    return cached;
}
/** Clears the cached module (mainly for tests). */
export function resetMoonshineModule() {
    cached = undefined;
}
//# sourceMappingURL=module.js.map