/**
 * Voice dialogs: the one-call way to build a speech interface.
 *
 * ```ts
 * const agent = new AgentFlow();
 *
 * agent.listenFor('set up wifi', async (d) => {
 *   const ssid = await d.ask("What's the name of your wifi network?");
 *   if (await d.confirm(`I heard ${ssid}. Is that right?`)) {
 *     await d.say(`Done. Connecting to ${ssid}.`);
 *   }
 * });
 *
 * await agent.load();
 * await agent.startListening();
 * ```
 *
 * `load()` downloads and wires everything a voice interface needs: a streaming
 * speech-to-text model, an embedding model for matching trigger phrases, a
 * text-to-speech voice, and a microphone. `speech(false)` and
 * `microphone(false)` each drop one of those when an application does not need
 * it. A flow is an ordinary async function, so it reads top to bottom and
 * `try` / `finally` work the way you expect.
 *
 * Scope note vs. the Python runner: this port implements free-form asks plus
 * confirm/choose matching. The alphanumeric dictation subsystem and the
 * success/error beep diagnostics are not here yet.
 */
import { AssetDownloader } from './asset-downloader.js';
import { ModelArch } from './enums.js';
import { EmbeddingModel, PhraseMatcher, } from './embedding-model.js';
import { MicTranscriber, wrapProgress, } from './mic-transcriber.js';
import { loadMoonshineModule } from './module.js';
import { TextToSpeech } from './text-to-speech.js';
const DEFAULT_YES = [
    'yes', 'yeah', 'yep', 'correct', "that's right", 'sure', 'affirmative',
    'okay', 'please do', 'do it',
];
const DEFAULT_NO = [
    'no', 'nope', 'incorrect', "that's wrong", 'negative', 'cancel',
    "don't do it", 'stop',
];
const DEFAULT_TRIGGER_THRESHOLD = 0.7;
/**
 * Prompt answers ("yes", "the blue one") are short and varied, so they match on
 * a looser threshold than trigger phrases.
 */
const PROMPT_THRESHOLD = 0.55;
/** Thrown into a flow when the user (or a global handler) cancels it. */
export class DialogCancelled extends Error {
    constructor() {
        super('DialogCancelled');
        this.name = 'DialogCancelled';
    }
}
/** Thrown into a flow when it should start again from the top. */
export class DialogRestart extends Error {
    constructor() {
        super('DialogRestart');
        this.name = 'DialogRestart';
    }
}
/** Thrown out of `ask` / `confirm` / `choose` after the retries run out. */
export class DialogNoMatch extends Error {
    constructor(message = 'No matching answer') {
        super(message);
        this.name = 'DialogNoMatch';
    }
}
/**
 * The conversation, handed to a flow as its only argument. Every method speaks
 * and then waits, so a flow is just straight-line code.
 */
