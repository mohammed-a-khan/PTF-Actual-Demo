/**
 * Signals between the test screens:
 *  - Run tests asks the Code screen to save its unsaved files before a run ("Save and run").
 *  - A run started or finished in one browser tab: the other tabs of the Studio read the runs again at once, so their
 *    Run button is disabled (and enabled again) before a click, not after the next poll.
 */

export const SAVE_FILES_EVENT = 'cs-save-files';
export interface SaveFilesRequest { paths: string[]; done: (ok: boolean) => void }

/** Ask the Code screen to save these files; true once all are saved (false when one was not: an error, a conflict left open). */
export function saveEditorFiles(paths: string[]): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        let answered = false;
        const done = (ok: boolean) => { if (!answered) { answered = true; resolve(ok); } };
        window.dispatchEvent(new CustomEvent<SaveFilesRequest>(SAVE_FILES_EVENT, { detail: { paths, done } }));
        // No Code screen listening (it always is in the Studio): nothing was saved.
        setTimeout(() => { if (!answered && !listening()) done(false); }, 0);
    });
}
let listeners = 0;
const listening = () => listeners > 0;
/** The Code screen says it handles SAVE_FILES_EVENT (for saveEditorFiles' check). */
export function handlesSaveFiles(): () => void { listeners++; return () => { listeners--; }; }

const CHANNEL = 'cs-studio-runs';
let channel: BroadcastChannel | null = null;
const chan = (): BroadcastChannel | null => {
    if (channel || typeof BroadcastChannel === 'undefined') return channel;
    try { channel = new BroadcastChannel(CHANNEL); } catch { channel = null; }
    return channel;
};
/** Tell the other tabs the runs changed (one started, ended or was removed). */
export function runsChanged(): void { try { chan()?.postMessage({ at: Date.now() }); } catch { /* closed */ } }
/** Called when another tab says the runs changed. */
export function onRunsChanged(fn: () => void): () => void {
    const c = chan();
    if (!c) return () => undefined;
    const h = () => fn();
    c.addEventListener('message', h);
    return () => c.removeEventListener('message', h);
}
