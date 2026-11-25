/**
 * Requests through an HTTP proxy, with the proxy's sign-in (shared by the Studio and the framework):
 *  - https:// addresses: a CONNECT tunnel, then TLS to the server (the certificate is the server's);
 *  - http:// addresses: the request goes to the proxy with the full address (forwarding);
 *  - the proxy's sign-in: Basic, or NTLM / Digest answered on the same connection (407 → challenge → answer), as
 *    Windows proxies ask. Each tunnel is one kept-alive connection (reused for the next requests).
 */
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as tls from 'tls';
import type { Duplex } from 'stream';
import { digestAuthorization, ntlmParseType2, ntlmType1, ntlmType3, parseDigest } from '../api/httpAuth';

export interface ProxyAuth { type: 'basic' | 'ntlm' | 'digest'; username: string; password: string; domain?: string; workstation?: string }
export interface ProxyServer { host: string; port: number; auth?: ProxyAuth; timeoutMs?: number }

/**
 * The proxy's answers on one connection: everything it sends during the handshake is kept in one buffer (the socket
 * stays paused between reads, so nothing is lost), and what is left after the last answer goes back to the socket.
 */
class HandshakeReader {
    private buf = Buffer.alloc(0);
    private wake: (() => void) | null = null;
    private failed: Error | null = null;
    private readonly onData = (d: Buffer) => { this.buf = Buffer.concat([this.buf, d]); this.wake?.(); };
    private readonly onEnd = (e?: Error) => { this.failed = e ?? new Error('The proxy closed the connection.'); this.wake?.(); };
    constructor(private readonly socket: net.Socket, private readonly timeoutMs: number) {
        socket.on('data', this.onData); socket.on('error', this.onEnd); socket.on('close', () => this.onEnd());
    }
    private async more(): Promise<void> {
        if (this.failed) throw this.failed;
        await new Promise<void>((resolve, reject) => {
            const t = setTimeout(() => { this.wake = null; reject(new Error('The proxy did not answer in time.')); }, this.timeoutMs);
            this.wake = () => { clearTimeout(t); this.wake = null; resolve(); };
        });
        if (this.failed) throw this.failed;
    }
    /** The next response head (status, headers) and its body (Content-Length). */
    async response(): Promise<{ status: number; headers: Record<string, string> }> {
        let end: number;
        while ((end = this.buf.indexOf('\r\n\r\n')) < 0) await this.more();
        const lines = this.buf.subarray(0, end).toString('latin1').split('\r\n');
        this.buf = this.buf.subarray(end + 4);
        const status = Number(/^HTTP\/\d\.\d (\d{3})/.exec(lines[0])?.[1] ?? 0);
        const headers: Record<string, string> = {};
        for (const l of lines.slice(1)) { const i = l.indexOf(':'); if (i > 0) { const k = l.slice(0, i).trim().toLowerCase(); headers[k] = headers[k] ? `${headers[k]}, ${l.slice(i + 1).trim()}` : l.slice(i + 1).trim(); } }
        // A 407's body comes before the next answer: skip it (a 200 to CONNECT has none).
        const len = status === 200 ? 0 : Number(headers['content-length'] ?? 0);
        while (this.buf.length < len) await this.more();
        this.buf = this.buf.subarray(len);
        return { status, headers };
    }
    /** Hand the socket over (to TLS or the request): paused, with any bytes already read put back. */
    release() {
        this.socket.off('data', this.onData);
        this.socket.removeAllListeners('close');
        this.socket.off('error', this.onEnd);
        this.socket.pause();
        if (this.buf.length) this.socket.unshift(this.buf);
    }
}

