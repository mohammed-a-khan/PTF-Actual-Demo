/**
 * cs_qa_env_health — HTTP ping health checks across environments (SIT, UAT,
 * prod). Auto-discovers URLs from workspace `.env` files under
 * `config/<env>/environments/*.env` (matches the framework layout the
 * consumer projects use).
 *
 * Classification:
 *   healthy   → 2xx or configured expectedStatus, latency below 2× baseline
 *   degraded  → 3xx, or 2xx with latency ≥ 2× baseline, or partial retry recovery
 *   down      → 4xx (except configured expectedStatus), 5xx, connect error, timeout
 *
 * On-prem safe — uses NODE's global fetch, no ADO auth against target URLs.
 * ADO writes (bug creation) still route through AdoHttpClient with proper
 * retry/redaction.
 */
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import { AdoHttpClient, type AdoCreds } from './_helpers/ado_http_client';
import { createLogger } from './_helpers/structured_logger';
import { getResolvedCreds } from './ado_config_tool';

const EndpointSchema = z.object({
    name: z.string().min(1),
    environment: z.string().min(1),
    url: z.string().url().optional(),
    expectedStatus: z.number().int().min(100).max(599).optional(),
    timeoutMs: z.number().int().positive().optional(),
    authHeaders: z.record(z.string(), z.string()).optional(),
    kind: z.enum(['http', 'db', 'queue', 'dependency']).default('http').describe('http = default (existing behavior). db = probe DB reachability via SELECT 1 (needs connectionAlias). queue = publish + verify a health-marker message on an AMQP broker (needs brokerUrl + queueName; lazy-loads amqplib). dependency = verify a local dependency present (needs checkKind:"npm|binary|file|env-var" + target).'),
    connectionAlias: z.string().min(1).optional().describe('kind=db — the CSDBUtils alias name (matches cs_qa_db_select alias).'),
    brokerUrl: z.string().min(1).optional().describe('kind=queue — AMQP URL (amqp://host:5672).'),
    queueName: z.string().min(1).optional().describe('kind=queue — queue to publish + verify the health marker on.'),
    checkKind: z.enum(['npm', 'binary', 'file', 'env-var']).optional().describe('kind=dependency — the probe subtype.'),
    target: z.string().min(1).optional().describe('kind=dependency — the target (npm package name, binary name, absolute file path, or env-var name).'),
});

type Endpoint = z.infer<typeof EndpointSchema>;

interface HealthResult {
    name: string;
    environment: string;
    url: string;
    kind?: 'http' | 'db' | 'queue' | 'dependency';
    status: 'healthy' | 'degraded' | 'down';
    latencyMs: number | null;
    httpStatus: number | null;
    redirectChain: string[];
    error?: string;
    attempts: number;
}

