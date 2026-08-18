/**
 * ado_name_resolver — pure resolver functions that map user-friendly names
 * (planName / suiteName / testCaseNames / parentUserStoryTitle) to the numeric
 * IDs the ADO REST API needs.
 *
 * NO tool registration here — these are importable helpers reused by the
 * publish tool, the testcases-manage tool, and any future ADO verb.
 *
 * Behaviour rules (uniform across every resolve* function):
 *  - Both id and name given, id resolves + name matches → single result, no warning
 *  - Both id and name given, mismatch → warning, id wins (id is authoritative)
 *  - Only id → return single result; optionally GET workitems/{id} for the name (soft — a lookup failure still returns the id with a warning)
 *  - Only name → list the space; 1 match → OK; 0 matches → notFound; >1 → ambiguous + candidates
 *  - Neither → notFound with a helpful message
 *
 * A per-invocation URL cache prevents duplicate GET /plans calls inside one
 * verb run. Passing the same `cache` object between resolve calls in a single
 * verb keeps HTTP round-trips down.
 */

// =============================================================================
// Types.
// =============================================================================

export interface AdoCreds {
    orgUrl: string;
    project: string;
    pat: string;
}

export interface ResolveResult<T> {
    /** Matching entities. Empty for a non-resolving single lookup. */
    resolved: T[];
    /** true when a single-input name query hit >1 match. */
    ambiguous: boolean;
    /** Populated when ambiguous — the choices the caller can present. */
    candidates?: Array<{ id: number; name: string; note?: string }>;
    warnings: string[];
    /** Names/inputs that did not resolve to any entity. */
    notFound: string[];
}

export interface PlanRef { id: number; name: string }
export interface SuiteRef { id: number; name: string; parentSuiteId?: number }
export interface CaseRef { id: number; name: string }

// =============================================================================
// Per-invocation HTTP cache. Prevents duplicate GET /plans in one verb call.
// =============================================================================

export type ResolverCache = Map<string, unknown>;
export function createCache(): ResolverCache { return new Map(); }

// =============================================================================
// Low-level ADO helper — mirrors adoRequest in the manage/publish tools.
// Kept private to this module so callers stay in the resolver contract.
// =============================================================================

interface AdoResponse<T = unknown> { ok: boolean; status: number; body: T }

