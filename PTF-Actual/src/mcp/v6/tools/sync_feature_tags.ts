/**
 * sync_feature_tags — pure, ADO-free helpers that write tool-managed tags
 * (`@TestPlanId:<n>`, `@TestSuiteId:<n>`, `@TestCaseId:<n>` / `@TestCaseId:{n1,n2,...}`)
 * back to Gherkin `.feature` files after ADO ops (publish, move, delete, remove-from-suite).
 *
 * Format-preservation rules (critical):
 *  - Only append/modify the tool-managed tags. User tags are never touched
 *    and never re-ordered.
 *  - Tool-managed tags always go at the END of the scenario's tag line.
 *  - If a scenario has no tag line, create one directly above `Scenario:`.
 *  - Steps, background, examples, comments, and feature body are never touched.
 *  - Blank lines are neither introduced nor removed.
 *
 * Hoist / demote:
 *  - When every scenario in a file has the same effective (planId, suiteId),
 *    the tags are hoisted onto the Feature tag line.
 *  - When any scenario diverges, feature-level tags are demoted into each
 *    scenario's tag block.
 *  - `@TestCaseId` NEVER hoists — always per-scenario.
 *
 * Braced form:
 *  - `@TestCaseId:{100,200,300}` → [100, 200, 300].
 *  - Written back with IDs in ASCENDING order for stable diffs.
 *  - N=0 → tag omitted. N=1 → bare. N>1 → braced.
 *
 * Idempotency: if no tag change is required, the file is NOT rewritten.
 */
import * as fs from 'fs';
import * as path from 'path';

// =============================================================================
// Public types.
// =============================================================================

export interface ScenarioMapping {
    /** 1-indexed line number of the `Scenario:` / `Scenario Outline:` keyword. */
    scenarioLine: number;
    scenarioName: string;
    /** N=0 → no `@TestCaseId` tag. N=1 → bare. N>1 → braced. */
    testCaseIds: number[];
    testPlanId?: number;
    testSuiteId?: number;
}

export interface SyncResult {
    filePath: string;
    fileChanged: boolean;
    scenariosPatched: number;
    /** Which tool-managed tag names were hoisted to feature level this run. */
    hoistedToFeatureLevel: string[];
    /** Which tool-managed tag names were demoted from feature to scenario level. */
    demotedToScenarioLevel: string[];
    tagsAdded: number;
    tagsRemoved: number;
    tagsUnchanged: number;
    /** Divergences between what the mapping said vs. what the file already had. */
    driftWarnings: string[];
}

// =============================================================================
// Tag extraction helpers.
// =============================================================================

const TC_BRACED_RE = /^@TestCaseId:\{([^}]*)\}$/;
const TC_BARE_RE = /^@TestCaseId:(\d+)$/;
const PLAN_RE = /^@TestPlanId:(\d+)$/;
const SUITE_RE = /^@TestSuiteId:(\d+)$/;
// @RunId — appended by publish-run to link each scenario to the ADO Test Run
// that most recently exercised it. Braced form {n1,n2,...} preserves history
// across multiple runs. Bare form is the single-run steady state.
const RUN_BRACED_RE = /^@RunId:\{([^}]*)\}$/;
const RUN_BARE_RE = /^@RunId:(\d+)$/;
// @LinkedRequirement / @LinkedStory — appended by cs_qa_ado_trace (Phase B2)
// when a test case is linked to a requirement or user story. Bare form is the
// single-link steady state; braced {n1,n2,...} preserves multiple parents.
const LINKED_REQ_BRACED_RE = /^@LinkedRequirement:\{([^}]*)\}$/;
const LINKED_REQ_BARE_RE = /^@LinkedRequirement:(\d+)$/;
const LINKED_STORY_BRACED_RE = /^@LinkedStory:\{([^}]*)\}$/;
const LINKED_STORY_BARE_RE = /^@LinkedStory:(\d+)$/;

/**
 * Parse `@TestCaseId:...` tags — both bare and braced forms — from an array
 * of tags on one scenario/feature line. Returns the numeric IDs in the order
 * they appear in the tag text.
 */
export function extractTestCaseIdsFromScenario(scenarioTags: string[]): number[] {
    const ids: number[] = [];
    for (const t of scenarioTags) {
        const brac = TC_BRACED_RE.exec(t);
        if (brac) {
            const inner = brac[1].trim();
            if (!inner) continue;
            for (const part of inner.split(',')) {
                const n = Number(part.trim());
                if (Number.isFinite(n) && n > 0) ids.push(n);
            }
            continue;
        }
        const bare = TC_BARE_RE.exec(t);
        if (bare) {
            const n = Number(bare[1]);
            if (Number.isFinite(n) && n > 0) ids.push(n);
        }
    }
    return ids;
}

function extractPlanId(tags: string[]): number | undefined {
    for (const t of tags) {
        const m = PLAN_RE.exec(t);
        if (m) return Number(m[1]);
    }
    return undefined;
}

function extractSuiteId(tags: string[]): number | undefined {
    for (const t of tags) {
        const m = SUITE_RE.exec(t);
        if (m) return Number(m[1]);
    }
    return undefined;
}

/**
 * Parse `@RunId:...` tags (both bare and braced) — returns the numeric IDs in
 * the order they appear. Publish-run appends the new runId to the front of the
 * braced list so the "most recent run" is always the first entry.
 */
export function extractRunIdsFromScenario(tags: string[]): number[] {
    const ids: number[] = [];
    for (const t of tags) {
        const brac = RUN_BRACED_RE.exec(t);
        if (brac) {
            const inner = brac[1].trim();
            if (!inner) continue;
            for (const part of inner.split(',')) {
                const n = Number(part.trim());
                if (Number.isFinite(n) && n > 0) ids.push(n);
            }
            continue;
        }
        const bare = RUN_BARE_RE.exec(t);
        if (bare) {
            const n = Number(bare[1]);
            if (Number.isFinite(n) && n > 0) ids.push(n);
        }
    }
    return ids;
}

function isToolManagedTag(tag: string): boolean {
    return TC_BRACED_RE.test(tag) || TC_BARE_RE.test(tag)
        || PLAN_RE.test(tag) || SUITE_RE.test(tag)
        || RUN_BRACED_RE.test(tag) || RUN_BARE_RE.test(tag)
        || LINKED_REQ_BRACED_RE.test(tag) || LINKED_REQ_BARE_RE.test(tag)
        || LINKED_STORY_BRACED_RE.test(tag) || LINKED_STORY_BARE_RE.test(tag);
}

/** Parse `@LinkedRequirement:...` tags (bare or braced) from a scenario's tag list. */
export function extractLinkedRequirementsFromScenario(tags: string[]): number[] {
    const ids: number[] = [];
    for (const t of tags) {
        const brac = LINKED_REQ_BRACED_RE.exec(t);
        if (brac) {
            const inner = brac[1].trim();
            if (!inner) continue;
            for (const part of inner.split(',')) {
                const n = Number(part.trim());
                if (Number.isFinite(n) && n > 0) ids.push(n);
            }
            continue;
        }
        const bare = LINKED_REQ_BARE_RE.exec(t);
        if (bare) {
            const n = Number(bare[1]);
            if (Number.isFinite(n) && n > 0) ids.push(n);
        }
    }
    return ids;
}

/** Parse `@LinkedStory:...` tags (bare or braced) from a scenario's tag list. */
export function extractLinkedStoriesFromScenario(tags: string[]): number[] {
    const ids: number[] = [];
    for (const t of tags) {
        const brac = LINKED_STORY_BRACED_RE.exec(t);
        if (brac) {
            const inner = brac[1].trim();
            if (!inner) continue;
            for (const part of inner.split(',')) {
                const n = Number(part.trim());
                if (Number.isFinite(n) && n > 0) ids.push(n);
            }
            continue;
        }
        const bare = LINKED_STORY_BARE_RE.exec(t);
        if (bare) {
            const n = Number(bare[1]);
            if (Number.isFinite(n) && n > 0) ids.push(n);
        }
    }
    return ids;
}

