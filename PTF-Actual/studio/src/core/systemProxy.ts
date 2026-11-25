/**
 * The proxy the computer is set up with, and PAC files (proxy auto-configuration):
 *  - Windows: the user's Internet settings (HKCU …\Internet Settings: ProxyEnable / ProxyServer / ProxyOverride /
 *    AutoConfigURL), what Edge and Chrome use;
 *  - macOS: `scutil --proxy` (HTTP/HTTPS proxy, exceptions, PAC URL);
 *  - Linux: HTTPS_PROXY / NO_PROXY.
 * A PAC script runs in an isolated context (no require, process or network) with the standard helper functions and a
 * time limit. Name resolution inside it (dnsResolve, isInNet, isResolvable) uses addresses already looked up: a name
 * is looked up in the background the first time, so the very first request to a new host may be decided without it.
 */
import * as dns from 'dns';
import * as net from 'net';
import * as os from 'os';
import * as vm from 'vm';
import { execFile } from 'child_process';

export interface SystemProxy { proxy?: string; httpsProxy?: string; bypass: string[]; pacUrl?: string; source: string }

const run = (cmd: string, args: string[]) => new Promise<string>((res) => execFile(cmd, args, { windowsHide: true, timeout: 10_000 }, (e, out) => res(e ? '' : String(out))));

/** Windows ProxyServer: "host:port", or per protocol "http=h:p;https=h:p;socks=…". */
export function parseWindowsProxyServer(v: string): { http?: string; https?: string } {
    if (!v.trim()) return {};
    if (!v.includes('=')) return { http: v.trim(), https: v.trim() };
    const m = Object.fromEntries(v.split(';').map((x) => x.split('=').map((y) => y.trim())).filter((x) => x.length === 2 && x[1]));
    return { http: m.http ?? m.https, https: m.https ?? m.http };
}

/** Windows ProxyOverride ("<local>;*.corp.local;10.*") as bypass entries. */
export function parseWindowsOverride(v: string): string[] {
    return v.split(/[;\s]+/).map((x) => x.trim()).filter(Boolean).map((x) => (x === '<local>' ? '<local>' : x.replace(/^\*\./, '.')));
}

export async function readSystemProxy(platform = process.platform, env: NodeJS.ProcessEnv = process.env): Promise<SystemProxy> {
    if (platform === 'win32') {
        const out = await run('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings']);
        const val = (name: string) => new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.*)$`, 'mi').exec(out)?.[1]?.trim() ?? '';
        const enabled = /^0x0*1$/i.test(val('ProxyEnable'));
        const servers = enabled ? parseWindowsProxyServer(val('ProxyServer')) : {};
        const pac = val('AutoConfigURL');
        const toUrl = (s?: string) => (s ? (/^\w+:\/\//.test(s) ? s : `http://${s}`) : undefined);
        return { proxy: toUrl(servers.http), httpsProxy: toUrl(servers.https), bypass: parseWindowsOverride(val('ProxyOverride')), ...(pac ? { pacUrl: pac } : {}), source: 'Windows Internet settings' };
    }
    if (platform === 'darwin') {
        const out = await run('scutil', ['--proxy']);
        const v = (k: string) => new RegExp(`\\b${k}\\s*:\\s*(\\S+)`).exec(out)?.[1];
        const exc = /ExceptionsList\s*:\s*<array>\s*\{([\s\S]*?)\}/.exec(out)?.[1] ?? '';
        const bypass = [...exc.matchAll(/:\s*(\S+)/g)].map((m) => m[1].replace(/^\*\./, '.'));
        const http = v('HTTPEnable') === '1' && v('HTTPProxy') ? `http://${v('HTTPProxy')}:${v('HTTPPort') ?? 80}` : undefined;
        const https = v('HTTPSEnable') === '1' && v('HTTPSProxy') ? `http://${v('HTTPSProxy')}:${v('HTTPSPort') ?? 443}` : undefined;
        const pac = v('ProxyAutoConfigEnable') === '1' ? v('ProxyAutoConfigURLString') : undefined;
        return { proxy: http, httpsProxy: https ?? http, bypass, ...(pac ? { pacUrl: pac } : {}), source: 'macOS network settings' };
    }
    const p = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
    return { proxy: env.HTTP_PROXY || env.http_proxy || p, httpsProxy: p, bypass: (env.NO_PROXY || env.no_proxy || '').split(',').map((x) => x.trim()).filter(Boolean), source: 'HTTPS_PROXY / NO_PROXY' };
}

