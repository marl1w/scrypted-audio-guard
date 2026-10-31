import './harness';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Candidate, candidates, FallbackStarter } from '../src/fallback';
import { WindowLevel } from '../src/pcm';
import { AudioProcess, NO_AUDIO_TRACK } from '../src/runner';
import { SAME_STREAM } from '../src/source';
import { flush } from './synth';

test('candidates: low-resolution, local, medium-resolution, then the stream options not reporting audio: null', () => {
    const c = candidates([{ id: 'a', name: 'Main' }, { id: 'b', audio: null }, { id: 'a' }, { id: 'c', audio: { codec: 'aac' } }] as any);
    assert.deepEqual(c.map(x => x.label), ['low-resolution', 'local', 'medium-resolution', 'stream Main', 'stream c']);
    assert.deepEqual(c[3].request, { id: 'a' });
    assert.deepEqual(candidates(undefined).map(x => x.request), [{ destination: 'low-resolution' }, { destination: 'local' }, { destination: 'medium-resolution' }]);
});

/** a fake opener: per label, 'reject' (no audio before ffmpeg), 'same', 'exit' (ffmpeg ends "no audio track"), 'ok' or 'fail' */
function setup(behaviour: Record<string, 'reject' | 'same' | 'exit' | 'ok' | 'fail'>) {
    const opened: string[] = [];
    const procs: { label: string; onWindow: (w: WindowLevel) => void; end: (e?: string) => void; stopped: boolean }[] = [];
    const logs: string[] = [];
    const list = async (): Promise<Candidate[]> => candidates([{ id: 'main', name: 'Main' }] as any);
    const f = new FallbackStarter(list, async (c, _tried, onWindow) => {
        opened.push(c.label);
        const b = behaviour[c.label] ?? 'ok';
        if (b === 'reject') throw new Error(`${NO_AUDIO_TRACK} (the stream reports none)`);
        if (b === 'same') throw new Error(`${SAME_STREAM} (x)`);
        if (b === 'fail') throw new Error('getVideoStream timed out');
        let end!: (e?: string) => void;
        const exited = new Promise<string | undefined>(r => { end = r; });
        const p = { label: c.label, onWindow, end, stopped: false };
        procs.push(p);
        if (b === 'exit')
            setImmediate(() => end(`${NO_AUDIO_TRACK} (matches no streams)`));
        return { stop: () => { p.stopped = true; end(undefined); }, exited } as AudioProcess;
    }, m => logs.push(m));
    return { f, opened, procs, logs };
}

test('low-resolution without audio: falls back to the next stream that has audio, skipping the same stream', async () => {
    const s = setup({ 'low-resolution': 'exit', local: 'same', 'medium-resolution': 'reject' });
    const got: number[] = [];
    const p = await s.f.start(w => got.push(w.db));
    await flush(); await flush(); await flush();
    assert.deepEqual(s.opened, ['low-resolution', 'local', 'medium-resolution', 'stream Main']);
    assert.equal(s.f.current, 'stream Main');
    s.procs[1].onWindow({ db: -50, sustainedDb: -50 });
    assert.deepEqual(got, [-50]);
    assert.equal(s.f.preferred, 'stream Main');
    assert.ok(s.logs.some(l => /no audio track on low-resolution, trying stream Main/.test(l)));
    p.stop();
    assert.equal(await p.exited, undefined);
});

test('the stream that had audio is tried first next time; reset() goes back to low-resolution', async () => {
    const s = setup({ 'low-resolution': 'reject', local: 'reject', 'medium-resolution': 'reject' });
    let p = await s.f.start(() => { });
    s.procs[0].onWindow({ db: -50, sustainedDb: -50 });
    p.stop();
    s.opened.length = 0;
    p = await s.f.start(() => { });
    assert.deepEqual(s.opened, ['stream Main']);
    p.stop();
    s.f.reset();
    s.opened.length = 0;
    p = await s.f.start(() => { });
    assert.equal(s.opened[0], 'low-resolution');
    p.stop();
});

test('no audio on any stream: the start (or the exit) reports "no audio track"', async () => {
    let s = setup({ 'low-resolution': 'reject', local: 'reject', 'medium-resolution': 'same', 'stream Main': 'reject' });
    await assert.rejects(s.f.start(() => { }), new RegExp(`^Error: ${NO_AUDIO_TRACK}`));
    s = setup({ 'low-resolution': 'exit', local: 'reject', 'medium-resolution': 'reject', 'stream Main': 'exit' });
    const p = await s.f.start(() => { });
    assert.match(String(await p.exited), new RegExp(`^${NO_AUDIO_TRACK}`));
});

test('another failure is passed through (the runner backs off quickly), not treated as no audio', async () => {
    const s = setup({ 'low-resolution': 'fail' });
    await assert.rejects(s.f.start(() => { }), /timed out/);
    const t = setup({});
    const p = await t.f.start(() => { });
    t.procs[0].end('ffmpeg exited (code 1)');
    assert.equal(await p.exited, 'ffmpeg exited (code 1)');
    assert.deepEqual(t.opened, ['low-resolution'], 'no fallback on an ordinary failure');
});