function formatLinkedRequirementTag(ids: number[]): string | null {
    if (ids.length === 0) return null;
    const sorted = Array.from(new Set(ids)).sort((a, b) => a - b);
    if (sorted.length === 1) return `@LinkedRequirement:${sorted[0]}`;
    return `@LinkedRequirement:{${sorted.join(',')}}`;
}

function formatLinkedStoryTag(ids: number[]): string | null {
    if (ids.length === 0) return null;
    const sorted = Array.from(new Set(ids)).sort((a, b) => a - b);
    if (sorted.length === 1) return `@LinkedStory:${sorted[0]}`;
    return `@LinkedStory:{${sorted.join(',')}}`;
}

function formatTestCaseTag(ids: number[]): string | null {
    if (ids.length === 0) return null;
    const sorted = ids.slice().sort((a, b) => a - b);
    if (sorted.length === 1) return `@TestCaseId:${sorted[0]}`;
    return `@TestCaseId:{${sorted.join(',')}}`;
}

function formatRunIdTag(ids: number[]): string | null {
    if (ids.length === 0) return null;
    // Preserve caller order — publish-run puts the newest runId first so the
    // "most recent run" is unambiguous from left-to-right reading.
    if (ids.length === 1) return `@RunId:${ids[0]}`;
    return `@RunId:{${ids.join(',')}}`;
}

// =============================================================================
// Feature-file line classifier + parser (line-preserving).
// =============================================================================

type LineKind =
    | 'blank'
    | 'comment'
    | 'tag'
    | 'feature'
    | 'background'
    | 'scenario'
    | 'examples'
    | 'step'
    | 'other';

interface ClassifiedLine {
    raw: string;
    trimmed: string;
    indent: string;
    kind: LineKind;
    /** Tags on this line, in original order — only when kind === 'tag'. */
    tags: string[];
}

function classifyLine(raw: string): ClassifiedLine {
    const trimmed = raw.trim();
    const indentMatch = /^(\s*)/.exec(raw);
    const indent = indentMatch ? indentMatch[1] : '';
    if (!trimmed) return { raw, trimmed, indent, kind: 'blank', tags: [] };
    if (trimmed.startsWith('#')) return { raw, trimmed, indent, kind: 'comment', tags: [] };
    if (/^@\S/.test(trimmed)) {
        const tags = trimmed.split(/\s+/).filter((t) => t.startsWith('@'));
        return { raw, trimmed, indent, kind: 'tag', tags };
    }
    if (/^Feature\s*:/.test(trimmed)) return { raw, trimmed, indent, kind: 'feature', tags: [] };
    if (/^Background\s*:/.test(trimmed)) return { raw, trimmed, indent, kind: 'background', tags: [] };
    if (/^(Scenario Outline|Scenario)\s*:/.test(trimmed)) return { raw, trimmed, indent, kind: 'scenario', tags: [] };
    if (/^Examples\s*:/.test(trimmed)) return { raw, trimmed, indent, kind: 'examples', tags: [] };
    if (/^(Given|When|Then|And|But)\s+/.test(trimmed)) return { raw, trimmed, indent, kind: 'step', tags: [] };
    return { raw, trimmed, indent, kind: 'other', tags: [] };
}

interface ScenarioBlockInfo {
    /** 1-indexed line of the `Scenario:` keyword. */
    scenarioLine: number;
    /** Zero-indexed lines forming the tag block immediately above the Scenario:. */
    tagLineIdxs: number[];
}

interface FeatureBlockInfo {
    /** Zero-indexed line of the Feature: keyword, or -1 when absent. */
    featureLineIdx: number;
    /** Zero-indexed lines forming the tag block immediately above the Feature:. */
    tagLineIdxs: number[];
}

/**
 * Find the tag block (contiguous tag lines) immediately above the given
 * target line. Blank lines / comments in between mean "no tag block".
 */
function findTagBlockAbove(lines: ClassifiedLine[], targetIdx: number): number[] {
    const tagIdxs: number[] = [];
    for (let i = targetIdx - 1; i >= 0; i--) {
        if (lines[i].kind === 'tag') {
            tagIdxs.unshift(i);
            continue;
        }
        break;
    }
    return tagIdxs;
}

function collectFeatureBlock(lines: ClassifiedLine[]): FeatureBlockInfo {
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].kind === 'feature') {
            return { featureLineIdx: i, tagLineIdxs: findTagBlockAbove(lines, i) };
        }
    }
    return { featureLineIdx: -1, tagLineIdxs: [] };
}

function collectScenarioBlocks(lines: ClassifiedLine[]): ScenarioBlockInfo[] {
    const out: ScenarioBlockInfo[] = [];
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].kind === 'scenario') {
            out.push({ scenarioLine: i + 1, tagLineIdxs: findTagBlockAbove(lines, i) });
        }
    }
    return out;
}

/**
 * Compose a fresh tag line given the user tags (in original order) plus the
 * tool-managed tags (in canonical order: plan, suite, testcase). Skips nulls.
 */
function composeTagLine(indent: string, userTags: string[], toolTags: (string | null)[]): string {
    const emitted = toolTags.filter((t): t is string => !!t);
    const all = [...userTags, ...emitted];
    return `${indent}${all.join(' ')}`;
}

/**
 * Split a scenario's tag block into (userTags-per-line, existing tool tags across whole block).
 * User tag positions are preserved per-line for multi-line blocks.
 */
interface TagBlockAnalysis {
    /** Per-tag-line list of only USER tags (tool-managed removed). */
    perLineUserTags: string[][];
    /** Aggregated tool-managed tags across every tag line in the block. */
    existingToolTags: string[];
    /** Indent for each tag line. */
    perLineIndent: string[];
}

function analyzeTagBlock(lines: ClassifiedLine[], tagLineIdxs: number[]): TagBlockAnalysis {
    const perLineUserTags: string[][] = [];
    const existingToolTags: string[] = [];
    const perLineIndent: string[] = [];
    for (const idx of tagLineIdxs) {
        const line = lines[idx];
        const userTags: string[] = [];
        for (const t of line.tags) {
            if (isToolManagedTag(t)) existingToolTags.push(t);
            else userTags.push(t);
        }
        perLineUserTags.push(userTags);
        perLineIndent.push(line.indent);
    }
    return { perLineUserTags, existingToolTags, perLineIndent };
}

// =============================================================================
// Effective mapping resolution — merges feature-level tags into per-scenario.
// =============================================================================

interface EffectiveScenarioTags {
    scenarioLine: number;
    planId?: number;
    suiteId?: number;
    testCaseIds: number[];
}

/**
 * Extract the actual current state from the file. Returns per-scenario
 * effective (plan, suite, testCaseIds) after merging feature-level tags.
 */
function extractCurrentState(lines: ClassifiedLine[]): {
    featurePlanId?: number;
    featureSuiteId?: number;
    scenarios: EffectiveScenarioTags[];
} {
    const feat = collectFeatureBlock(lines);
    const featureTags: string[] = [];
    for (const idx of feat.tagLineIdxs) featureTags.push(...lines[idx].tags);
    const featurePlanId = extractPlanId(featureTags);
    const featureSuiteId = extractSuiteId(featureTags);

    const scenarioBlocks = collectScenarioBlocks(lines);
    const scenarios: EffectiveScenarioTags[] = scenarioBlocks.map((sb) => {
        const tags: string[] = [];
        for (const idx of sb.tagLineIdxs) tags.push(...lines[idx].tags);
        return {
            scenarioLine: sb.scenarioLine,
            planId: extractPlanId(tags) ?? featurePlanId,
            suiteId: extractSuiteId(tags) ?? featureSuiteId,
            testCaseIds: extractTestCaseIdsFromScenario(tags),
        };
    });

    return { featurePlanId, featureSuiteId, scenarios };
}

// =============================================================================
// Core rewrite engine.
// =============================================================================

