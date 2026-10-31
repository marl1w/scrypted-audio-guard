import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioDetector } from '../src/detector';
import { WindowLevel } from '../src/pcm';
import { AudioProcess, AudioRunner, CLEAN_RUN_MS, jitter, NO_AUDIO_TRACK, noAudioDelayMs, restartDelayMs, START_JITTER_MS, STREAMS_CHANGED_MS, WATCHDOG_MS } from '../src/runner';
import { FakeClock, flush } from './synth';

interface FakeProc { onWindow: (w: WindowLevel) => void; stopped: boolean; end: (err?: string) => void }

function setup(opts: { failStart?: () => string | undefined; random?: () => number } = {}) {
    const clock = new FakeClock();
    if (opts.random)
        clock.random = opts.random;
    const procs: FakeProc[] = [];
    const events: boolean[] = [];
    const logs: string[] = [];
    const starter = async (onWindow: (w: WindowLevel) => void): Promise<AudioProcess> => {
        const f = opts.failStart?.();
        if (f)
            throw new Error(f);
        let end!: (e?: string) => void;
        const exited = new Promise<string | undefined>(r => { end = r; });
        const p: FakeProc = { onWindow, stopped: false, end };
        procs.push(p);
        return { stop: () => { p.stopped = true; end(undefined); }, exited };
    };
    const detector = new AudioDetector();
    const runner = new AudioRunner(starter, detector, { onDetected: v => events.push(v), log: m => logs.push(m), warn: m => logs.push(m) }, clock);
    /** feeds n windows of `db` from the newest process, 100 ms apart */
    const feed = (db: number, n: number) => {
        for (let i = 0; i < n; i++) {
            clock.advance(100);
            procs[procs.length - 1].onWindow({ db, sustainedDb: db });
        }
    };
    /** start, past the first-start jitter */
    const boot = async () => {
        runner.start();
        clock.advance(START_JITTER_MS);
        await flush();
    };
    return { clock, procs, events, logs, runner, detector, feed, boot };
}

test('backoff delays: restart 1 s doubling to 60 s; no-audio checks 5 min doubling to 1 h; jitter 0.8..1.2', () => {
    assert.deepEqual([0, 1, 2, 5, 6, 10].map(restartDelayMs), [1000, 2000, 4000, 32_000, 60_000, 60_000]);
    assert.deepEqual([0, 1, 2, 3, 4].map(noAudioDelayMs), [300_000, 600_000, 1_200_000, 2_400_000, 3_600_000]);
    assert.deepEqual([0, 0.5, 1].map(r => Math.round(jitter(r) * 100) / 100), [0.8, 1, 1.2]);
});

test('the first start waits a random 0..3 s; later starts (after a stop) do not', async () => {
    const s = setup({ random: () => 0.9 });
    s.runner.start();
    await flush();
    assert.equal(s.procs.length, 0);
    s.clock.advance(2699); await flush();
    assert.equal(s.procs.length, 0);
    s.clock.advance(1); await flush();
    assert.equal(s.procs.length, 1);
    s.runner.stop();
    s.runner.start(); await flush();
    assert.equal(s.procs.length, 2);
    s.runner.stop();
});

test('restart delays are jittered by 0.8..1.2', async () => {
    let r = 0;
    const s = setup({ random: () => r });
    await s.boot();
    r = 1;
    const t = s.clock.t;
    s.procs[0].end('boom'); await flush();
    assert.equal(s.runner.nextStartAt! - t, 1200);
    s.runner.stop();
});

test('a process that keeps exiting is restarted with growing delays, one at a time', async () => {
    const s = setup();
    await s.boot();
    assert.equal(s.procs.length, 1);
    const gaps: number[] = [];
    for (let k = 0; k < 4; k++) {
        const t = s.clock.t;
        s.procs[s.procs.length - 1].end('ffmpeg exited (code 1)');
        await flush();
        assert.equal(s.runner.state, 'restarting');
        assert.equal(s.clock.pending, 1, 'one pending restart (the watchdog is gone with the process)');
        s.clock.advance(restartDelayMs(k) - 1);
        await flush();
        assert.equal(s.procs.length, k + 1, 'not before the delay');
        s.clock.advance(1);
        await flush();
        assert.equal(s.procs.length, k + 2);
        gaps.push(s.clock.t - t);
    }
    assert.deepEqual(gaps, [1000, 2000, 4000, 8000]);
    assert.equal(s.logs.filter(l => l.includes('restarting with backoff')).length, 1, 'warned once per failure streak');
    s.runner.stop();
});

