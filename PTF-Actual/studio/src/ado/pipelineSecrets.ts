/**
 * Pipeline secrets: which secret variables an ADO pipeline must provide so tests run the same as on
 * a laptop, and whether each is present.
 *
 *  - Required names: every {env:NAME} the framework will resolve for a project + environment
 *    (effective config) plus {env:NAME} used in feature files (needed in every environment).
 *  - Locally: is NAME in the user's secret store for that environment?
 *  - In ADO: is NAME a secret variable in the environment's variable group?
 *
 * Settings live in the repository at .cs-studio/pipeline.json so the whole team shares them:
 *   { "variableGroup": "{project}-{env}-secrets" }
 */
import * as fs from 'fs';
import { azureAccessToken, AZURE_DEVOPS_RESOURCE } from '../api/vault';
import * as path from 'path';
import { resolveConfig } from '../env/resolve';
import { discover } from '../env/layers';
import { SecretStore } from '../secrets/store';
import { UserError } from '../core/errors';
import { AdoClient, AdoSettings } from './client';
import { isTrustedAdoHost, PersonalSettings, DEFAULT_SETTINGS } from '../core/settings';

export const PIPELINE_SETTINGS_PATH = '.cs-studio/pipeline.json';
export const DEFAULT_GROUP_PATTERN = '{project}-{env}-secrets';
/** Variables an ADO agent provides itself — never expected in a variable group. */
const AGENT_PROVIDED = /^(BUILD|SYSTEM|AGENT|RELEASE|PIPELINE|ENVIRONMENT|TF|COMMON|SYSTEM_ACCESSTOKEN)_|^(PATH|HOME|TEMP|TMP|USERPROFILE|PROJECT|ENVIRONMENT)$/;

export interface PipelineSettings { variableGroup: string }

export function readPipelineSettings(repoRoot: string): PipelineSettings {
    try {
        const d = JSON.parse(fs.readFileSync(path.join(repoRoot, PIPELINE_SETTINGS_PATH), 'utf8'));
        if (typeof d.variableGroup === 'string' && d.variableGroup.trim()) return { variableGroup: d.variableGroup.trim() };
    } catch { /* defaults */ }
    return { variableGroup: DEFAULT_GROUP_PATTERN };
}

export function writePipelineSettings(repoRoot: string, s: PipelineSettings): void {
    if (!/^[\w {}.-]{1,120}$/.test(s.variableGroup)) throw new UserError('The variable group name may use letters, digits, spaces, - _ . and {project} / {env}.');
    const p = path.join(repoRoot, PIPELINE_SETTINGS_PATH);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n', 'utf8');
}

export const groupNameFor = (pattern: string, project: string, env: string) => pattern.replace(/\{project\}/g, project).replace(/\{env\}/g, env);

export interface Reference { name: string; usedBy: Array<{ key?: string; file: string; line?: number }> }

/**
 * Names that come from the computer or the pipeline agent, never from a secret: the OS
 * (HOME, PATH, TEMP …), proxy settings, and Azure DevOps' predefined variables (BUILD_*, AGENT_* …).
 */
export const NOT_SECRETS = /^(HOME|PATH|USER|USERNAME|USERPROFILE|USERDOMAIN|TEMP|TMP|TMPDIR|SHELL|LANG|PWD|OS|COMPUTERNAME|HOSTNAME|APPDATA|LOCALAPPDATA|PROGRAMFILES|SYSTEMROOT|WINDIR|CI|TF_BUILD|NODE_ENV|NODE_OPTIONS|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy|(BUILD|AGENT|SYSTEM|RELEASE|PIPELINE|ENVIRONMENT|RESOURCES)_[A-Z0-9_]+)$/;

/**
 * The lines of a feature file whose values a test uses: steps, their tables and doc strings, and
 * Examples rows. Comments, descriptions and Feature/Scenario titles are only text.
 */
export function usedLines(text: string): Array<{ text: string; line: number }> {
    const out: Array<{ text: string; line: number }> = [];
    let doc: string | null = null;
    text.split(/\r?\n/).forEach((raw, i) => {
        const t = raw.trim();
        if (doc) { if (t.startsWith(doc)) doc = null; else out.push({ text: raw, line: i + 1 }); return; }
        if (t.startsWith('"""') || t.startsWith('```')) { doc = t.slice(0, 3); return; }
        if (/^(Given|When|Then|And|But|\*)\s/.test(t) || t.startsWith('|')) out.push({ text: raw, line: i + 1 });
    });
    return out;
}

