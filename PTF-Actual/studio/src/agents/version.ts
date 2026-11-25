/**
 * Whole-file saves of the Agents screens (an agent, the knowledge sources, the team notes, a tool server, the agent
 * settings): the screen sends back the version it read, and a save over a version changed since (another browser tab,
 * someone else, a pull) is refused instead of silently replacing that change. The screen then offers to reload or to
 * overwrite on purpose.
 */
import { createHash } from 'crypto';
import * as fs from 'fs';

/** The version of a file's content ('' when there is no file). */
export function fileVersion(file: string): string {
    try { return textVersion(fs.readFileSync(file)); } catch { return ''; }
}
/** The version of some content (a short hash; the same content, the same version). */
export function textVersion(text: string | Buffer): string {
    return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

export const CHANGED_ELSEWHERE = 'Changed in another tab or by someone else since you opened it.';
/** The thing was changed since the screen read it (the server answers 409). */
export class ChangedElsewhere extends Error {
    readonly code = 'changed';
    constructor(what?: string) { super(what ? `${CHANGED_ELSEWHERE.slice(0, -1)} (${what}).` : CHANGED_ELSEWHERE); }
}
/** Refused when the screen sent the version it read and the file has another one now (no version sent: not checked). */
export function checkVersion(current: string, sent: unknown, what?: string): void {
    if (typeof sent !== 'string') return;
    if (sent !== current) throw new ChangedElsewhere(what);
}
