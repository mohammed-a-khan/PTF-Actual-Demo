/**
 * Everything a load run needs, read from the project: the scenario, its collection's requests, the
 * data file, and the values ({{variables}}, {config:KEY}, {env:NAME}) as a test run of the chosen
 * environment sees them. Shared by the Studio (secrets from its secret store) and the command line
 * in a pipeline (secrets from the pipeline's environment variables).
 */
import * as fs from 'fs';
import type { SecretVault } from '../api/vault';
import * as path from 'path';
import { resolveConfig } from '../env/resolve';
import { discover } from '../env/layers';
import { allRequests, ApiCollection, ApiRequest } from '../api/model';
import { fill, Values } from '../api/send';
import { readCollection } from '../api/store';
import { DataSource, describeSource } from '../data/source';
import type { EngineInput, PopulationInput } from './engine';
import { LoadScenario, parseCsv, SlaProfile, validScenario, validSlaProfile } from './scenario';
import { BrowserPathDef, readBrowserPath } from './browserPath';
import { logicProblems, PathLogic } from './logic';

/** Reads a file of the project for a multipart part (never outside the repository, at most 50 MB). */
export function projectFileReader(repoRoot: string): (rel: string) => Buffer {
    const root = path.resolve(repoRoot);
    return (rel: string) => {
        const abs = path.resolve(root, rel);
        if (!abs.startsWith(root + path.sep)) throw new Error(`${rel} is not in the project.`);
        if (fs.statSync(abs).size > 50 * 1024 * 1024) throw new Error(`${rel} is larger than 50 MB.`);
        return fs.readFileSync(abs);
    };
}

export const scenarioFileOk = (f: string) => /^test\/[A-Za-z0-9][\w.-]*\/load\/[\w.-]+\.load\.json$/.test(f);

/** Values for a collection's requests in project/env; and the secret values (to mask them). */
export function valuesFor(repoRoot: string, project: string, env: string, c: Pick<ApiCollection, 'variables'>, secretEnv: Record<string, string>): { values: Values; secrets: string[] } {
    const resolved = resolveConfig({ repoRoot, project, environment: env, secretEnv, unmasked: true });
    const values: Values = { vars: {}, config: resolved.values ?? {}, env: { ...process.env, ...secretEnv } };
    for (const v of c.variables) if (v.enabled !== false) values.vars[v.key] = fill(v.value, values);
    const secrets = [...Object.values(secretEnv), ...Object.entries(resolved.values ?? {}).filter(([k]) => resolved.entries.find((e) => e.key === k)?.sensitive).map(([, v]) => v)].filter((x) => x && x.length >= 4);
    return { values, secrets };
}

/**
 * Configuration and secret values that are vault references ({kv:…}, {vault:…}, {awssm:…}) replaced by the secret
 * (read once per process); the collection's variables filled again with them; the secrets added to what is masked.
 */
export async function withVault(r: { values: Values; secrets: string[] }, c: Pick<ApiCollection, 'variables'>, vault: SecretVault): Promise<{ values: Values; secrets: string[] }> {
    const cfg = await vault.resolveMap(r.values.config);
    const env = await vault.resolveMap(r.values.env as Record<string, string | undefined>);
    if (!cfg.length && !env.length) return r;
    for (const v of c.variables) if (v.enabled !== false) r.values.vars[v.key] = fill(v.value, r.values);
    const got = [...cfg.map((k) => r.values.config[k]), ...env.map((k) => r.values.env[k] ?? '')].filter((x) => x && x.length >= 4);
    return { values: r.values, secrets: [...r.secrets, ...got] };
}

/** One user path's requests (or browser path) and values. */
function loadPath(repoRoot: string, project: string, environment: string, x: { collection?: string; browserPath?: string; requests: string[]; showBrowsers?: boolean; label: string; logic?: PathLogic }, secretEnv: Record<string, string>): Omit<PopulationInput, 'name' | 'share'> {
    const where = x.browserPath ?? x.collection ?? '';
    if (!where.startsWith(`test/${project}/`)) throw new Error(`${x.label}: ${where || 'nothing to run'} is not in the project ${project}.`);
    if (x.browserPath) {
        let def: BrowserPathDef;
        try { def = readBrowserPath(repoRoot, x.browserPath); } catch (e) { throw new Error(`${x.label}: the browser path ${x.browserPath} cannot be read: ${(e as Error).message}`); }
        return { collection: { baseUrl: '', auth: { type: 'none' } }, requests: [], values: { vars: {}, config: {}, env: {} }, browser: { def, projectRoot: repoRoot, headless: !x.showBrowsers } };
    }
    let c: ApiCollection;
    try { c = readCollection(repoRoot, x.collection!); } catch (e) { throw new Error(`${x.label}: the collection ${x.collection} cannot be read: ${(e as Error).message}`); }
    const all = allRequests(c.items).map((r) => r.request);
    // With logic, the logic says which requests run (any of the collection's).
    const requests = x.logic ? all : x.requests.length ? x.requests.map((id) => all.find((r) => r.id === id)).filter((r): r is ApiRequest => !!r) : all;
    if (!requests.length) throw new Error(`${x.label}: no requests to run.`);
    if (x.logic) { const p = logicProblems(x.logic, new Set(all.map((r) => r.id))); if (p.length) throw new Error(`${x.label}: ${p.slice(0, 5).join('; ')}`); }
    const { values, secrets } = valuesFor(repoRoot, project, environment, c, secretEnv);
    return { collection: { baseUrl: c.baseUrl, auth: c.auth, scripts: c.scripts }, requests, values, secrets, ...(x.logic ? { logic: x.logic } : {}) };
}

