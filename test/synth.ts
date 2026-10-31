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
