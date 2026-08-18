import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
        const child = spawn(cmd, args, { cwd, shell: false });
        let stdout = '';
        let stderr = '';
        const to = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* noop */ } }, timeoutMs);
        child.stdout.on('data', (c) => { stdout += c.toString('utf-8').slice(0, 200_000); });
        child.stderr.on('data', (c) => { stderr += c.toString('utf-8').slice(0, 200_000); });
        child.on('close', (exitCode) => { clearTimeout(to); resolve({ exitCode, stdout, stderr }); });
        child.on('error', (e) => { clearTimeout(to); resolve({ exitCode: 1, stdout: '', stderr: e.message }); });
    });
}

interface ScenarioBlock {
    file: string;
    line: number;
    name: string;
    tags: string[];
    isOutline: boolean;
    hasExamples: boolean;
    examplesInline: boolean;
    background: string[];
    when: string[];
    then: string[];
    all: string[];
    hardcodedLiterals: string[];
}

const VISIBILITY_THEN_REGEX = /^(the|I see|I verify)?\s*.*\b(visible|displayed|shown|present|appears?)\b/i;
const REJECTION_THEN_REGEX = /\b(error|invalid|required|reject|not\s+(saved|created|allowed|accepted|permitted)|warning|message|remains?\s+on\s+the\s+form|blocked|prevented|prohibited|failed?|denied|validation|duplicate|cannot|should\s+not|must\s+not|exceed(ed|s)?|already|limit(ed)?|forbidden|refused|throws?)\b/i;
// Placeholder-step-text patterns — generic scaffolding language that names the
// acceptance criterion itself rather than exercising real app behavior. Catches
// stubs disguised as scenarios (e.g. "exercises acceptance criterion X" /
// "outcome for X is recorded"), which pass framework-rule and coverage checks
// but perform zero real assertion work.
const PLACEHOLDER_STEP_REGEX = /\b(acceptance\s+criterion|acceptance\s+outcome|criterion\s+(is\s+)?(exercised|fulfilled|validated|recorded|verified|noted)|outcome\s+(is\s+)?(recorded|noted|validated|verified)|is\s+(fulfilled|exercised|acknowledged)\b|scaffold(?:ed)?\s+placeholder|todo:?\s*implement|placeholder\s+(step|scenario|assertion))/i;
// Generic behavioral vocabulary — NOT project-specific. Any scenario carrying one of
// these tags is treated as behavioral (must have a non-visibility Then, must have
// a rejection assertion if negative, etc.).
const GENERIC_BEHAVIOR_TAGS = new Set([
    '@negative', '@validation', '@crud', '@persistence', '@audit', '@search',
    '@cancel', '@delete', '@edit', '@update', '@create', '@duplicate-submission',
    '@upload', '@download', '@import', '@export', '@login', '@logout',
    '@navigation', '@integration', '@api', '@db', '@e2e',
]);
// Meta / infra / display tags — do NOT trigger behavioral rules.
const HAPPY_DISPLAY_TAGS = new Set(['@happy-path', '@display', '@smoke', '@form-display', '@initial-state', '@render']);
const META_TAG_PREFIXES = ['@story:', '@ts_', '@testcase:', '@tc:', '@ac:', '@id:'];
const META_TAG_NAMES = new Set(['@wip', '@skip', '@only', '@focus', '@pending-app-gap', '@flaky', '@slow', '@fast']);
const DATA_FILE_BOOKKEEPING_KEYS = new Set(['scenarioid', 'runflag', 'username', 'environment', 'tags', 'testcaseid', 'testid', 'notes']);

// Heuristic: a scenario is "behavioral" if it carries any tag other than pure
// meta/infra/display/project tags. This makes the rule work for any consumer
// project's tag vocabulary — not just tags we happen to have enumerated above.
function isBehavioralScenario(tags: string[]): boolean {
    for (const raw of tags) {
        const t = raw.toLowerCase();
        if (GENERIC_BEHAVIOR_TAGS.has(t)) return true;
        if (HAPPY_DISPLAY_TAGS.has(t)) continue;
        if (META_TAG_NAMES.has(t)) continue;
        if (META_TAG_PREFIXES.some((p) => t.startsWith(p))) continue;
        // Anything else — a story-, tab-, or feature-scoped tag written by the
        // author — is treated as behavioral by default. Project-agnostic.
        if (t.startsWith('@') && t.length > 1) return true;
    }
    return false;
}

