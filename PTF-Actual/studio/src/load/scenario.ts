/**
 * A load scenario: which requests a virtual user runs (a user path made of an API collection's
 * requests, each one a transaction), with what data, how fast, under which load policy, and the
 * service levels (SLAs) that decide pass or fail. Kept in the project as
 * test/<project>/load/<name>.load.json, next to the API collections it uses.
 */
import { LoadPolicy, validPolicy } from './policy';
import { MonitorDef, validMonitor } from './monitor';
import { ApmTagging, validApm } from './apm';
import { RegressionGate, validGate } from './analysis';
import { GeneratorDef, validGenerator } from './generators';
import { DataSource, validSource } from '../data/source';
import { labelOf, sameNameLabels } from './labels';
import type { PathLogic } from './logic';

export interface DataFile {
    /** CSV in the project (first line: column names, used as {{column}}). */
    file?: string;
    /** Any test data source (files, query, stored procedure, API, generated): see src/data/source.ts. */
    source?: DataSource;
    /**
     * sequential: each iteration takes the next row (from the start again at the end); random;
     * perUser: one row per virtual user; unique: each row once, the test ends when all are used.
     */
    mode: 'sequential' | 'random' | 'perUser' | 'unique';
}

/** Levels of a service level (ms, percent, requests per second). */
export interface SlaLevels {
    avg?: number; p90?: number; p95?: number; p99?: number;
    /** Percent. */
    errorRate?: number;
    /** At least this many requests per second. */
    throughput?: number;
}
export interface Sla extends SlaLevels {
    /** Applies to: '*' (every request together) or a request id. */
    target: string;
    /** Arrival-rate runs, every request together ('*'): at most this percent of the iterations that came due may be dropped (every user busy). */
    dropped?: number;
    /** Over these: a warning, the run still passes. */
    warn?: SlaLevels;
    /** Checked over the whole run (default), or over every interval of the run (each one must meet it). */
    per?: 'run' | 'interval';
}
export const SLA_KEYS = ['avg', 'p90', 'p95', 'p99', 'errorRate', 'throughput'] as const;

/** Reusable service levels (load/sla/<name>.sla.json), used by scenarios with slaProfile. */
export interface SlaProfile { format: 'cs-studio-sla/1'; name: string; description?: string; slas: Sla[]; interval?: number }

export function validSla(s: Sla): string | null {
    if (!s || typeof s.target !== 'string' || !s.target.trim()) return 'a service level needs what it applies to';
    const num = (v: unknown) => v === undefined || (typeof v === 'number' && Number.isFinite(v) && v >= 0);
    for (const k of [...SLA_KEYS, 'dropped'] as const) if (!num(s[k])) return `${s.target}: ${k} is a number`;
    if (s.warn !== undefined) {
        if (typeof s.warn !== 'object' || !s.warn) return `${s.target}: warning levels`;
        for (const k of SLA_KEYS) {
            if (!num(s.warn[k])) return `${s.target}: warning ${k} is a number`;
            const w = s.warn[k], f = s[k];
            if (w !== undefined && f !== undefined && (k === 'throughput' ? w < f : w > f)) return `${s.target}: the warning ${k} is beyond the failing one`;
        }
    }
    if (s.per !== undefined && s.per !== 'run' && s.per !== 'interval') return `${s.target}: per run or per interval`;
    return null;
}

export function validSlaProfile(x: unknown): SlaProfile {
    const p = x as SlaProfile;
    if (!p || p.format !== 'cs-studio-sla/1' || typeof p.name !== 'string' || !p.name.trim() || !Array.isArray(p.slas) || p.slas.length > 100) throw new Error('Not a service-level profile (cs-studio-sla/1 with a name and its service levels).');
    for (const s of p.slas) { const e = validSla(s); if (e) throw new Error(`Not a valid service-level profile: ${e}`); }
    if (p.interval !== undefined && !(Number.isInteger(p.interval) && p.interval >= 1 && p.interval <= 3600)) throw new Error('Not a valid service-level profile: interval (1–3600 s)');
    return p;
}

/**
 * Another user path in the same run (a population): its own collection requests or browser path,
 * and its share of the users (percent). The scenario's own path gets the rest.
 */
export interface Population {
    name: string;
    collection?: string;
    browserPath?: string;
    /** Request ids in order; empty: every request of the collection. */
    requests: string[];
    /** Percent of the users (1–99). */
    share: number;
    /** Logic of this path (Init / Actions / End) instead of the requests in order. */
    logic?: PathLogic;
    /** Its own load policy (its own users over time) instead of a share of the scenario's. */
    policy?: LoadPolicy;
    /** Seconds after the start before its users start; seconds after the start when they stop. */
    startDelay?: number;
    stopAfter?: number;
    /** Network of these users (WAN emulation): slower, farther, losing requests. */
    wan?: WanProfile;
}

