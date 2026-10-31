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
    assert.equal(s.type, 'html');
    assert.match(m.statusText(), /^Sound detected · level -35 dBFS · floor -60 dBFS · last sound \d\d:\d\d:\d\d$/);
    assert.match(String(s.value), /<div>Sound detected · level -35 dBFS · floor -60 dBFS · last sound \d\d:\d\d:\d\d<\/div>/);
    assert.match(String(s.value), /Activity/);
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

test('status html: the Activity chart is fed by the windows (level, floor, threshold, sound, Published)', async () => {
    const { m, feed, clock } = make();
    const now = () => clock.now();
    const empty = m.statusHtml(now());
    assert.match(empty, /Listening, no data yet/);
    await flush();
    feed(-60, 150);
    feed(-35, 5);
    const b = m.activity.bucket(now(), 0)!;
    assert.ok(b, 'the current second has data');
    assert.equal(b.published, true);
    assert.equal(b.spike, true);
    assert.equal(Math.round(b.level), -35);
    assert.equal(b.floor, -60);
    assert.equal(b.threshold, -45, 'floor + sensitivity');
    const before = m.activity.bucket(now(), 3)!;
    assert.equal(before.spike, false);
    assert.equal(before.published, false);
    const html = m.statusHtml(now());
    assert.match(html, /<title>sound, 1 s<\/title>/);
    assert.match(html, /stroke-dasharray="4 3"/, 'floor line');
    assert.match(html, /stroke="#d9930d" stroke-width="1.5" stroke-linejoin="round"\/>/, 'threshold line');
    const row = m.overviewRow(now());
    assert.equal(row.state, 'Sound');
    assert.equal(row.detectionsHour, 1);
    assert.equal(row.levelFloor, '-35 / -60 dBFS');
    assert.equal(row.lastSound, 'just now');
    await m.release();
});

test('status history: the chart level is the sustained level (what the detector compares), not the window RMS', async () => {
    const { m, procs, clock } = make();
    await flush();
    clock.advance(100);
    procs[0].onWindow({ db: -20, sustainedDb: -70 }); // a click: loud window, quiet half
    assert.equal(m.activity.bucket(clock.now(), 0)!.level, -70);
    assert.match(m.overviewRow().levelFloor, /^-20 \//, 'the overview shows the live window level');
    await m.release();
});

test('overview row: no live level unless ffmpeg is running; a silent camera is grey', async () => {
    const { m, feed } = make();
    assert.equal(m.runner.state, 'starting', 'ffmpeg not started yet');
    m.detector.lastDb = -50;
    assert.equal(m.overviewRow().levelFloor, '—');
    await flush();
    assert.equal(m.runner.state, 'running');
    feed(-60, 150);
    assert.equal(m.overviewRow().levelFloor, '-60 / -60 dBFS');
    m.detector.silent = true;
    assert.deepEqual(m.shortState(), { state: 'Silent', color: '#8b8b8b' });
    await m.release();
});

test('status html: a disabled camera shows its empty state', async () => {
    const { m } = make({ enabled: 'false' });
    assert.match(m.statusHtml(), /Disabled, no data/);
    assert.equal(m.shortState().state, 'Disabled');
    await m.release();
});

test('provider page: Overview and Performance html, one row per camera, totals and windows counted', async () => {
    const p = new AudioGuardProvider('n');
    const clock = new FakeClock();
    const host = p as any;
    host.timers = clock;
    let feed!: (w: WindowLevel) => void;
    host.starter = () => async (onWindow: (w: WindowLevel) => void) => { feed = onWindow; return { stop() { }, exited: new Promise(() => { }) } as AudioProcess; };
    const m: AudioGuardMixin = await p.getMixin({}, [] as any, { id: 'c1', store: {} } as any);
    clock.advance(START_JITTER_MS);
    await flush();
    for (let i = 0; i < 20; i++) { clock.advance(100); feed({ db: -60, sustainedDb: -60 }); }
    assert.equal(p.totals.windows, 20);
    const s = await p.getSettings();
    assert.deepEqual(s.map(x => x.key), ['overview', 'performance']);
    assert.ok(s.every(x => x.readonly && x.type === 'html'));
    assert.match(String(s[0].value), /Cam 1/);
    assert.match(String(s[0].value), /Learning/);
    assert.match(String(s[1].value), /ffmpeg running/);
    assert.match(String(s[1].value), />1 of 1</);
    assert.match(String(s[1].value), />1 of 1</);
    // a camera without audio is not wanted: not counted in the denominator
    (m.runner as any).noAudio = 'no audio track';
    (m.runner as any).state = 'no audio';
    assert.deepEqual(p.totalsNow(), { wanted: 0, running: 0 });
    p.stopPerf();
    await p.releaseMixin('c1', m);
});
