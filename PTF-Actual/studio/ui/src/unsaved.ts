/**
 * Unsaved work across the Studio: each screen says what it has not saved; closing or reloading the browser tab
 * then asks first (the browser shows its own "Leave site?" message).
 */
import React from 'react';

const dirty = new Map<string, string>();
let installed = false;
function install() {
    if (installed || typeof window === 'undefined') return;
    installed = true;
    window.addEventListener('beforeunload', (e) => {
        if (!dirty.size) return;
        e.preventDefault();
        // Older browsers need a value set; the text itself is not shown any more.
        e.returnValue = `Not saved: ${[...dirty.values()].join(', ')}`;
    });
}
/** Unsaved work a screen does not keep when another screen is opened (asked about in the menu). */
const lost = new Set<string>();
/** While isDirty is true, leaving the page asks first; with lostOnLeave, opening another screen asks too. */
export function useUnsaved(key: string, isDirty: boolean, what: string, o: { lostOnLeave?: boolean; save?: () => Promise<boolean> } = {}) {
    // The screen's own Save, so "Leave without saving?" can offer to save first (kept current every render).
    const saveRef = React.useRef(o.save);
    saveRef.current = o.save;
    React.useEffect(() => {
        install();
        if (isDirty) { dirty.set(key, what); if (o.lostOnLeave) lost.add(key); if (saveRef.current) savers.set(key, () => saveRef.current!()); }
        else { dirty.delete(key); lost.delete(key); savers.delete(key); }
        return () => { dirty.delete(key); lost.delete(key); savers.delete(key); };
    }, [key, isDirty, what, o.lostOnLeave, !!o.save]); // eslint-disable-line react-hooks/exhaustive-deps
}
const savers = new Map<string, () => Promise<boolean>>();
/** Save everything another screen would throw away, when each of those screens can save; true when all saved. */
export const canSaveLost = () => lost.size > 0 && [...lost].every((k) => savers.has(k));
export async function saveLost(): Promise<boolean> {
    for (const k of [...lost]) { const s = savers.get(k); if (!s || !(await s())) return false; }
    return true;
}
/** What another screen would throw away (its edits are not kept). */
export const lostOnLeave = () => [...lost].map((k) => dirty.get(k)).filter((x): x is string => !!x);
/** What is not saved now (for tests and the status bar). */
export const unsavedNow = () => [...dirty.values()];

/** Unsaved work kept outside a screen (a draft that outlives it): set while it exists, null when saved or discarded. */
export function markUnsaved(key: string, what: string | null) { install(); if (what) dirty.set(key, what); else dirty.delete(key); }
