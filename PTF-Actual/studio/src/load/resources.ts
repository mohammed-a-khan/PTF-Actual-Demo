/**
 * A page's resources, loaded as a browser loads them: the scripts, style sheets, images and icons of the same site
 * that an HTML page refers to, six at a time, through the user's own cache. A resource still fresh (Cache-Control
 * max-age, Expires) is not asked for again; a stale one is asked with If-None-Match / If-Modified-Since and a 304
 * costs only the round trip. The cache is the user's: a returning user (the next iteration) loads less.
 */
export interface CachedResource { etag?: string; lastModified?: string; freshUntil: number }

export class BrowserCache {
    private readonly map = new Map<string, CachedResource>();
    get(url: string) { return this.map.get(url); }
    put(url: string, headers: Record<string, string>, now = Date.now()) {
        const cc = (headers['cache-control'] ?? '').toLowerCase();
        if (/no-store/.test(cc)) { this.map.delete(url); return; }
        const maxAge = /max-age=(\d+)/.exec(cc);
        const expires = headers.expires ? Date.parse(headers.expires) : NaN;
        const freshUntil = /no-cache/.test(cc) ? 0 : maxAge ? now + Number(maxAge[1]) * 1000 : Number.isFinite(expires) ? expires : 0;
        if (!freshUntil && !headers.etag && !headers['last-modified']) { this.map.delete(url); return; }
        this.map.set(url, { ...(headers.etag ? { etag: headers.etag } : {}), ...(headers['last-modified'] ? { lastModified: headers['last-modified'] } : {}), freshUntil });
    }
    get size() { return this.map.size; }
    clear() { this.map.clear(); }
}

/** Same-site resources an HTML page refers to (scripts, style sheets, images, icons; at most 100). */
export function pageResources(html: string, pageUrl: string): string[] {
    const base = new URL(/<base\s[^>]*href\s*=\s*["']([^"']+)["']/i.exec(html)?.[1] ?? pageUrl, pageUrl);
    const out = new Set<string>();
    const add = (ref: string | undefined) => {
        if (!ref || /^(data|blob|javascript|mailto|about):/i.test(ref.trim())) return;
        try { const u = new URL(ref.trim().replace(/&amp;/g, '&'), base); if (u.origin === new URL(pageUrl).origin) { u.hash = ''; out.add(u.href); } } catch { /* not a URL */ }
    };
    const attr = (tag: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
    const val = (m: RegExpExecArray | null) => (m ? m[1] ?? m[2] ?? m[3] : undefined);
    for (const m of html.matchAll(/<script\b[^>]*>/gi)) add(val(attr(m[0], 'src')));
    for (const m of html.matchAll(/<link\b[^>]*>/gi)) if (/\brel\s*=\s*["']?[^"'>]*(stylesheet|icon|preload|modulepreload)/i.test(m[0])) add(val(attr(m[0], 'href')));
    for (const m of html.matchAll(/<img\b[^>]*>/gi)) add(val(attr(m[0], 'src')));
    for (const m of html.matchAll(/<source\b[^>]*>/gi)) add(val(attr(m[0], 'src')));
    return [...out].slice(0, 100);
}

export interface ResourceLoad { requested: number; fromCache: number; notModified: number; bytes: number; failed: string[] }

/** Load the resources (six at a time) through the cache. `get` sends one GET with the given headers. */
export async function loadResources(urls: string[], cache: BrowserCache, get: (url: string, headers: Record<string, string>) => Promise<{ status: number; headers: Record<string, string>; size: number }>): Promise<ResourceLoad> {
    const out: ResourceLoad = { requested: 0, fromCache: 0, notModified: 0, bytes: 0, failed: [] };
    const queue = [...urls];
    const worker = async () => {
        for (let u = queue.shift(); u; u = queue.shift()) {
            const c = cache.get(u);
            if (c && c.freshUntil > Date.now()) { out.fromCache++; continue; }
            const h: Record<string, string> = {};
            if (c?.etag) h['If-None-Match'] = c.etag;
            if (c?.lastModified) h['If-Modified-Since'] = c.lastModified;
            out.requested++;
            try {
                const r = await get(u, h);
                if (r.status === 304) { out.notModified++; cache.put(u, { ...r.headers, ...(c?.etag && !r.headers.etag ? { etag: c.etag } : {}) }); continue; }
                if (r.status >= 400) { out.failed.push(`${r.status} ${new URL(u).pathname}`); continue; }
                out.bytes += r.size;
                cache.put(u, r.headers);
            } catch (e) { out.failed.push(`${new URL(u).pathname}: ${(e as Error).message.split('\n')[0]}`); }
        }
    };
    await Promise.all(Array.from({ length: Math.min(6, urls.length) }, worker));
    return out;
}
