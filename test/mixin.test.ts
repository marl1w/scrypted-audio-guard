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
    feed(-25, 3);
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

test('settings: defaults; sensitivity, hold, minimum level, duration and the loud-sound thresholds are clamped and applied live', async () => {
    const d = make();
    assert.deepEqual([d.m.detector.config.absMinDb, d.m.detector.config.minSustainedWindows, d.m.detector.config.impulseDb, d.m.detector.config.impulseMinDb], [-45, 10, 25, -30]);
    await d.m.release();
    const { m, feed, clock } = make({ sensitivity: '99', hold: '2', minLevel: '-200', duration: '99', impulse: '1', impulseLevel: '5' });
    await flush();
    assert.equal(m.detector.config.sensitivityDb, 40);
    assert.equal(m.detector.config.holdMs, 2000);
    assert.equal(m.detector.config.absMinDb, -90);
    assert.equal(m.detector.config.minSustainedWindows, 100);
    assert.equal(m.detector.config.impulseDb, 6);
    assert.equal(m.detector.config.impulseMinDb, 0);
    await m.putMixinSetting('sensitivity', 10);
    await m.putMixinSetting('minLevel', -50);
    await m.putMixinSetting('duration', 0.3);
    assert.equal(m.detector.config.sensitivityDb, 10);
    assert.equal(m.detector.config.minSustainedWindows, 3);
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
    feed(-25, 3);
    const s = (await m.getMixinSettings())[0];
    assert.equal(s.key, 'status');
    assert.equal(s.readonly, true);
    assert.equal(s.type, 'html');
    assert.match(m.statusText(), /^Sound detected · level -25 dBFS · floor -60 dBFS · last sound \d\d:\d\d:\d\d$/);
    assert.match(String(s.value), /<div>Sound detected · level -25 dBFS · floor -60 dBFS · last sound \d\d:\d\d:\d\d<\/div>/);
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
    feed(-25, 3);
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
    feed(-25, 5);
    const b = m.activity.bucket(now(), 0)!;
    assert.ok(b, 'the current second has data');
    assert.equal(b.published, true);
    assert.equal(b.spike, true);
    assert.equal(Math.round(b.level), -25);
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
    assert.equal(row.levelFloor, '-25 / -60 dBFS');
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

/** A provider with `n` cameras (fake clock and ffmpeg), all past the start jitter and the learning (floor -60 dBFS). */
async function fleet(n: number, store: Record<string, string> = {}) {
    const p = new AudioGuardProvider('n');
    p.stopPerf();
    const clock = new FakeClock();
    const host = p as any;
    host.timers = clock;
    const feeds = new Map<AudioGuardMixin, (w: WindowLevel) => void>();
    const ends = new Map<AudioGuardMixin, (e?: string) => void>();
    host.starter = (m: AudioGuardMixin) => async (onWindow: (w: WindowLevel) => void) => {
        feeds.set(m, onWindow);
        const exited = new Promise<string | undefined>(r => ends.set(m, r));
        return { stop() { }, exited } as AudioProcess;
    };
    const ms: AudioGuardMixin[] = [];
    for (let i = 0; i < n; i++)
        ms.push(await p.getMixin({}, [] as any, { id: `c${i}`, store: { ...store } } as any));
    clock.advance(START_JITTER_MS);
    await flush();
    /** `k` windows to each running camera: `db(i)` for camera i, -60 dBFS for the others */
    const tick = (db: number | ((i: number) => number), loud: number[] = [], k = 1) => {
        for (let j = 0; j < k; j++) {
            clock.advance(100);
            ms.forEach((m, i) => {
                if (m.runner.state !== 'running')
                    return;
                const v = !loud.includes(i) ? -60 : typeof db === 'number' ? db : db(i);
                feeds.get(m)!({ db: v, sustainedDb: v });
            });
        }
    };
    tick(-60, [], 150);
    const logs = (i: number) => ((ms[i] as any).logs as string[]).filter(l => l.startsWith('background check'));
    const done = async () => { for (let i = 0; i < n; i++) await p.releaseMixin(`c${i}`, ms[i]); };
    return { p, clock, ms, tick, ends, logs, done };
}

test('background check: a sound 4 of 5 cameras hear alike is ignored; a sound at one camera is published 1 s later', async () => {
    const { ms, tick, clock, logs, done } = await fleet(5);
    tick(-20, [0, 1]);
    tick(-60, [], 5);
    tick(-20, [2, 3]);
    tick(-60, [], 30);
    assert.ok(ms.every(m => !m.audioDetected));
    assert.ok(ms.every(m => m.detections.sum(clock.now()) === 0));
    assert.match(logs(0)[0], /^background check: sound ignored, 3 of 4 other cameras heard it as loud at the same moment$/);
    assert.equal(ms[0].shortState().state, 'Background');
    assert.match(ms[0].statusText(), /^Background \(ignored by the background check\)/);
    // 3 of 5 is not enough: each camera has only 2 of 4 others (needs 60 %, 3)
    clock.advance(10_000);
    tick(-20, [0, 1, 2]);
    tick(-60, [], 10);
    assert.ok([0, 1, 2].every(i => ms[i].audioDetected));
    clock.advance(20_000);
    // one camera alone: published once the 1 s check has passed
    tick(-20, [3]);
    assert.ok(!ms[3].audioDetected, 'waits for the other cameras');
    tick(-60, [], 10);
    assert.equal(ms[3].audioDetected, true);
    assert.equal(ms[3].detections.sum(clock.now()), 1);
    await done();
});

test('background check with 3 cameras: all 3 is background, 2 of 3 is published', async () => {
    const { ms, tick, clock, done } = await fleet(3);
    tick(-20, [0, 1, 2]);
    tick(-60, [], 15);
    assert.ok(ms.every(m => !m.audioDetected && m.background));
    clock.advance(15_000);
    tick(-20, [0, 1]);
    tick(-60, [], 15);
    assert.deepEqual(ms.map(m => !!m.audioDetected), [true, true, false]);
    await done();
});

test('background check: fewer than 3 cameras listening, no check and no delay', async () => {
    const { ms, tick, done } = await fleet(2);
    tick(-20, [0, 1]);
    assert.ok(ms.every(m => m.audioDetected), 'published at the first window');
    await done();
});

test('background check: the camera where the sound is clearly loudest above its floor is not suppressed', async () => {
    const { ms, tick, done } = await fleet(5);
    // a bang next to camera 0 (+50 dB), heard by the four others at +30 dB
    tick(i => i === 0 ? -10 : -30, [0, 1, 2, 3, 4]);
    tick(-60, [], 15);
    assert.equal(ms[0].audioDetected, true);
    assert.ok([1, 2, 3, 4].every(i => !ms[i].audioDetected && ms[i].background));
    await done();
});

test('background check: a sound that keeps going is not checked again; a new sound during it on another camera is background too', async () => {
    const { ms, tick, logs, done } = await fleet(4);
    // wind on cameras 1 to 3 for 30 s
    tick(-20, [1, 2, 3], 100);
    // camera 0 hears it 10 s later, for 1.5 s: the others' sound started long before, but goes on
    tick(-20, [0, 1, 2, 3], 15);
    tick(-20, [1, 2, 3], 185);
    assert.ok(ms.every(m => !m.audioDetected));
    assert.deepEqual([0, 1, 2, 3].map(i => logs(i).length), [1, 1, 1, 1], 'one check per camera');
    assert.ok([1, 2, 3].every(i => ms[i].background && ms[i].detector.detected));
    assert.ok(ms.every(m => m.detections.sum(m['now']()) === 0));
    const html = ms[1].statusHtml();
    assert.match(html, /<title>background, \d+ s<\/title>/);
    assert.match(html, /a short loud sound counts when one 100 ms window reaches the floor \+ 25 dB and -30 dBFS \(now -30 dBFS\)/);
    await done();
});

test('background check: the "sound ignored" log is rate-limited to one line a minute', async () => {
    const { tick, logs, clock, done } = await fleet(3, { hold: '1' });
    for (let k = 0; k < 13; k++) {
        tick(-20, [0, 1, 2]);
        tick(-60, [], 49); // 5 s apart, each a new sound (Hold 1 s)
    }
    assert.equal(clock.now() >= 60_000, true);
    tick(-20, [0, 1, 2]);
    tick(-60, [], 20);
    assert.equal(logs(0).length, 2);
    assert.match(logs(0)[1], /\(and 11 more since the last line\)$/);
    await done();
});

test('background check: with Hold 1 s the sensor is on for Hold after the check turned it on', async () => {
    const { ms, tick, clock, done } = await fleet(3, { hold: '1' });
    const t0 = clock.now();
    tick(-20, [0]);
    clock.advance(900);
    assert.equal(ms[0].audioDetected, undefined, 'not yet published');
    clock.advance(600); // 1.5 s after the bang: the detector's own hold ended, the sensor is on since 1 s
    assert.equal(ms[0].audioDetected, true);
    clock.advance(500);
    assert.equal(ms[0].audioDetected, false);
    assert.equal(clock.now() - t0, 2100);
    assert.deepEqual((ms[0] as any).writes, [true, false]);
    await done();
});

test('background check: Hold counts from when the sensor turned on', async () => {
    const { ms, tick, clock, done } = await fleet(3);
    tick(-20, [0]);
    clock.advance(10_050); // 10.05 s after the bang: the detector is off, the sensor (on at 1 s) stays on
    assert.equal(ms[0].detector.detected, false);
    assert.equal(ms[0].audioDetected, true);
    clock.advance(1000);
    assert.equal(ms[0].audioDetected, false);
    await done();
});

for (const how of ['disabled', 'process ended', 'released'] as const) {
    test(`background check: a pending sound is dropped and logged when the audio stops (${how})`, async () => {
        const { ms, tick, ends, clock, logs, done } = await fleet(3);
        tick(-20, [0]);
        const logLines = (ms[0] as any).logs as string[];
        if (how === 'disabled')
            await ms[0].putMixinSetting('enabled', false);
        else if (how === 'process ended') {
            ends.get(ms[0])!('boom');
            await flush();
        }
        else
            await ms[0].release();
        assert.ok(logLines.includes('background check: a pending sound was dropped, the audio stopped'), logs(0).join('|'));
        clock.advance(5000);
        assert.ok(!ms[0].audioDetected);
        assert.deepEqual((ms[0] as any).writes.filter(Boolean), [], 'never published');
        await done();
    });
}

test('settings are clamped when they are saved', async () => {
    const { m } = make();
    await m.putMixinSetting('hold', 5000);
    await m.putMixinSetting('sensitivity', 1);
    await m.putMixinSetting('duration', 'x');
    assert.deepEqual([m.storage.getItem('hold'), m.storage.getItem('sensitivity'), m.storage.getItem('duration')], ['600', '6', '1']);
    await m.release();
});
