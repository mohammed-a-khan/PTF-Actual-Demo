/**
 * How the Studio itself reaches the network (Azure DevOps): proxy and trusted certificates.
 * Personal settings, OFF by default; nothing is hard-coded. Git and the framework's test runs have
 * their own settings (Git: http.proxy etc.; framework: ADO_PROXY_*), shown and managed separately.
 *
 * Certificates: a company proxy that inspects HTTPS (Zscaler and similar) re-signs every site with
 * the company's root certificate. Node.js only trusts its built-in list, so such connections fail
 * with "unable to get local issuer certificate" until that root is trusted — either from the
 * computer's certificate store (where IT installs it; Node.js 22.15+ can read it) or a PEM file.
 * Turning certificate checks off is never offered: it would let anyone on the way read the token.
 */
import * as fs from 'fs';
import * as tls from 'tls';
import * as https from 'https';
import * as http from 'http';
import { X509Certificate } from 'crypto';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { ProxyTunnelAgent, ProxyTunnelHttpAgent, type ProxyServer } from './proxyTunnel';
import { pacEvaluator, type SystemProxy } from './systemProxy';
import { UserError } from './errors';

/** off · environment (HTTPS_PROXY) · manual (the URL below) · system (Windows / macOS settings, their PAC file too) · pac (a PAC file's address). */
export type ProxyMode = 'off' | 'environment' | 'manual' | 'system' | 'pac';

export interface NetworkSettings {
    /** off (default): connect directly · environment: HTTPS_PROXY / NO_PROXY · manual: the URL below. */
    proxyMode: ProxyMode;
    /** http://host:port (manual mode). No credentials here: the password is a Studio secret. */
    proxyUrl: string;
    proxyUser: string;
    /** Hosts reached directly: exact names or suffixes (".corp.local"), as NO_PROXY. */
    bypass: string[];
    /** Trust the certificates installed on this computer (Windows certificate store, macOS keychain). */
    useSystemCerts: boolean;
    /** A PEM file with the company root certificate(s), trusted in addition. */
    caFile: string;
    /** Also give these certificates to test runs (NODE_EXTRA_CA_CERTS / --use-system-ca). */
    certsForTestRuns: boolean;
    /** PAC mode: the address of the proxy auto-configuration file. */
    pacUrl?: string;
    /** How the Studio signs in to the proxy: Basic (default), or NTLM / Digest (Windows proxies), with the Windows domain. */
    proxyAuth?: 'basic' | 'ntlm' | 'digest';
    proxyDomain?: string;
    /**
     * Client certificates (mutual TLS) per host: a .pfx/.p12 file, or a PEM certificate and key; the passphrase is a
     * Studio secret named here. host: an exact name or a suffix (".bank.local").
     */
    clientCerts?: Array<{ host: string; pfxFile?: string; certFile?: string; keyFile?: string; passphraseSecret?: string }>;
}

export const DEFAULT_NETWORK: NetworkSettings = { proxyMode: 'off', proxyUrl: '', proxyUser: '', bypass: ['localhost', '127.0.0.1'], useSystemCerts: false, caFile: '', certsForTestRuns: true };

/** Name of the Studio secret holding the proxy password. */
export const PROXY_PASSWORD_SECRET = 'NETWORK_PROXY_PASSWORD';

export const systemCertsSupported = (): boolean => typeof (tls as { getCACertificates?: unknown }).getCACertificates === 'function';

