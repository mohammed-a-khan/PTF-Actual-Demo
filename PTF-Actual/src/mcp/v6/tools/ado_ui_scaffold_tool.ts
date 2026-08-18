/**
 * cs_qa_ui_scaffold — reverse of cs_qa_publish_feature_to_ado.
 *
 * Reads one ADO Test Case (by id OR title), parses its steps XML, and
 * generates the full framework artifact set for it:
 *
 *   test/<slug>/pages/story-<id>/<PageName>Page.ts
 *   test/<slug>/features/story-<id>/<slug>.feature
 *   test/<slug>/steps/<PageName>Steps.steps.ts
 *   test/<slug>/data/uat/story-<id>/scenarios.json
 *   config/<slug>/environments/uat.env               (only when it does not
 *                                                     already define BASE_URL)
 *
 * When `generateLive:true` is passed AND a `baseUrl` is supplied, the tool
 * fetches the live URL via dom_fetcher and grafts real locators into the
 * page object. When `generateLive` is off (default) it synthesises
 * plausible locators from step-text verbs; the caller can sync them later
 * via cs_qa_sync_locators.
 *
 * On the way out we call sync_feature_tags so the generated feature file
 * carries `@TestCaseId:<n>` (and `@TestPlanId`/`@TestSuiteId` when known)
 * from the very first commit — no drift between generation and publish.
 *
 * `dryRun:true` composes every artifact string but writes nothing.
 * `outputRoot`, `slug`, and per-file paths are derived when not supplied.
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import { createLogger } from './_helpers/structured_logger';
import { AdoHttpClient, type AdoCreds } from './_helpers/ado_http_client';
import { getResolvedCreds } from './ado_config_tool';
import { parseTestCaseStepsXml, type ActionStep } from './_helpers/tc_steps_parser';
import { fetchDom } from './_helpers/dom_fetcher';
import { parseInteractiveDom, type ExtractedElement } from './_helpers/dom_parser';
import { buildArtifacts, derivePascalName } from './_helpers/scaffold_generator';
import { syncFeatureAfterPublish, type ScenarioMapping } from './sync_feature_tags';
import { wiql } from './_helpers/wiql_builder';

// -----------------------------------------------------------------------
// Slug inference from workspaceRoot's package.json / basename.
// -----------------------------------------------------------------------

function inferSlug(workspaceRoot: string): string {
    try {
        const pkgPath = path.join(workspaceRoot, 'package.json');
        if (fs.existsSync(pkgPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { name?: string };
            if (pkg.name) {
                const clean = pkg.name.replace(/^@[^/]+\//, '').toLowerCase();
                if (clean) return clean.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'app';
            }
        }
    } catch { /* fall through */ }
    return path.basename(workspaceRoot).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-') || 'app';
}

// -----------------------------------------------------------------------
// Tag → story-id extraction (used to derive feature folder + data folder).
// -----------------------------------------------------------------------

const STORY_TAG_RE = /^@story-(\d+)$/i;
const AC_TAG_RE = /^@ac(\d+)$/i;

function extractStoryTag(tags: string[]): { storyId?: number; storyLabel: string } {
    for (const t of tags) {
        const m = STORY_TAG_RE.exec(t);
        if (m) return { storyId: Number(m[1]), storyLabel: `story-${m[1]}` };
    }
    return { storyLabel: 'story-untagged' };
}

function extractAcTag(tags: string[]): string {
    for (const t of tags) if (AC_TAG_RE.test(t)) return t.replace(/^@/, '');
    return 'ac1';
}

// -----------------------------------------------------------------------
// Zod schemas.
// -----------------------------------------------------------------------