// ---------------------------------------------------------------- PAC

const resolved = new Map<string, string | null>();
function lookupLater(host: string) {
    if (resolved.has(host) || net.isIP(host)) return;
    resolved.set(host, null);
    dns.lookup(host, { family: 4 }, (e, addr) => { if (!e) resolved.set(host, addr); });
}
const ip = (host: string): string | null => (net.isIP(host) ? host : (lookupLater(host), resolved.get(host) ?? null));
const ipNum = (a: string) => a.split('.').reduce((n, x) => n * 256 + Number(x), 0);
const glob = (s: string, pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i').test(s);
const myIp = () => Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address ?? '127.0.0.1';

/** The PAC helper functions (Netscape's original set). */
const PAC_HELPERS = {
    isPlainHostName: (h: string) => !h.includes('.'),
    dnsDomainIs: (h: string, d: string) => h.toLowerCase().endsWith(d.toLowerCase()),
    localHostOrDomainIs: (h: string, hd: string) => h.toLowerCase() === hd.toLowerCase() || (!h.includes('.') && hd.toLowerCase().startsWith(`${h.toLowerCase()}.`)),
    isResolvable: (h: string) => ip(h) !== null,
    isInNet: (h: string, pattern: string, mask: string) => { const a = ip(h); return a !== null && net.isIPv4(a) && (ipNum(a) & ipNum(mask)) >>> 0 === (ipNum(pattern) & ipNum(mask)) >>> 0; },
    dnsResolve: (h: string) => ip(h),
    myIpAddress: () => myIp(),
    dnsDomainLevels: (h: string) => (h.match(/\./g) ?? []).length,
    shExpMatch: (s: string, p: string) => glob(s, p),
    weekdayRange: () => true,
    dateRange: () => true,
    timeRange: () => true,
    alert: () => undefined,
};

/** A PAC script compiled once: url → the proxies it names, in order ("DIRECT" or http://host:port / socks5://…). */
export function pacEvaluator(script: string): (url: string) => string[] {
    const ctx = vm.createContext(Object.create(null));
    for (const [k, f] of Object.entries(PAC_HELPERS)) (ctx as Record<string, unknown>)[k] = f;
    new vm.Script(script, { filename: 'proxy.pac' }).runInContext(ctx, { timeout: 1000 });
    const find = (ctx as Record<string, unknown>).FindProxyForURL;
    if (typeof find !== 'function') throw new Error('The PAC file has no FindProxyForURL function.');
    return (url: string) => {
        const u = new URL(url);
        const call = new vm.Script('__r = FindProxyForURL(__u, __h)');
        Object.assign(ctx, { __u: url, __h: u.hostname });
        call.runInContext(ctx, { timeout: 200 });
        return parsePacResult(String((ctx as Record<string, unknown>).__r ?? 'DIRECT'));
    };
}

/** "PROXY a:8080; SOCKS5 b:1080; DIRECT" → ["http://a:8080", "socks5://b:1080", "DIRECT"]. */
export function parsePacResult(r: string): string[] {
    return r.split(';').map((x) => x.trim()).filter(Boolean).map((x) => {
        const [kind, hostPort] = x.split(/\s+/);
        const k = kind.toUpperCase();
        if (k === 'DIRECT' || !hostPort) return 'DIRECT';
        if (k === 'PROXY' || k === 'HTTP') return `http://${hostPort}`;
        if (k === 'HTTPS') return `https://${hostPort}`;
        if (k === 'SOCKS' || k === 'SOCKS4') return `socks4://${hostPort}`;
        if (k === 'SOCKS5') return `socks5://${hostPort}`;
        return 'DIRECT';
    });
}