interface RewriteRequest {
    filePath: string;
    mappings: ScenarioMapping[];
}

interface RewritePlan {
    lines: ClassifiedLine[];
    /** Zero-indexed line → replacement raw text, or null to DROP the line. */
    lineOverrides: Map<number, string | null>;
    /** Zero-indexed line → array of raw lines to INSERT BEFORE this line. */
    insertBefore: Map<number, string[]>;
    hoisted: Set<'@TestPlanId' | '@TestSuiteId'>;
    demoted: Set<'@TestPlanId' | '@TestSuiteId'>;
    tagsAdded: number;
    tagsRemoved: number;
    tagsUnchanged: number;
    driftWarnings: string[];
    scenariosPatched: number;
}

/**
 * Decide whether the file's mapping is uniform enough to hoist.
 *
 * Hoist is ALL-OR-NOTHING (per spec): if either plan OR suite diverges
 * across scenarios, BOTH get demoted per-scenario. This keeps the
 * feature-line clean of half-populated tool-managed tags and mirrors the
 * convention that plan and suite tags always travel together.
 */
function decideHoist(mappings: ScenarioMapping[]): { hoistPlan?: number; hoistSuite?: number } {
    // Only mappings with at least one test-case ID contribute to hoist. A mapping
    // with `testCaseIds: []` (from shrink-mode delete/remove-from-suite after all
    // IDs stripped) is an unmapped scenario — its lingering planId/suiteId from
    // prior state should NOT drive hoisting, since the scenario no longer belongs
    // to any suite. Without this filter the code would hoist a plan+suite pair
    // that belongs to zero test cases.
    const plans = new Set<number>();
    const suites = new Set<number>();
    let anyWithMapping = false;
    for (const m of mappings) {
        if (m.testCaseIds.length === 0) continue;
        if (m.testPlanId !== undefined || m.testSuiteId !== undefined) anyWithMapping = true;
        if (m.testPlanId !== undefined) plans.add(m.testPlanId);
        if (m.testSuiteId !== undefined) suites.add(m.testSuiteId);
    }
    if (!anyWithMapping) return {};
    const planUniform = plans.size <= 1;
    const suiteUniform = suites.size <= 1;
    if (!planUniform || !suiteUniform) return {};   // demote both
    return {
        hoistPlan: plans.size === 1 ? [...plans][0] : undefined,
        hoistSuite: suites.size === 1 ? [...suites][0] : undefined,
    };
}

/**
 * Given the parsed file + the mapping, compute the rewrite plan.
 * The plan is a set of line-level overrides — a diff, not a re-emit.
 */
function planRewrite(lines: ClassifiedLine[], mappings: ScenarioMapping[], mode: SyncMode = 'publish'): RewritePlan {
    const plan: RewritePlan = {
        lines,
        lineOverrides: new Map(),
        insertBefore: new Map(),
        hoisted: new Set(),
        demoted: new Set(),
        tagsAdded: 0,
        tagsRemoved: 0,
        tagsUnchanged: 0,
        driftWarnings: [],
        scenariosPatched: 0,
    };

    if (mappings.length === 0) return plan;

    const feat = collectFeatureBlock(lines);
    const scenarioBlocks = collectScenarioBlocks(lines);
    const byLine = new Map<number, ScenarioMapping>();
    for (const m of mappings) byLine.set(m.scenarioLine, m);

    // ---- decide hoist policy ---------------------------------------------
    const { hoistPlan, hoistSuite } = decideHoist(mappings);

    // ---- compute new feature-level tags ---------------------------------
    const featTagAnalysis = analyzeTagBlock(lines, feat.tagLineIdxs);
    const oldFeaturePlan = extractPlanId(featTagAnalysis.existingToolTags);
    const oldFeatureSuite = extractSuiteId(featTagAnalysis.existingToolTags);

    const newFeaturePlanTag = hoistPlan !== undefined ? `@TestPlanId:${hoistPlan}` : null;
    const newFeatureSuiteTag = hoistSuite !== undefined ? `@TestSuiteId:${hoistSuite}` : null;

    if (newFeaturePlanTag && oldFeaturePlan === undefined) plan.hoisted.add('@TestPlanId');
    if (newFeatureSuiteTag && oldFeatureSuite === undefined) plan.hoisted.add('@TestSuiteId');
    if (!newFeaturePlanTag && oldFeaturePlan !== undefined) plan.demoted.add('@TestPlanId');
    if (!newFeatureSuiteTag && oldFeatureSuite !== undefined) plan.demoted.add('@TestSuiteId');

    // ---- emit new feature tag block --------------------------------------
    // Strategy: put all NEW feature-level tool-managed tags on the LAST
    // existing tag line of the feature block. If there are no tag lines,
    // create a new one directly above the Feature: line.
    const featurePlanIdNeeded = newFeaturePlanTag !== null;
    const featureSuiteIdNeeded = newFeatureSuiteTag !== null;
    // Compute existing effective state to detect drift on unchanged case.
    if (feat.featureLineIdx >= 0) {
        rewriteTagBlock(
            plan,
            lines,
            feat.tagLineIdxs,
            feat.featureLineIdx,
            [
                featurePlanIdNeeded ? newFeaturePlanTag : null,
                featureSuiteIdNeeded ? newFeatureSuiteTag : null,
                // Feature never carries @TestCaseId.
            ],
            /* stripToolTags */ true,
        );
    }

    // ---- per-scenario rewriting -----------------------------------------
    for (const sb of scenarioBlocks) {
        const m = byLine.get(sb.scenarioLine);
        if (!m) continue;   // scenario not in mapping — leave untouched.
        plan.scenariosPatched++;

        // Compute what tool-managed tags this scenario needs, honoring hoist policy.
        // Invariant: @TestPlanId / @TestSuiteId are only meaningful when the scenario
        // has at least one @TestCaseId. When the mapping has zero IDs (shrink mode
        // after all IDs deleted/removed), suppress plan+suite tags too — the
        // scenario is now un-mapped and should carry no ADO metadata.
        const scenarioHasCaseIds = m.testCaseIds.length > 0;
        const scenarioPlanTag = scenarioHasCaseIds && m.testPlanId !== undefined && hoistPlan === undefined
            ? `@TestPlanId:${m.testPlanId}`
            : null;
        const scenarioSuiteTag = scenarioHasCaseIds && m.testSuiteId !== undefined && hoistSuite === undefined
            ? `@TestSuiteId:${m.testSuiteId}`
            : null;

        // ---- drift check on existing @TestCaseId -------------------------
        const tagBlockTags: string[] = [];
        for (const idx of sb.tagLineIdxs) tagBlockTags.push(...lines[idx].tags);
        const existingTcIds = extractTestCaseIdsFromScenario(tagBlockTags);

        // Drift handling (publish mode only): if existing IDs are a strict
        // superset of mapping IDs, PRESERVE the existing set (user's set is
        // authoritative — see spec's braced-tag semantics). In shrink mode
        // (delete/remove-from-suite), the caller has authoritatively reduced
        // the set — always overwrite.
        let effectiveTcIds = m.testCaseIds.slice();
        if (mode === 'publish' && existingTcIds.length > 0 && m.testCaseIds.length > 0) {
            const mSet = new Set(m.testCaseIds);
            const eSet = new Set(existingTcIds);
            const isSubset = m.testCaseIds.every((id) => eSet.has(id));
            const isSame = mSet.size === eSet.size && [...mSet].every((id) => eSet.has(id));
            if (isSubset && !isSame) {
                plan.driftWarnings.push(
                    `Scenario at line ${sb.scenarioLine} ("${m.scenarioName}"): tool mapping had [${m.testCaseIds.join(',')}] but file has {${existingTcIds.join(',')}} — preserving wider user tag.`,
                );
                effectiveTcIds = existingTcIds.slice();
            } else if (!isSame && !isSubset) {
                plan.driftWarnings.push(
                    `Scenario at line ${sb.scenarioLine} ("${m.scenarioName}"): file had @TestCaseId {${existingTcIds.join(',')}} but publish returned [${m.testCaseIds.join(',')}] — overwriting.`,
                );
            }
        }

        const scenarioTcTag = formatTestCaseTag(effectiveTcIds);

        rewriteTagBlock(
            plan,
            lines,
            sb.tagLineIdxs,
            sb.scenarioLine - 1,   // zero-indexed scenario-line position
            [scenarioPlanTag, scenarioSuiteTag, scenarioTcTag],
            /* stripToolTags */ true,
        );
    }

    return plan;
}

