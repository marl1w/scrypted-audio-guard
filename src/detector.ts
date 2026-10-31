// The sound detector: a rolling noise floor and spikes above it. Pure: driven by one level per 100 ms window and a clock.
//
// - Noise floor: the 20th percentile of the window levels of the last 5 minutes (3000 windows), windows currently above
//   the threshold left out. A histogram of 0.5 dB bins keeps the percentile O(bins) per window.
// - A sound counts through one of two tiers:
//   - Loud impulse: one window (100 ms) whose level is at least floor + impulseDb and at least impulseMinDb. A bang, a
//     door slam or breaking glass counts at once, however short.
//   - Sustained: windows whose sustained level (their quieter 50 ms half) is at least floor + sensitivity and at least
//     absMinDb, for minSustainedWindows (1 s). Gaps of up to gapWindows quiet windows (between syllables or steps) do
//     not break it. A faint click or a short glitch of the camera never lasts that long.
// - Hold: detected stays on until holdMs after the last spike window.
// - Step change: when the background itself jumps (a fan, rain) the loud windows stay out of the floor. A "run" starts
//   at the first loud window and records EVERY window from then on (quiet gaps included) until runGapWindows quiet
//   windows in a row end it. Once the run's last rebaselineWindows (60 s) are steady (interquartile spread at most
//   steadySpreadDb), the floor is rebuilt from them, so the sensor does not stay on forever. Speech-like bursts are
//   not steady and never become the floor.
// - Digital silence: silenceWindows (60 s) in a row at or below silenceDb sets `silent` (a status only: gated or
//   noise-suppressed cameras send exact zeros in a quiet room, and detection goes on). It clears after
//   silenceClearWindows (2 s) of audio at or above absMinDb.

import { MIN_DB, WINDOW_MS, WindowLevel } from './pcm';

export interface DetectorConfig {
    /** dB above the noise floor that counts as a spike. */
    sensitivityDb: number;
    /** how long detected stays on after the last spike. */
    holdMs: number;
    /** a sustained sound must also be at least this loud (dBFS): a near-silent floor plus small noise never triggers. */
    absMinDb: number;
    /** windows a sustained sound must last (x 100 ms), its short gaps included. */
    minSustainedWindows: number;
    /** quiet windows in a row that a sustained sound may contain without ending. */
    gapWindows: number;
    /** dB above the noise floor that makes one window a loud impulse. */
    impulseDb: number;
    /** a loud impulse must also be at least this loud (dBFS). */
    impulseMinDb: number;
    /** percentile of the floor history (0..1). */
    floorPercentile: number;
    /** windows in the floor history (5 min). */
    floorWindows: number;
    /** windows needed before the floor is trusted (no detection while learning). */
    learnWindows: number;
    /** windows at or below this level are digital silence. */
    silenceDb: number;
    /** consecutive silent windows that make the stream "silent". */
    silenceWindows: number;
    /** windows above the threshold, in one run, after which the floor is rebuilt from them. */
    rebaselineWindows: number;
    /** windows below the threshold that end such a run. */
    runGapWindows: number;
    /** a run is steady (a new background) when the spread between its 25th and 75th percentile is at most this. */
    steadySpreadDb: number;
    /** windows at or above absMinDb that end the silent status. */
    silenceClearWindows: number;
}

export const DEFAULT_SENSITIVITY_DB = 15;
export const DEFAULT_HOLD_S = 10;
export const DEFAULT_MIN_LEVEL_DB = -45;
export const DEFAULT_DURATION_S = 1;
export const DEFAULT_IMPULSE_DB = 25;
export const DEFAULT_IMPULSE_LEVEL_DB = -30;

