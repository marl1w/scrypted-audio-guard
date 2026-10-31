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

test('a 300 ms burst +20 dB over the floor: detected at the second window, off after the hold', () => {
    const d = new AudioDetector();
    const bg = noise(-60, 60_000, rng(3));
    // burst on window boundaries 30.0-30.3 s and one off the boundaries at 45.05 s
    const pcm = overlay(overlay(bg, noise(-40, 300, rng(4)), 30_000), noise(-40, 300, rng(5)), 45_050);
    const r = feed(d, windows(pcm));
    assert.deepEqual(r.on, [30_100, 45_200], 'on at the 2nd full window of each burst');
    // hold 10 s after the last spike window (30.2 s, 45.2 s)
    assert.deepEqual(r.off, [40_200, 55_200]);
});

test('hold expiry without new windows (stream gone): expireAt', () => {
    const d = new AudioDetector();
    const r = feed(d, windows(noise(-60, 20_000), noise(-40, 300)));
    assert.equal(r.on.length, 1);
    assert.equal(d.holdLeft(r.end), 10_000 - 100);
    assert.equal(d.expireAt(r.end + 5000), false);
    assert.equal(d.expireAt(r.end + 9_900), true);
    assert.equal(d.detected, false);
});

test('the sensitivity and hold settings apply without forgetting the floor', () => {
    const d = new AudioDetector();
    feed(d, windows(noise(-60, 20_000)));
    d.configure({ sensitivityDb: 25, holdMs: 2000 });
    assert.ok(d.floorDb !== undefined);
    let r = feed(d, windows(noise(-40, 500), noise(-60, 5000)), 20_000);
    assert.deepEqual(r.on, [], '+20 dB is below a 25 dB sensitivity');
    r = feed(d, windows(noise(-30, 500), noise(-60, 5000)), 30_000);
    assert.deepEqual(r.on, [30_100]);
    assert.deepEqual(r.off, [30_400 + 2000]);
});

test('a slowly rising floor (+2 dB per minute for 15 min) never detects', () => {
    const d = new AudioDetector();
    const n = 15 * 60 * 8000;
    const r = feed(d, windows(noise(i => -75 + (30 * i) / n, 15 * 60_000, rng(7))));
    assert.deepEqual(r.on, []);
    assert.ok(d.floorDb! > -54, `the floor followed: ${d.floorDb}`);
});

test('a single-window click (100 ms) does not detect, on or across a window boundary', () => {
    const d = new AudioDetector();
    let pcm = noise(-60, 60_000, rng(8));
    pcm = overlay(pcm, noise(-20, 100, rng(9)), 20_000); // exactly one window
    pcm = overlay(pcm, noise(-20, 100, rng(10)), 30_050); // straddles two windows
    pcm = overlay(pcm, noise(-10, 20, rng(11)), 40_090); // a sharp 20 ms click on a boundary
    pcm = overlay(pcm, noise(-20, 150, rng(12)), 50_050); // 150 ms covers only one full window
    const r = feed(d, windows(pcm));
    assert.deepEqual(r.on, []);
});

test('the absolute minimum: a near-silent floor plus small noise does not detect', () => {
    const d = new AudioDetector();
    // floor -85 dBFS, a "spike" to -55 is +30 dB but below -50 dBFS
    const r = feed(d, windows(noise(-85, 20_000), noise(-55, 1000), noise(-85, 5000)));
    assert.deepEqual(r.on, []);
    const r2 = feed(d, windows(noise(-45, 1000)), r.end);
    assert.equal(r2.on.length, 1, 'above -50 dBFS it does');
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

test('digital silence: the silent status after 60 s, detection goes on, cleared by ~2 s of audio at or above -50 dBFS', () => {
    const d = new AudioDetector();
    const r = feed(d, windows(silence(150_000)));
    const at = r.res.map((x, i) => x.silentChanged ? i : -1).filter(i => i >= 0);
    assert.deepEqual(at, [DEFAULT_DETECTOR.silenceWindows - 1]);
    assert.equal(d.silent, true);
    // quiet audio below the absolute minimum does not clear it
    feed(d, windows(noise(-70, 5000)), r.end);
    assert.equal(d.silent, true);
    // a gated camera: a short sound in the silence is still detected...
    const r2 = feed(d, windows(silence(1000), noise(-35, 300)), r.end + 5000);
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