const HOST_RE = /^(?=.{1,253}$)[a-z0-9*.](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i;

/**
 * Checks the settings, but only the fields the chosen mode uses: a value the person can no longer see
 * (a proxy address while the proxy is off, say) never blocks a save. Such a hidden value is kept when it
 * is fine (for when that mode is chosen again) and dropped when it is not (it would be refused when used).
 */
export function validateNetwork(n: NetworkSettings): NetworkSettings {
    if (!['off', 'environment', 'manual', 'system', 'pac'].includes(n.proxyMode)) throw new UserError('Unknown proxy mode.');
    const mode = n.proxyMode;
    let pacUrl = n.pacUrl === undefined ? undefined : n.pacUrl.trim();
    if (mode === 'pac') {
        const problem = pacUrlProblem(pacUrl ?? '');
        if (problem) throw new UserError(problem);
    } else if (pacUrl && pacUrlProblem(pacUrl)) pacUrl = '';
    // Sign-in, login and bypass list are used by every mode but "off".
    const signIn = mode !== 'off';
    let proxyAuth = n.proxyAuth;
    if (proxyAuth && !['basic', 'ntlm', 'digest'].includes(proxyAuth)) { if (signIn) throw new UserError('Unknown proxy sign-in.'); proxyAuth = 'basic'; }
    let proxyDomain = n.proxyDomain;
    if ((proxyDomain ?? '').length > 100 || /[\s\\/@:]/.test(proxyDomain ?? '')) { if (signIn) throw new UserError('The Windows domain is a name such as CORP.'); proxyDomain = ''; }
    let proxyUser = n.proxyUser;
    if (proxyUser.length > 200 || /[\s:]/.test(proxyUser)) { if (signIn) throw new UserError('Proxy user name cannot contain spaces or ":".'); proxyUser = ''; }
    let bypass = n.bypass.map((b) => b.trim().toLowerCase()).filter(Boolean);
    if (signIn) { for (const b of bypass) if (!HOST_RE.test(b)) throw new UserError(`"${b}" is not a host name for the bypass list.`); }
    else bypass = bypass.filter((b) => HOST_RE.test(b));
    let url = n.proxyUrl.trim();
    if (mode === 'manual') {
        const problem = proxyUrlProblem(url);
        if (problem) throw new UserError(problem);
    } else if (url && proxyUrlProblem(url)) url = ''; // never kept with a password inside, nor when it could not be used
    if (n.useSystemCerts && !systemCertsSupported()) throw new UserError(`This Node.js (${process.version}) cannot read the computer's certificate store; it needs Node.js 22.15 or later. Use a certificate file instead.`);
    if (n.caFile) readCaFile(n.caFile);
    return {
        ...n, proxyUrl: url, proxyUser, bypass, caFile: n.caFile.trim(),
        ...(proxyAuth !== undefined ? { proxyAuth } : {}), ...(proxyDomain !== undefined ? { proxyDomain } : {}), ...(pacUrl !== undefined ? { pacUrl } : {}),
    };
}

/** Why a manual proxy address would be refused, or null. */
export function proxyUrlProblem(raw: string): string | null {
    const url = raw.trim();
    if (!url) return 'Give the proxy address, e.g. http://proxy.company.com:8080';
    if (url.length > 2048) return 'The proxy address is too long (at most 2,048 characters).';
    let u: URL;
    try { u = new URL(url); } catch { return 'Proxy address must look like http://proxy.company.com:8080'; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'Proxy address must start with http:// or https://';
    if (u.username || u.password) return 'Put the proxy user name and password in their own fields, not in the address.';
    if (u.pathname !== '/' || u.search || u.hash) return 'Proxy address is just the server and port, e.g. http://proxy.company.com:8080';
    return null;
}

/** Why a PAC file address would be refused, or null. */
export function pacUrlProblem(raw: string): string | null {
    const pac = raw.trim();
    if (!pac) return 'Give the PAC file address (http://wpad.company.local/proxy.pac) or its path.';
    if (pac.length > 2048) return 'The PAC file address is too long (at most 2,048 characters).';
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(pac) && !/^(https?|file):\/\//i.test(pac)) return 'A PAC file address starts with http://, https:// or file://, or is a file path.';
    return null;
}

/** The PEM certificates in a file, with their names (to show what is trusted). Throws a UserError. */
export function readCaFile(file: string): Array<{ pem: string; subject: string; issuer: string; validTo: string }> {
    let text: string;
    try {
        const st = fs.statSync(file);
        if (!st.isFile()) throw new Error('not a file');
        if (st.size > 2 * 1024 * 1024) throw new UserError('The certificate file is larger than 2 MB.');
        text = fs.readFileSync(file, 'utf8');
    } catch (e) {
        if (e instanceof UserError) throw e;
        throw new UserError(`Cannot read the certificate file ${file}.`);
    }
    const pems = text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
    if (!pems.length) throw new UserError('The certificate file has no PEM certificates (-----BEGIN CERTIFICATE-----). Export the root certificate as "Base-64 encoded X.509 (.CER)".');
    return pems.map((pem) => {
        try { const c = new X509Certificate(pem); return { pem, subject: c.subject.replace(/\n/g, ', '), issuer: c.issuer.replace(/\n/g, ', '), validTo: c.validTo }; }
        catch { throw new UserError('A certificate in the file could not be read.'); }
    });
}

/** Does `host` match the bypass list (NO_PROXY rules: exact, suffix, ".suffix", "*")? */
export function bypassed(host: string, list: string[]): boolean {
    const h = host.toLowerCase().replace(/\.$/, '');
    return list.some((raw) => {
        const b = raw.toLowerCase().replace(/:\d+$/, '');
        if (b === '*') return true;
        const suffix = b.startsWith('*.') ? b.slice(1) : b.startsWith('.') ? b : '.' + b;
        return h === b.replace(/^\*?\./, '') || h.endsWith(suffix);
    });
}

export interface Connection {
    /**
     * Agent for a request to `url` (proxy or not), and the extra trusted certificates. Through a proxy: one kept-alive
     * agent per proxy (connections reused). exclusive: a new agent with one kept-alive connection, for a handshake that
     * needs the same connection (NTLM); the caller destroys it.
     */
    agentFor(url: string, o?: { exclusive?: boolean }): http.Agent | undefined;
    ca: string[] | undefined;
    /** The PAC file could not be used (the connection is then direct). */
    pacError?: string;
    /** For messages: the proxy without credentials. */
    proxyLabel(url: string): string | null;
}

/** What some settings need besides themselves: the system proxy read from the computer, the PAC file's text, secrets. */
export interface ConnectionExtras {
    system?: SystemProxy;
    pacScript?: string;
    secret?: (name: string) => string | undefined;
    readFile?: (file: string) => Buffer;
}

/** Turn the settings into what a request needs. `password` comes from the Studio secret. */
export function connection(n: NetworkSettings, env: NodeJS.ProcessEnv, password?: string, extras: ConnectionExtras = {}): Connection {
    let ca: string[] | undefined;
    if (n.useSystemCerts || n.caFile) {
        const set = new Set<string>((tls as { getCACertificates?: (k: string) => string[] }).getCACertificates?.('default') ?? tls.rootCertificates);
        if (n.useSystemCerts && systemCertsSupported()) for (const c of (tls as unknown as { getCACertificates: (k: string) => string[] }).getCACertificates('system')) set.add(c);
        if (n.caFile) for (const c of readCaFile(n.caFile)) set.add(c.pem);
        ca = [...set];
    }
    // The PAC file (pac mode, or the system's): compiled once; a broken file means a direct connection, with the reason kept.
    let pac: ((url: string) => string[]) | null = null;
    let pacError: string | undefined;
    const pacText = extras.pacScript;
    if ((n.proxyMode === 'pac' || (n.proxyMode === 'system' && extras.system?.pacUrl)) && pacText) {
        try { pac = pacEvaluator(pacText); } catch (e) { pacError = (e as Error).message; }
    }
    const withUser = (href: string) => {
        if (!n.proxyUser || /^socks/i.test(href)) return href;
        const u = new URL(href);
        if (!u.username) { u.username = encodeURIComponent(n.proxyUser); u.password = encodeURIComponent(password ?? ''); }
        return u.href;
    };
    const labelOf = (href: string) => { try { const u = new URL(href); u.username = ''; u.password = ''; return u.href; } catch { return href; } };
    const proxyFor = (url: string): { href: string; label: string } | null => {
        const host = new URL(url).hostname;
        if (n.proxyMode === 'manual') {
            if (!n.proxyUrl || bypassed(host, n.bypass)) return null;
            return { href: withUser(n.proxyUrl), label: n.proxyUrl };
        }
        if (n.proxyMode === 'environment') {
            const p = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
            const noProxy = (env.NO_PROXY || env.no_proxy || '').split(',').map((x) => x.trim()).filter(Boolean);
            if (!p || bypassed(host, [...noProxy, ...n.bypass])) return null;
            return { href: p, label: labelOf(p) };
        }
        if (n.proxyMode === 'pac' || (n.proxyMode === 'system' && pac)) {
            if (!pac || bypassed(host, n.bypass)) return null;
            const first = pac(url)[0] ?? 'DIRECT';
            return first === 'DIRECT' ? null : { href: withUser(first), label: `${first} (PAC)` };
        }
        if (n.proxyMode === 'system') {
            const sys = extras.system;
            const p = url.startsWith('https:') ? sys?.httpsProxy ?? sys?.proxy : sys?.proxy;
            const local = (sys?.bypass ?? []).includes('<local>') && !host.includes('.');
            if (!p || local || bypassed(host, [...(sys?.bypass ?? []).filter((b) => b !== '<local>'), ...n.bypass])) return null;
            return { href: withUser(p), label: `${p} (${sys?.source ?? 'system'})` };
        }
        return null;
    };
    // Client certificate for a host (mutual TLS): the TLS options, read once.
    const certCache = new Map<string, tls.SecureContextOptions>();
    const certFor = (url: string): tls.SecureContextOptions | undefined => {
        if (!url.startsWith('https:') || !n.clientCerts?.length) return undefined;
        const host = new URL(url).hostname.toLowerCase();
        const c = n.clientCerts.find((x) => { const h = x.host.trim().toLowerCase(); return h.startsWith('.') ? host.endsWith(h) || host === h.slice(1) : host === h; });
        if (!c) return undefined;
        let o = certCache.get(c.host);
        if (!o) {
            const read = extras.readFile ?? ((f: string) => fs.readFileSync(f));
            const passphrase = c.passphraseSecret ? extras.secret?.(c.passphraseSecret) : undefined;
            o = c.pfxFile ? { pfx: read(c.pfxFile), ...(passphrase ? { passphrase } : {}) } : { cert: read(c.certFile ?? ''), key: read(c.keyFile ?? ''), ...(passphrase ? { passphrase } : {}) };
            certCache.set(c.host, o);
        }
        return o;
    };
    // One kept-alive agent per proxy and client certificate (connections reused).
    const shared = new Map<string, http.Agent>();
    const tunnelServer = (href: string): ProxyServer => {
        const u = new URL(href);
        return { host: u.hostname, port: Number(u.port) || 8080, auth: { type: n.proxyAuth as 'ntlm' | 'digest', username: n.proxyUser, password: password ?? '', domain: n.proxyDomain } };
    };
    const make = (url: string, p: { href: string } | null, o: { keepAlive: boolean; maxSockets?: number }): http.Agent | undefined => {
        const cert = certFor(url);
        const tlsOpts = { ...(ca ? { ca } : {}), ...(cert ?? {}) };
        if (!p) return cert || o.maxSockets ? (url.startsWith('https:') ? new https.Agent({ ...o, ...tlsOpts }) : new http.Agent(o)) : undefined;
        if (/^socks/i.test(p.href)) return new SocksProxyAgent(p.href, { ...o, ...tlsOpts } as never);
        // NTLM / Digest proxy sign-in: a CONNECT tunnel answering the proxy's challenge (core/proxyTunnel).
        if ((n.proxyAuth === 'ntlm' || n.proxyAuth === 'digest') && n.proxyUser) {
            const server = tunnelServer(labelOf(p.href));
            return url.startsWith('https:') ? new ProxyTunnelAgent(server, { ...o, ...tlsOpts }) : new ProxyTunnelHttpAgent(server, o);
        }
        return new HttpsProxyAgent(p.href, { ...o, ...tlsOpts });
    };
    return {
        ca,
        ...(pacError ? { pacError } : {}),
        agentFor(url, o = {}) {
            const p = proxyFor(url);
            if (o.exclusive) return make(url, p, { keepAlive: true, maxSockets: 1 }) ?? (url.startsWith('https:') ? new https.Agent({ keepAlive: true, maxSockets: 1, ...(ca ? { ca } : {}) }) : new http.Agent({ keepAlive: true, maxSockets: 1 }));
            const cert = certFor(url);
            if (!p && !cert) return undefined;
            const key = `${p?.href ?? 'direct'}|${cert ? new URL(url).hostname : ''}|${url.startsWith('https:') ? 's' : ''}`;
            let a = shared.get(key);
            if (!a) { a = make(url, p, { keepAlive: true }); if (a) shared.set(key, a); }
            return a;
        },
        proxyLabel(url) { return proxyFor(url)?.label ?? null; },
    };
}

/** Environment for a test run so the framework's own HTTPS (ADO publishing…) trusts the same roots. */
export function runEnvFor(n: NetworkSettings, current: NodeJS.ProcessEnv): Record<string, string> {
    if (!n.certsForTestRuns) return {};
    const out: Record<string, string> = {};
    if (n.caFile) out.NODE_EXTRA_CA_CERTS = n.caFile;
    if (n.useSystemCerts && systemCertsSupported() && !/(^|\s)--use-system-ca(\s|$)/.test(current.NODE_OPTIONS ?? '')) {
        out.NODE_OPTIONS = `${current.NODE_OPTIONS ? current.NODE_OPTIONS + ' ' : ''}--use-system-ca`;
    }
    return out;
}

export type CheckStage = 'dns' | 'connect' | 'proxy' | 'certificate' | 'http' | 'ok';
export interface ConnectionCheck {
    ok: boolean;
    stage: CheckStage;
    message: string;
    url: string;
    proxy: string | null;
    status?: number;
    /** When the certificate is not trusted: who issued what the server (or the proxy) presented. */
    certificateChain?: Array<{ subject: string; issuer: string }>;
    detail?: string;
}

const CERT_CODES = new Set(['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_UNTRUSTED', 'UNABLE_TO_GET_ISSUER_CERT']);

function request(url: string, conn: Connection, headers: Record<string, string>, opts: { rejectUnauthorized?: boolean; timeoutMs?: number } = {}): Promise<{ status: number; chain: Array<{ subject: string; issuer: string }> }> {
    return new Promise((resolve, reject) => {
        const plain = /^http:/i.test(url);
        const req = (plain ? http : https).request(url, {
            method: 'GET', headers, agent: conn.agentFor(url), timeout: opts.timeoutMs ?? 15_000,
            ...(plain ? {} : { ...(conn.ca ? { ca: conn.ca } : {}), rejectUnauthorized: opts.rejectUnauthorized !== false }),
        }, (res) => {
            const chain: Array<{ subject: string; issuer: string }> = [];
            try {
                let c = (res.socket as tls.TLSSocket).getPeerCertificate?.(true) as tls.DetailedPeerCertificate | undefined;
                const seen = new Set<string>();
                while (c && c.fingerprint256 && !seen.has(c.fingerprint256) && chain.length < 6) {
                    seen.add(c.fingerprint256);
                    const name = (x?: Record<string, string | string[]>) => { const v = x?.CN || x?.O; return Array.isArray(v) ? v.join(', ') : v || '?'; };
                    chain.push({ subject: name(c.subject as unknown as Record<string, string | string[]>), issuer: name(c.issuer as unknown as Record<string, string | string[]>) });
                    c = c.issuerCertificate;
                }
            } catch { /* not available */ }
            res.resume();
            res.on('end', () => resolve({ status: res.statusCode ?? 0, chain }));
        });
        req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
        req.on('error', reject);
        req.end();
    });
}

/**
 * Try `url` the way the Studio will use it, and say where it fails. When the certificate is not
 * trusted, a second look WITHOUT any credentials reads who issued the certificate that was
 * presented (e.g. "Zscaler Root CA"), so the user knows which root to trust.
 */
export async function checkConnection(url: string, conn: Connection, auth?: string): Promise<ConnectionCheck> {
    const proxy = conn.proxyLabel(url);
    const base = { url, proxy };
    try {
        const r = await request(url, conn, { Accept: 'application/json', ...(auth ? { Authorization: auth } : {}) });
        if (r.status === 407) return { ...base, ok: false, stage: 'proxy', status: 407, message: 'The proxy asks for a login (HTTP 407). Enter the proxy user name and password, or ask IT which login it expects.' };
        if (r.status === 401 || r.status === 203) return { ...base, ok: false, stage: 'http', status: r.status, message: 'The network works, but Azure DevOps rejected the access token. Check it under Secrets (it may be expired or for another organization).' };
        if (r.status >= 400) return { ...base, ok: false, stage: 'http', status: r.status, message: `The network works; Azure DevOps answered HTTP ${r.status}.` };
        return { ...base, ok: true, stage: 'ok', status: r.status, message: proxy ? `Connected through ${proxy}.` : 'Connected directly.' };
    } catch (e) {
        const err = e as NodeJS.ErrnoException & { code?: string };
        const code = err.code ?? '';
        const msg = err.message ?? String(e);
        if (CERT_CODES.has(code) || /certificate|self.signed|issuer/i.test(msg)) {
            let chain: ConnectionCheck['certificateChain'];
            try { chain = (await request(url, conn, {}, { rejectUnauthorized: false, timeoutMs: 10_000 })).chain; } catch { /* keep what we know */ }
            const root = chain?.[chain.length - 1]?.issuer;
            return { ...base, ok: false, stage: 'certificate', certificateChain: chain, detail: code || msg,
                message: code === 'CERT_HAS_EXPIRED' ? 'The certificate presented has expired.'
                    : code === 'ERR_TLS_CERT_ALTNAME_INVALID' ? 'The certificate presented is for a different host name.'
                    : `The connection is not trusted: the certificate was issued by "${root ?? 'an unknown authority'}", which this computer's Node.js does not trust. On a company network this is usually the company's HTTPS-inspection root: turn on "Use this computer's certificates", or choose the company root certificate file.` };
        }
        if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
            return { ...base, ok: false, stage: 'dns', detail: code, message: proxy ? `The proxy ${proxy} could not be found (DNS). Check the proxy address.` : `${new URL(url).hostname} could not be found (DNS). On a company network you may need the proxy.` };
        }
        if (/407|Proxy Authentication Required/i.test(msg)) return { ...base, ok: false, stage: 'proxy', status: 407, detail: msg, message: 'The proxy asks for a login (HTTP 407). Enter the proxy user name and password.' };
        if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
            return { ...base, ok: false, stage: proxy ? 'proxy' : 'connect', detail: code,
                message: proxy ? `Could not get through the proxy ${proxy} (${code}). Check the address and port.` : `Could not connect to ${new URL(url).hostname} (${code}). On a company network you probably need the proxy.` };
        }
        return { ...base, ok: false, stage: 'connect', detail: code || msg, message: `Connection failed: ${msg}` };
    }
}

/**
 * Does an application address answer (BASE_URL, API_BASE_URL)? Any HTTP answer below 500 counts: 401/403 is a
 * sign-in page, 404 a missing root path. The network failures are described as for Azure DevOps.
 */
export async function checkUrl(url: string, conn: Connection): Promise<ConnectionCheck> {
    const r = await checkConnection(url, conn);
    if (r.stage !== 'http' || r.status === undefined) return r.ok ? { ...r, message: `Answers (HTTP ${r.status}).${r.proxy ? ` Through ${r.proxy}.` : ''}` } : r;
    if (r.status === 407) return r;
    if (r.status < 500) return { ...r, ok: true, stage: 'ok', message: r.status === 401 || r.status === 403 ? `Answers (HTTP ${r.status}: it asks for a sign-in).` : `Answers (HTTP ${r.status}).` };
    return { ...r, ok: false, message: `The server answers with an error (HTTP ${r.status}).` };
}
