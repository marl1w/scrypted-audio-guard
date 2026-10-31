import test from 'node:test';
import assert from 'node:assert/strict';
import { OverviewCamera, ProcRing, renderOverview, renderPerformance, sparkChart } from '../src/overview';

const cam = (o: Partial<OverviewCamera> = {}): OverviewCamera => ({
    name: 'Cam A', state: 'Listening', color: '#2f9e5b', restartsHour: 0, detectionsHour: 2, lastSound: '12:00:00', levelFloor: '-55 / -60 dBFS', ...o,
});

test('proc ring: CPU % and windows/s from the deltas, RSS in MB, at most max samples', () => {
    const r = new ProcRing(3);
    const a = r.sample(0, 1_000_000, 100 * 1024 * 1024, 0);
    assert.equal(a.cpuPct, undefined, 'the first sample is a baseline');
    assert.equal(a.windowsPerS, undefined);
    assert.equal(a.rssMb, 100);
    // 60 s later: 1.2 s of CPU (2 %), 1200 windows (20/s = two cameras)
    const b = r.sample(60_000, 2_200_000, 110 * 1024 * 1024, 1200);
    assert.ok(Math.abs(b.cpuPct! - 2) < 1e-9);
    assert.equal(b.windowsPerS, 20);
    r.sample(120_000, 2_200_000, 1, 1200);
    r.sample(180_000, 2_200_000, 1, 1200);
    assert.equal(r.samples.length, 3);
    assert.equal(r.samples[0].at, 60_000);
    assert.equal(r.samples[2].cpuPct, 0);
});

test('overview: one escaped row per camera, alphabetical, restarts highlighted; empty state', () => {
    const html = renderOverview([cam({ name: 'Zed <b>' }), cam({ name: 'Alpha', state: 'No audio', color: '#8b8b8b', restartsHour: 3 })]);
    assert.ok(html.indexOf('Alpha') < html.indexOf('Zed'));
    assert.match(html, /Zed &lt;b&gt;/);
    assert.ok(!html.includes('<b>'));
    assert.match(html, /&#9679; No audio/);
    assert.match(html, /color:#d9930d">3</);
    assert.match(html, /-55 \/ -60 dBFS/);
    for (const h of ['Camera', 'State', 'Level / floor', 'Last sound', 'Sounds (1 h)', 'Restarts (1 h)'])
        assert.ok(html.includes(`>${h.replace('/', '/')}</th>`), h);
    assert.match(renderOverview([]), /No camera has Audio Guard enabled/);
});

test('performance: ffmpeg running of wanted, audio windows/s of expected, CPU and memory; sparklines after two samples', () => {
    const r = new ProcRing(60);
    const totals = { wanted: 2, running: 2 };
    let html = renderPerformance(totals, r);
    assert.match(html, />2 of 2</);
    assert.match(html, /Chart after 2 min of samples/);
    r.sample(0, 0, 50 * 1024 * 1024, 0);
    r.sample(60_000, 600_000, 52 * 1024 * 1024, 1080);
    r.sample(120_000, 1_800_000, 54 * 1024 * 1024, 2160);
    html = renderPerformance(totals, r);
    assert.match(html, />2\.0 %</, 'latest CPU');
    assert.match(html, />54 MB</);
    assert.match(html, /Audio windows\/s<\/div><div>18\.0 of 20</, 'within 10 %: no warning colour');
    assert.ok(!/Sounds|Restarts|collecting/.test(html), 'no duplicate tiles, no collecting text');
    assert.equal((html.match(/<svg width="240"/g) || []).length, 2, 'CPU and memory sparklines');
    assert.match(html, /aria-label="Plugin CPU"/);
    assert.match(html, /aria-label="Plugin memory"/);
    assert.equal((html.match(/<circle /g) || []).length, 2, 'a last-value dot each');
    assert.ok(!/stroke-dasharray|min \d|NaN|undefined/.test(html), 'no midline, no min/max line');
    // fewer windows than expected, or fewer ffmpeg than wanted: amber
    r.sample(180_000, 1_800_000, 1, 2760);
    html = renderPerformance({ wanted: 3, running: 2 }, r);
    assert.match(html, /color:#d9930d">2 of 3</);
    assert.match(html, /color:#d9930d">10\.0 of 20</);
});

test('sparkline: nothing with fewer than two values; title escaped; y labels only', () => {
    assert.equal(sparkChart('x', [{ at: 0, v: 1 }], '', 0), '');
    const svg = sparkChart('<t>', [{ at: 0, v: 1 }, { at: 60_000, v: 3 }], ' %', 0);
    assert.match(svg, /aria-label="&lt;t&gt;"/);
    assert.equal((svg.match(/<text /g) || []).length, 2);
    assert.ok(!svg.includes('ago'));
});
