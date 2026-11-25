/**
 * Server monitoring during a load run: what the systems under test do while users hit them.
 *  - Linux over SSH (the computer's own ssh, its keys and configuration): CPU, memory, load, disk use, or the first
 *    number a command prints.
 *  - Windows performance counters (typeperf, on a Windows load generator; another computer's as \\host\counter):
 *    processor, memory, IIS, ASP.NET, .NET CLR, SQL Server counters.
 *  - JMX through Jolokia (the HTTP agent of Java servers): an MBean attribute (heap, threads, GC, pools).
 *  - A database's own counters: a query returning a number on one of the project's connections (SQL Server
 *    dm_os_performance_counters, Oracle v$sysstat, PostgreSQL pg_stat_*), read-only.
 *  - Prometheus endpoints (the text format of /metrics: node_exporter, windows_exporter, application
 *    metrics): a metric name with optional labels, summed over the matching series; counters can be
 *    turned into a rate per second.
 *  - JSON endpoints (e.g. Spring Boot actuator /actuator/metrics/system.cpu.usage): a value at a JSON path.
 *  - The load generator itself (always): CPU and memory of this computer, so an overloaded generator is
 *    not mistaken for a slow server.
 * A monitor can have a maximum: going over it fails the run like a service level.
 */
import * as os from 'os';
import { performance } from 'perf_hooks';
import { Histogram } from './metrics';
import type { Connection } from '../core/network';
import type { KV } from '../api/model';
import { fill, send, Values } from '../api/send';
import { readPath } from '../api/jsonPath';
import { execFile } from 'child_process';
import { SqlConn, sqlOpener } from '../api/sqlAction';

export type MonitorKind = 'prometheus' | 'json' | 'ssh' | 'perfmon' | 'jolokia' | 'sql';
export const SSH_PRESETS = { cpu: 'CPU busy (%)', memory: 'Memory used (%)', load: 'Load average (1 min)', disk: 'Disk used on / (%)' } as const;

export interface MonitorDef {
    name: string;
    kind: MonitorKind;
    /** prometheus, json, jolokia: the address. May use {config:KEY}, {env:NAME}. */
    url: string;
    /** ssh: user@host[:port]; perfmon: the computer (empty: this one). */
    host?: string;
    /** ssh: a measure of the computer, or a command whose output's first number is the value. */
    preset?: keyof typeof SSH_PRESETS;
    command?: string;
    /** ssh: private key file and known hosts file (default: the user's ssh configuration). */
    identity?: string;
    knownHosts?: string;
    /** perfmon: \\Processor(_Total)\\% Processor Time */
    counter?: string;
    /** jolokia: java.lang:type=Memory, HeapMemoryUsage, used (a wildcard MBean sums its values). */
    mbean?: string;
    attribute?: string;
    innerPath?: string;
    /** sql: connection alias (DB_<ALIAS>_*) and a query whose first column of the first row is the value. */
    connection?: string;
    query?: string;
    /** prometheus: metric{label="value",other!="x"}. */
    metric?: string;
    /** json: $.path.to[0].value */
    path?: string;
    headers?: KV[];
    unit?: string;
    /** A counter: show its increase per second. */
    rate?: boolean;
    /** Multiply the value (e.g. 100 for a 0–1 ratio shown as %). */
    scale?: number;
    /** Fail the run when the value goes over this (a critical alert while running). */
    max?: number;
    /** A warning alert while running when the value goes over this. */
    warn?: number;
}

/** An alert raised while running: a monitor over its warning / maximum, and back below. */
export interface LoadAlert { t: number; level: 'warning' | 'critical' | 'ok'; source: string; message: string }

export interface MonitorSeries { name: string; unit: string; points: Array<{ t: number; v: number }>; max?: number; warn?: number; error?: string; generator?: boolean }

const SELECTOR = /^([a-zA-Z_:][\w:]*)(?:\{(.*)\})?$/;