/**
 * Rewrite (or create) a tag block so the tool-managed tags end up in
 * canonical order at the end of the LAST tag line. Preserves user tags
 * per-line.
 */
function rewriteTagBlock(
    plan: RewritePlan,
    lines: ClassifiedLine[],
    tagLineIdxs: number[],
    targetLineIdx: number,
    newToolTags: (string | null)[],
    stripToolTags: boolean,
): void {
    const { perLineUserTags, existingToolTags, perLineIndent } = analyzeTagBlock(lines, tagLineIdxs);

    // Compose the desired new tool-managed set (order matters: plan, suite, tc).
    const wantTools = newToolTags.filter((t): t is string => !!t);

    // Compute per-line replacements.
    // Case A: existing block is empty → create a new tag line above target.
    if (tagLineIdxs.length === 0) {
        if (wantTools.length === 0) {
            plan.tagsUnchanged += 0;
            return;
        }
        const target = lines[targetLineIdx];
        const indent = target.indent;
        const newLine = `${indent}${wantTools.join(' ')}`;
        const existing = plan.insertBefore.get(targetLineIdx) || [];
        existing.push(newLine);
        plan.insertBefore.set(targetLineIdx, existing);
        plan.tagsAdded += wantTools.length;
        return;
    }

    // Case B: existing block has 1+ lines.
    // Strategy: rewrite EACH line to keep only user tags. Put tool tags on
    // the LAST originally-tag line. If that line ends up empty (no user tags
    // AND no tool tags), drop it. If any user-only line becomes empty because
    // it only held tool tags → drop it too (to preserve blank-line-free layout).
    const lastIdx = tagLineIdxs.length - 1;
    let addedCount = 0;
    let removedCount = existingToolTags.filter((t) => stripToolTags).length;
    let unchangedCount = 0;

    // Determine which existing tool tags will be preserved (no-op).
    // A tag is "unchanged" if it's in both existing and want, else it's swapped.
    const existingSet = new Set(existingToolTags);
    const wantSet = new Set(wantTools);
    for (const t of wantTools) {
        if (existingSet.has(t)) {
            unchangedCount++;
            removedCount--;   // undo the "removed" count for tags kept
        } else {
            addedCount++;
        }
    }

    for (let i = 0; i < tagLineIdxs.length; i++) {
        const lineIdx = tagLineIdxs[i];
        const userTags = perLineUserTags[i];
        const indent = perLineIndent[i];
        const toolsForThisLine = i === lastIdx ? wantTools : [];
        const all = [...userTags, ...toolsForThisLine];
        if (all.length === 0) {
            // Drop this line entirely.
            plan.lineOverrides.set(lineIdx, null);
        } else {
            const newLine = `${indent}${all.join(' ')}`;
            const orig = lines[lineIdx].raw;
            if (newLine !== orig) {
                plan.lineOverrides.set(lineIdx, newLine);
            }
        }
    }

    plan.tagsAdded += addedCount;
    plan.tagsRemoved += Math.max(0, removedCount);
    plan.tagsUnchanged += unchangedCount;
}

// =============================================================================
// File I/O + assembly.
// =============================================================================

function detectEol(content: string): string {
    return content.includes('\r\n') ? '\r\n' : '\n';
}

function applyPlan(originalContent: string, plan: RewritePlan): string {
    // Split preserving trailing empty element so a trailing newline is preserved.
    const eol = detectEol(originalContent);
    const rawLines = originalContent.split(eol);
    const out: string[] = [];
    for (let i = 0; i < rawLines.length; i++) {
        // Insertions BEFORE this line index (only within the classified line range).
        const inserts = plan.insertBefore.get(i);
        if (inserts) out.push(...inserts);
        const override = plan.lineOverrides.get(i);
        if (override === null) continue;   // drop the line
        if (override !== undefined) {
            out.push(override);
        } else {
            out.push(rawLines[i]);
        }
    }
    return out.join(eol);
}

function computeSyncResult(filePath: string, plan: RewritePlan, changed: boolean): SyncResult {
    return {
        filePath,
        fileChanged: changed,
        scenariosPatched: plan.scenariosPatched,
        hoistedToFeatureLevel: [...plan.hoisted],
        demotedToScenarioLevel: [...plan.demoted],
        tagsAdded: plan.tagsAdded,
        tagsRemoved: plan.tagsRemoved,
        tagsUnchanged: plan.tagsUnchanged,
        driftWarnings: plan.driftWarnings,
    };
}

function emptyResult(filePath: string): SyncResult {
    return {
        filePath,
        fileChanged: false,
        scenariosPatched: 0,
        hoistedToFeatureLevel: [],
        demotedToScenarioLevel: [],
        tagsAdded: 0,
        tagsRemoved: 0,
        tagsUnchanged: 0,
        driftWarnings: [],
    };
}

// =============================================================================
// Public entrypoints.
// =============================================================================

/** Publish mode = preserve wider user tag on strict-subset drift. Shrink mode
 * = overwrite unconditionally (used by delete/remove-from-suite, where the
 *  ADO op has authoritatively reduced the set). */
type SyncMode = 'publish' | 'shrink';

function syncCore(
    featurePath: string,
    mappings: ScenarioMapping[],
    mode: SyncMode,
): SyncResult {
    if (!fs.existsSync(featurePath)) return emptyResult(featurePath);
    const content = fs.readFileSync(featurePath, 'utf-8');
    const eol = detectEol(content);
    const rawLines = content.split(eol);
    const classified = rawLines.map(classifyLine);

    // Merge passed mappings with file-snapshot state for scenarios not touched
    // this run — so hoist/demote decisions consider the WHOLE file, not just
    // the subset the caller processed (avoids wrongly stripping tags from
    // untouched scenarios when publishing under a scenarioTagFilter or when
    // move/delete/remove touches only some scenarios).
    const snap = snapshotFileFromLines(classified, rawLines, featurePath);
    const passedByLine = new Map<number, ScenarioMapping>();
    for (const m of mappings) passedByLine.set(m.scenarioLine, m);
    const fullMappings: ScenarioMapping[] = snap.scenarios.map((s) => {
        const passed = passedByLine.get(s.scenarioLine);
        if (passed) return passed;
        return {
            scenarioLine: s.scenarioLine,
            scenarioName: s.scenarioName,
            testCaseIds: s.testCaseIds,
            testPlanId: s.planId,
            testSuiteId: s.suiteId,
        };
    });

    const plan = planRewrite(classified, fullMappings, mode);
    // scenariosPatched reflects scenarios the CALLER touched.
    plan.scenariosPatched = mappings.length;
    const newContent = applyPlan(content, plan);
    const changed = newContent !== content;
    if (changed) fs.writeFileSync(featurePath, newContent, 'utf-8');
    return computeSyncResult(featurePath, plan, changed);
}

export function syncFeatureAfterPublish(
    featurePath: string,
    mappings: ScenarioMapping[],
    _workspaceRoot: string,
): SyncResult {
    return syncCore(featurePath, mappings, 'publish');
}

function snapshotFileFromLines(lines: ClassifiedLine[], rawLines: string[], filePath: string): FileSnapshot {
    const state = extractCurrentState(lines);
    const scenarios: ScenarioSnapshot[] = state.scenarios.map((es) => {
        const raw = rawLines[es.scenarioLine - 1] || '';
        const m = /^(?:\s*)(Scenario Outline|Scenario)\s*:\s*(.+)$/.exec(raw);
        return {
            scenarioLine: es.scenarioLine,
            scenarioName: m ? m[2].trim() : '',
            testCaseIds: es.testCaseIds,
            planId: es.planId,
            suiteId: es.suiteId,
        };
    });
    return { filePath, lines, scenarios };
}

