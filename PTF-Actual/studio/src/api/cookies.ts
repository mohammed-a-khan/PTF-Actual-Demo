/**
 * A cookie jar (RFC 6265, as browsers and the framework's API client keep cookies): Set-Cookie lines of a
 * response (redirects too) are kept and sent back to matching requests.
 *  - Domain: host-only unless the cookie names a domain (then that domain and its subdomains; a domain that is
 *    not the request host's own or a parent is refused, as are public suffix-like single labels).
 *  - Path: the cookie's path, or the request path's directory; a request matches the path and its sub-paths.
 *  - Secure cookies only over https; Max-Age before Expires; a past expiry deletes the cookie.
 *  - Sent most specific path first, then oldest.
 */
export interface Cookie {
    name: string;
    value: string;
    domain: string;
    hostOnly: boolean;
    path: string;
    secure: boolean;
    httpOnly: boolean;
    sameSite?: string;
    /** ms since epoch; undefined: a session cookie. */
    expires?: number;
    created: number;
}

const defaultPath = (p: string) => { if (!p.startsWith('/')) return '/'; const i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); };
const domainMatch = (host: string, domain: string) => host === domain || (host.endsWith(`.${domain}`) && !/^\d+\.\d+\.\d+\.\d+$/.test(host));
const pathMatch = (reqPath: string, cookiePath: string) => reqPath === cookiePath || (reqPath.startsWith(cookiePath) && (cookiePath.endsWith('/') || reqPath[cookiePath.length] === '/'));

export class CookieJar {
    private cookies: Cookie[] = [];
    private seq = 0;

    /** Keep the cookies a response to `url` sets. */
    setFrom(url: string, setCookie: string[] | undefined, now = Date.now()) {
        if (!setCookie?.length) return;
        let u: URL;
        try { u = new URL(url); } catch { return; }
        for (const line of setCookie) this.setOne(u, line, now);
    }

    private setOne(u: URL, line: string, now: number) {
        const [pair, ...attrs] = line.split(';');
        const eq = pair.indexOf('=');
        if (eq < 1) return;
        const name = pair.slice(0, eq).trim(), value = pair.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
        const host = u.hostname.toLowerCase();
        const c: Cookie = { name, value, domain: host, hostOnly: true, path: defaultPath(u.pathname), secure: false, httpOnly: false, created: now + this.seq++ / 1000 };
        let maxAge: number | undefined, expires: number | undefined;
        for (const a of attrs) {
            const i = a.indexOf('=');
            const k = (i < 0 ? a : a.slice(0, i)).trim().toLowerCase(), v = i < 0 ? '' : a.slice(i + 1).trim();
            if (k === 'domain' && v) {
                const d = v.replace(/^\./, '').toLowerCase();
                // Another site's domain, or a bare top-level label: refused.
                if (!domainMatch(host, d) || (!d.includes('.') && d !== host)) return;
                c.domain = d;
                c.hostOnly = false;
            } else if (k === 'path' && v.startsWith('/')) c.path = v;
            else if (k === 'secure') c.secure = true;
            else if (k === 'httponly') c.httpOnly = true;
            else if (k === 'samesite') c.sameSite = v;
            else if (k === 'max-age' && /^-?\d+$/.test(v)) maxAge = Number(v);
            else if (k === 'expires') { const t = Date.parse(v); if (!Number.isNaN(t)) expires = t; }
        }
        if (maxAge !== undefined) c.expires = maxAge <= 0 ? 0 : now + maxAge * 1000;
        else if (expires !== undefined) c.expires = expires;
        // Replace the same name/domain/path (keeping its creation time).
        const i = this.cookies.findIndex((x) => x.name === c.name && x.domain === c.domain && x.path === c.path);
        if (i >= 0) { c.created = this.cookies[i].created; this.cookies.splice(i, 1); }
        if (c.expires !== undefined && c.expires <= now) return; // expired: deleted
        this.cookies.push(c);
    }

    /** The Cookie header for a request to `url` (undefined when no cookie matches). */
    header(url: string, now = Date.now()): string | undefined {
        let u: URL;
        try { u = new URL(url); } catch { return undefined; }
        const host = u.hostname.toLowerCase(), path = u.pathname || '/';
        this.cookies = this.cookies.filter((c) => c.expires === undefined || c.expires > now);
        const match = this.cookies.filter((c) => (c.hostOnly ? host === c.domain : domainMatch(host, c.domain)) && pathMatch(path, c.path) && (!c.secure || u.protocol === 'https:'));
        if (!match.length) return undefined;
        match.sort((a, b) => b.path.length - a.path.length || a.created - b.created);
        return match.map((c) => `${c.name}=${c.value}`).join('; ');
    }

    list(now = Date.now()): Cookie[] { return this.cookies.filter((c) => c.expires === undefined || c.expires > now).map((c) => ({ ...c })); }
    remove(name: string, domain?: string) { this.cookies = this.cookies.filter((c) => !(c.name === name && (!domain || c.domain === domain))); }
    clear() { this.cookies = []; }
    get size() { return this.list().length; }
}

/** The request's own Cookie header and the jar's, merged (the request's values win for the same name). */
export function mergeCookieHeader(own: string | undefined, fromJar: string | undefined): string | undefined {
    if (!fromJar) return own;
    if (!own) return fromJar;
    const names = new Set(own.split(';').map((p) => p.split('=')[0].trim()));
    const extra = fromJar.split(';').map((p) => p.trim()).filter((p) => p && !names.has(p.split('=')[0].trim()));
    return extra.length ? `${own}; ${extra.join('; ')}` : own;
}
