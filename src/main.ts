import sdk, { MixinProvider, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, Setting, Settings, SettingValue, WritableDeviceState } from '@scrypted/sdk';

import { Hearing } from './background';
import { AudioGuardMixin, MixinHost } from './mixin';
import { ProcRing, renderOverview, renderPerformance, Totals } from './overview';
import { realTimers } from './runner';

/** Marker interface: at most one Audio Guard mixin per camera (objectdetector pattern). */
const MARKER = 'scrypted-audio-guard:mixin';
/** a hung lookup of Scrypted's ffmpeg must not stall a camera's start for ever */
const FFMPEG_PATH_TIMEOUT_MS = 10_000;
/** the plugin process is sampled (CPU, memory, throughput) once a minute; the page renders from the ring */
export const PERF_SAMPLE_MS = 60_000;

export class AudioGuardProvider extends ScryptedDeviceBase implements MixinProvider, MixinHost, Settings {
    // Enabling is opt-in: nothing here calls setMixins, so the user turns the extension on per camera.
    private live = new Map<string, AudioGuardMixin>();
    /** Scrypted's ffmpeg, looked up once (again after a failed lookup) */
    private ffmpegLookup: Promise<string> | undefined;
    /** windows of all cameras since the plugin started (counted by the mixins) */
    readonly totals = { windows: 0 };
    /** the last hour, one sample per minute */
    readonly perf = new ProcRing(60);
    private perfTimer: NodeJS.Timeout | undefined;

    constructor(nativeId?: string) {
        super(nativeId);
        this.samplePerf(); // baseline: the first minute then has a CPU figure
        this.perfTimer = setInterval(() => this.samplePerf(), PERF_SAMPLE_MS);
        this.perfTimer.unref?.();
    }

    /** stops the per-minute sampler (tests; Scrypted ends the whole process on a plugin restart) */
    stopPerf() {
        clearInterval(this.perfTimer);
        this.perfTimer = undefined;
    }

    /** One per-minute sample of the plugin's own process: O(1), a single object. */
    samplePerf(now = realTimers.now()) {
        const cpu = process.cpuUsage();
        this.perf.sample(now, cpu.user + cpu.system, process.memoryUsage().rss, this.totals.windows);
    }

    private cameras(): AudioGuardMixin[] {
        return [...this.live.values()];
    }

    /** The background check: what the other listening cameras (running, past learning) heard last. */
    otherListeners(self: AudioGuardMixin): Hearing[] {
        return this.cameras().filter(m => m !== self && m.runner.state === 'running' && !m.detector.learning).map(m => m.detector);
    }

    totalsNow(): Totals {
        const cams = this.cameras();
        return {
            // a camera without audio is not counted, unless its periodic check is running right now
            wanted: cams.filter(m => m.runner.state !== 'stopped' && (!m.runner.noAudio || m.runner.state === 'running')).length,
            running: cams.filter(m => m.runner.state === 'running').length,
        };
    }

    /** Plugin page: rendered when it is requested, never pushed. */
    async getSettings(): Promise<Setting[]> {
        const now = realTimers.now();
        const rows = this.cameras().map(m => { try { return m.overviewRow(now); } catch { return undefined; } }).filter(r => r !== undefined);
        return [
            { key: 'overview', group: 'Overview', title: 'Cameras', type: 'html', readonly: true, description: 'Refreshed when the page is opened.', value: renderOverview(rows) },
            { key: 'performance', group: 'Performance', title: 'Plugin', type: 'html', readonly: true, description: 'Refreshed when the page is opened.', value: renderPerformance(this.totalsNow(), this.perf) },
        ];
    }

    async putSetting(_key: string, _value: SettingValue): Promise<void> {
        // read-only page
    }

    ffmpegPath(): Promise<string> {
        if (!this.ffmpegLookup) {
            let timer: NodeJS.Timeout | undefined;
            const timeout = new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('ffmpeg path lookup timed out')), FFMPEG_PATH_TIMEOUT_MS);
            });
            const lookup = Promise.race([sdk.mediaManager.getFFmpegPath(), timeout]).finally(() => clearTimeout(timer));
            lookup.catch(() => { if (this.ffmpegLookup === lookup) this.ffmpegLookup = undefined; });
            this.ffmpegLookup = lookup;
        }
        return this.ffmpegLookup;
    }

    async canMixin(_type: ScryptedDeviceType, interfaces: string[]): Promise<string[] | null | undefined | void> {
        if (!interfaces.includes(ScryptedInterface.VideoCamera))
            return;
        // our own marker must not hide us (the enabled extension would be unticked); another provider's does
        const thisMarker = `${MARKER}:${this.id}`;
        if (interfaces.some(i => i.startsWith(MARKER) && i !== thisMarker))
            return;
        return [ScryptedInterface.AudioSensor, ScryptedInterface.Settings, thisMarker];
    }

    async getMixin(mixinDevice: any, mixinDeviceInterfaces: ScryptedInterface[], mixinDeviceState: WritableDeviceState): Promise<any> {
        // Scrypted may rebuild a camera's mixin chain and call getMixin before releaseMixin: keep one live instance per camera
        const id = String((mixinDeviceState as any)?.id ?? mixinDevice?.id ?? '');
        const old = id ? this.live.get(id) : undefined;
        // the new instance is registered before anything is awaited: a concurrent getMixin for the same camera then
        // finds (and releases) this one, so no instance is ever orphaned
        const m = new AudioGuardMixin({
            group: 'Audio Guard',
            groupKey: 'audio-guard',
            mixinDevice,
            mixinDeviceInterfaces,
            mixinDeviceState,
            mixinProviderNativeId: this.nativeId,
        }, this);
        if (id)
            this.live.set(id, m);
        if (old) {
            try { await old.release(); } catch { /* best effort */ }
        }
        return m;
    }

    async releaseMixin(id: string, mixinDevice: AudioGuardMixin): Promise<void> {
        if (this.live.get(id) === mixinDevice)
            this.live.delete(id);
        await mixinDevice?.release();
    }
}

export default AudioGuardProvider;