// =============================================================================
// Feature-file scanning + mapping derivation for move/delete/remove-from-suite.
// =============================================================================

function collectFeatureFilesRecursive(root: string): string[] {
    const out: string[] = [];
    const walk = (d: string, depth: number): void => {
        if (depth < 0) return;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (e.name.startsWith('.') || e.name === 'node_modules') continue;
            const fp = path.join(d, e.name);
            if (e.isDirectory()) walk(fp, depth - 1);
            else if (e.isFile() && e.name.toLowerCase().endsWith('.feature')) out.push(fp);
        }
    };
    if (fs.existsSync(root)) {
        const st = fs.statSync(root);
        if (st.isDirectory()) walk(root, 10);
        else if (st.isFile() && root.toLowerCase().endsWith('.feature')) out.push(root);
    }
    return out.sort();
}

interface ScenarioSnapshot {
    scenarioLine: number;
    scenarioName: string;
    /** Effective testCaseIds after merging feature-level tags. */
    testCaseIds: number[];
    /** Effective planId after merging feature-level tags. */
    planId?: number;
    /** Effective suiteId after merging feature-level tags. */
    suiteId?: number;
}

interface FileSnapshot {
    filePath: string;
    lines: ClassifiedLine[];
    scenarios: ScenarioSnapshot[];
}

function snapshotFile(filePath: string): FileSnapshot | null {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    const eol = detectEol(content);
    const rawLines = content.split(eol);
    const lines = rawLines.map(classifyLine);
    return snapshotFileFromLines(lines, rawLines, filePath);
}

/**
 * For move/delete/remove-from-suite: for each scenario the change is
 * relevant to, build a ScenarioMapping reflecting the desired new state.
 * Only scenarios in the returned array will be treated as "changed" by
 * syncFeatureAfterPublish; everything else is preserved as-is.
 */
function processFile(
    filePath: string,
    changer: (s: ScenarioSnapshot) => Partial<Pick<ScenarioMapping, 'testCaseIds' | 'testPlanId' | 'testSuiteId'>>,
    isRelevant: (s: ScenarioSnapshot) => boolean,
    mode: SyncMode = 'shrink',
): SyncResult | null {
    const snap = snapshotFile(filePath);
    if (!snap) return null;
    if (!snap.scenarios.some(isRelevant)) return null;
    const changed: ScenarioMapping[] = [];
    for (const s of snap.scenarios) {
        if (!isRelevant(s)) continue;
        const patch = changer(s);
        // A patch key that's explicitly PRESENT (even with value undefined) is a
        // "clear" — the caller wants that tag stripped. `in` distinguishes
        // "explicit clear" from "not touched". A patch key that's absent falls
        // through to the snapshot value.
        changed.push({
            scenarioLine: s.scenarioLine,
            scenarioName: s.scenarioName,
            testCaseIds: 'testCaseIds' in patch ? (patch.testCaseIds as number[] | undefined ?? []) : s.testCaseIds,
            testPlanId: 'testPlanId' in patch ? patch.testPlanId : s.planId,
            testSuiteId: 'testSuiteId' in patch ? patch.testSuiteId : s.suiteId,
        });
    }
    return syncCore(filePath, changed, mode);
}

export function syncFeaturesAfterMove(
    workspaceRoot: string,
    moves: Array<{ testCaseId: number; newTestPlanId: number; newTestSuiteId: number }>,
    scanRoot?: string,
): SyncResult[] {
    const root = scanRoot ?? path.join(workspaceRoot, 'test');
    const byId = new Map<number, { newTestPlanId: number; newTestSuiteId: number }>();
    for (const m of moves) byId.set(m.testCaseId, { newTestPlanId: m.newTestPlanId, newTestSuiteId: m.newTestSuiteId });
    const files = collectFeatureFilesRecursive(root);
    const out: SyncResult[] = [];
    for (const f of files) {
        const isRelevant = (s: ScenarioSnapshot): boolean => s.testCaseIds.some((id) => byId.has(id));
        const changer = (s: ScenarioSnapshot): Partial<Pick<ScenarioMapping, 'testCaseIds' | 'testPlanId' | 'testSuiteId'>> => {
            const hit = s.testCaseIds.find((id) => byId.has(id));
            if (hit === undefined) return {};
            const target = byId.get(hit)!;
            return { testPlanId: target.newTestPlanId, testSuiteId: target.newTestSuiteId };
        };
        const res = processFile(f, changer, isRelevant);
        if (res) out.push(res);
    }
    return out;
}

export function syncFeaturesAfterDelete(
    workspaceRoot: string,
    deletedTestCaseIds: number[],
    scanRoot?: string,
): SyncResult[] {
    const root = scanRoot ?? path.join(workspaceRoot, 'test');
    const del = new Set(deletedTestCaseIds);
    const files = collectFeatureFilesRecursive(root);
    const out: SyncResult[] = [];
    for (const f of files) {
        const isRelevant = (s: ScenarioSnapshot): boolean => s.testCaseIds.some((id) => del.has(id));
        const changer = (s: ScenarioSnapshot): Partial<Pick<ScenarioMapping, 'testCaseIds' | 'testPlanId' | 'testSuiteId'>> => {
            if (!s.testCaseIds.some((id) => del.has(id))) return {};
            return { testCaseIds: s.testCaseIds.filter((id) => !del.has(id)) };
        };
        const res = processFile(f, changer, isRelevant);
        if (res) out.push(res);
    }
    return out;
}

export function syncFeaturesAfterRemoveFromSuite(
    workspaceRoot: string,
    removedTestCaseIds: number[],
    scanRoot?: string,
): SyncResult[] {
    // remove-from-suite: strip IDs from @TestCaseId tags, but leave
    // @TestPlanId / @TestSuiteId alone (they represent the scenario's
    // logical suite mapping — the user can wipe manually if needed).
    const root = scanRoot ?? path.join(workspaceRoot, 'test');
    const removed = new Set(removedTestCaseIds);
    const files = collectFeatureFilesRecursive(root);
    const out: SyncResult[] = [];
    for (const f of files) {
        const isRelevant = (s: ScenarioSnapshot): boolean => s.testCaseIds.some((id) => removed.has(id));
        const changer = (s: ScenarioSnapshot): Partial<Pick<ScenarioMapping, 'testCaseIds' | 'testPlanId' | 'testSuiteId'>> => {
            if (!s.testCaseIds.some((id) => removed.has(id))) return {};
            return { testCaseIds: s.testCaseIds.filter((id) => !removed.has(id)) };
        };
        const res = processFile(f, changer, isRelevant);
        if (res) out.push(res);
    }
    return out;
}

/**
 * Sync-back for delete-suite. A scenario is relevant iff its effective
 * @TestPlanId matches the deleted plan AND its effective @TestSuiteId is
 * in the deleted-suite set. Behaviour:
 *  - Strip @TestSuiteId (the suite no longer exists) — this makes the scenario
 *    look "un-suited". When deletedTestCaseIds is non-empty (cascadeTestCases=true),
 *    also drop those IDs from @TestCaseId. Once @TestCaseId is empty, the shrink-mode
 *    invariant in planRewrite auto-strips the orphan @TestPlanId too.
 *
 * We NEVER touch scenarios that belong to other plans or other suites.
 */
