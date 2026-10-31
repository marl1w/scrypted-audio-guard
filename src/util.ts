// Small pure helpers: clock, backoff, secrets masking, timeouts.

const T0 = Date.now() - performance.now();

/** Monotonic clock in unix-ms scale: immune to wall-clock steps (NTP, manual changes). */
export function monoNow(): number {
    return Math.round(T0 + performance.now());
}

/** Exponential backoff: base doubled per attempt, capped. */
export function backoffMs(attempt: number, base = 1000, cap = 60000): number {
    return Math.min(cap, base * 2 ** Math.max(0, attempt));
}

/** Remove credentials and query strings (tokens) from text that may contain stream URLs. */
export function maskSecrets(text: string): string {
    return text
        // everything up to the LAST '@' of the URL is user info: a raw '/' or '@' inside a password must not leak
        .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s'"]*@/gi, '$1***@')
        .replace(/\?[^\s'"]*/g, '?***');
}

/** maskSecrets, and every URL reduced to scheme://host:port (no path, credentials or query): safe for any log line or status text. */
export function maskUrls(text: string): string {
    return maskSecrets(text).replace(/([a-z][a-z0-9+.-]*:\/\/)(?:[^/\s]*@)?([^/\s?]*)\/[^\s'"]*/gi, '$1$2');
}

/** Last `n` lines of ffmpeg stderr, every URL masked. */
export function stderrTail(text: string, n = 10): string {
    return maskUrls(text).split(/\r?\n/).map(l => l.trimEnd()).filter(Boolean).slice(-n).join(' | ');
}

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
        p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
    });
}

/** HH:MM:SS local time of a wall-clock timestamp. */
export function clockTime(ms: number): string {
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
