// Test harness: a stubbed Scrypted SDK, installed before any src module is loaded (import this file first).
/* eslint-disable @typescript-eslint/no-explicit-any */
import Module = require('module');

export const ctl = {
    /** what mediaManager.convertMediaObjectToJSON returns (the camera's FFmpegInput) */
    ffmpegInput: undefined as any,
    ffmpegPath: 'ffmpeg',
    /** settings change notifications */
    notified: 0,
    /** listenDevice registrations: id, event, callback, removed */
    listens: [] as { id: string; event: string; cb: () => void; removed: boolean }[],
};

export const sdkStub: any = {
    mediaManager: {
        convertMediaObjectToJSON: async (_mo: any, _mime: string) => ctl.ffmpegInput,
        getFFmpegPath: async () => ctl.ffmpegPath,
    },
    deviceManager: { onMixinEvent: () => { ctl.notified++; return Promise.resolve(); } },
    systemManager: {
        listenDevice: (id: string, o: any, cb: () => void) => {
            const r = { id, event: o?.event, cb, removed: false };
            ctl.listens.push(r);
            return { removeListener: () => { r.removed = true; } };
        },
    },
};

/** SettingsMixinDeviceBase stand-in: storage, console, and the AudioSensor property with its writes recorded. */
export class MixinBaseStub {
    id = 'cam1';
    name = 'Cam 1';
    mixinDevice: any;
    store: Record<string, string> = {};
    storage = { getItem: (k: string) => this.store[k] ?? null, setItem: (k: string, v: any) => { this.store[k] = String(v); }, removeItem: (k: string) => { delete this.store[k]; } };
    logs: string[] = [];
    console = { log: (...a: any[]) => this.logs.push(a.join(' ')), warn: (...a: any[]) => this.logs.push(a.join(' ')), error: (...a: any[]) => this.logs.push(a.join(' ')) } as any;
    writes: boolean[] = [];
    private _audio: boolean | undefined;
    constructor(o: any) {
        this.mixinDevice = o.mixinDevice;
        Object.assign(this.store, o.mixinDeviceState?.store ?? {});
        this._audio = o.mixinDeviceState?.audioDetected;
    }
    get audioDetected() { return this._audio; }
    set audioDetected(v: boolean | undefined) { this._audio = v; this.writes.push(!!v); }
    async release() { }
}

class StorageSettingsStub {
    values: Record<string, any> = {};
    constructor(private dev: any, private defs: Record<string, any>) {
        for (const k of Object.keys(defs))
            Object.defineProperty(this.values, k, { get: () => this.get(k), enumerable: true });
    }
    private get(k: string) {
        const d = this.defs[k];
        const raw = this.dev.storage.getItem(k);
        if (raw == null) return d.defaultValue;
        if (d.type === 'number') { const n = parseFloat(raw); return isNaN(n) ? d.defaultValue : n; }
        if (d.type === 'boolean') return raw === 'true';
        return raw;
    }
    async putSetting(k: string, v: any) { this.dev.storage.setItem(k, v); this.defs[k]?.onPut?.(undefined, v); }
    async getSettings() { return Object.entries(this.defs).map(([key, d]: [string, any]) => ({ key, title: d.title, type: d.type, value: this.values[key] })); }
}

const origLoad = (Module as any)._load;
(Module as any)._load = function (req: string, ...rest: any[]) {
    if (req === '@scrypted/sdk')
        return {
            __esModule: true, default: sdkStub,
            ScryptedInterface: { AudioSensor: 'AudioSensor', Settings: 'Settings', VideoCamera: 'VideoCamera', MixinProvider: 'MixinProvider' },
            ScryptedDeviceType: { Camera: 'Camera', Doorbell: 'Doorbell' },
            ScryptedDeviceBase: class { id = 'prov1'; nativeId = 'n'; console = console; constructor(_n?: string) { } },
            ScryptedMimeTypes: { FFmpegInput: 'x-scrypted/x-ffmpeg-input' },
        };
    if (req === '@scrypted/sdk/settings-mixin') return { SettingsMixinDeviceBase: MixinBaseStub };
    if (req === '@scrypted/sdk/storage-settings') return { StorageSettings: StorageSettingsStub };
    return origLoad.call(this, req, ...rest);
};
