/**
 * State a screen keeps while the person is elsewhere: when they come back ("Back to …", the menu, a
 * reload of the tab) the screen is as they left it (its filter, the open drawer, the selected row).
 * Kept in memory and in this tab's session storage (not shared with other tabs, gone when the tab closes).
 */
import React from 'react';

const mem = new Map<string, unknown>();
const KEY = (k: string) => `cs-kept:${k}`;

export function useKept<T>(key: string, initial: T): [T, React.Dispatch<React.SetStateAction<T>>] {
    const [v, setV] = React.useState<T>(() => {
        if (mem.has(key)) return mem.get(key) as T;
        try { const s = sessionStorage.getItem(KEY(key)); if (s !== null) return JSON.parse(s) as T; } catch { /* no storage */ }
        return initial;
    });
    React.useEffect(() => {
        mem.set(key, v);
        try { if (v === undefined) sessionStorage.removeItem(KEY(key)); else sessionStorage.setItem(KEY(key), JSON.stringify(v)); } catch { /* no storage */ }
    }, [key, v]);
    return [v, setV];
}
