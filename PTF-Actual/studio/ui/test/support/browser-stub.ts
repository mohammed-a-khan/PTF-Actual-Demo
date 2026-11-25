/** Just enough of a browser for modules that read window/location when they load (no DOM rendering). */
const g = globalThis as Record<string, unknown>;
if (!g.window) {
    const noop = () => undefined;
    const store = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }; };
    g.window = { location: { hash: '', pathname: '/', search: '', href: 'http://localhost/' }, addEventListener: noop, removeEventListener: noop, dispatchEvent: () => true, matchMedia: () => ({ matches: false, addListener: noop, removeListener: noop, addEventListener: noop, removeEventListener: noop }) };
    g.history = { state: null, replaceState: noop, pushState: noop, go: noop };
    g.sessionStorage = store(); g.localStorage = store();
    g.document = { querySelector: () => null, addEventListener: noop, removeEventListener: noop, createElement: () => ({ style: {} }) };
}
export {};
