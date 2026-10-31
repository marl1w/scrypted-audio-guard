// The audio process: the camera's low-resolution (prebuffered) stream through Rebroadcast, audio only, decoded by ffmpeg
// to 8 kHz mono s16le on stdout. No video is decoded; on an RTSP input (Rebroadcast) with a known audio track only the
// audio track is set up (-allowed_media_types audio), so the video is not even sent.
// Same resolution path as Coral Guard's frames.ts: getVideoStream -> FFmpegInput -> spawn Scrypted's ffmpeg.

import sdk, { FFmpegInput, RequestMediaStreamOptions, ScryptedMimeTypes, VideoCamera } from '@scrypted/sdk';
import child_process from 'child_process';

import { PcmWindower, SAMPLE_RATE, WindowLevel } from './pcm';
import { AudioProcess, NO_AUDIO_TRACK } from './runner';
import { maskUrls, stderrTail, withTimeout } from './util';

/** a hung getVideoStream/convert must not block the camera forever: fail, and the runner retries with backoff. */
export const STREAM_RESOLVE_MS = 15_000;

/** ffmpeg's messages for an input without an audio stream (the -map below matches nothing). */
export const NO_AUDIO_RE = /matches no streams|does not contain any stream|Output file #?\d* ?does not contain/i;

/**
 * Scrypted's FFmpegInput.inputArguments already ends with `-i <url>` (the rebroadcast input); its url is a single-client
 * listener, so a second `-i url` would be refused. Append `-i url` only when the arguments do not carry one.
 */
export function buildInputArgs(inputArguments: string[] | undefined, url: string): string[] {
    const a = inputArguments || [];
    return a.includes('-i') ? [...a] : [...a, '-i', url];
}

/** reason prefix of a start skipped because the stream resolved to one already found without audio. */
export const SAME_STREAM = 'same stream';

/** True when the input (the last -i) is RTSP: `-f rtsp` before it, or an rtsp:// or rtsps:// url. */
export function isRtspInput(inputArgs: string[]): boolean {
    const at = inputArgs.lastIndexOf('-i');
    if (at < 0)
        return false;
    const f = inputArgs.lastIndexOf('-f', at);
    return (f >= 0 && inputArgs[f + 1] === 'rtsp') || /^rtsps?:\/\//i.test(inputArgs[at + 1] || '');
}

/** RTSP only: set up the audio track alone (the server then sends no video), spliced right before the last -i. */
export function spliceAudioOnly(inputArgs: string[]): string[] {
    if (!isRtspInput(inputArgs) || inputArgs.includes('-allowed_media_types'))
        return [...inputArgs];
    const at = inputArgs.lastIndexOf('-i');
    return [...inputArgs.slice(0, at), '-allowed_media_types', 'audio', ...inputArgs.slice(at)];
}

/** Full ffmpeg argument list: the input arguments, then the first audio track only (-map: nothing else is output), 8 kHz mono PCM. */
export function audioArgs(inputArgs: string[]): string[] {
    return [
        '-hide_banner', '-loglevel', 'error', '-nostdin',
        '-threads', '1',
        ...inputArgs,
        '-map', '0:a:0',
        '-ac', '1', '-ar', String(SAMPLE_RATE),
        '-f', 's16le', 'pipe:1',
    ];
}

export interface SourceOptions {
    camera: VideoCamera;
    console: Console;
    ffmpegPath: () => Promise<string>;
    onWindow: (w: WindowLevel) => void;
    /** which stream to ask for (default: the low-resolution destination) */
    request?: RequestMediaStreamOptions;
    /** stream ids already found without audio: such a stream is not started again (SAME_STREAM); new ones are added */
    tried?: Set<string>;
    resolveTimeoutMs?: number;
    /** injectable for tests */
    spawn?: typeof child_process.spawn;
}

export async function startAudio(o: SourceOptions): Promise<AudioProcess> {
    const timeout = o.resolveTimeoutMs ?? STREAM_RESOLVE_MS;
    const mo = await withTimeout(o.camera.getVideoStream(o.request ?? { destination: 'low-resolution' }), timeout, 'getVideoStream');
    const input = await withTimeout(sdk.mediaManager.convertMediaObjectToJSON<FFmpegInput>(mo, ScryptedMimeTypes.FFmpegInput), timeout, 'stream conversion');
    if (!input.url && !(input.inputArguments || []).includes('-i'))
        throw new Error('getVideoStream returned no url');
    const mso: any = input.mediaStreamOptions || {};
    const streamId: string | undefined = mso.id;
    if (streamId && o.tried?.has(streamId))
        throw new Error(`${SAME_STREAM} (${streamId})`);
    if (mso.audio === null) {
        if (streamId) o.tried?.add(streamId);
        throw new Error(`${NO_AUDIO_TRACK} (the stream reports none)`);
    }
    const ffmpegPath = input.ffmpegPath || await o.ffmpegPath();
    const env = input.env ? { ...process.env, ...input.env } : process.env;
    const inArgs = buildInputArgs(input.inputArguments, input.url!);
    // audio-only setup only for a track the stream reports: a camera without audio still ends in the -map error below
    const args = audioArgs(mso.audio?.codec ? spliceAudioOnly(inArgs) : inArgs);
    const stream = `${mso.name || mso.id || 'low-resolution'}${mso.audio?.codec ? `, audio ${mso.audio.codec}` : ''}${mso.audio?.sampleRate ? ` ${mso.audio.sampleRate} Hz` : ''}`;
    o.console.log(`audio source: ${stream}`);

    const cp = (o.spawn ?? child_process.spawn)(ffmpegPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const windower = new PcmWindower();
    let stopping = false;
    let gotData = false;
    let err = '';
    cp.stdout!.on('data', (d: Buffer) => {
        gotData = true;
        windower.push(d, o.onWindow);
    });
    cp.stderr!.on('data', (d: Buffer) => {
        err = (err + d.toString()).slice(-4000); // may contain the stream URL: only ever logged masked
    });
    const exited = new Promise<string | undefined>(resolve => {
        cp.on('error', e => resolve(`ffmpeg failed: ${maskUrls(String(e.message))}`));
        cp.on('exit', (code, signal) => {
            if (stopping)
                return resolve(undefined);
            if (!gotData && NO_AUDIO_RE.test(err)) {
                if (streamId) o.tried?.add(streamId);
                return resolve(`${NO_AUDIO_TRACK} (${stderrTail(err, 2)})`);
            }
            resolve(`ffmpeg exited (code ${code}, signal ${signal})${err ? ': ' + stderrTail(err, 4) : ''}`);
        });
    });
    return {
        stop: () => { stopping = true; try { cp.kill('SIGKILL'); } catch { /* already gone */ } },
        exited,
    };
}
