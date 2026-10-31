import sdk, { MixinProvider, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, WritableDeviceState } from '@scrypted/sdk';

import { AudioGuardMixin, MixinHost } from './mixin';

/** Marker interface: at most one Audio Guard mixin per camera (objectdetector pattern). */
const MARKER = 'scrypted-audio-guard:mixin';
/** a hung lookup of Scrypted's ffmpeg must not stall a camera's start for ever */
const FFMPEG_PATH_TIMEOUT_MS = 10_000;

export class AudioGuardProvider extends ScryptedDeviceBase implements MixinProvider, MixinHost {
    // Enabling is opt-in: nothing here calls setMixins, so the user turns the extension on per camera.
    private live = new Map<string, AudioGuardMixin>();
    /** Scrypted's ffmpeg, looked up once (again after a failed lookup) */
    private ffmpegLookup: Promise<string> | undefined;

    constructor(nativeId?: string) {
        super(nativeId);
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
