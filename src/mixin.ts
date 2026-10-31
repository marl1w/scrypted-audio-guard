import sdk, { AudioSensor, EventListenerRegister, ScryptedInterface, Setting, SettingValue, VideoCamera } from '@scrypted/sdk';
import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from '@scrypted/sdk/settings-mixin';
import { StorageSettings } from '@scrypted/sdk/storage-settings';

import { AudioDetector, DEFAULT_DETECTOR, DEFAULT_HOLD_S, DEFAULT_SENSITIVITY_DB } from './detector';
import { candidates, FallbackStarter } from './fallback';
import { MIN_DB } from './pcm';
import { AudioRunner, AudioStarter, realTimers, Timers } from './runner';
import { startAudio, STREAM_RESOLVE_MS } from './source';
import { clockTime, maskUrls, withTimeout } from './util';

export const SENSITIVITY_RANGE: [number, number] = [6, 40];
export const HOLD_RANGE: [number, number] = [1, 600];

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
            description: `How far above the camera's own background a sound must be (${SENSITIVITY_RANGE[0]} to ${SENSITIVITY_RANGE[1]} dB; lower is more sensitive).`,
            type: 'number',
            defaultValue: DEFAULT_SENSITIVITY_DB,
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
    private released = false;
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
        this.audioDetected = on;
    }

    /** One line: state, current level, floor, last spike. */
    statusText(now = (this.host.timers ?? realTimers).now()): string {
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

    async getMixinSettings(): Promise<Setting[]> {
        const settings = await this.storageSettings.getSettings();
        settings.unshift({
            key: 'status',
            title: 'Status',
            description: 'Refreshed when the page is opened.',
            readonly: true,
            value: this.statusText(),
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
        if (this.audioDetected)
            this.audioDetected = false;
        this.released = true;
        for (const l of this.listeners.splice(0))
            try { l.removeListener(); } catch { /* gone */ }
        await super.release();
    }
}
