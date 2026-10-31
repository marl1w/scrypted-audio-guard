// Lifecycle of one camera's audio process: start, restart with backoff, watchdog, "no audio" (no audio track) with a long
// backoff, and the hold timer. Digital silence is only a status: the process keeps running and detecting. The process itself is injected (src/source.ts in the plugin, a fake in the tests), and so is the clock.

import { AudioDetector, PushResult } from './detector';
import { WindowLevel } from './pcm';
import { MinuteCounter } from './status';
import { backoffMs, maskUrls } from './util';

export interface AudioProcess {
    stop(): void;
    /** resolves when the process has ended: undefined for a clean end, else the reason. */
    exited: Promise<string | undefined>;
}

export type AudioStarter = (onWindow: (w: WindowLevel) => void) => Promise<AudioProcess>;

export interface Timers {
    now(): number;
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(h: unknown): void;
    /** 0..1, for the jitter (Math.random in the plugin, fixed in the tests) */
    random(): number;
}

export const realTimers: Timers = {
    now: () => performance.now(),
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
    clearTimeout: h => clearTimeout(h as NodeJS.Timeout),
    random: () => Math.random(),
};

/** the first start waits a random 0..START_JITTER_MS, so cameras do not all spawn ffmpeg at the same moment. */
export const START_JITTER_MS = 3000;
/** a change of the camera's streams restarts a "no audio" camera after this (several setting events come together). */
export const STREAMS_CHANGED_MS = 2000;
/** delays are multiplied by 0.8..1.2 */
export function jitter(r: number): number {
    return 0.8 + 0.4 * r;
}

/** reason prefix of a process that ended because the stream has no audio track. */
export const NO_AUDIO_TRACK = 'no audio track';

/** restart after a failure: 1 s doubling per consecutive failure, at most 60 s (as Coral Guard's frame process). */
export function restartDelayMs(attempt: number): number {
    return backoffMs(attempt, 1000, 60_000);
}
/** check a camera without audio again after 5 min, doubling per consecutive check that finds none, at most 1 h. */
export function noAudioDelayMs(count: number): number {
    return backoffMs(count, 5 * 60_000, 60 * 60_000);
}
/** a run that delivered audio for this long resets the restart backoff. */
export const CLEAN_RUN_MS = 60_000;
/** no window for this long: the process is stuck (stalled stream), kill it and restart. */
export const WATCHDOG_MS = 30_000;

export type RunnerState = 'stopped' | 'starting' | 'running' | 'restarting' | 'no audio';

export interface RunnerEvents {
    onDetected(on: boolean): void;
    /** every window, after the detector (the status history): must be O(1) */
    onLevel?(w: WindowLevel, r: PushResult, now: number): void;
    log(msg: string): void;
    warn(msg: string): void;
}

export class AudioRunner {
    state: RunnerState = 'stopped';
    /** the camera's streams have no audio track; cleared by the first audio window of a later check */
    noAudio: string | undefined;
    /** monotonic time of the next start while restarting or in "no audio" */
    nextStartAt: number | undefined;
    lastError: string | undefined;
    starts = 0;
    /** restarts after a failure (ended, stalled, start failed), per minute over the last hour */
    readonly restarts = new MinuteCounter();

    private proc: AudioProcess | undefined;
    private gen = 0;
    private attempt = 0;
    private noAudioCount = 0;
    /** fixed per camera: the long "no audio" checks of many cameras spread out and stay spread */
    private noAudioJitter: number;
    private started = false;
    private restartTimer: unknown;
    private watchdog: unknown;
    private holdTimer: unknown;
    private lastWindowAt = 0;
    private firstWindowAt: number | undefined;
    private wanted = false;

    constructor(private starter: AudioStarter, readonly detector: AudioDetector, private ev: RunnerEvents, private t: Timers = realTimers) {
        this.noAudioJitter = jitter(t.random());
    }

    /** digital silence (a status only) */
    get silent(): boolean {
        return this.detector.silent;
    }

    start() {
        this.wanted = true;
        if (this.state !== 'stopped')
            return;
        if (this.started) {
            this.spawn();
            return;
        }
        // first start only: a random delay spreads the cameras' ffmpeg starts when the plugin loads
        this.started = true;
        this.state = 'restarting';
        const delay = Math.round(this.t.random() * START_JITTER_MS);
        this.nextStartAt = this.t.now() + delay;
        this.restartTimer = this.t.setTimeout(() => {
            this.restartTimer = undefined;
            if (this.wanted && this.state === 'restarting')
                this.spawn();
        }, delay);
    }

    /** The camera's stream settings or options changed: a "no audio" camera is checked again soon, from a fresh backoff. */
    streamsChanged() {
        this.noAudioCount = 0;
        if (!this.wanted || this.state !== 'no audio')
            return;
        this.t.clearTimeout(this.restartTimer);
        this.nextStartAt = this.t.now() + STREAMS_CHANGED_MS;
        this.restartTimer = this.t.setTimeout(() => {
            this.restartTimer = undefined;
            if (this.wanted && this.state === 'no audio')
                this.spawn();
        }, STREAMS_CHANGED_MS);
    }

    stop() {
        this.wanted = false;
        this.gen++;
        this.t.clearTimeout(this.restartTimer);
        this.t.clearTimeout(this.watchdog);
        this.t.clearTimeout(this.holdTimer);
        this.restartTimer = this.watchdog = this.holdTimer = undefined;
        this.proc?.stop();
        this.proc = undefined;
        this.state = 'stopped';
        this.nextStartAt = undefined;
        if (this.detector.clear())
            this.ev.onDetected(false);
    }