export class Dialog {
    /** The phrase that started this flow. */
    triggerPhrase;
    /** Scratch space for the flow's own use; the runner never touches it. */
    state = {};
    runner;
    constructor(runner, triggerPhrase = '') {
        this.runner = runner;
        this.triggerPhrase = triggerPhrase;
    }
    /** Speaks `text` and waits for playback to finish. */
    async say(text) {
        await this.runner.speakInFlow(text);
    }
    /** Asks an open question and returns what the user said. */
    async ask(prompt, options = {}) {
        return this.runner.promptForAnswer(prompt, options, (text) => text ? { ok: true, value: text } : { ok: false });
    }
    /** Asks a yes/no question. */
    async confirm(prompt, options = {}) {
        const yes = options.yesPhrases ?? DEFAULT_YES;
        const no = options.noPhrases ?? DEFAULT_NO;
        return this.runner.promptForAnswer(prompt, {
            maxRetries: 1,
            reprompt: "Sorry, I didn't catch that. Was that a yes or a no? {prompt}",
            ...options,
        }, (text) => {
            const key = this.runner.matchKey(text, [
                { key: 'yes', phrases: yes },
                { key: 'no', phrases: no },
            ]);
            if (key === 'yes')
                return { ok: true, value: true };
            if (key === 'no')
                return { ok: true, value: false };
            return { ok: false };
        });
    }
    /**
     * Offers a set of choices and returns the key of the one picked. Each key
     * maps to the phrases that select it; the key itself always counts.
     */
    async choose(prompt, options, settings = {}) {
        return this.runner.promptForAnswer(prompt, settings, (text) => {
            // The key itself always counts as one of its phrases.
            const groups = Object.entries(options).map(([key, phrases]) => ({
                key,
                phrases: [key, ...phrases],
            }));
            const match = this.runner.matchKey(text, groups);
            return match ? { ok: true, value: match } : { ok: false };
        });
    }
    /** Abandons the flow. */
    cancel() {
        throw new DialogCancelled();
    }
    /** Runs the flow again from the beginning. */
    restart() {
        throw new DialogRestart();
    }
}
export class AgentFlow {
    flows = new Map();
    globals = new Map();
    /**
     * Globals that only mean anything while a flow is running. The built-in
     * "cancel" and "start over" are in here: matching them when nothing is
     * active would consume the line, do nothing with it, and leave a dictation
     * interface silently missing a sentence.
     */
    flowScopedGlobals = new Set();
    languageCode = 'en';
    arch = ModelArch.MediumStreaming;
    voiceId;
    wantsMicrophone = true;
    wantsSpeech = true;
    threshold = DEFAULT_TRIGGER_THRESHOLD;
    assetBase;
    context;
    progressCallback;
    speakOverride;
    heardCallbacks = [];
    saidCallbacks = [];
    errorCallbacks = [];
    unmatchedCallbacks = [];
    mod;
    sharedDownloader;
    tts;
    embedding;
    matcher = new PhraseMatcher();
    mic;
    micConstraints = true;
    ownsTts = true;
    ownsMic = true;
    activeDialog;
    activeTriggerPhrase;
    pending;
    speaking = false;
    /** Serializes utterance handling so one flow advances at a time. */
    queue = Promise.resolve();
    /**
     * Woken when the runner comes to rest, meaning the flow either finished or
     * is parked waiting for the next thing the user says. Handing an utterance
     * in resolves at that point rather than when the whole flow completes, which
     * would deadlock: the flow is waiting for the utterance after this one.
     */
    settleWaiters = [];
    constructor() {
        // "cancel" and "start over" are what people actually say to a voice
        // interface, so they work without every application registering them.
        // Both only apply to a flow in progress, so they stay out of the way of
        // whatever else the microphone is being used for. Registering either with
        // always() makes it live all the time, as any other global is.
        this.addFlowScopedGlobal('cancel', (d) => d.cancel());
        this.addFlowScopedGlobal('start over', (d) => d.restart());
    }
    addFlowScopedGlobal(phrase, handler) {
        this.globals.set(phrase, handler);
        this.flowScopedGlobals.add(phrase);
    }
    // --- Configuration ---
    /** Speech-to-text and synthesis language. Defaults to `"en"`. */
    language(code) {
        this.languageCode = code;
        return this;
    }
    /** Overrides the streaming speech-to-text model. */
    modelArch(arch) {
        this.arch = arch;
        return this;
    }
    /** Voice used for spoken prompts, e.g. `"kokoro_af_heart"`. */
    voice(id) {
        this.voiceId = id;
        return this;
    }
    /** Fetches all model assets from a base URL you host instead of the CDN. */
    modelsFrom(baseUrl) {
        this.assetBase = baseUrl;
        return this;
    }
    /** Set to false to drive the agent from text instead of a microphone. */
    microphone(enabled) {
        this.wantsMicrophone = enabled;
        return this;
    }
    /**
     * Whether {@link load} should open a synthesizer. Defaults to true. Turn it
     * off for a silent runner: prompts still reach {@link onSaid} and flows still
     * advance, they just aren't spoken, and no voice is downloaded.
     */
    speech(enabled = true) {
        this.wantsSpeech = enabled;
        return this;
    }
    /**
     * Constraints for the microphone this opens, e.g. to name a capture device
     * rather than accept the browser's default. Ignored when a transcriber is
     * supplied through {@link useMicTranscriber}, which brings its own.
     */
    audioConstraints(constraints) {
        this.micConstraints = constraints;
        return this;
    }
    /** Similarity a trigger phrase needs to match, 0 to 1. Defaults to 0.7. */
    triggerThreshold(threshold) {
        this.threshold = threshold;
        return this;
    }
    audioContext(context) {
        this.context = context;
        return this;
    }
    /** Combined download progress for every model, as a `0..1` fraction. */
    onProgress(callback) {
        this.progressCallback = callback;
        return this;
    }
    /** Called with each thing the user says. */
    onHeard(callback) {
        this.heardCallbacks.push(callback);
        return this;
    }
    /** Called with each thing the assistant says. */
    onSaid(callback) {
        this.saidCallbacks.push(callback);
        return this;
    }
    /** Called when a flow throws something the runner doesn't handle itself. */
    onError(callback) {
        this.errorCallbacks.push(callback);
        return this;
    }
    /** Replaces the built-in synthesizer, e.g. to route prompts somewhere else. */
    speakWith(speak) {
        this.speakOverride = speak;
        return this;
    }
    /** Registers a flow to run when the user says something like `phrase`. */
    listenFor(phrase, flow) {
        this.flows.set(phrase, flow);
        return this;
    }
    /**
     * Registers a handler that runs whenever `phrase` is heard, even in the
     * middle of a flow. This is how `cancel` and `start over` are implemented.
     */
    always(phrase, handler) {
        this.globals.set(phrase, handler);
        // Asking for a global by name means wanting it live, even if it is one of
        // the built-ins that is otherwise limited to a running flow.
        this.flowScopedGlobals.delete(phrase);
        return this;
    }
    /**
     * Registers a handler for speech that matched no global, no waiting prompt
     * and no trigger. This is what a dictation interface hangs its text off:
     * `onHeard` reports every line including commands and answers, while this
     * one reports only the lines nothing else claimed.
     *
     * Nothing arrives here while a flow is running, because a flow's prompts
     * take every line until it finishes.
     */
    otherwise(handler) {
        this.unmatchedCallbacks.push(handler);
        return this;
    }
    useModule(module) {
        this.mod = module;
        return this;
    }
    useDownloader(downloader) {
        this.sharedDownloader = downloader;
        return this;
    }
    useTextToSpeech(tts) {
        this.tts = tts;
        this.ownsTts = false;
        return this;
    }
    useMicTranscriber(mic) {
        this.mic = mic;
        this.ownsMic = false;
        return this;
    }
    // --- Lifecycle ---
    /** Downloads and wires every model the agent needs. */
    async load() {
        this.mod ??= await loadMoonshineModule();
        const progress = this.progressCallback;
        if (this.assetBase && !this.sharedDownloader) {
            // The embedding model is fetched through a manifest, so redirecting it to a
            // self-hosted base URL happens at the downloader.
            this.sharedDownloader = new AssetDownloader({
                baseUrl: this.assetBase,
                onProgress: wrapProgress(progress),
            });
        }
        // A runner that has been silenced, or that speaks through a callback of
        // its own, has no use for a voice and should not spend a download on one.
        if (this.wantsSpeech && !this.tts && !this.speakOverride) {
            const tts = new TextToSpeech().language(this.languageCode).useModule(this.mod);
            if (this.voiceId)
                tts.voice(this.voiceId);
            if (this.assetBase)
                tts.modelsFrom(this.assetBase);
            if (this.context)
                tts.audioContext(this.context);
            if (progress)
                tts.onProgress(progress);
            if (this.sharedDownloader)
                tts.useDownloader(this.sharedDownloader);
            this.tts = await tts.load();
        }
        if (!this.embedding) {
            this.embedding = await EmbeddingModel.load({
                module: this.mod,
                downloader: this.sharedDownloader,
                onProgress: wrapProgress(progress),
            });
            this.matcher = new PhraseMatcher(this.embedding);
        }
        if (this.wantsMicrophone && !this.mic) {
            const mic = new MicTranscriber()
                .language(this.languageCode)
                .modelArch(this.arch)
                .audioConstraints(this.micConstraints);
            if (this.assetBase)
                mic.modelsFrom(this.assetBase);
            if (progress)
                mic.onProgress(progress);
            this.mic = await mic.load();
        }
        this.mic?.addListener(this.transcriptListener());
        return this;
    }
    /** Opens the microphone and starts responding to trigger phrases. */
    async startListening() {
        if (!this.mic) {
            throw new Error('No microphone. Call load() first, or use handleUtterance() for text input.');
        }
        await this.mic.start();
    }
    async stopListening() {
        await this.mic?.stop();
    }
    /** Says something outside any flow, e.g. a welcome message. */
    async say(text) {
        if (text)
            await this.speak(text);
    }
    /**
     * Feeds in an utterance the agent didn't hear itself. Useful for text input
     * and for tests. Resolves once the flow has advanced as far as it can.
     */
    handleUtterance(text) {
        const utterance = text.trim();
        if (!utterance)
            return Promise.resolve();
        for (const cb of this.heardCallbacks)
            cb(utterance);
        this.queue = this.queue
            .then(() => this.dispatch(utterance))
            .catch(() => { });
        return this.queue;
    }
    /** True while a flow is running. */
    get isActive() {
        return this.activeDialog !== undefined;
    }
    /** The trigger phrase of the running flow, if any. */
    get activeTrigger() {
        return this.activeTriggerPhrase;
    }
    /** Abandons the running flow. Returns false if there wasn't one. */
    cancel() {
        if (!this.activeDialog)
            return false;
        this.rejectPending(new DialogCancelled());
        this.activeDialog = undefined;
        this.activeTriggerPhrase = undefined;
        return true;
    }
    close() {
        if (this.ownsMic)
            this.mic?.close();
        if (this.ownsTts)
            this.tts?.close();
        this.embedding?.close();
        this.mic = undefined;
        this.tts = undefined;
        this.embedding = undefined;
        this.matcher = new PhraseMatcher();
    }
    // --- Internals used by Dialog ---
    /** @internal */
    async speakInFlow(text) {
        await this.speak(text);
    }
    /**
     * Speaks a prompt, waits for an answer, and re-prompts until `interpret`
     * accepts one or the retries run out.
     * @internal
     */
    async promptForAnswer(prompt, options, interpret) {
        const maxRetries = options.maxRetries ?? 2;
        const reprompt = options.reprompt ?? "Sorry, I didn't catch that. {prompt}";
        for (let attempt = 0;; attempt++) {
            const line = attempt === 0 ? prompt : reprompt.replace('{prompt}', prompt);
            await this.speak(line);
            let answer;
            try {
                answer = await this.waitForAnswer(options.timeoutMs);
            }
            catch (err) {
                if (err instanceof DialogNoMatch && attempt < maxRetries)
                    continue;
                throw err;
            }
            const result = interpret(answer.trim());
            if (result.ok)
                return result.value;
            if (attempt >= maxRetries) {
                throw new DialogNoMatch(`Gave up understanding: "${answer}"`);
            }
        }
    }
    // --- Internals ---
    transcriptListener() {
        return {
            onLineCompleted: (event) => {
                if (this.speaking)
                    return; // don't transcribe our own voice
                void this.handleUtterance(event.line.text);
            },
        };
    }
    waitForAnswer(timeoutMs) {
        const answer = new Promise((resolve, reject) => {
            const entry = { resolve, reject };
            if (timeoutMs !== undefined) {
                entry.timer = setTimeout(() => {
                    if (this.pending === entry)
                        this.pending = undefined;
                    reject(new DialogNoMatch('Timed out waiting for an answer'));
                }, timeoutMs);
            }
            this.pending = entry;
        });
        this.notifySettled();
        return answer;
    }
    /** Resolves the next time the runner finishes a flow or parks on a prompt. */
    settledSignal() {
        return new Promise((resolve) => this.settleWaiters.push(resolve));
    }
    notifySettled() {
        const waiters = this.settleWaiters;
        this.settleWaiters = [];
        for (const resolve of waiters)
            resolve();
    }
    resolvePending(text) {
        const entry = this.pending;
        if (!entry)
            return false;
        this.pending = undefined;
        if (entry.timer)
            clearTimeout(entry.timer);
        entry.resolve(text);
        return true;
    }
    rejectPending(error) {
        const entry = this.pending;
        if (!entry)
            return;
        this.pending = undefined;
        if (entry.timer)
            clearTimeout(entry.timer);
        entry.reject(error);
    }
    async dispatch(utterance) {
        // Globals win over everything, so "cancel" works mid-question.
        const trigger = this.matchTrigger(utterance);
        if (trigger && this.globals.has(trigger)) {
            const settled = this.settledSignal();
            await this.invokeGlobal(trigger);
            // A global that cancelled or restarted the flow left it unwinding, so
            // wait for it to come to rest. One that just spoke did not.
            if (this.activeDialog && !this.pending)
                await settled;
            return;
        }
        if (this.pending) {
            const settled = this.settledSignal();
            this.resolvePending(utterance);
            await settled;
            return;
        }
        if (this.activeDialog)
            return; // busy between prompts; drop the line
        if (trigger && this.flows.has(trigger)) {
            const settled = this.settledSignal();
            void this.runFlow(trigger);
            await settled;
            return;
        }
        // Nothing in the agent's domain wanted this line, so hand it to whoever
        // asked for the leftovers. Awaited, so that a handler doing async work
        // still sees utterances in the order they were spoken.
        for (const handler of this.unmatchedCallbacks)
            await handler(utterance);
    }
    matchTrigger(utterance) {
        const phrases = [...this.liveGlobals(), ...this.flows.keys()];
        if (phrases.length === 0)
            return undefined;
        return this.matcher.matchPhrases(utterance, phrases, this.threshold);
    }
    /**
     * The globals worth matching right now. Flow-scoped ones are offered only
     * while a flow is running, so with nothing active their phrases reach
     * `otherwise()` like any other speech.
     */
    liveGlobals() {
        const phrases = [...this.globals.keys()];
        if (this.flowScopedGlobals.size === 0)
            return phrases;
        if (this.activeDialog !== undefined || this.pending !== undefined)
            return phrases;
        return phrases.filter((phrase) => !this.flowScopedGlobals.has(phrase));
    }
    /**
     * The key of the group whose phrases best match `utterance`, used by
     * `Dialog.confirm` and `Dialog.choose`.
     *
     * @internal
     */
    matchKey(utterance, groups) {
        return this.matcher.match(utterance, groups, PROMPT_THRESHOLD);
    }
    async runFlow(triggerPhrase) {
        const flow = this.flows.get(triggerPhrase);
        if (!flow)
            return;
        try {
            for (;;) {
                const dialog = new Dialog(this, triggerPhrase);
                this.activeDialog = dialog;
                this.activeTriggerPhrase = triggerPhrase;
                try {
                    await flow(dialog);
                    return;
                }
                catch (err) {
                    if (err instanceof DialogRestart)
                        continue; // round again
                    if (err instanceof DialogCancelled)
                        return;
                    if (err instanceof DialogNoMatch) {
                        await this.speak("Sorry, I didn't get that. Let's start over.");
                        return;
                    }
                    for (const cb of this.errorCallbacks) {
                        cb(err instanceof Error ? err : new Error(String(err)));
                    }
                    return;
                }
            }
        }
        finally {
            this.activeDialog = undefined;
            this.activeTriggerPhrase = undefined;
            this.notifySettled();
        }
    }
    async invokeGlobal(triggerPhrase) {
        const handler = this.globals.get(triggerPhrase);
        if (!handler)
            return;
        const dialog = this.activeDialog ?? new Dialog(this, triggerPhrase);
        try {
            await handler(dialog);
        }
        catch (err) {
            if (err instanceof DialogCancelled || err instanceof DialogRestart) {
                // Hand the interruption to the flow, which is parked in an `await`.
                if (this.pending) {
                    this.rejectPending(err);
                }
                else if (err instanceof DialogCancelled) {
                    this.activeDialog = undefined;
                    this.activeTriggerPhrase = undefined;
                }
                return;
            }
            throw err;
        }
    }
    async speak(text) {
        if (!text)
            return;
        for (const cb of this.saidCallbacks)
            cb(text);
        this.speaking = true;
        this.mic?.mute(true);
        try {
            if (this.speakOverride) {
                await this.speakOverride(text);
            }
            else if (this.tts) {
                await this.tts.say(text);
            }
            else {
                // eslint-disable-next-line no-console
                console.log(`[AgentFlow] ${text}`);
            }
        }
        finally {
            this.mic?.mute(false);
            this.speaking = false;
        }
    }
}
/** Renders a string as a space-separated spoken form for reading back. */
export function spellOut(value) {
    return value.split('').join(' ');
}
//# sourceMappingURL=agent-flow.js.map