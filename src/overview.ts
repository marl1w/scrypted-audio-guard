// Plugin page 'Overview' and 'Performance' (read-only html settings): one row per camera, plugin-wide totals, and
// 60-minute CPU and memory sparklines from a per-minute ring (in memory, reset on plugin restart). Computed only when the
// page is requested; every text is escaped. Look follows Coral Guard's plugin page.

import { C, esc } from './status';

export interface OverviewCamera {
    name: string;
    /** short state and its chip colour */
    state: string;
    color: string;
    restartsHour: number;
    detectionsHour: number;
    lastSound: string;
    /** '-52 / -60 dBFS' or a dash */
    levelFloor: string;
}

export interface ProcSample {
    at: number;
    /** plugin process CPU, % of one core, over the minute before; undefined for the first sample */
    cpuPct?: number;
    rssMb: number;
    /** 100 ms windows per second, all cameras, over the minute before */
    windowsPerS?: number;
}

/** One sample per minute (at most `max`): CPU from the process.cpuUsage() delta, RSS, window throughput from the total delta. */
export class ProcRing {
    samples: ProcSample[] = [];
    private last: { at: number; cpuUs: number; windows: number } | undefined;
    constructor(readonly max = 60) { }

    /** at: ms; cpuUs: user + system µs since the process started; windowsTotal: windows counted since the plugin started. */
    sample(at: number, cpuUs: number, rssBytes: number, windowsTotal: number): ProcSample {
        const l = this.last;
        const dt = l ? at - l.at : 0;
        const s: ProcSample = {
            at,
            rssMb: rssBytes / (1024 * 1024),
            cpuPct: l && dt > 0 ? Math.max(0, ((cpuUs - l.cpuUs) / 1000 / dt) * 100) : undefined,
            windowsPerS: l && dt > 0 ? Math.max(0, (windowsTotal - l.windows) / (dt / 1000)) : undefined,
        };
        this.last = { at, cpuUs, windows: windowsTotal };
        this.samples.push(s);
        while (this.samples.length > this.max)
            this.samples.shift();
        return s;
    }
}

/** Polyline path ('M x y L ...') inside the box for the values (missing ones skipped); '' with fewer than 2 points. A constant series is a flat mid line. */
export function scaledPath(values: (number | undefined)[], box: { x0: number; x1: number; y0: number; y1: number }, range: { min: number; max: number }): string {
    const pts = values.map((v, i) => ({ v, i })).filter((p): p is { v: number; i: number } => typeof p.v === 'number' && Number.isFinite(p.v));
    if (pts.length < 2 || values.length < 2)
        return '';
    const span = range.max - range.min;
    const x = (i: number) => box.x0 + (i / (values.length - 1)) * (box.x1 - box.x0);
    const y = (v: number) => span === 0 ? (box.y0 + box.y1) / 2 : box.y1 - ((Math.min(range.max, Math.max(range.min, v)) - range.min) / span) * (box.y1 - box.y0);
    return pts.map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(' ');
}

/** Axis range auto-scaled with ~10 % padding (never below 0). */
export function axisRange(vals: number[]): { min: number; max: number } {
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const pad = (hi - lo) * 0.1 || Math.max(1, Math.abs(hi) * 0.1);
    return { min: Math.max(0, lo - pad), max: hi + pad };
}

/** 240x50 chart: y labels (top/bottom) with units and a dot on the latest point. '' with fewer than 2 values. */
export function sparkChart(title: string, samples: { at: number; v?: number }[], unit: string, digits: number): string {
    const W = 240, H = 50, box = { x0: 52, x1: 234, y0: 8, y1: 44 };
    const vals = samples.map(s => s.v).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    if (vals.length < 2)
        return '';
    const r = axisRange(vals);
    const path = scaledPath(samples.map(s => s.v), box, r);
    const f = (v: number) => `${v.toFixed(digits)}${unit}`;
    const lastIdx = samples.map(s => s.v).map((v, i) => (typeof v === 'number' && Number.isFinite(v) ? i : -1)).filter(i => i >= 0).pop()!;
    const lastV = samples[lastIdx].v!;
    const lx = box.x0 + (lastIdx / (samples.length - 1)) * (box.x1 - box.x0);
    const ly = box.y1 - ((Math.min(r.max, Math.max(r.min, lastV)) - r.min) / (r.max - r.min || 1)) * (box.y1 - box.y0);
    const t = (x: number, y: number, s: string, anchor = 'start', extra = '') => `<text x="${x}" y="${y}" font-size="12" fill="currentColor" text-anchor="${anchor}"${extra}>${esc(s)}</text>`;
    return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block;color:currentColor" role="img" aria-label="${esc(title)}">`
        + t(box.x0 - 4, box.y0 + 4, f(r.max), 'end', ' opacity=".7"') + t(box.x0 - 4, box.y1, f(r.min), 'end', ' opacity=".7"')
        + `<path d="${path}" fill="none" stroke="currentColor" stroke-width="1.5"/>`
        + `<circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="3" fill="currentColor"><title>${esc(f(lastV))}</title></circle>`
        + `</svg>`;
}

