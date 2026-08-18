/**
 * cs_qa_ado_testcases_manage — move / remove-from-suite / delete / delete-suite / delete-plan
 * verbs for ADO test cases + suites + plans.
 *
 * Peer of publish_feature_to_ado_tool.ts. Reuses the same ADO config-loading
 * pattern (workspace + home fallback + PAT decryption) and the same adoRequest
 * shape. Every verb supports dryRun. Nothing destructive fires without an
 * explicit dryRun:false in the caller's payload.
 *
 * Name-based lookup: every verb that accepts plan/suite/testCase IDs also
 * accepts the matching *Name(s) fields. IDs remain the fast path; names go
 * through ado_name_resolver.ts which returns ambiguous:true (+ candidates)
 * when a name matches multiple entities, in which case the verb stops and
 * returns the ambiguity payload without any writes.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import {
    syncFeaturesAfterMove,
    syncFeaturesAfterDelete,
    syncFeaturesAfterRemoveFromSuite,
    syncFeaturesAfterSuiteDeleted,
    syncFeaturesAfterPlanDeleted,
    type SyncResult,
} from './sync_feature_tags';
import {
    resolvePlan,
    resolveSuite,
    resolveTestCases,
    listAllSuitesInPlan,
    collectNestedSuites,
    listTestCasesInSuite as resolverListTestCasesInSuite,
    listSuitesContainingCase,
    createCache,
    type ResolverCache,
    type AdoCreds as ResolverCreds,
} from './ado_name_resolver';

// =============================================================================
// ADO config loading — mirrors publish_feature_to_ado_tool's loadAdo.
// =============================================================================

const PAT_PLACEHOLDERS = new Set([
    'ENCRYPTED:paste-output-of-cs-playwright-mcp-encrypt-here',
    'ENCRYPTED:paste-encrypted-pat-here',
    'YOUR_PAT_HERE',
    'REPLACE_ME',
]);

interface AdoCreds {
    orgUrl: string;
    project: string;
    pat: string;
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

function loadAdo(workspaceRoot: string): AdoCreds | null {
    const candidates = [
        path.join(workspaceRoot, 'cs-playwright-mcp.config.json'),
        path.join(workspaceRoot, 'cs-ai-auto-assist.config.json'),
        path.join(os.homedir(), '.cs-qa', 'ado-config.json'),
    ];
    let orgUrl = '';
    let project = '';
    let pat = '';
    for (const c of candidates) {
        if (!fs.existsSync(c)) continue;
        try {
            const j = JSON.parse(fs.readFileSync(c, 'utf-8')) as Record<string, unknown>;
            const ado = (j.ado ?? j.azureDevOps ?? j) as Record<string, unknown>;
            const organization = (ado.organization ?? '') as string;
            const proj = (ado.project ?? '') as string;
            const baseUrl = ((ado.baseUrl ?? 'https://dev.azure.com') as string).replace(/\/$/, '');
            const rawToken = ((ado.personalAccessToken ?? ado.pat ?? ado.token ?? '') as string).trim();
            const localOrgUrl = (ado.orgUrl as string) || (organization ? `${baseUrl}/${organization}` : '');
            if (!orgUrl && localOrgUrl) orgUrl = localOrgUrl;
            if (!project && proj) project = proj;
            if (!pat && rawToken && !PAT_PLACEHOLDERS.has(rawToken)) {
                const decrypted = decryptIfNeeded(rawToken, workspaceRoot);
                if (decrypted) pat = decrypted;
            }
        } catch { /* ignore */ }
    }
    if (!orgUrl && process.env.ADO_ORG_URL) orgUrl = process.env.ADO_ORG_URL;
    if (!project && process.env.ADO_PROJECT) project = process.env.ADO_PROJECT;
    if (!pat) pat = process.env.ADO_PAT || process.env.AZURE_DEVOPS_EXT_PAT || process.env.AZURE_DEVOPS_TOKEN || process.env.AZURE_DEVOPS_PAT || process.env.ADO_PERSONAL_ACCESS_TOKEN || '';
    if (!orgUrl || !project || !pat) return null;
    return { orgUrl, project, pat };
}

// =============================================================================
// ADO REST helper. Retains adoRequest's return-any-JSON shape so 200/201/204
// bodies all pass through the same call site.
// =============================================================================

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

interface AdoResponse {
    ok: boolean;
    status: number;
    body: unknown;
    errorText?: string;
}

