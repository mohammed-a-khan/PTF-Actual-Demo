/**
 * The inner tab a screen of the Agents group shows, remembered per screen on this computer (a private window or
 * blocked storage just starts on the first tab). With a screen given, the tab is in the address too
 * (#/agents/tools, #/missions/finished…): a link opens that tab, and switching tabs changes the address in place
 * (no new history entry, so Back and "Back to …" still return to where the screen was opened from). A bare screen
 * address (#/agents) gets the tab shown written into it, so the address always names the tab; so does an address
 * naming a tab the screen does not have (#/agents/nope), unless the screen opens items there (`items`: #/missions/<id>).
 */
import React from 'react';
import { navigate, useRoute } from './route';

const read = (key: string): string | null => { try { return localStorage.getItem(`cs-studio-tab-${key}`); } catch { return null; } };
const write = (key: string, v: string) => { try { localStorage.setItem(`cs-studio-tab-${key}`, v); } catch { /* storage off */ } };

/**
 * [tab, setTab] for `key`; a remembered tab that is not among `allowed` (when given) falls back to `first`.
 * `page`: the screen's route (e.g. 'agents'): the tab is read from and written to its second segment.
 */
export function useRememberedTab(key: string, first: string, allowed?: string[], page?: string, o: { items?: boolean } = {}): [string, (t: string) => void] {
    const route = useRoute();
    const [tab, setTabState] = React.useState<string>(() => read(key) ?? first);
    const fromRoute = page && route[0] === page && route[1] && allowed?.includes(route[1]) ? route[1] : null;
    // A link to a tab: it becomes the remembered one.
    React.useEffect(() => { if (fromRoute && fromRoute !== tab) { setTabState(fromRoute); write(key, fromRoute); } }, [fromRoute, tab, key]);
    const setTab = React.useCallback((t: string) => {
        setTabState(t); write(key, t);
        if (page) navigate([page, t], true);
    }, [key, page]);
    const current = fromRoute ?? tab;
    const shown = allowed && !allowed.includes(current) ? first : current;
    // A bare screen address (#/knowledge): the tab shown is written into it at once (in place, no new history
    // entry), so the address always says which tab is shown and a copied link opens the same tab.
    const bare = !!page && route[0] === page && route.length === 1;
    // Not one of its tabs (#/knowledge/zzz): rewritten in place to the tab shown, so the address says what is shown.
    const unknown = !!page && !o.items && route[0] === page && route.length >= 2 && !!allowed && !allowed.includes(route[1]);
    React.useEffect(() => { if ((bare || unknown) && page) navigate([page, shown], true); }, [bare, unknown, page, shown]);
    return [shown, setTab];
}

/** Whether a route segment is one of a screen's tabs (not an item's id). */
export const isTab = (seg: string | undefined, allowed: string[]) => !!seg && allowed.includes(seg);
