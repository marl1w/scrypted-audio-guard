// Per-camera status panel: a bounded per-second history of the last 10 min (typed arrays, O(1) per 100 ms window, no
// allocation) and a renderer that returns one compact, script-free HTML string for a Scrypted Setting of `type: 'html'`.
// Rendered only when the settings page is requested. Look and sizes follow Coral Guard's 'Activity' chart.

/** seconds of history: one bucket per second, 10 min */
export const ACTIVITY_S = 600;
/** dB axis limits: the chart never shows below or above these */
export const AXIS_MIN_DB = -90;
export const AXIS_MAX_DB = 0;
/** smallest dB span of the axis */
const MIN_SPAN_DB = 20;

const SPIKE = 1, PUBLISHED = 2, BACKGROUND = 4;

export const C = { green: '#2f9e5b', amber: '#d9930d', red: '#e5484d', blue: '#3b82f6', gray: '#8b8b8b' };

export function esc(s: unknown): string {
    return String(s ?? '').replace(/[&<>"'`]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c] as string));
}

/** One second of history. */
export interface Bucket {
    /** loudest window level (dBFS) */
    level: number;
    /** noise floor and threshold at the end of the second; NaN while learning */
    floor: number;
    threshold: number;
    /** a spike window (one that counted toward a detection) fell in this second */
    spike: boolean;
    /** audioDetected was on */
    published: boolean;
    /** a sound went on that the background check ignored */
    background: boolean;
}

/** Ring of ACTIVITY_S one-second buckets. A bucket is valid only while its stamp is its own second: no clearing pass on rollover. */
export class ActivityRing {
    private sec = new Float64Array(ACTIVITY_S).fill(-1);
    private level = new Float32Array(ACTIVITY_S);
    private floor = new Float32Array(ACTIVITY_S);
    private threshold = new Float32Array(ACTIVITY_S);
    private flags = new Uint8Array(ACTIVITY_S);

    /** One 100 ms window: O(1), no allocation. floor/threshold undefined while learning. */
    add(nowMs: number, db: number, floor: number | undefined, threshold: number | undefined, spike: boolean, published: boolean, background = false) {
        const s = Math.floor(nowMs / 1000);
        const i = s % ACTIVITY_S;
        if (this.sec[i] !== s) {
            this.sec[i] = s;
            this.level[i] = db;
            this.flags[i] = 0;
        }
        else if (db > this.level[i])
            this.level[i] = db;
        this.floor[i] = floor ?? NaN;
        this.threshold[i] = threshold ?? NaN;
        this.flags[i] |= (spike ? SPIKE : 0) | (published ? PUBLISHED : 0) | (background ? BACKGROUND : 0);
    }

    /** The bucket `ageS` seconds before the current one (0 = the current second); undefined = no audio in that second (a gap). */
    bucket(nowMs: number, ageS: number): Bucket | undefined {
        if (ageS < 0 || ageS >= ACTIVITY_S)
            return undefined;
        const s = Math.floor(nowMs / 1000) - ageS;
        if (s < 0)
            return undefined;
        const i = s % ACTIVITY_S;
        if (this.sec[i] !== s)
            return undefined;
        return { level: this.level[i], floor: this.floor[i], threshold: this.threshold[i], spike: !!(this.flags[i] & SPIKE), published: !!(this.flags[i] & PUBLISHED), background: !!(this.flags[i] & BACKGROUND) };
    }

    /** the last 10 min, oldest first (allocates: render only) */
    series(nowMs: number): (Bucket | undefined)[] {
        const out: (Bucket | undefined)[] = new Array(ACTIVITY_S);
        for (let k = 0; k < ACTIVITY_S; k++)
            out[k] = this.bucket(nowMs, ACTIVITY_S - 1 - k);
        return out;
    }
}

/** Counts per minute over the last hour (60 buckets, stamped like ActivityRing): restarts, detections. O(1) per add. */
export class MinuteCounter {
    private min = new Float64Array(60).fill(-1);
    private n = new Uint32Array(60);

    add(nowMs: number, k = 1) {
        const m = Math.floor(nowMs / 60_000);
        const i = m % 60;
        if (this.min[i] !== m) {
            this.min[i] = m;
            this.n[i] = 0;
        }
        this.n[i] += k;
    }

    /** total of the last 60 minutes (the current one included) */
    sum(nowMs: number): number {
        const m = Math.floor(nowMs / 60_000);
        let s = 0;
        for (let i = 0; i < 60; i++)
            if (this.min[i] > m - 60 && this.min[i] <= m)
                s += this.n[i];
        return s;
    }
}

/** dB axis: the data range rounded out to 10 dB, clamped to AXIS_MIN_DB..AXIS_MAX_DB, at least MIN_SPAN_DB wide. */
export function dbRange(values: number[]): { lo: number; hi: number } {
    const v = values.filter(Number.isFinite);
    if (!v.length)
        return { lo: -80, hi: -20 };
    let lo = Math.max(AXIS_MIN_DB, Math.floor(Math.min(...v) / 10) * 10);
    let hi = Math.min(AXIS_MAX_DB, Math.ceil(Math.max(...v) / 10) * 10);
    if (hi - lo < MIN_SPAN_DB) {
        lo = Math.max(AXIS_MIN_DB, hi - MIN_SPAN_DB);
        hi = Math.min(AXIS_MAX_DB, lo + MIN_SPAN_DB);
    }
    return { lo, hi };
}

/** legend swatch of a line: the same colour, width, dash and opacity as the mark */
const lineSample = (color: string, width: number, dash?: string, opacity = 1) => `<svg width="16" height="8" style="vertical-align:middle" aria-hidden="true"><line x1="0" y1="4" x2="16" y2="4" stroke="${color}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ''} stroke-opacity="${opacity}"/></svg>`;
const FLOOR_DASH = '4 3', FLOOR_OPACITY = .45;
const SOUND_OPACITY = .25;

/** runs of consecutive indexes where `on(k)` holds: [start, end) pairs */
function runs(n: number, on: (k: number) => boolean): [number, number][] {
    const out: [number, number][] = [];
    for (let k = 0; k < n; k++) {
        if (!on(k))
            continue;
        const a = k;
        while (k < n && on(k))
            k++;
        out.push([a, k]);
    }
    return out;
}

/**
 * 'Activity' block over the last 10 min: level (per-second max of the windows' sustained level, what the detector decides on),
 * floor (faint, dashed) and threshold (solid amber) in dBFS, sound bands and the Sensor on lane (green: audioDetected
 * on; grey: a sound the background check ignored). Seconds without audio break the lines. `emptyText` without data, `note` under
 * the legend. Fixed min-width in a scrolling wrapper: the labels stay readable on a phone.
 */
export function renderActivity(ring: ActivityRing, nowMs: number, emptyText = 'Listening, no data yet', note?: string): string {
    const b = ring.series(nowMs);
    const legend = `${lineSample(C.blue, 1.2)} level &nbsp;${lineSample('currentColor', 1.2, FLOOR_DASH, FLOOR_OPACITY)} floor &nbsp;${lineSample(C.amber, 1.5)} threshold &nbsp;`
        + `<span style="display:inline-block;width:10px;height:10px;vertical-align:middle;background:${C.red};opacity:${SOUND_OPACITY * 2}"></span> sound &nbsp;`
        + `<span style="display:inline-block;width:14px;height:7px;vertical-align:middle;background:${C.green}"></span> sensor on &nbsp;`
        + `<span style="display:inline-block;width:14px;height:7px;vertical-align:middle;background:${C.gray}"></span> background`;
    const head = `<div style="margin-top:10px"><div style="font-weight:600">Activity</div><div style="opacity:.7;font-size:85%">${legend}</div>`
        + (note ? `<div style="opacity:.7;font-size:85%">${esc(note)}</div>` : '');
    if (!b.some(Boolean))
        return head + `<div style="opacity:.7;margin-top:4px">${esc(emptyText)}</div></div>`;

    const W = 600, x0 = 64, x1 = 594, bw = (x1 - x0) / ACTIVITY_S, top = 10, base = 70, H = 108, FS = 12;
    const all: number[] = [];
    for (const x of b)
        if (x)
            all.push(Math.max(AXIS_MIN_DB, x.level), x.floor, x.threshold);
    const { lo, hi } = dbRange(all);
    const y = (v: number) => (base - ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * (base - top)).toFixed(1);
    const xc = (k: number) => (x0 + (k + 0.5) * bw).toFixed(1);
    const xs = (k: number) => (x0 + k * bw).toFixed(1);
    const width = (a: number, e: number) => Math.max(1, (e - a) * bw).toFixed(1);
    /** polyline of one series, broken at seconds without audio and at missing values */
    const path = (pick: (x: Bucket) => number) => {
        let d = '', pen = false;
        b.forEach((x, k) => {
            const v = x ? pick(x) : NaN;
            if (!Number.isFinite(v)) { pen = false; return; }
            d += `${pen ? 'L' : 'M'}${xc(k)} ${y(v)}`;
            pen = true;
        });
        return d;
    };
    const line = (d: string, color: string, w: number, extra = '') => d ? `<path d="${d}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linejoin="round"${extra}/>` : '';
    const spikes = runs(ACTIVITY_S, k => !!b[k]?.spike).map(([a, e]) => `<rect x="${xs(a)}" y="${top}" width="${width(a, e)}" height="${base - top}" fill="${C.red}" fill-opacity="${SOUND_OPACITY}"><title>${esc(`sound, ${e - a} s`)}</title></rect>`).join('');
    const ly = base + 6;
    const lane = `<text x="${x0 - 4}" y="${ly + 7}" font-size="${FS}" fill="currentColor" text-anchor="end" opacity=".7">Sensor on</text>`
        + `<rect x="${x0}" y="${ly}" width="${x1 - x0}" height="8" fill="currentColor" fill-opacity=".08"/>`
        + runs(ACTIVITY_S, k => !!b[k]?.background && !b[k]?.published).map(([a, e]) => `<rect x="${xs(a)}" y="${ly}" width="${width(a, e)}" height="8" fill="${C.gray}"><title>${esc(`background, ${e - a} s`)}</title></rect>`).join('')
        + runs(ACTIVITY_S, k => !!b[k]?.published).map(([a, e]) => `<rect x="${xs(a)}" y="${ly}" width="${width(a, e)}" height="8" fill="${C.green}"/>`).join('');
    const t = (tx: number, ty: number, s: string, a = 'start') => `<text x="${tx}" y="${ty}" font-size="${FS}" fill="currentColor" text-anchor="${a}" opacity=".7">${esc(s)}</text>`;
    return head
        + `<div style="overflow-x:auto"><svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;min-width:360px;max-width:${W}px;color:currentColor" role="img" aria-label="Activity, last 10 minutes">`
        + t(x0 - 4, top + 9, `${hi} dBFS`, 'end') + t(x0 - 4, base, `${lo} dBFS`, 'end')
        + `<line x1="${x0}" y1="${base}" x2="${x1}" y2="${base}" stroke="currentColor" stroke-opacity=".3"/>`
        + spikes
        + line(path(x => x.floor), 'currentColor', 1.2, ` stroke-opacity="${FLOOR_OPACITY}" stroke-dasharray="${FLOOR_DASH}"`)
        + line(path(x => x.threshold), C.amber, 1.5)
        + line(path(x => Math.max(AXIS_MIN_DB, x.level)), C.blue, 1.2)
        + lane
        + t(x0, H - 2, '10 min ago') + t(x1, H - 2, 'now', 'end')
        + `</svg></div></div>`;
}

/** 'just now', '42 s ago', '12 min ago', '3 h ago', '2 d ago'; 'never' when undefined. */
export function relTime(thenMs: number | undefined, nowMs: number): string {
    if (thenMs === undefined || !Number.isFinite(thenMs))
        return 'never';
    const s = Math.max(0, Math.round((nowMs - thenMs) / 1000));
    if (s < 5)
        return 'just now';
    if (s < 60)
        return `${s} s ago`;
    const m = Math.floor(s / 60);
    if (m < 60)
        return `${m} min ago`;
    const h = Math.floor(m / 60);
    return h < 48 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`;
}

/** The camera's Status setting: the status line, then the Activity chart. */
export function renderStatus(statusLine: string, ring: ActivityRing, nowMs: number, emptyText?: string, note?: string): string {
    return `<div style="font-size:90%;line-height:1.45;max-width:680px;color:currentColor">`
        + `<div>${esc(statusLine)}</div>`
        + renderActivity(ring, nowMs, emptyText, note)
        + `</div>`;
}