async function adoGet<T = unknown>(cfg: AdoCreds, urlPath: string, cache?: ResolverCache): Promise<AdoResponse<T>> {
    const url = `${cfg.orgUrl.replace(/\/$/, '')}/${cfg.project}/${urlPath.replace(/^\//, '')}`;
    if (cache && cache.has(url)) return cache.get(url) as AdoResponse<T>;
    const auth = Buffer.from(`:${cfg.pat}`).toString('base64');
    const res = await fetch(url, { method: 'GET', headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' } });
    const text = await res.text().catch(() => '');
    let parsed: unknown = {};
    if (text) { try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; } }
    const wrapped: AdoResponse<T> = { ok: res.ok, status: res.status, body: parsed as T };
    if (cache) cache.set(url, wrapped);
    return wrapped;
}

async function adoPost<T = unknown>(cfg: AdoCreds, urlPath: string, body: unknown): Promise<AdoResponse<T>> {
    const auth = Buffer.from(`:${cfg.pat}`).toString('base64');
    const url = `${cfg.orgUrl.replace(/\/$/, '')}/${cfg.project}/${urlPath.replace(/^\//, '')}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const text = await res.text().catch(() => '');
    let parsed: unknown = {};
    if (text) { try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; } }
    return { ok: res.ok, status: res.status, body: parsed as T };
}

function emptyResult<T>(notFound: string[] = [], warnings: string[] = []): ResolveResult<T> {
    return { resolved: [], ambiguous: false, warnings, notFound };
}

// =============================================================================
// resolvePlan.
// =============================================================================

interface PlanListBody { value?: Array<{ id: number; name?: string }> }

export async function resolvePlan(
    cfg: AdoCreds,
    opts: { planId?: number; planName?: string },
    cache: ResolverCache = createCache(),
): Promise<ResolveResult<PlanRef>> {
    const { planId, planName } = opts;

    // Neither → notFound.
    if (planId === undefined && (planName === undefined || planName.trim() === '')) {
        return emptyResult<PlanRef>(['(no planId or planName provided)'], ['resolvePlan called with neither planId nor planName.']);
    }

    // Both id + name → verify match; id wins on mismatch.
    if (planId !== undefined && planName !== undefined && planName.trim() !== '') {
        const byId = await adoGet<{ id?: number; name?: string }>(cfg, `_apis/testplan/plans/${planId}?api-version=7.1`, cache);
        if (!byId.ok || !byId.body || typeof byId.body.id !== 'number') {
            return emptyResult<PlanRef>([`planId=${planId}`], [`planId ${planId} could not be fetched (status ${byId.status}) — id wins, treating as not-found.`]);
        }
        const foundName = String(byId.body.name || '');
        if (foundName === planName.trim()) {
            return { resolved: [{ id: planId, name: foundName }], ambiguous: false, warnings: [], notFound: [] };
        }
        return {
            resolved: [{ id: planId, name: foundName }],
            ambiguous: false,
            warnings: [`Plan name mismatch: id ${planId} resolves to "${foundName}" but user provided "${planName}". id wins.`],
            notFound: [],
        };
    }

    // Only id.
    if (planId !== undefined) {
        const byId = await adoGet<{ id?: number; name?: string }>(cfg, `_apis/testplan/plans/${planId}?api-version=7.1`, cache);
        if (!byId.ok || !byId.body || typeof byId.body.id !== 'number') {
            // Still return the id — the caller supplied it, we don't have proof it's wrong (403? off-project?).
            return {
                resolved: [{ id: planId, name: `(plan ${planId})` }],
                ambiguous: false,
                warnings: [`planId ${planId} lookup failed (status ${byId.status}); using id as-is without name verification.`],
                notFound: [],
            };
        }
        return { resolved: [{ id: planId, name: String(byId.body.name || `(plan ${planId})`) }], ambiguous: false, warnings: [], notFound: [] };
    }

    // Only name → list + filter.
    const targetName = planName!.trim();
    const listRes = await adoGet<PlanListBody>(cfg, `_apis/testplan/plans?api-version=7.1`, cache);
    if (!listRes.ok) {
        return emptyResult<PlanRef>([targetName], [`GET /plans failed (status ${listRes.status}) — cannot resolve plan by name.`]);
    }
    const plans = (listRes.body.value || []).map((p) => ({ id: p.id, name: String(p.name || '') }));
    const matches = plans.filter((p) => p.name === targetName);
    if (matches.length === 0) {
        return {
            resolved: [], ambiguous: false,
            warnings: [`No plan matched name "${targetName}". ${plans.length} plans exist in project ${cfg.project}.`],
            notFound: [targetName],
        };
    }
    if (matches.length > 1) {
        return {
            resolved: matches, ambiguous: true,
            candidates: matches.map((m) => ({ id: m.id, name: m.name })),
            warnings: [`${matches.length} plans named "${targetName}" — caller must pick one by id.`],
            notFound: [],
        };
    }
    return { resolved: matches, ambiguous: false, warnings: [], notFound: [] };
}

// =============================================================================
// resolveSuite.
// =============================================================================

interface SuiteListBody { value?: Array<{ id: number; name?: string; parentSuite?: { id?: number } }> }

export async function resolveSuite(
    cfg: AdoCreds,
    opts: { planId: number; suiteId?: number; suiteName?: string; includeNested?: boolean },
    cache: ResolverCache = createCache(),
): Promise<ResolveResult<SuiteRef>> {
    const { planId, suiteId, suiteName, includeNested = true } = opts;

    if (typeof planId !== 'number' || !isFinite(planId)) {
        return emptyResult<SuiteRef>(['(no planId)'], ['resolveSuite requires planId — suite names are scoped to a plan.']);
    }

    if (suiteId === undefined && (suiteName === undefined || suiteName.trim() === '')) {
        return emptyResult<SuiteRef>(['(no suiteId or suiteName provided)'], ['resolveSuite called with neither suiteId nor suiteName.']);
    }

    // Both id + name → verify.
    if (suiteId !== undefined && suiteName !== undefined && suiteName.trim() !== '') {
        const byId = await adoGet<{ id?: number; name?: string; parentSuite?: { id?: number } }>(cfg, `_apis/testplan/plans/${planId}/suites/${suiteId}?api-version=7.1`, cache);
        if (!byId.ok || !byId.body || typeof byId.body.id !== 'number') {
            return emptyResult<SuiteRef>([`suiteId=${suiteId}`], [`suiteId ${suiteId} in plan ${planId} could not be fetched (status ${byId.status}); id wins, treating as not-found.`]);
        }
        const foundName = String(byId.body.name || '');
        const parentSuiteId = byId.body.parentSuite?.id;
        if (foundName === suiteName.trim()) {
            return { resolved: [{ id: suiteId, name: foundName, parentSuiteId }], ambiguous: false, warnings: [], notFound: [] };
        }
        return {
            resolved: [{ id: suiteId, name: foundName, parentSuiteId }],
            ambiguous: false,
            warnings: [`Suite name mismatch in plan ${planId}: id ${suiteId} resolves to "${foundName}" but user provided "${suiteName}". id wins.`],
            notFound: [],
        };
    }

    // Only id.
    if (suiteId !== undefined) {
        const byId = await adoGet<{ id?: number; name?: string; parentSuite?: { id?: number } }>(cfg, `_apis/testplan/plans/${planId}/suites/${suiteId}?api-version=7.1`, cache);
        if (!byId.ok || !byId.body || typeof byId.body.id !== 'number') {
            return {
                resolved: [{ id: suiteId, name: `(suite ${suiteId})` }],
                ambiguous: false,
                warnings: [`suiteId ${suiteId} lookup failed in plan ${planId} (status ${byId.status}); using id as-is without name verification.`],
                notFound: [],
            };
        }
        return { resolved: [{ id: suiteId, name: String(byId.body.name || `(suite ${suiteId})`), parentSuiteId: byId.body.parentSuite?.id }], ambiguous: false, warnings: [], notFound: [] };
    }

    // Only name → list in plan.
    const targetName = suiteName!.trim();
    const listRes = await adoGet<SuiteListBody>(cfg, `_apis/testplan/plans/${planId}/suites?api-version=7.1`, cache);
    if (!listRes.ok) {
        return emptyResult<SuiteRef>([targetName], [`GET /plans/${planId}/suites failed (status ${listRes.status}) — cannot resolve suite by name.`]);
    }
    const suites = (listRes.body.value || []).map((s) => ({ id: s.id, name: String(s.name || ''), parentSuiteId: s.parentSuite?.id }));
    let matches = suites.filter((s) => s.name === targetName);
    if (!includeNested) {
        // Filter down to top-level suites only (no parentSuite → root; parentSuite === plan root)
        // Since we don't have the plan-root id here without an extra call, we treat suites
        // with NO parentSuiteId or with parentSuiteId that isn't itself in the list as top-level.
        const rootIds = new Set(suites.filter((s) => s.parentSuiteId === undefined).map((s) => s.id));
        matches = matches.filter((s) => s.parentSuiteId === undefined || rootIds.has(s.parentSuiteId));
    }
    if (matches.length === 0) {
        return {
            resolved: [], ambiguous: false,
            warnings: [`No suite in plan ${planId} matched name "${targetName}". ${suites.length} suites exist in that plan.`],
            notFound: [targetName],
        };
    }
    if (matches.length > 1) {
        return {
            resolved: matches, ambiguous: true,
            candidates: matches.map((m) => ({ id: m.id, name: m.name, note: m.parentSuiteId !== undefined ? `parentSuiteId=${m.parentSuiteId}` : 'root-level' })),
            warnings: [`${matches.length} suites named "${targetName}" in plan ${planId} — caller must pick one by id.`],
            notFound: [],
        };
    }
    return { resolved: matches, ambiguous: false, warnings: [], notFound: [] };
}

// =============================================================================
// resolveTestCases — batch resolver, project-wide OR scoped to plan+suite.
// =============================================================================

interface WiqlBody { workItems?: Array<{ id: number }> }
interface WorkItemBody { id?: number; fields?: { 'System.Title'?: string } }

export async function resolveTestCases(
    cfg: AdoCreds,
    opts: { testCaseIds?: number[]; testCaseNames?: string[]; scope?: { planId?: number; suiteId?: number } },
    cache: ResolverCache = createCache(),
): Promise<ResolveResult<CaseRef>> {
    const idsIn = (opts.testCaseIds || []).filter((n) => Number.isFinite(n) && n > 0);
    const namesIn = (opts.testCaseNames || []).map((s) => String(s || '').trim()).filter(Boolean);

    if (idsIn.length === 0 && namesIn.length === 0) {
        return emptyResult<CaseRef>(['(no testCaseIds or testCaseNames provided)'], ['resolveTestCases called with neither ids nor names.']);
    }

    const resolved: CaseRef[] = [];
    const warnings: string[] = [];
    const notFound: string[] = [];
    const candidates: Array<{ id: number; name: string; note?: string }> = [];
    let ambiguous = false;

    // 1. IDs pass straight through. We do NOT verify each id via GET workitems
    //    (would cost N HTTP calls). If the caller wants names in the report,
    //    they can read them from tool output populated by downstream ops.
    for (const id of idsIn) resolved.push({ id, name: `(test case ${id})` });

    // 2. Names → resolve.
    if (namesIn.length > 0) {
        // Scope decision: if scope has a planId+suiteId, list that suite's cases.
        // Otherwise fall through to project-wide WIQL, one query per name (batchable
        // by OR when N > 1).
        if (opts.scope?.planId && opts.scope?.suiteId) {
            const listRes = await adoGet<{ value?: Array<{ workItem?: { id?: number; name?: string } }> }>(
                cfg,
                `_apis/testplan/plans/${opts.scope.planId}/suites/${opts.scope.suiteId}/TestCase?api-version=7.1`,
                cache,
            );
            if (!listRes.ok) {
                for (const n of namesIn) notFound.push(n);
                warnings.push(`Suite-scoped test-case list failed (status ${listRes.status}) — falling back to WIQL is not attempted for scoped requests.`);
                return { resolved, ambiguous, warnings, notFound };
            }
            const suiteCases = (listRes.body.value || []).map((v) => ({ id: Number(v.workItem?.id || 0), name: String(v.workItem?.name || '') })).filter((c) => c.id > 0);
            for (const nm of namesIn) {
                const matches = suiteCases.filter((c) => c.name === nm);
                if (matches.length === 0) notFound.push(nm);
                else if (matches.length === 1) resolved.push(matches[0]);
                else {
                    ambiguous = true;
                    for (const m of matches) candidates.push({ id: m.id, name: m.name, note: `matches name "${nm}" in scoped suite` });
                }
            }
        } else {
            // Project-wide WIQL. Batch into one query when N > 1.
            const orClauses = namesIn.map((n) => `[System.Title] = '${n.replace(/'/g, "''")}'`).join(' OR ');
            const wiql = `SELECT [System.Id],[System.Title] FROM WorkItems WHERE [System.WorkItemType] = 'Test Case' AND (${orClauses})`;
            const wRes = await adoPost<WiqlBody>(cfg, `_apis/wit/wiql?api-version=7.1`, { query: wiql });
            if (!wRes.ok) {
                for (const n of namesIn) notFound.push(n);
                warnings.push(`WIQL for test-case names failed (status ${wRes.status}).`);
                return { resolved, ambiguous, warnings, notFound };
            }
            const wiIds = (wRes.body.workItems || []).map((w) => w.id).filter((n) => Number.isFinite(n) && n > 0);
            if (wiIds.length === 0) {
                for (const n of namesIn) notFound.push(n);
                return { resolved, ambiguous, warnings, notFound };
            }
            // Fetch titles in one batch — GET workitems?ids=... (up to 200).
            const idsCsv = wiIds.slice(0, 200).join(',');
            const wiRes = await adoGet<{ value?: WorkItemBody[] }>(cfg, `_apis/wit/workitems?ids=${idsCsv}&fields=System.Id,System.Title&api-version=7.1`, cache);
            if (!wiRes.ok) {
                for (const n of namesIn) notFound.push(n);
                warnings.push(`Batch workitems lookup after WIQL failed (status ${wiRes.status}).`);
                return { resolved, ambiguous, warnings, notFound };
            }
            const hits = (wiRes.body.value || []).map((w) => ({ id: Number(w.id || 0), name: String(w.fields?.['System.Title'] || '') })).filter((c) => c.id > 0);
            // Group hits by name so we can detect ambiguity per requested name.
            const byName = new Map<string, CaseRef[]>();
            for (const h of hits) {
                const arr = byName.get(h.name) || [];
                arr.push(h);
                byName.set(h.name, arr);
            }
            for (const nm of namesIn) {
                const matches = byName.get(nm) || [];
                if (matches.length === 0) notFound.push(nm);
                else if (matches.length === 1) resolved.push(matches[0]);
                else {
                    ambiguous = true;
                    for (const m of matches) candidates.push({ id: m.id, name: m.name, note: `matches name "${nm}" project-wide` });
                }
            }
        }
    }

    return {
        resolved, ambiguous,
        candidates: candidates.length > 0 ? candidates : undefined,
        warnings, notFound,
    };
}

