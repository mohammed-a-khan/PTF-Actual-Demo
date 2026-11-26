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
/** The history place the guard itself is moving to (undoing a refused step, or making it again after
 *  "leave"). A place, not a count: a Back pressed before that move lands is still seen as the person's. */
let expect: number | null = null;
/** The guard's question is open (closed by stay/leave: see questionClosed). */
let asking = false;
/** The guard's question was answered or dismissed: further steps may ask again. */
export function questionClosed(): void { asking = false; }
/**
 * The addresses of this tab's history, by place (idx): what the Studio's own Back / Forward buttons offer and
 * name. Kept in this tab's session storage, so a reload keeps them. A new step drops what lay ahead, as the
 * browser does.
 */
const NAV_KEY = 'cs-nav-entries';
let entries: string[] = [];
try { const v = JSON.parse(sessionStorage.getItem(NAV_KEY) ?? '[]'); if (Array.isArray(v)) entries = v.map(String); } catch { /* no storage */ }
const NAV_EVENT = 'cs-nav';
function remember(idx: number, hash: string, dropAhead: boolean): void {
    if (dropAhead) entries = entries.slice(0, idx);
    entries[idx] = hash;
    try { sessionStorage.setItem(NAV_KEY, JSON.stringify(entries.slice(-300))); } catch { /* no storage */ }
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(NAV_EVENT));
}
const idxOf = (st: unknown) => (st && typeof (st as { idx?: unknown }).idx === 'number' ? (st as { idx: number }).idx : null);
/** Move the browser to history place `idx` (from wherever it is now). */
function goTo(idx: number): void {
    const cur = idxOf(history.state) ?? shownIdx;
    if (cur === idx) { expect = null; return; }
    expect = idx;
    history.go(idx - cur);
}
if (typeof window !== 'undefined') {
    // The first entry gets its place too.
    if (idxOf(history.state) === null) history.replaceState({ ...(history.state ?? {}), idx: 0 }, '');
    shownIdx = idxOf(history.state) ?? 0;
    remember(shownIdx, shownHash, false);
    // Registered before any screen listens, so a refused step never reaches them.
    window.addEventListener('popstate', (e) => {
        const toHash = window.location.hash;
        let toIdx = idxOf(history.state);
        if (expect !== null && toIdx === expect) {
            expect = null;
            // Back where the screens are: nothing changed for them.
            if (toHash === shownHash) { e.stopImmediatePropagation(); shownIdx = toIdx; return; }
            shownHash = toHash; shownIdx = toIdx;
            remember(shownIdx, shownHash, false);
            return;
        }
        const from = routeOf(shownHash), to = currentRoute();
        // An address typed in the address bar makes a new entry without a place: it is the next one.
        if (toIdx === null) { toIdx = shownIdx + 1; history.replaceState({ ...(history.state ?? {}), idx: toIdx }, ''); remember(toIdx, toHash, true); }
        const target = toIdx;
        const delta = target - shownIdx;
        if (popGuard && from[0] && to.join('\0') !== from.join('\0') && delta) {
            // A second Back/Forward while the question is open: back to the shown screen (one question at a time).
            if (asking) { e.stopImmediatePropagation(); goTo(shownIdx); return; }
            const asked = popGuard(to, from, () => { asking = false; goTo(target); });
            if (asked) {
                asking = true;
                e.stopImmediatePropagation();
                goTo(shownIdx);
                return;
            }
        }
        expect = null;
        shownHash = toHash; shownIdx = target;
        remember(shownIdx, shownHash, false);
    });
    window.addEventListener(EVENT, () => { shownHash = window.location.hash; shownIdx = idxOf(history.state) ?? shownIdx; remember(shownIdx, shownHash, false); });
    // The browser also says "hashchange" for a step the guard refused (before its undoing lands): held back,
    // or the screens would switch under the open question and lose the work (popstate already says the rest).
    window.addEventListener('hashchange', (e) => {
        if ((expect !== null || asking) && window.location.hash !== shownHash) { e.stopImmediatePropagation(); return; }
        shownHash = window.location.hash;
    });
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
        const idx = (idxOf(history.state) ?? shownIdx) + 1;
        history.pushState({ ...(state ?? {}), idx }, '', window.location.pathname + window.location.search + h);
        remember(idx, h, true);
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

/**
 * The Studio's own Back and Forward: where each goes in this tab's history (an address, or "" for a place
 * whose address is not known, e.g. before this tab kept them), or null when there is nowhere to go.
 * They step the browser's history, so unsaved work is asked about exactly as with the browser's buttons.
 */
export function useBackForward(): { back: string | null; forward: string | null; go: (delta: -1 | 1) => void } {
    const read = () => {
        const i = idxOf(history.state) ?? shownIdx;
        return { back: i > 0 ? entries[i - 1] ?? '' : null, forward: i + 1 < entries.length ? entries[i + 1] ?? '' : null };
    };
    const [st, setSt] = React.useState(read);
    React.useEffect(() => {
        const h = () => setSt((o) => { const n = read(); return o.back === n.back && o.forward === n.forward ? o : n; });
        for (const ev of ['popstate', 'hashchange', EVENT, NAV_EVENT]) window.addEventListener(ev, h);
        return () => { for (const ev of ['popstate', 'hashchange', EVENT, NAV_EVENT]) window.removeEventListener(ev, h); };
    }, []);
    return { ...st, go: (delta) => history.go(delta) };
}
/** The route parts of an address ("#/runs/123" → ["runs", "123"]). */
export function routeOfHash(hash: string): string[] { return routeOf(hash); }
