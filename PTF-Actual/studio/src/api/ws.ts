/**
 * WebSocket exchanges (Node's built-in WebSocket client): connect with the request's headers and
 * authentication, then send messages and wait for expected ones, saving values from them.
 * The time is the whole exchange (connect, every step, until the last expected message).
 * Note: the built-in client connects directly (the network settings' proxy is not used for WebSockets).
 */
import type { ApiResponse, CheckResult, PreparedRequest, Values } from './send';
import { fill } from './send';
import type { WsStep } from './model';
import { readPath } from './jsonPath';
import NodeWs from 'ws';
import type { Connection } from '../core/network';

export interface WsLogEntry { dir: 'out' | 'in' | 'info'; t: number; text: string }
export interface WsResult {
    connected: boolean;
    timeMs: number;
    log: WsLogEntry[];
    /** Per step: passed or not, and why. */
    steps: Array<{ step: number; pass: boolean; message: string }>;
    saved: Record<string, string>;
    error?: string;
}

/** ws(s) URL of a prepared request (http → ws, https → wss). */
export const wsUrl = (url: string) => url.replace(/^http(s?):\/\//i, 'ws$1://');

const MAX_LOG = 500, MAX_TEXT = 20_000;
const shown = (t: string) => (t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}… (${t.length - MAX_TEXT} more characters)` : t);
const asText = async (d: unknown): Promise<string> => (typeof d === 'string' ? d : d instanceof Blob ? `(binary, ${d.size} bytes)` : d instanceof ArrayBuffer ? `(binary, ${d.byteLength} bytes)` : Buffer.isBuffer(d) ? `(binary, ${d.length} bytes)` : String(d));

export async function wsExchange(p: Pick<PreparedRequest, 'url' | 'headers'>, steps: WsStep[], v: Values, timeoutMs = 30_000, conn?: Connection): Promise<WsResult> {
    const t0 = performance.now();
    const at = () => Math.round(performance.now() - t0);
    const res: WsResult = { connected: false, timeMs: 0, log: [], steps: [], saved: {} };
    const log = (dir: WsLogEntry['dir'], text: string) => { if (res.log.length < MAX_LOG) res.log.push({ dir, t: at(), text: shown(text) }); };
    const url = wsUrl(p.url);
    if (!/^wss?:\/\//i.test(url)) { res.error = `A WebSocket URL starts with ws:// or wss:// (got ${url}).`; return res; }
    const inbox: string[] = [];
    let wake: (() => void) | null = null;
    let closed: string | null = null;
    // Handshake headers the client sets itself must not be overridden.
    const headers = Object.fromEntries(Object.entries(p.headers).filter(([k]) => !/^(host|connection|upgrade|sec-websocket-.*|content-type|content-length)$/i.test(k)));
    let ws: WebSocket;
    // Through the proxy (CONNECT, NTLM/Digest sign-in), with a client certificate or the company's root certificates:
    // the ws client with the same agent as HTTP requests; otherwise Node's own WebSocket.
    const agent = conn?.agentFor(url.replace(/^ws/i, 'http'));
    try {
        ws = agent || conn?.ca
            ? (new NodeWs(url, { headers, ...(agent ? { agent } : {}), ...(conn?.ca ? { ca: conn.ca } : {}), handshakeTimeout: timeoutMs }) as unknown as WebSocket)
            : new WebSocket(url, { headers } as unknown as string[]);
    }
    catch (e) { res.error = (e as Error).message; res.timeMs = at(); return res; }
    const done = () => { try { ws.close(); } catch { /* closed */ } res.timeMs = at(); return res; };
    ws.onopen = () => wake?.();
    ws.onmessage = (e) => { void asText(e.data).then((t) => { inbox.push(t); log('in', t); wake?.(); }); };
    ws.onclose = (e) => { closed = `closed by the server (code ${e.code}${e.reason ? `: ${e.reason}` : ''})`; wake?.(); };
    ws.onerror = () => { closed = closed ?? 'connection failed'; wake?.(); };
    const until = (ok: () => boolean, ms: number) => new Promise<boolean>((resolve) => {
        if (ok()) return resolve(true);
        const timer = setTimeout(() => { wake = null; resolve(ok()); }, ms);
        wake = () => { if (ok() || closed) { clearTimeout(timer); wake = null; resolve(ok()); } };
    });
    // Connect.
    const opened = await until(() => ws.readyState === WebSocket.OPEN, timeoutMs);
    if (!opened) { res.error = closed ? `Could not connect to ${url}: ${closed}.` : `Could not connect to ${url} within ${timeoutMs} ms.`; return done(); }
    res.connected = true;
    log('info', `Connected to ${url}`);
    const vals: Values = { ...v, vars: { ...v.vars } };
    for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        const missing = new Set<string>();
        const text = fill(s.text, vals, missing);
        if (missing.size) { res.steps.push({ step: i + 1, pass: false, message: `Not filled in: ${[...missing].join(', ')}` }); res.error = res.steps.at(-1)!.message; return done(); }
        if (s.kind === 'send') {
            if (ws.readyState !== WebSocket.OPEN) { res.steps.push({ step: i + 1, pass: false, message: `Cannot send: ${closed ?? 'not connected'}` }); res.error = res.steps.at(-1)!.message; return done(); }
            ws.send(text); log('out', text);
            res.steps.push({ step: i + 1, pass: true, message: 'Sent' });
            continue;
        }
        // Expect: the first message (not used by an earlier step) that contains the text.
        let found = -1;
        const ok = await until(() => (found = inbox.findIndex((m) => m.includes(text))) >= 0, s.timeoutMs ?? timeoutMs);
        if (!ok) {
            const why = `No message${text ? ` containing "${text}"` : ''} within ${s.timeoutMs ?? timeoutMs} ms${closed ? ` (${closed})` : ''}`;
            res.steps.push({ step: i + 1, pass: false, message: why }); res.error = why; return done();
        }
        const msg = inbox[found];
        inbox.splice(0, found + 1);
        if (s.save?.variable && s.save.path) {
            let value: unknown;
            try { value = readPath(JSON.parse(msg), s.save.path); } catch { value = undefined; }
            if (value === undefined || value === null) { const why = `The message has no ${s.save.path} to save as ${s.save.variable}`; res.steps.push({ step: i + 1, pass: false, message: why }); res.error = why; return done(); }
            const str = typeof value === 'string' ? value : JSON.stringify(value);
            res.saved[s.save.variable] = str; vals.vars[s.save.variable] = str;
        }
        res.steps.push({ step: i + 1, pass: true, message: text ? `Received a message containing "${text}"` : 'Received a message' });
    }
    return done();
}

