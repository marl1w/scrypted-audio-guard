// The background check: a sound that most of the other listening cameras heard at the same moment, about as loud above
// their own floors, is background (wind, rain, a distant bang) and is not published. The camera where the sound is clearly
// loudest is never suppressed: the others heard it fainter, so it happened near that camera. Pure: no timers, no devices.

export const BACKGROUND_CHECK = {
    /** a new sound waits this long before it is published: the other cameras' sounds of the same moment are in by then */
    delayMs: 1000,
    /** fewer listening cameras than this (this one included): no check and no delay */
    minCameras: 3,
    /** the share of the OTHER listening cameras that must have heard it alike... */
    share: 0.6,
    /** ...and at least this many of them */
    minOthers: 2,
    /** another camera heard it alike when its level above its own floor is at least this camera's minus this (dB) */
    similarDb: 6,
    /** at most one "sound ignored" line per camera in this long (the others are counted) */
    logEveryMs: 60_000,
};

/** What a camera heard last: its detector. */
export interface Hearing {
    /** the last spike window (monotonic ms) */
    lastSpikeAt: number | undefined;
    /** its level above that camera's floor (dB) */
    lastSpikeExcessDb: number | undefined;
}

/** the check runs (and delays a sound) only with this many other listening cameras */
export function backgroundCheckOn(others: number): boolean {
    return others + 1 >= BACKGROUND_CHECK.minCameras;
}

/**
 * A sound that started at `at` (its first loud window), `excessDb` above this camera's floor: the reason it is background,
 * else undefined. `others`: the other listening cameras.
 */
export function backgroundReason(at: number, excessDb: number, others: Hearing[]): string | undefined {
    const c = BACKGROUND_CHECK;
    if (!backgroundCheckOn(others.length))
        return;
    const need = Math.max(c.minOthers, Math.ceil(c.share * others.length));
    const alike = others.filter(o => o.lastSpikeAt !== undefined && o.lastSpikeAt >= at - c.delayMs
        && o.lastSpikeExcessDb !== undefined && o.lastSpikeExcessDb >= excessDb - c.similarDb).length;
    return alike >= need ? `${alike} of ${others.length} other cameras heard it as loud at the same moment` : undefined;
}
