/**
 * cs_qa_generate_manual_tcs_from_story — read an ADO User Story, guide the LLM
 * caller to draft manual test cases from its acceptance criteria, then bulk-
 * create them in ADO and add them to a target Test Plan / Suite.
 *
 * Two-round contract (client-agnostic — never uses ctx.elicit):
 *
 *   Round 1 (no draftedTestCases, no confirmed:true)
 *     → Fetch story, parse ACs, resolve target plan/suite.
 *     → Return requiresDrafting:true with:
 *         story, parsedAcceptanceCriteria, targetPlan, targetSuite,
 *         suggestedTestCases (3-5 title candidates per AC across kinds),
 *         draftTemplate (schema Copilot must fill), guidance string.
 *     → Copilot shows suggestions to the human, drafts full TC content, then
 *       calls back with draftedTestCases + confirmed:true.
 *
 *   Round 2 (draftedTestCases non-empty AND confirmed:true)
 *     → Validate each draft (title, steps, per-item errors).
 *     → Optional dedupe: WIQL query for same-title existing TC.
 *     → Bulk-create via bulkExecute (concurrency 4, per-item isolation).
 *     → Link each new TC to story (Hierarchy-Reverse or TestedBy-Forward).
 *     → Add each TC to the target suite.
 *     → Return created[], skippedDuplicates[], warnings.
 *
 * All ADO HTTP goes through AdoHttpClient (Retry-After honored, PAT redacted,
 * response cap enforced). No `dev.azure.com` hardcoded — on-prem safe.
 */

import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import { createLogger } from './_helpers/structured_logger';
import { AdoHttpClient, type AdoCreds } from './_helpers/ado_http_client';
import { wiql } from './_helpers/wiql_builder';
import { bulkExecute } from './_helpers/bulk_batcher';
import { getResolvedCreds } from './ado_config_tool';

// ---------------------------------------------------------------------------
// Input / output schemas
// ---------------------------------------------------------------------------

const StepDraftSchema = z.object({
    action: z.string().min(1),
    expectedResult: z.string().optional(),
    data: z.string().optional(),
});

const TestCaseDraftSchema = z.object({
    title: z.string().min(1).max(254),
    description: z.string().optional(),
    preconditions: z.string().optional(),
    priority: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
    automationStatus: z.enum(['Not Automated', 'Planned', 'Automated']).optional(),
    steps: z.array(StepDraftSchema).min(1),
    acReference: z.string().optional(),
    kind: z.string().optional(),
});

const InputSchema = z.object({
    storyId: z.number().int().positive(),
    targetPlanId: z.number().int().positive(),
    targetSuiteId: z.number().int().positive().optional(),
    targetSuiteName: z.string().min(1).optional(),
    draftedTestCases: z.array(TestCaseDraftSchema).optional().describe('Round 2 payload — Copilot fills this after Round 1 returns draftTemplate. Set confirmed:true alongside to trigger creation.'),
    areaPath: z.string().optional(),
    iterationPath: z.string().optional(),
    assignedTo: z.string().optional(),
    priority: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).default(3),
    tags: z.array(z.string()).default([]),
    linkStoryAsParent: z.boolean().default(true).describe('When true, uses System.LinkTypes.Hierarchy-Reverse (parent story). When false, uses Microsoft.VSTS.Common.TestedBy-Forward.'),
    dedupeByTitle: z.boolean().default(true).describe('Skip creation for any draft whose title matches an existing Test Case in the project.'),
    confirmed: z.boolean().default(false).describe('Two-phase gate. Round 2 requires this AND non-empty draftedTestCases.'),
    dryRun: z.boolean().default(false),
    orgUrl: z.string().optional(),
    project: z.string().optional(),
    pat: z.string().optional(),
});
type Input = z.infer<typeof InputSchema>;

const SuggestedTestCaseSchema = z.object({
    ac: z.string(),
    title: z.string(),
    kind: z.enum(['happy', 'negative', 'edge-case', 'boundary', 'security', 'accessibility', 'permission']),
    suggestedStepCount: z.number(),
});

const DraftTemplateSchema = z.object({
    requiredFields: z.array(z.string()),
    stepShape: z.object({
        action: z.string(),
        expectedResult: z.string().optional(),
        data: z.string().optional(),
    }),
    example: z.object({
        title: z.string(),
        preconditions: z.string(),
        priority: z.number(),
        steps: z.array(z.object({
            action: z.string(),
            expectedResult: z.string(),
        })),
    }),
});

const StorySchema = z.object({
    id: z.number(),
    title: z.string(),
    description: z.string(),
    acceptanceCriteria: z.string(),
    tags: z.array(z.string()),
});

const CreatedItemSchema = z.object({
    tcId: z.number(),
    url: z.string(),
    title: z.string(),
    addedToSuite: z.boolean(),
    linkedToStory: z.boolean(),
    warnings: z.array(z.string()),
});

const SkippedItemSchema = z.object({
    title: z.string(),
    existingTcId: z.number(),
    reason: z.string(),
});

