// PCM -> levels: signed 16-bit little-endian mono at 8 kHz, cut into 100 ms windows.
// Every sample is read exactly once (O(samples)); no sample buffer is copied.

export const SAMPLE_RATE = 8000;
export const WINDOW_MS = 100;
export const WINDOW_SAMPLES = (SAMPLE_RATE * WINDOW_MS) / 1000; // 800
const HALF = WINDOW_SAMPLES / 2;
/** level reported for an all-zero window (log of zero), and the lowest level ever reported. */
export const MIN_DB = -120;

export interface WindowLevel {
    /** RMS of the whole window, dBFS (a full-scale sine is -3 dBFS). */
    db: number;
    /** RMS of the quieter 50 ms half: high only when the sound fills the whole window (a click on a window edge does not). */
    sustainedDb: number;
}

function toDb(sumSquares: number, n: number): number {
    if (sumSquares <= 0)
        return MIN_DB;
    const rms = Math.sqrt(sumSquares / n) / 32768;
    return Math.max(MIN_DB, 20 * Math.log10(rms));
}

/** RMS level in dBFS of s16le samples. */
export function rmsDbfs(pcm: Uint8Array): number {
    let sum = 0;
    const n = pcm.length >> 1;
    for (let i = 0; i < n; i++) {
        const s = ((pcm[2 * i] | (pcm[2 * i + 1] << 8)) << 16) >> 16;
        sum += s * s;
    }
    return toDb(sum, n);
}

/** Accepts arbitrary chunks of s16le bytes (odd lengths included) and emits one level per complete 100 ms window. */
export class PcmWindower {
    private lo = -1; // pending low byte of a sample split across chunks
    private count = 0; // samples in the current window
    private sum1 = 0; // first half
    private sum2 = 0; // second half

    push(chunk: Uint8Array, onWindow: (w: WindowLevel) => void) {
        let i = 0;
        const len = chunk.length;
        if (this.lo >= 0 && len > 0) {
            this.sample(((this.lo | (chunk[0] << 8)) << 16) >> 16, onWindow);
            this.lo = -1;
            i = 1;
        }
        for (; i + 1 < len; i += 2)
            this.sample(((chunk[i] | (chunk[i + 1] << 8)) << 16) >> 16, onWindow);
        if (i < len)
            this.lo = chunk[i];
    }

    private sample(s: number, onWindow: (w: WindowLevel) => void) {
        if (this.count < HALF)
            this.sum1 += s * s;
        else
            this.sum2 += s * s;
        if (++this.count === WINDOW_SAMPLES) {
            const db = toDb(this.sum1 + this.sum2, WINDOW_SAMPLES);
            const sustainedDb = Math.min(toDb(this.sum1, HALF), toDb(this.sum2, HALF));
            this.count = 0;
            this.sum1 = 0;
            this.sum2 = 0;
            onWindow({ db, sustainedDb });
        }
    }
}

