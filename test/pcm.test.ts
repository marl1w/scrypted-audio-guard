import test from 'node:test';
import assert from 'node:assert/strict';
import { MIN_DB, PcmWindower, rmsDbfs, WINDOW_SAMPLES } from '../src/pcm';
import { noise, overlay, silence, sine, windows } from './synth';

test('a full-scale sine is -3 dBFS, a -40 dBFS sine reads -40', () => {
    const full = Buffer.alloc(WINDOW_SAMPLES * 2);
    for (let i = 0; i < WINDOW_SAMPLES; i++)
        full.writeInt16LE(Math.round(32767 * Math.sin((2 * Math.PI * 1000 * i) / 8000)), i * 2);
    assert.ok(Math.abs(rmsDbfs(full) - -3.01) < 0.05, String(rmsDbfs(full)));
    assert.ok(Math.abs(rmsDbfs(sine(-40, 440, 100)) - -40) < 0.2);
});

test('digital silence is the floor value, not -Infinity', () => {
    assert.equal(rmsDbfs(silence(100)), MIN_DB);
    const w = windows(silence(300));
    assert.equal(w.length, 3);
    assert.ok(w.every(x => x.db === MIN_DB && x.sustainedDb === MIN_DB));
});

test('one level per complete 100 ms window, whatever the chunking (odd byte splits included)', () => {
    const pcm = noise(-50, 1050);
    const whole = windows(pcm);
    assert.equal(whole.length, 10);
    const w = new PcmWindower();
    const split: number[] = [];
    for (let i = 0; i < pcm.length; i += 7) // odd chunk size: samples split across chunks
        w.push(pcm.subarray(i, Math.min(pcm.length, i + 7)), x => split.push(x.db));
    assert.deepEqual(split, whole.map(x => x.db));
    whole.forEach(x => assert.ok(Math.abs(x.db - -50) < 1, String(x.db)));
});

test('sustained level: a click in one half of a window leaves the quieter half at the background', () => {
    const [w] = windows(overlay(noise(-60, 100), noise(-20, 20, undefined), 70));
    assert.ok(w.db > -35, `window level ${w.db}`);
    assert.ok(w.sustainedDb < -58, `sustained ${w.sustainedDb}`);
});