const InputSchema = z.object({
    testCaseId: z.number().int().positive().optional(),
    testCaseTitle: z.string().min(1).optional(),
    targetPagePath: z.string().optional().describe('Explicit path (workspace-relative) for the page object. When omitted, auto-derived from the test case title + slug + story tag.'),
    baseUrl: z.string().url().optional().describe('Base URL for the page under test. Used both for locator extraction (when generateLive:true) AND as the BASE_URL emitted into the env file.'),
    generateLive: z.boolean().default(false).describe('When true and baseUrl is set, fetch the URL and derive real locators. Otherwise synthesise from step-verb heuristics.'),
    outputRoot: z.string().optional().describe('Root folder (workspace-relative) under which page/feature/steps/data go. Defaults to `test/<slug>`.'),
    slug: z.string().optional().describe('Project slug — used for folder naming AND @CSPage decoration. Defaults to inferred from the workspace package.json name.'),
    dryRun: z.boolean().default(false),
    /** ADO overrides — normally read from cascade. */
    orgUrl: z.string().url().optional(),
    project: z.string().min(1).optional(),
    pat: z.string().min(1).optional(),
    /** Whether to write `@TestCaseId:<n>` back into the generated feature file. Default true. */
    syncBackTags: z.boolean().default(true),
    /** Cap on decorated elements in the page object. */
    maxElements: z.number().int().positive().default(12),
}).refine((v) => v.testCaseId !== undefined || v.testCaseTitle !== undefined, {
    message: 'testCaseId or testCaseTitle is required',
});
type Input = z.infer<typeof InputSchema>;

const GeneratedFileSchema = z.object({
    path: z.string(),
    kind: z.enum(['page-object', 'feature', 'steps', 'data', 'env']),
    size: z.number(),
    /** When dryRun:true, the composed content is included so the caller can preview. */
    previewContent: z.string().optional(),
    /** When dryRun:false and the file already existed with the same content, this is true and the file was not rewritten. */
    unchanged: z.boolean().optional(),
    /** When dryRun:false and the file already existed with different content, this is true and the file was NOT overwritten. */
    conflict: z.boolean().optional(),
});
const OutputSchema = z.object({
    ok: z.boolean(),
    testCaseId: z.number().optional(),
    testCaseTitle: z.string(),
    slug: z.string(),
    outputRoot: z.string(),
    pageObjectPath: z.string(),
    generatedFiles: z.array(GeneratedFileSchema),
    dryRun: z.boolean(),
    driftWarnings: z.array(z.string()),
    unresolvedRequirements: z.array(z.string()),
    suggestedManualReview: z.array(z.string()),
    domInspection: z.object({
        attempted: z.boolean(),
        ok: z.boolean(),
        elementsFound: z.number(),
        authRequired: z.boolean().optional(),
        parseMethod: z.enum(['jsdom', 'regex']).optional(),
        note: z.string().optional(),
    }).optional(),
    warnings: z.array(z.string()),
    note: z.string().optional(),
});
type Output = z.infer<typeof OutputSchema>;

// -----------------------------------------------------------------------
// Test-case lookup (id or title).
// -----------------------------------------------------------------------

interface TcFields { fields?: Record<string, unknown>; id?: number }

async function fetchTcById(client: AdoHttpClient, id: number): Promise<TcFields | null> {
    const wi = await client.get<TcFields>(`_apis/wit/workitems/${id}?$expand=all&api-version=7.0`);
    if (!wi || typeof wi.id !== 'number') return null;
    return wi;
}

async function fetchTcByTitle(client: AdoHttpClient, title: string): Promise<TcFields | null> {
    // WIQL string values MUST be escaped via the shared builder — never hand-concatenate.
    const query = wiql()
        .select(['[System.Id]', '[System.Title]'])
        .from('WorkItems')
        .where()
        .equals('[System.WorkItemType]', 'Test Case')
        .and().equals('[System.Title]', title)
        .done()
        .build();
    const r = await client.post<{ workItems?: Array<{ id: number }> }>(`_apis/wit/wiql?api-version=7.0`, { query });
    const ids = (r.workItems || []).map((w) => w.id);
    if (ids.length === 0) return null;
    return fetchTcById(client, ids[0]);
}

// -----------------------------------------------------------------------
// Data-row synthesis from step placeholders + step text.
// -----------------------------------------------------------------------

