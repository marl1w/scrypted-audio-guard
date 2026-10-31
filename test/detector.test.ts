import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioDetector, DEFAULT_DETECTOR, PushResult } from '../src/detector';
import { WindowLevel } from '../src/pcm';
import { noise, overlay, rng, silence, windows } from './synth';

/** feeds windows 100 ms apart; returns the push results and the times detected changed */
function feed(d: AudioDetector, ws: WindowLevel[], t0 = 0) {
    const res: PushResult[] = [];
    const on: number[] = [], off: number[] = [];
    ws.forEach((w, i) => {
        const now = t0 + i * 100;
        const r = d.push(w, now);
        res.push(r);
        if (r.changed)
            (r.detected ? on : off).push(now);
    });
    return { res, on, off, end: t0 + ws.length * 100 };
}

test('steady noise: learns a floor, never detects', () => {
    const d = new AudioDetector();
    const r = feed(d, windows(noise(-55, 10 * 60_000, rng(2))));
    assert.deepEqual(r.on, []);
    assert.ok(Math.abs(d.floorDb! - -55) < 1, `floor ${d.floorDb}`);
});

test('no detection while learning (first 10 s)', () => {
    const d = new AudioDetector();
    const r = feed(d, windows(noise(-60, 5000), noise(-20, 1000), noise(-60, 2000)));
    assert.deepEqual(r.on, []);
    assert.equal(d.floorDb, undefined);
});

test('a loud 0.4 s burst at -20 dBFS (breaking glass): detected at its first window, off after the hold', () => {
    const d = new AudioDetector();
    const bg = noise(-60, 60_000, rng(3));
    // burst on window boundaries 30.0-30.4 s and one off the boundaries at 45.05 s
    const pcm = overlay(overlay(bg, noise(-20, 400, rng(4)), 30_000), noise(-20, 400, rng(5)), 45_050);
    const r = feed(d, windows(pcm));
    assert.deepEqual(r.on, [30_000, 45_000], 'an impulse counts at once');
    // hold 10 s after the last spike window (30.3 s; 45.4 s holds 50 ms of the burst)
    assert.deepEqual(r.off, [40_300, 55_400]);
});

test('a sustained moderate sound (1.5 s at -40 dBFS, voices) counts after 1 s; 0.5 s of it does not', () => {
    const d = new AudioDetector();
    const pcm = overlay(overlay(noise(-60, 60_000, rng(31)), noise(-40, 1500, rng(32)), 30_000), noise(-40, 500, rng(33)), 50_000);
    const r = feed(d, windows(pcm));
    assert.deepEqual(r.on, [30_900], 'on at the 10th window');
    assert.equal(r.res.find(x => x.changed && x.detected)?.impulse, false);
});

test('speech with short pauses (0.2 s) counts as one sustained sound; longer pauses restart it', () => {
    const d = new AudioDetector();
    feed(d, windows(noise(-60, 20_000, rng(34))));
    const word = (i: number) => [noise(-40, 300, rng(100 + i)), noise(-60, 200, rng(200 + i))];
    let r = feed(d, windows(...[0, 1, 2].flatMap(word)), 20_000);
    assert.equal(r.on.length, 1, '3 words with 0.2 s pauses');
    d.clear();
    const slow = (i: number) => [noise(-40, 300, rng(300 + i)), noise(-60, 400, rng(400 + i))];
    r = feed(d, windows(noise(-60, 5000), ...[0, 1, 2, 3].flatMap(slow)), 30_000);
    assert.deepEqual(r.on, [], '0.4 s pauses: each word alone is too short');
});

test('hold expiry without new windows (stream gone): expireAt', () => {
    const d = new AudioDetector();
    const r = feed(d, windows(noise(-60, 20_000), noise(-20, 300)));
    assert.equal(r.on.length, 1);
    assert.equal(d.holdLeft(r.end), 10_000 - 100);
    assert.equal(d.expireAt(r.end + 5000), false);
    assert.equal(d.expireAt(r.end + 9_900), true);
    assert.equal(d.detected, false);
});