/** A Prometheus selector check (name and =, != label matchers); null when it is not one. */
export function parseSelector(sel: string): { name: string; labels: Array<{ key: string; op: '=' | '!='; value: string }> } | null {
    const m = SELECTOR.exec(sel.trim());
    if (!m) return null;
    const labels: Array<{ key: string; op: '=' | '!='; value: string }> = [];
    const body = (m[2] ?? '').trim();
    if (body) {
        const re = /\s*([a-zA-Z_]\w*)\s*(!=|=)\s*"((?:[^"\\]|\\.)*)"\s*(,|$)/y;
        let pos = 0;
        while (pos < body.length) {
            re.lastIndex = pos;
            const x = re.exec(body);
            if (!x) return null;
            labels.push({ key: x[1], op: x[2] as '=' | '!=', value: x[3].replace(/\\(.)/g, '$1') });
            pos = re.lastIndex;
        }
    }
    return { name: m[1], labels };
}

/** Sum of the samples of a Prometheus text exposition that match the selector; null when none match. */
export function promValue(text: string, selector: string): number | null {
    const sel = parseSelector(selector);
    if (!sel) throw new Error(`"${selector}" is not a metric name with optional labels, e.g. node_load1 or http_requests_total{status="500"}.`);
    let sum = 0, found = false;
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const m = /^([a-zA-Z_:][\w:]*)(\{[^}]*\})?\s+(\S+)/.exec(line);
        if (!m || m[1] !== sel.name) continue;
        const labels: Record<string, string> = {};
        for (const x of (m[2] ?? '').slice(1, -1).matchAll(/([a-zA-Z_]\w*)="((?:[^"\\]|\\.)*)"/g)) labels[x[1]] = x[2].replace(/\\(.)/g, '$1');
        if (!sel.labels.every((l) => (l.op === '=' ? labels[l.key] === l.value : labels[l.key] !== l.value))) continue;
        const v = m[3] === '+Inf' ? Infinity : m[3] === '-Inf' ? -Infinity : Number(m[3]);
        if (!Number.isFinite(v)) continue;
        sum += v; found = true;
    }
    return found ? sum : null;
}

