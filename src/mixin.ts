import sdk, { AudioSensor, EventListenerRegister, ScryptedInterface, Setting, SettingValue, VideoCamera } from '@scrypted/sdk';
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from '@scrypted/sdk/settings-mixin';
import { StorageSettings } from '@scrypted/sdk/storage-settings';

import { AudioDetector, DEFAULT_DETECTOR, DEFAULT_DURATION_S, DEFAULT_HOLD_S, DEFAULT_IMPULSE_DB, DEFAULT_IMPULSE_LEVEL_DB, DEFAULT_MIN_LEVEL_DB, DEFAULT_SENSITIVITY_DB } from './detector';
import { candidates, FallbackStarter } from './fallback';
import { OverviewCamera } from './overview';
import { MIN_DB } from './pcm';
import { AudioRunner, AudioStarter, realTimers, Timers } from './runner';
import { startAudio, STREAM_RESOLVE_MS } from './source';
import { ActivityRing, C, MinuteCounter, relTime, renderStatus } from './status';
import { clockTime, maskUrls, withTimeout } from './util';

export const SENSITIVITY_RANGE: [number, number] = [6, 40];
export const HOLD_RANGE: [number, number] = [1, 600];
export const LEVEL_RANGE: [number, number] = [-90, 0];
export const DURATION_RANGE: [number, number] = [0.2, 10];
export const IMPULSE_RANGE: [number, number] = [6, 60];
/** a sound is checked against the other cameras this long after it starts (their sounds of the same moment are in by then) */
export const COMMON_MODE_MS = 1000;

function clamp(v: unknown, [lo, hi]: [number, number], dflt: number): number {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}

export interface MixinHost {
    ffmpegPath(): Promise<string>;
    /** tests replace the ffmpeg process */
    starter?: (m: AudioGuardMixin) => AudioStarter;
    /** tests replace the clock */
    timers?: Timers;
    /** plugin-wide counters: 100 ms windows of all cameras (the provider's throughput figure) */
    totals?: { windows: number };
    /** a sound at `at` (monotonic ms) was heard by most listening cameras at once: background, not near one camera */
    commonMode?(at: number): string | undefined;
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
            description: 'How long the sensor stays on after the last loud sound.',
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
    /** a new sound waits COMMON_MODE_MS for the other cameras before it is published */
    private pending: unknown;
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
            onDetected: on => this.publish(on),
            onLevel: (w, r, now) => this.record(w.sustainedDb, r.spike, r.detected, now),
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

    private tuning() {
        return {
            sensitivityDb: clamp(this.storageSettings.values.sensitivity, SENSITIVITY_RANGE, DEFAULT_SENSITIVITY_DB),
            holdMs: clamp(this.storageSettings.values.hold, HOLD_RANGE, DEFAULT_HOLD_S) * 1000,
            absMinDb: clamp(this.storageSettings.values.minLevel, LEVEL_RANGE, DEFAULT_MIN_LEVEL_DB),
            minSustainedWindows: Math.round(clamp(this.storageSettings.values.duration, DURATION_RANGE, DEFAULT_DURATION_S) * 10),
            impulseDb: clamp(this.storageSettings.values.impulse, IMPULSE_RANGE, DEFAULT_IMPULSE_DB),
            impulseMinDb: clamp(this.storageSettings.values.impulseLevel, LEVEL_RANGE, DEFAULT_IMPULSE_LEVEL_DB),
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
        else
            this.runner.stop();
    }

    streamsChanged() {
        if (this.released)
            return;
        this.fallback.reset();
        this.runner.streamsChanged();
    }

    private publish(on: boolean) {
        if (this.released)
            return;
        const t = this.host.timers ?? realTimers;
        t.clearTimeout(this.pending);
        this.pending = undefined;
        if (!on) {
            if (this.audioDetected)
                this.audioDetected = false;
            return;
        }
        if (!this.host.commonMode) {
            this.show();
            return;
        }
        // wait for the other cameras: a sound most of them hear at the same moment is background (wind, rain, a distant bang)
        const at = this.detector.lastSpikeAt ?? this.now();
        this.pending = t.setTimeout(() => {
            this.pending = undefined;
            if (this.released || !this.detector.detected)
                return;
            const why = this.host.commonMode?.(at);
            if (!why) {
                this.show();
                return;
            }
            this.console.log(`sound ignored: ${why}`);
            // forget it: the next sound of this camera is checked afresh
            this.detector.clear();
        }, COMMON_MODE_MS);
    }

    private show() {
        this.detections.add(this.now());
        this.audioDetected = true;
    }

    private now(): number {
        return (this.host.timers ?? realTimers).now();
    }

    /** one window into the status history: O(1), no allocation. db is the window's sustained level, the one compared with the threshold. */
    private record(db: number, spike: boolean, detected: boolean, now: number) {
        const floor = this.detector.floorDb;
        const c = this.detector.config;
        // the threshold a window's sustained level must reach: floor + sensitivity, never below the absolute minimum
        const threshold = floor === undefined ? undefined : Math.max(floor + c.sensitivityDb, c.absMinDb);
        this.activity.add(now, db, floor, threshold, spike, detected);
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
        if (d.detected)
            return { state: 'Sound', color: C.red };
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
            state = d.detected ? 'Sound detected' : r.silent ? 'Listening (the audio is digital silence)' : 'Listening';
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
        return renderStatus(this.statusText(now), this.activity, now, empty);
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
        await this.storageSettings.putSetting(key, value);
        sdk.deviceManager.onMixinEvent(this.id, this, ScryptedInterface.Settings, null);
        return true;
    }

    async release() {
        if (this.released)
            return;
        // stop first: the runner publishes the sensor off while publishing is still allowed
        this.runner.stop();
        (this.host.timers ?? realTimers).clearTimeout(this.pending);
        if (this.audioDetected)
            this.audioDetected = false;
        this.released = true;
        for (const l of this.listeners.splice(0))
            try { l.removeListener(); } catch { /* gone */ }
        await super.release();
    }
}