/** The exchange shown like an HTTP response: the message log as the body, each step as a check. */
export function wsAsResponse(r: WsResult, steps: WsStep[], label = 'WebSocket'): { response: ApiResponse; checks: CheckResult[]; extracted: Array<{ variable: string; value?: string; found: boolean }> } {
    const body = r.log.map((l) => `${l.dir === 'out' ? '→' : l.dir === 'in' ? '←' : '·'} ${String(l.t).padStart(6)} ms  ${l.text}`).join('\n') + (r.error ? `\n✗ ${r.error}` : '');
    return {
        response: { status: r.connected ? 101 : 0, statusText: r.connected ? label : 'Not connected', headers: {}, body, truncated: false, size: Buffer.byteLength(body), timeMs: r.timeMs, redirects: [] },
        checks: steps.map((s, i): CheckResult => {
            const done = r.steps.find((x) => x.step === i + 1);
            return { check: { kind: 'bodyContains', value: s.text }, pass: !!done?.pass, message: done ? `${i + 1}. ${s.kind === 'send' ? 'Send' : 'Expect'}: ${done.message}` : `${i + 1}. ${s.kind === 'send' ? 'Send' : 'Expect'}: not reached` };
        }),
        extracted: steps.filter((s) => s.save?.variable).map((s) => ({ variable: s.save!.variable, value: r.saved[s.save!.variable], found: s.save!.variable in r.saved })),
    };
}
