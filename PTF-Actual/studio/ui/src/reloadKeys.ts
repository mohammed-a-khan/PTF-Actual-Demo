/**
 * The browser's reload keys never reload the Studio by accident (open tabs, unsaved edits, a debug
 * session and every screen's state would go): F5, Ctrl+R and Ctrl+F5 do nothing here, except what a
 * screen gives them (F5 = Continue while a debug session is paused, in the Debug panel). A short hint
 * says how to reload on purpose. Ctrl+Shift+R (the browser's hard reload) and the reload button still work.
 */

export type ReloadKey = 'f5' | 'ctrl-r' | 'ctrl-f5';

/** Is this key press one of the browser's reload keys the Studio holds back? */
export function reloadKeyOf(e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>): ReloadKey | null {
    const mod = e.ctrlKey || e.metaKey;
    if (e.altKey) return null;
    if (e.key === 'F5' || e.code === 'F5') return e.shiftKey ? (mod ? null : 'f5') : mod ? 'ctrl-f5' : 'f5';
    const r = e.key === 'r' || e.key === 'R' || e.code === 'KeyR';
    if (r && mod && !e.shiftKey) return 'ctrl-r';
    return null;
}

export const RELOAD_HINT = 'F5 does not reload the Studio; use the browser\'s reload button if you need to.';

/**
 * Hold the reload keys back on the whole page (capture phase: before any screen's own handler, which
 * still gets the key). `hint` is called when no screen used the key (none called preventDefault itself).
 */
export function installReloadGuard(hint: (key: ReloadKey) => void, target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window): () => void {
    const onKey = (e: KeyboardEvent) => {
        const k = reloadKeyOf(e);
        if (!k) return;
        // Did a screen use it (e.g. the Debug panel's F5 = Continue)? Its handler calls preventDefault.
        let used = e.defaultPrevented;
        const real = e.preventDefault.bind(e);
        real();
        try { Object.defineProperty(e, 'preventDefault', { configurable: true, value: () => { used = true; real(); } }); } catch { /* read-only: the hint shows every time */ }
        if (e.repeat) return;
        setTimeout(() => { if (!used) hint(k); }, 0);
    };
    target.addEventListener('keydown', onKey as EventListener, true);
    return () => target.removeEventListener('keydown', onKey as EventListener, true);
}
