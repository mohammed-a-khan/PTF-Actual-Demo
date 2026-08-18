import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';

// Home-level + workspace + env cascade for ADO configuration.
//
// Precedence (highest wins — first source with a value for a field is used):
//   1. Explicit tool arg
//   2. Workspace cs-playwright-mcp.config.json (ado block)
//   3. Per-workspace .cs-qa/ado-config.json (project-scoped overrides)
//   4. Home ~/.cs-qa/ado-config.json (encrypted PAT)
//   5. Env vars (ADO_ORG_URL, ADO_PROJECT, ADO_PAT + defaults)
//   6. Framework CSADOConfiguration singleton (only when the module resolves —
//      typically true inside consumer projects, false inside PTF-ADO itself)
//
// Fields resolved:
//   orgUrl, project, pat, defaultTestPlanId, defaultTestSuiteId, defaultAreaPath,
//   defaultIterationPath, defaultAssignedTo
//
// `resolve` returns per-field {value, source} for a dry-run trace.
// `debug` walks EVERY layer even after a hit, so callers can see the whole ladder.

type ConfigField = 'orgUrl' | 'project' | 'pat' | 'defaultTestPlanId' | 'defaultTestSuiteId' | 'defaultAreaPath' | 'defaultIterationPath' | 'defaultAssignedTo';

type SourceLabel = 'tool-arg' | 'workspace-config' | 'workspace-cs-qa-override' | 'home-config' | 'env' | 'framework-singleton' | 'unset';

interface FieldTrace {
    value: string | number | null;
    source: SourceLabel;
    /** Layers examined in order; each entry is {source, found, note?}. */
    considered: Array<{ source: SourceLabel; found: boolean; note?: string }>;
}

type ResolvedFields = Record<ConfigField, FieldTrace>;

const PAT_PLACEHOLDERS = new Set([
    'ENCRYPTED:paste-output-of-cs-playwright-mcp-encrypt-here',
    'ENCRYPTED:paste-encrypted-pat-here',
    'YOUR_PAT_HERE',
    'REPLACE_ME',
]);

function encryptViaFramework(workspaceRoot: string, plain: string): string | null {
    if (plain.startsWith('ENCRYPTED:')) return plain;
    try {
        const cryptoUtilPath = path.resolve(workspaceRoot, 'node_modules/@mdakhan.mak/cs-playwright-test-framework/dist/utils/CSEncryptionUtil.js');
        if (!fs.existsSync(cryptoUtilPath)) return null;
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { CSEncryptionUtil } = require(cryptoUtilPath) as { CSEncryptionUtil: { getInstance(): { createEncryptedConfigValue(v: string): string } } };
        return CSEncryptionUtil.getInstance().createEncryptedConfigValue(plain);
    } catch {
        return null;
    }
}

function decryptIfNeeded(value: string, workspaceRoot: string): string | null {
    if (!value.startsWith('ENCRYPTED:')) return value;
    try {
        const cryptoUtilPath = path.resolve(workspaceRoot, 'node_modules/@mdakhan.mak/cs-playwright-test-framework/dist/utils/CSEncryptionUtil.js');
        if (!fs.existsSync(cryptoUtilPath)) return null;
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { CSEncryptionUtil } = require(cryptoUtilPath) as { CSEncryptionUtil: { getInstance(): { decrypt(v: string): string } } };
        return CSEncryptionUtil.getInstance().decrypt(value);
    } catch {
        return null;
    }
}

function maskPat(pat: string | null | undefined): string {
    if (!pat) return '';
    if (pat.startsWith('ENCRYPTED:')) return 'ENCRYPTED:***';
    if (pat.length <= 8) return '***';
    return `${pat.slice(0, 4)}***${pat.slice(-2)}`;
}

interface RawFile {
    orgUrl?: string;
    organization?: string;
    baseUrl?: string;
    project?: string;
    personalAccessToken?: string;
    pat?: string;
    token?: string;
    defaultTestPlanId?: number | string;
    defaultTestSuiteId?: number | string;
    defaultAreaPath?: string;
    defaultIterationPath?: string;
    defaultAssignedTo?: string;
}