export function syncFeaturesAfterSuiteDeleted(
    workspaceRoot: string,
    deletedSuiteIds: number[],
    deletedPlanId: number,
    deletedTestCaseIds: number[],
    scanRoot?: string,
    /**
     * The membership of the deleted suite(s) — every TC id that lived in one
     * of the deleted suites BEFORE deletion. Different from
     * `deletedTestCaseIds`: those are TCs whose work item was destroyed
     * (cascadeTestCases:true). `suiteMemberIds` is the broader set — the TC
     * work items may survive (cascadeTestCases:false, orphaned in ADO), but
     * from the perspective of any scenario in the DELETED suite the
     * @TestCaseId tag is now homeless and should be stripped. Scenarios in
     * OTHER suites that also reference the same TC keep their tag intact.
     */
    suiteMemberIds?: number[],
): SyncResult[] {
    const root = scanRoot ?? path.join(workspaceRoot, 'test');
    const suites = new Set(deletedSuiteIds);
    const deletedCases = new Set(deletedTestCaseIds);
    const memberCases = new Set(suiteMemberIds ?? []);
    const files = collectFeatureFilesRecursive(root);
    const out: SyncResult[] = [];
    for (const f of files) {
        const isRelevant = (s: ScenarioSnapshot): boolean => {
            if (s.planId !== deletedPlanId) return false;
            if (s.suiteId === undefined || !suites.has(s.suiteId)) {
                // Not in a deleted suite. Still relevant if cascade destroyed
                // any TC id the scenario references — we need to strip those.
                if (deletedCases.size > 0 && s.testCaseIds.some((id) => deletedCases.has(id))) return true;
                return false;
            }
            return true;
        };
        const changer = (s: ScenarioSnapshot): Partial<Pick<ScenarioMapping, 'testCaseIds' | 'testPlanId' | 'testSuiteId'>> => {
            const patch: Partial<Pick<ScenarioMapping, 'testCaseIds' | 'testPlanId' | 'testSuiteId'>> = {};
            const scenarioWasInDeletedSuite = s.suiteId !== undefined && suites.has(s.suiteId);
            // Rule 1: If a TC was destroyed (cascadeTestCases:true), strip it
            // from EVERY scenario that referenced it — including scenarios in
            // OTHER suites.
            let nextCaseIds = s.testCaseIds;
            if (deletedCases.size > 0 && nextCaseIds.some((id) => deletedCases.has(id))) {
                nextCaseIds = nextCaseIds.filter((id) => !deletedCases.has(id));
            }
            // Rule 2: If THIS scenario's suite was deleted, strip TC ids that
            // were members of the deleted suite — the scenario no longer has
            // an ADO home for those references. TCs that were NOT in the
            // deleted suite (i.e., the scenario also references TCs living in
            // other suites) stay.
            if (scenarioWasInDeletedSuite && memberCases.size > 0) {
                nextCaseIds = nextCaseIds.filter((id) => !memberCases.has(id));
            }
            if (nextCaseIds.length !== s.testCaseIds.length) patch.testCaseIds = nextCaseIds;
            // Rule 3: If the scenario's suite was deleted, strip BOTH plan
            // and suite tags. Leaving @TestPlanId behind was the historic
            // sync-back bug that surfaced orphaned tags after delete-suite.
            if (scenarioWasInDeletedSuite) {
                patch.testSuiteId = undefined;
                patch.testPlanId = undefined;
            }
            return patch;
        };
        const res = processFile(f, changer, isRelevant);
        if (res) out.push(res);
    }
    return out;
}

/**
 * Sync-back for delete-plan. A scenario is relevant iff its effective
 * @TestPlanId matches the deleted plan. Behaviour:
 *  - Strip @TestPlanId AND @TestSuiteId (both are dead).
 *  - When deletedTestCaseIds is non-empty (cascadeTestCases=true), also drop those
 *    IDs from @TestCaseId. Shrink mode ensures orphaned plan/suite tags don't
 *    hang around for scenarios that end up with zero test-case IDs.
 *
 * Scenarios in other plans are NEVER touched (correctness rule from the spec).
 */
export function syncFeaturesAfterPlanDeleted(
    workspaceRoot: string,
    deletedPlanId: number,
    deletedTestCaseIds: number[],
    scanRoot?: string,
): SyncResult[] {
    const root = scanRoot ?? path.join(workspaceRoot, 'test');
    const deletedCases = new Set(deletedTestCaseIds);
    const files = collectFeatureFilesRecursive(root);
    const out: SyncResult[] = [];
    for (const f of files) {
        const isRelevant = (s: ScenarioSnapshot): boolean => s.planId === deletedPlanId;
        const changer = (s: ScenarioSnapshot): Partial<Pick<ScenarioMapping, 'testCaseIds' | 'testPlanId' | 'testSuiteId'>> => {
            const patch: Partial<Pick<ScenarioMapping, 'testCaseIds' | 'testPlanId' | 'testSuiteId'>> = {
                testPlanId: undefined,
                testSuiteId: undefined,
            };
            if (deletedCases.size > 0 && s.testCaseIds.some((id) => deletedCases.has(id))) {
                patch.testCaseIds = s.testCaseIds.filter((id) => !deletedCases.has(id));
            }
            return patch;
        };
        const res = processFile(f, changer, isRelevant);
        if (res) out.push(res);
    }
    return out;
}

// =============================================================================
// @RunId sync-back — driven by cs_qa_ado_publish_run_results.
//
// Scope: only scenarios whose @TestCaseId set intersects `publishedTestCaseIds`
// are touched. Behaviour:
//   - Append `runId` to the front of the existing @RunId list (newest-first).
//   - Cap history at `maxRunIdHistory` (default 5) — older entries drop off.
//   - Emit `@RunId:<n>` (bare) or `@RunId:{n1,n2,...}` (braced with history).
//   - Hoist to Feature-level when EVERY mapped scenario in the file ends up
//     with the SAME @RunId set (typical: one publish-run covers all scenarios).
//   - Never touches user tags, @TestPlanId, @TestSuiteId, or @TestCaseId.
//   - Sync-back is idempotent — a second publish-run with the same runId is a
//     no-op (the runId is already at position 0).
// =============================================================================

export interface RunIdSyncResult {
    filePath: string;
    fileChanged: boolean;
    scenariosPatched: number;
    runIdHoisted: boolean;
    warnings: string[];
}

interface RunIdRewriteState {
    /** Existing tool-managed tag block above target line. */
    tagLineIdxs: number[];
    /** Effective runIds already present (from feature or scenario level). */
    effectiveRunIds: number[];
}

function extractRunIdsFromBlock(lines: ClassifiedLine[], tagLineIdxs: number[]): number[] {
    const collected: string[] = [];
    for (const idx of tagLineIdxs) collected.push(...lines[idx].tags);
    return extractRunIdsFromScenario(collected);
}

function mergeRunIds(existing: number[], newRunId: number, maxHistory: number): number[] {
    // Newest first, dedupe, cap at maxHistory.
    const seen = new Set<number>();
    const out: number[] = [];
    const push = (n: number): void => { if (!seen.has(n)) { seen.add(n); out.push(n); } };
    push(newRunId);
    for (const id of existing) push(id);
    return out.slice(0, Math.max(1, maxHistory));
}

/**
 * Rewrite a tag block preserving user tags and every existing tool-managed tag
 * EXCEPT @RunId (which we recompute). New @RunId (if provided) is appended to
 * the end of the LAST tag line — canonical order: plan, suite, testcase, run.
 */
function rewriteTagBlockPreservingCoreToolTags(
    lines: ClassifiedLine[],
    rawLines: string[],
    tagLineIdxs: number[],
    targetLineIdx: number,
    newRunTag: string | null,
    lineOverrides: Map<number, string | null>,
    insertBefore: Map<number, string[]>,
): void {
    // Split each tag line into user + non-Run tool tags + Run tool tags.
    if (tagLineIdxs.length === 0) {
        if (!newRunTag) return;
        const target = lines[targetLineIdx];
        const indent = target.indent;
        const newLine = `${indent}${newRunTag}`;
        const existing = insertBefore.get(targetLineIdx) || [];
        existing.push(newLine);
        insertBefore.set(targetLineIdx, existing);
        return;
    }
    const lastIdx = tagLineIdxs.length - 1;
    for (let i = 0; i < tagLineIdxs.length; i++) {
        const lineIdx = tagLineIdxs[i];
        const line = lines[lineIdx];
        const userTags: string[] = [];
        const nonRunToolTags: string[] = [];
        for (const t of line.tags) {
            const isRunTag = RUN_BRACED_RE.test(t) || RUN_BARE_RE.test(t);
            if (isRunTag) continue;   // drop — will be re-emitted at last line
            if (isToolManagedTag(t)) nonRunToolTags.push(t);
            else userTags.push(t);
        }
        const runForThisLine = (i === lastIdx && newRunTag) ? [newRunTag] : [];
        const all = [...userTags, ...nonRunToolTags, ...runForThisLine];
        if (all.length === 0) {
            lineOverrides.set(lineIdx, null);
        } else {
            const newLine = `${line.indent}${all.join(' ')}`;
            if (newLine !== rawLines[lineIdx]) lineOverrides.set(lineIdx, newLine);
        }
    }
}