test('the sensitivity and hold settings apply without forgetting the floor', () => {
    const d = new AudioDetector();
    feed(d, windows(noise(-60, 20_000)));
    d.configure({ sensitivityDb: 25, holdMs: 2000, minSustainedWindows: 5, impulseMinDb: -10 });
    assert.ok(d.floorDb !== undefined);
    let r = feed(d, windows(noise(-40, 1000), noise(-60, 5000)), 20_000);
    assert.deepEqual(r.on, [], '+20 dB is below a 25 dB sensitivity');
    r = feed(d, windows(noise(-30, 1000), noise(-60, 5000)), 30_000);
    assert.deepEqual(r.on, [30_400], '0.5 s duration; -30 dBFS is no impulse below -10 dBFS');
    assert.deepEqual(r.off, [30_900 + 2000]);
});

test('a slowly rising floor (+2 dB per minute for 15 min) never detects', () => {
    const d = new AudioDetector();
    const n = 15 * 60 * 8000;
    const r = feed(d, windows(noise(i => -75 + (30 * i) / n, 15 * 60_000, rng(7))));
    assert.deepEqual(r.on, []);
    assert.ok(d.floorDb! > -54, `the floor followed: ${d.floorDb}`);
});

test('camera self-noise: faint clicks (-54 dBFS over a -69 floor, up to 0.5 s) never detect', () => {
    const d = new AudioDetector();
    let pcm = noise(-69, 60_000, rng(8));
    pcm = overlay(pcm, noise(-54, 100, rng(9)), 20_000); // exactly one window
    pcm = overlay(pcm, noise(-54, 200, rng(10)), 30_050); // 0.2 s across window boundaries
    pcm = overlay(pcm, noise(-40, 20, rng(11)), 40_090); // a sharp 20 ms click on a boundary
    pcm = overlay(pcm, noise(-50, 500, rng(12)), 50_000); // a 0.5 s glitch
    const r = feed(d, windows(pcm));
    assert.deepEqual(r.on, []);
});

test('a loud single window (a bang) detects: the impulse needs both +25 dB over the floor and -30 dBFS', () => {
    const d = new AudioDetector();
    let pcm = noise(-60, 60_000, rng(14));
    pcm = overlay(pcm, noise(-38, 100, rng(15)), 20_000); // +22 dB: not an impulse
    pcm = overlay(pcm, noise(-20, 100, rng(16)), 40_000); // +40 dB and above -30 dBFS
    let r = feed(d, windows(pcm));
    assert.deepEqual(r.on, [40_000]);
    // on a quiet camera (-80), -40 dBFS is +40 dB but below -30 dBFS
    const q = new AudioDetector();
    r = feed(q, windows(overlay(noise(-80, 30_000, rng(17)), noise(-40, 300, rng(18)), 20_000)));
    assert.deepEqual(r.on, []);
});

test('the absolute minimum: a near-silent floor plus small noise does not detect', () => {
    const d = new AudioDetector();
    // floor -85 dBFS, a sound at -50 is +35 dB but below -45 dBFS
    const r = feed(d, windows(noise(-85, 20_000), noise(-50, 2000), noise(-85, 5000)));
    assert.deepEqual(r.on, []);
    const r2 = feed(d, windows(noise(-40, 1500)), r.end);
    assert.equal(r2.on.length, 1, 'above -45 dBFS it does');
});

test('loud windows stay out of the floor (a long sound does not raise it)', () => {
    const d = new AudioDetector();
    feed(d, windows(noise(-60, 60_000)));
    const before = d.floorDb!;
    feed(d, windows(noise(-35, 40_000)), 60_000);
    assert.equal(d.floorDb, before);
    assert.equal(d.detected, true);
});

test('a lasting step in the background rebuilds the floor after 60 s, and the sensor goes off', () => {
    const d = new AudioDetector();
    feed(d, windows(noise(-65, 60_000)));
    const r = feed(d, windows(noise(-40, 120_000, rng(13))), 60_000);
    assert.equal(r.on.length, 1);
    assert.equal(r.res.filter(x => x.rebaselined).length, 1);
    assert.ok(Math.abs(d.floorDb! - -40) < 1.5, `floor ${d.floorDb}`);
    assert.equal(r.off.length, 1, 'off one hold after the rebuild');
    assert.ok(r.off[0] <= 60_000 + 60_000 + 10_000 + 200);
});