registerPrimitive({
    name: 'cs_qa_verify_generated',
    description: 'Full pre-run verification of generated tests. Runs: (1) tsc compilation check filtered to touched files, (2) framework-rule scan (calls cs_qa_code_analyze internally), (3) feature/steps coverage check (every feature step has a matching @CSBDDStepDef, every AC/scenarioId in the feature has content), (4) no-duplicate-step-defs across the whole project, (5) scenario-quality audit that catches placeholder scenarios, missing When steps, visibility-only Then blocks on behavioral scenarios, @negative scenarios missing rejection assertions, duplicate Then blocks across scenarios, hardcoded literals when a data file exists at the story path, and empty scenarios.json files. Returns structured findings so the model can decide whether to proceed or fix.',
    inputSchema: z.object({
        touchedFiles: z.array(z.string()).default([]),
        runTsc: z.boolean().default(true),
        tscTimeoutMs: z.number().int().positive().max(15 * 60_000).default(3 * 60_000),
        storySlug: z.string().optional(),
    }),
    outputSchema: z.object({
        ok: z.boolean(),
        tsc: z.object({
            ran: z.boolean(),
            exitCode: z.number().nullable(),
            errorCount: z.number(),
            errorSummary: z.array(z.string()),
        }),
        frameworkFindings: z.array(z.object({
            file: z.string(), line: z.number(), kind: z.string(), severity: z.string(),
            subject: z.string(), message: z.string(), hint: z.string(),
        })),
        duplicateStepDefs: z.array(z.object({ descriptionOrMethod: z.string(), files: z.array(z.string()) })),
        coverageGaps: z.array(z.object({ kind: z.string(), detail: z.string() })),
        scenarioQualityFindings: z.array(z.object({
            file: z.string(),
            line: z.number(),
            scenario: z.string(),
            kind: z.string(),
            severity: z.string(),
            detail: z.string(),
            hint: z.string(),
        })),
        summary: z.object({ errors: z.number(), warnings: z.number() }),
    }),
    run: async (ctx, input) => {
        const errorSummary: string[] = [];
        let tscExit: number | null = null;
        let tscErrorCount = 0;
        if (input.runTsc) {
            const tscPath = path.join(ctx.workspaceRoot, 'node_modules', 'typescript', 'bin', 'tsc');
            const args = ['--noEmit'];
            const result = await run('node', [tscPath, ...args], ctx.workspaceRoot, input.tscTimeoutMs);
            tscExit = result.exitCode;
            const errLines = result.stdout.split('\n').filter((l) => /error TS\d+/.test(l));
            tscErrorCount = errLines.length;
            const filtered = input.touchedFiles.length > 0
                ? errLines.filter((l) => input.touchedFiles.some((t) => l.replace(/\\/g, '/').includes(t.replace(/\\/g, '/'))))
                : errLines;
            errorSummary.push(...filtered.slice(0, 30));
        }

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { execute } = require('../runtime/execute') as { execute: (p: unknown, i: unknown, c: unknown) => Promise<{ ok: boolean; output: unknown }> };
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { getPrimitive } = require('../runtime/Primitive') as { getPrimitive: (n: string) => unknown };
        const analyzeTool = getPrimitive('cs_qa_code_analyze');
        let frameworkFindings: unknown[] = [];
        let duplicateStepDefs: unknown[] = [];
        if (analyzeTool) {
            const analyzed = await execute(analyzeTool, { root: 'test', checkDuplicates: true, maxFindings: 200 }, { workspaceRoot: ctx.workspaceRoot, invocationId: ctx.invocationId + '-analyze' });
            if (analyzed.ok) {
                frameworkFindings = (analyzed.output as { findings: unknown[]; duplicateStepDefs: unknown[] }).findings;
                duplicateStepDefs = (analyzed.output as { findings: unknown[]; duplicateStepDefs: unknown[] }).duplicateStepDefs;
            }
        }

        const coverageGaps: Array<{ kind: string; detail: string }> = [];
        const scenarioQualityFindings: Array<{ file: string; line: number; scenario: string; kind: string; severity: string; detail: string; hint: string }> = [];
        try {
            const testRoot = path.join(ctx.workspaceRoot, 'test');
            const stepDefTexts = new Set<string>();
            walk(testRoot, (abs) => {
                if (!/\.steps\.ts$/.test(abs)) return;
                const content = fs.readFileSync(abs, 'utf-8');
                const re = /@CSBDDStepDef\(\s*['"`]([^'"`]+)['"`]/g;
                let m: RegExpExecArray | null;
                while ((m = re.exec(content))) stepDefTexts.add(normalizeStep(m[1]));
            });

            const scenarios: ScenarioBlock[] = [];
            walk(testRoot, (abs) => {
                if (!/\.feature$/.test(abs)) return;
                if (input.storySlug && !abs.replace(/\\/g, '/').includes(input.storySlug)) return;
                const content = fs.readFileSync(abs, 'utf-8');
                const parsed = parseFeature(abs, content, ctx.workspaceRoot);
                scenarios.push(...parsed);
                const lines = content.split('\n');
                for (let i = 0; i < lines.length; i++) {
                    const m = /^\s*(Given|When|Then|And|But)\s+(.+?)\s*$/.exec(lines[i]);
                    if (!m) continue;
                    const stepText = normalizeStep(m[2]);
                    const covered = Array.from(stepDefTexts).some((sdText) => stepDefMatches(sdText, stepText));
                    if (!covered) {
                        coverageGaps.push({ kind: 'feature-step-without-stepdef', detail: `${path.relative(ctx.workspaceRoot, abs).replace(/\\/g, '/')}:${i + 1} — '${m[2]}' has no matching @CSBDDStepDef` });
                    }
                }
            });

            scenarioQualityFindings.push(...auditScenarios(scenarios, ctx.workspaceRoot));
            scenarioQualityFindings.push(...auditScenarioDataFiles(ctx.workspaceRoot, scenarios, input.storySlug));
            scenarioQualityFindings.push(...auditSentinelResolution(scenarios, ctx.workspaceRoot));
            scenarioQualityFindings.push(...auditTautologicalAssertions(ctx.workspaceRoot));
            scenarioQualityFindings.push(...auditAcceptanceCriteriaCoverage(scenarios, ctx.workspaceRoot));
            scenarioQualityFindings.push(...auditFeatureFileFormatting(ctx.workspaceRoot));
            scenarioQualityFindings.push(...auditHardcodedRecordIdInNavigate(ctx.workspaceRoot));
            scenarioQualityFindings.push(...auditAcInteractionCoverage(scenarios, ctx.workspaceRoot));
        } catch { /* ignore */ }

        const ffTyped = frameworkFindings as Array<{ severity: string; file?: string }>;
        const dsdTyped = duplicateStepDefs as Array<{ descriptionOrMethod: string; files: string[] }>;
        const sqErrors = scenarioQualityFindings.filter((s) => s.severity === 'error').length;
        const sqWarnings = scenarioQualityFindings.filter((s) => s.severity === 'warn').length;
        const inScope = (p: string | undefined): boolean => {
            if (!p) return true;
            if (input.storySlug && p.replace(/\\/g, '/').includes(input.storySlug)) return true;
            if (input.touchedFiles.some((t) => p.replace(/\\/g, '/').includes(t.replace(/\\/g, '/')))) return true;
            return !input.storySlug && input.touchedFiles.length === 0;
        };
        const inScopeFramework = ffTyped.filter((f) => inScope(f.file));
        const inScopeDupes = dsdTyped.filter((d) => d.files.some((f) => inScope(f)));
        const inScopeCoverage = coverageGaps.filter((g) => inScope(g.detail.split(':')[0]));
        const tscInScopeErrorCount = input.storySlug || input.touchedFiles.length > 0
            ? errorSummary.length
            : tscErrorCount;
        const errors = inScopeFramework.filter((f) => f.severity === 'error').length
            + (tscExit !== 0 && input.runTsc ? tscInScopeErrorCount : 0)
            + inScopeCoverage.length
            + inScopeDupes.length
            + sqErrors;
        const warnings = inScopeFramework.filter((f) => f.severity === 'warn').length + sqWarnings;

        return {
            ok: errors === 0,
            tsc: { ran: input.runTsc, exitCode: tscExit, errorCount: tscErrorCount, errorSummary },
            frameworkFindings: frameworkFindings as Array<{ file: string; line: number; kind: string; severity: string; subject: string; message: string; hint: string }>,
            duplicateStepDefs: dsdTyped,
            coverageGaps,
            scenarioQualityFindings,
            summary: { errors, warnings },
        };
    },
});

function walk(root: string, visit: (abs: string) => void): void {
    const stack = [root];
    while (stack.length > 0) {
        const d = stack.pop()!;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            if (e.name === 'node_modules' || e.name.startsWith('.git')) continue;
            const p = path.join(d, e.name);
            if (e.isDirectory()) stack.push(p);
            else visit(p);
        }
    }
}

function normalizeStep(s: string): string {
    return s.replace(/"[^"]*"|'[^']*'|<[^>]+>/g, '{arg}').replace(/\s+/g, ' ').trim();
}

function stepDefMatches(defTextNormalized: string, featureStepNormalized: string): boolean {
    if (defTextNormalized === featureStepNormalized) return true;
    const p = defTextNormalized
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\\\{arg\\\}/g, '\\{arg\\}')
        .replace(/\\\{string\\\}/g, '\\{arg\\}')
        .replace(/\\\{int\\\}/g, '\\{arg\\}')
        .replace(/\\\{number\\\}/g, '\\{arg\\}');
    try { return new RegExp('^' + p + '$').test(featureStepNormalized); } catch { return false; }
}

function parseFeature(absPath: string, content: string, workspaceRoot: string): ScenarioBlock[] {
    const rel = path.relative(workspaceRoot, absPath).replace(/\\/g, '/');
    const lines = content.split('\n');
    const scenarios: ScenarioBlock[] = [];
    let background: string[] = [];
    let inBackground = false;
    let current: ScenarioBlock | null = null;
    let pendingTags: string[] = [];
    let currentSection: 'when' | 'then' | 'given' | null = null;

    const flush = () => {
        if (current) scenarios.push(current);
        current = null;
        currentSection = null;
    };

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const trimmed = raw.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith('#')) continue;

        const tagMatch = /^@\S/.test(trimmed);
        if (tagMatch) {
            pendingTags.push(...trimmed.split(/\s+/).filter((t) => t.startsWith('@')));
            continue;
        }

        if (/^Background\s*:/.test(trimmed)) {
            flush();
            inBackground = true;
            background = [];
            continue;
        }

        const scMatch = /^(Scenario Outline|Scenario)\s*:\s*(.+)$/.exec(trimmed);
        if (scMatch) {
            flush();
            inBackground = false;
            current = {
                file: rel,
                line: i + 1,
                name: scMatch[2].trim(),
                tags: pendingTags.slice(),
                isOutline: scMatch[1] === 'Scenario Outline',
                hasExamples: false,
                examplesInline: false,
                background: background.slice(),
                when: [],
                then: [],
                all: [],
                hardcodedLiterals: [],
            };
            pendingTags = [];
            currentSection = null;
            continue;
        }

        if (/^Examples\s*:/.test(trimmed)) {
            if (current) {
                current.hasExamples = true;
                const rest = trimmed.replace(/^Examples\s*:/, '').trim();
                if (rest && !rest.startsWith('{')) current.examplesInline = true;
                if (rest.startsWith('{')) current.examplesInline = false;
                if (!rest) current.examplesInline = true;
            }
            continue;
        }

        if (/^Feature\s*:/.test(trimmed)) { pendingTags = []; continue; }

        const stepMatch = /^(Given|When|Then|And|But)\s+(.+)$/.exec(trimmed);
        if (stepMatch) {
            const keyword = stepMatch[1];
            const body = stepMatch[2];
            if (inBackground) { background.push(`${keyword} ${body}`); continue; }
            if (!current) continue;
            if (keyword === 'Given') currentSection = 'given';
            else if (keyword === 'When') currentSection = 'when';
            else if (keyword === 'Then') currentSection = 'then';
            if (keyword === 'When') current.when.push(body);
            else if (keyword === 'Then') current.then.push(body);
            else if (keyword === 'And' || keyword === 'But') {
                if (currentSection === 'when') current.when.push(body);
                else if (currentSection === 'then') current.then.push(body);
            }
            current.all.push(`${keyword} ${body}`);
            const literalMatch = body.match(/"[^"]{3,}"/g);
            if (literalMatch) current.hardcodedLiterals.push(...literalMatch);
        }
    }
    flush();
    return scenarios;
}

function auditScenarios(scenarios: ScenarioBlock[], workspaceRoot: string): Array<{ file: string; line: number; scenario: string; kind: string; severity: string; detail: string; hint: string }> {
    const findings: Array<{ file: string; line: number; scenario: string; kind: string; severity: string; detail: string; hint: string }> = [];

    // Duplicate scenario-identifier tag (@ac1 / @TS_XXX / @ts_XXX etc.) within the same feature file.
    // Any two scenarios sharing the same story-identifier tag is a coverage-collapse smell.
    const tagOccurrences = new Map<string, ScenarioBlock[]>();
    for (const s of scenarios) {
        for (const t of s.tags) {
            const lower = t.toLowerCase();
            // Only story-identifier-shaped tags (things that look like scenario ids, not category tags)
            if (!/^@(ac|ts|tc|scenario|s)[_-]?\d/i.test(t) && !/^@id:/i.test(lower)) continue;
            const key = `${s.file}::${lower}`;
            if (!tagOccurrences.has(key)) tagOccurrences.set(key, []);
            tagOccurrences.get(key)!.push(s);
        }
    }
    for (const [key, group] of tagOccurrences) {
        if (group.length < 2) continue;
        const tag = key.split('::')[1];
        for (const s of group) {
            findings.push({
                file: s.file, line: s.line, scenario: s.name,
                kind: 'duplicate-scenario-tag',
                severity: 'error',
                detail: `Scenario identifier tag ${tag} appears on ${group.length} scenarios in the same feature (${group.map((x) => x.name).slice(0, 3).join(' / ')}${group.length > 3 ? ' / …' : ''}). Each scenario-id tag MUST be unique within a feature file — this is a coverage-collapse smell (two ACs being tracked under one id).`,
                hint: `Rename the second occurrence to the correct AC id. If both scenarios genuinely test the same AC, merge them; if they test different ACs, use distinct tags (@ac2, @ac3 …).`,
            });
        }
    }

    // Shallow-scenario-diversity — N scenarios with the SAME normalized When AND SAME normalized Then
    // signatures (only data differs) are ONE Scenario Outline with N Examples, not N different scenarios.
    // This is coverage fraud: 20 "AC scenarios" that all say `When save employee with names → Then toast
    // contains X` don't test 20 different behaviors, they test 1 behavior with 20 data rows.
    const signatureGroups = new Map<string, ScenarioBlock[]>();
    for (const s of scenarios) {
        const whenSig = s.when.map((w) => normalizeStep(w)).join('|');
        const thenSig = s.then.map((t) => normalizeStep(t)).join('|');
        if (!whenSig && !thenSig) continue;
        const sig = `${s.file}::WHEN=${whenSig}::THEN=${thenSig}`;
        if (!signatureGroups.has(sig)) signatureGroups.set(sig, []);
        signatureGroups.get(sig)!.push(s);
    }
    for (const [sig, group] of signatureGroups) {
        if (group.length < 5) continue;
        void sig;
        for (const s of group) {
            findings.push({
                file: s.file, line: s.line, scenario: s.name,
                kind: 'shallow-scenario-diversity',
                severity: 'error',
                detail: `${group.length} scenarios in this feature share identical When + Then signatures (only data differs). This is a single Scenario Outline pretending to be ${group.length} — coverage fraud. Sibling scenarios: ${group.slice(0, 3).map((x) => x.name).join(' / ')}${group.length > 3 ? ' / …' : ''}.`,
                hint: `Either merge into ONE Scenario Outline with N data rows in one Examples: block, OR give each scenario a truly distinct When/Then that exercises a different behavior. If the story has N ACs testing N truly different behaviors (photo upload, tab persistence, cancel, etc.), each AC needs its OWN When invoking a page-object method specific to that behavior — not a shared 'create(firstName, lastName) → save' wrapper.`,
            });
        }
    }

    // Original per-scenario checks (0. placeholder-step, 1. missing-when, 2. visibility-only-then,
    // 3. negative-missing-rejection) — must run for EVERY scenario, not just the new ones above.
    const thenSignatures = new Map<string, ScenarioBlock[]>();
    const whenSignatures = new Map<string, ScenarioBlock[]>();
    for (const s of scenarios) {
        const thenSig = s.then.map((t) => normalizeStep(t)).join('\n');
        const whenSig = s.when.map((w) => normalizeStep(w)).join('\n');
        if (thenSig) {
            if (!thenSignatures.has(thenSig)) thenSignatures.set(thenSig, []);
            thenSignatures.get(thenSig)!.push(s);
        }
        if (whenSig) {
            if (!whenSignatures.has(whenSig)) whenSignatures.set(whenSig, []);
            whenSignatures.get(whenSig)!.push(s);
        }
    }
    for (const s of scenarios) {
        const tagSet = new Set(s.tags);
        const hasBehaviorTag = isBehavioralScenario(s.tags);
        const hasHappyDisplayTag = s.tags.some((t) => HAPPY_DISPLAY_TAGS.has(t.toLowerCase()));
        const allSteps = [...s.when, ...s.then];
        const placeholderHit = allSteps.find((step) => PLACEHOLDER_STEP_REGEX.test(step));
        if (placeholderHit) {
            findings.push({
                file: s.file, line: s.line, scenario: s.name,
                kind: 'placeholder-step-text', severity: 'error',
                detail: `Scenario contains generic placeholder step text: "${placeholderHit.slice(0, 120)}". This pattern names the acceptance criterion instead of exercising real app behavior.`,
                hint: `Replace with concrete steps that DRIVE the app. Never emit a scenario whose only work is echoing the criterion name back.`,
            });
        }
        const backgroundHasWhen = s.background.some((b) => /^When\b/.test(b) || /^And\b/.test(b));
        if (s.when.length === 0 && !backgroundHasWhen && !hasHappyDisplayTag) {
            findings.push({
                file: s.file, line: s.line, scenario: s.name,
                kind: 'scenario-missing-when', severity: 'error',
                detail: `Scenario has no When step but is not tagged as pure display.`,
                hint: `Add a When that performs the AC's action, or tag as @happy-path @display.`,
            });
        }
        const allThenVisibilityOnly = s.then.length > 0 && s.then.every((t) => VISIBILITY_THEN_REGEX.test(t)) && !s.then.some((t) => REJECTION_THEN_REGEX.test(t));
        if (allThenVisibilityOnly && hasBehaviorTag) {
            const behaviorTagList = s.tags.filter((t) => {
                const lower = t.toLowerCase();
                if (HAPPY_DISPLAY_TAGS.has(lower)) return false;
                if (META_TAG_NAMES.has(lower)) return false;
                if (META_TAG_PREFIXES.some((p) => lower.startsWith(p))) return false;
                return true;
            });
            findings.push({
                file: s.file, line: s.line, scenario: s.name,
                kind: 'scenario-visibility-only-then', severity: 'error',
                detail: `Scenario has behavioral tag(s) ${behaviorTagList.join(', ')} but every Then is a visibility check.`,
                hint: `Replace visibility-only Then with an assertion that verifies the AC's specific outcome.`,
            });
        }
        const isNegative = tagSet.has('@negative') || tagSet.has('@validation');
        const hasRejectionAssertion = s.then.some((t) => REJECTION_THEN_REGEX.test(t));
        if (isNegative && !hasRejectionAssertion) {
            findings.push({
                file: s.file, line: s.line, scenario: s.name,
                kind: 'negative-scenario-missing-rejection', severity: 'error',
                detail: `Scenario is tagged @negative/@validation but has no Then that asserts an error/rejection.`,
                hint: `Add a Then that asserts the actual error message text or blocked-state indicator.`,
            });
        }
    }
    for (const [sig, list] of thenSignatures) {
        if (list.length < 3) continue;
        if (!sig || sig.length < 10) continue;
        if (sig.includes('{arg}')) continue;
        for (const s of list) {
            findings.push({
                file: s.file, line: s.line, scenario: s.name,
                kind: 'duplicate-then-block-across-scenarios', severity: 'error',
                detail: `Then block is identical (and unparameterized) across ${list.length} scenarios.`,
                hint: `Each scenario's Then must assert the specific outcome its AC describes.`,
            });
        }
    }
    for (const [sig, list] of whenSignatures) {
        if (list.length < 3) continue;
        if (!sig || sig.length < 10) continue;
        const distinctBehaviorTags = new Set<string>();
        for (const sc of list) {
            for (const t of sc.tags) {
                const lower = t.toLowerCase();
                if (HAPPY_DISPLAY_TAGS.has(lower)) continue;
                if (META_TAG_NAMES.has(lower)) continue;
                if (META_TAG_PREFIXES.some((p) => lower.startsWith(p))) continue;
                if (t.startsWith('@') && t.length > 1) distinctBehaviorTags.add(t);
            }
        }
        if (distinctBehaviorTags.size < 2) continue;
        const thenSigs = list.map((s) => s.then.map((t) => normalizeStep(t)).join('\n'));
        const uniqueThenSigs = new Set(thenSigs);
        const allThensVisibilityOnly = list.every((s) =>
            s.then.length > 0
            && s.then.every((t) => VISIBILITY_THEN_REGEX.test(t))
            && !s.then.some((t) => REJECTION_THEN_REGEX.test(t))
        );
        const thensDistinctEnough = uniqueThenSigs.size >= Math.ceil(list.length * 0.7);
        if (thensDistinctEnough && !allThensVisibilityOnly) continue;
        for (const s of list) {
            findings.push({
                file: s.file, line: s.line, scenario: s.name,
                kind: 'duplicate-when-block-across-scenarios', severity: 'error',
                detail: `When block is identical across ${list.length} scenarios with distinct behavioral tags AND their Thens are ${allThensVisibilityOnly ? 'visibility-only' : 'largely identical'}.`,
                hint: `Either give each scenario a distinct When or a unique behavioral Then.`,
            });
        }
    }
    void workspaceRoot;
    return findings;
}

function auditSentinelResolution(scenarios: ScenarioBlock[], workspaceRoot: string): Array<{ file: string; line: number; scenario: string; kind: string; severity: string; detail: string; hint: string }> {
    const findings: Array<{ file: string; line: number; scenario: string; kind: string; severity: string; detail: string; hint: string }> = [];
    // 1. Find all data files referenced by any scenario's Examples: {"source":"..."}
    const featureFiles = new Set<string>();
    for (const s of scenarios) featureFiles.add(s.file);
    const referencedDataFiles = new Set<string>();
    for (const rel of featureFiles) {
        const abs = path.resolve(workspaceRoot, rel);
        let content: string;
        try { content = fs.readFileSync(abs, 'utf-8'); } catch { continue; }
        const re = /Examples\s*:\s*\{[^}]*"source"\s*:\s*"([^"]+)"/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(content))) referencedDataFiles.add(m[1]);
    }
    // 2. Check each data file for sentinel presence
    const sentinelsFound: Array<{ dataFile: string; sentinelSample: string }> = [];
    for (const rel of referencedDataFiles) {
        const abs = path.resolve(workspaceRoot, rel);
        let raw: string;
        try { raw = fs.readFileSync(abs, 'utf-8'); } catch { continue; }
        const m = /(__AUTO_[A-Z_:]+__|"TODAY(?:[+-]\d+B?)?")/i.exec(raw);
        if (m) sentinelsFound.push({ dataFile: rel, sentinelSample: m[1] });
    }
    if (sentinelsFound.length === 0) return findings;
    // 3. Check if ANY step-def file references CSDataGenerator or CSDateTimeUtility (resolver signals)
    const testRoot = path.join(workspaceRoot, 'test');
    let hasResolver = false;
    walk(testRoot, (abs) => {
        if (hasResolver) return;
        if (!/\.(steps\.ts|resolver\.ts|helper\.ts)$/.test(abs)) return;
        try {
            const content = fs.readFileSync(abs, 'utf-8');
            if (/CSDataGenerator|CSDateTimeUtility|__AUTO_NUMBER__|__AUTO_ID:|resolveSentinel|resolveRow/.test(content)) hasResolver = true;
        } catch { /* noop */ }
    });
    if (hasResolver) return findings;
    // 4. Report on each scenario in the data-referenced feature
    for (const s of scenarios) {
        const sample = sentinelsFound[0];
        findings.push({
            file: s.file, line: s.line, scenario: s.name,
            kind: 'unresolved-sentinel-in-data-file',
            severity: 'error',
            detail: `Data file ${sample.dataFile} contains sentinel ${sample.sentinelSample} but no step-def / helper / resolver in test/** references CSDataGenerator or CSDateTimeUtility to substitute them. The sentinel string gets typed VERBATIM into the form field (e.g. firstName="__AUTO_ID:EMP__" enters "__AUTO_ID:EMP__" literally).`,
            hint: `Add a data resolver: (a) in a helpers/DataResolver.ts, write a static resolveRow(row) that replaces __AUTO_NUMBER__ with CSDataGenerator.getInstance().generateNumber(10000,99999).toString(), __AUTO_ID:PREFIX__ with CSDataGenerator.getInstance().generateId('PREFIX', 6), TODAY with CSDateTimeUtility.getTodayInAmericasTimezone(), TODAY+5B with CSDateTimeUtility.formatInTimezone(CSDateTimeUtility.addBusinessDays(CSDateTimeUtility.now(), 5), 'YYYY-MM-DD'). (b) Call DataResolver.resolveRow(row) at the top of each step-def that consumes the row. OR: switch to omitting the column entirely and have the step-def generate at runtime.`,
        });
        break; // one finding per feature is enough
    }
    return findings;
}
function auditScenarioDataFiles(workspaceRoot: string, scenarios: ScenarioBlock[], storySlug?: string): Array<{ file: string; line: number; scenario: string; kind: string; severity: string; detail: string; hint: string }> {
    const findings: Array<{ file: string; line: number; scenario: string; kind: string; severity: string; detail: string; hint: string }> = [];
    const dataRoot = path.join(workspaceRoot, 'test');

    // First check: every feature's `Examples: {"source":"..."}` must point at an existing file.
    // Without this, cs_qa_run_tests blows up at scenario expansion — but Copilot has often
    // "shipped" here anyway (wrote features, skipped data files, ended with a menu of options).
    const featureFiles = new Set<string>();
    for (const s of scenarios) featureFiles.add(s.file);
    for (const rel of featureFiles) {
        const abs = path.resolve(workspaceRoot, rel);
        let content: string;
        try { content = fs.readFileSync(abs, 'utf-8'); } catch { continue; }
        const re = /Examples\s*:\s*\{[^}]*"source"\s*:\s*"([^"]+)"/g;
        const lines = content.split('\n');
        let m: RegExpExecArray | null;
        while ((m = re.exec(content))) {
            const srcPath = m[1];
            const srcAbs = path.resolve(workspaceRoot, srcPath);
            if (fs.existsSync(srcAbs)) continue;
            // Find the line for a useful anchor
            let lineNum = 1;
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes(srcPath)) { lineNum = i + 1; break; }
            }
            findings.push({
                file: rel, line: lineNum, scenario: '(feature-level)',
                kind: 'referenced-data-file-missing',
                severity: 'error',
                detail: `Feature references data file "${srcPath}" via Examples.source but that file does not exist on disk. The runner will fail at scenario expansion. This usually means the generator wrote the feature but skipped writing the data file (a common premature-stop pattern).`,
                hint: `Write the data file at ${srcPath} with real rows keyed by scenarioId. Every scenarioId used in a filter=... must have at least one matching row with real per-scenario data columns (firstName, lastName, expectedError, etc.) — not just bookkeeping keys. If cs_qa_fs write is rejecting the file, read the error message and fix the specific cause (path, size, permissions). Do NOT ship the feature without its data file. Do NOT end the session asking the user to create the data file manually.`,
            });
        }
    }

    const dataFiles: string[] = [];
    walk(dataRoot, (abs) => {
        if (!/data[/\\][^/\\]+[/\\][^/\\]+[/\\]scenarios\.json$/.test(abs.replace(/\\/g, '/'))) return;
        if (storySlug && !abs.replace(/\\/g, '/').includes(storySlug)) return;
        dataFiles.push(abs);
    });

    for (const df of dataFiles) {
        let rows: Array<Record<string, unknown>> = [];
        try { rows = JSON.parse(fs.readFileSync(df, 'utf-8')) as Array<Record<string, unknown>>; } catch { continue; }
        if (!Array.isArray(rows) || rows.length === 0) continue;
        const rel = path.relative(workspaceRoot, df).replace(/\\/g, '/');
        // Check every row's non-bookkeeping columns
        const allExtraColumns = new Set<string>();
        for (const r of rows) {
            for (const k of Object.keys(r)) {
                if (!DATA_FILE_BOOKKEEPING_KEYS.has(k.toLowerCase())) allExtraColumns.add(k);
            }
        }
        if (allExtraColumns.size === 0) {
            findings.push({
                file: rel, line: 1, scenario: '(entire file)',
                kind: 'data-file-only-bookkeeping-columns',
                severity: 'error',
                detail: `${rel} has ${rows.length} rows but zero data columns (only scenarioId/runFlag/userName-style bookkeeping). This is a placeholder data file — the feature is likely hardcoding values that should live here.`,
                hint: `Add real per-scenario data columns (firstName, middleName, lastName, expectedError, employeeId, dob, contactNumber, etc.). Update the feature to reference values via <placeholder> and use Examples: {"type":"json","source":"${rel}","filter":"scenarioId=TS_XXX_YY"}.`,
            });
        }
    }

    // Detect hardcoded literals in feature files when a data file exists at the same story path
    for (const s of scenarios) {
        if (s.hardcodedLiterals.length === 0) continue;
        if (s.isOutline || s.hasExamples) continue;
        const featureAbs = path.join(workspaceRoot, s.file);
        const featureDir = path.dirname(featureAbs);
        // Look up two levels for a matching data file under data/<env>/<same-story-slug>/
        const storyName = path.basename(featureDir);
        const possibleDataFiles = dataFiles.filter((df) => df.replace(/\\/g, '/').includes(`/${storyName}/`));
        if (possibleDataFiles.length === 0) continue;
        findings.push({
            file: s.file, line: s.line, scenario: s.name,
            kind: 'hardcoded-literals-with-data-file-present',
            severity: 'warn',
            detail: `Scenario hardcodes literal(s) ${s.hardcodedLiterals.slice(0, 3).join(', ')} while a data file exists at ${possibleDataFiles.map((p) => path.relative(workspaceRoot, p).replace(/\\/g, '/')).slice(0, 2).join(', ')}. Data should live in the data file, referenced via <placeholder> from Scenario Outline + Examples.`,
            hint: `Convert to Scenario Outline, move literal(s) into scenarios.json as columns, reference via <firstName> etc., and add Examples: {"type":"json","source":"...","filter":"scenarioId=..."}.`,
        });
    }

    return findings;
}

// Tautological assertion detector.
//
// An assertion like `assertEqual(await readContactHeading(), 'Contact Details')` proves
// nothing when the underlying element is located by `//h6[normalize-space()='Contact Details']`.
// If the locator resolves, the text is 'Contact Details' by construction; if it doesn't
// resolve, the read call throws before assertion. Both branches make the assertion useless.
// Same for `click Salary tab → assert Salary tab text === 'Salary'`.
//
// Strategy:
//   1. Scan every page-object file. Extract {className -> {getterName -> [text-literals]}}
//      from @CSGetElement decorators whose xpath uses text()='X' or normalize-space()='X'
//      or from `text:X` alternativeLocators. These are element-identifying literals.
//   2. Scan every .steps.ts file. For each assertEqual(...) where the second arg is a
//      quoted literal L, walk the first arg back to a page-object method call.
//      Look up the method on the page-object class. If the method reads text of an
//      element whose identifying literals include L, that assertion is tautological.
//   3. Also flag the simpler pattern where the ASSERTION LITERAL appears verbatim inside
//      ANY @CSGetElement text() clause in the same imported page-object file — this is
//      a conservative approximation that catches most cases without needing full call-graph.
function auditTautologicalAssertions(workspaceRoot: string): Array<{ file: string; line: number; scenario: string; kind: string; severity: string; detail: string; hint: string }> {
    const findings: Array<{ file: string; line: number; scenario: string; kind: string; severity: string; detail: string; hint: string }> = [];
    const testRoot = path.join(workspaceRoot, 'test');
    if (!fs.existsSync(testRoot)) return findings;

    // Phase 1: Build page-object → identifying-literals index.
    // pageLiterals: relative file path → set of text/normalize-space literals used to locate elements
    const pageLiterals = new Map<string, Set<string>>();
    walk(testRoot, (abs) => {
        if (!/[\\/]pages[\\/].*\.ts$/.test(abs) || abs.endsWith('.d.ts')) return;
        let content: string;
        try { content = fs.readFileSync(abs, 'utf-8'); } catch { return; }
        const lits = new Set<string>();
        // xpath: text()='X' or text()="X" or normalize-space()='X' or normalize-space()="X"
        const xpRe = /(?:text\s*\(\s*\)|normalize-space\s*\(\s*\)\s*)\s*=\s*['"]([^'"]{2,})['"]/g;
        let m: RegExpExecArray | null;
        while ((m = xpRe.exec(content))) lits.add(m[1].trim());
        // alternativeLocators: 'text:X'
        const altRe = /['"]text:([^'"]{2,})['"]/g;
        while ((m = altRe.exec(content))) lits.add(m[1].trim());
        if (lits.size > 0) pageLiterals.set(path.relative(workspaceRoot, abs).replace(/\\/g, '/'), lits);
    });
    if (pageLiterals.size === 0) return findings;

    // Phase 2: Scan step-def files, cross-reference assertion literals against imported page-object literals.
    walk(testRoot, (abs) => {
        if (!/\.steps\.ts$/.test(abs)) return;
        let content: string;
        try { content = fs.readFileSync(abs, 'utf-8'); } catch { return; }
        const relSteps = path.relative(workspaceRoot, abs).replace(/\\/g, '/');

        // Which page-object files does this step-def import?
        const importRe = /import\s+\{[^}]*\}\s+from\s+['"]([^'"]+)['"]/g;
        const importedPageLiterals = new Set<string>();
        let im: RegExpExecArray | null;
        while ((im = importRe.exec(content))) {
            const spec = im[1];
            if (!/\/pages\//.test(spec) && !/Page$/.test(spec)) continue;
            // Resolve relative import to a path key in pageLiterals
            const stepsDir = path.dirname(abs);
            const resolvedNoExt = path.resolve(stepsDir, spec);
            for (const candidate of [`${resolvedNoExt}.ts`, path.join(resolvedNoExt, 'index.ts')]) {
                const relCand = path.relative(workspaceRoot, candidate).replace(/\\/g, '/');
                const lits = pageLiterals.get(relCand);
                if (lits) for (const l of lits) importedPageLiterals.add(l);
            }
        }
        if (importedPageLiterals.size === 0) return;

        // Find assertion literals. Cover assertEqual, assertContains, expect(X).toBe/toEqual.
        // We can't parse balanced parens with a regex (real code has `assertEqual((await foo())...)`),
        // so instead: for each line containing an assertion call, extract EVERY quoted literal on
        // that line and check against the imported page's identifying literals. Some noise possible
        // if the same line has non-assertion literals, but false-positive rate is low because
        // page-locator literals are usually specific enough not to collide.
        const lines = content.split('\n');
        const assertKeywordRe = /\b(?:assertEqual|assertContains|assertTrue|assertFalse|toBe|toEqual|toContain)\s*\(/;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (!assertKeywordRe.test(line)) continue;
            // Scan only the substring FROM the assertion call site forward — this
            // naturally excludes the @CSBDDStepDef('...') keyword string (which lives
            // before the assertion when Copilot writes step body on the same line as
            // its decorator, e.g. `@CSBDDStepDef('...') async foo() { ...assertEqual(...) }`).
            const assertMatch = assertKeywordRe.exec(line);
            const assertIdx = assertMatch ? line.indexOf(assertMatch[0]) : -1;
            const scanBody = line.slice(assertIdx >= 0 ? assertIdx : 0);
            const litRe = /['"]([^'"\n]{2,80})['"]/g;
            let lm: RegExpExecArray | null;
            while ((lm = litRe.exec(scanBody))) {
                const lit = lm[1].trim();
                if (!importedPageLiterals.has(lit)) continue;
                findings.push({
                    file: relSteps, line: i + 1, scenario: '(step-def)',
                    kind: 'tautological-assertion',
                    severity: 'error',
                    detail: `Assertion on line ${i + 1} compares against literal "${lit}", but the page-object locates an element via a text()='${lit}' or normalize-space()='${lit}' or 'text:${lit}' locator. If the locator resolves, the text is "${lit}" by construction — the assertion is tautologically true and proves nothing about the app under test.`,
                    hint: `Change the assertion to check something the LOCATOR does not already assert: a distinct visible attribute (aria-label, count, disabled state, URL after action, or a sibling element's text). Or locate the element by a stable structural attribute (@id, @name, @data-*) instead of by its visible text, then assert the visible text separately. Example: locate the Salary content region by @data-section='salary' and assert the visible currency/amount rendered inside it — not "the tab I just clicked has the text I selected it by".`,
                });
                break; // one finding per assertion line is enough
            }
        }
    });
    return findings;
}

// Acceptance-criteria coverage.
//
// cs_qa_ado_read (verb=work-item) persists a story-<id>-acs.json checkpoint under
// .cs-qa/run-state/ listing every AC the story contains. Verifier reads those
// checkpoints and hard-errors on any AC that has no scenario tagged for it
// (@ac1 or @ac1-* or @ac1_* etc). Without this the toolchain has no way to
// detect coverage collapse — Copilot can silently ship 5 scenarios for a 20-AC
// story and every downstream tool sees a "clean" verify.
function auditAcceptanceCriteriaCoverage(scenarios: ScenarioBlock[], workspaceRoot: string): Array<{ file: string; line: number; scenario: string; kind: string; severity: string; detail: string; hint: string }> {
    const findings: Array<{ file: string; line: number; scenario: string; kind: string; severity: string; detail: string; hint: string }> = [];
    const stateDir = path.join(workspaceRoot, '.cs-qa', 'run-state');
    if (!fs.existsSync(stateDir)) return findings;
    const checkpoints = fs.readdirSync(stateDir).filter((n) => /^story-\d+-acs\.json$/.test(n));
    if (checkpoints.length === 0) return findings;

    // Build set of AC identifiers actually tagged on scenarios: extract N from any tag
    // matching @acN, @acN-*, @acN_*, or @ac_N (case-insensitive).
    const coveredAcIndices = new Set<number>();
    const acTagRe = /^@ac[_-]?(\d+)(?:[_-].*)?$/i;
    for (const s of scenarios) {
        for (const t of s.tags) {
            const m = acTagRe.exec(t);
            if (m) coveredAcIndices.add(parseInt(m[1], 10));
        }
    }

    for (const cp of checkpoints) {
        let checkpoint: { storyId: number; acs: Array<{ index: number; tag: string; text: string }> };
        try {
            checkpoint = JSON.parse(fs.readFileSync(path.join(stateDir, cp), 'utf-8')) as typeof checkpoint;
        } catch { continue; }
        if (!checkpoint.acs || !Array.isArray(checkpoint.acs) || checkpoint.acs.length === 0) continue;

        // First-scenario file (for anchoring the finding) — pick any scenario in the run
        const anchorFile = scenarios[0]?.file ?? '(feature files)';
        const anchorLine = scenarios[0]?.line ?? 1;
        const totalAcs = checkpoint.acs.length;
        const coveredCount = checkpoint.acs.filter((ac) => coveredAcIndices.has(ac.index)).length;

        // Whole-story finding: coverage collapse
        if (coveredCount < totalAcs) {
            const missing = checkpoint.acs.filter((ac) => !coveredAcIndices.has(ac.index));
            const missingList = missing.slice(0, 8).map((ac) => `AC${ac.index}: ${ac.text.slice(0, 80)}${ac.text.length > 80 ? '…' : ''}`).join(' | ');
            findings.push({
                file: anchorFile, line: anchorLine, scenario: `(story ${checkpoint.storyId})`,
                kind: 'acceptance-criteria-coverage-gap',
                severity: 'error',
                detail: `Story ${checkpoint.storyId} has ${totalAcs} acceptance criteria but only ${coveredCount} are covered by tagged scenarios (${totalAcs - coveredCount} uncovered). Missing tags: ${missing.slice(0, 12).map((m) => `@ac${m.index}`).join(', ')}${missing.length > 12 ? ', …' : ''}. First uncovered ACs: ${missingList}${missing.length > 8 ? ` (…and ${missing.length - 8} more)` : ''}.`,
                hint: `Every AC must have at least one @ac<N> or @ac<N>-<slug> tagged scenario. Read .cs-qa/run-state/${cp} for the full AC list, then emit one Scenario / Scenario Outline per uncovered AC. Do NOT merge multiple ACs into a single scenario with more Examples rows — each AC tests a distinct behavior and deserves its own tagged scenario. If an AC genuinely maps to the same When/Then flow as one you already wrote (e.g. two ACs both describe the same happy path with different worded variants), still emit two scenarios each tagged with its own @ac<N> — the tags are the coverage record.`,
            });
        }

        // Per-AC granularity: emit one finding per missing AC so heal_loop / audit can
        // consume them individually. Cap at 20 to prevent spam on huge stories.
        const missing = checkpoint.acs.filter((ac) => !coveredAcIndices.has(ac.index)).slice(0, 20);
        for (const ac of missing) {
            findings.push({
                file: anchorFile, line: anchorLine, scenario: `AC${ac.index}`,
                kind: 'uncovered-acceptance-criterion',
                severity: 'error',
                detail: `AC${ac.index} of story ${checkpoint.storyId} is uncovered by any scenario. AC text: "${ac.text.slice(0, 200)}${ac.text.length > 200 ? '…' : ''}"`,
                hint: `Emit a scenario tagged @ac${ac.index} (or @ac${ac.index}-<short-slug>) that exercises this specific behavior. The When steps should reflect what the AC actually says, and the Then step must prove the AC's observable outcome (not just a tab click).`,
            });
        }
    }
    return findings;
}

// Feature-file formatting.
//
// Copilot's generated .feature files are readable code — humans review them, PMs
// audit them, and diff-reviewers rely on structural whitespace to see what changed.
// When scenarios pile up back-to-back with no blank lines, the file becomes a wall
// of text. This detector fires warnings on the most common format problems so the
// generator learns to write cleanly the first time.
//
// Checks:
//   1. `scenarios-not-blank-separated` — two Scenario/Scenario Outline blocks (or
//      their leading @tag line) with no blank line between them.
//   2. `background-not-blank-separated` — Background block not followed by a blank
//      line before the first Scenario.
//   3. `feature-line-not-blank-separated` — Feature: line immediately followed by
//      Background: or Scenario: with no blank line.
//   4. `trailing-whitespace-lines` — lines with only spaces/tabs (visually blank
//      but not empty — messes up diffs).
//   5. `no-trailing-newline` — file doesn't end with exactly one newline.
function auditFeatureFileFormatting(workspaceRoot: string): Array<{ file: string; line: number; scenario: string; kind: string; severity: string; detail: string; hint: string }> {
    const findings: Array<{ file: string; line: number; scenario: string; kind: string; severity: string; detail: string; hint: string }> = [];
    const testRoot = path.join(workspaceRoot, 'test');
    if (!fs.existsSync(testRoot)) return findings;

    walk(testRoot, (abs) => {
        if (!abs.endsWith('.feature')) return;
        let raw: string;
        try { raw = fs.readFileSync(abs, 'utf-8'); } catch { return; }
        const rel = path.relative(workspaceRoot, abs).replace(/\\/g, '/');
        const lines = raw.split('\n');

        // Whole-file end-of-file check
        if (raw.length > 0 && !raw.endsWith('\n')) {
            findings.push({
                file: rel, line: lines.length, scenario: '(file end)',
                kind: 'no-trailing-newline', severity: 'warn',
                detail: `Feature file ${rel} does not end with a newline.`,
                hint: `Append a single \\n at end-of-file. POSIX text files must end with a newline; many tools (git diff, cat, grep -c) misbehave without it.`,
            });
        }

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (/^[\t ]+$/.test(line)) {
                findings.push({
                    file: rel, line: i + 1, scenario: '(whitespace)',
                    kind: 'trailing-whitespace-lines', severity: 'warn',
                    detail: `Line ${i + 1} contains only whitespace (spaces/tabs) — visually blank but not empty. Confuses diffs and greps.`,
                    hint: `Trim to a truly empty line. Configure your editor to trim trailing whitespace on save.`,
                });
            }
        }

        // Structural: iterate lines, find each Scenario/Scenario Outline start, then
        // walk backwards to include any leading @tag lines — the "block start" is the
        // first tag line if present, else the Scenario: line. Require the line BEFORE
        // the block start to be blank (unless it's the Feature: or Background: opener).
        const isBlank = (s: string): boolean => s === undefined || /^\s*$/.test(s);
        const isTagLine = (s: string): boolean => /^\s*@\S/.test(s);
        const isBlockOpener = (s: string): boolean => /^\s*(?:Scenario Outline|Scenario|Background|Feature)\s*:/.test(s);

        let previousBlockEnd = -1;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const scMatch = /^\s*(Scenario Outline|Scenario)\s*:/.exec(line);
            if (!scMatch) continue;
            // Find block start: walk back over leading tags
            let blockStart = i;
            for (let j = i - 1; j >= 0; j--) {
                if (isTagLine(lines[j])) { blockStart = j; continue; }
                break;
            }
            // Check line above blockStart
            if (blockStart > 0 && previousBlockEnd >= 0) {
                const above = lines[blockStart - 1];
                if (!isBlank(above) && !isBlockOpener(above)) {
                    findings.push({
                        file: rel, line: blockStart + 1, scenario: scMatch[1] + ': ' + line.replace(scMatch[0], '').trim().slice(0, 60),
                        kind: 'scenarios-not-blank-separated',
                        severity: 'warn',
                        detail: `Scenario at line ${blockStart + 1} is not preceded by a blank line. Two scenarios back-to-back read as a wall of text; readers and diff tools rely on blank separators.`,
                        hint: `Insert exactly one blank line between the previous scenario's last step (or its inline Examples block) and the tag/Scenario line of the next scenario. Rewrite the whole feature file with cs_qa_fs verb=write to fix.`,
                    });
                }
            }
            previousBlockEnd = i;
        }

        // Background separator: Background: block must be followed by a blank line
        // before the first Scenario.
        for (let i = 0; i < lines.length; i++) {
            if (!/^\s*Background\s*:/.test(lines[i])) continue;
            // Find end of Background: walk forward through Given/When/Then/And lines
            // until we hit either a blank line, a @tag line, or a Scenario: line.
            let j = i + 1;
            while (j < lines.length && /^\s*(Given|When|Then|And|But)\s+/.test(lines[j])) j++;
            // j now points at the line AFTER the last background step.
            // If that line is a tag or Scenario/Feature opener (not blank), format is wrong.
            if (j < lines.length && !isBlank(lines[j]) && (isTagLine(lines[j]) || isBlockOpener(lines[j]))) {
                findings.push({
                    file: rel, line: j + 1, scenario: '(background)',
                    kind: 'background-not-blank-separated',
                    severity: 'warn',
                    detail: `Background block ends at line ${j} but line ${j + 1} is not blank — the first scenario starts immediately.`,
                    hint: `Insert one blank line between the last Background step and the first Scenario's tag/Scenario line.`,
                });
            }
            break; // one Background per feature
        }

        // Feature: line must be followed by a blank line before Background/Scenario/@tag
        for (let i = 0; i < lines.length; i++) {
            if (!/^\s*Feature\s*:/.test(lines[i])) continue;
            const next = lines[i + 1];
            if (next && !isBlank(next) && (isBlockOpener(next) || isTagLine(next))) {
                findings.push({
                    file: rel, line: i + 2, scenario: '(feature)',
                    kind: 'feature-line-not-blank-separated',
                    severity: 'warn',
                    detail: `Feature: line at ${i + 1} is immediately followed by ${isTagLine(next) ? 'a tag' : 'a block opener'} — no blank line separator.`,
                    hint: `Insert one blank line after the Feature: title (Feature description prose, if any, may occupy that space instead).`,
                });
            }
            break;
        }
    });
    return findings;
}