    /** settings changed (hold): re-check the hold timer. */
    rearmHold() {
        this.t.clearTimeout(this.holdTimer);
        this.holdTimer = undefined;
        if (this.detector.expireAt(this.t.now()))
            this.ev.onDetected(false);
        this.armHold();
    }

    private spawn() {
        const gen = ++this.gen;
        this.state = 'starting';
        this.nextStartAt = undefined;
        this.starts++;
        this.firstWindowAt = undefined;
        this.detector.resetRun();
        this.lastWindowAt = this.t.now();
        this.armWatchdog(gen);
        this.starter(w => this.onWindow(gen, w)).then(p => {
            if (gen !== this.gen) {
                p.stop();
                return;
            }
            this.proc = p;
            this.state = 'running';
            p.exited.then(err => this.onExit(gen, err));
        }, e => {
            const msg = maskUrls(String(e?.message || e));
            this.onExit(gen, msg.startsWith(NO_AUDIO_TRACK) ? msg : `start failed: ${msg}`);
        });
    }

    private onWindow(gen: number, w: WindowLevel) {
        if (gen !== this.gen)
            return;
        const now = this.t.now();
        this.lastWindowAt = now;
        this.firstWindowAt ??= now;
        if (this.noAudio) {
            // any window means the stream has an audio track now
            this.ev.log(`audio track found (${this.noAudio} before)`);
            this.noAudio = undefined;
            this.noAudioCount = 0;
        }
        const r = this.detector.push(w, now);
        this.ev.onLevel?.(w, r, now);
        if (r.silentChanged)
            this.ev.log(this.detector.silent ? 'the audio is digital silence (still listening)' : 'the audio is no longer digital silence');
        if (r.rebaselined)
            this.ev.log('the background got louder and stayed: noise floor rebuilt');
        if (r.changed) {
            this.ev.onDetected(r.detected);
            if (r.detected)
                this.armHold();
        }
    }

    private armHold() {
        if (this.holdTimer !== undefined || !this.detector.detected)
            return;
        const left = Math.max(1, this.detector.holdLeft(this.t.now()));
        this.holdTimer = this.t.setTimeout(() => {
            this.holdTimer = undefined;
            if (this.detector.expireAt(this.t.now()))
                this.ev.onDetected(false);
            else
                this.armHold();
        }, left);
    }

    private armWatchdog(gen: number) {
        this.t.clearTimeout(this.watchdog);
        this.watchdog = this.t.setTimeout(() => {
            this.watchdog = undefined;
            if (gen !== this.gen)
                return;
            const idle = this.t.now() - this.lastWindowAt;
            if (idle >= WATCHDOG_MS) {
                this.ev.warn(`no audio data for ${Math.round(idle / 1000)} s, restarting`);
                this.kill();
                this.ended('no audio data (stalled)');
                return;
            }
            this.armWatchdog(gen);
        }, Math.max(1000, WATCHDOG_MS - (this.t.now() - this.lastWindowAt)));
    }

    /** stops the current process; its exit and late windows are ignored from now on (new generation). */
    private kill() {
        this.gen++;
        this.t.clearTimeout(this.watchdog);
        this.watchdog = undefined;
        this.proc?.stop();
        this.proc = undefined;
    }

    private onExit(gen: number, err: string | undefined) {
        if (gen !== this.gen)
            return; // stopped or replaced on purpose
        this.kill();
        this.ended(err);
    }

    /** the process is gone (ended, failed to start, stalled): "no audio" or a restart with backoff. */
    private ended(err: string | undefined) {
        if (!this.wanted)
            return;
        if (this.detector.clear())
            this.ev.onDetected(false);
        if (err && err.startsWith(NO_AUDIO_TRACK)) {
            this.enterNoAudio(NO_AUDIO_TRACK);
            return;
        }
        const now = this.t.now();
        if (this.firstWindowAt !== undefined && now - this.firstWindowAt >= CLEAN_RUN_MS)
            this.attempt = 0;
        this.lastError = err || 'ended';
        this.restarts.add(now);
        const delay = Math.round(restartDelayMs(this.attempt++) * jitter(this.t.random()));
        if (this.attempt === 1)
            this.ev.warn(`audio process ended (${maskUrls(this.lastError)}); restarting with backoff`);
        this.state = 'restarting';
        this.nextStartAt = now + delay;
        this.t.clearTimeout(this.restartTimer);
        this.restartTimer = this.t.setTimeout(() => {
            this.restartTimer = undefined;
            if (this.wanted && this.state === 'restarting')
                this.spawn();
        }, delay);
    }

    private enterNoAudio(reason: string) {
        this.kill();
        if (this.detector.clear())
            this.ev.onDetected(false);
        const first = !this.noAudio;
        this.noAudio = reason;
        const delay = Math.round(noAudioDelayMs(this.noAudioCount++) * this.noAudioJitter);
        if (first)
            this.ev.warn(`no audio (${reason}); checking again in ${Math.round(delay / 60_000)} min, then less often`);
        this.state = 'no audio';
        this.nextStartAt = this.t.now() + delay;
        this.t.clearTimeout(this.restartTimer);
        this.restartTimer = this.t.setTimeout(() => {
            this.restartTimer = undefined;
            if (this.wanted && this.state === 'no audio')
                this.spawn();
        }, delay);
    }
}