/** {env:NAME} references in feature files (used in every environment). */
export function featureReferences(repoRoot: string): Reference[] {
    const found = new Map<string, Reference>();
    const walk = (dir: string, depth: number) => {
        if (depth > 12) return;
        let entries: fs.Dirent[] = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist' || e.name === 'reports') continue;
            const abs = path.join(dir, e.name);
            if (e.isDirectory()) walk(abs, depth + 1);
            else if (e.name.endsWith('.feature')) {
                const rel = path.relative(repoRoot, abs).split(path.sep).join('/');
                usedLines(fs.readFileSync(abs, 'utf8')).forEach(({ text: l, line }) => {
                    for (const m of l.matchAll(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
                        if (NOT_SECRETS.test(m[1])) continue;
                        if (!found.has(m[1])) found.set(m[1], { name: m[1], usedBy: [] });
                        found.get(m[1])!.usedBy.push({ file: rel, line });
                    }
                });
            }
        }
    };
    walk(repoRoot, 0);
    return [...found.values()];
}

/** {env:NAME} references in the effective configuration of one project + environment. */
export function configReferences(repoRoot: string, project: string, env: string): Reference[] {
    const res = resolveConfig({ repoRoot, project, environment: env });
    const found = new Map<string, Reference>();
    for (const e of res.entries) {
        if (!e.from.source.startsWith('config/')) continue;
        for (const m of e.from.raw.matchAll(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
            if (NOT_SECRETS.test(m[1])) continue;
            if (!found.has(m[1])) found.set(m[1], { name: m[1], usedBy: [] });
            found.get(m[1])!.usedBy.push({ key: e.key, file: e.from.source, line: e.from.line });
        }
    }
    return [...found.values()];
}

export interface RequirementRow {
    name: string;
    usedBy: Reference['usedBy'];
    local: boolean;
    /** undefined = not checked (ADO not connected). */
    inAdo?: 'secret' | 'plain' | 'missing';
}

export interface Requirements {
    project: string;
    env: string;
    variableGroup: string;
    rows: RequirementRow[];
    /** YAML for the pipeline using the shared template. */
    yaml: string;
}

export function requirements(repoRoot: string, store: SecretStore, storeProject: string, project: string, env: string): Requirements {
    const { projects } = discover(repoRoot);
    if (!projects.includes(project)) throw new UserError(`There is no project "${project}" under config/.`);
    const merged = new Map<string, Reference>();
    for (const r of [...configReferences(repoRoot, project, env), ...featureReferences(repoRoot)]) {
        if (AGENT_PROVIDED.test(r.name)) continue;
        if (!merged.has(r.name)) merged.set(r.name, { name: r.name, usedBy: [] });
        merged.get(r.name)!.usedBy.push(...r.usedBy);
    }
    const rows = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name)).map((r) => ({
        name: r.name,
        usedBy: r.usedBy,
        local: store.resolve(r.name, { project: storeProject, env }) !== undefined,
    }));
    const variableGroup = groupNameFor(readPipelineSettings(repoRoot).variableGroup, project, env);
    return { project, env, variableGroup, rows, yaml: pipelineYaml(variableGroup, rows.map((r) => r.name)) };
}

/** Parameters to pass to the shared ado-playwright-shared stage template. */
export function pipelineYaml(group: string, names: string[]): string {
    return [
        '    secretsVariableGroup: ' + JSON.stringify(group),
        '    secretNames:',
        ...names.map((n) => `    - ${n}`),
    ].join('\n').replace(/secretNames:$/, 'secretNames: []');
}

/**
 * ADO connection for a project + environment. The organization and project come from the
 * framework config, but two things come ONLY from the user's personal settings, never from the
 * repository (a cloned repo must not be able to redirect the token):
 *   - the token: the secret named in personal settings (default ADO_PAT);
 *   - which hosts may receive it: https://dev.azure.com, *.visualstudio.com, or hosts the user
 *     added as trusted.
 */