const OutputSchema = z.object({
    ok: z.boolean(),
    verb: z.literal('generate-manual-tcs-from-story'),
    storyId: z.number(),
    story: StorySchema.optional(),
    parsedAcceptanceCriteria: z.array(z.string()).optional(),
    targetPlan: z.object({ id: z.number(), name: z.string() }).optional(),
    targetSuite: z.object({ id: z.number(), name: z.string() }).optional(),
    suggestedTestCases: z.array(SuggestedTestCaseSchema).optional(),
    draftTemplate: DraftTemplateSchema.optional(),
    requiresDrafting: z.boolean().optional(),
    requiresConfirmation: z.boolean().optional(),
    confirmationHint: z.string().optional(),
    guidance: z.string().optional(),
    created: z.array(CreatedItemSchema).default([]),
    skippedDuplicates: z.array(SkippedItemSchema).default([]),
    warnings: z.array(z.string()).default([]),
    note: z.string().optional(),
});
type Output = z.infer<typeof OutputSchema>;

// ---------------------------------------------------------------------------
// HTML → plain-text + AC splitting
// ---------------------------------------------------------------------------

function decodeHtmlEntities(s: string): string {
    return s
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCharCode(parseInt(n, 16)));
}

function stripHtmlToPlain(html: string): string {
    if (!html) return '';
    // Convert block-level tags to newlines before stripping so structure is
    // preserved in the plaintext form.
    let out = html
        .replace(/<\s*br\s*\/?>/gi, '\n')
        .replace(/<\/\s*(li|p|div|tr|h[1-6])\s*>/gi, '\n')
        .replace(/<\s*li[^>]*>/gi, '\n- ');
    out = out.replace(/<[^>]+>/g, '');
    out = decodeHtmlEntities(out);
    // Normalize whitespace but keep newlines as separators.
    return out
        .split('\n')
        .map((l) => l.replace(/\s+/g, ' ').trim())
        .filter((l) => l.length > 0)
        .join('\n');
}

/** Split ACs from the raw HTML AC field. Prefers <li> then <p> then plaintext line
 * boundaries. Also splits on numbered / lettered / "AC1:" prefixes. */
function splitAcceptanceCriteria(html: string): string[] {
    if (!html) return [];
    const items: string[] = [];
    // First pass — mine <li> items directly from the HTML.
    const liMatches = html.match(/<li[^>]*>[\s\S]*?<\/li>/gi);
    if (liMatches && liMatches.length > 0) {
        for (const li of liMatches) {
            const txt = stripHtmlToPlain(li).replace(/^-\s*/, '').trim();
            if (txt) items.push(txt);
        }
    }
    // Fallback — <p> blocks.
    if (items.length === 0) {
        const pMatches = html.match(/<p[^>]*>[\s\S]*?<\/p>/gi);
        if (pMatches && pMatches.length > 0) {
            for (const p of pMatches) {
                const txt = stripHtmlToPlain(p).trim();
                if (txt) items.push(txt);
            }
        }
    }
    // Final fallback — plaintext line boundaries.
    if (items.length === 0) {
        const plain = stripHtmlToPlain(html);
        for (const line of plain.split(/\n/)) {
            const txt = line.trim();
            if (txt) items.push(txt);
        }
    }
    // Post-process: if any single item looks like it packs multiple ACs prefixed
    // 1) 1. AC1: etc., split it further.
    const expanded: string[] = [];
    const acPrefixRe = /(?:^|\s)(?:AC\s*\d+\s*[:.\-\)]|\d+\s*[\.\)]|\([a-z]\)|[a-z]\s*\.)\s+/gi;
    for (const item of items) {
        if (acPrefixRe.test(item) && item.length > 120) {
            acPrefixRe.lastIndex = 0;
            const parts = item.split(/(?:^|\s)(?:AC\s*\d+\s*[:.\-\)]|\d+\s*[\.\)]|\([a-z]\)|[a-z]\s*\.)\s+/g);
            for (const p of parts) {
                const t = p.trim();
                if (t) expanded.push(t);
            }
        } else {
            expanded.push(item);
        }
    }
    // Deduplicate — same text may appear twice from overlapping matchers.
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const it of expanded) {
        const key = it.toLowerCase().replace(/\s+/g, ' ').trim();
        if (!seen.has(key)) { seen.add(key); unique.push(it); }
    }
    return unique;
}

// ---------------------------------------------------------------------------
// Suggested test cases — deterministic proposals
// ---------------------------------------------------------------------------

const TC_KINDS: SuggestedTestCase['kind'][] = ['happy', 'negative', 'edge-case', 'boundary', 'permission'];

type SuggestedTestCase = z.infer<typeof SuggestedTestCaseSchema>;

