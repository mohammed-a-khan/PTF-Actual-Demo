/** A browser opened at a start link with a deep link after the key, for the token tests (loaded before api.ts). */
const g = globalThis as Record<string, unknown>;
const store = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }; };
export const calls = { replaced: [] as string[], reloads: 0 };
g.window = {
    location: { hash: '#token=launch1&/quality/causes', pathname: '/', search: '', href: 'http://localhost/', reload: () => { calls.reloads++; } },
    addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => true,
};
g.history = { state: null, replaceState: (_s: unknown, _t: string, url: string) => { calls.replaced.push(url); }, pushState: () => undefined };
g.localStorage = store();
g.sessionStorage = store();
export {};