async function adoRequest(cfg: AdoCreds, method: HttpMethod, urlPath: string, body?: unknown, contentType = 'application/json'): Promise<AdoResponse> {
    const auth = Buffer.from(`:${cfg.pat}`).toString('base64');
    const url = `${cfg.orgUrl.replace(/\/$/, '')}/${cfg.project}/${urlPath.replace(/^\//, '')}`;
    const res = await fetch(url, {
        method,
        headers: {
            Authorization: `Basic ${auth}`,
            Accept: 'application/json',
            ...(body !== undefined ? { 'Content-Type': contentType } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text().catch(() => '');
    let parsed: unknown = {};
    if (text) {
        try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    }
    if (!res.ok) {
        return { ok: false, status: res.status, body: parsed, errorText: text.slice(0, 500) };
    }
    return { ok: true, status: res.status, body: parsed };
}

// =============================================================================
// Helpers: resolve plan root suite, list suites, list test cases in a suite,
// create a suite, batch-add, batch-remove, delete work item.
// =============================================================================

interface SuiteRef {
    id: number;
    name: string;
    parentSuiteId?: number;
}

async function getPlanRootSuiteId(cfg: AdoCreds, planId: number): Promise<number | null> {
    const r = await adoRequest(cfg, 'GET', `_apis/testplan/plans/${planId}?api-version=7.0`);
    if (!r.ok) return null;
    const plan = r.body as { rootSuite?: { id?: number } };
    return plan.rootSuite?.id ?? null;
}

async function listSuitesInPlan(cfg: AdoCreds, planId: number): Promise<SuiteRef[]> {
    const r = await adoRequest(cfg, 'GET', `_apis/testplan/plans/${planId}/suites?api-version=7.0`);
    if (!r.ok) return [];
    const body = r.body as { value?: Array<{ id: number; name?: string; parentSuite?: { id?: number } }> };
    return (body.value || []).map((s) => ({ id: s.id, name: s.name || '', parentSuiteId: s.parentSuite?.id }));
}

async function createSuite(cfg: AdoCreds, planId: number, parentSuiteId: number, name: string): Promise<{ id: number; name: string } | null> {
    const r = await adoRequest(cfg, 'POST', `_apis/testplan/plans/${planId}/suites?api-version=7.0`, { suiteType: 'StaticTestSuite', name, parentSuite: { id: parentSuiteId } });
    if (!r.ok) return null;
    const body = r.body as { id?: number; name?: string };
    if (typeof body.id !== 'number') return null;
    return { id: body.id, name: body.name || name };
}

interface SuiteMember {
    id: number;
    title?: string;
}

async function listTestCasesInSuite(cfg: AdoCreds, planId: number, suiteId: number): Promise<SuiteMember[]> {
    const r = await adoRequest(cfg, 'GET', `_apis/testplan/plans/${planId}/suites/${suiteId}/TestCase?api-version=7.0`);
    if (!r.ok) return [];
    const body = r.body as { value?: Array<{ workItem?: { id?: number; name?: string } }> };
    return (body.value || [])
        .map((v) => ({ id: Number(v.workItem?.id || 0), title: v.workItem?.name }))
        .filter((m) => m.id > 0);
}

async function addTestCasesToSuite(cfg: AdoCreds, planId: number, suiteId: number, testCaseIds: number[]): Promise<AdoResponse> {
    const body = testCaseIds.map((id) => ({ workItem: { id } }));
    return adoRequest(cfg, 'POST', `_apis/testplan/plans/${planId}/suites/${suiteId}/TestCase?api-version=7.0`, body);
}

/**
 * Batch remove test cases from a suite (membership only — work items untouched).
 *
 * Per Microsoft docs (learn.microsoft.com/rest/api/azure/devops/testplan/suite-test-case/remove-test-cases-from-suite):
 *   DELETE .../_apis/testplan/Plans/{planId}/Suites/{suiteId}/TestCase?testCaseIds={ids}&api-version=7.1
 *
 * Two things the original impl got wrong (produced HTTP 405 on real ADO):
 *  - testCaseIds is a QUERY parameter, not a path segment. Putting `/TestCase/{ids}`
 *    made ADO route to a resource-specific URL that only accepts GET; DELETE
 *    returned 405 "method not allowed on this resource".
 *  - Path casing matters for some ADO instances — the doc's URI uses `Plans`,
 *    `Suites`, `TestCase` (Pascal-case). Cloud dev.azure.com is often
 *    case-insensitive; on-prem TFS/ADO Server sometimes is not.
 */
async function removeTestCasesFromSuite(cfg: AdoCreds, planId: number, suiteId: number, testCaseIds: number[]): Promise<AdoResponse> {
    const ids = testCaseIds.join(',');
    return adoRequest(cfg, 'DELETE', `_apis/testplan/Plans/${planId}/Suites/${suiteId}/TestCase?testCaseIds=${ids}&api-version=7.1`);
}

/**
 * Delete a test-case work item.
 *
 * The generic `_apis/wit/workitems/{id}?destroy=...` endpoint REJECTS test-case
 * work items with HTTP 400 "cannot delete or restore test work items. It
 * requires the Test Management REST API." Test cases have their own delete
 * endpoint under the /test/ namespace.
 *
 *  Soft delete (destroy=false):
 *    DELETE .../_apis/test/testcases/{testCaseId}?api-version=7.1
 *    (sends to recycle bin, recoverable within org retention window)
 *
 *  Permanent delete (destroy=true): two-step because the ADO API doesn't offer
 *  a single-shot destroy for test cases:
 *    1. Soft delete via /_apis/test/testcases/{id}     → sends to recycle bin
 *    2. Recycle-bin destroy via /_apis/wit/recyclebin/{id}   → permanent
 *  Refs: learn.microsoft.com/rest/api/azure/devops/test/test-cases/delete
 *        learn.microsoft.com/rest/api/azure/devops/wit/recyclebin/destroy-work-item
 */
async function deleteWorkItem(cfg: AdoCreds, id: number, destroy: boolean): Promise<AdoResponse> {
    // Step 1: soft delete via the Test service endpoint
    const softRes = await adoRequest(cfg, 'DELETE', `_apis/test/testcases/${id}?api-version=7.1`);
    if (!destroy) return softRes;

    // Step 2: destroy from recycle bin for permanent removal
    return adoRequest(cfg, 'DELETE', `_apis/wit/recyclebin/${id}?api-version=7.1`);
}

/** Delete a whole suite (child sub-suites cascade automatically per ADO docs). */
async function deleteSuiteApi(cfg: AdoCreds, planId: number, suiteId: number): Promise<AdoResponse> {
    return adoRequest(cfg, 'DELETE', `_apis/testplan/Plans/${planId}/suites/${suiteId}?api-version=7.1`);
}

/** Delete a whole plan (child suites cascade automatically per ADO docs). */
async function deletePlanApi(cfg: AdoCreds, planId: number): Promise<AdoResponse> {
    return adoRequest(cfg, 'DELETE', `_apis/testplan/plans/${planId}?api-version=7.1`);
}

// =============================================================================
// Zod schemas.
// =============================================================================

const MoveSchema = z.object({
    verb: z.literal('move'),
    sourcePlanId: z.number().int().positive().optional().describe('ADO test plan ID that currently contains the test cases. Alternative: sourcePlanName.'),
    sourcePlanName: z.string().min(1).optional().describe('Name of the source plan — resolved to sourcePlanId at run time. Mismatch with sourcePlanId → warning, id wins.'),
    sourceSuiteId: z.number().int().positive().optional().describe('Suite ID within sourcePlanId. If omitted (and no sourceSuiteName), the plan\'s root suite is used.'),
    sourceSuiteName: z.string().min(1).optional().describe('Name of the source suite — resolved within the source plan. Requires source plan to be resolved first.'),
    targetPlanId: z.number().int().positive().optional().describe('ADO test plan ID that will receive the test cases (may equal sourcePlanId). Alternative: targetPlanName.'),
    targetPlanName: z.string().min(1).optional().describe('Name of the target plan — resolved to targetPlanId at run time.'),
    targetSuiteId: z.number().int().positive().optional().describe('Explicit target suite ID. When present, targetSuiteName and createTargetSuiteIfMissing are IGNORED.'),
    targetSuiteName: z.string().optional().describe('Used with createTargetSuiteIfMissing when targetSuiteId is absent — matched against suites under the target plan\'s root.'),
    createTargetSuiteIfMissing: z.boolean().default(true).describe('When target-by-name lookup finds no match, create the suite as a child of target plan\'s root.'),
    testCaseIds: z.array(z.number().int().positive()).optional().describe('If omitted (and no testCaseNames), ALL test cases in the source suite are moved.'),
    testCaseNames: z.array(z.string().min(1)).optional().describe('Names of test cases to move — resolved to IDs via WIQL (or scoped to source suite when both source plan+suite are known).'),
    syncBackTags: z.boolean().default(true).describe('After a successful move, update `@TestPlanId` / `@TestSuiteId` tags in any `.feature` file whose scenario carries a moved `@TestCaseId`. Non-fatal — a sync failure logs a warning but does not fail the ADO op.'),
    syncBackScanRoot: z.string().optional().describe('Narrow the sync-back scan to this directory (default: `<workspaceRoot>/test`, recursive).'),
    dryRun: z.boolean().default(false).describe('Preview only — no writes performed.'),
}).refine((v) => v.sourcePlanId !== undefined || v.sourcePlanName !== undefined, { message: 'sourcePlanId or sourcePlanName required' })
   .refine((v) => v.targetPlanId !== undefined || v.targetPlanName !== undefined, { message: 'targetPlanId or targetPlanName required' });

const RemoveFromSuiteSchema = z.object({
    verb: z.literal('remove-from-suite'),
    planId: z.number().int().positive().optional().describe('ADO test plan ID. Alternative: planName.'),
    planName: z.string().min(1).optional().describe('Plan name — resolved to planId at run time.'),
    suiteId: z.number().int().positive().optional().describe('Suite ID within planId. Alternative: suiteName.'),
    suiteName: z.string().min(1).optional().describe('Suite name — resolved within the plan.'),
    testCaseIds: z.array(z.number().int().positive()).optional().describe('If omitted (and no testCaseNames), ALL test cases in the suite are removed. Work items themselves are NOT deleted — this is a non-destructive membership change.'),
    testCaseNames: z.array(z.string().min(1)).optional().describe('Names of test cases — resolved scoped to the given plan+suite (falls back to project-wide WIQL if scope lookup fails).'),
    syncBackTags: z.boolean().default(true).describe('After a successful remove, strip the removed IDs from any `@TestCaseId:{...}` braces (or drop bare `@TestCaseId` tags entirely). `@TestPlanId` / `@TestSuiteId` are left alone. Non-fatal — a sync failure logs a warning but does not fail the ADO op.'),
    syncBackScanRoot: z.string().optional().describe('Narrow the sync-back scan to this directory (default: `<workspaceRoot>/test`, recursive).'),
    dryRun: z.boolean().default(false).describe('Preview only — no writes performed.'),
}).refine((v) => v.planId !== undefined || v.planName !== undefined, { message: 'planId or planName required' })
   .refine((v) => v.suiteId !== undefined || v.suiteName !== undefined, { message: 'suiteId or suiteName required' });

const DeleteSchema = z.object({
    verb: z.literal('delete'),
    testCaseIds: z.array(z.number().int().positive()).optional().describe('Work-item IDs to delete. Alternative: testCaseNames.'),
    testCaseNames: z.array(z.string().min(1)).optional().describe('Names of test cases — resolved to IDs project-wide via WIQL.'),
    destroy: z.boolean().default(false).describe('false = soft delete (recycle bin, recoverable). true = permanent (bypasses recycle bin, UNRECOVERABLE).'),
    syncBackTags: z.boolean().default(true).describe('After a successful delete, strip the deleted IDs from any `@TestCaseId` tags in the workspace `.feature` files. Non-fatal — a sync failure logs a warning but does not fail the ADO op.'),
    syncBackScanRoot: z.string().optional().describe('Narrow the sync-back scan to this directory (default: `<workspaceRoot>/test`, recursive).'),
    dryRun: z.boolean().default(false).describe('Preview only — no writes performed.'),
    confirmed: z.boolean().default(false).describe('DESTRUCTIVE-OP CONFIRMATION GATE. When dryRun:false and confirmed:false, the tool AUTO-RUNS a dry-run and returns requiresConfirmation:true — no write happens. To actually delete, retry the SAME call with confirmed:true. Never set confirmed:true without first showing the dry-run preview to the human.'),
}).refine((v) => (v.testCaseIds && v.testCaseIds.length > 0) || (v.testCaseNames && v.testCaseNames.length > 0), { message: 'testCaseIds or testCaseNames required (at least one non-empty)' });

const DeleteSuiteSchema = z.object({
    verb: z.literal('delete-suite'),
    planId: z.number().int().positive().optional(),
    planName: z.string().min(1).optional(),
    suiteId: z.number().int().positive().optional(),
    suiteName: z.string().min(1).optional(),
    cascadeTestCases: z.boolean().default(false).describe('true = also delete every test-case work item inside the suite (and its sub-suites). false = ADO leaves cases as orphans (still exist as work items, just no longer in the suite tree).'),
    cascadeSkipCasesInOtherSuites: z.boolean().default(false).describe('Only relevant when cascadeTestCases=true. When true, cases that also appear in OTHER suites (via GET /test/suites?testCaseId=...) are skipped — safer, avoids orphaning multi-owned cases.'),
    destroy: z.boolean().default(false).describe('When cascadeTestCases=true, controls whether cases are soft-deleted (default) or permanently destroyed.'),
    dryRun: z.boolean().default(false),
    confirmed: z.boolean().default(false).describe('DESTRUCTIVE-OP CONFIRMATION GATE. When dryRun:false and confirmed:false, the tool AUTO-RUNS a dry-run and returns requiresConfirmation:true — no write happens. To actually delete the suite, retry the SAME call with confirmed:true. Never set confirmed:true without first showing the dry-run preview to the human.'),
    syncBackTags: z.boolean().default(true),
    syncBackScanRoot: z.string().optional(),
}).refine((v) => v.planId !== undefined || v.planName !== undefined, { message: 'planId or planName required' })
   .refine((v) => v.suiteId !== undefined || v.suiteName !== undefined, { message: 'suiteId or suiteName required' });

const DeletePlanSchema = z.object({
    verb: z.literal('delete-plan'),
    planId: z.number().int().positive().optional(),
    planName: z.string().min(1).optional(),
    cascadeTestCases: z.boolean().default(false).describe('true = enumerate every case in every suite of the plan and delete each. false = only the plan (and its suites, which auto-cascade) is deleted; cases live on as orphaned work items.'),
    destroy: z.boolean().default(false).describe('When cascadeTestCases=true, controls whether cases are soft-deleted (default) or permanently destroyed.'),
    dryRun: z.boolean().default(false),
    confirmed: z.boolean().default(false).describe('DESTRUCTIVE-OP CONFIRMATION GATE. When dryRun:false and confirmed:false, the tool AUTO-RUNS a dry-run and returns requiresConfirmation:true — no write happens. To actually delete the plan, retry the SAME call with confirmed:true. Never set confirmed:true without first showing the dry-run preview to the human.'),
    syncBackTags: z.boolean().default(true),
    syncBackScanRoot: z.string().optional(),
}).refine((v) => v.planId !== undefined || v.planName !== undefined, { message: 'planId or planName required' });

const InputSchema = z.discriminatedUnion('verb', [MoveSchema, RemoveFromSuiteSchema, DeleteSchema, DeleteSuiteSchema, DeletePlanSchema]);
type Input = z.infer<typeof InputSchema>;

const OutcomeRowSchema = z.object({
    id: z.number(),
    title: z.string().optional(),
    reason: z.string().optional(),
    note: z.string().optional(),
});

const SyncBackFileSchema = z.object({
    filePath: z.string(),
    fileChanged: z.boolean(),
    scenariosPatched: z.number(),
    hoistedToFeatureLevel: z.array(z.string()),
    demotedToScenarioLevel: z.array(z.string()),
    tagsAdded: z.number(),
    tagsRemoved: z.number(),
    tagsUnchanged: z.number(),
    driftWarnings: z.array(z.string()),
});

const AmbiguityCandidateSchema = z.object({
    id: z.number(),
    name: z.string(),
    note: z.string().optional(),
});

const OutputSchema = z.object({
    verb: z.string(),
    dryRun: z.boolean(),
    sourcePlanId: z.number().optional(),
    sourceSuiteId: z.number().optional(),
    targetPlanId: z.number().optional(),
    targetSuiteIdUsed: z.number().optional(),
    targetSuiteCreated: z.boolean().optional(),
    // delete-suite / delete-plan
    deletedSuiteIds: z.array(z.number()).optional(),
    deletedSuiteNames: z.array(z.string()).optional(),
    deletedPlanId: z.number().optional(),
    deletedPlanName: z.string().optional(),
    moved: z.array(OutcomeRowSchema).default([]),
    addedOnly: z.array(OutcomeRowSchema).default([]),
    removed: z.array(OutcomeRowSchema).default([]),
    deleted: z.array(OutcomeRowSchema).default([]),
    skipped: z.array(OutcomeRowSchema).default([]),
    failed: z.array(OutcomeRowSchema).default([]),
    // Ambiguity is a HARD stop — no writes were attempted.
    ambiguous: z.boolean().optional(),
    ambiguousCandidates: z.array(AmbiguityCandidateSchema).optional(),
    notFound: z.array(z.string()).default([]),
    totals: z.object({
        enumerated: z.number(),
        succeeded: z.number(),
        failed: z.number(),
        warnings: z.number(),
    }),
    warnings: z.array(z.string()).default([]),
    note: z.string().optional(),
    syncBack: z.array(SyncBackFileSchema).default([]),
});
type Output = z.infer<typeof OutputSchema>;

// =============================================================================
// Small utility — a "config missing" output that keeps the shape stable.
// =============================================================================

function noAdoOutput(verb: string, dryRun: boolean): Output {
    return {
        verb,
        dryRun,
        moved: [], addedOnly: [], removed: [], deleted: [], skipped: [], failed: [],
        notFound: [],
        totals: { enumerated: 0, succeeded: 0, failed: 0, warnings: 1 },
        warnings: ['ADO not configured. Set ado.personalAccessToken in cs-playwright-mcp.config.json (ENCRYPTED:... value) OR ADO_PAT env var OR ~/.cs-qa/ado-config.json.'],
        note: 'ADO not configured — nothing performed.',
        syncBack: [],
    };
}

/**
 * Convert sync_feature_tags SyncResult[] → the tool-output shape (only
 * files with actual changes are surfaced; unchanged files stay silent).
 */
function toOutputSyncBack(results: SyncResult[]): z.infer<typeof SyncBackFileSchema>[] {
    return results
        .filter((r) => r.fileChanged || r.driftWarnings.length > 0)
        .map((r) => ({
            filePath: r.filePath,
            fileChanged: r.fileChanged,
            scenariosPatched: r.scenariosPatched,
            hoistedToFeatureLevel: r.hoistedToFeatureLevel,
            demotedToScenarioLevel: r.demotedToScenarioLevel,
            tagsAdded: r.tagsAdded,
            tagsRemoved: r.tagsRemoved,
            tagsUnchanged: r.tagsUnchanged,
            driftWarnings: r.driftWarnings,
        }));
}

/**
 * Emit an ambiguity-stop output. No writes were attempted — the caller (skill)
 * should present the candidates and re-run the verb with a specific id.
 */
function ambiguityOutput(verb: string, dryRun: boolean, msg: string, candidates: Array<{ id: number; name: string; note?: string }>): Output {
    return {
        verb, dryRun,
        moved: [], addedOnly: [], removed: [], deleted: [], skipped: [], failed: [],
        notFound: [],
        ambiguous: true,
        ambiguousCandidates: candidates,
        totals: { enumerated: 0, succeeded: 0, failed: 0, warnings: 1 },
        warnings: [msg],
        note: `Ambiguous name — ${candidates.length} candidates. No writes performed. Pass an explicit id to disambiguate.`,
        syncBack: [],
    };
}

// =============================================================================
// Verb: move.
//
// CRITICAL ORDERING: enumerate → dryRun-if-set → add-to-target → remove-from-source.
// Never remove from source before add succeeds, so a failed add can't lose the
// test case. 409 on add means "already present in target" — we treat that as
// added (per ADO's idempotent shape) and proceed with the remove.
// =============================================================================

async function runMove(input: z.infer<typeof MoveSchema>, cfg: AdoCreds | null, workspaceRoot: string): Promise<Output> {
    const warnings: string[] = [];
    const out: Output = {
        verb: 'move', dryRun: input.dryRun,
        moved: [], addedOnly: [], removed: [], deleted: [], skipped: [], failed: [], syncBack: [],
        notFound: [],
        totals: { enumerated: 0, succeeded: 0, failed: 0, warnings: 0 },
        warnings,
    };

    if (!cfg) return noAdoOutput('move', input.dryRun);

    const cache: ResolverCache = createCache();
    const resolverCfg: ResolverCreds = cfg;

    // 1. Resolve source plan.
    const srcPlan = await resolvePlan(resolverCfg, { planId: input.sourcePlanId, planName: input.sourcePlanName }, cache);
    warnings.push(...srcPlan.warnings);
    if (srcPlan.ambiguous) return ambiguityOutput('move', input.dryRun, `Ambiguous sourcePlanName "${input.sourcePlanName}"`, srcPlan.candidates || []);
    if (srcPlan.resolved.length === 0) {
        out.failed.push({ id: 0, reason: `Source plan not found: ${input.sourcePlanId ?? input.sourcePlanName}` });
        out.notFound = srcPlan.notFound;
        out.totals.failed = 1;
        out.note = 'source plan resolution failed';
        return out;
    }
    const sourcePlanId = srcPlan.resolved[0].id;
    out.sourcePlanId = sourcePlanId;

    // 2. Resolve source suite (defaults to plan root if neither id nor name given).
    let sourceSuiteId = input.sourceSuiteId;
    if (!sourceSuiteId && input.sourceSuiteName) {
        const srcSuite = await resolveSuite(resolverCfg, { planId: sourcePlanId, suiteName: input.sourceSuiteName }, cache);
        warnings.push(...srcSuite.warnings);
        if (srcSuite.ambiguous) return ambiguityOutput('move', input.dryRun, `Ambiguous sourceSuiteName "${input.sourceSuiteName}"`, srcSuite.candidates || []);
        if (srcSuite.resolved.length === 0) {
            out.failed.push({ id: 0, reason: `Source suite not found in plan ${sourcePlanId}: ${input.sourceSuiteName}` });
            out.notFound = srcSuite.notFound;
            out.totals.failed = 1;
            out.note = 'source suite resolution failed';
            return out;
        }
        sourceSuiteId = srcSuite.resolved[0].id;
    }
    if (!sourceSuiteId) {
        const rootId = await getPlanRootSuiteId(cfg, sourcePlanId);
        if (!rootId) {
            out.failed.push({ id: 0, reason: `Could not resolve root suite for source plan ${sourcePlanId}.` });
            out.totals.failed = 1;
            out.note = 'source plan root suite lookup failed';
            return out;
        }
        sourceSuiteId = rootId;
    }
    out.sourceSuiteId = sourceSuiteId;

    // 3. Resolve target plan.
    const tgtPlan = await resolvePlan(resolverCfg, { planId: input.targetPlanId, planName: input.targetPlanName }, cache);
    warnings.push(...tgtPlan.warnings);
    if (tgtPlan.ambiguous) return ambiguityOutput('move', input.dryRun, `Ambiguous targetPlanName "${input.targetPlanName}"`, tgtPlan.candidates || []);
    if (tgtPlan.resolved.length === 0) {
        out.failed.push({ id: 0, reason: `Target plan not found: ${input.targetPlanId ?? input.targetPlanName}` });
        out.notFound = [...out.notFound, ...tgtPlan.notFound];
        out.totals.failed = 1;
        out.note = 'target plan resolution failed';
        return out;
    }
    const targetPlanId = tgtPlan.resolved[0].id;
    out.targetPlanId = targetPlanId;

    // 4. Resolve destination suite.
    let targetSuiteIdUsed = input.targetSuiteId;
    let targetSuiteCreated = false;
    if (!targetSuiteIdUsed) {
        const targetRoot = await getPlanRootSuiteId(cfg, targetPlanId);
        if (!targetRoot) {
            out.failed.push({ id: 0, reason: `Could not resolve root suite for target plan ${targetPlanId}.` });
            out.totals.failed = 1;
            out.note = 'target plan root suite lookup failed';
            return out;
        }
        if (input.targetSuiteName) {
            const all = await listSuitesInPlan(cfg, targetPlanId);
            const match = all.find((s) => s.name === input.targetSuiteName && s.parentSuiteId === targetRoot);
            if (match) {
                targetSuiteIdUsed = match.id;
            } else if (input.createTargetSuiteIfMissing) {
                if (input.dryRun) {
                    // Preview only — do not create.
                    warnings.push(`[dry-run] Would create target suite "${input.targetSuiteName}" under plan ${targetPlanId} root ${targetRoot}.`);
                } else {
                    const created = await createSuite(cfg, targetPlanId, targetRoot, input.targetSuiteName);
                    if (!created) {
                        out.failed.push({ id: 0, reason: `Failed to create target suite "${input.targetSuiteName}" under plan ${targetPlanId}.` });
                        out.totals.failed = 1;
                        out.note = 'target suite creation failed';
                        return out;
                    }
                    targetSuiteIdUsed = created.id;
                    targetSuiteCreated = true;
                }
            } else {
                out.failed.push({ id: 0, reason: `Target suite "${input.targetSuiteName}" not found and createTargetSuiteIfMissing=false.` });
                out.totals.failed = 1;
                out.note = 'target suite not found; auto-create disabled';
                return out;
            }
        } else {
            // Neither id nor name provided — fall back to target plan's root suite.
            targetSuiteIdUsed = targetRoot;
        }
    }
    out.targetSuiteIdUsed = targetSuiteIdUsed;
    out.targetSuiteCreated = targetSuiteCreated;

    // Same-suite short-circuit (safe no-op).
    if (sourcePlanId === targetPlanId && sourceSuiteId === targetSuiteIdUsed) {
        out.note = 'source and target are the same suite — no-op';
        return out;
    }

    // 5. Resolve test cases (names → ids).
    let explicitIds: number[] | undefined;
    if ((input.testCaseIds && input.testCaseIds.length > 0) || (input.testCaseNames && input.testCaseNames.length > 0)) {
        const tc = await resolveTestCases(resolverCfg, {
            testCaseIds: input.testCaseIds,
            testCaseNames: input.testCaseNames,
            scope: { planId: sourcePlanId, suiteId: sourceSuiteId },
        }, cache);
        warnings.push(...tc.warnings);
        if (tc.ambiguous) return ambiguityOutput('move', input.dryRun, 'One or more testCaseNames matched multiple work items', tc.candidates || []);
        out.notFound = [...out.notFound, ...tc.notFound];
        explicitIds = tc.resolved.map((c) => c.id);
        if (explicitIds.length === 0) {
            out.note = `No test cases resolved (${tc.notFound.length} name(s) not found).`;
            return out;
        }
    }

    // 6. Enumerate.
    let members: SuiteMember[];
    if (explicitIds && explicitIds.length > 0) {
        members = explicitIds.map((id) => ({ id, title: undefined }));
    } else {
        members = await listTestCasesInSuite(cfg, sourcePlanId, sourceSuiteId);
    }
    out.totals.enumerated = members.length;

    if (members.length === 0) {
        out.note = 'No test cases to move (source suite is empty or explicit list was empty).';
        return out;
    }

    // 7. Dry-run stops before any write.
    if (input.dryRun) {
        for (const m of members) out.moved.push({ id: m.id, title: m.title });
        out.note = `[dry-run] Would move ${members.length} test case(s) from plan ${sourcePlanId}/suite ${sourceSuiteId} to plan ${targetPlanId}/suite ${targetSuiteIdUsed ?? '(created)'}. Nothing written.`;
        return out;
    }

    // 8. ADD to destination FIRST. If the add fails, we don't remove from source.
    if (!targetSuiteIdUsed) {
        // Only possible if the dry-run branch above left us without a suite id.
        out.failed.push({ id: 0, reason: 'Target suite ID not resolved (dry-run only creation path).' });
        out.totals.failed = 1;
        return out;
    }

    const addRes = await addTestCasesToSuite(cfg, targetPlanId, targetSuiteIdUsed, members.map((m) => m.id));
    const addOk = addRes.ok || addRes.status === 409;
    if (addRes.status === 409) {
        warnings.push(`Some test case(s) were already in target suite ${targetSuiteIdUsed} (409) — treating as added, proceeding with source removal.`);
    }
    if (!addOk) {
        // Every case failed to add — do NOT remove from source.
        for (const m of members) out.failed.push({ id: m.id, title: m.title, reason: `Add to target failed (status ${addRes.status}): ${addRes.errorText || ''}`.slice(0, 300) });
        out.totals.failed = members.length;
        out.totals.warnings = warnings.length;
        out.note = 'Add to target failed — source is UNCHANGED. Nothing removed.';
        return out;
    }

    // 9. Only after add succeeds, REMOVE from source.
    const removeRes = await removeTestCasesFromSuite(cfg, sourcePlanId, sourceSuiteId, members.map((m) => m.id));
    if (!removeRes.ok) {
        // Add succeeded, remove failed → duplicates exist. Report as addedOnly (warning),
        // not moved. Safer than lying that it moved.
        for (const m of members) out.addedOnly.push({ id: m.id, title: m.title, note: `Added to target but source remove failed (status ${removeRes.status}) — duplicate exists in source. Manual cleanup required.` });
        warnings.push(`Source remove failed for ${members.length} test case(s): ${(removeRes.errorText || '').slice(0, 200)}`);
        out.totals.succeeded = 0;
        out.totals.failed = 0;
        out.totals.warnings = warnings.length;
        out.note = `Added to target ${targetSuiteIdUsed}, but source remove failed — duplicates remain in source suite ${sourceSuiteId}.`;
        return out;
    }

    // Full success.
    for (const m of members) out.moved.push({ id: m.id, title: m.title });
    out.totals.succeeded = members.length;
    out.totals.warnings = warnings.length;
    out.note = `Moved ${members.length} test case(s) from plan ${sourcePlanId}/suite ${sourceSuiteId} to plan ${targetPlanId}/suite ${targetSuiteIdUsed}${targetSuiteCreated ? ' (created)' : ''}.`;

    // Sync-back — non-fatal.
    if (input.syncBackTags && targetSuiteIdUsed) {
        try {
            const moves = members.map((m) => ({ testCaseId: m.id, newTestPlanId: targetPlanId, newTestSuiteId: targetSuiteIdUsed! }));
            const results = syncFeaturesAfterMove(workspaceRoot, moves, input.syncBackScanRoot);
            out.syncBack = toOutputSyncBack(results);
            for (const r of results) for (const dw of r.driftWarnings) warnings.push(`sync-back drift in ${r.filePath}: ${dw}`);
        } catch (e) {
            warnings.push(`sync-back failed: ${(e as Error).message.slice(0, 200)}`);
        }
        out.totals.warnings = warnings.length;
    }
    return out;
}

// =============================================================================
// Verb: remove-from-suite.
//
// Non-destructive: only membership is removed. Work items survive.
// =============================================================================

async function runRemoveFromSuite(input: z.infer<typeof RemoveFromSuiteSchema>, cfg: AdoCreds | null, workspaceRoot: string): Promise<Output> {
    const warnings: string[] = [];
    const out: Output = {
        verb: 'remove-from-suite', dryRun: input.dryRun,
        moved: [], addedOnly: [], removed: [], deleted: [], skipped: [], failed: [], syncBack: [],
        notFound: [],
        totals: { enumerated: 0, succeeded: 0, failed: 0, warnings: 0 },
        warnings,
    };

    if (!cfg) return noAdoOutput('remove-from-suite', input.dryRun);

    const cache: ResolverCache = createCache();
    const resolverCfg: ResolverCreds = cfg;

    // 1. Resolve plan.
    const plan = await resolvePlan(resolverCfg, { planId: input.planId, planName: input.planName }, cache);
    warnings.push(...plan.warnings);
    if (plan.ambiguous) return ambiguityOutput('remove-from-suite', input.dryRun, `Ambiguous planName "${input.planName}"`, plan.candidates || []);
    if (plan.resolved.length === 0) {
        out.failed.push({ id: 0, reason: `Plan not found: ${input.planId ?? input.planName}` });
        out.notFound = plan.notFound;
        out.totals.failed = 1;
        out.note = 'plan resolution failed';
        return out;
    }
    const planId = plan.resolved[0].id;

    // 2. Resolve suite.
    const suite = await resolveSuite(resolverCfg, { planId, suiteId: input.suiteId, suiteName: input.suiteName }, cache);
    warnings.push(...suite.warnings);
    if (suite.ambiguous) return ambiguityOutput('remove-from-suite', input.dryRun, `Ambiguous suiteName "${input.suiteName}"`, suite.candidates || []);
    if (suite.resolved.length === 0) {
        out.failed.push({ id: 0, reason: `Suite not found in plan ${planId}: ${input.suiteId ?? input.suiteName}` });
        out.notFound = [...out.notFound, ...suite.notFound];
        out.totals.failed = 1;
        out.note = 'suite resolution failed';
        return out;
    }
    const suiteId = suite.resolved[0].id;

    // 3. Resolve testCaseNames if provided.
    let explicitIds: number[] | undefined;
    if ((input.testCaseIds && input.testCaseIds.length > 0) || (input.testCaseNames && input.testCaseNames.length > 0)) {
        const tc = await resolveTestCases(resolverCfg, {
            testCaseIds: input.testCaseIds,
            testCaseNames: input.testCaseNames,
            scope: { planId, suiteId },
        }, cache);
        warnings.push(...tc.warnings);
        if (tc.ambiguous) return ambiguityOutput('remove-from-suite', input.dryRun, 'One or more testCaseNames matched multiple work items', tc.candidates || []);
        out.notFound = [...out.notFound, ...tc.notFound];
        explicitIds = tc.resolved.map((c) => c.id);
        if (explicitIds.length === 0) {
            out.note = `No test cases resolved (${tc.notFound.length} name(s) not found).`;
            return out;
        }
    }

    // 4. Enumerate.
    let members: SuiteMember[];
    if (explicitIds && explicitIds.length > 0) {
        members = explicitIds.map((id) => ({ id, title: undefined }));
    } else {
        members = await listTestCasesInSuite(cfg, planId, suiteId);
    }
    out.totals.enumerated = members.length;

    if (members.length === 0) {
        out.note = 'No test cases to remove (suite is empty or explicit list was empty).';
        return out;
    }

    // 5. Dry-run: show plan, no writes.
    if (input.dryRun) {
        for (const m of members) out.removed.push({ id: m.id, title: m.title });
        out.note = `[dry-run] Would remove ${members.length} test case(s) from plan ${planId}/suite ${suiteId} (membership only — work items untouched).`;
        return out;
    }

    // 6. Batch DELETE.
    const res = await removeTestCasesFromSuite(cfg, planId, suiteId, members.map((m) => m.id));
    if (!res.ok) {
        for (const m of members) out.failed.push({ id: m.id, title: m.title, reason: `Batch remove failed (status ${res.status}): ${(res.errorText || '').slice(0, 200)}` });
        out.totals.failed = members.length;
        out.note = 'Remove failed — no membership changes.';
        return out;
    }
    for (const m of members) out.removed.push({ id: m.id, title: m.title });
    out.totals.succeeded = members.length;
    out.note = `Removed ${members.length} test case(s) from plan ${planId}/suite ${suiteId}. Work items themselves are untouched.`;

    // Sync-back — non-fatal.
    if (input.syncBackTags) {
        try {
            const results = syncFeaturesAfterRemoveFromSuite(workspaceRoot, members.map((m) => m.id), input.syncBackScanRoot);
            out.syncBack = toOutputSyncBack(results);
            for (const r of results) for (const dw of r.driftWarnings) warnings.push(`sync-back drift in ${r.filePath}: ${dw}`);
        } catch (e) {
            warnings.push(`sync-back failed: ${(e as Error).message.slice(0, 200)}`);
        }
        out.totals.warnings = warnings.length;
    }
    return out;
}

// =============================================================================
// Verb: delete.
//
// Per-id DELETE — some IDs may fail (already deleted, missing, referenced).
// The endpoint appends `?destroy=true` for the permanent-delete flavour.
// =============================================================================

async function runDelete(input: z.infer<typeof DeleteSchema>, cfg: AdoCreds | null, workspaceRoot: string): Promise<Output> {
    const warnings: string[] = [];
    const out: Output = {
        verb: 'delete', dryRun: input.dryRun,
        moved: [], addedOnly: [], removed: [], deleted: [], skipped: [], failed: [], syncBack: [],
        notFound: [],
        totals: { enumerated: 0, succeeded: 0, failed: 0, warnings: 0 },
        warnings,
    };

    if (!cfg) return noAdoOutput('delete', input.dryRun);

    const cache: ResolverCache = createCache();
    const resolverCfg: ResolverCreds = cfg;

    // 1. Resolve testCaseNames → ids (if provided).
    let ids: number[] = input.testCaseIds ? [...input.testCaseIds] : [];
    if (input.testCaseNames && input.testCaseNames.length > 0) {
        const tc = await resolveTestCases(resolverCfg, {
            testCaseIds: input.testCaseIds,
            testCaseNames: input.testCaseNames,
        }, cache);
        warnings.push(...tc.warnings);
        if (tc.ambiguous) return ambiguityOutput('delete', input.dryRun, 'One or more testCaseNames matched multiple work items', tc.candidates || []);
        out.notFound = [...out.notFound, ...tc.notFound];
        ids = tc.resolved.map((c) => c.id);
    }

    if (ids.length === 0) {
        out.totals.warnings = warnings.length;
        out.note = 'No test cases resolved.';
        return out;
    }

    out.totals.enumerated = ids.length;

    // 2. Dry-run: show plan.
    if (input.dryRun) {
        for (const id of ids) out.deleted.push({ id });
        out.note = input.destroy
            ? `[dry-run] Would PERMANENTLY delete (destroy=true — unrecoverable) ${ids.length} test case(s). Nothing written.`
            : `[dry-run] Would soft-delete (recycle-bin, recoverable) ${ids.length} test case(s). Nothing written.`;
        return out;
    }

    // 3. Per-id DELETE.
    for (const id of ids) {
        const res = await deleteWorkItem(cfg, id, input.destroy);
        if (res.ok) {
            const body = res.body as { fields?: { 'System.Title'?: string } };
            out.deleted.push({ id, title: body.fields?.['System.Title'] });
            out.totals.succeeded++;
        } else {
            out.failed.push({ id, reason: `Delete failed (status ${res.status}): ${(res.errorText || '').slice(0, 200)}` });
            out.totals.failed++;
        }
    }

    const kind = input.destroy ? 'permanently destroyed' : 'soft-deleted (recoverable via recycle bin)';
    out.note = `${out.totals.succeeded}/${ids.length} test case(s) ${kind}. ${out.totals.failed} failed.`;

    // Sync-back — non-fatal. Only sync the IDs that actually succeeded on ADO.
    if (input.syncBackTags && out.deleted.length > 0) {
        try {
            const results = syncFeaturesAfterDelete(workspaceRoot, out.deleted.map((d) => d.id), input.syncBackScanRoot);
            out.syncBack = toOutputSyncBack(results);
            for (const r of results) for (const dw of r.driftWarnings) warnings.push(`sync-back drift in ${r.filePath}: ${dw}`);
        } catch (e) {
            warnings.push(`sync-back failed: ${(e as Error).message.slice(0, 200)}`);
        }
        out.totals.warnings = warnings.length;
    }
    return out;
}

// =============================================================================
// Verb: delete-suite.
//
// Deletes a whole suite. Child sub-suites cascade automatically on the ADO
// side; test-case work items DO NOT cascade unless cascadeTestCases=true.
// =============================================================================

async function runDeleteSuite(input: z.infer<typeof DeleteSuiteSchema>, cfg: AdoCreds | null, workspaceRoot: string): Promise<Output> {
    const warnings: string[] = [];
    const out: Output = {
        verb: 'delete-suite', dryRun: input.dryRun,
        moved: [], addedOnly: [], removed: [], deleted: [], skipped: [], failed: [], syncBack: [],
        notFound: [],
        totals: { enumerated: 0, succeeded: 0, failed: 0, warnings: 0 },
        warnings,
    };

    if (!cfg) return noAdoOutput('delete-suite', input.dryRun);

    const cache: ResolverCache = createCache();
    const resolverCfg: ResolverCreds = cfg;

    // 1. Resolve plan.
    const plan = await resolvePlan(resolverCfg, { planId: input.planId, planName: input.planName }, cache);
    warnings.push(...plan.warnings);
    if (plan.ambiguous) return ambiguityOutput('delete-suite', input.dryRun, `Ambiguous planName "${input.planName}"`, plan.candidates || []);
    if (plan.resolved.length === 0) {
        out.failed.push({ id: 0, reason: `Plan not found: ${input.planId ?? input.planName}` });
        out.notFound = plan.notFound;
        out.totals.failed = 1;
        return out;
    }
    const planId = plan.resolved[0].id;
    out.deletedPlanId = planId;
    out.deletedPlanName = plan.resolved[0].name;

    // 2. Resolve suite.
    const suite = await resolveSuite(resolverCfg, { planId, suiteId: input.suiteId, suiteName: input.suiteName }, cache);
    warnings.push(...suite.warnings);
    if (suite.ambiguous) return ambiguityOutput('delete-suite', input.dryRun, `Ambiguous suiteName "${input.suiteName}"`, suite.candidates || []);
    if (suite.resolved.length === 0) {
        out.failed.push({ id: 0, reason: `Suite not found in plan ${planId}: ${input.suiteId ?? input.suiteName}` });
        out.notFound = [...out.notFound, ...suite.notFound];
        out.totals.failed = 1;
        return out;
    }
    const suiteId = suite.resolved[0].id;
    const suiteName = suite.resolved[0].name;

    // 3. Collect nested sub-suites of the target (they will auto-cascade).
    const allSuites = await listAllSuitesInPlan(resolverCfg, planId, cache);
    const nested = collectNestedSuites(allSuites, suiteId);
    // Include target itself in the nested list.
    if (!nested.some((s) => s.id === suiteId)) nested.unshift({ id: suiteId, name: suiteName });
    out.deletedSuiteIds = nested.map((s) => s.id);
    out.deletedSuiteNames = nested.map((s) => s.name);

    // 4. Enumerate test cases in target + all nested sub-suites (needed for dryRun + cascade).
    const casesInSuites = new Map<number, { id: number; name: string; inSuites: number[] }>();
    for (const s of nested) {
        const list = await resolverListTestCasesInSuite(resolverCfg, planId, s.id, cache);
        for (const c of list) {
            const existing = casesInSuites.get(c.id);
            if (existing) existing.inSuites.push(s.id);
            else casesInSuites.set(c.id, { id: c.id, name: c.name, inSuites: [s.id] });
        }
    }
    const allCases = Array.from(casesInSuites.values());
    out.totals.enumerated = allCases.length;

    // 5. If cascadeSkipCasesInOtherSuites, filter out cases that live in other suites.
    let casesToDelete: Array<{ id: number; name: string }> = [];
    const skipped: Array<{ id: number; name: string; reason: string }> = [];
    if (input.cascadeTestCases) {
        const deletedSuiteSet = new Set(nested.map((s) => s.id));
        if (input.cascadeSkipCasesInOtherSuites) {
            for (const c of allCases) {
                const otherSuites = await listSuitesContainingCase(resolverCfg, c.id, cache);
                const inOthers = otherSuites.filter((s) => !deletedSuiteSet.has(s.suiteId));
                if (inOthers.length > 0) {
                    skipped.push({ id: c.id, name: c.name, reason: `also in ${inOthers.length} other suite(s) — skipped to avoid orphaning.` });
                } else {
                    casesToDelete.push(c);
                }
            }
        } else {
            casesToDelete = allCases;
        }
        for (const s of skipped) out.skipped.push({ id: s.id, title: s.name, reason: s.reason });
    }

    // 6. Dry-run: report plan + cases, no writes.
    if (input.dryRun) {
        if (input.cascadeTestCases) for (const c of casesToDelete) out.deleted.push({ id: c.id, title: c.name });
        const sampleNames = casesToDelete.slice(0, 5).map((c) => c.name).filter(Boolean).join(', ');
        out.note = `[dry-run] Would delete suite "${suiteName}" (id ${suiteId}) from plan ${planId}. ${nested.length - 1} nested sub-suite(s) would auto-cascade. ${allCases.length} test case(s) live in the target subtree${input.cascadeTestCases ? `; ${casesToDelete.length} would be ${input.destroy ? 'PERMANENTLY destroyed' : 'soft-deleted'}` : ' (they would be left as orphaned work items)'}${sampleNames ? ` — sample: ${sampleNames}` : ''}. Nothing written.`;
        return out;
    }

    // 7. Live.
    // 7a. Cascade cases first.
    if (input.cascadeTestCases) {
        for (const c of casesToDelete) {
            const r = await deleteWorkItem(cfg, c.id, input.destroy);
            if (r.ok) {
                out.deleted.push({ id: c.id, title: c.name });
                out.totals.succeeded++;
            } else {
                out.failed.push({ id: c.id, title: c.name, reason: `Delete failed (status ${r.status}): ${(r.errorText || '').slice(0, 200)}` });
                out.totals.failed++;
            }
        }
    }

    // 7b. Delete the suite itself.
    const suiteRes = await deleteSuiteApi(cfg, planId, suiteId);
    if (!suiteRes.ok) {
        out.failed.push({ id: suiteId, title: suiteName, reason: `Suite delete failed (status ${suiteRes.status}): ${(suiteRes.errorText || '').slice(0, 200)}` });
        out.totals.failed++;
        out.note = `Failed to delete suite ${suiteId}${input.cascadeTestCases ? ` — ${out.deleted.length} case(s) were already deleted before the suite delete failed.` : ''}.`;
        return out;
    }

    const casesMsg = input.cascadeTestCases
        ? `Cascade-deleted ${out.deleted.length} case(s) (${input.destroy ? 'permanent' : 'soft'})${out.skipped.length > 0 ? `, skipped ${out.skipped.length}` : ''}. `
        : `Suite deleted; ${allCases.length} case(s) survive as orphaned work items. `;
    out.note = `${casesMsg}Suite "${suiteName}" (id ${suiteId}) deleted from plan ${planId}. ${nested.length - 1} sub-suite(s) auto-cascaded.`;

    // 8. Sync-back. Pass `allCases` as suite members so the sync fn can strip
    // @TestCaseId tags from scenarios whose suite was deleted, even when
    // cascadeTestCases:false (TCs survive as orphans in ADO but the scenario
    // no longer has an ADO home under this suite/plan).
    if (input.syncBackTags) {
        try {
            const results = syncFeaturesAfterSuiteDeleted(
                workspaceRoot,
                nested.map((s) => s.id),
                planId,
                input.cascadeTestCases ? out.deleted.map((d) => d.id) : [],
                input.syncBackScanRoot,
                allCases.map((c) => c.id),
            );
            out.syncBack = toOutputSyncBack(results);
            for (const r of results) for (const dw of r.driftWarnings) warnings.push(`sync-back drift in ${r.filePath}: ${dw}`);
        } catch (e) {
            warnings.push(`sync-back failed: ${(e as Error).message.slice(0, 200)}`);
        }
    }
    out.totals.warnings = warnings.length;
    return out;
}

// =============================================================================
// Verb: delete-plan.
//
// Most destructive verb. Deletes an entire plan — child suites auto-cascade on
// the ADO side; test-case work items don't cascade unless cascadeTestCases=true.
// =============================================================================

async function runDeletePlan(input: z.infer<typeof DeletePlanSchema>, cfg: AdoCreds | null, workspaceRoot: string): Promise<Output> {
    const warnings: string[] = [];
    const out: Output = {
        verb: 'delete-plan', dryRun: input.dryRun,
        moved: [], addedOnly: [], removed: [], deleted: [], skipped: [], failed: [], syncBack: [],
        notFound: [],
        totals: { enumerated: 0, succeeded: 0, failed: 0, warnings: 0 },
        warnings,
    };

    if (!cfg) return noAdoOutput('delete-plan', input.dryRun);

    const cache: ResolverCache = createCache();
    const resolverCfg: ResolverCreds = cfg;

    // 1. Resolve plan.
    const plan = await resolvePlan(resolverCfg, { planId: input.planId, planName: input.planName }, cache);
    warnings.push(...plan.warnings);
    if (plan.ambiguous) return ambiguityOutput('delete-plan', input.dryRun, `Ambiguous planName "${input.planName}"`, plan.candidates || []);
    if (plan.resolved.length === 0) {
        out.failed.push({ id: 0, reason: `Plan not found: ${input.planId ?? input.planName}` });
        out.notFound = plan.notFound;
        out.totals.failed = 1;
        return out;
    }
    const planId = plan.resolved[0].id;
    out.deletedPlanId = planId;
    out.deletedPlanName = plan.resolved[0].name;

    // 2. Enumerate every suite in the plan.
    const allSuites = await listAllSuitesInPlan(resolverCfg, planId, cache);
    out.deletedSuiteIds = allSuites.map((s) => s.id);
    out.deletedSuiteNames = allSuites.map((s) => s.name);

    // 3. If cascadeTestCases: enumerate all cases across all suites (dedupe).
    const casesById = new Map<number, { id: number; name: string }>();
    if (input.cascadeTestCases) {
        for (const s of allSuites) {
            const list = await resolverListTestCasesInSuite(resolverCfg, planId, s.id, cache);
            for (const c of list) casesById.set(c.id, c);
        }
    }
    const allCases = Array.from(casesById.values());
    out.totals.enumerated = allCases.length;

    // 4. Dry-run report.
    if (input.dryRun) {
        if (input.cascadeTestCases) for (const c of allCases) out.deleted.push({ id: c.id, title: c.name });
        const sampleNames = allCases.slice(0, 5).map((c) => c.name).filter(Boolean).join(', ');
        out.note = `[dry-run] Would delete plan "${plan.resolved[0].name}" (id ${planId}). ${allSuites.length} suite(s) would auto-cascade${input.cascadeTestCases ? `; ${allCases.length} test case(s) would be ${input.destroy ? 'PERMANENTLY destroyed' : 'soft-deleted'}` : `; ${allCases.length} case(s) would survive as orphaned work items`}${sampleNames ? ` — sample: ${sampleNames}` : ''}. Nothing written.`;
        return out;
    }

    // 5. Live.
    // 5a. Cascade cases first.
    if (input.cascadeTestCases) {
        for (const c of allCases) {
            const r = await deleteWorkItem(cfg, c.id, input.destroy);
            if (r.ok) {
                out.deleted.push({ id: c.id, title: c.name });
                out.totals.succeeded++;
            } else {
                out.failed.push({ id: c.id, title: c.name, reason: `Delete failed (status ${r.status}): ${(r.errorText || '').slice(0, 200)}` });
                out.totals.failed++;
            }
        }
    }

    // 5b. Delete the plan itself.
    const planRes = await deletePlanApi(cfg, planId);
    if (!planRes.ok) {
        out.failed.push({ id: planId, title: plan.resolved[0].name, reason: `Plan delete failed (status ${planRes.status}): ${(planRes.errorText || '').slice(0, 200)}` });
        out.totals.failed++;
        out.note = `Failed to delete plan ${planId}${input.cascadeTestCases ? ` — ${out.deleted.length} case(s) were already deleted before the plan delete failed.` : ''}.`;
        return out;
    }

    const casesMsg = input.cascadeTestCases
        ? `Cascade-deleted ${out.deleted.length} case(s) (${input.destroy ? 'permanent' : 'soft'}). `
        : `Plan deleted; ${allCases.length} case(s) survive as orphaned work items. `;
    out.note = `${casesMsg}Plan "${plan.resolved[0].name}" (id ${planId}) deleted. ${allSuites.length} suite(s) auto-cascaded.`;

    // 6. Sync-back.
    if (input.syncBackTags) {
        try {
            const results = syncFeaturesAfterPlanDeleted(
                workspaceRoot,
                planId,
                input.cascadeTestCases ? out.deleted.map((d) => d.id) : [],
                input.syncBackScanRoot,
            );
            out.syncBack = toOutputSyncBack(results);
            for (const r of results) for (const dw of r.driftWarnings) warnings.push(`sync-back drift in ${r.filePath}: ${dw}`);
        } catch (e) {
            warnings.push(`sync-back failed: ${(e as Error).message.slice(0, 200)}`);
        }
    }
    out.totals.warnings = warnings.length;
    return out;
}

// =============================================================================
// Registration.
// =============================================================================

registerPrimitive<Input, Output>({
    name: 'cs_qa_ado_testcases_manage',
    description:
        'Manage ADO test-case membership + lifecycle + whole-suite/plan deletion. ' +
        'ALL FIELDS ARE FLAT AT TOP LEVEL — never nest under `plan`, `suite`, `testCase`, `sourcePlan`, `targetPlan`, `sourceSuite`, or `targetSuite` objects. Use `planId` (integer) or `planName` (string), `suiteId` (integer) or `suiteName` (string), `testCaseIds` (integer[]) or `testCaseNames` (string[]). Both id and name may be provided; mismatch warns and id wins. Name resolution: unique match → OK; ambiguous → tool returns ambiguousCandidates and stops (no writes); not-found → tool reports and stops. ' +
        'Every verb supports dryRun (boolean, default false). ' +
        'DESTRUCTIVE VERBS (delete, delete-suite, delete-plan) have a BUILT-IN two-phase confirmation. Call ONCE with your target IDs and NO confirmed flag — the tool auto-previews and returns {requiresConfirmation:true, destructive:true, ...dryRunPreview}. Show the preview to the human in the chat message. When (and ONLY when) the human explicitly says yes in the chat, call the tool AGAIN with the SAME inputs plus confirmed:true. Do NOT use elicitation/ask_user for this — the confirmation gate is client-agnostic and lives inside this tool. ' +
        '(1) verb:"move" — relocate test cases between suites/plans. Fields: sourcePlanId|sourcePlanName, sourceSuiteId|sourceSuiteName (optional; defaults to plan root), targetPlanId|targetPlanName, targetSuiteId|targetSuiteName, createTargetSuiteIfMissing (default true), testCaseIds|testCaseNames (optional; omit to move ALL from source). Add fires BEFORE remove. 409 on add is tolerated as "already present". Example: {"verb":"move","sourcePlanId":423,"sourceSuiteId":1203,"targetPlanId":423,"targetSuiteId":1204,"testCaseIds":[9001,9002]} ' +
        '(2) verb:"remove-from-suite" — drop cases from a suite WITHOUT deleting the work items. Fields: planId|planName, suiteId|suiteName, testCaseIds|testCaseNames (optional; omit to remove ALL). Non-destructive. Example: {"verb":"remove-from-suite","planId":423,"suiteId":1203,"testCaseIds":[9001]} ' +
        '(3) verb:"delete" — delete test-case work items. Fields: testCaseIds|testCaseNames, destroy (default false — soft-delete to recycle bin; true = permanent). Example: {"verb":"delete","testCaseIds":[9001],"destroy":false} ' +
        '(4) verb:"delete-suite" — delete a whole suite. Fields: planId|planName, suiteId|suiteName, cascadeTestCases (default false — leave cases as orphaned work items; true = delete them too), cascadeSkipCasesInOtherSuites (only with cascadeTestCases — skip cases that also live in other suites, avoids orphaning), destroy (only with cascadeTestCases). Child sub-suites always auto-cascade on the ADO side. Example: {"verb":"delete-suite","planId":423,"suiteId":1203,"cascadeTestCases":false,"dryRun":true} ' +
        '(5) verb:"delete-plan" — delete a whole plan. Fields: planId|planName, cascadeTestCases (default false), destroy (only with cascadeTestCases). Child suites always auto-cascade on the ADO side. Example: {"verb":"delete-plan","planId":423,"cascadeTestCases":false,"dryRun":true}',
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    run: async (ctx, input) => {
        const cfg = loadAdo(ctx.workspaceRoot);
        // Note: dryRun still tries to load config so live enumeration lookups work.
        if (input.verb === 'move') {
            if (!cfg && input.dryRun) {
                // Pure dry-run with no config → can only preview when caller supplied explicit ids.
                if ((!input.testCaseIds || input.testCaseIds.length === 0) && (!input.testCaseNames || input.testCaseNames.length === 0)) {
                    return {
                        verb: 'move', dryRun: true,
                        sourcePlanId: input.sourcePlanId, targetPlanId: input.targetPlanId,
                        moved: [], addedOnly: [], removed: [], deleted: [], skipped: [], failed: [], syncBack: [],
                        notFound: [],
                        totals: { enumerated: 0, succeeded: 0, failed: 0, warnings: 1 },
                        warnings: ['ADO not configured — cannot enumerate suite membership for dry-run preview. Pass explicit testCaseIds or testCaseNames to preview.'],
                        note: 'ADO not configured; explicit testCaseIds required for offline dry-run.',
                    };
                }
            }
            return runMove(input, cfg, ctx.workspaceRoot);
        }
        if (input.verb === 'remove-from-suite') {
            if (!cfg && input.dryRun) {
                if ((!input.testCaseIds || input.testCaseIds.length === 0) && (!input.testCaseNames || input.testCaseNames.length === 0)) {
                    return {
                        verb: 'remove-from-suite', dryRun: true,
                        moved: [], addedOnly: [], removed: [], deleted: [], skipped: [], failed: [], syncBack: [],
                        notFound: [],
                        totals: { enumerated: 0, succeeded: 0, failed: 0, warnings: 1 },
                        warnings: ['ADO not configured — cannot enumerate suite membership for dry-run preview. Pass explicit testCaseIds or testCaseNames to preview.'],
                        note: 'ADO not configured; explicit testCaseIds required for offline dry-run.',
                    };
                }
            }
            return runRemoveFromSuite(input, cfg, ctx.workspaceRoot);
        }
        // Destructive verbs: gate on confirmed. When user asks for a real
        // write without explicit confirmation, do a preview run and return
        // requiresConfirmation:true so the caller can show the human the
        // preview and retry with confirmed:true. This is CLIENT-AGNOSTIC —
        // works with MCP clients that do not support elicitation.
        const isDestructive = input.verb === 'delete' || input.verb === 'delete-suite' || input.verb === 'delete-plan';
        const wantsWrite = isDestructive && !input.dryRun && !(input as { confirmed?: boolean }).confirmed;
        if (wantsWrite) {
            const previewInput = { ...(input as object), dryRun: true } as typeof input;
            let preview: unknown;
            if (input.verb === 'delete') preview = await runDelete(previewInput as never, cfg, ctx.workspaceRoot);
            else if (input.verb === 'delete-suite') preview = await runDeleteSuite(previewInput as never, cfg, ctx.workspaceRoot);
            else preview = await runDeletePlan(previewInput as never, cfg, ctx.workspaceRoot);
            const p = preview as Record<string, unknown>;
            return {
                ...p,
                requiresConfirmation: true,
                destructive: true,
                confirmationHint:
                    `This will DELETE data on ADO. No write was performed. Review the dry-run preview above, then — ONLY after the human explicitly agrees in chat — retry the SAME call with confirmed:true (and dryRun:false or omitted). Example: {${JSON.stringify({ verb: input.verb, planId: (input as { planId?: number }).planId, suiteId: (input as { suiteId?: number }).suiteId }).slice(1, -1)}, confirmed:true}`,
            } as never;
        }
        if (input.verb === 'delete') {
            return runDelete(input, cfg, ctx.workspaceRoot);
        }
        if (input.verb === 'delete-suite') {
            return runDeleteSuite(input, cfg, ctx.workspaceRoot);
        }
        // delete-plan
        return runDeletePlan(input, cfg, ctx.workspaceRoot);
    },
});