/** A network to emulate for some users: added round-trip latency, a bandwidth limit, a share of lost requests. */
export interface WanProfile { latencyMs?: number; bandwidthKbps?: number; lossPercent?: number }

export interface LoadScenario {
    format: 'cs-studio-load/1';
    name: string;
    description?: string;
    /** API user path: an API collection file (test/<project>/api/….collection.json); '' with a browser path. */
    collection: string;
    /** Browser user path instead: a recorded path (test/<project>/load/….browser.json); each user is a browser. */
    browserPath?: string;
    /** Browser users: show the browsers (default: hidden). */
    showBrowsers?: boolean;
    /** Request ids in the order a user runs them; empty: every request of the collection, in order. */
    requests: string[];
    /** Name of the scenario's own user path when there are populations (default "Main"). */
    mainName?: string;
    /** More user paths in the same run, each with its share of the users. */
    populations?: Population[];
    data?: DataFile;
    /** Pause between requests (ms, random between min and max). */
    thinkTime: { min: number; max: number };
    /** Minimum length of one iteration (ms); 0: none. */
    pacing: number;
    policy: LoadPolicy;
    slas: Sla[];
    /** Load generators (computers running `cs-test-studio agent`): each runs its share of the users; none: this computer. */
    generators?: GeneratorDef[];
    /** How much worse than the scenario's baseline run a run may be (checked when a baseline is set). */
    regression?: RegressionGate;
    /** A reusable profile of service levels (load/sla/<name>.sla.json) checked besides the scenario's own. */
    slaProfile?: string;
    /** Seconds of a service-level interval (per-interval levels, live alerts); default 10. */
    slaInterval?: number;
    /** Stop the run early when the error rate goes above this (percent, over the last 10 seconds). */
    stopOnErrorRate?: number;
    /** Per-request timeout (ms). */
    timeout: number;
    /** Servers to watch during the run (the load generator itself is always watched). */
    monitors?: MonitorDef[];
    /** Seconds between monitor samples (default 5). */
    monitorEvery?: number;
    /** Alerts while running (monitors over their warning level / maximum): sent to a webhook (Teams, Slack); a critical one can stop the run. */
    alerting?: { webhook?: string; stopOnCritical?: boolean };
    /** Requests tagged for APM tools (W3C traceparent, Dynatrace's test header, a header of your own). */
    apm?: ApmTagging;
    /** Logic of the scenario's own path (Init / Actions / End: transactions, loops, conditions, rendezvous…) instead of the requests in order. */
    logic?: PathLogic;
    /** Each user runs this many iterations, then stops; the run ends when all have (instead of a duration). */
    iterationsPerUser?: number;
    /** Network of the scenario's own users (WAN emulation). */
    wan?: WanProfile;
}

export function newScenario(name: string, collection: string): LoadScenario {
    return {
        format: 'cs-studio-load/1', name, collection, requests: [],
        thinkTime: { min: 1000, max: 3000 }, pacing: 0,
        policy: { type: 'ramp', users: 10, duration: 300, rampUp: 60, rampDown: 30 },
        slas: [{ target: '*', p95: 1000, errorRate: 1 }], timeout: 30_000,
    };
}