export const DEFAULT_DETECTOR: DetectorConfig = {
    sensitivityDb: DEFAULT_SENSITIVITY_DB,
    holdMs: DEFAULT_HOLD_S * 1000,
    absMinDb: DEFAULT_MIN_LEVEL_DB,
    minSustainedWindows: (DEFAULT_DURATION_S * 1000) / WINDOW_MS,
    gapWindows: 2,
    impulseDb: DEFAULT_IMPULSE_DB,
    impulseMinDb: DEFAULT_IMPULSE_LEVEL_DB,
    floorPercentile: 0.2,
    floorWindows: (5 * 60_000) / WINDOW_MS,
    learnWindows: 10_000 / WINDOW_MS,
    silenceDb: -90,
    silenceWindows: 60_000 / WINDOW_MS,
    rebaselineWindows: 60_000 / WINDOW_MS,
    runGapWindows: 1000 / WINDOW_MS,
    steadySpreadDb: 6,
    silenceClearWindows: 2000 / WINDOW_MS,
};

const BIN_DB = 0.5;
const BINS = Math.ceil(-MIN_DB / BIN_DB) + 1; // MIN_DB .. 0 dBFS

function binOf(db: number): number {
    return Math.max(0, Math.min(BINS - 1, Math.round((db - MIN_DB) / BIN_DB)));
}

export interface PushResult {
    /** detected changed with this window */
    changed: boolean;
    detected: boolean;
    /** the silent status changed with this window */
    silentChanged: boolean;
    /** the floor was rebuilt from a sustained louder background with this window */
    rebaselined: boolean;
    /** this window counted as a spike (it set or extended the detection) */
    spike: boolean;
    /** the spike was a loud impulse (else a sustained sound) */
    impulse: boolean;
}

export class AudioDetector {
    private hist = new Uint32Array(BINS);
    /** circular history of the bins in the floor */
    private ring: Uint16Array;
    private head = 0;
    private size = 0;
    /** the current run: every window since its first loud one, the last rebaselineWindows of them in a ring */
    private runRing: Uint16Array;
    private runHist = new Uint32Array(BINS);
    private runHead = 0;
    private runSize = 0;
    private inRun = false;
    private runGap = 0;
    private soundRun = 0;
    /** digital silence for silenceWindows: a status only */
    silent = false;
    /** windows of the current sustained sound, its short gaps included (0 = none) */
    private sustained = 0;
    private gap = 0;
    private silentRun = 0;
    private cachedFloor: number | undefined;
    detected = false;
    lastSpikeAt: number | undefined;
    /** wall-clock time of the last spike, for the status line */
    lastSpikeWall: number | undefined;
    lastDb: number | undefined;

    constructor(public config: DetectorConfig = DEFAULT_DETECTOR, private wall: () => number = Date.now) {
        this.ring = new Uint16Array(config.floorWindows);
        this.runRing = new Uint16Array(config.rebaselineWindows);
    }

    /** noise floor in dBFS, undefined while learning. */
    get floorDb(): number | undefined {
        return this.size >= this.config.learnWindows ? this.cachedFloor : undefined;
    }

    get learning(): boolean {
        return this.size < this.config.learnWindows;
    }

    /** Settings changed: keep the learned floor. */
    configure(c: Partial<DetectorConfig>) {
        this.config = { ...this.config, ...c };
    }

    /** A new stream starts: drop the per-run counters, keep the learned floor (same camera, same background). */
    resetRun() {
        this.sustained = 0;
        this.silentRun = 0;
        this.soundRun = 0;
        this.endRun();
    }

    private endRun() {
        this.inRun = false;
        this.runGap = 0;
        this.runHead = 0;
        this.runSize = 0;
        this.runHist.fill(0);
    }

    private addRun(bin: number) {
        const cap = this.runRing.length;
        if (this.runSize === cap)
            this.runHist[this.runRing[this.runHead]]--;
        else
            this.runSize++;
        this.runRing[this.runHead] = bin;
        this.runHead = (this.runHead + 1) % cap;
        this.runHist[bin]++;
    }

    /** the full run window is steady: interquartile spread at most steadySpreadDb */
    private runSteady(): boolean {
        const p25 = percentileOf(this.runHist, this.runSize, 0.25);
        const p75 = percentileOf(this.runHist, this.runSize, 0.75);
        return p75 - p25 <= this.config.steadySpreadDb;
    }