test('a start that throws is retried with the same backoff', async () => {
    let fail = 2;
    const s = setup({ failStart: () => fail-- > 0 ? 'getVideoStream failed' : undefined });
    await s.boot();
    assert.equal(s.runner.state, 'restarting');
    assert.match(s.runner.lastError!, /start failed: getVideoStream failed/);
    s.clock.advance(1000); await flush();
    s.clock.advance(2000); await flush();
    assert.equal(s.procs.length, 1);
    assert.equal(s.runner.state, 'running');
    s.runner.stop();
});

test('a clean run of 60 s resets the backoff', async () => {
    const s = setup();
    await s.boot();
    for (let k = 0; k < 3; k++) {
        s.procs[s.procs.length - 1].end('boom'); await flush();
        s.clock.advance(restartDelayMs(k)); await flush();
    }
    s.feed(-60, CLEAN_RUN_MS / 100 + 1);
    const t = s.clock.t;
    s.procs[s.procs.length - 1].end('boom'); await flush();
    assert.equal(s.runner.nextStartAt! - t, 1000);
    s.runner.stop();
});

test('watchdog: a stalled process (no windows for 30 s) is killed and restarted', async () => {
    const s = setup();
    await s.boot();
    s.feed(-60, 50);
    s.clock.advance(WATCHDOG_MS); await flush();
    assert.equal(s.procs[0].stopped, true);
    assert.equal(s.runner.state, 'restarting');
    s.clock.advance(1000); await flush();
    assert.equal(s.procs.length, 2);
    s.runner.stop();
});

test('detection: on after a burst, off by the hold timer even when no more windows arrive', async () => {
    const s = setup();
    await s.boot();
    s.feed(-60, 150);
    s.feed(-35, 3);
    assert.deepEqual(s.events, [true]);
    s.clock.advance(9_000);
    assert.deepEqual(s.events, [true]);
    s.clock.advance(1_000);
    assert.deepEqual(s.events, [true, false]);
    s.runner.stop();
});

test('a process ending while detected turns the sensor off', async () => {
    const s = setup();
    await s.boot();
    s.feed(-60, 150);
    s.feed(-35, 3);
    s.procs[0].end('ffmpeg exited (code 1)'); await flush();
    assert.deepEqual(s.events, [true, false]);
    s.runner.stop();
});

test('no audio track: "no audio", checked again after 5 min, 10 min, ... without restart spam; the first window clears it', async () => {
    const s = setup();
    await s.boot();
    s.procs[0].end(`${NO_AUDIO_TRACK} (Stream map '0:a:0' matches no streams.)`); await flush();
    assert.equal(s.runner.state, 'no audio');
    assert.equal(s.runner.noAudio, NO_AUDIO_TRACK);
    s.clock.advance(noAudioDelayMs(0) - 1); await flush();
    assert.equal(s.procs.length, 1);
    s.clock.advance(1); await flush();
    assert.equal(s.procs.length, 2);
    s.procs[1].end(`${NO_AUDIO_TRACK} (again)`); await flush();
    assert.equal(s.runner.nextStartAt! - s.clock.t, noAudioDelayMs(1));
    assert.equal(s.logs.filter(l => l.startsWith('no audio')).length, 1, 'warned once');
    s.clock.advance(noAudioDelayMs(1)); await flush();
    s.feed(-60, 1);
    assert.equal(s.runner.noAudio, undefined, 'one window proves an audio track');
    s.procs[2].end(`${NO_AUDIO_TRACK} (gone again)`); await flush();
    assert.equal(s.runner.nextStartAt! - s.clock.t, noAudioDelayMs(0), 'the backoff started over');
    s.runner.stop();
});