function discoverFromWorkspace(workspaceRoot: string, envFilter?: string[]): Endpoint[] {
    const out: Endpoint[] = [];
    const configDir = path.join(workspaceRoot, 'config');
    if (!fs.existsSync(configDir)) return out;
    const projects = safeReaddir(configDir);
    for (const proj of projects) {
        const envDir = path.join(configDir, proj, 'environments');
        if (!fs.existsSync(envDir)) continue;
        const envFiles = safeReaddir(envDir).filter((f) => f.endsWith('.env'));
        for (const envFile of envFiles) {
            const envName = envFile.replace(/\.env$/i, '').toLowerCase();
            if (envFilter && envFilter.length > 0 && !envFilter.map((s) => s.toLowerCase()).includes(envName)) continue;
            const filePath = path.join(envDir, envFile);
            let text = '';
            try { text = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }
            const kv = parseEnvFile(text);
            const seenUrls = new Set<string>();
            for (const key of ['BASE_URL', 'API_BASE_URL', 'LOGIN_URL', 'APP_URL']) {
                const val = kv[key];
                if (!val || !/^https?:\/\//i.test(val)) continue;
                if (seenUrls.has(val)) continue;
                seenUrls.add(val);
                out.push({
                    name: `${proj} ${key.toLowerCase().replace(/_/g, ' ')} (${envName})`,
                    environment: envName,
                    url: val,
                    expectedStatus: 200,
                    kind: 'http',
                });
            }
        }
    }
    return out;
}

function safeReaddir(dir: string): string[] {
    try { return fs.readdirSync(dir); } catch { return []; }
}

function parseEnvFile(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        let val = line.slice(eq + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        out[key] = val;
    }
    return out;
}

async function ping(ep: Endpoint, retries: number, baselineLatencyMs: number | undefined, workspaceRoot?: string): Promise<HealthResult> {
    // Dispatch by kind — db/queue/dependency probes have their own paths.
    if (ep.kind === 'db') return probeDb(ep, workspaceRoot);
    if (ep.kind === 'queue') return probeQueue(ep);
    if (ep.kind === 'dependency') return probeDependency(ep, workspaceRoot);

    // Default: HTTP probe (existing behavior).
    if (!ep.url) {
        return { name: ep.name, environment: ep.environment, url: '', status: 'down', latencyMs: null, httpStatus: null, redirectChain: [], error: 'kind=http requires url', attempts: 0 };
    }
    const timeoutMs = ep.timeoutMs ?? 15000;
    const expectedStatus = ep.expectedStatus ?? 200;
    const redirectChain: string[] = [];
    let lastError: string | undefined;
    let lastStatus: number | null = null;
    let lastLatency: number | null = null;
    let attempts = 0;
    for (let i = 0; i <= retries; i++) {
        attempts++;
        const started = Date.now();
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            let res: Response;
            try {
                res = await fetch(ep.url, { method: 'GET', headers: ep.authHeaders, signal: controller.signal, redirect: 'manual' });
            } finally { clearTimeout(timer); }
            lastLatency = Date.now() - started;
            lastStatus = res.status;
            // If manual redirect, chase up to 5 hops.
            let hops = 0;
            let current = res;
            while ([301, 302, 303, 307, 308].includes(current.status) && hops < 5) {
                const loc = current.headers.get('location');
                if (!loc) break;
                redirectChain.push(loc);
                hops++;
                const nextCtrl = new AbortController();
                const nextTimer = setTimeout(() => nextCtrl.abort(), timeoutMs);
                try {
                    current = await fetch(loc, { method: 'GET', headers: ep.authHeaders, signal: nextCtrl.signal, redirect: 'manual' });
                    lastStatus = current.status;
                } finally { clearTimeout(nextTimer); }
            }
            break; // one attempt completed
        } catch (e) {
            lastError = (e as Error).message;
            lastLatency = Date.now() - started;
            if (i < retries) continue;
        }
    }
    let classification: HealthResult['status'] = 'healthy';
    if (lastStatus === null) classification = 'down';
    else if (lastStatus === expectedStatus || (lastStatus >= 200 && lastStatus < 300)) classification = 'healthy';
    else if (lastStatus >= 300 && lastStatus < 400) classification = 'degraded';
    else classification = 'down';
    if (classification === 'healthy' && baselineLatencyMs && lastLatency !== null && lastLatency >= baselineLatencyMs * 2) {
        classification = 'degraded';
    }
    return {
        name: ep.name,
        environment: ep.environment,
        url: ep.url!,
        status: classification,
        latencyMs: lastLatency,
        httpStatus: lastStatus,
        redirectChain,
        error: lastError,
        attempts,
    };
}

async function probeDb(ep: Endpoint, workspaceRoot?: string): Promise<HealthResult> {
    const started = Date.now();
    if (!ep.connectionAlias) {
        return { name: ep.name, environment: ep.environment, url: ep.connectionAlias || '(db)', status: 'down', latencyMs: null, httpStatus: null, redirectChain: [], error: 'db kind requires connectionAlias', attempts: 1 };
    }
    // Lazy-load CSDBUtils from the workspace's node_modules — same pattern as db_select_tool.
    try {
        if (!workspaceRoot) throw new Error('workspaceRoot required to resolve CSDBUtils');
        const p = require('path');
        const csdbPath = p.resolve(workspaceRoot, 'node_modules/@mdakhan.mak/cs-playwright-test-framework/dist/database-utils/CSDBUtils.js');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { CSDBUtils } = require(csdbPath) as { CSDBUtils: { executeQuery(alias: string, sql: string, params?: unknown[]): Promise<{ rows?: unknown[] }> } };
        await CSDBUtils.executeQuery(ep.connectionAlias, 'SELECT 1', []);
        const latency = Date.now() - started;
        return { name: ep.name, environment: ep.environment, url: `db:${ep.connectionAlias}`, status: 'healthy', latencyMs: latency, httpStatus: null, redirectChain: [], attempts: 1 };
    } catch (e) {
        return { name: ep.name, environment: ep.environment, url: `db:${ep.connectionAlias}`, status: 'down', latencyMs: Date.now() - started, httpStatus: null, redirectChain: [], error: (e as Error).message, attempts: 1 };
    }
}