export function validScenario(x: unknown): LoadScenario {
    const fail = (m: string): never => { throw new Error(`Not a valid load scenario: ${m}`); };
    const s = x as LoadScenario;
    if (!s || typeof s !== 'object' || s.format !== 'cs-studio-load/1') fail('unknown format');
    if (typeof s.name !== 'string' || !s.name.trim() || s.name.length > 200) fail('name');
    if (s.browserPath !== undefined) {
        if (typeof s.browserPath !== 'string' || !/^test\/[A-Za-z0-9][\w.-]*\/load\/[\w.-]+\.browser\.json$/.test(s.browserPath)) fail('browser path');
    } else if (typeof s.collection !== 'string' || !/^test\/[A-Za-z0-9][\w.-]*\/api\/[\w.-]+\.collection\.json$/.test(s.collection)) fail('collection');
    if (!Array.isArray(s.requests) || s.requests.some((r) => typeof r !== 'string')) fail('requests');
    if (!s.thinkTime || !(s.thinkTime.min >= 0) || !(s.thinkTime.max >= s.thinkTime.min) || s.thinkTime.max > 600_000) fail('think time');
    if (!Number.isInteger(s.thinkTime.min) || !Number.isInteger(s.thinkTime.max)) fail('think time (whole milliseconds)');
    if (!(s.pacing >= 0) || s.pacing > 3_600_000 || !Number.isInteger(s.pacing)) fail('pacing (a whole number of ms, 0 to 3600000)');
    if (!(s.timeout >= 100) || s.timeout > 600_000 || !Number.isInteger(s.timeout)) fail('timeout (a whole number of ms, 100 to 600000)');
    const p = validPolicy(s.policy ?? ({} as LoadPolicy));
    if (p) fail(p);
    if (!Array.isArray(s.slas)) fail('slas');
    for (const x of s.slas) { const e = validSla(x); if (e) fail(e); }
    if (s.slaProfile !== undefined && (typeof s.slaProfile !== 'string' || !/^[\w./ -]+\.sla\.json$/.test(s.slaProfile) || s.slaProfile.includes('..'))) fail('the service-level profile (a .sla.json file of the project)');
    if (s.slaInterval !== undefined && !(Number.isInteger(s.slaInterval) && s.slaInterval >= 1 && s.slaInterval <= 3600)) fail('service-level interval (1–3600 s)');
    if (s.iterationsPerUser !== undefined && !(Number.isInteger(s.iterationsPerUser) && s.iterationsPerUser >= 1 && s.iterationsPerUser <= 1_000_000)) fail('iterations per user (1–1000000)');
    for (const w of [s.wan, ...(s.populations ?? []).map((p) => p.wan)]) if (w !== undefined && (typeof w !== 'object' || [w.latencyMs, w.bandwidthKbps, w.lossPercent].some((x) => x !== undefined && !(Number(x) >= 0)) || (w.lossPercent ?? 0) > 100 || [w.latencyMs, w.bandwidthKbps].some((x) => x !== undefined && !Number.isInteger(x)))) fail('network emulation (latency and bandwidth are whole numbers)');
    for (const p of s.populations ?? []) {
        if (p.startDelay !== undefined && !(Number.isInteger(p.startDelay) && p.startDelay >= 0)) fail(`start of ${p.name} (whole seconds)`);
        if (p.stopAfter !== undefined && !(Number.isInteger(p.stopAfter) && p.stopAfter >= 1)) fail(`stop of ${p.name} (whole seconds)`);
    }
    if (s.stopOnErrorRate !== undefined && !(Number.isInteger(s.stopOnErrorRate) && s.stopOnErrorRate >= 1 && s.stopOnErrorRate <= 100)) fail('stop on error rate (a whole percent, 1–100)');
    for (const p of s.populations ?? []) if (p.policy !== undefined) { const e = validPolicy(p.policy); if (e) fail(`policy of ${p.name}: ${e}`); }
    if (s.logic !== undefined && (!s.logic || typeof s.logic !== 'object' || !Array.isArray(s.logic.actions))) fail('logic (Init / Actions / End)');
    if (s.monitors !== undefined) {
        if (!Array.isArray(s.monitors) || s.monitors.length > 20) fail('monitors (at most 20)');
        for (const m of s.monitors) { const e = validMonitor(m); if (e) fail(`monitor ${e}`); }
        if (new Set(s.monitors.map((m) => m.name.trim())).size !== s.monitors.length) fail('two monitors have the same name');
    }
    if (s.alerting !== undefined) {
        if (typeof s.alerting !== 'object' || !s.alerting) fail('alerting');
        if (s.alerting.webhook !== undefined && (typeof s.alerting.webhook !== 'string' || !/^(https?:\/\/|\{config:|\{env:)/i.test(s.alerting.webhook.trim()))) fail('the alert webhook (http(s)://, {config:KEY} or {env:NAME})');
    }
    if (s.generators !== undefined) {
        if (!Array.isArray(s.generators) || s.generators.length > 50) fail('load generators (at most 50)');
        for (const g of s.generators) { const e = validGenerator(g); if (e) fail(e); }
        if (new Set(s.generators.map((g) => g.name)).size !== s.generators.length) fail('two load generators have the same name');
    }
    if (s.regression !== undefined) { const e = typeof s.regression === 'object' && s.regression ? validGate(s.regression) : 'the regression gate'; if (e) fail(e); }
    if (s.apm !== undefined) { const e = typeof s.apm === 'object' && s.apm ? validApm(s.apm) : 'APM tagging'; if (e) fail(e); }
    if (s.monitorEvery !== undefined && !(Number.isInteger(s.monitorEvery) && s.monitorEvery >= 1 && s.monitorEvery <= 300)) fail('monitor interval (1–300 s)');
    if (s.populations !== undefined) {
        if (!Array.isArray(s.populations) || s.populations.length > 10) fail('populations (at most 10)');
        const names = new Set<string>([s.mainName?.trim() || 'Main']);
        for (const p of s.populations) {
            if (!p || typeof p.name !== 'string' || !p.name.trim() || p.name.length > 80) fail('population name');
            if (names.has(p.name.trim())) fail(`two user paths are named "${p.name}"`);
            names.add(p.name.trim());
            if (!Number.isInteger(p.share) || p.share < 1 || p.share > 99) fail(`share of ${p.name} (1–99 percent)`);
            if (p.browserPath !== undefined) { if (typeof p.browserPath !== 'string' || !/^test\/[A-Za-z0-9][\w.-]*\/load\/[\w.-]+\.browser\.json$/.test(p.browserPath)) fail(`browser path of ${p.name}`); }
            else if (typeof p.collection !== 'string' || !/^test\/[A-Za-z0-9][\w.-]*\/api\/[\w.-]+\.collection\.json$/.test(p.collection)) fail(`collection of ${p.name}`);
            if (!Array.isArray(p.requests) || p.requests.some((r) => typeof r !== 'string')) fail(`requests of ${p.name}`);
        }
        if (s.populations.reduce((n, p) => n + p.share, 0) >= 100) fail('the populations\' shares must leave some users for the main path (total under 100%)');
    }
    if (s.data) {
        if (!['sequential', 'random', 'perUser', 'unique'].includes(s.data.mode)) fail('how data rows are used');
        if (s.data.source !== undefined) { try { validSource(s.data.source); } catch (e) { fail((e as Error).message.replace(/^Test data: |\.$/g, '')); } }
        else if (typeof s.data.file !== 'string' || !/^[\w./ -]+\.csv$/i.test(s.data.file) || s.data.file.includes('..')) fail('data file (a .csv in the project)');
    }
    return s;
}

/** Read a CSV (header row, commas, double-quoted fields with "" escapes). */
export function parseCsv(text: string): { columns: string[]; rows: Array<Record<string, string>> } {
    const records: string[][] = [];
    let row: string[] = [], field = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
            if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
            else if (c === '"') quoted = false;
            else field += c;
        } else if (c === '"' && field === '') quoted = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i++;
            row.push(field); field = '';
            if (row.some((x) => x !== '')) records.push(row);
            row = [];
        } else field += c;
    }
    row.push(field);
    if (row.some((x) => x !== '')) records.push(row);
    const [head, ...body] = records;
    const columns = (head ?? []).map((h) => h.trim().replace(/^﻿/, ''));
    return { columns, rows: body.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i] ?? '']))) };
}

