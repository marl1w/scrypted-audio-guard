import { ctl } from './harness';
import test from 'node:test';
import assert from 'node:assert/strict';
import child_process from 'child_process';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { audioArgs, buildInputArgs, isRtspInput, SAME_STREAM, spliceAudioOnly, startAudio } from '../src/source';
import { WindowLevel } from '../src/pcm';
import { NO_AUDIO_TRACK } from '../src/runner';
import { noise } from './synth';

const camera: any = { getVideoStream: async (o: any) => { camera.asked = o; return {}; } };

/** a fake ffmpeg child process */
function fakeSpawn() {
    const calls: { path: string; args: string[] }[] = [];
    let cp: any;
    const spawn: any = (path: string, args: string[]) => {
        calls.push({ path, args });
        cp = new EventEmitter();
        cp.stdout = new PassThrough();
        cp.stderr = new PassThrough();
        cp.kill = () => { cp.killed = true; setImmediate(() => cp.emit('exit', null, 'SIGKILL')); };
        return cp;
    };
    return { spawn, calls, cp: () => cp };
}

test('ffmpeg arguments: Rebroadcast input kept as is, first audio track only (-map), 8 kHz mono s16le', () => {
    const input = ['-analyzeduration', '0', '-probesize', '512', '-f', 'rtsp', '-i', 'rtsp://127.0.0.1:1234/abc'];
    const a = audioArgs(buildInputArgs(input, 'rtsp://127.0.0.1:1234/abc'));
    assert.equal(a.filter(x => x === '-i').length, 1, 'the url is not added twice');
    assert.deepEqual(a.slice(a.indexOf('-analyzeduration'), a.indexOf('-analyzeduration') + input.length), input);
    assert.deepEqual(a.slice(-9), ['-map', '0:a:0', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1']);
    assert.deepEqual(buildInputArgs(['-f', 'rtsp'], 'rtsp://x/y'), ['-f', 'rtsp', '-i', 'rtsp://x/y']);
});

test('audio-only RTSP setup: spliced right before -i, only for an RTSP input', () => {
    const rb = ['-analyzeduration', '0', '-rtsp_transport', 'tcp', '-f', 'rtsp', '-i', 'rtsp://127.0.0.1:1/x'];
    assert.deepEqual(spliceAudioOnly(rb), ['-analyzeduration', '0', '-rtsp_transport', 'tcp', '-f', 'rtsp', '-allowed_media_types', 'audio', '-i', 'rtsp://127.0.0.1:1/x']);
    assert.ok(isRtspInput(['-i', 'rtsps://h/x']), 'by url');
    assert.deepEqual(spliceAudioOnly(['-f', 'mp4', '-i', 'http://h/x']), ['-f', 'mp4', '-i', 'http://h/x']);
    assert.deepEqual(spliceAudioOnly(['-f', 'lavfi', '-i', 'sine']), ['-f', 'lavfi', '-i', 'sine']);
    assert.deepEqual(spliceAudioOnly(spliceAudioOnly(rb)), spliceAudioOnly(rb), 'never twice');
});

test('startAudio asks the low-resolution destination and turns stdout PCM into windows', async () => {
    ctl.ffmpegInput = { url: 'rtsp://127.0.0.1:1/x', inputArguments: ['-i', 'rtsp://127.0.0.1:1/x'], mediaStreamOptions: { name: 'sub', audio: { codec: 'aac' } } };
    const f = fakeSpawn();
    const got: WindowLevel[] = [];
    const logs: string[] = [];
    const p = await startAudio({ camera, console: { log: (m: string) => logs.push(m) } as any, ffmpegPath: async () => '/usr/bin/ffmpeg', onWindow: w => got.push(w), spawn: f.spawn });
    assert.deepEqual(camera.asked, { destination: 'low-resolution' });
    assert.equal(f.calls[0].path, '/usr/bin/ffmpeg');
    assert.ok(f.calls[0].args.includes('-allowed_media_types'), 'RTSP with a known audio track: audio-only setup');
    f.cp().stdout.write(noise(-40, 1000));
    await new Promise(r => setImmediate(r));
    assert.equal(got.length, 10);
    assert.ok(Math.abs(got[0].db - -40) < 1);
    assert.match(logs[0], /audio source: sub, audio aac/);
    p.stop();
    assert.equal(await p.exited, undefined, 'a stop is a clean end');
});

test('an exit with "matches no streams" before any audio is "no audio track"; other exits are errors with the url masked', async () => {
    ctl.ffmpegInput = { url: 'rtsp://u:secret@127.0.0.1:1/x', inputArguments: [], mediaStreamOptions: {} };
    let f = fakeSpawn();
    let p = await startAudio({ camera, console: { log() { } } as any, ffmpegPath: async () => 'ffmpeg', onWindow() { }, spawn: f.spawn });
    f.cp().stderr.write("Stream map '0:a:0' matches no streams.\n");
    await new Promise(r => setImmediate(r));
    f.cp().emit('exit', 1, null);
    assert.ok((await p.exited)!.startsWith(NO_AUDIO_TRACK));

    f = fakeSpawn();
    p = await startAudio({ camera, console: { log() { } } as any, ffmpegPath: async () => 'ffmpeg', onWindow() { }, spawn: f.spawn });
    f.cp().stderr.write('rtsp://u:secret@127.0.0.1:1/x?token=abc: Connection refused\n');
    await new Promise(r => setImmediate(r));
    f.cp().emit('exit', 1, null);
    const err = (await p.exited)!;
    assert.match(err, /code 1/);
    assert.doesNotMatch(err, /secret|token=abc/);
});

test('a stream that reports no audio is "no audio track" without starting ffmpeg', async () => {
    ctl.ffmpegInput = { url: 'rtsp://127.0.0.1:1/x', mediaStreamOptions: { audio: null } };
    const f = fakeSpawn();
    await assert.rejects(startAudio({ camera, console: { log() { } } as any, ffmpegPath: async () => 'ffmpeg', onWindow() { }, spawn: f.spawn }), new RegExp(NO_AUDIO_TRACK));
    assert.equal(f.calls.length, 0);
});

const hasFfmpeg = (() => { try { child_process.execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('real ffmpeg: a 16 kHz AAC-like tone is resampled and measured at its level', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
    // -20 dBFS RMS sine: amplitude 0.1414
    ctl.ffmpegInput = { url: 'x', inputArguments: ['-f', 'lavfi', '-i', 'aevalsrc=0.1414*sin(2*PI*440*t):s=16000:d=2'], mediaStreamOptions: {} };
    const got: WindowLevel[] = [];
    const p = await startAudio({ camera, console: { log() { } } as any, ffmpegPath: async () => 'ffmpeg', onWindow: w => got.push(w) });
    assert.match(String(await p.exited), /code 0/);
    assert.ok(got.length >= 19 && got.length <= 20, `${got.length} windows`);
    for (const w of got.slice(1, -1))
        assert.ok(Math.abs(w.db - -20) < 0.5, `level ${w.db}`);
});

test('real ffmpeg: a video-only stream ends as "no audio track"', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
    ctl.ffmpegInput = { url: 'x', inputArguments: ['-f', 'lavfi', '-i', 'testsrc=d=1:s=64x48'], mediaStreamOptions: {} };
    const p = await startAudio({ camera, console: { log() { } } as any, ffmpegPath: async () => 'ffmpeg', onWindow() { } });
    assert.ok(String(await p.exited).startsWith(NO_AUDIO_TRACK), String(await p.exited));
});

test('a stream reporting an audio codec over RTSP gets the audio-only setup; one without audio info does not', async () => {
    ctl.ffmpegInput = { url: 'rtsp://127.0.0.1:1/x', inputArguments: ['-f', 'rtsp', '-i', 'rtsp://127.0.0.1:1/x'], mediaStreamOptions: { id: 'sub', audio: { codec: 'aac' } } };
    let f = fakeSpawn();
    let p = await startAudio({ camera, console: { log() { } } as any, ffmpegPath: async () => 'ffmpeg', onWindow() { }, spawn: f.spawn });
    assert.ok(f.calls[0].args.indexOf('-allowed_media_types') === f.calls[0].args.indexOf('-i') - 2);
    p.stop();
    // unknown audio: a camera without a track must still end in the -map error ("no audio track"), so no splice
    ctl.ffmpegInput = { ...ctl.ffmpegInput, mediaStreamOptions: { id: 'sub' } };
    f = fakeSpawn();
    p = await startAudio({ camera, console: { log() { } } as any, ffmpegPath: async () => 'ffmpeg', onWindow() { }, spawn: f.spawn });
    assert.equal(f.calls[0].args.includes('-allowed_media_types'), false);
    p.stop();
});

test('tried streams: a stream found without audio is remembered and not started again', async () => {
    const tried = new Set<string>();
    ctl.ffmpegInput = { url: 'rtsp://127.0.0.1:1/x', inputArguments: [], mediaStreamOptions: { id: 's1' } };
    const f = fakeSpawn();
    const p = await startAudio({ camera, console: { log() { } } as any, ffmpegPath: async () => 'ffmpeg', onWindow() { }, spawn: f.spawn, tried, request: { destination: 'local' } });
    assert.deepEqual(camera.asked, { destination: 'local' });
    f.cp().stderr.write("Stream map '0:a:0' matches no streams.\n");
    await new Promise(r => setImmediate(r));
    f.cp().emit('exit', 1, null);
    assert.ok((await p.exited)!.startsWith(NO_AUDIO_TRACK));
    assert.deepEqual([...tried], ['s1']);
    await assert.rejects(startAudio({ camera, console: { log() { } } as any, ffmpegPath: async () => 'ffmpeg', onWindow() { }, spawn: f.spawn, tried }), new RegExp(SAME_STREAM));
    assert.equal(f.calls.length, 1, 'no second ffmpeg for the same stream');
});