function extractVerbObject(ac: string): { verb: string; object: string } {
    const trimmed = ac.replace(/^[\-\*\d\.\)\s]+/, '').trim();
    // Common shapes:
    //   "User can <verb> <object>"
    //   "As a <role>, I want to <verb> <object>, so that ..."
    //   "The system should <verb> <object>"
    //   "Given <precond>, When <verb> <object>, Then <expected>"
    const asIWant = /(?:i\s+want\s+to|i\s+should\s+be\s+able\s+to|should\s+be\s+able\s+to|can|should|must|shall)\s+([a-z]+)\s+(.+?)(?:,|\s+so\s+that|\s+in\s+order\s+to|$)/i.exec(trimmed);
    if (asIWant) {
        return { verb: capitalize(asIWant[1]), object: trimBoundary(asIWant[2]) };
    }
    const whenThen = /when\s+(?:i|the\s+user|user|system)\s+([a-z]+)\s+(.+?)(?:,|\s+then\s+|$)/i.exec(trimmed);
    if (whenThen) {
        return { verb: capitalize(whenThen[1]), object: trimBoundary(whenThen[2]) };
    }
    const startsVerb = /^([A-Za-z]+)\s+(.+)$/.exec(trimmed);
    if (startsVerb) {
        return { verb: capitalize(startsVerb[1]), object: trimBoundary(startsVerb[2]) };
    }
    return { verb: 'Verify', object: trimBoundary(trimmed) };
}