/** The users of each user path at a given total (largest remainder, so they add up). */
export function splitUsers(total: number, shares: number[]): number[] {
    const sum = shares.reduce((a, b) => a + b, 0) || 1;
    const exact = shares.map((s) => (total * s) / sum);
    const out = exact.map(Math.floor);
    let left = total - out.reduce((a, b) => a + b, 0);
    for (const i of exact.map((e, i) => [e - Math.floor(e), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]).map(([, i]) => i)) { if (left-- <= 0) break; out[i]++; }
    return out;
}

export interface SlaResult { sla: Sla; name: string; pass: boolean; details: string[]; /** pass, warning (over a warning level), fail. */ level?: 'pass' | 'warning' | 'fail'; /** Per interval: the intervals over the levels. */ intervals?: Array<{ t0: number; t1: number; level: 'warning' | 'fail'; details: string[] }> }

type Measured = { count?: number; errorRate: number; avg: number; p95: number; p90?: number; p99?: number; throughput?: number };
const LABEL: Record<(typeof SLA_KEYS)[number], string> = { avg: 'average', p90: 'p90', p95: 'p95', p99: 'p99', errorRate: 'errors', throughput: 'throughput' };
const unit = (k: (typeof SLA_KEYS)[number]) => (k === 'errorRate' ? '%' : k === 'throughput' ? '/s' : ' ms');
const shownV = (k: (typeof SLA_KEYS)[number], v: number) => (k === 'errorRate' ? v.toFixed(2) : k === 'throughput' ? v.toFixed(1) : String(v));