function synthesiseDataRows(steps: ActionStep[], scenarioId: string): Array<Record<string, string>> {
    // Collect placeholders <field> that appear in step text, and any
    // "enter X as Y" pairs that give us seed values.
    const placeholders = new Set<string>();
    const inferred: Record<string, string> = {};
    const placeholderRe = /<([a-zA-Z][a-zA-Z0-9_]*)>/g;
    const fieldValueRe = /\b(?:enter|fill|set|input|type)\s+(?:the\s+)?["']?([A-Za-z][A-Za-z0-9 _-]{1,40})["']?\s+(?:as|with|to|=)\s+["']?([^"'\s<>]+)["']?/i;
    for (const s of steps) {
        let m: RegExpExecArray | null;
        while ((m = placeholderRe.exec(s.action)) !== null) placeholders.add(m[1]);
        while ((m = placeholderRe.exec(s.expected)) !== null) placeholders.add(m[1]);
        const fv = fieldValueRe.exec(s.action);
        if (fv) {
            const key = fv[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
            const val = fv[2];
            if (key && !(key in inferred)) inferred[key] = val;
        }
    }
    const row: Record<string, string> = { scenarioId };
    for (const p of placeholders) {
        if (!(p in row)) row[p] = inferred[p.toLowerCase()] ?? '';
    }
    // If no placeholders and no inferred values, at least keep scenarioId.
    return [row];
}

// -----------------------------------------------------------------------
// Runtime.
// -----------------------------------------------------------------------

interface WrittenTrack { path: string; kind: 'page-object' | 'feature' | 'steps' | 'data' | 'env'; size: number; previewContent?: string; unchanged?: boolean; conflict?: boolean }

function writeIfChanged(absPath: string, content: string): { size: number; unchanged: boolean; conflict: boolean } {
    if (fs.existsSync(absPath)) {
        const existing = fs.readFileSync(absPath, 'utf-8');
        if (existing === content) return { size: Buffer.byteLength(content, 'utf-8'), unchanged: true, conflict: false };
        // Conflict — we NEVER silently overwrite an existing test artifact
        // (would risk clobbering the user's hand-tuned locators).
        return { size: Buffer.byteLength(existing, 'utf-8'), unchanged: false, conflict: true };
    }
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, 'utf-8');
    return { size: Buffer.byteLength(content, 'utf-8'), unchanged: false, conflict: false };
}

function appendEnvIfMissing(envAbs: string, additions: string, keys: string[]): { added: string[]; skipped: string[] } {
    const added: string[] = [];
    const skipped: string[] = [];
    const existing = fs.existsSync(envAbs) ? fs.readFileSync(envAbs, 'utf-8') : '';
    const toAppendLines: string[] = [];
    for (const line of additions.split(/\r?\n/)) {
        if (!line || line.startsWith('#')) { toAppendLines.push(line); continue; }
        const key = line.split('=')[0];
        if (!key) { toAppendLines.push(line); continue; }
        const keyRe = new RegExp(`^\\s*${key}\\s*=`, 'm');
        if (keyRe.test(existing)) { skipped.push(key); continue; }
        toAppendLines.push(line);
        if (keys.includes(key)) added.push(key);
    }
    if (added.length === 0 && !existing.trim()) {
        // Fresh file — still create it so the user has a starting point.
        fs.mkdirSync(path.dirname(envAbs), { recursive: true });
        fs.writeFileSync(envAbs, additions, 'utf-8');
        return { added: keys.slice(), skipped };
    }
    if (added.length === 0) return { added, skipped };
    const combined = existing + (existing.endsWith('\n') || !existing ? '' : '\n') + '\n# --- appended by cs_qa_ui_scaffold ---\n' + toAppendLines.filter(Boolean).join('\n') + '\n';
    fs.mkdirSync(path.dirname(envAbs), { recursive: true });
    fs.writeFileSync(envAbs, combined, 'utf-8');
    return { added, skipped };
}

export async function runUiScaffold(ctx: { workspaceRoot: string; invocationId: string }, input: Input): Promise<Output> {
    const logger = createLogger(ctx.invocationId, 'cs_qa_ui_scaffold', { workspaceRoot: ctx.workspaceRoot });
    logger.info('ui-scaffold-start', { testCaseId: input.testCaseId, testCaseTitle: input.testCaseTitle, dryRun: input.dryRun });

    const slug = (input.slug && input.slug.trim()) || inferSlug(ctx.workspaceRoot);
    const outputRoot = input.outputRoot || `test/${slug}`;

    // Load ADO creds.
    const resolved = getResolvedCreds(ctx.workspaceRoot, {
        orgUrl: input.orgUrl, project: input.project, personalAccessToken: input.pat,
    });
    if (!resolved.creds) {
        return {
            ok: false, testCaseTitle: input.testCaseTitle ?? '',
            slug, outputRoot, pageObjectPath: '',
            generatedFiles: [], dryRun: input.dryRun, driftWarnings: [],
            unresolvedRequirements: [], suggestedManualReview: [], warnings: [],
            note: `ADO not configured — ${resolved.diagnostic}`,
        };
    }
    const cfg: AdoCreds = resolved.creds;
    const client = new AdoHttpClient(cfg);

    // Fetch TC.
    let tc: TcFields | null = null;
    try {
        if (input.testCaseId) tc = await fetchTcById(client, input.testCaseId);
        else if (input.testCaseTitle) tc = await fetchTcByTitle(client, input.testCaseTitle);
    } catch (e) {
        return {
            ok: false, testCaseTitle: input.testCaseTitle ?? '',
            slug, outputRoot, pageObjectPath: '',
            generatedFiles: [], dryRun: input.dryRun, driftWarnings: [],
            unresolvedRequirements: [], suggestedManualReview: [], warnings: [],
            note: `Failed to fetch test case: ${(e as Error).message}`,
        };
    }
    if (!tc || !tc.fields) {
        return {
            ok: false, testCaseTitle: input.testCaseTitle ?? '',
            slug, outputRoot, pageObjectPath: '',
            generatedFiles: [], dryRun: input.dryRun, driftWarnings: [],
            unresolvedRequirements: [], suggestedManualReview: [], warnings: [],
            note: input.testCaseId
                ? `Test case #${input.testCaseId} not found or inaccessible in project ${cfg.project}.`
                : `No test case matched title "${input.testCaseTitle}" in project ${cfg.project}.`,
        };
    }
    const tcId = Number(tc.id);
    const fields = tc.fields;
    const title = String(fields['System.Title'] || `Test Case ${tcId}`);
    const stepsXml = String(fields['Microsoft.VSTS.TCM.Steps'] || '');
    const tagsRaw = String(fields['System.Tags'] || '');
    const tagList = tagsRaw.split(/[,;]/).map((t) => t.trim()).filter(Boolean).map((t) => t.startsWith('@') ? t : '@' + t);

    const steps = parseTestCaseStepsXml(stepsXml);
    const { storyId, storyLabel } = extractStoryTag(tagList);
    const acTag = extractAcTag(tagList);

    // Derive paths.
    const pageName = derivePascalName(title, 'Page');
    const pagePath = input.targetPagePath
        ? input.targetPagePath
        : path.posix.join(outputRoot, 'pages', storyLabel, `${pageName}.ts`);
    const featureFolderRel = path.posix.join(outputRoot, 'features', storyLabel);
    const featureFileName = `${slug}.feature`;
    const stepsClassName = pageName.replace(/Page$/, '') + 'Steps';
    const stepsFileName = `${stepsClassName}.steps.ts`;
    const stepsPathRel = path.posix.join(outputRoot, 'steps', stepsFileName);
    const dataFileRel = path.posix.join(outputRoot, 'data', 'uat', storyLabel, 'scenarios.json');
    const envRel = path.posix.join('config', slug, 'environments', 'uat.env');

    // Optional live DOM inspection.
    let domElements: ExtractedElement[] = [];
    const suggested: string[] = [];
    const unresolved: string[] = [];
    const driftWarnings: string[] = [];
    let domInspection: Output['domInspection'] | undefined;
    if (input.generateLive) {
        if (!input.baseUrl) {
            driftWarnings.push('generateLive:true requested but no baseUrl provided — falling back to step-verb locator synthesis.');
            domInspection = { attempted: false, ok: false, elementsFound: 0 };
        } else {
            const fr = await fetchDom({ url: input.baseUrl, followRedirects: true, maxRedirects: 3, timeoutMs: 15_000 });
            if (fr.authRequired) {
                driftWarnings.push(`baseUrl ${input.baseUrl} is behind an auth gate (${fr.authReason || 'unknown'}). Locator synthesis fell back to step-verb heuristics.`);
                domInspection = { attempted: true, ok: false, elementsFound: 0, authRequired: true, note: fr.authReason };
                suggested.push(`Review page-object locators manually — the baseUrl redirected to an auth gate before locator extraction could complete.`);
            } else if (!fr.ok) {
                driftWarnings.push(`baseUrl ${input.baseUrl} fetch failed (status ${fr.status}${fr.fetchError ? ', ' + fr.fetchError : ''}); using step-verb heuristics.`);
                domInspection = { attempted: true, ok: false, elementsFound: 0, note: fr.fetchError || `HTTP ${fr.status}` };
            } else {
                const parsed = parseInteractiveDom(fr.html);
                domElements = parsed.elements;
                domInspection = { attempted: true, ok: true, elementsFound: parsed.elements.length, parseMethod: parsed.parseMethod, note: parsed.warnings.join('; ') || undefined };
                for (const w of parsed.warnings) driftWarnings.push(`dom parse: ${w}`);
            }
        }
    } else {
        if (input.baseUrl) suggested.push('generateLive:false — the emitted page-object locators are heuristics from step text; re-run with generateLive:true or use cs_qa_sync_locators once the app is reachable.');
    }

    // Data rows.
    const dataRows = synthesiseDataRows(steps, acTag);

    // Build artifacts.
    const featureTags = [
        storyId ? `@${storyLabel}` : null,
    ].filter(Boolean) as string[];
    const scenarioTags: string[] = [
        `@${acTag}`,
        `@TestCaseId:${tcId}`,
    ];

    const artifacts = buildArtifacts({
        testCaseId: tcId,
        testCaseTitle: title,
        slug,
        pageName,
        pagePath: pagePath,
        featureFolderRel,
        featureFileName,
        stepsClassName,
        stepsFileName,
        dataFileRel,
        baseUrl: input.baseUrl,
        featureTags,
        scenarioTags,
        steps,
        dataRows,
        domElements: domElements.length > 0 ? domElements : undefined,
        maxElements: input.maxElements,
    });

    // Attach post-hoc warnings when the page object came from heuristics only.
    if (artifacts.elementSource === 'step-verb-synthesis' && (!input.generateLive || domElements.length === 0)) {
        driftWarnings.push('Page object locators were synthesised from step text — expect drift on first run. Fix via cs_qa_sync_locators after the app is reachable.');
    }
    if (artifacts.elementSource === 'empty') {
        unresolved.push('No locators identified — step text was too abstract and no baseUrl was inspected. Populate manually or re-run with generateLive:true.');
    }
    if (steps.length === 0) {
        unresolved.push(`Test case #${tcId} carried no Microsoft.VSTS.TCM.Steps rows — generated a single placeholder scenario.`);
    }

    // Write (or preview) each file.
    const generated: WrittenTrack[] = [];
    const featurePathAbs = path.join(ctx.workspaceRoot, featureFolderRel, featureFileName);
    const pagePathAbs = path.join(ctx.workspaceRoot, pagePath);
    const stepsPathAbs = path.join(ctx.workspaceRoot, stepsPathRel);
    const dataPathAbs = path.join(ctx.workspaceRoot, dataFileRel);
    const envAbs = path.join(ctx.workspaceRoot, envRel);

    if (input.dryRun) {
        generated.push({ path: pagePath, kind: 'page-object', size: Buffer.byteLength(artifacts.pageObject, 'utf-8'), previewContent: artifacts.pageObject });
        generated.push({ path: path.posix.join(featureFolderRel, featureFileName), kind: 'feature', size: Buffer.byteLength(artifacts.feature, 'utf-8'), previewContent: artifacts.feature });
        generated.push({ path: stepsPathRel, kind: 'steps', size: Buffer.byteLength(artifacts.steps, 'utf-8'), previewContent: artifacts.steps });
        generated.push({ path: dataFileRel, kind: 'data', size: Buffer.byteLength(artifacts.data, 'utf-8'), previewContent: artifacts.data });
        if (artifacts.envAdditions.trim().length > 0) generated.push({ path: envRel, kind: 'env', size: Buffer.byteLength(artifacts.envAdditions, 'utf-8'), previewContent: artifacts.envAdditions });
    } else {
        const po = writeIfChanged(pagePathAbs, artifacts.pageObject);
        generated.push({ path: pagePath, kind: 'page-object', size: po.size, unchanged: po.unchanged, conflict: po.conflict });
        if (po.conflict) driftWarnings.push(`Page object ${pagePath} already exists with different content — NOT overwritten. Delete it or set targetPagePath to a fresh file.`);

        const feat = writeIfChanged(featurePathAbs, artifacts.feature);
        const featureRelPath = path.posix.join(featureFolderRel, featureFileName);
        generated.push({ path: featureRelPath, kind: 'feature', size: feat.size, unchanged: feat.unchanged, conflict: feat.conflict });
        if (feat.conflict) driftWarnings.push(`Feature file ${featureRelPath} already exists with different content — NOT overwritten.`);

        const stepsOut = writeIfChanged(stepsPathAbs, artifacts.steps);
        generated.push({ path: stepsPathRel, kind: 'steps', size: stepsOut.size, unchanged: stepsOut.unchanged, conflict: stepsOut.conflict });
        if (stepsOut.conflict) driftWarnings.push(`Steps file ${stepsPathRel} already exists with different content — NOT overwritten.`);

        const data = writeIfChanged(dataPathAbs, artifacts.data);
        generated.push({ path: dataFileRel, kind: 'data', size: data.size, unchanged: data.unchanged, conflict: data.conflict });
        if (data.conflict) driftWarnings.push(`Data file ${dataFileRel} already exists with different content — NOT overwritten.`);

        if (artifacts.envAdditions.trim().length > 0) {
            const envRes = appendEnvIfMissing(envAbs, artifacts.envAdditions, artifacts.envKeysAdded);
            if (envRes.added.length > 0) {
                generated.push({ path: envRel, kind: 'env', size: fs.existsSync(envAbs) ? fs.statSync(envAbs).size : 0 });
            }
            if (envRes.skipped.length > 0) driftWarnings.push(`Env file ${envRel} already had keys: ${envRes.skipped.join(', ')} — not overwritten.`);
        }

        // Sync-back @TestCaseId onto the freshly written feature file.
        if (input.syncBackTags && fs.existsSync(featurePathAbs)) {
            try {
                // Find the scenario line in the file we just wrote.
                const contentLines = artifacts.feature.split('\n');
                const scLine = contentLines.findIndex((ln) => /^\s*Scenario\b/.test(ln)) + 1; // 1-indexed
                const mapping: ScenarioMapping = {
                    scenarioLine: scLine,
                    scenarioName: title,
                    testCaseIds: [tcId],
                };
                const syncRes = syncFeatureAfterPublish(featurePathAbs, [mapping], ctx.workspaceRoot);
                if (syncRes.driftWarnings.length > 0) {
                    for (const w of syncRes.driftWarnings) driftWarnings.push(`sync-back: ${w}`);
                }
            } catch (e) {
                driftWarnings.push(`sync-back failed for ${path.posix.join(featureFolderRel, featureFileName)}: ${(e as Error).message}`);
            }
        }
    }

    logger.info('ui-scaffold-done', { testCaseId: tcId, filesGenerated: generated.length, dryRun: input.dryRun });

    return {
        ok: true, testCaseId: tcId, testCaseTitle: title,
        slug, outputRoot, pageObjectPath: pagePath,
        generatedFiles: generated,
        dryRun: input.dryRun,
        driftWarnings, unresolvedRequirements: unresolved, suggestedManualReview: suggested,
        domInspection,
        warnings: [],
        note: `${input.dryRun ? '[dry-run] would generate' : 'Generated'} ${generated.length} artifact(s) for test case #${tcId} ("${title}"). ${artifacts.elementSource === 'live-dom' ? 'Locators from live DOM.' : artifacts.elementSource === 'step-verb-synthesis' ? 'Locators from step-verb synthesis.' : artifacts.elementSource === 'both' ? 'Locators from live DOM + step-verb synthesis.' : 'No locators identified.'}`,
    };
}

registerPrimitive<Input, Output>({
    name: 'cs_qa_ui_scaffold',
    description: 'Generate the complete test artifact set (page object, feature file, step-definitions, data JSON, env additions) from an ADO Test Case. Reverse of cs_qa_publish_feature_to_ado. Reads the TC by id or title, parses steps XML into ActionSteps, derives page-object name via title de-prefixing, infers folder layout from tags (@story-<n> → story-<n> folder), optionally fetches a live URL via dom_fetcher for real locators (generateLive:true + baseUrl), synthesises plausible locators from step-text verbs otherwise. Writes only when no conflict (existing file with different content is never overwritten). syncBackTags:true appends @TestCaseId:<n> to the generated feature scenario so it participates in future sync-back rounds.',
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    run: async (ctx, input) => runUiScaffold(ctx, input),
});
