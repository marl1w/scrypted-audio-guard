import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIVITY_S, ActivityRing, dbRange, esc, MinuteCounter, relTime, renderActivity, renderStatus } from '../src/status';

const T0 = 1_000_000; // ms, on a second boundary

/** n windows 100 ms apart from `from` */
function fill(r: ActivityRing, from: number, n: number, db: number, floor = -60, spike = false, published = false) {
    for (let i = 0; i < n; i++)
        r.add(from + i * 100, db, floor, floor + 15, spike, published);
    return from + n * 100;
}

test('ring: a second aggregates its windows (level max, last floor and threshold, spike and published ORed)', () => {
    const r = new ActivityRing();
    r.add(T0, -50, -61, -46, false, false);
    r.add(T0 + 100, -30, -60, -45, true, false);
    r.add(T0 + 200, -55, -59, -44, false, true);
    r.add(T0 + 900, -40, -58, -43, false, false);
    const b = r.bucket(T0 + 999, 0)!;
    assert.equal(b.level, -30);
    assert.equal(b.floor, -58);
    assert.equal(b.threshold, -43);
    assert.equal(b.spike, true);
    assert.equal(b.published, true);
    assert.equal(r.bucket(T0 + 1000, 0), undefined, 'the next second is empty');
    assert.equal(r.bucket(T0 + 1000, 1)!.level, -30);
});

test('ring: learning (no floor) is stored as NaN, not as a value', () => {
    const r = new ActivityRing();
    r.add(T0, -50, undefined, undefined, false, false);
    const b = r.bucket(T0, 0)!;
    assert.ok(Number.isNaN(b.floor) && Number.isNaN(b.threshold));
});

test('ring rollover: a slot reused after 10 min starts afresh, data older than 10 min is gone', () => {
    const r = new ActivityRing();
    r.add(T0, -20, -60, -45, true, true);
    assert.ok(r.bucket(T0 + (ACTIVITY_S - 1) * 1000, ACTIVITY_S - 1), 'still inside the 10 min');
    assert.equal(r.bucket(T0 + ACTIVITY_S * 1000, ACTIVITY_S), undefined, 'out of range');
    // the same slot, 600 s later
    r.add(T0 + ACTIVITY_S * 1000, -70, -75, -60, false, false);
    const b = r.bucket(T0 + ACTIVITY_S * 1000, 0)!;
    assert.equal(b.level, -70, 'not the max with the old -20');
    assert.equal(b.spike, false);
    assert.equal(b.published, false);
    // a long run: the ring holds exactly the last 600 s
    const r2 = new ActivityRing();
    const end = fill(r2, T0, 10 * (ACTIVITY_S + 50), -60);
    const s = r2.series(end - 1);
    assert.equal(s.length, ACTIVITY_S);
    assert.ok(s.every(Boolean));
});

test('ring: seconds without windows are gaps (no audio, ffmpeg down); the chart breaks its lines there, no gap bars', () => {
    const r = new ActivityRing();
    let t = fill(r, T0, 50, -60); // 5 s of audio
    t += 20_000; // 20 s without windows
    t = fill(r, t, 50, -60);
    const s = r.series(t - 1);
    const gaps = s.slice(-30).filter(x => !x).length;
    assert.equal(gaps, 20);
    assert.ok(s[ACTIVITY_S - 1], 'the current second has data');
    const html = renderActivity(r, t - 1);
    assert.ok(!html.includes('no audio'), 'no gap bars, none before the first data either');
    const level = /<path d="([^"]+)" fill="none" stroke="#3b82f6"/.exec(html)![1];
    assert.equal((level.match(/M/g) || []).length, 2, 'the level line is broken by the gap');
});

test('minute counter: last hour only, a slot reused after an hour restarts at zero', () => {
    const c = new MinuteCounter();
    c.add(0);
    c.add(30_000);
    c.add(5 * 60_000, 3);
    assert.equal(c.sum(5 * 60_000), 5);
    assert.equal(c.sum(60 * 60_000), 3, 'minute 0 is more than an hour ago');
    c.add(60 * 60_000); // the slot of minute 0
    assert.equal(c.sum(60 * 60_000), 4);
    assert.equal(c.sum(3 * 60 * 60_000), 0);
});