// =============================================================================
// resolveUserStory — helper for publish tool's parentUserStoryTitle input.
// Uses WIQL with WorkItemType = 'User Story' (or Product Backlog Item / Feature
// depending on process template — WIQL doesn't restrict us to one type).
// =============================================================================

export async function resolveUserStory(
    cfg: AdoCreds,
    opts: { userStoryId?: number; userStoryTitle?: string },
    cache: ResolverCache = createCache(),
): Promise<ResolveResult<{ id: number; name: string; workItemType?: string }>> {
    const { userStoryId, userStoryTitle } = opts;

    if (userStoryId === undefined && (userStoryTitle === undefined || userStoryTitle.trim() === '')) {
        return emptyResult<{ id: number; name: string; workItemType?: string }>(['(no id or title provided)'], ['resolveUserStory called with neither id nor title.']);
    }

    if (userStoryId !== undefined && userStoryTitle !== undefined && userStoryTitle.trim() !== '') {
        const byId = await adoGet<WorkItemBody & { fields?: { 'System.Title'?: string; 'System.WorkItemType'?: string } }>(cfg, `_apis/wit/workitems/${userStoryId}?api-version=7.1`, cache);
        if (!byId.ok || !byId.body || typeof byId.body.id !== 'number') {
            return emptyResult(['id=' + userStoryId], [`user-story id ${userStoryId} lookup failed (status ${byId.status}); id wins.`]);
        }
        const foundName = String(byId.body.fields?.['System.Title'] || '');
        const wit = String(byId.body.fields?.['System.WorkItemType'] || '');
        if (foundName === userStoryTitle.trim()) {
            return { resolved: [{ id: userStoryId, name: foundName, workItemType: wit }], ambiguous: false, warnings: [], notFound: [] };
        }
        return {
            resolved: [{ id: userStoryId, name: foundName, workItemType: wit }],
            ambiguous: false,
            warnings: [`Story title mismatch: id ${userStoryId} resolves to "${foundName}" but user provided "${userStoryTitle}". id wins.`],
            notFound: [],
        };
    }

    if (userStoryId !== undefined) {
        const byId = await adoGet<WorkItemBody & { fields?: { 'System.Title'?: string; 'System.WorkItemType'?: string } }>(cfg, `_apis/wit/workitems/${userStoryId}?api-version=7.1`, cache);
        if (!byId.ok || !byId.body || typeof byId.body.id !== 'number') {
            return {
                resolved: [{ id: userStoryId, name: `(work item ${userStoryId})` }],
                ambiguous: false,
                warnings: [`user-story id ${userStoryId} lookup failed (status ${byId.status}); using id as-is.`],
                notFound: [],
            };
        }
        return {
            resolved: [{ id: userStoryId, name: String(byId.body.fields?.['System.Title'] || `(work item ${userStoryId})`), workItemType: String(byId.body.fields?.['System.WorkItemType'] || '') }],
            ambiguous: false, warnings: [], notFound: [],
        };
    }

    // Only title → WIQL. Do not restrict WorkItemType (User Story / PBI / Feature vary by template).
    const title = userStoryTitle!.trim();
    const wiql = `SELECT [System.Id],[System.Title],[System.WorkItemType] FROM WorkItems WHERE [System.Title] = '${title.replace(/'/g, "''")}'`;
    const wRes = await adoPost<WiqlBody>(cfg, `_apis/wit/wiql?api-version=7.1`, { query: wiql });
    if (!wRes.ok) {
        return emptyResult([title], [`WIQL for user-story title failed (status ${wRes.status}).`]);
    }
    const wiIds = (wRes.body.workItems || []).map((w) => w.id).filter((n) => Number.isFinite(n) && n > 0);
    if (wiIds.length === 0) {
        return { resolved: [], ambiguous: false, warnings: [`No work item with title "${title}".`], notFound: [title] };
    }
    const idsCsv = wiIds.slice(0, 50).join(',');
    const wiRes = await adoGet<{ value?: Array<WorkItemBody & { fields?: { 'System.Title'?: string; 'System.WorkItemType'?: string } }> }>(cfg, `_apis/wit/workitems?ids=${idsCsv}&fields=System.Id,System.Title,System.WorkItemType&api-version=7.1`, cache);
    if (!wiRes.ok) {
        return emptyResult([title], [`Batch workitems lookup after WIQL failed (status ${wiRes.status}).`]);
    }
    const hits = (wiRes.body.value || []).map((w) => ({
        id: Number(w.id || 0),
        name: String(w.fields?.['System.Title'] || ''),
        workItemType: String(w.fields?.['System.WorkItemType'] || ''),
    })).filter((c) => c.id > 0 && c.name === title);
    if (hits.length === 0) {
        return { resolved: [], ambiguous: false, warnings: [`No work item with exact title "${title}".`], notFound: [title] };
    }
    if (hits.length > 1) {
        return {
            resolved: hits, ambiguous: true,
            candidates: hits.map((h) => ({ id: h.id, name: h.name, note: h.workItemType || undefined })),
            warnings: [`${hits.length} work items match title "${title}" — caller must pick one by id.`],
            notFound: [],
        };
    }
    return { resolved: hits, ambiguous: false, warnings: [], notFound: [] };
}

