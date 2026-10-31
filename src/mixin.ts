import sdk, { AudioSensor, EventListenerRegister, ScryptedInterface, Setting, SettingValue, VideoCamera } from '@scrypted/sdk';
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from '@scrypted/sdk/settings-mixin';
import { StorageSettings } from '@scrypted/sdk/storage-settings';

import { BACKGROUND_CHECK, backgroundCheckOn, backgroundReason, Hearing } from './background';
import { AudioDetector, DEFAULT_DETECTOR, DEFAULT_DURATION_S, DEFAULT_HOLD_S, DEFAULT_IMPULSE_DB, DEFAULT_IMPULSE_LEVEL_DB, DEFAULT_MIN_LEVEL_DB, DEFAULT_SENSITIVITY_DB } from './detector';
import { candidates, FallbackStarter } from './fallback';
import { OverviewCamera } from './overview';
import { MIN_DB, WINDOW_MS } from './pcm';
import { AudioRunner, AudioStarter, realTimers, Timers } from './runner';
import { startAudio, STREAM_RESOLVE_MS } from './source';
import { ActivityRing, C, MinuteCounter, relTime, renderStatus } from './status';
import { clockTime, maskUrls, withTimeout } from './util';

export const SENSITIVITY_RANGE: [number, number] = [6, 40];
export const HOLD_RANGE: [number, number] = [1, 600];
export const LEVEL_RANGE: [number, number] = [-90, 0];
export const DURATION_RANGE: [number, number] = [0.2, 10];
export const IMPULSE_RANGE: [number, number] = [6, 60];

function clamp(v: unknown, [lo, hi]: [number, number], dflt: number): number {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}

/** the numeric settings: range and default, clamped when read and when saved */
const NUMBERS: Record<string, [[number, number], number]> = {
    sensitivity: [SENSITIVITY_RANGE, DEFAULT_SENSITIVITY_DB],
    minLevel: [LEVEL_RANGE, DEFAULT_MIN_LEVEL_DB],
    duration: [DURATION_RANGE, DEFAULT_DURATION_S],
    impulse: [IMPULSE_RANGE, DEFAULT_IMPULSE_DB],
    impulseLevel: [LEVEL_RANGE, DEFAULT_IMPULSE_LEVEL_DB],
    hold: [HOLD_RANGE, DEFAULT_HOLD_S],
};

export interface MixinHost {
    ffmpegPath(): Promise<string>;
    /** tests replace the ffmpeg process */
    starter?: (m: AudioGuardMixin) => AudioStarter;
    /** tests replace the clock */
    timers?: Timers;
    /** plugin-wide counters: 100 ms windows of all cameras (the provider's throughput figure) */
    totals?: { windows: number };
    /** the background check: what the other listening cameras heard last (none without the provider) */
    otherListeners?(self: AudioGuardMixin): Hearing[];
}

export class AudioGuardMixin extends SettingsMixinDeviceBase<VideoCamera> implements AudioSensor {
    storageSettings = new StorageSettings(this, {
        enabled: {
            title: 'Enabled',
            description: 'Listen to this camera. Off stops its audio process.',
            type: 'boolean',
            defaultValue: true,
            onPut: () => this.sync(),
        },
        sensitivity: {
            title: 'Sensitivity (dB)',
            description: `A sustained sound (voices, steps): how far above the camera's own background it must be (${SENSITIVITY_RANGE[0]} to ${SENSITIVITY_RANGE[1]} dB; lower is more sensitive).`,
            type: 'number',
            defaultValue: DEFAULT_SENSITIVITY_DB,
            onPut: () => this.configure(),
        },
        minLevel: {
            title: 'Minimum level (dBFS)',
            description: 'A sustained sound must also be at least this loud. Keeps the camera\'s own faint noise out.',
            type: 'number',
            defaultValue: DEFAULT_MIN_LEVEL_DB,
            onPut: () => this.configure(),
        },
        duration: {
            title: 'Minimum duration (s)',
            description: 'How long a sustained sound must last. Pauses of up to 0.2 s (between words or steps) do not end it.',
            type: 'number',
            defaultValue: DEFAULT_DURATION_S,
            onPut: () => this.configure(),
        },
        impulse: {
            title: 'Loud sound above the background (dB)',
            description: 'A short sound (a bang, a door, breaking glass) counts at once, however short, when it is this far above the background...',
            type: 'number',
            defaultValue: DEFAULT_IMPULSE_DB,
            onPut: () => this.configure(),
        },
        impulseLevel: {
            title: 'Loud sound level (dBFS)',
            description: '...and at least this loud.',
            type: 'number',
            defaultValue: DEFAULT_IMPULSE_LEVEL_DB,
            onPut: () => this.configure(),
        },
        hold: {
            title: 'Hold (s)',
            description: 'How long the sensor stays on after the last loud sound, counted from when it turned on (with 3 or more cameras listening, a sound is published 1 s late by the background check).',
            type: 'number',
            defaultValue: DEFAULT_HOLD_S,
            onPut: () => this.configure(),
        },
    });