async function probeQueue(ep: Endpoint): Promise<HealthResult> {
    const started = Date.now();
    if (!ep.brokerUrl || !ep.queueName) {
        return { name: ep.name, environment: ep.environment, url: ep.brokerUrl || '(queue)', status: 'down', latencyMs: null, httpStatus: null, redirectChain: [], error: 'queue kind requires brokerUrl + queueName', attempts: 1 };
    }
    // Lazy require amqplib — warn (not fail hard) when missing.
    let amqp: { connect: (url: string) => Promise<{ createChannel(): Promise<{ assertQueue(q: string, opts?: unknown): Promise<unknown>; sendToQueue(q: string, buf: Buffer): boolean; get(q: string, opts?: unknown): Promise<unknown>; close(): Promise<void> }>; close(): Promise<void> }> };
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        amqp = require('amqplib');
    } catch (e) {
        return { name: ep.name, environment: ep.environment, url: `queue:${ep.brokerUrl}/${ep.queueName}`, status: 'degraded', latencyMs: null, httpStatus: null, redirectChain: [], error: `amqplib not installed — install to enable queue probes: ${(e as Error).message}`, attempts: 1 };
    }
    let conn: { createChannel(): Promise<{ assertQueue(q: string, opts?: unknown): Promise<unknown>; sendToQueue(q: string, buf: Buffer): boolean; get(q: string, opts?: unknown): Promise<unknown>; close(): Promise<void> }>; close(): Promise<void> } | null = null;
    try {
        conn = await amqp.connect(ep.brokerUrl);
        const ch = await conn.createChannel();
        const q = `${ep.queueName}.health-${Date.now()}`;
        await ch.assertQueue(q, { autoDelete: true, durable: false });
        const marker = Buffer.from(JSON.stringify({ ts: Date.now(), source: 'cs_qa_env_health' }));
        ch.sendToQueue(q, marker);
        const got = await ch.get(q, { noAck: true });
        await ch.close();
        await conn.close();
        const ok = got !== false && got !== null && got !== undefined;
        return { name: ep.name, environment: ep.environment, url: `queue:${ep.queueName}`, status: ok ? 'healthy' : 'degraded', latencyMs: Date.now() - started, httpStatus: null, redirectChain: [], error: ok ? undefined : 'sent but did not read back within window', attempts: 1 };
    } catch (e) {
        try { if (conn) await conn.close(); } catch { /* ignore */ }
        return { name: ep.name, environment: ep.environment, url: `queue:${ep.queueName}`, status: 'down', latencyMs: Date.now() - started, httpStatus: null, redirectChain: [], error: (e as Error).message, attempts: 1 };
    }
}