function capitalize(s: string): string {
    if (!s) return s;
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function trimBoundary(s: string): string {
    return s
        .replace(/[\.,;:!\?]+$/g, '')
        .replace(/\s+/g, ' ')
        .slice(0, 120)
        .trim();
}

function suggestedStepCountFor(kind: SuggestedTestCase['kind']): number {
    switch (kind) {
        case 'happy': return 5;
        case 'negative': return 4;
        case 'edge-case': return 5;
        case 'boundary': return 4;
        case 'permission': return 4;
        default: return 4;
    }
}

function proposeTestCases(acs: string[]): SuggestedTestCase[] {
    const out: SuggestedTestCase[] = [];
    for (const ac of acs) {
        const { verb, object } = extractVerbObject(ac);
        for (const kind of TC_KINDS) {
            const suffix = kind === 'happy' ? 'happy path'
                : kind === 'negative' ? 'negative path'
                : kind === 'edge-case' ? 'edge case'
                : kind === 'boundary' ? 'boundary values'
                : kind === 'security' ? 'security'
                : kind === 'accessibility' ? 'accessibility'
                : 'role-based access';
            const title = `${verb} ${object} — ${suffix}`.slice(0, 254);
            out.push({ ac, title, kind, suggestedStepCount: suggestedStepCountFor(kind) });
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Step XML — matches ADO's VSTS Steps schema (id starts at 2, last = highest id)
// ---------------------------------------------------------------------------

function escapeStepText(s: string): string {
    // Double-escape: HTML then XML — matches publish_feature_to_ado_tool.ts so
    // ADO's dual-parse (XML container, HTML-formatted text inside) renders < / > correctly.
    const html = String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return html
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function buildStepsXml(steps: Array<{ action: string; expectedResult?: string; data?: string }>): string {
    if (steps.length === 0) return '';
    const stepEls: string[] = [];
    for (let i = 0; i < steps.length; i++) {
        const id = i + 2;
        const actionText = steps[i].data
            ? `${steps[i].action}\n(Test data: ${steps[i].data})`
            : steps[i].action;
        stepEls.push(
            `<step id="${id}" type="ActionStep">` +
            `<parameterizedString isformatted="true">&lt;P&gt;${escapeStepText(actionText)}&lt;/P&gt;</parameterizedString>` +
            `<parameterizedString isformatted="true">&lt;P&gt;${escapeStepText(steps[i].expectedResult || 'Step completes without error.')}&lt;/P&gt;</parameterizedString>` +
            `<description/></step>`,
        );
    }
    const last = steps.length + 1;
    return `<steps id="0" last="${last}">${stepEls.join('')}</steps>`;
}

function escapeHtml(s: string): string {
    return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// ADO shape adapters
// ---------------------------------------------------------------------------

interface RawWorkItem {
    id?: number;
    url?: string;
    fields?: Record<string, unknown>;
    relations?: Array<{ rel: string; url: string; attributes?: Record<string, unknown> }>;
}

interface RawSuiteRef {
    id: number;
    name?: string;
    parentSuite?: { id?: number };
}

async function fetchStory(client: AdoHttpClient, storyId: number): Promise<{
    id: number;
    title: string;
    description: string;
    acceptanceCriteriaHtml: string;
    tags: string[];
}> {
    const raw = await client.get<RawWorkItem>(`_apis/wit/workitems/${storyId}?$expand=all&api-version=7.1`);
    const fields = raw.fields || {};
    const title = String(fields['System.Title'] || `Story ${storyId}`);
    const description = stripHtmlToPlain(String(fields['System.Description'] || ''));
    const acHtml = String(fields['Microsoft.VSTS.Common.AcceptanceCriteria'] || '');
    const rawTags = String(fields['System.Tags'] || '');
    const tags = rawTags
        .split(/[;,]/)
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
    return {
        id: storyId,
        title,
        description,
        acceptanceCriteriaHtml: acHtml,
        tags,
    };
}

async function fetchPlanRootSuite(client: AdoHttpClient, planId: number): Promise<{ id: number; name: string; planName: string } | null> {
    try {
        const plan = await client.get<{
            id?: number;
            name?: string;
            rootSuite?: { id?: number; name?: string };
        }>(`_apis/testplan/plans/${planId}?api-version=7.1`);
        if (plan.rootSuite?.id) {
            return {
                id: plan.rootSuite.id,
                name: plan.rootSuite.name || `Plan-${planId}-root`,
                planName: plan.name || `Plan-${planId}`,
            };
        }
        return null;
    } catch {
        return null;
    }
}

async function fetchPlanName(client: AdoHttpClient, planId: number): Promise<string> {
    try {
        const plan = await client.get<{ name?: string }>(`_apis/testplan/plans/${planId}?api-version=7.1`);
        return plan.name || `Plan-${planId}`;
    } catch {
        return `Plan-${planId}`;
    }
}

async function findSuiteById(client: AdoHttpClient, planId: number, suiteId: number): Promise<{ id: number; name: string } | null> {
    try {
        const suite = await client.get<{ id?: number; name?: string }>(`_apis/testplan/plans/${planId}/suites/${suiteId}?api-version=7.1`);
        if (suite && suite.id) return { id: suite.id, name: suite.name || `Suite-${suiteId}` };
        return null;
    } catch {
        return null;
    }
}

async function findSuiteByName(client: AdoHttpClient, planId: number, suiteName: string): Promise<{ id: number; name: string } | null> {
    try {
        const res = await client.get<{ value?: RawSuiteRef[] }>(`_apis/testplan/plans/${planId}/suites?api-version=7.1`);
        const list = res.value || [];
        const target = suiteName.trim().toLowerCase();
        const hit = list.find((s) => (s.name || '').trim().toLowerCase() === target);
        if (hit) return { id: hit.id, name: hit.name || suiteName };
        return null;
    } catch {
        return null;
    }
}

async function findExistingTcByTitle(client: AdoHttpClient, title: string): Promise<number | null> {
    const query = wiql()
        .select(['[System.Id]'])
        .from('WorkItems')
        .where()
        .equals('[System.WorkItemType]', 'Test Case')
        .and().equals('[System.Title]', title)
        .done()
        .build();
    try {
        const res = await client.post<{ workItems?: Array<{ id: number }> }>(`_apis/wit/wiql?api-version=7.1`, { query });
        const ids = (res.workItems || []).map((w) => w.id).filter((n) => Number.isFinite(n) && n > 0);
        return ids.length > 0 ? ids[0] : null;
    } catch {
        return null;
    }
}

interface CreateTcArgs {
    draft: z.infer<typeof TestCaseDraftSchema>;
    input: Input;
    storyId: number;
    storyTitle: string;
    orgBase: string;
    defaultPriority: number;
}

function buildSystemInfoHtml(args: CreateTcArgs): string {
    const rows: Array<[string, string]> = [];
    rows.push(['Source', `Generated from Story #${args.storyId} — ${args.storyTitle}`]);
    if (args.draft.acReference) rows.push(['Acceptance criterion', args.draft.acReference]);
    if (args.draft.kind) rows.push(['Coverage kind', args.draft.kind]);
    if (args.draft.preconditions) rows.push(['Preconditions', args.draft.preconditions]);
    rows.push(['Story link', `${args.orgBase}/_workitems/edit/${args.storyId}`]);
    const trs = rows
        .map(([k, v]) => `<tr><td style="padding:4px 12px;border:1px solid #ccc;background:#f6f8fa;vertical-align:top"><b>${escapeHtml(k)}</b></td><td style="padding:4px 12px;border:1px solid #ccc;vertical-align:top">${escapeHtml(v)}</td></tr>`)
        .join('');
    return `<table style="border-collapse:collapse;font-family:Segoe UI,Arial,sans-serif;font-size:13px">${trs}</table>`;
}

function buildDescriptionHtml(args: CreateTcArgs): string {
    if (args.draft.description) return args.draft.description;
    const parts: string[] = [];
    parts.push(`<p><b>Generated from Story #${args.storyId} — ${escapeHtml(args.storyTitle)}</b></p>`);
    if (args.draft.acReference) parts.push(`<p><b>Acceptance criterion:</b> ${escapeHtml(args.draft.acReference)}</p>`);
    if (args.draft.kind) parts.push(`<p><b>Coverage kind:</b> ${escapeHtml(args.draft.kind)}</p>`);
    if (args.draft.preconditions) parts.push(`<p><b>Preconditions:</b><br/>${escapeHtml(args.draft.preconditions)}</p>`);
    parts.push(`<p><b>Steps:</b> ${args.draft.steps.length}</p>`);
    return parts.join('');
}

function buildTagString(args: CreateTcArgs): string {
    const tags = new Set<string>();
    tags.add('auto-generated');
    tags.add(`source:story-${args.storyId}`);
    if (args.draft.kind) tags.add(`kind:${args.draft.kind}`);
    // Defensive — .run() may be invoked directly (tests, embedded callers) and
    // bypass Zod's default() coercion.
    const inputTags = Array.isArray(args.input.tags) ? args.input.tags : [];
    for (const t of inputTags) {
        const cleaned = String(t || '').trim();
        if (cleaned) tags.add(cleaned);
    }
    return Array.from(tags).join('; ');
}

function buildPatchDoc(args: CreateTcArgs): Array<Record<string, unknown>> {
    const priority = args.draft.priority ?? args.input.priority ?? args.defaultPriority;
    const automationStatus = args.draft.automationStatus ?? 'Not Automated';
    const patch: Array<Record<string, unknown>> = [
        { op: 'add', path: '/fields/System.Title', value: args.draft.title },
        { op: 'add', path: '/fields/System.State', value: 'Design' },
        { op: 'add', path: '/fields/System.Description', value: buildDescriptionHtml(args) },
        { op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: priority },
        { op: 'add', path: '/fields/Microsoft.VSTS.TCM.AutomationStatus', value: automationStatus },
        { op: 'add', path: '/fields/Microsoft.VSTS.TCM.Steps', value: buildStepsXml(args.draft.steps) },
        { op: 'add', path: '/fields/Microsoft.VSTS.TCM.SystemInfo', value: buildSystemInfoHtml(args) },
        { op: 'add', path: '/fields/System.Tags', value: buildTagString(args) },
    ];
    if (args.input.areaPath) patch.push({ op: 'add', path: '/fields/System.AreaPath', value: args.input.areaPath });
    if (args.input.iterationPath) patch.push({ op: 'add', path: '/fields/System.IterationPath', value: args.input.iterationPath });
    if (args.input.assignedTo) patch.push({ op: 'add', path: '/fields/System.AssignedTo', value: args.input.assignedTo });
    // Link to story — Hierarchy-Reverse (parent) OR TestedBy-Forward.
    const relRel = args.input.linkStoryAsParent
        ? 'System.LinkTypes.Hierarchy-Reverse'
        : 'Microsoft.VSTS.Common.TestedBy-Forward';
    patch.push({
        op: 'add', path: '/relations/-',
        value: {
            rel: relRel,
            url: `${args.orgBase}/_apis/wit/workitems/${args.storyId}`,
            attributes: { comment: `Generated from Story #${args.storyId} via cs_qa_generate_manual_tcs_from_story` },
        },
    });
    return patch;
}

// ---------------------------------------------------------------------------
// Draft validation
// ---------------------------------------------------------------------------

interface DraftValidationIssue {
    index: number;
    title: string;
    reasons: string[];
}

function validateDrafts(drafts: Array<z.infer<typeof TestCaseDraftSchema>>): { valid: Array<{ index: number; draft: z.infer<typeof TestCaseDraftSchema> }>; issues: DraftValidationIssue[] } {
    const valid: Array<{ index: number; draft: z.infer<typeof TestCaseDraftSchema> }> = [];
    const issues: DraftValidationIssue[] = [];
    for (let i = 0; i < drafts.length; i++) {
        const d = drafts[i];
        const reasons: string[] = [];
        if (!d.title || d.title.trim().length === 0) reasons.push('title is empty');
        else if (d.title.length > 254) reasons.push(`title too long (${d.title.length} > 254)`);
        if (!Array.isArray(d.steps) || d.steps.length === 0) reasons.push('steps array is empty (must have ≥1 step)');
        else {
            for (let si = 0; si < d.steps.length; si++) {
                const s = d.steps[si];
                if (!s.action || s.action.trim().length === 0) {
                    reasons.push(`step[${si}].action is empty`);
                }
            }
        }
        if (reasons.length > 0) {
            issues.push({ index: i, title: d.title || '<untitled>', reasons });
        } else {
            valid.push({ index: i, draft: d });
        }
    }
    return { valid, issues };
}

// ---------------------------------------------------------------------------
// Suite add — batched
// ---------------------------------------------------------------------------

async function addTestCasesToSuite(client: AdoHttpClient, planId: number, suiteId: number, tcIds: number[]): Promise<{ added: number[]; failed: Array<{ tcId: number; error: string }> }> {
    if (tcIds.length === 0) return { added: [], failed: [] };
    const body = tcIds.map((id) => ({ workItem: { id } }));
    try {
        await client.post<unknown>(`_apis/testplan/plans/${planId}/suites/${suiteId}/TestCase?api-version=7.1`, body);
        return { added: tcIds, failed: [] };
    } catch (e) {
        const msg = (e as Error).message.slice(0, 200);
        // Per-item fallback so a single collision doesn't sink the batch.
        const added: number[] = [];
        const failed: Array<{ tcId: number; error: string }> = [];
        for (const id of tcIds) {
            try {
                await client.post<unknown>(`_apis/testplan/plans/${planId}/suites/${suiteId}/TestCase?api-version=7.1`, [{ workItem: { id } }]);
                added.push(id);
            } catch (e2) {
                failed.push({ tcId: id, error: (e2 as Error).message.slice(0, 200) || msg });
            }
        }
        return { added, failed };
    }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

registerPrimitive<Input, Output>({
    name: 'cs_qa_generate_manual_tcs_from_story',
    description:
        'Read an ADO User Story, guide the LLM caller to draft manual test cases from its acceptance criteria, then bulk-create them in ADO and add them to a target Test Plan/Suite. Two-round contract: (1) call with storyId + targetPlanId → returns parsed ACs, suggested test-case titles per AC (across happy/negative/edge-case/boundary/permission kinds), and a draftTemplate the Copilot uses to compose full TCs; (2) call again with draftedTestCases:[…] + confirmed:true → bulk-creates each TC with steps XML, links to story (Hierarchy-Reverse or TestedBy-Forward), adds to suite. dedupeByTitle skips creation for any draft whose title already exists as a Test Case. On-prem safe — every ADO call routes through AdoHttpClient.',
    inputSchema: InputSchema as unknown as import('zod').ZodType<Input>,
    outputSchema: OutputSchema as unknown as import('zod').ZodType<Output>,
    run: async (ctx, input) => {
        const log = createLogger(ctx.invocationId, 'cs_qa_generate_manual_tcs_from_story', { workspaceRoot: ctx.workspaceRoot });
        const warnings: string[] = [];

        // Defensive: .run() can be invoked directly (tests, embedded callers)
        // bypassing Zod's default coercion. Normalize the fields that other
        // code paths dereference without a null-check.
        input = {
            ...input,
            priority: (input.priority as 1 | 2 | 3 | 4 | undefined) ?? 3,
            tags: Array.isArray(input.tags) ? input.tags : [],
            linkStoryAsParent: input.linkStoryAsParent !== false, // default true
            dedupeByTitle: input.dedupeByTitle !== false,          // default true
            confirmed: input.confirmed === true,
            dryRun: input.dryRun === true,
        };

        // Resolve creds — every code path needs them (Round 1 reads the story,
        // Round 2 also writes). Fail fast with a clear error if unresolved.
        const resolved = getResolvedCreds(ctx.workspaceRoot, {
            orgUrl: input.orgUrl,
            project: input.project,
            personalAccessToken: input.pat,
        });
        if (!resolved.creds) {
            return {
                ok: false,
                verb: 'generate-manual-tcs-from-story',
                storyId: input.storyId,
                created: [],
                skippedDuplicates: [],
                warnings,
                note: `ADO creds unresolved — ${resolved.diagnostic}`,
            };
        }
        const creds: AdoCreds = resolved.creds;
        const client = new AdoHttpClient(creds);
        const orgBase = creds.orgUrl.replace(/\/$/, '');

        // ------------------------------------------------------------------
        // Round 2 — Copilot has drafted TCs and confirmed. Create + link.
        // ------------------------------------------------------------------
        const drafts = input.draftedTestCases;
        const wantsRound2 = Array.isArray(drafts) && drafts.length > 0;

        if (wantsRound2 && !input.confirmed) {
            return {
                ok: false,
                verb: 'generate-manual-tcs-from-story',
                storyId: input.storyId,
                requiresConfirmation: true,
                confirmationHint: `draftedTestCases provided (${drafts!.length}), but confirmed:true is required. Retry the SAME call with confirmed:true after the human explicitly agrees to create ${drafts!.length} Test Case(s) in ADO.`,
                created: [],
                skippedDuplicates: [],
                warnings,
                note: `Round 2 requires confirmed:true.`,
            };
        }

        if (wantsRound2 && input.confirmed) {
            // Fetch story (for link + display) + resolve suite.
            let story: Awaited<ReturnType<typeof fetchStory>>;
            try {
                story = await fetchStory(client, input.storyId);
            } catch (e) {
                return {
                    ok: false,
                    verb: 'generate-manual-tcs-from-story',
                    storyId: input.storyId,
                    created: [],
                    skippedDuplicates: [],
                    warnings,
                    note: `Failed to fetch story #${input.storyId}: ${(e as Error).message.slice(0, 300)}`,
                };
            }

            const targetSuite = await resolveTargetSuite(client, input, warnings);
            if (!targetSuite) {
                return {
                    ok: false,
                    verb: 'generate-manual-tcs-from-story',
                    storyId: input.storyId,
                    story: {
                        id: story.id, title: story.title, description: story.description,
                        acceptanceCriteria: stripHtmlToPlain(story.acceptanceCriteriaHtml),
                        tags: story.tags,
                    },
                    created: [],
                    skippedDuplicates: [],
                    warnings,
                    note: `Could not resolve target suite in plan #${input.targetPlanId}.`,
                };
            }
            const planName = await fetchPlanName(client, input.targetPlanId);

            // Validate all drafts before any writes.
            const { valid, issues } = validateDrafts(drafts!);
            for (const iss of issues) {
                warnings.push(`Draft #${iss.index} ("${iss.title}") rejected: ${iss.reasons.join('; ')}`);
            }
            if (valid.length === 0) {
                return {
                    ok: false,
                    verb: 'generate-manual-tcs-from-story',
                    storyId: input.storyId,
                    story: {
                        id: story.id, title: story.title, description: story.description,
                        acceptanceCriteria: stripHtmlToPlain(story.acceptanceCriteriaHtml),
                        tags: story.tags,
                    },
                    targetPlan: { id: input.targetPlanId, name: planName },
                    targetSuite,
                    created: [],
                    skippedDuplicates: [],
                    warnings,
                    note: `Zero valid drafts — nothing to create.`,
                };
            }

            // Dedupe by title before creating.
            const skippedDuplicates: Output['skippedDuplicates'] = [];
            let toCreate = valid;
            if (input.dedupeByTitle) {
                const survivors: typeof valid = [];
                for (const v of valid) {
                    const existing = await findExistingTcByTitle(client, v.draft.title);
                    if (existing !== null) {
                        skippedDuplicates.push({
                            title: v.draft.title,
                            existingTcId: existing,
                            reason: `Test Case #${existing} with identical title already exists`,
                        });
                    } else {
                        survivors.push(v);
                    }
                }
                toCreate = survivors;
            }

            if (input.dryRun) {
                return {
                    ok: true,
                    verb: 'generate-manual-tcs-from-story',
                    storyId: input.storyId,
                    story: {
                        id: story.id, title: story.title, description: story.description,
                        acceptanceCriteria: stripHtmlToPlain(story.acceptanceCriteriaHtml),
                        tags: story.tags,
                    },
                    targetPlan: { id: input.targetPlanId, name: planName },
                    targetSuite,
                    created: [],
                    skippedDuplicates,
                    warnings,
                    note: `dryRun:true — ${toCreate.length} Test Case(s) would be created, ${skippedDuplicates.length} skipped as duplicate, ${issues.length} rejected.`,
                };
            }

            // Bulk-create with concurrency 4 + per-item isolation.
            interface CreatedTc {
                draftIndex: number;
                tcId: number;
                url: string;
                title: string;
                warnings: string[];
                linkedToStory: boolean;
            }

            const bulkOut = await bulkExecute<{ index: number; draft: z.infer<typeof TestCaseDraftSchema> }, CreatedTc>(
                toCreate,
                {
                    chunkSize: 1, // one WI per POST; concurrency provides parallelism
                    concurrency: 4,
                    workFn: async (chunk) => {
                        const item = chunk[0];
                        const patch = buildPatchDoc({
                            draft: item.draft,
                            input,
                            storyId: input.storyId,
                            storyTitle: story.title,
                            orgBase,
                            defaultPriority: input.priority,
                        });
                        const created = await client.post<RawWorkItem>(`_apis/wit/workitems/$${encodeURIComponent('Test Case')}?api-version=7.1`, patch);
                        if (!created.id) throw new Error('ADO returned Test Case with no id');
                        // Determine linkedToStory by inspecting relations echoed back.
                        const rels = created.relations || [];
                        const linkedToStory = rels.some((r) =>
                            (r.rel === 'System.LinkTypes.Hierarchy-Reverse' || r.rel === 'Microsoft.VSTS.Common.TestedBy-Forward')
                            && r.url.endsWith(`/${input.storyId}`),
                        );
                        return [{
                            draftIndex: item.index,
                            tcId: created.id,
                            url: created.url || `${orgBase}/_workitems/edit/${created.id}`,
                            title: item.draft.title,
                            warnings: [],
                            linkedToStory,
                        }];
                    },
                    onChunkError: (err, chunk) => {
                        log.warn('tc-create-failed', {
                            draftIndex: chunk[0]?.index,
                            title: chunk[0]?.draft?.title?.slice(0, 80),
                            error: err.message.slice(0, 200),
                        });
                    },
                },
            );

            for (const f of bulkOut.failed) {
                warnings.push(`Draft #${f.item.index} ("${f.item.draft.title}") create failed: ${f.error.message.slice(0, 200)}`);
            }

            // Add successfully-created TCs to the target suite (batched).
            const okTcIds = bulkOut.ok.map((c) => c.tcId);
            const suiteResult = await addTestCasesToSuite(client, input.targetPlanId, targetSuite.id, okTcIds);
            const addedSet = new Set(suiteResult.added);
            for (const sf of suiteResult.failed) {
                warnings.push(`Test Case #${sf.tcId} created but suite-add failed: ${sf.error}`);
            }

            const created: Output['created'] = bulkOut.ok.map((c) => ({
                tcId: c.tcId,
                url: c.url,
                title: c.title,
                addedToSuite: addedSet.has(c.tcId),
                linkedToStory: c.linkedToStory,
                warnings: c.warnings,
            }));

            log.info('round-2-complete', {
                storyId: input.storyId,
                planId: input.targetPlanId,
                suiteId: targetSuite.id,
                created: created.length,
                skippedDuplicates: skippedDuplicates.length,
                rejected: issues.length,
                createFailed: bulkOut.failed.length,
            });

            return {
                ok: true,
                verb: 'generate-manual-tcs-from-story',
                storyId: input.storyId,
                story: {
                    id: story.id,
                    title: story.title,
                    description: story.description,
                    acceptanceCriteria: stripHtmlToPlain(story.acceptanceCriteriaHtml),
                    tags: story.tags,
                },
                targetPlan: { id: input.targetPlanId, name: planName },
                targetSuite,
                created,
                skippedDuplicates,
                warnings,
                note: `${created.length} Test Case(s) created, ${skippedDuplicates.length} deduped, ${bulkOut.failed.length} failed, ${issues.length} rejected as invalid.`,
            };
        }

        // ------------------------------------------------------------------
        // Round 1 — Discovery + suggestions + drafting template.
        // ------------------------------------------------------------------
        let story: Awaited<ReturnType<typeof fetchStory>>;
        try {
            story = await fetchStory(client, input.storyId);
        } catch (e) {
            return {
                ok: false,
                verb: 'generate-manual-tcs-from-story',
                storyId: input.storyId,
                created: [],
                skippedDuplicates: [],
                warnings,
                note: `Failed to fetch story #${input.storyId}: ${(e as Error).message.slice(0, 300)}`,
            };
        }

        const parsedAcs = splitAcceptanceCriteria(story.acceptanceCriteriaHtml);
        if (parsedAcs.length === 0) {
            warnings.push('Story has no parseable Acceptance Criteria — draft freely from title + description.');
        }

        const targetSuite = await resolveTargetSuite(client, input, warnings);
        if (!targetSuite) {
            return {
                ok: false,
                verb: 'generate-manual-tcs-from-story',
                storyId: input.storyId,
                story: {
                    id: story.id, title: story.title, description: story.description,
                    acceptanceCriteria: stripHtmlToPlain(story.acceptanceCriteriaHtml),
                    tags: story.tags,
                },
                parsedAcceptanceCriteria: parsedAcs,
                created: [],
                skippedDuplicates: [],
                warnings,
                note: `Could not resolve target suite in plan #${input.targetPlanId}.`,
            };
        }
        const planName = await fetchPlanName(client, input.targetPlanId);

        const suggested = proposeTestCases(parsedAcs);
        const draftTemplate: z.infer<typeof DraftTemplateSchema> = {
            requiredFields: ['title', 'steps'],
            stepShape: {
                action: 'One imperative sentence describing what the manual tester does.',
                expectedResult: 'Optional. Concrete observable outcome after the action.',
                data: 'Optional. Any test data used in this step (username, amount, etc.).',
            },
            example: {
                title: 'Verify happy-path login with valid credentials',
                preconditions: 'App is reachable, test user exists and is not locked.',
                priority: 2,
                steps: [
                    { action: 'Open the login page.', expectedResult: 'Login form is displayed with Username and Password fields.' },
                    { action: 'Enter valid username and password.', expectedResult: 'Fields accept input; no validation error is shown.' },
                    { action: 'Click Sign In.', expectedResult: 'User is redirected to the dashboard; their name appears in the header.' },
                ],
            },
        };

        const guidance = [
            `Round 1 discovery complete. Present the suggestedTestCases to the human, let them prune / adjust, then compose full test-case drafts.`,
            `Each draft must include: title (≤254 chars), steps[] (≥1, each with an action). Optional: description, preconditions, priority (1-4), automationStatus, acReference, kind.`,
            `Call this SAME tool again with draftedTestCases:[...] AND confirmed:true. Round 2 will bulk-create the Test Cases and add them to suite "${targetSuite.name}" (#${targetSuite.id}) in plan "${planName}" (#${input.targetPlanId}).`,
            `Each Test Case will be linked to Story #${input.storyId} using ${input.linkStoryAsParent ? 'Hierarchy-Reverse (parent)' : 'TestedBy-Forward'}.`,
        ].join(' ');

        log.info('round-1-complete', {
            storyId: input.storyId,
            planId: input.targetPlanId,
            suiteId: targetSuite.id,
            acsParsed: parsedAcs.length,
            suggestions: suggested.length,
        });

        return {
            ok: true,
            verb: 'generate-manual-tcs-from-story',
            storyId: input.storyId,
            story: {
                id: story.id,
                title: story.title,
                description: story.description,
                acceptanceCriteria: stripHtmlToPlain(story.acceptanceCriteriaHtml),
                tags: story.tags,
            },
            parsedAcceptanceCriteria: parsedAcs,
            targetPlan: { id: input.targetPlanId, name: planName },
            targetSuite,
            suggestedTestCases: suggested,
            draftTemplate,
            requiresDrafting: true,
            guidance,
            created: [],
            skippedDuplicates: [],
            warnings,
            note: `Parsed ${parsedAcs.length} AC(s), proposed ${suggested.length} candidate title(s). Awaiting draftedTestCases + confirmed:true.`,
        };
    },
});

// ---------------------------------------------------------------------------
// Suite resolution — shared by Round 1 + Round 2
// ---------------------------------------------------------------------------

async function resolveTargetSuite(client: AdoHttpClient, input: Input, warnings: string[]): Promise<{ id: number; name: string } | null> {
    if (input.targetSuiteId) {
        const byId = await findSuiteById(client, input.targetPlanId, input.targetSuiteId);
        if (byId) return byId;
        warnings.push(`targetSuiteId #${input.targetSuiteId} not found in plan #${input.targetPlanId} — falling back to root suite.`);
    } else if (input.targetSuiteName) {
        const byName = await findSuiteByName(client, input.targetPlanId, input.targetSuiteName);
        if (byName) return byName;
        warnings.push(`targetSuiteName "${input.targetSuiteName}" not found in plan #${input.targetPlanId} — falling back to root suite.`);
    }
    const root = await fetchPlanRootSuite(client, input.targetPlanId);
    if (root) return { id: root.id, name: root.name };
    return null;
}