    push(w: WindowLevel, now: number): PushResult {
        const c = this.config;
        this.lastDb = w.db;
        const floor = this.floorDb;
        const flagged = floor !== undefined && w.db >= floor + c.sensitivityDb;
        const loud = floor !== undefined && w.sustainedDb >= floor + c.sensitivityDb && w.sustainedDb >= c.absMinDb;
        const impulse = floor !== undefined && w.db >= floor + c.impulseDb && w.db >= c.impulseMinDb;
        let rebaselined = false;
        const bin = binOf(w.db);

        if (!flagged)
            this.add(bin);
        if (flagged || this.inRun) {
            this.inRun = true;
            this.addRun(bin);
            this.runGap = flagged ? 0 : this.runGap + 1;
            if (this.runGap >= c.runGapWindows)
                this.endRun();
            else if (this.runSize >= c.rebaselineWindows && this.runSteady()) {
                this.rebuild(this.runRing.subarray(0, this.runSize));
                this.endRun();
                rebaselined = true;
            }
        }

        if (loud) {
            this.sustained++;
            this.gap = 0;
        }
        else if (this.sustained > 0 && ++this.gap <= c.gapWindows)
            this.sustained++;
        else
            this.sustained = 0;
        const before = this.detected;
        const spike = impulse || (loud && this.sustained >= c.minSustainedWindows);
        if (spike) {
            this.lastSpikeAt = now;
            this.lastSpikeWall = this.wall();
            this.detected = true;
        }
        else
            this.expireAt(now);

        const wasSilent = this.silent;
        if (w.db <= c.silenceDb) {
            if (++this.silentRun >= c.silenceWindows && !this.silent) {
                this.silent = true;
                this.soundRun = 0;
            }
        }
        else
            this.silentRun = 0;
        // leaves the silent status on ~2 s of audio at or above the absolute minimum (counted while silent, not in a row)
        if (this.silent && w.db >= c.absMinDb && ++this.soundRun >= c.silenceClearWindows)
            this.silent = false;

        return { changed: before !== this.detected, detected: this.detected, silentChanged: wasSilent !== this.silent, rebaselined, spike, impulse: spike && impulse };
    }

    /** ms until the hold ends (0 = ended or not detected). */
    holdLeft(now: number): number {
        if (!this.detected || this.lastSpikeAt === undefined)
            return 0;
        return Math.max(0, this.lastSpikeAt + this.config.holdMs - now);
    }

    /** Ends the hold when it is over; true when detected changed to off. */
    expireAt(now: number): boolean {
        if (this.detected && this.holdLeft(now) <= 0) {
            this.detected = false;
            this.sustained = 0;
            return true;
        }
        return false;
    }

    /** Forces detected off (stream gone, no audio, disabled); true when it was on. */
    clear(): boolean {
        const was = this.detected;
        this.detected = false;
        this.sustained = 0;
        return was;
    }

    private add(bin: number, recompute = true) {
        const cap = this.ring.length;
        if (this.size === cap) {
            this.hist[this.ring[this.head]]--;
        }
        else
            this.size++;
        this.ring[this.head] = bin;
        this.head = (this.head + 1) % cap;
        this.hist[bin]++;
        if (recompute)
            this.cachedFloor = percentileOf(this.hist, this.size, this.config.floorPercentile);
    }

    private rebuild(bins: ArrayLike<number>) {
        this.hist.fill(0);
        this.head = 0;
        this.size = 0;
        // the floor history must be trusted at once: repeat the run if it is shorter than the learning period
        const n = Math.max(bins.length, this.config.learnWindows);
        for (let i = 0; i < n; i++)
            this.add(bins[i % bins.length], false);
        this.cachedFloor = percentileOf(this.hist, this.size, this.config.floorPercentile);
    }
}

/** level (dBFS) at percentile p (0..1) of a bin histogram holding n entries. */
function percentileOf(hist: Uint32Array, n: number, p: number): number {
    const target = Math.max(1, Math.ceil(p * n));
    let acc = 0;
    for (let b = 0; b < BINS; b++) {
        acc += hist[b];
        if (acc >= target)
            return MIN_DB + b * BIN_DB;
    }
    return 0;
}
