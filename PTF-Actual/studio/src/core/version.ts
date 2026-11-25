/**
 * Saves of a whole file (the notification channels, the pipeline variable group, the network settings) from a screen
 * that read it earlier: the screen sends back the version it read, and a save over something that changed since (in
 * another tab, or by someone else) is refused with 409 instead of silently dropping that change.
 */
import { createHash } from 'crypto';

export const STALE_SAVE_MESSAGE = 'Changed in another tab or by someone else: reload to see it.';

/** The refusal (409 Conflict). */
export class StaleSaveError extends Error {
    readonly statusCode = 409;
    readonly code = 'stale';
    /** The version saved now (sent with the refusal: "Keep editing" then saves over it without asking again). */
    constructor(message = STALE_SAVE_MESSAGE, readonly current?: string) { super(message); }
}

/** A short fingerprint of what a screen was shown (any JSON value, or a file's text). */
export function contentVersion(value: unknown): string {
    return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value ?? null)).digest('hex').slice(0, 16);
}

/**
 * Refuses a save made from an older version. `given` absent: a caller that does not send versions (a script, an
 * older screen) saves as before.
 */
export function checkVersion(given: unknown, current: string, force?: unknown): void {
    // force: the person chose Overwrite after a refusal.
    if (force === true) return;
    if (given === undefined || given === null || given === '') return;
    if (given !== current) throw new StaleSaveError(STALE_SAVE_MESSAGE, current);
}