// =============================================================================
// listAllSuitesInPlan — helper for delete-plan/delete-suite verbs. Returns
// suites in the plan (may be nested). No caching side-effects beyond
// what adoGet does automatically.
// =============================================================================

export async function listAllSuitesInPlan(cfg: AdoCreds, planId: number, cache: ResolverCache = createCache()): Promise<SuiteRef[]> {
    const r = await adoGet<SuiteListBody>(cfg, `_apis/testplan/plans/${planId}/suites?api-version=7.1`, cache);
    if (!r.ok) return [];
    return (r.body.value || []).map((s) => ({ id: s.id, name: String(s.name || ''), parentSuiteId: s.parentSuite?.id }));
}

/**
 * Given a target suite, return the target + every descendant (transitively).
 * Walk the plan's flat suite list once, keying by parentSuiteId.
 */
export function collectNestedSuites(all: SuiteRef[], rootSuiteId: number): SuiteRef[] {
    const byParent = new Map<number, SuiteRef[]>();
    for (const s of all) {
        if (s.parentSuiteId === undefined) continue;
        const arr = byParent.get(s.parentSuiteId) || [];
        arr.push(s);
        byParent.set(s.parentSuiteId, arr);
    }
    const out: SuiteRef[] = [];
    const seen = new Set<number>();
    const walk = (suiteId: number): void => {
        if (seen.has(suiteId)) return;
        seen.add(suiteId);
        const self = all.find((s) => s.id === suiteId);
        if (self) out.push(self);
        const kids = byParent.get(suiteId) || [];
        for (const k of kids) walk(k.id);
    };
    walk(rootSuiteId);
    return out;
}