function readJsonSafe(p: string): Record<string, unknown> | null {
    if (!fs.existsSync(p)) return null;
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>; }
    catch { return null; }
}

function extractAdoBlock(j: Record<string, unknown> | null): RawFile {
    if (!j) return {};
    const ado = (j.ado ?? j.azureDevOps ?? j) as Record<string, unknown>;
    const out: RawFile = {
        orgUrl: (ado.orgUrl as string) || undefined,
        organization: (ado.organization as string) || undefined,
        baseUrl: (ado.baseUrl as string) || undefined,
        project: (ado.project as string) || undefined,
        personalAccessToken: (ado.personalAccessToken as string) || undefined,
        pat: (ado.pat as string) || undefined,
        token: (ado.token as string) || undefined,
        defaultTestPlanId: (ado.defaultTestPlanId as number | string) ?? undefined,
        defaultTestSuiteId: (ado.defaultTestSuiteId as number | string) ?? undefined,
        defaultAreaPath: (ado.defaultAreaPath as string) || undefined,
        defaultIterationPath: (ado.defaultIterationPath as string) || undefined,
        defaultAssignedTo: (ado.defaultAssignedTo as string) || undefined,
    };
    // Derive orgUrl from organization + baseUrl if not explicit.
    if (!out.orgUrl && out.organization) {
        const base = (out.baseUrl ?? 'https://dev.azure.com').replace(/\/$/, '');
        out.orgUrl = `${base}/${out.organization}`;
    }
    return out;
}

function loadFrameworkSingleton(workspaceRoot: string): { orgUrl?: string; project?: string; pat?: string; loaded: boolean; error?: string } {
    try {
        const modPath = path.resolve(workspaceRoot, 'node_modules/@mdakhan.mak/cs-playwright-test-framework/dist/ado/CSADOConfiguration.js');
        if (!fs.existsSync(modPath)) return { loaded: false, error: 'framework not installed' };
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require(modPath) as { CSADOConfiguration: { getInstance(): { initialize?: () => void; getOrganizationUrl?: () => string; getProject?: () => string; getPAT?: () => string } } };
        const cfg = mod.CSADOConfiguration.getInstance();
        try { cfg.initialize?.(); } catch { /* best effort */ }
        return {
            orgUrl: cfg.getOrganizationUrl?.() || undefined,
            project: cfg.getProject?.() || undefined,
            pat: cfg.getPAT?.() || undefined,
            loaded: true,
        };
    } catch (e) {
        return { loaded: false, error: (e as Error).message };
    }
}

interface ResolveInput {
    orgUrl?: string;
    project?: string;
    personalAccessToken?: string;
    defaultTestPlanId?: number;
    defaultTestSuiteId?: number;
    defaultAreaPath?: string;
    defaultIterationPath?: string;
    defaultAssignedTo?: string;
}

interface ResolveOptions {
    /** When true, keep walking every layer for the trace even after a hit (verbose mode). */
    trace?: boolean;
}

function pickField(
    field: ConfigField,
    layers: Array<{ source: SourceLabel; value: string | number | null; note?: string }>,
    trace: boolean,
): FieldTrace {
    const considered: Array<{ source: SourceLabel; found: boolean; note?: string }> = [];
    let chosen: { source: SourceLabel; value: string | number | null } | null = null;
    for (const layer of layers) {
        const isSet = layer.value !== null && layer.value !== undefined && layer.value !== '';
        // For PAT: reject placeholders during resolution.
        const passesPatCheck = field !== 'pat' || (typeof layer.value !== 'string' || !PAT_PLACEHOLDERS.has(layer.value));
        const found = isSet && passesPatCheck;
        considered.push({ source: layer.source, found, note: layer.note });
        if (!chosen && found) {
            chosen = { source: layer.source, value: layer.value };
            if (!trace) break;
        }
    }
    return chosen
        ? { value: chosen.value, source: chosen.source, considered }
        : { value: null, source: 'unset', considered };
}