    readonly detector: AudioDetector;
    readonly runner: AudioRunner;
    readonly fallback: FallbackStarter;
    /** the last 10 min, one bucket per second (Status setting) */
    readonly activity = new ActivityRing();
    /** sounds (audioDetected turned on) per minute over the last hour (plugin overview) */
    readonly detections = new MinuteCounter();
    private released = false;
    /** the background check of a new sound: it waits BACKGROUND_CHECK.delayMs for the other cameras before it is published */
    private pending: unknown;
    /** after the detector's hold, the sensor stays on until Hold after it turned on */
    private offTimer: unknown;
    /** when audioDetected turned on (monotonic ms) */
    private onSince = 0;
    /** the sound going on was found to be background: not published, and not checked again until it ends */
    background = false;
    /** rate limit of the "sound ignored" log */
    private ignoredLog = { at: -Infinity, more: 0 };
    private listeners: EventListenerRegister[] = [];

    constructor(options: SettingsMixinDeviceOptions<VideoCamera>, private host: MixinHost) {
        super(options);
        this.detector = new AudioDetector({ ...DEFAULT_DETECTOR, ...this.tuning() });
        const camera = this.mixinDevice as VideoCamera;
        this.fallback = new FallbackStarter(
            async () => candidates(typeof camera.getVideoStreamOptions === 'function'
                ? await withTimeout(camera.getVideoStreamOptions(), STREAM_RESOLVE_MS, 'getVideoStreamOptions').catch(() => undefined)
                : undefined),
            (c, tried, onWindow) => startAudio({ camera, console: this.console, ffmpegPath: () => this.host.ffmpegPath(), onWindow, request: c.request, tried }),
            m => this.console.log(m),
        );
        const starter: AudioStarter = host.starter?.(this) ?? this.fallback.start;
        this.runner = new AudioRunner(starter, this.detector, {
            onDetected: (on, forced) => this.publish(on, forced),
            onLevel: (w, r, now) => this.record(w.sustainedDb, r.spike, now),
            log: m => this.console.log(m),
            warn: m => this.console.warn(maskUrls(m)),
        }, host.timers ?? realTimers);
        // a value left on by a previous run (plugin restart mid-hold) must not stay on
        if (this.audioDetected)
            this.audioDetected = false;
        // the camera's stream settings or options changed (Rebroadcast, the camera plugin): a "no audio" camera is checked again
        for (const event of [ScryptedInterface.Settings, ScryptedInterface.VideoCamera]) {
            try {
                this.listeners.push(sdk.systemManager.listenDevice(this.id, { event }, () => this.streamsChanged()));
            }
            catch { /* no listener: the periodic checks still run */ }
        }
        this.sync();
    }

    /** a numeric setting, clamped to its range */
    private num(key: string): number {
        const [range, dflt] = NUMBERS[key];
        return clamp((this.storageSettings.values as any)[key], range, dflt);
    }

    private tuning() {
        return {
            sensitivityDb: this.num('sensitivity'),
            holdMs: this.num('hold') * 1000,
            absMinDb: this.num('minLevel'),
            minSustainedWindows: Math.round((this.num('duration') * 1000) / WINDOW_MS),
            impulseDb: this.num('impulse'),
            impulseMinDb: this.num('impulseLevel'),
        };
    }

    private configure() {
        this.detector.configure(this.tuning());
        this.runner.rearmHold();
    }

    /** ffmpeg runs only while the mixin exists (the user enabled the extension) and its Enabled setting is on. */
    private sync() {
        if (this.released)
            return;
        if (this.storageSettings.values.enabled !== false)
            this.runner.start();
        else {
            this.runner.stop();
            this.soundEnded(true);
        }
    }

    streamsChanged() {
        if (this.released)
            return;
        this.fallback.reset();
        this.runner.streamsChanged();
    }

