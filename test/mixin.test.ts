import { ctl } from './harness';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioGuardProvider } from '../src/main';
import { AudioGuardMixin, MixinHost } from '../src/mixin';
import { WindowLevel } from '../src/pcm';
import { AudioProcess, NO_AUDIO_TRACK, START_JITTER_MS, STREAMS_CHANGED_MS } from '../src/runner';
import { FakeClock, flush } from './synth';

const MARKER = 'scrypted-audio-guard:mixin';

function make(store: Record<string, string> = {}, state: any = {}) {
    const clock = new FakeClock();
    const procs: { onWindow: (w: WindowLevel) => void; stopped: boolean; end: (e?: string) => void }[] = [];
    const host: MixinHost = {
        ffmpegPath: async () => 'ffmpeg',
        timers: clock,
        starter: () => async onWindow => {
            let end!: (e?: string) => void;
            const exited = new Promise<string | undefined>(r => { end = r; });
            const p = { onWindow, stopped: false, end };
            procs.push(p);
            return { stop: () => { p.stopped = true; }, exited } as AudioProcess;
        },
    };
    const m = new AudioGuardMixin({ mixinDevice: {}, mixinDeviceState: { store, ...state } } as any, host);
    clock.advance(START_JITTER_MS); // past the first-start jitter
    const feed = (db: number, n: number) => {
        for (let i = 0; i < n; i++) {
            clock.advance(100);
            procs[procs.length - 1].onWindow({ db, sustainedDb: db });
        }
    };
    return { m, clock, procs, feed, base: m as any };
}

test('canMixin: any device with VideoCamera gets AudioSensor, Settings and our marker; others are refused', async () => {
    const p = new AudioGuardProvider('n');
    assert.deepEqual(await p.canMixin('Camera' as any, ['VideoCamera', 'MotionSensor']), ['AudioSensor', 'Settings', `${MARKER}:prov1`]);
    assert.ok(await p.canMixin('Doorbell' as any, ['VideoCamera']));
    assert.equal(await p.canMixin('Camera' as any, ['MotionSensor']), undefined);
    assert.ok(await p.canMixin('Camera' as any, ['VideoCamera', `${MARKER}:prov1`]), 'our own marker does not hide us');
    assert.equal(await p.canMixin('Camera' as any, ['VideoCamera', `${MARKER}:other`]), undefined);
});

test('ffmpeg path: looked up once and shared', async () => {
    const p = new AudioGuardProvider('n');
    ctl.ffmpegPath = '/opt/ffmpeg';
    assert.equal(await p.ffmpegPath(), '/opt/ffmpeg');
    ctl.ffmpegPath = '/other';
    assert.equal(await p.ffmpegPath(), '/opt/ffmpeg');
});

test('enabled by default: one process starts with the mixin; a sound sets audioDetected, the hold clears it', async () => {
    const { m, procs, feed, clock, base } = make();
    await flush();
    assert.equal(procs.length, 1);
    feed(-60, 120);
    feed(-35, 3);
    assert.equal(m.audioDetected, true);
    clock.advance(10_000);
    assert.equal(m.audioDetected, false);
    assert.deepEqual(base.writes, [true, false]);
    await m.release();
    assert.equal(procs[0].stopped, true);
});

test('Enabled off: no process at all; turning it on starts one, off stops it', async () => {
    const { m, procs, clock } = make({ enabled: 'false' });
    await flush();
    assert.equal(procs.length, 0, 'ffmpeg never starts for a disabled camera');
    assert.match(m.statusText(), /^Disabled/);
    await m.putMixinSetting('enabled', true);
    clock.advance(START_JITTER_MS);
    await flush();
    assert.equal(procs.length, 1);
    await m.putMixinSetting('enabled', false);
    assert.equal(procs[0].stopped, true);
    assert.ok(ctl.notified > 0);
    await m.release();
});

