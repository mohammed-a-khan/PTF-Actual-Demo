/**
 * Load test data rows for an API run or a load test (see source.ts), in the project's own process
 * (src/db/worker.ts): files and generated rows through the installed framework's CSDataProvider,
 * queries and procedures through the project's connection settings. On production-like environments
 * and read-only connections, database sources run read only (as on the Database screen). API sources
 * send a saved request (with its auth) through the Studio's network settings.
 */
import type { Connection } from '../core/network';
import { resolveConfig } from '../env/resolve';
import { listConnections, protectedEnvironment } from '../db/connections';
import type { DbSessions } from '../db/sessions';
import { readCollection } from '../api/store';
import { allRequests } from '../api/model';
import { authorize, prepare, send } from '../api/send';
import { readPath } from '../api/jsonPath';
import { valuesFor } from '../load/prepare';
import { DataRows, DataSource, describeSource, validSource } from './source';

export interface LoadDataInput {
    repoRoot: string;
    project: string;
    environment: string;
    source: unknown;
    /** Secrets as environment variables ({env:NAME}). */
    secretEnv: Record<string, string>;
    sessions: DbSessions;
    connection?: Connection;
    timeoutMs?: number;
    /** Values remembered in a recording ({{name}} of an API request that the collection does not define). */
    remembered?: Record<string, string>;
}

export async function loadDataRows(o: LoadDataInput): Promise<DataRows & { source: DataSource; readOnly?: string }> {
    const s = validSource(o.source);
    if (!o.project || !s) throw new Error('Test data: no project.');
    const where = (p: string) => { if (p.startsWith('test/') && !p.startsWith(`test/${o.project}/`)) throw new Error(`Test data: ${p} is not in the project ${o.project}.`); };
    if (s.file) where(s.file);
    if (s.collection) where(s.collection);
    const timeoutMs = o.timeoutMs ?? 300_000;
    let mode: 'read' | 'change' = 'read';
    let readOnly: string | undefined;
    let rows: unknown[] | undefined;
    if (s.kind === 'query' || s.kind === 'procedure') {
        const osEnv: Record<string, string> = {};
        for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('CS_STUDIO_')) osEnv[k] = v;
        const values = resolveConfig({ repoRoot: o.repoRoot, project: o.project, environment: o.environment, secretEnv: o.secretEnv, osEnv, unmasked: true }).values ?? {};
        const alias = String(s.connection).toUpperCase();
        const c = listConnections(values).find((x) => x.alias === alias);
        if (!c) throw new Error(`Test data: no connection ${alias} in ${o.project}/${o.environment} (DB_${alias}_TYPE is not set).`);
        if (c.problems.length) throw new Error(`Test data: ${c.problems.join(' ')}`);
        readOnly = protectedEnvironment(o.environment, values) ?? (c.readOnlyByConfig ? `DB_${alias}_STUDIO_READONLY=true` : undefined) ?? undefined;
        mode = readOnly ? 'read' : 'change';
    }
    if (s.kind === 'api') {
        let c;
        try { c = readCollection(o.repoRoot, s.collection!); } catch (e) { throw new Error(`Test data: the collection ${s.collection} cannot be read: ${(e as Error).message}`); }
        const r = allRequests(c.items).map((x) => x.request).find((x) => x.id === s.request || x.name === s.request);
        if (!r) throw new Error(`Test data: no request ${s.request} in ${s.collection}.`);
        const { values } = valuesFor(o.repoRoot, o.project, o.environment, c, o.secretEnv);
        for (const [k, v] of Object.entries(o.remembered ?? {})) if (!(k in values.vars)) values.vars[k] = v;
        const p = await authorize(c, r, values, prepare(c, r, values), o.connection, new Map(), 60_000);
        if (p.missing.length) throw new Error(`Test data: ${r.name}: not filled in: ${p.missing.join(', ')}.`);
        const res = await send(p, o.connection, timeoutMs);
        if (res.status < 200 || res.status > 299) throw new Error(`Test data: ${r.name} answered ${res.status} ${res.statusText}.`);
        if (res.json === undefined) throw new Error(`Test data: ${r.name} did not answer JSON.`);
        const at = readPath(res.json, (s.path || '$').replace(/\[\*\]$/, ''));
        if (at === undefined) throw new Error(`Test data: nothing at ${s.path} in the response of ${r.name}.`);
        rows = Array.isArray(at) ? at : [at];
    }
    const out = await o.sessions.request<DataRows>(o.project, o.environment, { op: 'data', source: s, mode, rows, timeoutMs }, timeoutMs + 30_000);
    return { ...out, source: s, ...(readOnly ? { readOnly } : {}) };
}

export { describeSource };