test('a start rejected with "no audio track" (every stream tried) is "no audio", not the fast restart loop', async () => {
    const s = setup({ failStart: () => `${NO_AUDIO_TRACK} (on every stream)` });
    await s.boot();
    assert.equal(s.runner.state, 'no audio');
    assert.equal(s.runner.nextStartAt! - s.clock.t, noAudioDelayMs(0));
    s.runner.stop();
});

test('the long no-audio checks use a fixed per-camera jitter factor', async () => {
    let r = 0;
    const s = setup({ random: () => r });
    await s.boot();
    r = 1; // later draws do not change the factor picked at construction (0.8)
    s.procs[0].end(NO_AUDIO_TRACK); await flush();
    assert.equal(s.runner.nextStartAt! - s.clock.t, noAudioDelayMs(0) * 0.8);
    s.clock.advance(noAudioDelayMs(0) * 0.8); await flush();
    s.procs[1].end(NO_AUDIO_TRACK); await flush();
    assert.equal(s.runner.nextStartAt! - s.clock.t, noAudioDelayMs(1) * 0.8);
    s.runner.stop();
});

test('streams changed: a "no audio" camera is checked again within 2 s, from a fresh backoff', async () => {
    const s = setup();
    await s.boot();
    s.procs[0].end(NO_AUDIO_TRACK); await flush();
    s.clock.advance(noAudioDelayMs(0)); await flush();
    s.procs[1].end(NO_AUDIO_TRACK); await flush();
    s.runner.streamsChanged();
    s.runner.streamsChanged(); // a burst of events: one restart
    s.clock.advance(STREAMS_CHANGED_MS); await flush();
    assert.equal(s.procs.length, 3);
    s.procs[2].end(NO_AUDIO_TRACK); await flush();
    assert.equal(s.runner.nextStartAt! - s.clock.t, noAudioDelayMs(0));
    s.runner.stop();
});

test('streams changed while listening: nothing restarts', async () => {
    const s = setup();
    await s.boot();
    s.runner.streamsChanged();
    s.clock.advance(10_000); await flush();
    assert.equal(s.procs.length, 1);
    assert.equal(s.procs[0].stopped, false);
    s.runner.stop();
});

test('digital silence is a status only: ffmpeg keeps running and a sound is still detected', async () => {
    const s = setup();
    await s.boot();
    s.feed(-120, 700);
    assert.equal(s.runner.silent, true);
    assert.equal(s.runner.state, 'running');
    assert.equal(s.runner.noAudio, undefined);
    assert.equal(s.procs[0].stopped, false);
    s.feed(-30, 3); // a gated camera: the room is silent, then a sound
    assert.deepEqual(s.events, [true]);
    s.feed(-30, 17);
    assert.equal(s.runner.silent, false, 'cleared by 2 s of audio above the absolute minimum');
    assert.equal(s.procs.length, 1);
    s.runner.stop();
});

test('stop: process killed, timers cleared, sensor off, late windows and exits ignored', async () => {
    const s = setup();
    await s.boot();
    s.feed(-60, 150);
    s.feed(-35, 3);
    const p = s.procs[0];
    s.runner.stop();
    assert.equal(p.stopped, true);
    assert.equal(s.clock.pending, 0);
    assert.deepEqual(s.events, [true, false]);
    p.onWindow({ db: -20, sustainedDb: -20 });
    await flush();
    s.clock.advance(120_000); await flush();
    assert.equal(s.procs.length, 1, 'never restarted');
    assert.equal(s.runner.state, 'stopped');
});

test('stop during a pending start: the late process is stopped at once', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const clock = new FakeClock();
    clock.random = () => 0;
    let stopped = 0;
    const runner = new AudioRunner(async () => { await gate; return { stop: () => { stopped++; }, exited: new Promise(() => { }) }; }, new AudioDetector(), { onDetected() { }, log() { }, warn() { } }, clock);
    runner.start();
    clock.advance(0);
    runner.stop();
    release(); await flush();
    assert.equal(stopped, 1);
});