export function resolveAdoConfig(workspaceRoot: string, input: ResolveInput, opts: ResolveOptions = {}): ResolvedFields {
    const trace = opts.trace === true;

    // Layer 1 — tool args
    const argOrg = input.orgUrl ?? null;
    const argProject = input.project ?? null;
    const argPat = input.personalAccessToken ?? null;
    const argPlan = input.defaultTestPlanId ?? null;
    const argSuite = input.defaultTestSuiteId ?? null;
    const argArea = input.defaultAreaPath ?? null;
    const argIter = input.defaultIterationPath ?? null;
    const argAssigned = input.defaultAssignedTo ?? null;

    // Layer 2 — workspace config
    const workspaceConfigPath = path.join(workspaceRoot, 'cs-playwright-mcp.config.json');
    const workspaceAltPath = path.join(workspaceRoot, 'cs-ai-auto-assist.config.json');
    const workspaceRaw = extractAdoBlock(readJsonSafe(workspaceConfigPath) ?? readJsonSafe(workspaceAltPath));

    // Layer 3 — per-workspace .cs-qa override
    const csqaOverridePath = path.join(workspaceRoot, '.cs-qa', 'ado-config.json');
    const csqaRaw = extractAdoBlock(readJsonSafe(csqaOverridePath));

    // Layer 4 — home config
    const homeConfigPath = path.join(os.homedir(), '.cs-qa', 'ado-config.json');
    const homeRaw = extractAdoBlock(readJsonSafe(homeConfigPath));

    // Layer 5 — env vars
    const envOrg = process.env.ADO_ORG_URL || null;
    const envProject = process.env.ADO_PROJECT || null;
    const envPatRaw = process.env.ADO_PAT
        || process.env.AZURE_DEVOPS_EXT_PAT
        || process.env.AZURE_DEVOPS_TOKEN
        || process.env.AZURE_DEVOPS_PAT
        || process.env.ADO_PERSONAL_ACCESS_TOKEN
        || null;
    const envPlan = process.env.ADO_DEFAULT_TEST_PLAN_ID ? Number(process.env.ADO_DEFAULT_TEST_PLAN_ID) : null;
    const envSuite = process.env.ADO_DEFAULT_TEST_SUITE_ID ? Number(process.env.ADO_DEFAULT_TEST_SUITE_ID) : null;
    const envArea = process.env.ADO_DEFAULT_AREA_PATH || null;
    const envIter = process.env.ADO_DEFAULT_ITERATION_PATH || null;
    const envAssigned = process.env.ADO_DEFAULT_ASSIGNED_TO || null;

    // Layer 6 — framework singleton (best-effort; may not exist)
    const fw = loadFrameworkSingleton(workspaceRoot);

    // Resolve each field independently.
    const readPatFromFile = (raw: RawFile, sourceHint: string): string | null => {
        const rawTok = (raw.personalAccessToken || raw.pat || raw.token || '').trim();
        if (!rawTok) return null;
        if (PAT_PLACEHOLDERS.has(rawTok)) return null;
        const dec = decryptIfNeeded(rawTok, workspaceRoot);
        if (!dec) {
            // Return the raw (encrypted) marker so the trace can surface decrypt-failed.
            // pickField will still accept it as "value present" — caller sees masked form.
            return `DECRYPT_FAILED:${sourceHint}`;
        }
        return dec;
    };

    const patLayers: Array<{ source: SourceLabel; value: string | number | null; note?: string }> = [
        { source: 'tool-arg', value: argPat, note: argPat ? 'passed inline' : undefined },
        { source: 'workspace-config', value: readPatFromFile(workspaceRaw, 'workspace') },
        { source: 'workspace-cs-qa-override', value: readPatFromFile(csqaRaw, 'workspace-cs-qa') },
        { source: 'home-config', value: readPatFromFile(homeRaw, 'home') },
        { source: 'env', value: envPatRaw, note: envPatRaw ? 'env var set' : undefined },
        { source: 'framework-singleton', value: fw.pat ?? null, note: fw.loaded ? 'framework loaded' : (fw.error ?? 'framework not loadable') },
    ];

    const orgLayers = [
        { source: 'tool-arg' as SourceLabel, value: argOrg },
        { source: 'workspace-config' as SourceLabel, value: workspaceRaw.orgUrl ?? null },
        { source: 'workspace-cs-qa-override' as SourceLabel, value: csqaRaw.orgUrl ?? null },
        { source: 'home-config' as SourceLabel, value: homeRaw.orgUrl ?? null },
        { source: 'env' as SourceLabel, value: envOrg },
        { source: 'framework-singleton' as SourceLabel, value: fw.orgUrl ?? null },
    ];
    const projectLayers = [
        { source: 'tool-arg' as SourceLabel, value: argProject },
        { source: 'workspace-config' as SourceLabel, value: workspaceRaw.project ?? null },
        { source: 'workspace-cs-qa-override' as SourceLabel, value: csqaRaw.project ?? null },
        { source: 'home-config' as SourceLabel, value: homeRaw.project ?? null },
        { source: 'env' as SourceLabel, value: envProject },
        { source: 'framework-singleton' as SourceLabel, value: fw.project ?? null },
    ];
    const asNum = (v: unknown): number | null => {
        if (v === null || v === undefined || v === '') return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    };
    const planLayers = [
        { source: 'tool-arg' as SourceLabel, value: argPlan },
        { source: 'workspace-config' as SourceLabel, value: asNum(workspaceRaw.defaultTestPlanId) },
        { source: 'workspace-cs-qa-override' as SourceLabel, value: asNum(csqaRaw.defaultTestPlanId) },
        { source: 'home-config' as SourceLabel, value: asNum(homeRaw.defaultTestPlanId) },
        { source: 'env' as SourceLabel, value: envPlan },
        { source: 'framework-singleton' as SourceLabel, value: null, note: 'not exposed by framework' },
    ];
    const suiteLayers = [
        { source: 'tool-arg' as SourceLabel, value: argSuite },
        { source: 'workspace-config' as SourceLabel, value: asNum(workspaceRaw.defaultTestSuiteId) },
        { source: 'workspace-cs-qa-override' as SourceLabel, value: asNum(csqaRaw.defaultTestSuiteId) },
        { source: 'home-config' as SourceLabel, value: asNum(homeRaw.defaultTestSuiteId) },
        { source: 'env' as SourceLabel, value: envSuite },
        { source: 'framework-singleton' as SourceLabel, value: null, note: 'not exposed by framework' },
    ];
    const areaLayers = [
        { source: 'tool-arg' as SourceLabel, value: argArea },
        { source: 'workspace-config' as SourceLabel, value: workspaceRaw.defaultAreaPath ?? null },
        { source: 'workspace-cs-qa-override' as SourceLabel, value: csqaRaw.defaultAreaPath ?? null },
        { source: 'home-config' as SourceLabel, value: homeRaw.defaultAreaPath ?? null },
        { source: 'env' as SourceLabel, value: envArea },
        { source: 'framework-singleton' as SourceLabel, value: null, note: 'not exposed by framework' },
    ];
    const iterLayers = [
        { source: 'tool-arg' as SourceLabel, value: argIter },
        { source: 'workspace-config' as SourceLabel, value: workspaceRaw.defaultIterationPath ?? null },
        { source: 'workspace-cs-qa-override' as SourceLabel, value: csqaRaw.defaultIterationPath ?? null },
        { source: 'home-config' as SourceLabel, value: homeRaw.defaultIterationPath ?? null },
        { source: 'env' as SourceLabel, value: envIter },
        { source: 'framework-singleton' as SourceLabel, value: null, note: 'not exposed by framework' },
    ];
    const assignedLayers = [
        { source: 'tool-arg' as SourceLabel, value: argAssigned },
        { source: 'workspace-config' as SourceLabel, value: workspaceRaw.defaultAssignedTo ?? null },
        { source: 'workspace-cs-qa-override' as SourceLabel, value: csqaRaw.defaultAssignedTo ?? null },
        { source: 'home-config' as SourceLabel, value: homeRaw.defaultAssignedTo ?? null },
        { source: 'env' as SourceLabel, value: envAssigned },
        { source: 'framework-singleton' as SourceLabel, value: null, note: 'not exposed by framework' },
    ];

    return {
        orgUrl: pickField('orgUrl', orgLayers, trace),
        project: pickField('project', projectLayers, trace),
        pat: pickField('pat', patLayers, trace),
        defaultTestPlanId: pickField('defaultTestPlanId', planLayers, trace),
        defaultTestSuiteId: pickField('defaultTestSuiteId', suiteLayers, trace),
        defaultAreaPath: pickField('defaultAreaPath', areaLayers, trace),
        defaultIterationPath: pickField('defaultIterationPath', iterLayers, trace),
        defaultAssignedTo: pickField('defaultAssignedTo', assignedLayers, trace),
    };
}