test('dB axis: rounded out to 10 dB, clamped to -90..0, at least 20 dB', () => {
    assert.deepEqual(dbRange([-62, -45, -33]), { lo: -70, hi: -30 });
    assert.deepEqual(dbRange([-120, 5]), { lo: -90, hi: 0 });
    assert.deepEqual(dbRange([-61, -60]), { lo: -80, hi: -60 });
    assert.deepEqual(dbRange([-2, -1]), { lo: -20, hi: 0 });
    assert.deepEqual(dbRange([-95, -92]), { lo: -90, hi: -70 });
    assert.deepEqual(dbRange([NaN]), { lo: -80, hi: -20 });
});

test('render: level, floor (dashed) and threshold (dotted) lines, sound band, Published lane, axes and legend', () => {
    const r = new ActivityRing();
    let t = fill(r, T0, 300, -60);
    t = fill(r, t, 20, -30, -60, true, true);
    t = fill(r, t, 100, -60, -60, false, true);
    const html = renderActivity(r, t - 1);
    assert.match(html, /<div style="font-weight:600">Activity<\/div>/);
    for (const l of ['level', 'floor', 'threshold', 'sound', 'sensor on'])
        assert.ok(html.includes(`</span> ${l}`) || html.includes(`</svg> ${l}`), `legend ${l}`);
    assert.ok(!html.includes(' gap'), 'no gap legend');
    assert.match(html, /<div style="overflow-x:auto"><svg [^>]*min-width:360px/, 'phone: scrolls instead of shrinking');
    assert.ok(!html.includes('font-size="10"'));
    assert.equal((html.match(/<path d="M/g) || []).length, 3, 'three lines');
    assert.match(html, /<path [^>]*stroke="#3b82f6" stroke-width="1.2"/, 'level line');
    assert.match(html, /<path [^>]*stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" stroke-opacity="0.45" stroke-dasharray="4 3"\/>/, 'floor faint, dashed');
    assert.match(html, /<path [^>]*stroke="#d9930d" stroke-width="1.5" stroke-linejoin="round"\/>/, 'threshold solid amber');
    assert.match(html, /<line [^>]*stroke="#d9930d" stroke-width="1.5" stroke-opacity="1"\/>/, 'threshold swatch matches');
    assert.match(html, /<title>sound, 2 s<\/title>/);
    assert.match(html, />Sensor on<\/text>/);
    assert.equal((html.match(/fill="#2f9e5b"/g) || []).length, 1, 'one Published run');
    assert.match(html, />-30 dBFS<\/text>/);
    assert.match(html, />-60 dBFS<\/text>/);
    assert.match(html, />10 min ago<\/text>/);
    assert.match(html, />now<\/text>/);
    assert.ok(!/NaN/.test(html));
});

test('render: a learning stretch draws no floor or threshold, digital silence is clamped to the axis floor', () => {
    const r = new ActivityRing();
    for (let i = 0; i < 50; i++)
        r.add(T0 + i * 100, -120, undefined, undefined, false, false);
    const html = renderActivity(r, T0 + 4999);
    assert.equal((html.match(/<path d="M/g) || []).length, 1, 'level only');
    assert.match(html, />-90 dBFS<\/text>/);
    assert.ok(!/NaN/.test(html));
});

test('empty state: listening, no data yet (legend kept, no chart)', () => {
    const html = renderActivity(new ActivityRing(), T0);
    assert.match(html, /Listening, no data yet/);
    assert.ok(!html.includes('<path'));
    assert.match(renderActivity(new ActivityRing(), T0, 'No audio, no data'), /No audio, no data/);
    // data older than 10 min counts as none
    const r = new ActivityRing();
    fill(r, T0, 10, -60);
    assert.match(renderActivity(r, T0 + 11 * 60_000), /Listening, no data yet/);
});

test('escaping: the status line and the empty text are escaped', () => {
    assert.equal(esc(`<a href="x">'&\``), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#96;');
    const html = renderStatus('Reconnecting (<script>alert(1)</script>)', new ActivityRing(), T0, '"><img src=x>');
    assert.ok(!html.includes('<script>'));
    assert.ok(!html.includes('<img'));
    assert.match(html, /Reconnecting \(&lt;script&gt;alert\(1\)&lt;\/script&gt;\)/);
    assert.match(html, /&quot;&gt;&lt;img src=x&gt;/);
});

test('relative time', () => {
    assert.equal(relTime(undefined, 0), 'never');
    assert.equal(relTime(0, 3000), 'just now');
    assert.equal(relTime(0, 42_000), '42 s ago');
    assert.equal(relTime(0, 12 * 60_000 + 5000), '12 min ago');
    assert.equal(relTime(0, 3 * 3600_000), '3 h ago');
    assert.equal(relTime(0, 50 * 3600_000), '2 d ago');
});
