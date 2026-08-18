/**
 * cs_qa_check_existing_tests — before generating a fresh test, ask "does one
 * already exist that covers this story's ACs?". Walks the test/ tree, parses
 * every .feature (tags + scenario titles + step text), every .steps.ts
 * (@CSBDDStepDef regex patterns), and every .page.ts (@CSPage slugs), and
 * matches per AC.
 *
 * Match strategy (per AC):
 *   1. Exact @TestCaseId:<n> from the story's linkedTestCaseIds  → conf 1.0
 *   2. @LinkedStory:<storyId> tag on the feature                 → conf 0.9
 *   3. @ac<n> tag matching the AC's index                        → conf 0.85
 *   4. Token overlap between AC text and (scenario title + step
 *      text) ≥ matchThreshold                                    → conf = ratio
 *
 * Output guides the orchestrator: extend-existing (high-confidence coverage
 * across enough ACs), generate-new (no coverage at all), or ask-user
 * (partial + ambiguous — human decides).
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import { AdoHttpClient } from './_helpers/ado_http_client';
import { createLogger } from './_helpers/structured_logger';
import { getResolvedCreds } from './ado_config_tool';

const InputSchema = z.object({
    storyId: z.number().int().positive().optional().describe('Story id used to look up @LinkedStory:<id> tag matches AND to load AC checkpoint from .cs-qa/run-state/story-<id>-acs.json when acCheckpointPath is omitted.'),
    linkedTestCaseIds: z.array(z.number().int().positive()).default([]).describe('Test-case ids already linked to the story via cs_qa_ado_read output. Used for @TestCaseId:<n> exact matches (confidence 1.0).'),
    acCheckpointPath: z.string().optional().describe('Override AC checkpoint path (default .cs-qa/run-state/story-<storyId>-acs.json).'),
    acs: z.array(z.object({ index: z.number().int().min(0), text: z.string().min(1), tag: z.string().optional() })).optional().describe('Inline AC list — takes precedence over acCheckpointPath. Used by callers that already have the ACs in hand.'),
    testRoot: z.string().default('test').describe('Workspace-relative root to walk for .feature / .steps.ts / .page.ts files.'),
    matchThreshold: z.number().min(0).max(1).default(0.4).describe('Minimum token-overlap ratio for the fallback token-match rule.'),
    maxScenariosPerAc: z.number().int().min(1).max(20).default(5).describe('Cap on candidatesForReuse per AC.'),
    includeAdoTestCases: z.boolean().default(false).describe('When true AND storyId is set, also query ADO for TCs linked to the story via TestedBy-Forward relations and include them in the output (adoTestCases[]).'),
    crossReference: z.boolean().default(false).describe('When true AND includeAdoTestCases is set, cross-check ADO TCs against local scenarios by name overlap. Adds orphans:{adoTcsWithoutLocalScenario[], localScenariosWithoutAdoTc[]}.'),
    orgUrl: z.string().optional().describe('ADO org URL override for includeAdoTestCases.'),
    project: z.string().optional().describe('ADO project override for includeAdoTestCases.'),
    pat: z.string().optional().describe('ADO PAT override for includeAdoTestCases.'),
});

const MatchTypeSchema = z.enum(['testcase-tag', 'linked-story-tag', 'ac-tag', 'token-overlap', 'none']);

const ExistingCoverageSchema = z.object({
    acIndex: z.number(),
    acText: z.string(),
    coveringFeatureFile: z.string(),
    coveringScenario: z.string(),
    matchType: MatchTypeSchema,
    confidence: z.number(),
    tagsMatched: z.array(z.string()),
});

const CandidateSchema = z.object({
    scenarioName: z.string(),
    filePath: z.string(),
    tagsMatched: z.array(z.string()),
    overlapScore: z.number(),
    matchesAcIndexes: z.array(z.number()),
});

const AdoTestCaseSchema = z.object({
    id: z.number(),
    title: z.string(),
    url: z.string(),
    state: z.string().optional(),
    automationStatus: z.string().optional(),
});

const OrphansSchema = z.object({
    adoTcsWithoutLocalScenario: z.array(z.object({ id: z.number(), title: z.string(), url: z.string() })),
    localScenariosWithoutAdoTc: z.array(z.object({ scenarioName: z.string(), filePath: z.string() })),
});

const OutputSchema = z.object({
    ok: z.boolean(),
    storyId: z.number().nullable(),
    testRoot: z.string(),
    scannedFeatureFiles: z.number(),
    scannedStepsFiles: z.number(),
    scannedPageFiles: z.number(),
    existingCoverage: z.array(ExistingCoverageSchema),
    missingCoverage: z.array(z.object({ acIndex: z.number(), acText: z.string() })),
    candidatesForReuse: z.array(CandidateSchema),
    recommendation: z.enum(['extend-existing', 'generate-new', 'ask-user']),
    reasoning: z.string(),
    stepDefIndex: z.array(z.object({ pattern: z.string(), file: z.string() })),
    pageSlugIndex: z.array(z.object({ slug: z.string(), file: z.string() })),
    adoTestCases: z.array(AdoTestCaseSchema).optional(),
    orphans: OrphansSchema.optional(),
    warnings: z.array(z.string()),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

// ---------------------------------------------------------------------------
// Filesystem walk.
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', '.cs-qa', 'test-results', 'reports']);

function walk(root: string, matcher: (p: string) => boolean): string[] {
    const out: string[] = [];
    function recurse(dir: string): void {
        let entries: string[] = [];
        try { entries = fs.readdirSync(dir); } catch { return; }
        for (const e of entries) {
            if (SKIP_DIRS.has(e)) continue;
            const full = path.join(dir, e);
            let stat: fs.Stats;
            try { stat = fs.statSync(full); } catch { continue; }
            if (stat.isDirectory()) recurse(full);
            else if (stat.isFile() && matcher(full)) out.push(full);
        }
    }
    if (fs.existsSync(root) && fs.statSync(root).isDirectory()) recurse(root);
    return out;
}

// ---------------------------------------------------------------------------
// Feature-file parsing — extract tags + scenario blocks + step text.
// ---------------------------------------------------------------------------

interface FeatureScenario {
    name: string;
    tags: string[];       // tags on the scenario itself
    steps: string[];      // Given/When/Then/And lines
    lineNumber: number;
}

interface FeatureFile {
    file: string;
    featureName: string;
    featureTags: string[]; // tags declared before Feature:
    scenarios: FeatureScenario[];
}

const TAG_LINE_RE = /^\s*(@\S+(?:\s+@\S+)*)\s*$/;
const FEATURE_LINE_RE = /^\s*Feature:\s*(.*)$/;
const SCENARIO_LINE_RE = /^\s*(Scenario|Scenario Outline):\s*(.*)$/;
const STEP_LINE_RE = /^\s*(Given|When|Then|And|But)\s+(.*)$/;

function parseFeatureFile(file: string): FeatureFile | null {
    let contents: string;
    try { contents = fs.readFileSync(file, 'utf-8'); }
    catch { return null; }
    const lines = contents.split(/\r?\n/);
    const scenarios: FeatureScenario[] = [];
    let featureTags: string[] = [];
    let featureName = '';
    let pendingTags: string[] = [];
    let current: FeatureScenario | null = null;
    let seenFeature = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const tagMatch = TAG_LINE_RE.exec(line);
        if (tagMatch) {
            pendingTags = pendingTags.concat(tagMatch[1].split(/\s+/).filter((t) => t.startsWith('@')));
            continue;
        }
        const featMatch = FEATURE_LINE_RE.exec(line);
        if (featMatch) {
            featureName = featMatch[1].trim();
            featureTags = pendingTags.slice();
            pendingTags = [];
            seenFeature = true;
            continue;
        }
        const scMatch = SCENARIO_LINE_RE.exec(line);
        if (scMatch) {
            if (current) scenarios.push(current);
            current = { name: scMatch[2].trim(), tags: pendingTags.slice(), steps: [], lineNumber: i + 1 };
            pendingTags = [];
            continue;
        }
        const stepMatch = STEP_LINE_RE.exec(line);
        if (stepMatch && current) {
            current.steps.push(stepMatch[2].trim());
            continue;
        }
        // A blank line or non-Gherkin line does NOT clear pendingTags — tags stack
        // above the next scenario. Only comments in Gherkin are '#'-prefixed.
        if (/^\s*#/.test(line)) continue;
    }
    if (current) scenarios.push(current);
    if (!seenFeature) return null;
    return { file, featureName, featureTags, scenarios };
}

// ---------------------------------------------------------------------------
// Steps-file parsing — pull @CSBDDStepDef patterns.
// ---------------------------------------------------------------------------

const STEP_DEF_RE = /@CSBDDStepDef\s*\(\s*['"`]([^'"`]+)['"`]/g;

function parseStepsFile(file: string): Array<{ pattern: string; file: string }> {
    let src: string;
    try { src = fs.readFileSync(file, 'utf-8'); }
    catch { return []; }
    const out: Array<{ pattern: string; file: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = STEP_DEF_RE.exec(src)) !== null) {
        out.push({ pattern: m[1], file });
    }
    return out;
}

// ---------------------------------------------------------------------------
// Page-file parsing — pull @CSPage slugs.
// ---------------------------------------------------------------------------

const CSPAGE_RE = /@CSPage\s*\(\s*['"`]([^'"`]+)['"`]/g;

function parsePageFile(file: string): Array<{ slug: string; file: string }> {
    let src: string;
    try { src = fs.readFileSync(file, 'utf-8'); }
    catch { return []; }
    const out: Array<{ slug: string; file: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = CSPAGE_RE.exec(src)) !== null) {
        out.push({ slug: m[1], file });
    }
    return out;
}

// ---------------------------------------------------------------------------
// AC loader.
// ---------------------------------------------------------------------------

interface LoadedAc {
    index: number;
    text: string;
    tag: string;
}

function loadAcs(input: Input, workspaceRoot: string): { acs: LoadedAc[]; source: string; error?: string } {
    if (input.acs && input.acs.length > 0) {
        return {
            acs: input.acs.map((a, i) => ({ index: a.index || i + 1, text: a.text, tag: a.tag || `ac${a.index || i + 1}` })),
            source: 'inline',
        };
    }
    const checkpointPath = input.acCheckpointPath
        ? (path.isAbsolute(input.acCheckpointPath) ? input.acCheckpointPath : path.resolve(workspaceRoot, input.acCheckpointPath))
        : (input.storyId ? path.join(workspaceRoot, '.cs-qa', 'run-state', `story-${input.storyId}-acs.json`) : null);
    if (!checkpointPath) return { acs: [], source: 'none', error: 'no acCheckpointPath, storyId, or inline acs provided' };
    if (!fs.existsSync(checkpointPath)) return { acs: [], source: checkpointPath, error: `checkpoint not found at ${checkpointPath}. Run cs_qa_ado_read first, or pass acs inline.` };
    try {
        const raw = JSON.parse(fs.readFileSync(checkpointPath, 'utf-8')) as { acs?: Array<{ index?: number; text?: string; tag?: string }> };
        const acs: LoadedAc[] = (raw.acs || []).filter((a) => a && typeof a.text === 'string').map((a, i) => ({
            index: typeof a.index === 'number' ? a.index : i + 1,
            text: a.text as string,
            tag: a.tag || `ac${typeof a.index === 'number' ? a.index : i + 1}`,
        }));
        return { acs, source: checkpointPath };
    } catch (e) {
        return { acs: [], source: checkpointPath, error: `checkpoint parse failed: ${(e as Error).message}` };
    }
}

// ---------------------------------------------------------------------------
// Token overlap.
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
    'have', 'has', 'had', 'do', 'does', 'did', 'shall', 'should', 'will', 'would',
    'can', 'could', 'may', 'might', 'must', 'to', 'of', 'in', 'on', 'at', 'for',
    'with', 'as', 'by', 'from', 'that', 'this', 'these', 'those', 'when', 'then',
    'given', 'user', 'users', 'i', 'we', 'they', 'it', 'be', 'been', 'not', 'if',
    'so', 'no', 'yes', 'all', 'any', 'some', 'each', 'both',
]);

function tokenize(s: string): string[] {
    return s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
}

function overlapScore(acText: string, scenarioText: string): number {
    const A = new Set(tokenize(acText));
    const B = new Set(tokenize(scenarioText));
    if (A.size === 0 || B.size === 0) return 0;
    let hits = 0;
    for (const t of A) if (B.has(t)) hits++;
    return hits / A.size;
}

// ---------------------------------------------------------------------------
// Tag helpers.
// ---------------------------------------------------------------------------

const TESTCASE_TAG_RE = /^@TestCaseId:(\d+)$/i;
const LINKED_STORY_TAG_RE = /^@LinkedStory:(\d+)$/i;
const AC_TAG_RE = /^@ac(\d+)(?:-.*)?$/i;
const LEGACY_TAG_RE = /^@LegacyId:(\d+)$/i;

function extractTagIds(tags: string[]): { testCaseIds: number[]; linkedStoryIds: number[]; acIndexes: number[]; legacyIds: number[] } {
    const testCaseIds: number[] = [];
    const linkedStoryIds: number[] = [];
    const acIndexes: number[] = [];
    const legacyIds: number[] = [];
    for (const t of tags) {
        const tc = TESTCASE_TAG_RE.exec(t);
        if (tc) { testCaseIds.push(parseInt(tc[1], 10)); continue; }
        const ls = LINKED_STORY_TAG_RE.exec(t);
        if (ls) { linkedStoryIds.push(parseInt(ls[1], 10)); continue; }
        const ac = AC_TAG_RE.exec(t);
        if (ac) { acIndexes.push(parseInt(ac[1], 10)); continue; }
        const lg = LEGACY_TAG_RE.exec(t);
        if (lg) { legacyIds.push(parseInt(lg[1], 10)); continue; }
    }
    return { testCaseIds, linkedStoryIds, acIndexes, legacyIds };
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

registerPrimitive<Input, Output>({
    name: 'cs_qa_check_existing_tests',
    description: 'Walks the test/ tree and answers: "does an existing scenario already cover this story\'s ACs?". Extracts tags (@TestCaseId:<n>, @LinkedStory:<n>, @ac<n>, @LegacyId:<n>) + scenario titles + step text from every .feature, plus @CSBDDStepDef patterns from steps and @CSPage slugs from pages. Per AC, ranks matches: @TestCaseId (conf 1.0) > @LinkedStory (0.9) > @ac<n> (0.85) > token overlap (ratio). Recommendation: extend-existing | generate-new | ask-user. Read-only.',
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    run: async (ctx, input) => {
        const log = createLogger(ctx.invocationId, 'cs_qa_check_existing_tests', { workspaceRoot: ctx.workspaceRoot });
        const warnings: string[] = [];

        const acLoad = loadAcs(input, ctx.workspaceRoot);
        if (acLoad.error) warnings.push(acLoad.error);
        const acs = acLoad.acs;

        const testRootAbs = path.isAbsolute(input.testRoot) ? input.testRoot : path.resolve(ctx.workspaceRoot, input.testRoot);
        const featureFiles = walk(testRootAbs, (p) => p.endsWith('.feature'));
        const stepsFiles = walk(testRootAbs, (p) => /\.steps?\.ts$/i.test(p) || /Steps\.ts$/i.test(p));
        const pageFiles = walk(testRootAbs, (p) => /Page\.ts$/i.test(p) || /[\\/]pages?[\\/].*\.ts$/i.test(p));

        log.info('scan-summary', {
            testRoot: testRootAbs,
            featureCount: featureFiles.length,
            stepsCount: stepsFiles.length,
            pageCount: pageFiles.length,
            acCount: acs.length,
        });

        const parsedFeatures: FeatureFile[] = [];
        for (const f of featureFiles) {
            const parsed = parseFeatureFile(f);
            if (parsed) parsedFeatures.push(parsed);
        }

        const stepDefIndex: Array<{ pattern: string; file: string }> = [];
        for (const s of stepsFiles) stepDefIndex.push(...parseStepsFile(s));

        const pageSlugIndex: Array<{ slug: string; file: string }> = [];
        for (const p of pageFiles) pageSlugIndex.push(...parsePageFile(p));

        // Per AC, find matches.
        const existingCoverage: z.infer<typeof ExistingCoverageSchema>[] = [];
        const missingCoverage: Array<{ acIndex: number; acText: string }> = [];
        const linkedTcSet = new Set<number>(input.linkedTestCaseIds);
        const workspaceRel = (abs: string): string => path.relative(ctx.workspaceRoot, abs).replace(/\\/g, '/');

        // Track scenarios that get picked as best match for at least one AC.
        // Also build the candidatesForReuse list per AC.
        const acMatchesMap = new Map<number, Array<{ scenario: FeatureScenario; feature: FeatureFile; overlap: number; matchType: z.infer<typeof MatchTypeSchema>; tagsMatched: string[] }>>();
        for (const ac of acs) acMatchesMap.set(ac.index, []);

        for (const feat of parsedFeatures) {
            for (const sc of feat.scenarios) {
                const combinedTags = feat.featureTags.concat(sc.tags);
                const ids = extractTagIds(combinedTags);
                const scenarioText = sc.name + ' ' + sc.steps.join(' ');

                for (const ac of acs) {
                    let matchType: z.infer<typeof MatchTypeSchema> = 'none';
                    let confidence = 0;
                    const tagsMatched: string[] = [];

                    // 1) @TestCaseId — highest confidence.
                    for (const tid of ids.testCaseIds) {
                        if (linkedTcSet.has(tid)) {
                            matchType = 'testcase-tag';
                            confidence = 1.0;
                            tagsMatched.push(`@TestCaseId:${tid}`);
                            break;
                        }
                    }
                    // 2) @LinkedStory
                    if (matchType === 'none' && input.storyId && ids.linkedStoryIds.includes(input.storyId)) {
                        matchType = 'linked-story-tag';
                        confidence = 0.9;
                        tagsMatched.push(`@LinkedStory:${input.storyId}`);
                    }
                    // 3) @ac<n>
                    if (matchType === 'none' && ids.acIndexes.includes(ac.index)) {
                        matchType = 'ac-tag';
                        confidence = 0.85;
                        tagsMatched.push(`@ac${ac.index}`);
                    }
                    // 4) Token overlap
                    const overlap = overlapScore(ac.text, scenarioText);
                    if (matchType === 'none' && overlap >= input.matchThreshold) {
                        matchType = 'token-overlap';
                        confidence = Number(overlap.toFixed(3));
                    }

                    if (matchType !== 'none') {
                        acMatchesMap.get(ac.index)!.push({
                            scenario: sc, feature: feat,
                            overlap: Math.max(overlap, confidence),
                            matchType, tagsMatched,
                        });
                    }
                }
            }
        }

        // Pick best match per AC.
        for (const ac of acs) {
            const matches = acMatchesMap.get(ac.index) || [];
            if (matches.length === 0) {
                missingCoverage.push({ acIndex: ac.index, acText: ac.text });
                continue;
            }
            // Sort: tag-based first (by confidence desc), then token overlap desc.
            const rank = (m: { matchType: z.infer<typeof MatchTypeSchema>; overlap: number }): number => {
                switch (m.matchType) {
                    case 'testcase-tag': return 100;
                    case 'linked-story-tag': return 90;
                    case 'ac-tag': return 85;
                    case 'token-overlap': return 50 + m.overlap * 40;
                    default: return 0;
                }
            };
            matches.sort((a, b) => rank(b) - rank(a));
            const best = matches[0];
            let confidence = 0;
            switch (best.matchType) {
                case 'testcase-tag': confidence = 1.0; break;
                case 'linked-story-tag': confidence = 0.9; break;
                case 'ac-tag': confidence = 0.85; break;
                case 'token-overlap': confidence = best.overlap; break;
                default: confidence = 0;
            }
            existingCoverage.push({
                acIndex: ac.index, acText: ac.text,
                coveringFeatureFile: workspaceRel(best.feature.file),
                coveringScenario: best.scenario.name,
                matchType: best.matchType, confidence: Number(confidence.toFixed(3)),
                tagsMatched: best.tagsMatched,
            });
        }

        // Build candidatesForReuse — deduplicated by (file+scenario) with acIndexes union.
        const candMap = new Map<string, z.infer<typeof CandidateSchema>>();
        for (const [acIndex, matches] of acMatchesMap.entries()) {
            for (const m of matches.slice(0, input.maxScenariosPerAc)) {
                const key = `${workspaceRel(m.feature.file)}::${m.scenario.name}`;
                const existing = candMap.get(key);
                if (existing) {
                    if (!existing.matchesAcIndexes.includes(acIndex)) existing.matchesAcIndexes.push(acIndex);
                    for (const t of m.tagsMatched) if (!existing.tagsMatched.includes(t)) existing.tagsMatched.push(t);
                    if (m.overlap > existing.overlapScore) existing.overlapScore = Number(m.overlap.toFixed(3));
                } else {
                    candMap.set(key, {
                        scenarioName: m.scenario.name,
                        filePath: workspaceRel(m.feature.file),
                        tagsMatched: m.tagsMatched.slice(),
                        overlapScore: Number(m.overlap.toFixed(3)),
                        matchesAcIndexes: [acIndex],
                    });
                }
            }
        }
        const candidatesForReuse = Array.from(candMap.values()).sort((a, b) => b.overlapScore - a.overlapScore);

        // Decide recommendation.
        let recommendation: 'extend-existing' | 'generate-new' | 'ask-user' = 'generate-new';
        let reasoning = '';
        if (acs.length === 0) {
            recommendation = 'generate-new';
            reasoning = 'No ACs loaded — cannot compare coverage. Defaulting to generate-new; the orchestrator should pick up ACs before proceeding.';
        } else {
            const covered = existingCoverage.length;
            const missing = missingCoverage.length;
            const highConfCount = existingCoverage.filter((c) => c.confidence >= 0.85).length;
            if (covered === 0) {
                recommendation = 'generate-new';
                reasoning = `No existing scenario covers any of the ${acs.length} AC(s). Safe to generate new.`;
            } else if (highConfCount === acs.length && missing === 0) {
                recommendation = 'extend-existing';
                reasoning = `All ${acs.length} AC(s) are covered by high-confidence tag-based matches. Extend existing coverage rather than generating a parallel test.`;
            } else if (highConfCount > 0 && covered / acs.length >= 0.5) {
                recommendation = 'ask-user';
                reasoning = `${covered}/${acs.length} AC(s) already have coverage (${highConfCount} high-confidence). Human should decide whether to extend the existing scenario(s) or generate a parallel one.`;
            } else {
                recommendation = 'generate-new';
                reasoning = `Partial low-confidence coverage (${covered}/${acs.length}). Safer to generate a new test than to extend on uncertain matches.`;
            }
        }

        // -------------------------------------------------------------------
        // Optional: ADO lookup for TCs linked to the story via TestedBy-Forward
        // -------------------------------------------------------------------
        let adoTestCases: Array<z.infer<typeof AdoTestCaseSchema>> | undefined;
        let orphans: z.infer<typeof OrphansSchema> | undefined;
        if (input.includeAdoTestCases) {
            if (!input.storyId) {
                warnings.push('includeAdoTestCases:true requires storyId — skipping ADO lookup.');
            } else {
                const credsRes = getResolvedCreds(ctx.workspaceRoot, {
                    orgUrl: input.orgUrl, project: input.project, personalAccessToken: input.pat,
                });
                if (!credsRes.creds) {
                    warnings.push(`ADO lookup skipped: ${credsRes.diagnostic}`);
                } else {
                    const client = new AdoHttpClient(credsRes.creds);
                    try {
                        interface WiWithRelations {
                            id?: number;
                            relations?: Array<{ rel?: string; url?: string }>;
                        }
                        const story = await client.get<WiWithRelations>(`_apis/wit/workitems/${input.storyId}?$expand=relations&api-version=7.0`);
                        const relations = Array.isArray(story.relations) ? story.relations : [];
                        const testedByUrls: string[] = [];
                        for (const r of relations) {
                            if (r.rel === 'Microsoft.VSTS.Common.TestedBy-Forward' && typeof r.url === 'string') {
                                testedByUrls.push(r.url);
                            }
                        }
                        // Collect ids from urls; resolve each TC's title + state.
                        const ids: number[] = [];
                        for (const u of testedByUrls) {
                            const m = /workItems\/(\d+)$/i.exec(u);
                            if (m) ids.push(parseInt(m[1], 10));
                        }
                        const uniqueIds = Array.from(new Set(ids));
                        interface WiFields {
                            id?: number;
                            fields?: Record<string, unknown>;
                            _links?: { html?: { href?: string } };
                        }
                        adoTestCases = [];
                        if (uniqueIds.length > 0) {
                            // Batch resolve fields (title, state, automation status).
                            const batchUrl = `_apis/wit/workitems?ids=${uniqueIds.join(',')}&fields=System.Id,System.Title,System.State,System.WorkItemType,Microsoft.VSTS.TCM.AutomationStatus&api-version=7.0`;
                            const batch = await client.get<{ value?: WiFields[] }>(batchUrl);
                            for (const w of batch.value || []) {
                                const id = Number(w.id || w.fields?.['System.Id'] || 0);
                                const title = String(w.fields?.['System.Title'] || '');
                                const state = w.fields?.['System.State'] ? String(w.fields['System.State']) : undefined;
                                const type = String(w.fields?.['System.WorkItemType'] || '');
                                if (type && type !== 'Test Case') continue;
                                const automationStatus = w.fields?.['Microsoft.VSTS.TCM.AutomationStatus']
                                    ? String(w.fields['Microsoft.VSTS.TCM.AutomationStatus'])
                                    : undefined;
                                const url = w._links?.html?.href
                                    || `${credsRes.creds.orgUrl.replace(/\/$/, '')}/${encodeURIComponent(credsRes.creds.project)}/_workitems/edit/${id}`;
                                adoTestCases.push({ id, title, url, state, automationStatus });
                            }
                        }
                        log.info('ado-testcases-resolved', { storyId: input.storyId, count: adoTestCases.length });
                    } catch (e) {
                        warnings.push(`ADO lookup failed: ${(e as Error).message}`);
                        adoTestCases = [];
                    }
                }
            }
        }

        // Cross-reference (name overlap) — surface orphans on each side.
        if (input.crossReference && adoTestCases) {
            const localScenarios = new Set<string>();
            const localScenarioFiles = new Map<string, string>();
            for (const feat of parsedFeatures) {
                for (const sc of feat.scenarios) {
                    const norm = sc.name.trim().toLowerCase();
                    localScenarios.add(norm);
                    if (!localScenarioFiles.has(norm)) localScenarioFiles.set(norm, workspaceRel(feat.file));
                }
            }
            const nameMatches = (a: string, b: string): boolean => {
                const na = a.trim().toLowerCase();
                const nb = b.trim().toLowerCase();
                if (na === nb) return true;
                if (na.includes(nb) || nb.includes(na)) return true;
                // Token overlap >= 0.6 => match.
                const setA = new Set(na.split(/[^a-z0-9]+/).filter((t) => t.length >= 3));
                const setB = new Set(nb.split(/[^a-z0-9]+/).filter((t) => t.length >= 3));
                if (setA.size === 0 || setB.size === 0) return false;
                let hits = 0;
                for (const t of setA) if (setB.has(t)) hits++;
                return hits / Math.min(setA.size, setB.size) >= 0.6;
            };
            const adoTcsWithoutLocalScenario: Array<{ id: number; title: string; url: string }> = [];
            for (const tc of adoTestCases) {
                let matched = false;
                for (const local of localScenarios) {
                    if (nameMatches(tc.title, local)) { matched = true; break; }
                }
                if (!matched) adoTcsWithoutLocalScenario.push({ id: tc.id, title: tc.title, url: tc.url });
            }
            const localScenariosWithoutAdoTc: Array<{ scenarioName: string; filePath: string }> = [];
            for (const local of localScenarios) {
                let matched = false;
                for (const tc of adoTestCases) {
                    if (nameMatches(tc.title, local)) { matched = true; break; }
                }
                if (!matched) {
                    const originalCase = parsedFeatures
                        .flatMap((f) => f.scenarios.map((s) => ({ name: s.name, file: f.file })))
                        .find((s) => s.name.trim().toLowerCase() === local);
                    localScenariosWithoutAdoTc.push({
                        scenarioName: originalCase?.name || local,
                        filePath: originalCase ? workspaceRel(originalCase.file) : localScenarioFiles.get(local) || '',
                    });
                }
            }
            orphans = { adoTcsWithoutLocalScenario, localScenariosWithoutAdoTc };
            log.info('cross-reference-done', {
                adoTcsWithoutLocalScenario: orphans.adoTcsWithoutLocalScenario.length,
                localScenariosWithoutAdoTc: orphans.localScenariosWithoutAdoTc.length,
            });
        }

        log.info('check-existing-done', {
            covered: existingCoverage.length,
            missing: missingCoverage.length,
            candidates: candidatesForReuse.length,
            recommendation,
            adoTestCases: adoTestCases ? adoTestCases.length : undefined,
        });

        return {
            ok: true,
            storyId: input.storyId ?? null,
            testRoot: input.testRoot,
            scannedFeatureFiles: featureFiles.length,
            scannedStepsFiles: stepsFiles.length,
            scannedPageFiles: pageFiles.length,
            existingCoverage,
            missingCoverage,
            candidatesForReuse,
            recommendation,
            reasoning,
            stepDefIndex: stepDefIndex.map((s) => ({ pattern: s.pattern, file: workspaceRel(s.file) })),
            pageSlugIndex: pageSlugIndex.map((p) => ({ slug: p.slug, file: workspaceRel(p.file) })),
            adoTestCases,
            orphans,
            warnings,
        };
    },
});