test('a stale audioDetected left on by a previous run is cleared at start', async () => {
    const { m, base } = make({}, { audioDetected: true });
    assert.equal(m.audioDetected, false);
    assert.deepEqual(base.writes, [false]);
    await m.release();
});

test('settings: sensitivity and hold are clamped and applied live', async () => {
    const { m, feed, clock } = make({ sensitivity: '99', hold: '2' });
    await flush();
    assert.equal(m.detector.config.sensitivityDb, 40);
    assert.equal(m.detector.config.holdMs, 2000);
    await m.putMixinSetting('sensitivity', 10);
    assert.equal(m.detector.config.sensitivityDb, 10);
    feed(-60, 120);
    feed(-48, 3);
    assert.equal(m.audioDetected, true);
    clock.advance(2000);
    assert.equal(m.audioDetected, false);
    await m.release();
});

test('status setting: read-only, shows state, level, floor and the last sound', async () => {
    const { m, feed, procs } = make();
    await flush();
    feed(-60, 50);
    assert.match(m.statusText(), /^Learning the background · level -60 dBFS · floor n\/a · last sound never$/);
    feed(-60, 100);
    feed(-35, 3);
    const s = (await m.getMixinSettings())[0];
    assert.equal(s.key, 'status');
    assert.equal(s.readonly, true);
    assert.match(String(s.value), /^Sound detected · level -35 dBFS · floor -60 dBFS · last sound \d\d:\d\d:\d\d$/);
    feed(-120, 700);
    assert.match(m.statusText(), /^Listening \(the audio is digital silence\) · level silent/);
    procs[0].end(`${NO_AUDIO_TRACK} (matches no streams)`);
    await flush();
    assert.match(m.statusText(), /^No audio \(no audio track\), next try in 300 s/);
    await m.release();
});

test('provider: a second getMixin for the same camera releases the first instance', async () => {
    const p = new AudioGuardProvider('n');
    const a: any = await p.getMixin({}, [] as any, { id: 'c1', store: { enabled: 'false' } } as any);
    let released = 0;
    const orig = a.release.bind(a);
    a.release = async () => { released++; return orig(); };
    const b: any = await p.getMixin({}, [] as any, { id: 'c1', store: { enabled: 'false' } } as any);
    assert.equal(released, 1);
    await p.releaseMixin('c1', b);
});

test('release while a sound is detected: audioDetected is published off', async () => {
    const { m, feed, base } = make();
    await flush();
    feed(-60, 120);
    feed(-35, 3);
    assert.equal(m.audioDetected, true);
    await m.release();
    assert.equal(m.audioDetected, false);
    assert.deepEqual(base.writes, [true, false]);
});

test('the camera\'s stream settings change: listened on the camera, a "no audio" camera is checked again soon; listeners removed on release', async () => {
    ctl.listens = [];
    const { m, procs, clock } = make();
    await flush();
    const mine = ctl.listens.filter(l => l.id === 'cam1');
    assert.deepEqual(mine.map(l => l.event).sort(), ['Settings', 'VideoCamera']);
    procs[0].end(NO_AUDIO_TRACK);
    await flush();
    assert.equal(m.runner.state, 'no audio');
    mine[0].cb();
    clock.advance(STREAMS_CHANGED_MS);
    await flush();
    assert.equal(procs.length, 2);
    await m.release();
    assert.ok(mine.every(l => l.removed));
});

test('provider: concurrent getMixin calls for one camera leave exactly one live instance, the others released', async () => {
    const p = new AudioGuardProvider('n');
    const released: any[] = [];
    const st = () => ({ id: 'c2', store: { enabled: 'false' } } as any);
    const [a, b, c]: any[] = await Promise.all([p.getMixin({}, [] as any, st()), p.getMixin({}, [] as any, st()), p.getMixin({}, [] as any, st())]);
    for (const x of [a, b, c])
        if (x.released) released.push(x);
    assert.equal(released.length, 2);
    assert.equal((p as any).live.get('c2'), c);
    assert.equal(c.released, false);
    await p.releaseMixin('c2', c);
});