async function probeDependency(ep: Endpoint, workspaceRoot?: string): Promise<HealthResult> {
    const started = Date.now();
    if (!ep.checkKind || !ep.target) {
        return { name: ep.name, environment: ep.environment, url: ep.target || '(dep)', status: 'down', latencyMs: null, httpStatus: null, redirectChain: [], error: 'dependency kind requires checkKind + target', attempts: 1 };
    }
    if (ep.checkKind === 'env-var') {
        const has = process.env[ep.target] !== undefined && process.env[ep.target] !== '';
        return { name: ep.name, environment: ep.environment, url: `env:${ep.target}`, status: has ? 'healthy' : 'down', latencyMs: Date.now() - started, httpStatus: null, redirectChain: [], error: has ? undefined : `env-var ${ep.target} not set`, attempts: 1 };
    }
    if (ep.checkKind === 'file') {
        const fsMod = require('fs') as typeof import('fs');
        const absTarget = require('path').isAbsolute(ep.target)
            ? ep.target
            : require('path').join(workspaceRoot || process.cwd(), ep.target);
        const exists = fsMod.existsSync(absTarget);
        return { name: ep.name, environment: ep.environment, url: `file:${absTarget}`, status: exists ? 'healthy' : 'down', latencyMs: Date.now() - started, httpStatus: null, redirectChain: [], error: exists ? undefined : `file not found: ${absTarget}`, attempts: 1 };
    }
    if (ep.checkKind === 'npm') {
        const p = require('path') as typeof import('path');
        const fsMod = require('fs') as typeof import('fs');
        const modPath = p.join(workspaceRoot || process.cwd(), 'node_modules', ep.target, 'package.json');
        const has = fsMod.existsSync(modPath);
        return { name: ep.name, environment: ep.environment, url: `npm:${ep.target}`, status: has ? 'healthy' : 'down', latencyMs: Date.now() - started, httpStatus: null, redirectChain: [], error: has ? undefined : `npm package not installed: ${ep.target}`, attempts: 1 };
    }
    if (ep.checkKind === 'binary') {
        // Look on PATH — cross-platform via `which` on posix, `where` on win32.
        const { spawnSync } = require('child_process') as typeof import('child_process');
        const cmd = process.platform === 'win32' ? 'where' : 'which';
        const r = spawnSync(cmd, [ep.target], { encoding: 'utf-8' });
        const has = r.status === 0 && (r.stdout || '').trim().length > 0;
        return { name: ep.name, environment: ep.environment, url: `bin:${ep.target}`, status: has ? 'healthy' : 'down', latencyMs: Date.now() - started, httpStatus: null, redirectChain: [], error: has ? undefined : `binary not on PATH: ${ep.target}`, attempts: 1 };
    }
    return { name: ep.name, environment: ep.environment, url: '(dep)', status: 'down', latencyMs: null, httpStatus: null, redirectChain: [], error: `unknown checkKind: ${ep.checkKind}`, attempts: 1 };
}