test('digital silence: the silent status after 60 s, detection goes on, cleared by ~2 s of audio at or above -45 dBFS', () => {
    const d = new AudioDetector();
    const r = feed(d, windows(silence(150_000)));
    const at = r.res.map((x, i) => x.silentChanged ? i : -1).filter(i => i >= 0);
    assert.deepEqual(at, [DEFAULT_DETECTOR.silenceWindows - 1]);
    assert.equal(d.silent, true);
    // quiet audio below the absolute minimum does not clear it
    feed(d, windows(noise(-70, 5000)), r.end);
    assert.equal(d.silent, true);
    // a gated camera: a short sound in the silence is still detected...
    const r2 = feed(d, windows(silence(1000), noise(-25, 300)), r.end + 5000);
    assert.equal(r2.on.length, 1);
    assert.equal(d.silent, true, '...but 300 ms does not end the silent status');
    // ...and ~2 s of audio in all (not necessarily in a row) ends it
    feed(d, windows(noise(-35, 1000), silence(500), noise(-35, 700)), r2.end);
    assert.equal(d.silent, false);
    const r3 = feed(d, windows(silence(61_000)), r2.end + 2200);
    assert.equal(r3.res.filter(x => x.silentChanged).length, 1, 'a new silent run sets it again');
});

test('-95 dBFS hiss counts as silence, -85 dBFS does not', () => {
    let d = new AudioDetector();
    feed(d, windows(noise(-95, 61_000)));
    assert.equal(d.silent, true);
    d = new AudioDetector();
    feed(d, windows(noise(-85, 61_000)));
    assert.equal(d.silent, false);
});

test('speech-like bursts for minutes (loud, quiet gaps under 1 s, spread over 6 dB) never become the floor', () => {
    const d = new AudioDetector();
    const r0 = rng(21);
    const parts: Buffer[] = [noise(-60, 30_000, rng(22))];
    for (let t = 0; t < 180_000; t += 700)
        parts.push(noise(-25 - r0() * 25, 400, rng(t + 1)), noise(-60, 300, rng(t + 2)));
    const r = feed(d, windows(...parts));
    assert.equal(r.res.filter(x => x.rebaselined).length, 0);
    assert.ok(Math.abs(d.floorDb! - -60) < 1, `floor ${d.floorDb}`);
});

test('the rebuilt floor includes the quieter gap windows of the run (no upward bias)', () => {
    const d = new AudioDetector();
    feed(d, windows(noise(-70, 30_000)));
    // a new background: 80 % at -40, 20 % short dips to -60, below the threshold (-55): gap windows of the run
    const parts: Buffer[] = [];
    for (let t = 0; t < 90_000; t += 1000)
        parts.push(noise(-40, 800, rng(t + 3)), noise(-60, 200, rng(t + 4)));
    const r = feed(d, windows(...parts), 30_000);
    assert.equal(r.res.filter(x => x.rebaselined).length, 1);
    // the 20th percentile of every window of the run is in the dips; recording only the loud windows would give -40
    assert.ok(d.floorDb! < -50, `floor ${d.floorDb}`);
});

test('rain: a steady louder background from the start is learned as the floor and never detects', () => {
    const d = new AudioDetector();
    // rain: -40 dBFS with +-3 dB drops varying every 100 ms
    const r0 = rng(41);
    const r = feed(d, windows(noise(() => -40 + (r0() - 0.5) * 6, 10 * 60_000, rng(42))));
    assert.deepEqual(r.on, []);
});

test('rain starting: the step raises the floor, the sensor goes off and stays off', () => {
    const d = new AudioDetector();
    feed(d, windows(noise(-65, 60_000, rng(43))));
    const r0 = rng(44);
    const r = feed(d, windows(noise(() => -42 + (r0() - 0.5) * 6, 5 * 60_000, rng(45))), 60_000);
    assert.equal(r.on.length, 1, 'the onset itself is one sound');
    assert.equal(r.off.length, 1);
    assert.ok(r.off[0] < 60_000 + 90_000, `off at ${r.off[0]}`);
    assert.ok(d.floorDb! > -46, `floor ${d.floorDb}`);
});

test('wind: gusts swelling 8 dB over a few seconds above a windy background never detect', () => {
    const d = new AudioDetector();
    const n = 10 * 60 * 8000;
    // -55 dBFS, a gust every 7 s up to -47 dBFS
    const r = feed(d, windows(noise(i => -55 + 8 * Math.max(0, Math.sin((2 * Math.PI * i) / (7 * 8000))), n / 8, rng(46))));
    assert.deepEqual(r.on, []);
});