/**
 * Sync-back for publish-run: append @RunId:<runId> to every scenario whose
 * @TestCaseId contains any of the published IDs.
 *
 * Hoist: when every scenario that would receive @RunId ends up with the same
 * @RunId set, hoist to the Feature tag line and strip per-scenario @RunId tags.
 *
 * All errors are captured in `warnings`; this function NEVER throws.
 */
export function syncFeaturesAfterRunPublished(
    workspaceRoot: string,
    args: {
        runId: number;
        publishedTestCaseIds: number[];
        scanRoot?: string;
        /** History cap for the braced form. Default 5. Older runIds drop off. */
        maxRunIdHistory?: number;
    },
): RunIdSyncResult[] {
    const results: RunIdSyncResult[] = [];
    const maxHistory = Math.max(1, args.maxRunIdHistory ?? 5);
    const idSet = new Set(args.publishedTestCaseIds);
    if (idSet.size === 0) return results;
    const root = args.scanRoot ?? path.join(workspaceRoot, 'test');
    const files = collectFeatureFilesRecursive(root);
    for (const f of files) {
        try {
            const r = syncOneFileRunId(f, args.runId, idSet, maxHistory);
            if (r) results.push(r);
        } catch (e) {
            results.push({ filePath: f, fileChanged: false, scenariosPatched: 0, runIdHoisted: false, warnings: [`sync failed: ${(e as Error).message}`] });
        }
    }
    return results;
}

function syncOneFileRunId(filePath: string, runId: number, mappedTcIds: Set<number>, maxHistory: number): RunIdSyncResult | null {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    const eol = detectEol(content);
    const rawLines = content.split(eol);
    const lines = rawLines.map(classifyLine);

    const feat = collectFeatureBlock(lines);
    const scenarioBlocks = collectScenarioBlocks(lines);
    if (scenarioBlocks.length === 0) return null;

    // Feature-level existing run ids.
    const featureExistingRunIds = extractRunIdsFromBlock(lines, feat.tagLineIdxs);

    // Determine per-scenario effective @TestCaseId set and existing @RunId set.
    const perScenario: Array<{
        block: ScenarioBlockInfo;
        matches: boolean;
        existingRunIds: number[];
    }> = scenarioBlocks.map((sb) => {
        const tags: string[] = [];
        for (const idx of sb.tagLineIdxs) tags.push(...lines[idx].tags);
        const scenarioTcIds = extractTestCaseIdsFromScenario(tags);
        // Effective TC set includes any published-at-feature-level ids too — but
        // publish-feature enforces @TestCaseId at scenario level only, so we do
        // not need to merge feature TCs.
        const matches = scenarioTcIds.some((id) => mappedTcIds.has(id));
        const scenarioRunIds = extractRunIdsFromBlock(lines, sb.tagLineIdxs);
        const effective = scenarioRunIds.length > 0 ? scenarioRunIds : featureExistingRunIds;
        return { block: sb, matches, existingRunIds: effective };
    });

    const matchedIndices = perScenario.map((p, i) => (p.matches ? i : -1)).filter((i) => i >= 0);
    if (matchedIndices.length === 0) return null;

    // Compute new run-id set for each matched scenario.
    const newRunIdsPerMatch: number[][] = matchedIndices.map((i) => mergeRunIds(perScenario[i].existingRunIds, runId, maxHistory));

    // Hoist decision: hoist iff every matched scenario ends up with the same
    // @RunId set AND every un-matched scenario has no per-scenario @RunId.
    // (An un-matched scenario with its own runId means the feature is not
    // uniform — leave everything per-scenario.)
    const anyUnmatchedHasScenarioRunId = perScenario.some((p, i) => {
        if (matchedIndices.includes(i)) return false;
        // Only "per-scenario" runIds count — feature-inherited ones don't
        // block hoisting since they'd stay at feature level.
        const perScenarioTagsOnly = extractRunIdsFromBlock(lines, p.block.tagLineIdxs);
        return perScenarioTagsOnly.length > 0;
    });
    let hoisted = false;
    let hoistRunIds: number[] | null = null;
    if (!anyUnmatchedHasScenarioRunId && matchedIndices.length > 0) {
        const first = newRunIdsPerMatch[0].join(',');
        const uniform = newRunIdsPerMatch.every((s) => s.join(',') === first);
        if (uniform) {
            hoisted = true;
            hoistRunIds = newRunIdsPerMatch[0];
        }
    }

    const lineOverrides = new Map<number, string | null>();
    const insertBefore = new Map<number, string[]>();

    if (hoisted && hoistRunIds) {
        // Feature-level: rewrite feature tag block with the new run tag.
        // Scenario-level: strip @RunId from every scenario block.
        if (feat.featureLineIdx >= 0) {
            rewriteTagBlockPreservingCoreToolTags(lines, rawLines, feat.tagLineIdxs, feat.featureLineIdx, formatRunIdTag(hoistRunIds), lineOverrides, insertBefore);
        }
        for (const sb of scenarioBlocks) {
            rewriteTagBlockPreservingCoreToolTags(lines, rawLines, sb.tagLineIdxs, sb.scenarioLine - 1, null, lineOverrides, insertBefore);
        }
    } else {
        // Per-scenario: strip @RunId at feature level, write per-matched scenario.
        if (feat.featureLineIdx >= 0) {
            rewriteTagBlockPreservingCoreToolTags(lines, rawLines, feat.tagLineIdxs, feat.featureLineIdx, null, lineOverrides, insertBefore);
        }
        for (let i = 0; i < scenarioBlocks.length; i++) {
            const sb = scenarioBlocks[i];
            const matchIdx = matchedIndices.indexOf(i);
            if (matchIdx >= 0) {
                const tag = formatRunIdTag(newRunIdsPerMatch[matchIdx]);
                rewriteTagBlockPreservingCoreToolTags(lines, rawLines, sb.tagLineIdxs, sb.scenarioLine - 1, tag, lineOverrides, insertBefore);
            } else {
                // Preserve as-is — don't disturb non-matched scenarios except to
                // clear any leftover per-scenario @RunId that no longer applies.
                // (Being safe: only rewrite if the scenario actually has @RunId.)
                const existing = extractRunIdsFromBlock(lines, sb.tagLineIdxs);
                if (existing.length > 0) {
                    rewriteTagBlockPreservingCoreToolTags(lines, rawLines, sb.tagLineIdxs, sb.scenarioLine - 1, null, lineOverrides, insertBefore);
                }
            }
        }
    }

    // Assemble.
    const out: string[] = [];
    for (let i = 0; i < rawLines.length; i++) {
        const inserts = insertBefore.get(i);
        if (inserts) out.push(...inserts);
        const override = lineOverrides.get(i);
        if (override === null) continue;
        if (override !== undefined) out.push(override); else out.push(rawLines[i]);
    }
    const newContent = out.join(eol);
    const changed = newContent !== content;
    if (changed) fs.writeFileSync(filePath, newContent, 'utf-8');
    return {
        filePath,
        fileChanged: changed,
        scenariosPatched: matchedIndices.length,
        runIdHoisted: hoisted,
        warnings: [],
    };
}