// Hardcoded record ID in navigate() URL — the "cross-scenario state" trap.
//
// When a page-object's navigate() constructs a URL with a hardcoded numeric path
// segment (e.g. `/details/1`, `/user/42`, `/order/100`), it silently assumes some
// record with that ID exists on the server. Each Cucumber scenario is independent,
// so unless the scenario itself creates that record first (and captures its actual
// ID), the assertion runs against ambient state — passes coincidentally when a
// prior manual test left the record around, fails otherwise.
//
// Signal: /segment/<digits> path pattern in a page-object navigate() body. Very
// few legitimate app routes use literal numeric IDs (public IDs are usually UUIDs,
// slugs, or query params). When they do, the URL should be composed from a value
// captured earlier in the same scenario, not baked into the page-object.
function auditHardcodedRecordIdInNavigate(workspaceRoot: string): Array<{ file: string; line: number; scenario: string; kind: string; severity: string; detail: string; hint: string }> {
    const findings: Array<{ file: string; line: number; scenario: string; kind: string; severity: string; detail: string; hint: string }> = [];
    const testRoot = path.join(workspaceRoot, 'test');
    if (!fs.existsSync(testRoot)) return findings;

    walk(testRoot, (abs) => {
        if (!/[\\/]pages[\\/].*\.ts$/.test(abs) || abs.endsWith('.d.ts')) return;
        let content: string;
        try { content = fs.readFileSync(abs, 'utf-8'); } catch { return; }
        const rel = path.relative(workspaceRoot, abs).replace(/\\/g, '/');
        const lines = content.split('\n');

        // Find navigate() method bodies. Look for `navigate(` followed by a body
        // containing a URL-like string with a `/segment/<digits>` pattern.
        // Match any string literal (single/double/backtick) with the anti-pattern.
        // Skip legitimate: port numbers (`:8080`), API versions (`/v1/`, `/v2/`).
        const badPathRe = /['"`][^'"`]*\/[a-zA-Z][a-zA-Z0-9_-]*\/([0-9]+)(?=[/'"`?])[^'"`]*['"`]/g;
        let inNavigate = false;
        let navigateStartLine = 0;
        let braceDepth = 0;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (!inNavigate && /\bnavigate\s*\(/.test(line) && /\{/.test(line)) {
                inNavigate = true;
                navigateStartLine = i + 1;
                braceDepth = (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
            } else if (inNavigate) {
                braceDepth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
                if (braceDepth <= 0) { inNavigate = false; continue; }
            }
            if (!inNavigate) continue;

            let m: RegExpExecArray | null;
            const localRe = new RegExp(badPathRe.source, 'g');
            while ((m = localRe.exec(line))) {
                const matched = m[0];
                const id = m[1];
                // Skip API version-like patterns: /v1/, /v2/, etc. (the segment before the number is 'v' + digit)
                if (/\/v\d+\//.test(matched)) continue;
                // Skip port numbers: :8080, :3000 etc. (colon-prefixed)
                if (/:\d+/.test(matched.slice(0, m.index - 1 < 0 ? 0 : matched.indexOf(id)))) continue;
                findings.push({
                    file: rel, line: i + 1, scenario: `(navigate at line ${navigateStartLine})`,
                    kind: 'hardcoded-record-id-in-navigate',
                    severity: 'warn',
                    detail: `Page-object's navigate() method constructs a URL containing a hardcoded numeric record ID (matched literal: ${matched.length > 90 ? matched.slice(0, 90) + '…' : matched}). Each Cucumber scenario is independent — this URL assumes some record with ID ${id} exists on the server, which either requires the scenario to create it first (and capture the returned ID) or requires a seeded fixture. Neither is provable from the page-object alone.`,
                    hint: `Refactor navigate() to accept a recordId parameter. In the scenario, capture the ID during the create step (from the redirect URL, response JSON, or DB) and pass it to navigate(). Example: instead of \`navigate() { super.navigate('/details/1') }\`, use \`navigate(recordId: string) { super.navigate(\`/details/\${recordId}\`) }\` and call from the step-def with the ID captured earlier via ctx.set/ctx.get. This makes the scenario self-sufficient.`,
                });
                break; // one finding per navigate() body is enough
            }
        }
    });
    return findings;
}

// AC-interaction coverage.
//
// When AC text mentions a specific UI interaction (upload, toggle, duplicate,
// cancel, delete, search, ...), the scenario tagged for that AC must actually
// perform that interaction — not just click Save and assert on a random toast.
// Skipping the interaction and asserting on its expected outcome is fabrication:
// the "green" run doesn't prove the feature works because the feature was never
// exercised.
//
// Detects: for each AC checkpoint, extract interaction verbs from AC text,
// resolve the scenario tagged @ac<N>, walk its step-def method bodies and
// every imported page-object method body, verify each interaction verb has
// a corresponding action pattern present. Missing → warn (severity=warn, not
// error, because verb detection is heuristic — some ACs use interaction words
// figuratively).
function auditAcInteractionCoverage(scenarios: ScenarioBlock[], workspaceRoot: string): Array<{ file: string; line: number; scenario: string; kind: string; severity: string; detail: string; hint: string }> {
    const findings: Array<{ file: string; line: number; scenario: string; kind: string; severity: string; detail: string; hint: string }> = [];
    const stateDir = path.join(workspaceRoot, '.cs-qa', 'run-state');
    if (!fs.existsSync(stateDir)) return findings;
    const checkpoints = fs.readdirSync(stateDir).filter((n) => /^story-\d+-acs\.json$/.test(n));
    if (checkpoints.length === 0) return findings;

    // Generic interaction verb families. Each family maps AC-text keywords → regex
    // that must match SOMEWHERE in the scenario's step-def / page-object code paths.
    // Keep these UI-domain-generic — never app-specific.
    interface Verb { name: string; textRe: RegExp; codeRe: RegExp; hintAction: string; }
    const verbs: Verb[] = [
        {
            name: 'file-upload',
            textRe: /\b(?:upload|attach(?:ment)?|photo|image file|document file|browse (?:for )?file|select (?:a )?file|choose file)\b/i,
            codeRe: /setInputFiles\s*\(|\.upload\s*\(|attachFile|enterPhoto|enterAttachment|enterImage|enterFile|photoField|fileInput/i,
            hintAction: 'Add a page-object method that uses the file input (`setInputFiles(<path>)` on the file <input>) and call it from the step-def. Provide a real fixture file (valid + invalid extensions in a `test/<project>/fixtures/` directory).',
        },
        {
            name: 'toggle-switch',
            textRe: /\b(?:toggle|switch(?: on| off)?|checkbox|check(?: box)? (?:the|is)|uncheck|enable(?:d)?|disable(?:d)?)\b/i,
            codeRe: /\.check\s*\(|\.uncheck\s*\(|\.toggle\s*\(|toggleCheckbox|clickCheckbox|switch\w*Button|enableToggle|disableToggle/i,
            hintAction: 'Add a page-object method that clicks the toggle/checkbox element and asserts on its resulting state. Call it from the step-def before asserting the downstream effect.',
        },
        {
            name: 'duplicate-submit',
            textRe: /\b(?:duplicate|already exists|second time|submit(?:ted)? (?:again|twice)|resubmit|prevented from|uniqueness)\b/i,
            codeRe: /submitDuplicate|createDuplicate|saveAgain|submitTwice|submitSecond|Duplicate\(|repeat(?:ed)?Submit/i,
            hintAction: 'Add a page-object method OR a step that saves the same payload twice within one scenario (e.g. `save(); await navigateBack(); enterSameId(); save();`), then assert the second attempt shows the duplicate-rejection message.',
        },
        {
            name: 'cancel-discard',
            textRe: /\b(?:cancel(?:s|ling)?|discard(?:ed)?|abandon(?:ed)?|revert|back out|do not save)\b/i,
            codeRe: /\.cancel\s*\(|clickCancel|cancelButton|discardChanges|revertForm/i,
            hintAction: 'Add a `cancel()` method on the page-object that clicks the Cancel button, and call it from the step-def. Assert on the resulting navigation (back to list) or the absence of a persisted record.',
        },
        {
            name: 'delete-remove',
            textRe: /\b(?:delete(?:d|s)?|remove(?:d|s)?|trash|permanent(?:ly)? (?:removed|deleted))\b/i,
            codeRe: /\.delete\s*\(|\.remove\s*\(|deleteButton|removeButton|confirmDelete|trashButton/i,
            hintAction: 'Add a `delete()` (or `remove()`) method on the page-object. The step-def must trigger the delete and confirm the resulting record-not-found or removed-from-list state.',
        },
        {
            name: 'search-filter',
            textRe: /\b(?:search(?:es|ing)?(?: for| by| returns| results?)?|filter(?:s|ing)?(?: by| on)?|look ?up|find (?:by|the record))\b/i,
            codeRe: /\.search\s*\(|searchField|\.filter\s*\(|searchInput|searchButton|filterDropdown/i,
            hintAction: 'Add a `search(query)` (or `filter(criteria)`) method on the page-object that fills the search input and submits. Step-def must call it and assert the resulting list contains the expected record.',
        },
        {
            name: 'authorization-check',
            textRe: /\b(?:only (?:visible|available|shown) to|admin(?:istrator)? (?:only|access)|restricted to|hidden from|unauthori[sz]ed|permission(?:s)?)\b/i,
            codeRe: /assertVisibleForRole|assertHiddenFromRole|isVisibleForAdmin|isHiddenForNonAdmin|switchRole|loginAs\w+Role/i,
            hintAction: 'Add role-switching to the scenario: log in as the non-privileged role first, assert the element is hidden, then log in as the privileged role and assert it is visible. Merely opening a tab and asserting its text is not an authorization test.',
        },
    ];

    // Build scenario → step-def code map so we can query each scenario's actual reachable code
    const stepDefFiles: Array<{ path: string; content: string; imports: string[] }> = [];
    const pageObjectFiles = new Map<string, string>();  // abs path → content
    const testRoot = path.join(workspaceRoot, 'test');
    walk(testRoot, (abs) => {
        if (abs.endsWith('.d.ts')) return;
        if (/\.steps\.ts$/.test(abs)) {
            try {
                const content = fs.readFileSync(abs, 'utf-8');
                const importRe = /import\s+\{[^}]*\}\s+from\s+['"]([^'"]+)['"]/g;
                const imports: string[] = [];
                let im: RegExpExecArray | null;
                const stepsDir = path.dirname(abs);
                while ((im = importRe.exec(content))) {
                    if (!/\/pages\//.test(im[1]) && !/Page$/.test(im[1])) continue;
                    const resolved = path.resolve(stepsDir, im[1]) + '.ts';
                    imports.push(resolved);
                }
                stepDefFiles.push({ path: abs, content, imports });
            } catch { /* noop */ }
        } else if (/[\\/]pages[\\/].*\.ts$/.test(abs)) {
            try { pageObjectFiles.set(abs, fs.readFileSync(abs, 'utf-8')); } catch { /* noop */ }
        }
    });

    // Get the union of all step-def content + imported page-object content — the
    // total code surface the scenarios can reach. Coarser than per-scenario walk
    // but avoids Cucumber step-name-matching complexity for MVP.
    const allStepContent = stepDefFiles.map((s) => s.content).join('\n');
    const allImportedPageContent = Array.from(new Set(stepDefFiles.flatMap((s) => s.imports)))
        .map((p) => pageObjectFiles.get(p) ?? '')
        .join('\n');
    const codeCorpus = allStepContent + '\n' + allImportedPageContent;

    for (const cp of checkpoints) {
        let checkpoint: { storyId: number; acs: Array<{ index: number; tag: string; text: string }> };
        try {
            checkpoint = JSON.parse(fs.readFileSync(path.join(stateDir, cp), 'utf-8')) as typeof checkpoint;
        } catch { continue; }
        if (!checkpoint.acs || !Array.isArray(checkpoint.acs)) continue;

        for (const ac of checkpoint.acs) {
            const text = ac.text || '';
            const matchedVerbs = verbs.filter((v) => v.textRe.test(text));
            if (matchedVerbs.length === 0) continue;
            const uncovered = matchedVerbs.filter((v) => !v.codeRe.test(codeCorpus));
            if (uncovered.length === 0) continue;

            // Find the scenario tagged @acN or @acN-* to anchor the finding
            const acTagRe = new RegExp(`^@ac[_-]?${ac.index}(?:[_-].*)?$`, 'i');
            const scenario = scenarios.find((s) => s.tags.some((t) => acTagRe.test(t)));
            const anchorFile = scenario?.file ?? '(feature)';
            const anchorLine = scenario?.line ?? 1;

            findings.push({
                file: anchorFile, line: anchorLine, scenario: `AC${ac.index}`,
                kind: 'ac-interaction-verb-uncovered',
                severity: 'warn',
                detail: `AC${ac.index} of story ${checkpoint.storyId} mentions interaction${uncovered.length > 1 ? 's' : ''} [${uncovered.map((v) => v.name).join(', ')}] but no step-def or imported page-object in the workspace contains the corresponding action code. AC text: "${text.slice(0, 180)}${text.length > 180 ? '…' : ''}". A green run here would prove nothing — the scenario asserts on the outcome of an interaction that never happens.`,
                hint: uncovered.map((v) => `${v.name}: ${v.hintAction}`).join(' ||| '),
            });
        }
    }
    return findings;
}