const dash = '—';
/** 100 ms windows per second of one running camera */
const WINDOWS_PER_S = 10;
const chip = (text: string, color: string) => `<span style="display:inline-block;padding:1px 9px;border-radius:11px;border:1px solid ${color};color:${color};white-space:nowrap">&#9679; ${esc(text)}</span>`;

/** Camera table, alphabetical. */
export function renderOverview(cameras: OverviewCamera[]): string {
    const th = (t: string) => `<th style="text-align:left;font-weight:normal;opacity:.7;padding:2px 10px 2px 0">${esc(t)}</th>`;
    const td = (v: string) => `<td style="padding:2px 10px 2px 0;white-space:nowrap">${v}</td>`;
    const rows = cameras.slice().sort((a, b) => a.name.localeCompare(b.name))
        .map(c => `<tr>${td(esc(c.name))}${td(chip(c.state, c.color))}${td(esc(c.levelFloor))}${td(esc(c.lastSound))}${td(esc(String(c.detectionsHour)))}${td(c.restartsHour ? `<span style="color:${C.amber}">${esc(String(c.restartsHour))}</span>` : '0')}</tr>`).join('');
    const table = cameras.length
        ? `<div style="overflow-x:auto"><table style="border-collapse:collapse;color:currentColor;font-size:95%"><tr>${th('Camera')}${th('State')}${th('Level / floor')}${th('Last sound')}${th('Sounds (1 h)')}${th('Restarts (1 h)')}</tr>${rows}</table></div>`
        : `<div style="opacity:.7">No camera has Audio Guard enabled ${dash} enable it per camera under Extensions.</div>`;
    return `<div style="color:currentColor;line-height:1.5">${table}</div>`;
}

export interface Totals {
    /** cameras that should have an ffmpeg: enabled, with an audio track */
    wanted: number;
    /** ffmpeg processes running */
    running: number;
}

/** Tiles (ffmpeg, CPU, memory, audio throughput) and the last-hour CPU and memory sparklines. */
export function renderPerformance(totals: Totals, ring: ProcRing): string {
    const s = ring.samples;
    const last = s[s.length - 1];
    const lastCpu = [...s].reverse().find(x => x.cpuPct !== undefined);
    const lastWps = [...s].reverse().find(x => x.windowsPerS !== undefined);
    const fmt = (v: number | undefined, d: number, u: string) => v === undefined || !Number.isFinite(v) ? 'n/a' : `${v.toFixed(d)}${u}`;
    const tile = (k: string, v: string, color?: string) => `<div style="border:1px solid currentColor;border-color:rgba(127,127,127,.35);border-radius:6px;padding:4px 8px;min-width:110px"><div style="opacity:.7;font-size:85%">${esc(k)}</div><div${color ? ` style="color:${color}"` : ''}>${esc(v)}</div></div>`;
    const expected = totals.running * WINDOWS_PER_S;
    const wps = lastWps?.windowsPerS;
    const tiles = `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px">`
        + tile('ffmpeg running', `${totals.running} of ${totals.wanted}`, totals.running < totals.wanted ? C.amber : undefined)
        + tile('Audio windows/s', `${fmt(wps, 1, '')} of ${expected}`, wps !== undefined && wps < expected * 0.9 ? C.amber : undefined)
        + tile('Plugin CPU', fmt(lastCpu?.cpuPct, 1, ' %'))
        + tile('Plugin memory', fmt(last?.rssMb, 0, ' MB'))
        + `</div><div style="opacity:.7;font-size:85%;margin-top:4px">CPU and memory of this plugin's process (ffmpeg not included), sampled once a minute.</div>`;
    const spark = (k: string, pick: (x: ProcSample) => number | undefined, d: number, u: string) => {
        const svg = sparkChart(k, s.map(x => ({ at: x.at, v: pick(x) })), u, d);
        const body = svg || `<div style="opacity:.7;font-size:85%">Chart after 2 min of samples</div>`;
        return `<div style="min-width:250px"><div style="font-size:85%">${esc(k)}</div>${body}</div>`;
    };
    const sparks = `<div style="opacity:.7;margin-top:10px;font-size:90%">Last 60 min</div><div style="display:flex;flex-wrap:wrap;gap:12px;margin-top:4px">`
        + spark('Plugin CPU', x => x.cpuPct, 1, ' %') + spark('Plugin memory', x => x.rssMb, 0, ' MB')
        + `</div>`;
    return `<div style="color:currentColor;line-height:1.5">${tiles}${sparks}</div>`;
}