export function validMonitor(m: MonitorDef): string | null {
    if (!m || typeof m.name !== 'string' || !m.name.trim() || m.name.length > 80) return 'a monitor needs a name';
    if (!['prometheus', 'json', 'ssh', 'perfmon', 'jolokia', 'sql'].includes(m.kind)) return `${m.name}: kind is prometheus, json, ssh, perfmon, jolokia or sql`;
    const web = m.kind === 'prometheus' || m.kind === 'json' || m.kind === 'jolokia';
    if (web && (typeof m.url !== 'string' || !/^(https?:\/\/|\{config:)/i.test(m.url.trim()))) return `${m.name}: the URL must start with http(s):// or {config:KEY}`;
    if (m.kind === 'prometheus' && (!m.metric || !parseSelector(m.metric))) return `${m.name}: a metric such as node_load1 or process_cpu_seconds_total{job="api"}`;
    if (m.kind === 'json' && (!m.path || !m.path.startsWith('$'))) return `${m.name}: a JSON path such as $.measurements[0].value`;
    if (m.kind === 'ssh') {
        if (!m.host || !sshHost(m.host)) return `${m.name}: the computer as user@host or user@host:port`;
        if (!m.preset === !m.command?.trim()) return `${m.name}: a measure (${Object.keys(SSH_PRESETS).join(', ')}) or a command`;
        if (m.preset && !(m.preset in SSH_PRESETS)) return `${m.name}: the measure is ${Object.keys(SSH_PRESETS).join(', ')}`;
        if (m.command && m.command.length > 1000) return `${m.name}: the command is too long`;
    }
    if (m.kind === 'perfmon') {
        if (!m.counter || !/^\\[^\\]+\\.+/.test(m.counter.trim())) return `${m.name}: a counter such as \\Processor(_Total)\\% Processor Time`;
        if (m.host && !/^[\w.-]{1,253}$/.test(m.host.trim())) return `${m.name}: the computer is a name such as web01`;
    }
    if (m.kind === 'jolokia' && (!m.mbean?.trim() || !/^[^:]+:.+=/.test(m.mbean) || !m.attribute?.trim())) return `${m.name}: an MBean (java.lang:type=Memory) and an attribute (HeapMemoryUsage)`;
    if (m.kind === 'sql' && (!m.connection || !/^[A-Za-z0-9_]{1,64}$/.test(m.connection) || !m.query?.trim())) return `${m.name}: a connection (DB_<ALIAS>_*) and a query returning a number`;
    if (m.max !== undefined && !Number.isFinite(m.max)) return `${m.name}: the maximum must be a number`;
    if (m.warn !== undefined && !Number.isFinite(m.warn)) return `${m.name}: the warning level must be a number`;
    if (m.warn !== undefined && m.max !== undefined && m.warn > m.max) return `${m.name}: the warning level is above the maximum`;
    if (m.scale !== undefined && !(Number.isFinite(m.scale) && m.scale !== 0)) return `${m.name}: the scale must be a number`;
    return null;
}

/** user@host[:port] (no option-like or shell characters). */
export function sshHost(s: string): { user?: string; host: string; port?: number } | null {
    const m = /^(?:([A-Za-z0-9._-]+)@)?([A-Za-z0-9.-]+|\[[0-9a-fA-F:]+\])(?::(\d{1,5}))?$/.exec(s.trim());
    if (!m || m[2].startsWith('-')) return null;
    return { ...(m[1] ? { user: m[1] } : {}), host: m[2], ...(m[3] ? { port: Number(m[3]) } : {}) };
}

/** The commands of the SSH measures (Linux /proc and df). */
const SSH_COMMANDS: Record<keyof typeof SSH_PRESETS, string> = {
    cpu: 'head -1 /proc/stat', memory: "grep -E '^(MemTotal|MemAvailable):' /proc/meminfo", load: 'cat /proc/loadavg', disk: 'df -P / | tail -1',
};

/** The value of an SSH measure from the command's output (CPU: busy share since the previous reading `prev`). */
export function sshValue(preset: keyof typeof SSH_PRESETS | undefined, out: string, prev?: number[]): { value: number | null; raw?: number[] } {
    if (preset === 'cpu') {
        const f = out.trim().split(/\s+/).slice(1, 9).map(Number);
        if (f.length < 4 || f.some((x) => !Number.isFinite(x))) throw new Error('Unexpected /proc/stat output.');
        if (!prev) return { value: null, raw: f };
        const total = f.reduce((a, b) => a + b, 0) - prev.reduce((a, b) => a + b, 0);
        const idle = (f[3] + (f[4] ?? 0)) - (prev[3] + (prev[4] ?? 0));
        return { value: total > 0 ? Math.round((1000 * (total - idle)) / total) / 10 : 0, raw: f };
    }
    if (preset === 'memory') {
        const total = Number(/MemTotal:\s+(\d+)/.exec(out)?.[1]), avail = Number(/MemAvailable:\s+(\d+)/.exec(out)?.[1]);
        if (!total || !Number.isFinite(avail)) throw new Error('Unexpected /proc/meminfo output.');
        return { value: Math.round((1000 * (total - avail)) / total) / 10 };
    }
    if (preset === 'disk') {
        const m = /(\d+)%/.exec(out);
        if (!m) throw new Error('Unexpected df output.');
        return { value: Number(m[1]) };
    }
    const m = /-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/.exec(out);
    return { value: m ? Number(m[0]) : null };
}

/** The value of a typeperf sample (its CSV: a header line, then "time","value"). */
export function perfmonValue(out: string): number | null {
    const lines = out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('"'));
    const last = lines.at(-1);
    if (!last || lines.length < 2) return null;
    const cells = [...last.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    const v = Number(cells[1]);
    return cells.length >= 2 && cells[1].trim() !== '' && Number.isFinite(v) ? v : null;
}

/** The sum of the numbers of a Jolokia value (one number, or an object of them: a wildcard MBean, a composite). */
export function jolokiaValue(v: unknown): number | null {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
    if (v && typeof v === 'object') {
        let sum = 0, found = false;
        for (const x of Object.values(v as Record<string, unknown>)) { const n = jolokiaValue(x); if (n !== null) { sum += n; found = true; } }
        return found ? sum : null;
    }
    return null;
}

const run = (file: string, args: string[], timeoutMs: number) => new Promise<string>((res, rej) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true }, (e, out, err) => {
        if (e) return rej(new Error((String(err).trim().split('\n').filter(Boolean).at(-1) || e.message).slice(0, 300)));
        res(String(out));
    });
});