/** The scenario with its service-level profile's levels added (the profile's interval unless the scenario has one). */
export function applySlaProfile(repoRoot: string, sc: LoadScenario): LoadScenario {
    if (!sc.slaProfile) return sc;
    const abs = path.resolve(repoRoot, sc.slaProfile);
    if (!abs.startsWith(path.resolve(repoRoot) + path.sep)) throw new Error('The service-level profile must be in the project.');
    let p: SlaProfile;
    try { p = validSlaProfile(JSON.parse(fs.readFileSync(abs, 'utf8'))); }
    catch (e) { throw new Error(fs.existsSync(abs) ? `${sc.slaProfile}: ${(e as Error).message}` : `The service-level profile ${sc.slaProfile} does not exist.`); }
    return { ...sc, slas: [...p.slas, ...sc.slas], ...(sc.slaInterval === undefined && p.interval ? { slaInterval: p.interval } : {}) };
}

export async function prepareLoad(repoRoot: string, file: string, env: string | undefined, secretEnvFor: (env: string) => Record<string, string>,
    rowsFor?: (project: string, environment: string, source: DataSource, secretEnv: Record<string, string>) => Promise<Array<Record<string, string>>>):
    Promise<{ project: string; environment: string; scenario: LoadScenario; input: Omit<EngineInput, 'connection'> }> {
    if (!scenarioFileOk(file)) throw new Error('Not a load scenario file (test/<project>/load/<name>.load.json).');
    const project = file.split('/')[1];
    const environment = env || ((discover(repoRoot).environments[project] ?? [])[0] ?? 'dev');
    let sc: LoadScenario;
    try { sc = validScenario(JSON.parse(fs.readFileSync(path.join(repoRoot, file), 'utf8'))); }
    catch (e) { throw new Error(fs.existsSync(path.join(repoRoot, file)) ? (e as Error).message : `${file} does not exist.`); }
    sc = applySlaProfile(repoRoot, sc);
    const secretEnv = secretEnvFor(environment);
    const main = loadPath(repoRoot, project, environment, { collection: sc.collection, browserPath: sc.browserPath, requests: sc.requests, showBrowsers: sc.showBrowsers, label: sc.mainName?.trim() || 'The scenario', logic: sc.logic }, secretEnv);
    const populations: PopulationInput[] = (sc.populations ?? []).map((p) => ({ name: p.name.trim(), share: p.share, ...loadPath(repoRoot, project, environment, { ...p, showBrowsers: sc.showBrowsers, label: p.name }, secretEnv),
        ...(p.policy ? { policy: p.policy } : {}), ...(p.startDelay ? { startDelay: p.startDelay } : {}), ...(p.stopAfter !== undefined ? { stopAfter: p.stopAfter } : {}), ...(p.wan ? { wan: p.wan } : {}) }));
    let rows: Array<Record<string, string>> = [];
    if (sc.data?.source) {
        if (!rowsFor) throw new Error('Test data sources other than CSV files need the project process.');
        try { rows = await rowsFor(project, environment, sc.data.source, secretEnv); } catch (e) { throw new Error(`Test data (${describeSource(sc.data.source)}): ${(e as Error).message.replace(/^Test data: /, '')}`); }
        if (!rows.length) throw new Error(`Test data (${describeSource(sc.data.source)}): no rows.`);
    } else if (sc.data?.file) {
        const abs = path.resolve(repoRoot, sc.data.file);
        if (!abs.startsWith(path.resolve(repoRoot) + path.sep)) throw new Error('The data file must be in the project.');
        try { rows = parseCsv(fs.readFileSync(abs, 'utf8')).rows; } catch { throw new Error(`The data file ${sc.data.file} cannot be read.`); }
        if (!rows.length) throw new Error(`The data file ${sc.data.file} has no rows.`);
    }
    return { project, environment, scenario: sc, input: { scenario: sc, ...main, rows, projectRoot: repoRoot, environment, ...(populations.length ? { populations } : {}) } };
}