    private get timers(): Timers {
        return this.host.timers ?? realTimers;
    }

    /** The detector turned on or off: audioDetected follows, after the background check and for at least Hold. */
    private publish(on: boolean, forced = false) {
        if (this.released)
            return;
        if (on)
            this.soundStarted();
        else
            this.soundEnded(forced);
    }

    private soundStarted() {
        this.timers.clearTimeout(this.offTimer);
        this.offTimer = undefined;
        if (this.audioDetected || this.pending !== undefined)
            return;
        if (!backgroundCheckOn(this.host.otherListeners?.(this).length ?? 0)) {
            this.turnOn();
            return;
        }
        // wait for the other cameras: a sound most of them hear alike at the same moment is background (wind, rain, a distant bang)
        const at = this.detector.soundStartAt ?? this.now();
        this.pending = this.timers.setTimeout(() => this.check(at), BACKGROUND_CHECK.delayMs);
    }

    private check(at: number) {
        this.pending = undefined;
        if (this.released)
            return;
        if (this.runner.state !== 'running') {
            this.console.log('background check: a pending sound was dropped, the audio stopped');
            return;
        }
        const why = backgroundReason(at, this.detector.lastSpikeExcessDb ?? 0, this.host.otherListeners?.(this) ?? []);
        if (why) {
            // not cleared: a sound that keeps going is not checked again; it ends with the detector's hold
            this.background = this.detector.detected;
            this.logIgnored(why);
            return;
        }
        this.turnOn();
        if (!this.detector.detected)
            this.soundEnded(false); // a Hold shorter than the check: on for Hold from now
    }

    private logIgnored(why: string) {
        const now = this.now(), l = this.ignoredLog;
        if (now - l.at < BACKGROUND_CHECK.logEveryMs) {
            l.more++;
            return;
        }
        this.console.log(`background check: sound ignored, ${why}${l.more ? ` (and ${l.more} more since the last line)` : ''}`);
        this.ignoredLog = { at: now, more: 0 };
    }

    private turnOn() {
        this.onSince = this.now();
        this.detections.add(this.onSince);
        this.audioDetected = true;
    }

    private soundEnded(forced: boolean) {
        this.background = false;
        if (forced) {
            // the audio stopped (disabled, ended, released): nothing waits
            if (this.pending !== undefined) {
                this.timers.clearTimeout(this.pending);
                this.pending = undefined;
                this.console.log('background check: a pending sound was dropped, the audio stopped');
            }
            this.turnOff();
            return;
        }
        // the check decides (and counts Hold from then)
        if (this.pending !== undefined || !this.audioDetected)
            return;
        const left = this.onSince + this.detector.config.holdMs - this.now();
        if (left <= 0) {
            this.turnOff();
            return;
        }
        this.timers.clearTimeout(this.offTimer);
        this.offTimer = this.timers.setTimeout(() => {
            this.offTimer = undefined;
            if (!this.detector.detected)
                this.turnOff();
        }, left);
    }

    private turnOff() {
        this.timers.clearTimeout(this.offTimer);
        this.offTimer = undefined;
        if (this.audioDetected)
            this.audioDetected = false;
    }

    private now(): number {
        return this.timers.now();
    }

    /** one window into the status history: O(1), no allocation. db is the window's sustained level, the one compared with the threshold. */
    private record(db: number, spike: boolean, now: number) {
        const floor = this.detector.floorDb;
        const c = this.detector.config;
        // the threshold a window's sustained level must reach: floor + sensitivity, never below the absolute minimum
        const threshold = floor === undefined ? undefined : Math.max(floor + c.sensitivityDb, c.absMinDb);
        this.activity.add(now, db, floor, threshold, spike, !!this.audioDetected, this.background);
        if (this.host.totals)
            this.host.totals.windows++;
    }

    /** Short state for the plugin overview, with its chip colour. */
    shortState(): { state: string; color: string } {
        const r = this.runner, d = this.detector;
        if (r.state === 'stopped')
            return { state: 'Disabled', color: C.gray };
        if (r.noAudio)
            return { state: 'No audio', color: C.gray };
        if (r.state === 'restarting')
            return { state: 'Restarting', color: C.amber };
        if (r.state === 'starting')
            return { state: 'Starting', color: C.blue };
        if (d.learning)
            return { state: 'Learning', color: C.blue };
        if (this.audioDetected)
            return { state: 'Sound', color: C.red };
        if (this.background)
            return { state: 'Background', color: C.gray };
        return r.silent ? { state: 'Silent', color: C.gray } : { state: 'Listening', color: C.green };
    }

