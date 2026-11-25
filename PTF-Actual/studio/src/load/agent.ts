/**
 * A load generator agent (`cs-test-studio agent`): runs the parts of load tests a controller (the Studio) sends it,
 * one at a time, in a worker thread, and reports progress and its own health. Every call needs the agent's
 * token (Authorization: Bearer …, compared in constant time). The parts carry the scenario's resolved values,
 * secrets included: use https (--tls-cert / --tls-key) or a private network, and keep the token secret.
 *   GET  /health                  idle or busy, CPU and memory, version, host, zone
 *   POST /runs                    { scenarioFile, project, env, definition, input, startAt? } → { id }
 *   GET  /runs/:id                progress (waiting until startAt), then the result
 *   POST /runs/:id/stop, /adjust  { factor }
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import { LoadRuns } from './runs';
import { validScenario } from './scenario';

export interface AgentOptions {
    token: string; dir: string; workerFile: string;
    /** A copy of the repository on this computer (.proto files, drivers of SQL actions, browser paths). */
    repo?: string; zone?: string; version?: string;
    tls?: { cert: string; key: string };
    maxBodyBytes?: number;
}

function cpuMeter() {
    const read = () => os.cpus().reduce((a, c) => { const t = c.times; return { idle: a.idle + t.idle, total: a.total + t.user + t.nice + t.sys + t.idle + t.irq }; }, { idle: 0, total: 0 });
    let last = read(), value = 0, at = Date.now();
    return () => { if (Date.now() - at > 500) { const now = read(); const dt = now.total - last.total; value = dt > 0 ? Math.round((1000 * (dt - (now.idle - last.idle))) / dt) / 10 : value; last = now; at = Date.now(); } return value; };
}

export function createAgent(o: AgentOptions): http.Server {
    if (o.token.length < 16) throw new Error('The agent token must be at least 16 characters (CS_AGENT_TOKEN).');
    const runs = new LoadRuns(o.dir, o.workerFile);
    const cpu = cpuMeter();
    const want = crypto.createHash('sha256').update(o.token).digest();
    const pending = new Map<string, { timer: NodeJS.Timeout; info: { id: string; startAt: string } }>();
    const json = (res: http.ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
        const got = crypto.createHash('sha256').update(String(req.headers.authorization ?? '').replace(/^Bearer /, '')).digest();
        if (!crypto.timingSafeEqual(got, want)) return json(res, 401, { error: 'A valid agent token is needed.' });
        const url = new URL(req.url ?? '/', 'http://agent');
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (c: Buffer) => { size += c.length; if (size > (o.maxBodyBytes ?? 300 * 1024 * 1024)) { json(res, 413, { error: 'Too large.' }); req.destroy(); } else chunks.push(c); });
        req.on('end', () => {
            try {
                const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
                if (req.method === 'GET' && url.pathname === '/health') {
                    return json(res, 200, { busy: !!runs.running() || pending.size > 0, cpu: cpu(), memory: Math.round((1000 * (os.totalmem() - os.freemem())) / os.totalmem()) / 10, version: o.version ?? '', host: os.hostname(), ...(o.zone ? { zone: o.zone } : {}) });
                }
                if (req.method === 'POST' && url.pathname === '/runs') {
                    if (runs.running() || pending.size) return json(res, 409, { error: 'This generator is running another test.' });
                    const definition = validScenario(body.definition);
                    const input = { ...body.input, scenario: definition, ...(o.repo ? { projectRoot: o.repo } : {}) };
                    if (!input || !Array.isArray(input.requests) || !input.part) throw new Error('Not a part of a load test.');
                    const go = () => runs.start({ scenarioFile: String(body.scenarioFile), project: String(body.project), env: String(body.env), definition, input });
                    const at = body.startAt ? Date.parse(String(body.startAt)) : NaN;
                    if (Number.isFinite(at) && at - Date.now() > 50) {
                        if (at - Date.now() > 3_600_000) throw new Error('The start is more than an hour away.');
                        const id = `wait-${crypto.randomBytes(6).toString('hex')}`;
                        const p = { info: { id, startAt: new Date(at).toISOString() }, timer: setTimeout(() => { pending.delete(id); try { const info = go(); alias.set(id, info.id); } catch (e) { failed.set(id, (e as Error).message); } }, at - Date.now()) };
                        pending.set(id, p);
                        return json(res, 200, { id });
                    }
                    return json(res, 200, { id: go().id });
                }
                const m = /^\/runs\/([\w-]{1,80})(?:\/(stop|adjust))?$/.exec(url.pathname);
                if (m) {
                    const wait = pending.get(m[1]);
                    const id = alias.get(m[1]) ?? m[1];
                    if (req.method === 'GET' && !m[2]) {
                        if (wait) return json(res, 200, { id: m[1], state: 'running', waiting: true, startAt: wait.info.startAt });
                        if (failed.has(m[1])) return json(res, 200, { id: m[1], state: 'error', message: failed.get(m[1]) });
                        const d = runs.get(id);
                        return d ? json(res, 200, d) : json(res, 404, { error: 'No such run.' });
                    }
                    if (req.method === 'POST' && m[2] === 'stop') {
                        if (wait) { clearTimeout(wait.timer); pending.delete(m[1]); failed.set(m[1], 'Stopped before it started.'); return json(res, 200, { stopped: true }); }
                        return json(res, 200, { stopped: runs.stop(id) });
                    }
                    if (req.method === 'POST' && m[2] === 'adjust') return json(res, 200, { adjusted: runs.adjust(id, Math.max(0, Math.min(Number(body.factor) || 1, 10))) });
                }
                json(res, 404, { error: 'Not found.' });
            } catch (e) { json(res, 400, { error: (e as Error).message }); }
        });
    };
    const alias = new Map<string, string>();
    const failed = new Map<string, string>();
    return o.tls ? https.createServer({ cert: fs.readFileSync(o.tls.cert), key: fs.readFileSync(o.tls.key) }, handler) : http.createServer(handler);
}