/**
 * Simple helper for downstream tools: return the resolved creds (or null) plus
 * a diagnostic string. Consumers can drop-in replace their ad-hoc loadAdoConfig
 * with this.
 */
export function getResolvedCreds(workspaceRoot: string, input: ResolveInput = {}): { creds: { orgUrl: string; project: string; pat: string } | null; diagnostic: string; trace: ResolvedFields } {
    const trace = resolveAdoConfig(workspaceRoot, input);
    const orgUrl = trace.orgUrl.value ? String(trace.orgUrl.value) : '';
    const project = trace.project.value ? String(trace.project.value) : '';
    const patRaw = trace.pat.value ? String(trace.pat.value) : '';
    if (patRaw.startsWith('DECRYPT_FAILED:')) {
        return { creds: null, diagnostic: `PAT found in ${trace.pat.source} but decryption failed. Verify workspace has @mdakhan.mak/cs-playwright-test-framework installed and the ENCRYPTED:value matches that workspace's key.`, trace };
    }
    if (!orgUrl || !project || !patRaw) {
        const missing = [
            !orgUrl && 'orgUrl',
            !project && 'project',
            !patRaw && 'pat',
        ].filter(Boolean).join(', ');
        return { creds: null, diagnostic: `ADO not fully configured — missing: ${missing}. Run cs_qa_ado_config verb=resolve for per-field trace.`, trace };
    }
    return { creds: { orgUrl, project, pat: patRaw }, diagnostic: `ADO config resolved (orgUrl:${trace.orgUrl.source}, project:${trace.project.source}, pat:${trace.pat.source})`, trace };
}