/** One measure against the levels: the level reached and what was compared. */
function judge(s: Sla, m: Measured): { level: 'pass' | 'warning' | 'fail'; details: string[] } {
    let level: 'pass' | 'warning' | 'fail' = 'pass';
    const details: string[] = [];
    for (const k of SLA_KEYS) {
        const fail = s[k], warn = s.warn?.[k];
        if (fail === undefined && warn === undefined) continue;
        const v = m[k];
        if (v === undefined) { level = 'fail'; details.push(`${LABEL[k]}: not measured`); continue; }
        const over = (limit: number) => (k === 'throughput' ? v < limit : v > limit);
        const ge = k === 'throughput' ? '≥' : '≤', lt = k === 'throughput' ? '<' : '>';
        if (fail !== undefined && over(fail)) { level = 'fail'; details.push(`${LABEL[k]} ${shownV(k, v)}${unit(k)} ${lt} ${fail}${unit(k)}`); }
        else if (warn !== undefined && over(warn)) { if (level === 'pass') level = 'warning'; details.push(`${LABEL[k]} ${shownV(k, v)}${unit(k)} ${lt} ${warn}${unit(k)} (warning)`); }
        else details.push(`${LABEL[k]} ${shownV(k, v)}${unit(k)} ${ge} ${fail ?? warn}${unit(k)}`);
    }
    return { level, details };
}

/** Check the service levels against the results (whole run; per interval when asked, with the intervals). */
export function checkSlas(slas: Sla[], tx: Array<{ id: string; name: string } & Measured>, total: Measured, run: { due?: number; dropped?: number; intervals?: Array<{ t0: number; t1: number; total: Measured; tx: Record<string, Measured> }> } = {}): SlaResult[] {
    // A target named like another request: numbered as everywhere else ("New request (2)").
    const labels = sameNameLabels(tx);
    return slas.map((s) => {
        const found = s.target === '*' ? undefined : tx.find((x) => x.id === s.target);
        const t = s.target === '*' ? { name: 'All requests', ...total } : found && { ...found, name: labelOf(labels, found) };
        if (!t) return { sla: s, name: s.target, pass: false, level: 'fail' as const, details: ['No requests of this kind ran.'] };
        let level: 'pass' | 'warning' | 'fail';
        let details: string[];
        let intervals: SlaResult['intervals'];
        if (s.per === 'interval') {
            const list = (run.intervals ?? []).map((i) => ({ i, m: s.target === '*' ? i.total : i.tx[s.target] })).filter((x) => x.m && (x.m.count ?? 1) > 0);
            intervals = [];
            for (const { i, m } of list) { const j = judge(s, m!); if (j.level !== 'pass') intervals.push({ t0: i.t0, t1: i.t1, level: j.level, details: j.details.filter((d) => /[<>]/.test(d)) }); }
            const fails = intervals.filter((x) => x.level === 'fail').length, warns = intervals.length - fails;
            level = !list.length ? 'fail' : fails ? 'fail' : warns ? 'warning' : 'pass';
            details = !list.length ? ['No interval had requests of this kind.'] : [`${list.length - intervals.length} of ${list.length} intervals met it${fails ? `; ${fails} failed` : ''}${warns ? `; ${warns} only warned` : ''}`,
                ...intervals.slice(0, 5).map((x) => `${x.t0}–${x.t1} s: ${x.details.join(', ')}`)];
        } else ({ level, details } = judge(s, t));
        if (s.dropped !== undefined) {
            if (run.due === undefined) { level = 'fail'; details.push('dropped iterations: only an arrival-rate run has them'); }
            else {
                const rate = run.due ? (100 * (run.dropped ?? 0)) / run.due : 0;
                const ok = rate <= s.dropped;
                if (!ok) level = 'fail';
                details.push(`dropped ${run.dropped ?? 0} of ${run.due} iterations (${rate.toFixed(2)}%) ${ok ? '≤' : '>'} ${s.dropped}%`);
            }
        }
        return { sla: s, name: t.name, pass: level !== 'fail', level, details, ...(intervals?.length ? { intervals } : {}) };
    });
}

/** The service levels of one interval, for alerts while running (levels checked per interval only). */
export function intervalBreaches(slas: Sla[], i: { t0: number; t1: number; total: Measured; tx: Record<string, Measured> }, names: (id: string) => string): Array<{ sla: Sla; level: 'warning' | 'fail'; message: string }> {
    const out: Array<{ sla: Sla; level: 'warning' | 'fail'; message: string }> = [];
    for (const s of slas) {
        if (s.per !== 'interval') continue;
        const m = s.target === '*' ? i.total : i.tx[s.target];
        if (!m || !(m.count ?? 1)) continue;
        const j = judge(s, m);
        if (j.level !== 'pass') out.push({ sla: s, level: j.level, message: `${s.target === '*' ? 'All requests' : names(s.target)} at ${i.t0}–${i.t1} s: ${j.details.filter((d) => /[<>]/.test(d)).join(', ')}` });
    }
    return out;
}