/** CPU busy share of this computer since the last call (all cores, 0–100). */
function cpuMeter() {
    const read = () => os.cpus().reduce((a, c) => { const t = c.times; return { idle: a.idle + t.idle, total: a.total + t.user + t.nice + t.sys + t.idle + t.irq }; }, { idle: 0, total: 0 });
    let last = read();
    return () => { const now = read(); const dt = now.total - last.total, di = now.idle - last.idle; last = now; return dt > 0 ? Math.round((1000 * (dt - di)) / dt) / 10 : 0; };
}

/** How late a 10 ms timer runs on this thread (the load generator's own delay): the 99th percentile since the last take. */
class LagMeter {
    private h = new Histogram();
    private last = performance.now();
    private readonly timer: NodeJS.Timeout;
    constructor(private readonly every = 10) {
        this.timer = setInterval(() => { const now = performance.now(); this.h.add(Math.max(0, now - this.last - this.every)); this.last = now; }, every);
        this.timer.unref();
    }
    take(): number | null {
        if (!this.h.count) return null;
        const v = Math.round(this.h.percentile(99) * 10) / 10;
        this.h = new Histogram();
        return v;
    }
    stop() { clearInterval(this.timer); }
}

export class Monitors {
    private readonly series: MonitorSeries[];
    private readonly prev = new Map<number, { t: number; v: number }>();
    private readonly cpu = cpuMeter();
    private busy = false;
    /** How late the load generator's timers run (99th percentile per sample): a busy generator sends late and measures late. */
    private readonly delay = new LagMeter();
    static readonly CPU_LIMIT = 90;
    static readonly DELAY_LIMIT = 100;

    private readonly raw = new Map<number, number[]>();
    private readonly sql = new Map<number, Promise<SqlConn>>();
    private readonly level = new Map<number, 'ok' | 'warning' | 'critical'>();
    readonly alerts: LoadAlert[] = [];

    constructor(private readonly defs: MonitorDef[], private readonly values: Values, private readonly conn: Connection | undefined, private readonly timeoutMs = 4000,
        private readonly ctx: { environment?: string; projectRoot?: string; onAlert?: (a: LoadAlert) => void } = {}) {
        this.series = [
            { name: 'Load generator CPU', unit: '%', points: [], generator: true },
            { name: 'Load generator memory', unit: '%', points: [], generator: true },
            { name: 'Load generator delay', unit: 'ms', points: [], generator: true },
            ...defs.map((d) => ({ name: d.name, unit: d.unit ?? (d.kind === 'ssh' && d.preset && d.preset !== 'load' ? '%' : ''), points: [], ...(d.max !== undefined ? { max: d.max } : {}), ...(d.warn !== undefined ? { warn: d.warn } : {}) })),
        ];
    }