export function adoSettingsFor(repoRoot: string, store: SecretStore, storeProject: string, project: string, env: string,
    processEnv: NodeJS.ProcessEnv = process.env, personal: PersonalSettings = DEFAULT_SETTINGS): AdoSettings {
    const res = resolveConfig({ repoRoot, project, environment: env });
    const get = (k: string) => res.entries.find((e) => e.key === k);
    const org = get('ADO_ORGANIZATION')?.value ?? '';
    const orgUrl = (get('ADO_ORGANIZATION_URL')?.value || (org ? `https://dev.azure.com/${org}` : '')).replace(/\/$/, '');
    const adoProject = get('ADO_PROJECT')?.value ?? '';
    if (!orgUrl) throw new UserError(`ADO_ORGANIZATION is not set for ${project}/${env}.`);
    let u: URL;
    try { u = new URL(orgUrl); } catch { throw new UserError(`ADO_ORGANIZATION_URL is not a valid address: ${orgUrl}`); }
    if (u.protocol !== 'https:') throw new UserError(`Your access token is only sent over https. ADO_ORGANIZATION_URL is ${orgUrl}.`);
    if (!isTrustedAdoHost(u.hostname, personal.trustedAdoHosts)) {
        throw new UserError(`${u.hostname} is not a trusted Azure DevOps host, so your access token will not be sent there. If it is your company's Azure DevOps Server, add it under Settings → Trusted Azure DevOps hosts.`);
    }
    // Entra ID instead of a PAT (PATs are being retired): the Azure CLI's sign-in, or a service principal / managed
    // identity from the environment. One token per organization, renewed before it expires.
    if (personal.adoAuth === 'entra') {
        const env2 = { ...processEnv };
        let cached: { token: string; until: number } | null = null;
        const bearer = async () => {
            if (cached && cached.until > Date.now()) return cached.token;
            const t = await azureAccessToken(AZURE_DEVOPS_RESOURCE, env2);
            cached = { token: t.token, until: Date.now() + (t.expiresIn - 120) * 1000 };
            return t.token;
        };
        return { orgUrl, project: adoProject, pat: '', bearer, apiVersion: get('ADO_API_VERSION')?.value };
    }
    const patName = personal.adoPatSecret;
    const pat = store.resolve(patName, { project: storeProject, env }) ?? '';
    if (!pat) {
        const patEntry = get('ADO_PAT');
        const legacy = patEntry && patEntry.from.source.startsWith('config/') && /^ENCRYPTED:/.test(patEntry.from.raw);
        throw new UserError(legacy
            ? `Your ADO token is still an ENCRYPTED: value in ${patEntry!.from.source}. Save it in your secret store as ${patName} (Secrets → Add secret).`
            : `Save your Azure DevOps personal access token as the secret ${patName} (Secrets → Add secret).`);
    }
    // The Studio's own connection (proxy, certificates) comes from Settings → Network, not from the
    // framework's ADO_PROXY_* (those apply to the framework's own ADO publishing during test runs).
    void processEnv;
    return { orgUrl, project: adoProject, pat, apiVersion: get('ADO_API_VERSION')?.value };
}

/** Add the ADO status of each required name (one read of the variable group). */
export async function checkInAdo(req: Requirements, client: AdoClient): Promise<Requirements & { groupExists: boolean }> {
    const g = await client.findVariableGroup(req.variableGroup);
    const rows = req.rows.map((r) => {
        const v = g?.variables[r.name];
        return { ...r, inAdo: (!v ? 'missing' : v.isSecret ? 'secret' : 'plain') as RequirementRow['inAdo'] };
    });
    return { ...req, rows, groupExists: !!g };
}

/** Copy the chosen secrets from the local store into the environment's variable group. */
export async function syncToAdo(req: Requirements, names: string[], store: SecretStore, storeProject: string, client: AdoClient): Promise<{ created: boolean; sent: string[] }> {
    const wanted = new Set(names);
    const values: Record<string, string> = {};
    for (const r of req.rows) {
        if (!wanted.has(r.name)) continue;
        const v = store.resolve(r.name, { project: storeProject, env: req.env });
        if (v === undefined) throw new UserError(`${r.name} is not in your secret store for ${req.env}, so there is nothing to send.`);
        values[r.name] = v;
    }
    if (Object.keys(values).length === 0) throw new UserError('Choose at least one secret to send.');
    const res = await client.upsertSecrets(req.variableGroup, values, `Test secrets for ${req.project} (${req.env}). Managed with CS Test Studio.`);
    return { created: res.created, sent: Object.keys(values) };
}