export async function listTestCasesInSuite(cfg: AdoCreds, planId: number, suiteId: number, cache: ResolverCache = createCache()): Promise<CaseRef[]> {
    const r = await adoGet<{ value?: Array<{ workItem?: { id?: number; name?: string } }> }>(cfg, `_apis/testplan/plans/${planId}/suites/${suiteId}/TestCase?api-version=7.1`, cache);
    if (!r.ok) return [];
    return (r.body.value || []).map((v) => ({ id: Number(v.workItem?.id || 0), name: String(v.workItem?.name || '') })).filter((c) => c.id > 0);
}

/**
 * Return every suite (planId, suiteId) that contains this test case, across all
 * plans in the project. Used by delete-suite's cascadeSkipCasesInOtherSuites
 * flag to avoid orphaning a test case that lives in multiple suites.
 *
 * Uses testplan suiteentry expansion when available; otherwise falls back to
 * scanning /test/suites?testCaseId={id} (older API).
 */
export async function listSuitesContainingCase(cfg: AdoCreds, testCaseId: number, cache: ResolverCache = createCache()): Promise<Array<{ planId?: number; suiteId: number }>> {
    // /_apis/test/suites?testCaseId=... — legacy Test service endpoint. Returns list of suites.
    const r = await adoGet<{ value?: Array<{ id?: number; plan?: { id?: number } }> }>(cfg, `_apis/test/suites?testCaseId=${testCaseId}&api-version=7.1`, cache);
    if (!r.ok) return [];
    return (r.body.value || [])
        .map((s) => ({ planId: s.plan?.id, suiteId: Number(s.id || 0) }))
        .filter((s) => s.suiteId > 0);
}
