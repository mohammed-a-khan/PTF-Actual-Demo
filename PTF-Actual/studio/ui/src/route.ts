/**
 * Address-bar navigation for the Studio, so the browser's Back and Forward buttons (and mouse
 * back/forward buttons) move between screens and views: #/git/history/<sha>/<file>, #/runs/<id> …
 *
 * Each path segment is URI-encoded on its own, so a file path ("test/a/b.feature") is one segment.
 * The one-time start token also arrives in the fragment (#token=…); api.ts removes it before the
 * Studio reads the route, so the two never mix.
 */
import React from 'react';

const EVENT = 'cs-route';

/**
 * Back/Forward while the shown screen has work it would lose: the step is undone (exactly, so the
 * browser's history stays as it was) and the guard asks; `leave()` then makes the same step again.
 * Every history entry carries its place (`idx`), so a step of any size can be undone and redone.
 */
type PopGuard = (to: string[], from: string[], leave: () => void) => boolean;
let popGuard: PopGuard | null = null;
export function setPopGuard(g: PopGuard | null): void { popGuard = g; }
let shownHash = typeof window !== 'undefined' ? window.location.hash : '';
let shownIdx = 0;
/** Pop events the guard itself caused (undoing a refused step, or making it again after "leave"). */
let ownPops = 0;
/** The guard's question is open (closed by stay/leave: see questionClosed). */
let asking = false;
/** The guard's question was answered "Stay" (or dismissed): further steps may ask again. */
export function questionClosed(): void { asking = false; }
const idxOf = (st: unknown) => (st && typeof (st as { idx?: unknown }).idx === 'number' ? (st as { idx: number }).idx : null);
if (typeof window !== 'undefined') {
    // The first entry gets its place too.
    if (idxOf(history.state) === null) history.replaceState({ ...(history.state ?? {}), idx: 0 }, '');
    shownIdx = idxOf(history.state) ?? 0;
    // Registered before any screen listens, so a refused step never reaches them.
    window.addEventListener('popstate', (e) => {
        const toHash = window.location.hash;
        const toIdx = idxOf(history.state);
        if (ownPops > 0) {
            ownPops--;
            // Undoing a refused step: nothing changed for the screens.
            if (toHash === shownHash) { e.stopImmediatePropagation(); shownIdx = toIdx ?? shownIdx; return; }
            shownHash = toHash; shownIdx = toIdx ?? shownIdx;
            return;
        }
        const from = routeOf(shownHash), to = currentRoute();
        // An address typed in the address bar makes a new entry without a place: it is the next one.
        let typed = false;
        if (toIdx === null) { typed = true; history.replaceState({ ...(history.state ?? {}), idx: shownIdx + 1 }, ''); }
        const delta = typed ? 1 : (toIdx as number) - shownIdx;
        if (popGuard && from[0] && to.join('\0') !== from.join('\0') && delta) {
            // A second Back/Forward while the question is open: undone quietly (one question at a time).
            if (asking) { e.stopImmediatePropagation(); ownPops++; history.go(-delta); return; }
            const asked = popGuard(to, from, () => { asking = false; ownPops++; history.go(delta); });
            if (asked) {
                asking = true;
                e.stopImmediatePropagation();
                ownPops++;
                history.go(-delta);
                return;
            }
        }
        shownHash = toHash; shownIdx = idxOf(history.state) ?? shownIdx;
    });
    window.addEventListener(EVENT, () => { shownHash = window.location.hash; shownIdx = idxOf(history.state) ?? shownIdx; });
    window.addEventListener('hashchange', () => { shownHash = window.location.hash; });
}
function routeOf(hash: string): string[] {
    const h = hash.replace(/^#\/?/, '');
    if (!h || /^token=/.test(h)) return [];
    return h.split('/').filter((x) => x !== '').map((x) => { try { return decodeURIComponent(x); } catch { return x; } });
}

export function currentRoute(): string[] {
    const h = window.location.hash.replace(/^#\/?/, '');
    if (!h || /^token=/.test(h)) return [];
    return h.split('/').filter((s) => s !== '').map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
}

export function routeHash(parts: Array<string | number | undefined | null>): string {
    return '#/' + parts.filter((p) => p !== undefined && p !== null && p !== '').map((p) => encodeURIComponent(String(p))).join('/');
}

/**
 * Go to a view. `replace` changes the current history entry instead of adding one (for
 * corrections, such as filling in a default), so Back does not stop on it.
 */
export function navigate(parts: Array<string | number | undefined | null>, replace = false, o: { menu?: boolean } = {}): void {
    const h = routeHash(parts);
    if (window.location.hash === h) return;
    if (replace) history.replaceState({ ...(history.state ?? {}), idx: idxOf(history.state) ?? shownIdx }, '', window.location.pathname + window.location.search + h);
    else {
        // A jump from one screen to another (not the menu): the new entry remembers where it came from,
        // so the screen can offer "Back to …" (Back returns there as it was: filters, selection, scroll).
        const from = currentRoute();
        const next = parts.filter((x) => x !== undefined && x !== null && x !== '').map(String);
        const here = (history.state as { cameFrom?: CameFrom; depth?: number } | null) ?? null;
        let state: { cameFrom: CameFrom; depth: number } | null = null;
        if (!o.menu && from[0] && next[0] && from[0] !== next[0]) state = { cameFrom: { hash: window.location.hash, route: from }, depth: 0 };
        // Moving within the screen it was opened on keeps the way back (one more step to go back).
        else if (!o.menu && here?.cameFrom && from[0] === next[0]) state = { cameFrom: here.cameFrom, depth: (here.depth ?? 0) + 1 };
        history.pushState({ ...(state ?? {}), idx: (idxOf(history.state) ?? shownIdx) + 1 }, '', window.location.pathname + window.location.search + h);
    }
    window.dispatchEvent(new Event(EVENT));
}

/** Where this screen was opened from (a jump from another screen), or null. */
export interface CameFrom { hash: string; route: string[] }
export function cameFrom(): CameFrom | null {
    const c = (history.state as { cameFrom?: CameFrom } | null)?.cameFrom;
    return c && Array.isArray(c.route) && typeof c.hash === 'string' ? c : null;
}
/** Return to where this screen was opened from: Back (that entry keeps its state), else the address itself. */
export function goBack(c: CameFrom): void {
    const before = window.location.hash;
    const depth = (history.state as { depth?: number } | null)?.depth ?? 0;
    history.go(-(depth + 1));
    // No history to go back to (a reloaded tab may keep the state but lose the entries): go to the address.
    setTimeout(() => { if (window.location.hash === before) navigate(c.route); }, 300);
}

/** The current route, updated on Back/Forward and on navigate(). */
export function useRoute(): string[] {
    const [r, setR] = React.useState<string[]>(currentRoute);
    React.useEffect(() => {
        const h = () => setR((old) => { const n = currentRoute(); return old.join('\0') === n.join('\0') ? old : n; });
        window.addEventListener('popstate', h);
        window.addEventListener('hashchange', h);
        window.addEventListener(EVENT, h);
        return () => { window.removeEventListener('popstate', h); window.removeEventListener('hashchange', h); window.removeEventListener(EVENT, h); };
    }, []);
    return r;
}