// =============================================================================
// @LinkedRequirement / @LinkedStory sync-back — driven by cs_qa_ado_trace.
//
// For each link (testCaseId, targetId, targetKind), find every scenario whose
// @TestCaseId contains testCaseId, and MERGE targetId into the effective
// @LinkedRequirement or @LinkedStory tag set (dedup, ascending).
//
// Rules:
//   - Never touches user tags, @TestPlanId, @TestSuiteId, @TestCaseId, @RunId.
//   - Append tags at end of the LAST existing tag line — canonical trailing.
//   - Bare when N=1, braced when N>=2, dropped when N=0.
//   - Sync-back is idempotent — a second call with the same link is a no-op.
//   - Never throws — all errors become warnings.
// =============================================================================

export type TraceLinkKind = 'requirement' | 'story';

export interface TraceLinkForSync {
    /** The scenario is discovered by intersecting @TestCaseId. */
    testCaseId: number;
    /** The requirement/story numeric ID to add. */
    targetId: number;
    /** Which tag family to write. */
    kind: TraceLinkKind;
}

export interface TraceLinkSyncResult {
    filePath: string;
    fileChanged: boolean;
    scenariosPatched: number;
    tagsAdded: number;
    warnings: string[];
}

function rewriteTagBlockAddLinkTags(
    lines: ClassifiedLine[],
    rawLines: string[],
    tagLineIdxs: number[],
    targetLineIdx: number,
    newReqIds: number[],
    newStoryIds: number[],
    lineOverrides: Map<number, string | null>,
    insertBefore: Map<number, string[]>,
): number {
    const newReqTag = formatLinkedRequirementTag(newReqIds);
    const newStoryTag = formatLinkedStoryTag(newStoryIds);
    let addedCount = 0;

    if (tagLineIdxs.length === 0) {
        // No existing tag block — create a new tag line above target with just link tags.
        const toEmit = [newReqTag, newStoryTag].filter((t): t is string => !!t);
        if (toEmit.length === 0) return 0;
        const target = lines[targetLineIdx];
        const newLine = `${target.indent}${toEmit.join(' ')}`;
        const existing = insertBefore.get(targetLineIdx) || [];
        existing.push(newLine);
        insertBefore.set(targetLineIdx, existing);
        return toEmit.length;
    }

    const lastIdx = tagLineIdxs.length - 1;
    for (let i = 0; i < tagLineIdxs.length; i++) {
        const lineIdx = tagLineIdxs[i];
        const line = lines[lineIdx];
        const userTags: string[] = [];
        const nonLinkToolTags: string[] = [];
        for (const t of line.tags) {
            const isLinkTag = LINKED_REQ_BRACED_RE.test(t) || LINKED_REQ_BARE_RE.test(t)
                || LINKED_STORY_BRACED_RE.test(t) || LINKED_STORY_BARE_RE.test(t);
            if (isLinkTag) continue;   // drop — recomputed
            if (isToolManagedTag(t)) nonLinkToolTags.push(t);
            else userTags.push(t);
        }
        const linkTagsForThisLine: string[] = [];
        if (i === lastIdx) {
            if (newReqTag) linkTagsForThisLine.push(newReqTag);
            if (newStoryTag) linkTagsForThisLine.push(newStoryTag);
            addedCount = linkTagsForThisLine.length;
        }
        const all = [...userTags, ...nonLinkToolTags, ...linkTagsForThisLine];
        if (all.length === 0) {
            lineOverrides.set(lineIdx, null);
        } else {
            const newLine = `${line.indent}${all.join(' ')}`;
            if (newLine !== rawLines[lineIdx]) lineOverrides.set(lineIdx, newLine);
        }
    }
    return addedCount;
}

/**
 * Sync-back for cs_qa_ado_trace link-forward / link-backward.
 *
 * `links` is a flat list — one entry per (testCaseId, targetId, kind). Multiple
 * links to the same testCaseId are merged into one tag set per scenario.
 *
 * All errors are captured in `warnings`; this function NEVER throws.
 */
export function syncFeaturesAfterTraceLink(
    workspaceRoot: string,
    links: TraceLinkForSync[],
    scanRoot?: string,
): TraceLinkSyncResult[] {
    const results: TraceLinkSyncResult[] = [];
    if (links.length === 0) return results;
    // Group targets by (testCaseId, kind).
    const reqByTc = new Map<number, Set<number>>();
    const storyByTc = new Map<number, Set<number>>();
    for (const l of links) {
        const map = l.kind === 'requirement' ? reqByTc : storyByTc;
        const s = map.get(l.testCaseId) || new Set<number>();
        s.add(l.targetId);
        map.set(l.testCaseId, s);
    }
    const allTcIds = new Set<number>([...reqByTc.keys(), ...storyByTc.keys()]);
    const root = scanRoot ?? path.join(workspaceRoot, 'test');
    const files = collectFeatureFilesRecursive(root);
    for (const f of files) {
        try {
            const r = syncOneFileTraceLink(f, allTcIds, reqByTc, storyByTc);
            if (r) results.push(r);
        } catch (e) {
            results.push({ filePath: f, fileChanged: false, scenariosPatched: 0, tagsAdded: 0, warnings: [`sync failed: ${(e as Error).message}`] });
        }
    }
    return results;
}

function syncOneFileTraceLink(
    filePath: string,
    allTcIds: Set<number>,
    reqByTc: Map<number, Set<number>>,
    storyByTc: Map<number, Set<number>>,
): TraceLinkSyncResult | null {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    const eol = detectEol(content);
    const rawLines = content.split(eol);
    const lines = rawLines.map(classifyLine);
    const scenarioBlocks = collectScenarioBlocks(lines);
    if (scenarioBlocks.length === 0) return null;

    const lineOverrides = new Map<number, string | null>();
    const insertBefore = new Map<number, string[]>();
    let patched = 0;
    let added = 0;
    for (const sb of scenarioBlocks) {
        const tags: string[] = [];
        for (const idx of sb.tagLineIdxs) tags.push(...lines[idx].tags);
        const scenarioTcIds = extractTestCaseIdsFromScenario(tags);
        const matchingTc = scenarioTcIds.filter((id) => allTcIds.has(id));
        if (matchingTc.length === 0) continue;
        // Merge: existing link tags + new ones (dedup).
        const existingReq = extractLinkedRequirementsFromScenario(tags);
        const existingStory = extractLinkedStoriesFromScenario(tags);
        const reqSet = new Set<number>(existingReq);
        const storySet = new Set<number>(existingStory);
        for (const tc of matchingTc) {
            const rs = reqByTc.get(tc);
            if (rs) for (const r of rs) reqSet.add(r);
            const ss = storyByTc.get(tc);
            if (ss) for (const s of ss) storySet.add(s);
        }
        const addedThis = rewriteTagBlockAddLinkTags(
            lines, rawLines, sb.tagLineIdxs, sb.scenarioLine - 1,
            Array.from(reqSet), Array.from(storySet),
            lineOverrides, insertBefore,
        );
        // Only count as patched if there's a net change vs. existing.
        const reqChanged = reqSet.size !== existingReq.length || Array.from(reqSet).some((n) => !existingReq.includes(n));
        const storyChanged = storySet.size !== existingStory.length || Array.from(storySet).some((n) => !existingStory.includes(n));
        if (reqChanged || storyChanged) {
            patched++;
            added += addedThis;
        }
    }

    const out: string[] = [];
    for (let i = 0; i < rawLines.length; i++) {
        const inserts = insertBefore.get(i);
        if (inserts) out.push(...inserts);
        const override = lineOverrides.get(i);
        if (override === null) continue;
        if (override !== undefined) out.push(override); else out.push(rawLines[i]);
    }
    const newContent = out.join(eol);
    const changed = newContent !== content;
    if (changed) fs.writeFileSync(filePath, newContent, 'utf-8');
    return {
        filePath,
        fileChanged: changed,
        scenariosPatched: patched,
        tagsAdded: added,
        warnings: [],
    };
}
