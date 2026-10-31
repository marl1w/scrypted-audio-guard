// Stream fallback: the low-resolution stream first; when it has no audio track, the other destinations ('local', then
// 'medium-resolution') and then the camera's other stream options that do not report "no audio". Streams that resolve to
// one already found without audio are skipped without starting ffmpeg. The stream that worked is tried first next time.

import { MediaStreamOptions, RequestMediaStreamOptions } from '@scrypted/sdk';

import { WindowLevel } from './pcm';
import { AudioProcess, AudioStarter, NO_AUDIO_TRACK } from './runner';
import { SAME_STREAM } from './source';

export interface Candidate {
    label: string;
    request: RequestMediaStreamOptions;
}

export const DESTINATIONS = ['low-resolution', 'local', 'medium-resolution'] as const;

/** The destinations, then each stream option (by id) that does not report audio: null. */
export function candidates(options: MediaStreamOptions[] | undefined): Candidate[] {
    const out: Candidate[] = DESTINATIONS.map(d => ({ label: d, request: { destination: d } }));
    const seen = new Set<string>();
    for (const o of options || []) {
        if (!o?.id || seen.has(o.id) || o.audio === null)
            continue;
        seen.add(o.id);
        out.push({ label: `stream ${o.name || o.id}`, request: { id: o.id } });
    }
    return out;
}

export type Opener = (c: Candidate, tried: Set<string>, onWindow: (w: WindowLevel) => void) => Promise<AudioProcess>;

const noAudio = (msg: string) => msg.startsWith(NO_AUDIO_TRACK) || msg.startsWith(SAME_STREAM);

export class FallbackStarter {
    /** label of the stream that last had audio */
    preferred: string | undefined;
    /** label of the stream in use */
    current: string | undefined;

    constructor(private list: () => Promise<Candidate[]>, private open: Opener, private log: (m: string) => void) { }

    /** The camera's streams changed: start again from the low-resolution stream. */
    reset() {
        this.preferred = undefined;
    }

    readonly start: AudioStarter = async onWindow => {
        let list = await this.list();
        const at = this.preferred ? list.findIndex(c => c.label === this.preferred) : -1;
        if (at > 0)
            list = [list[at], ...list.slice(0, at), ...list.slice(at + 1)];
        const tried = new Set<string>();
        let stopped = false;
        let k = 0;
        let heard = false;
        const windows = (w: WindowLevel) => {
            if (!heard) {
                heard = true;
                this.preferred = list[k]?.label; // this stream has audio: try it first next time
            }
            onWindow(w);
        };

        /** opens list[k..] until one starts; undefined when every stream has no audio; throws any other failure. */
        const next = async (): Promise<AudioProcess | undefined> => {
            for (; k < list.length; k++) {
                try {
                    const p = await this.open(list[k], tried, windows);
                    this.current = list[k].label;
                    return p;
                }
                catch (e: any) {
                    if (!noAudio(String(e?.message || e)))
                        throw e;
                }
            }
            return undefined;
        };

        let proc = await next();
        if (!proc)
            throw new Error(`${NO_AUDIO_TRACK} (on every stream)`);
        if (k > 0)
            this.log(`no audio track on ${list[0].label}, using ${list[k].label}`);
        let started: AudioProcess = proc;
        const exited = (async (): Promise<string | undefined> => {
            for (;;) {
                const err = await started.exited;
                if (stopped)
                    return undefined;
                if (!err || !noAudio(err))
                    return err;
                const label = list[k].label;
                k++;
                let p: AudioProcess | undefined;
                try {
                    p = await next();
                }
                catch (e: any) {
                    return `start failed: ${String(e?.message || e)}`;
                }
                if (stopped) {
                    p?.stop();
                    return undefined;
                }
                if (!p)
                    return `${NO_AUDIO_TRACK} (on every stream)`;
                this.log(`no audio track on ${label}, trying ${list[k].label}`);
                started = p;
            }
        })();
        return {
            stop: () => { stopped = true; started.stop(); },
            exited,
        };
    };
}