    /** One row of the plugin overview. */
    overviewRow(now = this.now()): OverviewCamera {
        const d = this.detector;
        const live = this.runner.state === 'running';
        const db = (v: number | undefined) => v === undefined ? 'n/a' : v <= MIN_DB ? 'silent' : v.toFixed(0);
        return {
            name: String(this.name || this.id || '?'),
            ...this.shortState(),
            restartsHour: this.runner.restarts.sum(now),
            detectionsHour: this.detections.sum(now),
            lastSound: relTime(d.lastSpikeWall, Date.now()),
            levelFloor: live && d.lastDb !== undefined ? `${db(d.lastDb)} / ${db(d.floorDb)} dBFS` : '—',
        };
    }

    /** One line: state, current level, floor, last spike. */
    statusText(now = this.now()): string {
        const r = this.runner, d = this.detector;
        const db = (v: number | undefined) => v === undefined ? 'n/a' : v <= MIN_DB ? 'silent' : `${v.toFixed(0)} dBFS`;
        const until = (t: number | undefined) => t === undefined ? '' : `, next try in ${Math.max(0, Math.round((t - now) / 1000))} s`;
        let state: string;
        if (r.state === 'stopped')
            state = 'Disabled';
        else if (r.noAudio)
            state = `No audio (${r.noAudio})${r.state === 'no audio' ? until(r.nextStartAt) : ', checking'}`;
        else if (r.state === 'restarting')
            state = `Reconnecting (${maskUrls(r.lastError || 'ended')})${until(r.nextStartAt)}`;
        else if (r.state === 'starting')
            state = 'Starting';
        else if (d.learning)
            state = 'Learning the background';
        else
            state = this.audioDetected ? 'Sound detected' : this.background ? 'Background (ignored by the background check)' : r.silent ? 'Listening (the audio is digital silence)' : 'Listening';
        if (this.fallback.current && this.fallback.current !== 'low-resolution' && (r.state === 'running' || r.state === 'starting'))
            state += ` on ${this.fallback.current}`;
        const parts = [state];
        if (r.state === 'running' || r.state === 'starting') {
            parts.push(`level ${db(d.lastDb)}`, `floor ${db(d.floorDb)}`);
        }
        parts.push(`last sound ${d.lastSpikeWall ? clockTime(d.lastSpikeWall) : 'never'}`);
        return parts.join(' · ');
    }

    /** Status line and the Activity chart (html), computed now: only when the settings page is requested. */
    statusHtml(now = this.now()): string {
        const r = this.runner;
        const empty = r.state === 'stopped' ? 'Disabled, no data' : r.noAudio ? 'No audio, no data' : 'Listening, no data yet';
        const c = this.detector.config, floor = this.detector.floorDb;
        const loud = floor === undefined ? '' : ` (now ${Math.max(floor + c.impulseDb, c.impulseMinDb).toFixed(0)} dBFS)`;
        const note = `Not drawn: a short loud sound counts when one 100 ms window reaches the floor + ${c.impulseDb} dB and ${c.impulseMinDb} dBFS${loud}.`;
        return renderStatus(this.statusText(now), this.activity, now, empty, note);
    }

    async getMixinSettings(): Promise<Setting[]> {
        const settings = await this.storageSettings.getSettings();
        settings.unshift({
            key: 'status',
            title: 'Status',
            description: 'Refreshed when the page is opened.',
            type: 'html',
            readonly: true,
            value: this.statusHtml(),
        });
        return settings;
    }

    async putMixinSetting(key: string, value: SettingValue): Promise<boolean | void> {
        if (key === 'status')
            return true;
        if (NUMBERS[key])
            value = clamp(value, NUMBERS[key][0], this.num(key));
        await this.storageSettings.putSetting(key, value);
        sdk.deviceManager.onMixinEvent(this.id, this, ScryptedInterface.Settings, null);
        return true;
    }

    async release() {
        if (this.released)
            return;
        // stop first: the runner publishes the sensor off while publishing is still allowed
        this.runner.stop();
        this.soundEnded(true);
        this.released = true;
        for (const l of this.listeners.splice(0))
            try { l.removeListener(); } catch { /* gone */ }
        await super.release();
    }
}