/** A TCP connection to `host:port` through the proxy (CONNECT), signed in to the proxy as it asks. */
export async function connectThroughProxy(proxy: ProxyServer, host: string, port: number): Promise<net.Socket> {
    const timeout = proxy.timeoutMs ?? 30_000;
    const socket = net.connect(proxy.port, proxy.host);
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    const reader = new HandshakeReader(socket, timeout);
    const target = `${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`;
    const send = (auth?: string) => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Connection: Keep-Alive\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ''}\r\n`);
    try {
        const a = proxy.auth;
        send(a?.type === 'basic' ? `Basic ${Buffer.from(`${a.username}:${a.password}`).toString('base64')}` : a?.type === 'ntlm' ? `NTLM ${ntlmType1()}` : undefined);
        let head = await reader.response();
        if (head.status === 407 && a && a.type !== 'basic') {
            const challenge = head.headers['proxy-authenticate'] ?? '';
            let answer: string | undefined;
            if (a.type === 'ntlm' && /NTLM\s+[A-Za-z0-9+/=]{20,}/i.test(challenge)) answer = `NTLM ${ntlmType3(ntlmParseType2(challenge), a.username, a.password, a.domain ?? '', a.workstation ?? '')}`;
            else if (a.type === 'digest') { const c = parseDigest(challenge); if (c) answer = digestAuthorization(c, { username: a.username, password: a.password, method: 'CONNECT', uri: target }); }
            if (answer) { send(answer); head = await reader.response(); }
        }
        if (head.status !== 200) {
            throw new Error(head.status === 407 ? `The proxy ${proxy.host}:${proxy.port} refused the sign-in (407${head.headers['proxy-authenticate'] ? `, it asks for ${head.headers['proxy-authenticate'].split(/[\s,]/)[0]}` : ''}).` : `The proxy ${proxy.host}:${proxy.port} answered ${head.status} to CONNECT ${target}.`);
        }
        reader.release();
        return socket;
    } catch (e) {
        socket.destroy();
        throw e;
    }
}

/** An agent for https:// addresses through the proxy (each connection a CONNECT tunnel + TLS), connections kept alive. */
export class ProxyTunnelAgent extends https.Agent {
    constructor(private readonly proxy: ProxyServer, opts: https.AgentOptions = {}) { super({ keepAlive: true, ...opts }); }
    // Node calls createConnection with a callback when it does not get a socket back (an asynchronous connection).
    override createConnection(options: http.ClientRequestArgs, callback?: (err: Error | null, stream: Duplex) => void): undefined {
        const o = options as tls.ConnectionOptions & { host?: string; port?: number };
        const cb = callback!;
        connectThroughProxy(this.proxy, o.host!, Number(o.port) || 443)
            .then((raw) => {
                const s = tls.connect({ ...o, socket: raw, servername: o.servername ?? (net.isIP(o.host!) ? undefined : o.host) });
                s.once('secureConnect', () => cb(null, s));
                s.once('error', (e) => cb(e, s));
            }, (e: Error) => cb(e, new net.Socket()));
        return undefined;
    }
}

/** An agent for http:// addresses through the proxy: CONNECT tunnels (used when the proxy needs NTLM / Digest). */
export class ProxyTunnelHttpAgent extends http.Agent {
    constructor(private readonly proxy: ProxyServer, opts: http.AgentOptions = {}) { super({ keepAlive: true, ...opts }); }
    override createConnection(options: http.ClientRequestArgs, callback?: (err: Error | null, stream: Duplex) => void): undefined {
        const cb = callback!;
        // The tunnel comes paused (nothing lost during the handshake): the HTTP client reads it once it is attached.
        connectThroughProxy(this.proxy, String(options.host ?? options.hostname), Number(options.port) || 80).then((s) => { cb(null, s); setImmediate(() => s.resume()); }, (e: Error) => cb(e, new net.Socket()));
        return undefined;
    }
}

/**
 * Request options for `url` through the proxy: https (and http when the proxy needs NTLM / Digest) through a tunnel
 * agent; plain http forwarded (the full address as the path, Basic sign-in in Proxy-Authorization).
 */
export function viaProxy(url: string, proxy: ProxyServer, agents: { https?: https.Agent; http?: http.Agent } = {}): { agent?: http.Agent; hostname?: string; port?: number; path?: string; headers?: Record<string, string> } {
    const u = new URL(url);
    if (u.protocol === 'https:') return { agent: agents.https ?? new ProxyTunnelAgent(proxy) };
    if (proxy.auth && proxy.auth.type !== 'basic') return { agent: agents.http ?? new ProxyTunnelHttpAgent(proxy) };
    return {
        hostname: proxy.host, port: proxy.port, path: u.href,
        headers: { Host: u.host, ...(proxy.auth ? { 'Proxy-Authorization': `Basic ${Buffer.from(`${proxy.auth.username}:${proxy.auth.password}`).toString('base64')}` } : {}) },
    };
}
