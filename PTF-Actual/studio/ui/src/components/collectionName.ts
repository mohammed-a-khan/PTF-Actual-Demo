/** API collection names: the file a name gives, and why a name cannot be used. */
/** The file name the server gives a collection (src/api/model.ts slug), to show it before saving. */
export function collectionSlug(s: string): string {
    const out = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    if (out) return out;
    const t = s.trim();
    if (!t) return 'api';
    let h = 0x811c9dc5;
    for (const ch of t) { h ^= ch.codePointAt(0)!; h = Math.imul(h, 0x01000193) >>> 0; }
    return `api-${h.toString(36)}`;
}
/** Why a collection name cannot be used (empty, too long, taken in the project), or null. */
export function collectionNameProblem(name: string, project: string, taken: Array<{ file: string; name: string }>, own?: string | null): string | null {
    const n = name.trim();
    if (!n) return 'Give the collection a name.';
    if (n.length > 200) return 'At most 200 characters.';
    if (taken.some((c) => c.file !== own && c.name.trim().toLowerCase() === n.toLowerCase())) return `A collection "${n}" exists in ${project}.`;
    const file = `test/${project}/api/${collectionSlug(n)}.collection.json`;
    if (!own && taken.some((c) => c.file === file)) return `${file} exists (another collection has a name that gives the same file name). Choose another name.`;
    return null;
}

/**
 * A query string typed in the URL (…?q=a b&x=1) moved to the request's Params (where it is edited and encoded),
 * after the ones already there. null when the URL has none. {{names}} stay as they are.
 */
export function splitUrlQuery(url: string, query: Array<{ key: string; value: string; enabled?: boolean }>): { url: string; query: Array<{ key: string; value: string; enabled?: boolean }> } | null {
    const i = url.indexOf('?');
    if (i < 0) return null;
    const qs = url.slice(i + 1).replace(/#.*$/, '');
    const dec = (x: string) => { try { return decodeURIComponent(x.replace(/\+/g, ' ')); } catch { return x; } };
    const added = qs.split('&').filter(Boolean).map((p) => { const j = p.indexOf('='); return j < 0 ? { key: dec(p), value: '' } : { key: dec(p.slice(0, j)), value: dec(p.slice(j + 1)) }; });
    return { url: url.slice(0, i), query: [...query, ...added] };
}
