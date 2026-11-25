/**
 * The inner tab a screen of the Agents group shows, remembered per screen on this computer (a private window or
 * blocked storage just starts on the first tab).
 */
import React from 'react';

const read = (key: string): string | null => { try { return localStorage.getItem(`cs-studio-tab-${key}`); } catch { return null; } };
const write = (key: string, v: string) => { try { localStorage.setItem(`cs-studio-tab-${key}`, v); } catch { /* storage off */ } };

/** [tab, setTab] for `key`; a remembered tab that is not among `allowed` (when given) falls back to `first`. */
export function useRememberedTab(key: string, first: string, allowed?: string[]): [string, (t: string) => void] {
    const [tab, setTabState] = React.useState<string>(() => read(key) ?? first);
    const setTab = React.useCallback((t: string) => { setTabState(t); write(key, t); }, [key]);
    const shown = allowed && !allowed.includes(tab) ? first : tab;
    return [shown, setTab];
}