    /** One reading of a monitor (null: none yet, e.g. the first CPU reading over SSH). */
    private async read(d: MonitorDef, i: number): Promise<number | null> {
        const missing = new Set<string>();
        const f = (x: string) => fill(x, this.values, missing);
        const need = () => { if (missing.size) throw new Error(`Not filled in: ${[...missing].join(', ')}`); };
        if (d.kind === 'ssh') {
            const h = sshHost(f(d.host ?? ''));
            if (!h) throw new Error('The computer is user@host[:port].');
            const cmd = d.preset ? SSH_COMMANDS[d.preset] : f(d.command ?? '');
            need();
            const args = ['-o', 'BatchMode=yes', '-o', `ConnectTimeout=${Math.max(1, Math.round(this.timeoutMs / 1000))}`, '-o', 'StrictHostKeyChecking=accept-new',
                ...(d.knownHosts ? ['-o', `UserKnownHostsFile=${f(d.knownHosts)}`] : []), ...(d.identity ? ['-i', f(d.identity)] : []), ...(h.port ? ['-p', String(h.port)] : []),
                '--', h.user ? `${h.user}@${h.host}` : h.host, cmd];
            const out = await run(process.env.CS_SSH_BIN || 'ssh', args, this.timeoutMs);
            const r = sshValue(d.preset, out, this.raw.get(i));
            if (r.raw) this.raw.set(i, r.raw);
            if (r.value === null && !(d.preset === 'cpu')) throw new Error('The command printed no number.');
            return r.value;
        }
        if (d.kind === 'perfmon') {
            if (process.platform !== 'win32') throw new Error('Windows performance counters are read with typeperf on a Windows load generator; elsewhere, read them through windows_exporter (Prometheus).');
            const counter = d.counter!.trim();
            const v = perfmonValue(await run('typeperf', [d.host?.trim() ? `\\\\${d.host.trim()}${counter}` : counter, '-sc', '1'], Math.max(this.timeoutMs, 5000)));
            if (v === null) throw new Error(`No value for ${counter}`);
            return v;
        }
        if (d.kind === 'sql') {
            let open = this.sql.get(i);
            if (!open) { open = sqlOpener({ config: this.values.config, environment: this.ctx.environment, projectRoot: this.ctx.projectRoot, timeoutMs: this.timeoutMs })(d.connection!.toUpperCase()); this.sql.set(i, open); }
            try {
                const r = await (await open).query(f(d.query!));
                need();
                const first = r.rows[0] ? Object.values(r.rows[0])[0] : undefined;
                const v = typeof first === 'number' ? first : typeof first === 'bigint' ? Number(first) : typeof first === 'string' && first.trim() !== '' ? Number(first) : NaN;
                if (!Number.isFinite(v)) throw new Error('The query returned no number.');
                return v;
            } catch (e) { this.sql.delete(i); open.then((c) => c.close()).catch(() => undefined); throw e; }
        }
        const url = f(d.url.trim());
        const headers: Record<string, string> = { Accept: d.kind === 'prometheus' ? 'text/plain' : 'application/json' };
        for (const h of d.headers ?? []) if (h.key && h.enabled !== false) headers[h.key] = f(h.value);
        need();
        if (d.kind === 'jolokia') {
            const body = JSON.stringify({ type: 'read', mbean: d.mbean!.trim(), attribute: d.attribute!.trim(), ...(d.innerPath?.trim() ? { path: d.innerPath.trim() } : {}) });
            const res = await send({ method: 'POST', url, headers: { ...headers, 'Content-Type': 'application/json' }, body, missing: [] }, this.conn, this.timeoutMs);
            if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
            const j = res.json as { status?: number; value?: unknown; error?: string } | undefined;
            if (!j || (j.status && j.status !== 200)) throw new Error(j?.error ? String(j.error).split('\n')[0] : 'Not a Jolokia answer.');
            const v = jolokiaValue(j.value);
            if (v === null) throw new Error(`No number in ${d.mbean} ${d.attribute}`);
            return v;
        }
        const res = await send({ method: 'GET', url, headers, missing: [] }, this.conn, this.timeoutMs);
        if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
        let v: number | null;
        if (d.kind === 'prometheus') v = promValue(res.body, d.metric!);
        else { const x = readPath(res.json, d.path!); v = typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x)) ? Number(x) : null; }
        if (v === null) throw new Error(d.kind === 'prometheus' ? `No series ${d.metric}` : `No number at ${d.path}`);
        return v;
    }

    /** A monitor's level after a value: an alert when it changes (over the warning level, over the maximum, back). */
    private judge(d: MonitorDef, i: number, t: number, v: number, unit: string) {
        const now = d.max !== undefined && v > d.max ? 'critical' : d.warn !== undefined && v > d.warn ? 'warning' : 'ok';
        const was = this.level.get(i) ?? 'ok';
        if (now === was) return;
        this.level.set(i, now);
        const u = unit ? ` ${unit}` : '';
        const message = now === 'ok' ? `${d.name} is back to ${v}${u}` : `${d.name} is at ${v}${u}, over its ${now === 'critical' ? 'maximum' : 'warning level'} of ${now === 'critical' ? d.max : d.warn}${u}`;
        const a: LoadAlert = { t, level: now, source: `monitor:${d.name}`, message };
        this.alerts.push(a);
        this.ctx.onAlert?.(a);
    }

    /** Take one sample of everything (skipped while the previous one is still running). */
    async sample(t: number): Promise<void> {
        if (this.busy) return;
        this.busy = true;
        try {
            this.series[0].points.push({ t, v: this.cpu() });
            this.series[1].points.push({ t, v: Math.round((1000 * (os.totalmem() - os.freemem())) / os.totalmem()) / 10 });
            const lag = this.delay.take();
            if (lag !== null) this.series[2].points.push({ t, v: lag });
            await Promise.all(this.defs.map(async (d, i) => {
                const s = this.series[i + 3];
                try {
                    let v = await this.read(d, i);
                    if (v === null) return;
                    if (d.rate) {
                        const p = this.prev.get(i);
                        this.prev.set(i, { t, v });
                        if (!p || t <= p.t) return;
                        v = Math.max(0, (v - p.v) / (t - p.t)); // a counter reset gives 0, not a negative rate
                    }
                    const value = Math.round(v * (d.scale ?? 1) * 1000) / 1000;
                    s.points.push({ t, v: value });
                    delete s.error;
                    this.judge(d, i, t, value, s.unit);
                } catch (e) { s.error = (e as Error).message.split('\n')[0].slice(0, 200); }
            }));
        } finally { this.busy = false; }
    }

    /**
     * The load generator was the bottleneck: two samples in a row with this computer's CPU at 90% or more, or its
     * timers 100 ms or more late. Response times then include the generator's own delay, and the rate it reached
     * is what it could send, not what the system could take.
     */
    overload(): string | null {
        const run = (pts: Array<{ v: number }>, limit: number) => { let best = 0; for (let i = 1; i < pts.length; i++) if (pts[i].v >= limit && pts[i - 1].v >= limit) best = Math.max(best, pts[i].v, pts[i - 1].v); return best; };
        const cpu = run(this.series[0].points, Monitors.CPU_LIMIT), delay = run(this.series[2].points, Monitors.DELAY_LIMIT);
        if (!cpu && !delay) return null;
        const why = [cpu ? `CPU at ${cpu}%` : '', delay ? `its timers up to ${delay} ms late` : ''].filter(Boolean).join(', ');
        return `The load generator was overloaded (${why}): response times include its own delay. Run fewer users per computer, or split the test over more load generators.`;
    }

    /** Stop measuring (end of the run). */
    close() { this.delay.stop(); for (const c of this.sql.values()) c.then((x) => x.close()).catch(() => undefined); this.sql.clear(); }

    /** The series (the last `last` seconds while running). */
    snapshot(last?: number): MonitorSeries[] {
        return this.series.map((s) => ({ ...s, points: last === undefined ? s.points : s.points.filter((p) => p.t > (s.points.at(-1)?.t ?? 0) - last) }));
    }
}

/** Monitors with a maximum, as service-level results. */
export function monitorChecks(series: MonitorSeries[]): Array<{ sla: { target: string }; name: string; pass: boolean; details: string[] }> {
    return series.filter((s) => s.max !== undefined).map((s) => {
        if (!s.points.length) return { sla: { target: `monitor:${s.name}` }, name: `Monitor ${s.name}`, pass: false, details: [`no values were read${s.error ? ` (${s.error})` : ''}`] };
        const peak = Math.max(...s.points.map((p) => p.v));
        const pass = peak <= s.max!;
        return { sla: { target: `monitor:${s.name}` }, name: `Monitor ${s.name}`, pass, details: [`highest ${peak}${s.unit ? ` ${s.unit}` : ''} ${pass ? '≤' : '>'} ${s.max}${s.unit ? ` ${s.unit}` : ''}`] };
    });
}