registerPrimitive({
    name: 'cs_qa_ado_config',
    description: 'Manage AND resolve ADO configuration across the six-tier cascade (tool-arg > workspace config > .cs-qa override > ~/.cs-qa > env > framework singleton). Verbs: set (write ~/.cs-qa/ado-config.json; encrypts PAT), get (read the home config, PAT masked), delete (remove the home config), path (show its location), resolve (dry-run — return every field with the source it resolved from; PAT masked), debug (verbose — every layer examined even after a hit, so callers see the full ladder). New fields supported: defaultTestPlanId, defaultTestSuiteId, defaultAreaPath, defaultIterationPath, defaultAssignedTo.',
    inputSchema: z.discriminatedUnion('verb', [
        z.object({
            verb: z.literal('set'),
            orgUrl: z.string().url().optional().describe('Full ADO org URL — cloud: https://dev.azure.com/<yourorg> ; on-prem: https://<your-ado-host>/tfs/<yourorg>. Optional if `organization` is provided instead.'),
            organization: z.string().min(1).optional().describe('ADO org name — combined with baseUrl to form orgUrl. Ignored if orgUrl is provided.'),
            baseUrl: z.string().url().optional().describe('ADO server base URL. Defaults to https://dev.azure.com. Used with `organization`.'),
            project: z.string().min(1).describe('ADO project name'),
            personalAccessToken: z.string().min(1).describe('Raw PAT or an already-ENCRYPTED:... value. Raw values are encrypted before write.'),
            defaultTestPlanId: z.number().int().positive().optional(),
            defaultTestSuiteId: z.number().int().positive().optional(),
            defaultAreaPath: z.string().min(1).optional(),
            defaultIterationPath: z.string().min(1).optional(),
            defaultAssignedTo: z.string().min(1).optional(),
        }),
        z.object({ verb: z.literal('get') }),
        z.object({ verb: z.literal('delete') }),
        z.object({ verb: z.literal('path') }),
        z.object({
            verb: z.literal('resolve'),
            orgUrl: z.string().url().optional(),
            project: z.string().min(1).optional(),
            personalAccessToken: z.string().min(1).optional(),
            defaultTestPlanId: z.number().int().positive().optional(),
            defaultTestSuiteId: z.number().int().positive().optional(),
            defaultAreaPath: z.string().min(1).optional(),
            defaultIterationPath: z.string().min(1).optional(),
            defaultAssignedTo: z.string().min(1).optional(),
        }),
        z.object({
            verb: z.literal('debug'),
            orgUrl: z.string().url().optional(),
            project: z.string().min(1).optional(),
            personalAccessToken: z.string().min(1).optional(),
            defaultTestPlanId: z.number().int().positive().optional(),
            defaultTestSuiteId: z.number().int().positive().optional(),
            defaultAreaPath: z.string().min(1).optional(),
            defaultIterationPath: z.string().min(1).optional(),
            defaultAssignedTo: z.string().min(1).optional(),
        }),
    ]),
    outputSchema: z.object({
        ok: z.boolean(),
        verb: z.string(),
        path: z.string().optional(),
        exists: z.boolean().optional(),
        writtenSize: z.number().optional(),
        stored: z.object({
            orgUrl: z.string().optional(),
            project: z.string().optional(),
            patMasked: z.string().optional(),
            encrypted: z.boolean().optional(),
            defaultTestPlanId: z.number().optional(),
            defaultTestSuiteId: z.number().optional(),
            defaultAreaPath: z.string().optional(),
            defaultIterationPath: z.string().optional(),
            defaultAssignedTo: z.string().optional(),
        }).optional(),
        resolved: z.record(z.string(), z.any()).optional(),
        note: z.string().optional(),
    }),
    run: async (ctx, input) => {
        const configPath = path.join(os.homedir(), '.cs-qa', 'ado-config.json');

        if (input.verb === 'path') {
            return { ok: true, verb: 'path', path: configPath, exists: fs.existsSync(configPath) };
        }

        if (input.verb === 'delete') {
            if (!fs.existsSync(configPath)) return { ok: true, verb: 'delete', path: configPath, exists: false, note: 'File did not exist.' };
            fs.unlinkSync(configPath);
            return { ok: true, verb: 'delete', path: configPath, exists: false, note: 'Deleted.' };
        }

        if (input.verb === 'get') {
            if (!fs.existsSync(configPath)) return { ok: true, verb: 'get', path: configPath, exists: false };
            const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
            const pat = String(raw.personalAccessToken ?? raw.pat ?? '');
            return {
                ok: true, verb: 'get', path: configPath, exists: true,
                stored: {
                    orgUrl: (raw.orgUrl as string) ?? undefined,
                    project: (raw.project as string) ?? undefined,
                    patMasked: maskPat(pat),
                    encrypted: pat.startsWith('ENCRYPTED:'),
                    defaultTestPlanId: raw.defaultTestPlanId === undefined ? undefined : Number(raw.defaultTestPlanId) || undefined,
                    defaultTestSuiteId: raw.defaultTestSuiteId === undefined ? undefined : Number(raw.defaultTestSuiteId) || undefined,
                    defaultAreaPath: (raw.defaultAreaPath as string) ?? undefined,
                    defaultIterationPath: (raw.defaultIterationPath as string) ?? undefined,
                    defaultAssignedTo: (raw.defaultAssignedTo as string) ?? undefined,
                },
            };
        }

        if (input.verb === 'resolve' || input.verb === 'debug') {
            const trace = resolveAdoConfig(ctx.workspaceRoot, input, { trace: input.verb === 'debug' });
            // Mask PAT before returning.
            const patCopy: FieldTrace = { ...trace.pat };
            if (patCopy.value && typeof patCopy.value === 'string') {
                patCopy.value = patCopy.value.startsWith('DECRYPT_FAILED:') ? 'DECRYPT_FAILED' : maskPat(patCopy.value);
            }
            const resolved = { ...trace, pat: patCopy };
            const hasCreds = !!(trace.orgUrl.value && trace.project.value && trace.pat.value && typeof trace.pat.value === 'string' && !trace.pat.value.startsWith('DECRYPT_FAILED:'));
            return {
                ok: hasCreds,
                verb: input.verb,
                resolved,
                note: hasCreds
                    ? `Resolved ADO config (orgUrl:${trace.orgUrl.source}, project:${trace.project.source}, pat:${trace.pat.source}).`
                    : `ADO not fully configured — see per-field trace. Missing: ${[!trace.orgUrl.value && 'orgUrl', !trace.project.value && 'project', !trace.pat.value && 'pat'].filter(Boolean).join(', ')}`,
            };
        }

        // verb === 'set'
        const orgUrl = input.orgUrl
            ?? (input.organization ? `${(input.baseUrl ?? 'https://dev.azure.com').replace(/\/$/, '')}/${input.organization}` : '');
        if (!orgUrl) {
            return { ok: false, verb: 'set', path: configPath, note: 'Provide either orgUrl or organization+baseUrl.' };
        }

        const encrypted = encryptViaFramework(ctx.workspaceRoot, input.personalAccessToken);
        const patToWrite = encrypted ?? input.personalAccessToken;
        const wasEncrypted = patToWrite.startsWith('ENCRYPTED:');

        const body: Record<string, unknown> = {
            orgUrl,
            project: input.project,
            personalAccessToken: patToWrite,
            _note: 'Written by cs_qa_ado_config. Loaded by cs_qa_ado_read as a fallback when the workspace config has a placeholder PAT.',
            _writtenAt: new Date().toISOString(),
        };
        if (input.defaultTestPlanId) body.defaultTestPlanId = input.defaultTestPlanId;
        if (input.defaultTestSuiteId) body.defaultTestSuiteId = input.defaultTestSuiteId;
        if (input.defaultAreaPath) body.defaultAreaPath = input.defaultAreaPath;
        if (input.defaultIterationPath) body.defaultIterationPath = input.defaultIterationPath;
        if (input.defaultAssignedTo) body.defaultAssignedTo = input.defaultAssignedTo;

        const json = JSON.stringify(body, null, 2);
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, json, { encoding: 'utf-8', mode: 0o600 });
        try { fs.chmodSync(configPath, 0o600); } catch { /* best effort */ }

        return {
            ok: true,
            verb: 'set',
            path: configPath,
            exists: true,
            writtenSize: Buffer.byteLength(json, 'utf-8'),
            stored: {
                orgUrl,
                project: input.project,
                patMasked: wasEncrypted ? 'ENCRYPTED:***' : maskPat(input.personalAccessToken),
                encrypted: wasEncrypted,
                defaultTestPlanId: input.defaultTestPlanId,
                defaultTestSuiteId: input.defaultTestSuiteId,
                defaultAreaPath: input.defaultAreaPath,
                defaultIterationPath: input.defaultIterationPath,
                defaultAssignedTo: input.defaultAssignedTo,
            },
            note: wasEncrypted
                ? 'ADO config written to ~/.cs-qa/ado-config.json (0600). PAT is encrypted at rest.'
                : 'ADO config written to ~/.cs-qa/ado-config.json (0600). WARNING: framework CSEncryptionUtil unavailable — PAT stored as plaintext with 0600 permissions. Install @mdakhan.mak/cs-playwright-test-framework in this workspace and re-run to encrypt.',
        };
    },
});