registerPrimitive({
    name: 'cs_qa_env_health',
    description: 'HTTP ping health checks across environments (SIT/UAT/prod). Auto-discovers URLs from workspace .env files (BASE_URL/API_BASE_URL/LOGIN_URL/APP_URL) or accepts explicit endpoint list. Detects downtime, redirects, and latency spikes. Optionally opens ADO bugs on down endpoints (Sev1 for prod, Sev3 for lower envs). Bug creation is gated by two-phase confirmation (call once without `confirmed`, get preview, retry with `confirmed:true`).',
    inputSchema: z.object({
        endpoints: z.array(EndpointSchema).optional(),
        environments: z.array(z.string()).optional(),
        parallel: z.boolean().default(true),
        retries: z.number().int().min(0).max(5).default(2),
        baselineLatencyMs: z.number().positive().optional(),
        createBugOnFailure: z.boolean().default(false),
        orgUrl: z.string().url().optional(),
        project: z.string().min(1).optional(),
        pat: z.string().min(1).optional(),
    }),
    outputSchema: z.object({
        ok: z.boolean(),
        timestamp: z.string(),
        results: z.array(z.object({
            name: z.string(),
            environment: z.string(),
            url: z.string(),
            status: z.enum(['healthy', 'degraded', 'down']),
            latencyMs: z.number().nullable(),
            httpStatus: z.number().nullable(),
            redirectChain: z.array(z.string()),
            error: z.string().optional(),
            attempts: z.number(),
        })).default([]),
        bugsCreated: z.array(z.number()).default([]),
        warnings: z.array(z.string()).default([]),
        note: z.string().optional(),
        requiresConfirmation: z.boolean().optional(),
        destructive: z.boolean().optional(),
        confirmationHint: z.string().optional(),
    }),
    run: async (ctx, input) => {
        const log = createLogger(ctx.invocationId, 'cs_qa_env_health', { workspaceRoot: ctx.workspaceRoot });
        const warnings: string[] = [];
        let endpoints: Endpoint[] = input.endpoints || [];
        if (endpoints.length === 0) {
            endpoints = discoverFromWorkspace(ctx.workspaceRoot, input.environments);
            if (endpoints.length === 0) {
                return { ok: false, timestamp: new Date().toISOString(), results: [], bugsCreated: [], warnings, note: 'No endpoints supplied and none discoverable from workspace config/<project>/environments/*.env. Pass endpoints:[...] explicitly.' };
            }
        } else if (input.environments && input.environments.length > 0) {
            const filter = new Set(input.environments.map((s) => s.toLowerCase()));
            endpoints = endpoints.filter((e) => filter.has(e.environment.toLowerCase()));
        }

        const results: HealthResult[] = [];
        if (input.parallel) {
            const settled = await Promise.allSettled(endpoints.map((ep) => ping(ep, input.retries, input.baselineLatencyMs, ctx.workspaceRoot)));
            for (let i = 0; i < settled.length; i++) {
                const s = settled[i];
                if (s.status === 'fulfilled') results.push(s.value);
                else results.push({
                    name: endpoints[i].name, environment: endpoints[i].environment, url: endpoints[i].url || '',
                    status: 'down', latencyMs: null, httpStatus: null, redirectChain: [],
                    error: (s.reason as Error).message, attempts: 1,
                });
            }
        } else {
            for (const ep of endpoints) {
                try { results.push(await ping(ep, input.retries, input.baselineLatencyMs, ctx.workspaceRoot)); }
                catch (e) {
                    results.push({ name: ep.name, environment: ep.environment, url: ep.url || '', status: 'down', latencyMs: null, httpStatus: null, redirectChain: [], error: (e as Error).message, attempts: 1 });
                }
            }
        }

        log.info('env health scan complete', { total: results.length, down: results.filter((r) => r.status === 'down').length });

        const bugsCreated: number[] = [];
        if (input.createBugOnFailure && results.some((r) => r.status === 'down')) {
            const credsRes = getResolvedCreds(ctx.workspaceRoot, {
                orgUrl: input.orgUrl, project: input.project, personalAccessToken: input.pat,
            });
            if (!credsRes.creds) warnings.push(credsRes.diagnostic);
            else {
                const cfg: AdoCreds = credsRes.creds;
                const client = new AdoHttpClient(cfg);
                if ((input as { confirmed?: boolean }).confirmed !== true) {
                    return {
                        ok: true,
                        timestamp: new Date().toISOString(),
                        results,
                        bugsCreated,
                        warnings,
                        requiresConfirmation: true,
                        destructive: true,
                        confirmationHint: `Open ${results.filter((r) => r.status === 'down').length} ADO bug(s) for down endpoints in project ${cfg.project}? No write performed. Retry the SAME call with confirmed:true (added at the top level).`,
                        note: 'requires confirmation — retry with confirmed:true',
                    } as never;
                }
                for (const r of results.filter((x) => x.status === 'down')) {
                    const isProd = /^prod/i.test(r.environment);
                    const sev = isProd ? '1 - Critical' : '3 - Medium';
                    const pri = isProd ? 1 : 3;
                    const patch: Array<Record<string, unknown>> = [
                        { op: 'add', path: '/fields/System.Title', value: `Env down: ${r.name} — ${r.httpStatus ?? 'no response'}` },
                        { op: 'add', path: '/fields/Microsoft.VSTS.TCM.ReproSteps', value: `<pre>URL: ${escapeHtml(r.url)}\nEnvironment: ${escapeHtml(r.environment)}\nHTTP status: ${r.httpStatus ?? 'no response'}\nLatency: ${r.latencyMs ?? 'n/a'} ms\nError: ${escapeHtml(r.error || '(none)')}\nAttempts: ${r.attempts}</pre>` },
                        { op: 'add', path: '/fields/Microsoft.VSTS.Common.Severity', value: sev },
                        { op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: pri },
                        { op: 'add', path: '/fields/System.Tags', value: `env-health; ${r.environment}` },
                    ];
                    try {
                        const created = await client.post<{ id?: number }>(`_apis/wit/workitems/$Bug?api-version=7.0`, patch);
                        if (created.id) bugsCreated.push(Number(created.id));
                    } catch (e) {
                        warnings.push(`Bug creation failed for ${r.name}: ${(e as Error).message}`);
                    }
                }
            }
        }

        const downCount = results.filter((r) => r.status === 'down').length;
        return {
            ok: true,
            timestamp: new Date().toISOString(),
            results,
            bugsCreated,
            warnings,
            note: `${results.length} endpoints scanned; ${results.filter((r) => r.status === 'healthy').length} healthy, ${results.filter((r) => r.status === 'degraded').length} degraded, ${downCount} down${bugsCreated.length > 0 ? `. Bugs opened: ${bugsCreated.join(', ')}` : ''}.`,
        };
    },
});

function escapeHtml(s: string): string {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
