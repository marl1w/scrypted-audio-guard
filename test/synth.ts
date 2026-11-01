// Synthetic PCM (s16le, 8 kHz mono) and a fake clock for the tests.
import { PcmWindower, SAMPLE_RATE, WindowLevel } from '../src/pcm';
import { Timers } from '../src/runner';

/** deterministic PRNG (mulberry32) */
export function rng(seed = 1): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Uniform white noise at an RMS level of `db` dBFS for `ms` (a uniform signal of peak A has RMS A/sqrt(3)). */
export function noise(db: number | ((i: number) => number), ms: number, r = rng()): Buffer {
    const n = Math.round((SAMPLE_RATE * ms) / 1000);
    const buf = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) {
        const level = typeof db === 'number' ? db : db(i);
        const peak = Math.pow(10, level / 20) * 32768 * Math.sqrt(3);
        const s = Math.max(-32768, Math.min(32767, Math.round((r() * 2 - 1) * peak)));
        buf.writeInt16LE(s, i * 2);
    }
    return buf;
}

/** Wind on a microphone: white noise through two one-pole low-passes at ~100 Hz, scaled to an RMS of `db` dBFS and clipped
 *  at full scale (a gust can overload the microphone). It swells in and dies out over 100 ms, as a gust does. */
export function rumble(db: number, ms: number, r = rng()): Buffer {
    const n = Math.round((SAMPLE_RATE * ms) / 1000);
    const k = 1 - Math.exp((-2 * Math.PI * 100) / SAMPLE_RATE);
    const y = new Float64Array(n);
    let a = 0, b = 0, sum = 0;
    for (let i = 0; i < n; i++) {
        a += k * (r() * 2 - 1 - a);
        b += k * (a - b);
        y[i] = b;
        sum += b * b;
    }
    const gain = (Math.pow(10, db / 20) * 32768) / Math.sqrt(sum / n || 1);
    const buf = Buffer.alloc(n * 2);
    const fade = Math.min(n / 2, SAMPLE_RATE / 10);
    for (let i = 0; i < n; i++) {
        const env = Math.min(1, i / fade, (n - 1 - i) / fade);
        buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(y[i] * gain * env))), i * 2);
    }
    return buf;
}

/** Sum of two buffers of the same length (clipped). */
export function mix(a: Buffer, b: Buffer): Buffer {
    const out = Buffer.alloc(a.length);
    for (let i = 0; i + 1 < a.length; i += 2)
        out.writeInt16LE(Math.max(-32768, Math.min(32767, a.readInt16LE(i) + (i + 1 < b.length ? b.readInt16LE(i) : 0))), i);
    return out;
}

/** A shout-like voice: a 300 Hz fundamental and its harmonics up to 3 kHz, falling 3 dB per harmonic, RMS `db` dBFS. */
export function voice(db: number, ms: number): Buffer {
    const n = Math.round((SAMPLE_RATE * ms) / 1000);
    const y = new Float64Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) {
        for (let h = 1; h * 300 <= 3000; h++)
            y[i] += Math.pow(10, (-3 * (h - 1)) / 20) * Math.sin((2 * Math.PI * 300 * h * i) / SAMPLE_RATE);
        sum += y[i] * y[i];
    }
    const gain = (Math.pow(10, db / 20) * 32768) / Math.sqrt(sum / n);
    const buf = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++)
        buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(y[i] * gain))), i * 2);
    return buf;
}

export function silence(ms: number): Buffer {
    return Buffer.alloc(Math.round((SAMPLE_RATE * ms) / 1000) * 2);
}

export function sine(db: number, hz: number, ms: number): Buffer {
    const n = Math.round((SAMPLE_RATE * ms) / 1000);
    const buf = Buffer.alloc(n * 2);
    const peak = Math.pow(10, db / 20) * 32768 * Math.SQRT2;
    for (let i = 0; i < n; i++)
        buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(peak * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE)))), i * 2);
    return buf;
}

/** Cuts PCM into 100 ms windows. */
export function windows(...parts: Buffer[]): WindowLevel[] {
    const out: WindowLevel[] = [];
    const w = new PcmWindower();
    for (const p of parts)
        w.push(p, x => out.push(x));
    return out;
}

/** Overwrites `insert` into `base` at `atMs` (a burst or click inside the background). */
export function overlay(base: Buffer, insert: Buffer, atMs: number): Buffer {
    const out = Buffer.from(base);
    insert.copy(out, Math.round((SAMPLE_RATE * atMs) / 1000) * 2);
    return out;
}

/** Manual clock: timers fire only in advance(). */
export class FakeClock implements Timers {
    t = 0;
    private seq = 0;
    private timers = new Map<number, { at: number; fn: () => void }>();
    now = () => this.t;
    setTimeout = (fn: () => void, ms: number) => {
        const id = ++this.seq;
        this.timers.set(id, { at: this.t + Math.max(0, ms), fn });
        return id;
    };
    clearTimeout = (h: unknown) => { this.timers.delete(h as number); };
    /** jitter source: 0.5 = no jitter on the delays (factor 1), half of the start jitter */
    random = () => 0.5;
    get pending() { return this.timers.size; }
    advance(ms: number) {
        const end = this.t + ms;
        for (;;) {
            let next: [number, { at: number; fn: () => void }] | undefined;
            for (const e of this.timers)
                if (e[1].at <= end && (!next || e[1].at < next[1].at))
                    next = e;
            if (!next)
                break;
            this.timers.delete(next[0]);
            this.t = next[1].at;
            next[1].fn();
        }
        this.t = end;
    }
}

export const flush = () => new Promise<void>(r => setImmediate(r));
