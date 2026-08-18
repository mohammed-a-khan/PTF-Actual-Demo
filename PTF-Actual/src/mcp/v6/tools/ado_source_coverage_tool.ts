/**
 * cs_qa_source_coverage — cross-references the source model against the local
 * `test/**` tree (features + page objects + step defs) and emits both a JSON
 * report and a Markdown gap report. Answers "what in the app is untested?"
 * using REAL evidence — not just a class-count.
 *
 * Coverage rules
 * --------------
 *   Endpoint: covered when a step-def file contains a step whose regex text
 *             references the endpoint path OR a feature scenario name
 *             contains controller+method.
 *   Screen:   covered when a page-object exists with a URL matching the
 *             screen's action OR with a class name matching the screen name.
 *   Entity:   covered when any step-def references at least one of the
 *             entity's column names in its assertion text.
 *   Validator: covered when a `.feature` scenario tagged `@negative` asserts
 *              a message text overlapping the validator's expected literal.
 *
 * Orphans
 * -------
 *   featureFilesWithNoBackingScreen — features that do not resolve to any
 *   matched screen.
 *   pageObjectsWithNoBackingScreen — page-objects whose URL/class does not
 *   resolve to any screen in the model.
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import { createLogger } from './_helpers/structured_logger';
import { loadModel, SourceModel } from './ado_source_ingest_tool';
import { splitIdentifier, tokenize } from './_helpers/story_matcher';

// -----------------------------------------------------------------------------
// I/O schemas.
// -----------------------------------------------------------------------------

const InputSchema = z.object({
    sourceModelPath: z.string().optional(),
    testRoot: z.string().default('test'),
    outputJson: z.string().optional(),
    outputMarkdown: z.string().optional(),
    dryRun: z.boolean().default(false),
    by: z.enum(['endpoint', 'tc', 'ac', 'story', 'all']).default('all').describe('all = full facet report (default). endpoint = per-endpoint rollup (which features/step-defs touch each). tc = per-ADO-TestCase rollup (which scenarios implement each — needs @TCxxxx tags on scenarios). ac = per-acceptance-criterion rollup (needs .cs-qa/run-state/story-<id>-acs.json checkpoints + @ac<n> tags). story = story→TCs→scenarios rollup (needs @storyxxxx tags).'),
});

const CoverageSchema = z.object({
    generatedAt: z.string(),
    modelPath: z.string(),
    endpoints: z.object({
        total: z.number(),
        covered: z.number(),
        uncovered: z.array(z.object({
            endpointId: z.string(), verb: z.string(), path: z.string(), controllerClass: z.string(),
        })),
        coveragePercent: z.number(),
    }),
    screens: z.object({
        total: z.number(),
        covered: z.number(),
        uncovered: z.array(z.object({
            screenId: z.string(), screenName: z.string(), filePath: z.string(),
        })),
        coveragePercent: z.number(),
    }),
    entities: z.object({
        total: z.number(),
        coveredByAssertion: z.number(),
        uncovered: z.array(z.object({ className: z.string(), tableName: z.string().nullable() })),
        coveragePercent: z.number(),
    }),
    validators: z.object({
        total: z.number(),
        coveredByNegativeTest: z.number(),
        uncovered: z.array(z.object({ className: z.string(), constraint: z.string(), messageKey: z.string().nullable() })),
        coveragePercent: z.number(),
    }),
    orphans: z.object({
        featureFilesWithNoBackingScreen: z.array(z.string()),
        pageObjectsWithNoBackingScreen: z.array(z.string()),
    }),
});

export type CoverageReport = z.infer<typeof CoverageSchema>;

// -----------------------------------------------------------------------------
// Test-tree scanning.
// -----------------------------------------------------------------------------

interface TestArtifacts {
    stepDefs: Array<{ absPath: string; content: string; regexes: string[] }>;
    features: Array<{ absPath: string; content: string; scenarioNames: string[]; negativeScenarioTexts: string[] }>;
    pageObjects: Array<{ absPath: string; className: string; urls: string[]; content: string }>;
}

function walkTests(root: string): TestArtifacts {
    const out: TestArtifacts = { stepDefs: [], features: [], pageObjects: [] };
    if (!fs.existsSync(root)) return out;
    const stack: string[] = [root];
    while (stack.length > 0) {
        const dir = stack.pop() as string;
        let ents: fs.Dirent[];
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of ents) {
            if (['node_modules', 'dist', '.git', 'reports'].includes(e.name)) continue;
            const abs = path.join(dir, e.name);
            if (e.isDirectory()) { stack.push(abs); continue; }
            if (!e.isFile()) continue;
            const lower = abs.toLowerCase();
            if (lower.endsWith('.feature')) {
                let content = '';
                try { content = fs.readFileSync(abs, 'utf-8'); } catch { continue; }
                const scenNames = Array.from(content.matchAll(/^\s*Scenario(?:\s+Outline)?\s*:\s*(.+)$/gm)).map((m) => m[1].trim());
                const negativeTexts = extractNegativeScenarios(content);
                out.features.push({ absPath: abs, content, scenarioNames: scenNames, negativeScenarioTexts: negativeTexts });
            } else if (lower.endsWith('.ts') || lower.endsWith('.js')) {
                let content = '';
                try { content = fs.readFileSync(abs, 'utf-8'); } catch { continue; }
                // Heuristic: step-def files carry Cucumber annotations (`@Given`,
                // `@When`, `@Then`) or `Given(` / `When(` / `Then(` calls.
                const isStepDef = /@(Given|When|Then|And)\s*\(/.test(content) || /\b(Given|When|Then|And)\s*\(\s*[/'"`]/.test(content);
                if (isStepDef) {
                    const regexes: string[] = [];
                    // Step-def calls: @Given('...'), Given("..."), When(`...`),
                    // @When(/regex/). Match each opening bracket + capture until
                    // the matching closing bracket, honoring the delimiter kind.
                    const stepCallRe = /@?(?:Given|When|Then|And)\s*\(\s*(["'`\/])/g;
                    let m: RegExpExecArray | null;
                    while ((m = stepCallRe.exec(content)) !== null) {
                        const openIdx = m.index + m[0].length - 1;
                        const delim = m[1];
                        let j = openIdx + 1;
                        while (j < content.length) {
                            const c = content[j];
                            if (c === '\\') { j += 2; continue; }
                            if (c === delim) break;
                            j++;
                        }
                        if (j < content.length) regexes.push(content.slice(openIdx + 1, j));
                    }
                    out.stepDefs.push({ absPath: abs, content, regexes });
                }
                // Page objects: classes ending with Page + at least one navigate/goto reference.
                const classMatch = content.match(/class\s+(\w*Page)\b/);
                if (classMatch) {
                    const urlRe = /(?:goto|navigate|url\s*=|BASE_URL\s*\+)\s*\(?["'`]([^"'`]+)["'`]/g;
                    const urls: string[] = [];
                    let u: RegExpExecArray | null;
                    while ((u = urlRe.exec(content)) !== null) urls.push(u[1]);
                    out.pageObjects.push({ absPath: abs, className: classMatch[1], urls, content });
                }
            }
        }
    }
    return out;
}

function extractNegativeScenarios(featureContent: string): string[] {
    // Find scenarios tagged with @negative (or @validation) and return the
    // whole scenario body as one string.
    const out: string[] = [];
    const lines = featureContent.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!/@negative\b|@validation\b/i.test(line)) continue;
        // Find the following Scenario: block.
        for (let j = i + 1; j < lines.length; j++) {
            if (/^\s*Scenario(?:\s+Outline)?\s*:/.test(lines[j])) {
                // Collect until next Scenario / Feature.
                let end = j + 1;
                while (end < lines.length && !/^\s*(?:Scenario|Feature|@)/.test(lines[end])) end++;
                out.push(lines.slice(j, end).join('\n'));
                i = end - 1;
                break;
            }
            if (/^\s*Feature\s*:/.test(lines[j])) break;
        }
    }
    return out;
}

// -----------------------------------------------------------------------------
// Rule engine.
// -----------------------------------------------------------------------------

/**
 * Reduce a path like `/employees/{id}/orders/{oid}` to its structural segments
 * `['employees', '*', 'orders', '*']`. Placeholder segments (`{...}`,
 * `:param`, `{int}`, `{string}`, `[0-9]+`, digits) all collapse to `*` so that
 * a step regex `/employees/{int}/orders/{int}` matches an endpoint whose
 * template names differ.
 */
function normalizePathSegments(p: string): string[] {
    return p.split('/').filter(Boolean).map((seg) => {
        if (/^\{.*\}$/.test(seg)) return '*';
        if (/^:.+/.test(seg)) return '*';
        if (/^\[[^\]]+\]/.test(seg)) return '*';
        if (/^\d+$/.test(seg)) return '*';
        // Regex tokens that look like `\d+`, `[0-9]+` etc — treat as placeholder.
        if (/^\\?d\+?$/.test(seg)) return '*';
        return seg.toLowerCase();
    });
}

function segEquals(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && a[i] !== '*' && b[i] !== '*') return false;
    return true;
}

/**
 * True when the endpoint path appears verbatim (segment-wise) inside `text`,
 * anchored on `/` so `/employees` doesn't match `/employees/{id}` and vice
 * versa.
 */
function pathAppearsIn(epSegs: string[], text: string): boolean {
    const lower = text.toLowerCase();
    // Extract every `/segment/segment/...` run from the text. We require an
    // EQUAL-length structural match — `/employees` and `/employees/{id}` are
    // different endpoints, and a step whose text mentions only one should
    // cover only one.
    const pathRunRe = /\/[a-z0-9_{}:\-*.\[\]\\]+(?:\/[a-z0-9_{}:\-*.\[\]\\]+)*/g;
    let m: RegExpExecArray | null;
    while ((m = pathRunRe.exec(lower)) !== null) {
        const runSegs = normalizePathSegments(m[0]);
        if (runSegs.length === epSegs.length && segEquals(runSegs, epSegs)) return true;
    }
    return false;
}

function endpointCovered(ep: SourceModel['endpoints'][number], arts: TestArtifacts): boolean {
    const epSegs = normalizePathSegments(ep.path);
    const ctrlPlusMethod = `${ep.controllerClass.replace(/Controller$/, '')} ${ep.methodName}`.toLowerCase();
    for (const s of arts.stepDefs) {
        for (const r of s.regexes) {
            if (pathAppearsIn(epSegs, r)) return true;
        }
    }
    for (const feat of arts.features) {
        for (const scen of feat.scenarioNames) {
            const lower = scen.toLowerCase();
            if (lower.includes(ctrlPlusMethod)) return true;
            if (pathAppearsIn(epSegs, scen)) return true;
        }
    }
    return false;
}

function screenCovered(scr: SourceModel['screens'][number], arts: TestArtifacts): boolean {
    const actions = scr.forms.map((f) => f.action).filter(Boolean) as string[];
    const nameLower = scr.screenName.toLowerCase();
    for (const po of arts.pageObjects) {
        if (po.className.toLowerCase().includes(nameLower)) return true;
        for (const u of po.urls) {
            for (const a of actions) if (u.toLowerCase().includes(a.toLowerCase())) return true;
            if (u.toLowerCase().includes(nameLower)) return true;
        }
    }
    return false;
}

function entityCoveredByAssertion(ent: SourceModel['entities'][number], arts: TestArtifacts): boolean {
    const cols = ent.columns.map((c) => c.name.toLowerCase());
    for (const s of arts.stepDefs) {
        const lower = s.content.toLowerCase();
        for (const c of cols) if (c.length > 2 && lower.includes(c)) return true;
    }
    return false;
}

function validatorCoveredByNegative(constraintText: string, arts: TestArtifacts): boolean {
    if (!constraintText) return false;
    const needle = constraintText.toLowerCase();
    for (const feat of arts.features) {
        for (const neg of feat.negativeScenarioTexts) {
            if (neg.toLowerCase().includes(needle)) return true;
        }
    }
    return false;
}

// -----------------------------------------------------------------------------
// Markdown formatter.
// -----------------------------------------------------------------------------

function renderMarkdown(report: CoverageReport, model: SourceModel): string {
    const lines: string[] = [];
    lines.push('# Source-coverage gap report');
    lines.push('');
    lines.push(`Generated: ${report.generatedAt}`);
    lines.push(`Model: ${report.modelPath}`);
    lines.push('');
    lines.push('## Summary');
    lines.push('');
    lines.push('| Facet | Covered | Total | % |');
    lines.push('|---|---|---|---|');
    lines.push(`| Endpoints | ${report.endpoints.covered} | ${report.endpoints.total} | ${report.endpoints.coveragePercent}% |`);
    lines.push(`| Screens | ${report.screens.covered} | ${report.screens.total} | ${report.screens.coveragePercent}% |`);
    lines.push(`| Entities | ${report.entities.coveredByAssertion} | ${report.entities.total} | ${report.entities.coveragePercent}% |`);
    lines.push(`| Validators | ${report.validators.coveredByNegativeTest} | ${report.validators.total} | ${report.validators.coveragePercent}% |`);
    lines.push('');
    if (report.endpoints.uncovered.length > 0) {
        lines.push('## Uncovered endpoints');
        lines.push('');
        lines.push('| Verb | Path | Controller |');
        lines.push('|---|---|---|');
        for (const e of report.endpoints.uncovered) {
            lines.push(`| ${e.verb} | \`${e.path}\` | ${e.controllerClass} |`);
        }
        lines.push('');
    }
    if (report.screens.uncovered.length > 0) {
        lines.push('## Uncovered screens');
        lines.push('');
        for (const s of report.screens.uncovered) lines.push(`- ${s.screenName} — ${s.filePath}`);
        lines.push('');
    }
    if (report.entities.uncovered.length > 0) {
        lines.push('## Entities with no assertion coverage');
        lines.push('');
        for (const e of report.entities.uncovered) lines.push(`- ${e.className}${e.tableName ? ` (table \`${e.tableName}\`)` : ''}`);
        lines.push('');
    }
    if (report.validators.uncovered.length > 0) {
        lines.push('## Validators with no negative-test coverage');
        lines.push('');
        for (const v of report.validators.uncovered.slice(0, 30)) {
            lines.push(`- ${v.className}#${v.constraint}${v.messageKey ? ` (key: ${v.messageKey})` : ''}`);
        }
        lines.push('');
    }
    if (report.orphans.featureFilesWithNoBackingScreen.length > 0) {
        lines.push('## Orphan feature files (no matching screen in model)');
        lines.push('');
        for (const f of report.orphans.featureFilesWithNoBackingScreen) lines.push(`- ${f}`);
        lines.push('');
    }
    if (report.orphans.pageObjectsWithNoBackingScreen.length > 0) {
        lines.push('## Orphan page objects (no matching screen in model)');
        lines.push('');
        for (const p of report.orphans.pageObjectsWithNoBackingScreen) lines.push(`- ${p}`);
        lines.push('');
    }
    lines.push('---');
    lines.push('');
    lines.push(`Model summary: ${model.endpoints.length} endpoints, ${model.screens.length} screens, ${model.entities.length} entities, ${model.validators.length} validators.`);
    return lines.join('\n') + '\n';
}

// -----------------------------------------------------------------------------
// Register.
// -----------------------------------------------------------------------------

registerPrimitive({
    name: 'cs_qa_source_coverage',
    description: 'Cross-reference the source-of-truth model (from cs_qa_source_ingest) against local test/**/*.feature + page objects + step defs and emit both a JSON coverage report and a Markdown gap report. Endpoint/screen/entity/validator coverage is computed from REAL rule matches, not by class-count.',
    inputSchema: InputSchema,
    outputSchema: z.object({
        ok: z.boolean(),
        jsonPath: z.string().nullable(),
        markdownPath: z.string().nullable(),
        report: CoverageSchema.optional(),
        by: z.string().optional(),
        rollup: z.unknown().optional(),
        note: z.string().optional(),
    }),
    run: async (ctx, input) => {
        const log = createLogger(ctx.invocationId, 'cs_qa_source_coverage', { workspaceRoot: ctx.workspaceRoot });
        const modelPath = input.sourceModelPath
            ? (path.isAbsolute(input.sourceModelPath) ? input.sourceModelPath : path.join(ctx.workspaceRoot, input.sourceModelPath))
            : path.join(ctx.workspaceRoot, '.cs-qa', 'source-model', 'model.json');
        const model = loadModel(modelPath);
        if (!model) return { ok: false, jsonPath: null, markdownPath: null, note: `source model not found at ${modelPath}. Run cs_qa_source_ingest first.` };

        const testRootAbs = path.isAbsolute(input.testRoot) ? input.testRoot : path.join(ctx.workspaceRoot, input.testRoot);
        const arts = walkTests(testRootAbs);
        log.info('source-coverage: scanned tests', { features: arts.features.length, stepDefs: arts.stepDefs.length, pageObjects: arts.pageObjects.length });

        // Endpoints.
        const epUncovered: CoverageReport['endpoints']['uncovered'] = [];
        let epCovered = 0;
        for (const ep of model.endpoints) {
            if (endpointCovered(ep, arts)) epCovered++;
            else epUncovered.push({ endpointId: ep.id, verb: ep.verb, path: ep.path, controllerClass: ep.controllerClass });
        }
        // Screens.
        const scrUncovered: CoverageReport['screens']['uncovered'] = [];
        let scrCovered = 0;
        for (const scr of model.screens) {
            if (screenCovered(scr, arts)) scrCovered++;
            else scrUncovered.push({ screenId: scr.id, screenName: scr.screenName, filePath: scr.filePath });
        }
        // Entities.
        const entUncovered: CoverageReport['entities']['uncovered'] = [];
        let entCovered = 0;
        for (const ent of model.entities) {
            if (entityCoveredByAssertion(ent, arts)) entCovered++;
            else entUncovered.push({ className: ent.className, tableName: ent.tableName });
        }
        // Validators.
        const valUncovered: CoverageReport['validators']['uncovered'] = [];
        let valCovered = 0;
        let valTotal = 0;
        for (const v of model.validators) {
            for (const c of v.constraints) {
                valTotal++;
                let literal = c.errorMessageLiteral;
                if (!literal && c.errorMessageKey) {
                    for (const b of Object.values(model.messages)) if (b[c.errorMessageKey] !== undefined) { literal = b[c.errorMessageKey]; break; }
                }
                if (literal && validatorCoveredByNegative(literal, arts)) valCovered++;
                else valUncovered.push({ className: v.className, constraint: c.kind + ':' + c.field, messageKey: c.errorMessageKey });
            }
        }
        // Orphans.
        const screenNamesLower = new Set(model.screens.map((s) => s.screenName.toLowerCase()));
        const featureOrphans: string[] = [];
        for (const f of arts.features) {
            const base = path.basename(f.absPath, '.feature').toLowerCase();
            const tokens = new Set(splitIdentifier(base));
            let matched = false;
            for (const scr of model.screens) {
                const sTokens = new Set(splitIdentifier(scr.screenName));
                for (const t of tokens) if (sTokens.has(t)) { matched = true; break; }
                if (matched) break;
            }
            if (!matched) featureOrphans.push(path.relative(ctx.workspaceRoot, f.absPath));
        }
        const pageOrphans: string[] = [];
        for (const po of arts.pageObjects) {
            const clsLower = po.className.replace(/Page$/, '').toLowerCase();
            if (!Array.from(screenNamesLower).some((n) => n.includes(clsLower) || clsLower.includes(n))) {
                pageOrphans.push(path.relative(ctx.workspaceRoot, po.absPath));
            }
        }

        const pct = (n: number, d: number) => d === 0 ? 100 : Math.round((n / d) * 100);
        const report: CoverageReport = {
            generatedAt: new Date().toISOString(),
            modelPath,
            endpoints: {
                total: model.endpoints.length, covered: epCovered, uncovered: epUncovered,
                coveragePercent: pct(epCovered, model.endpoints.length),
            },
            screens: {
                total: model.screens.length, covered: scrCovered, uncovered: scrUncovered,
                coveragePercent: pct(scrCovered, model.screens.length),
            },
            entities: {
                total: model.entities.length, coveredByAssertion: entCovered, uncovered: entUncovered,
                coveragePercent: pct(entCovered, model.entities.length),
            },
            validators: {
                total: valTotal, coveredByNegativeTest: valCovered, uncovered: valUncovered,
                coveragePercent: pct(valCovered, valTotal),
            },
            orphans: {
                featureFilesWithNoBackingScreen: featureOrphans,
                pageObjectsWithNoBackingScreen: pageOrphans,
            },
        };

        const jsonPath = input.outputJson
            ? (path.isAbsolute(input.outputJson) ? input.outputJson : path.join(ctx.workspaceRoot, input.outputJson))
            : path.join(ctx.workspaceRoot, '.cs-qa', 'source-model', 'coverage.json');
        const mdPath = input.outputMarkdown
            ? (path.isAbsolute(input.outputMarkdown) ? input.outputMarkdown : path.join(ctx.workspaceRoot, input.outputMarkdown))
            : path.join(ctx.workspaceRoot, '.cs-qa', 'source-model', 'coverage-gap.md');

        if (!input.dryRun) {
            try {
                fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
                fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf-8');
                fs.mkdirSync(path.dirname(mdPath), { recursive: true });
                fs.writeFileSync(mdPath, renderMarkdown(report, model), 'utf-8');
            } catch (e) {
                return { ok: false, jsonPath: null, markdownPath: null, note: 'write-failed: ' + (e as Error).message };
            }
        }

        // ---- by-dimension rollups (extension) ----
        let rollup: unknown = undefined;
        if (input.by && input.by !== 'all') {
            rollup = buildDimensionRollup(input.by, model, arts, ctx.workspaceRoot);
        }

        return {
            ok: true,
            jsonPath: input.dryRun ? null : jsonPath,
            markdownPath: input.dryRun ? null : mdPath,
            report,
            by: input.by,
            rollup,
            note: `endpoints ${report.endpoints.coveragePercent}%, screens ${report.screens.coveragePercent}%, entities ${report.entities.coveragePercent}%, validators ${report.validators.coveragePercent}%. Orphans: ${featureOrphans.length} feature files, ${pageOrphans.length} page objects.${input.by && input.by !== 'all' ? ' | by=' + input.by + ' rollup emitted' : ''}`,
        };
    },
});

// ---------------------------------------------------------------------------
// by-dimension rollups.
// ---------------------------------------------------------------------------

interface EndpointRollupRow {
    endpointId: string; verb: string; path: string; controller: string;
    coveringSteps: string[]; coveringFeatures: string[]; covered: boolean;
}

interface TcRollupRow {
    tcId: string; scenarios: string[]; features: string[]; covered: boolean;
}

interface AcRollupRow {
    storyId: number; acIndex: number; text: string; scenarios: string[]; covered: boolean;
}

interface StoryRollupRow {
    storyId: number; testCaseIds: string[]; scenarios: string[]; features: string[]; totalAcs: number; coveredAcs: number;
}

function buildDimensionRollup(
    by: 'endpoint' | 'tc' | 'ac' | 'story',
    model: SourceModel,
    arts: TestArtifacts,
    workspaceRoot: string,
): unknown {
    if (by === 'endpoint') return rollupByEndpoint(model, arts);
    if (by === 'tc') return rollupByTc(arts);
    if (by === 'ac') return rollupByAc(workspaceRoot, arts);
    if (by === 'story') return rollupByStory(workspaceRoot, arts);
    return undefined;
}

function rollupByEndpoint(model: SourceModel, arts: TestArtifacts): { rows: EndpointRollupRow[]; totals: { total: number; covered: number; coveragePercent: number } } {
    const rows: EndpointRollupRow[] = [];
    let covered = 0;
    for (const ep of model.endpoints) {
        const epSegs = normalizePathSegments(ep.path);
        const coveringSteps: string[] = [];
        const coveringFeatures: string[] = [];
        for (const s of arts.stepDefs) {
            for (const r of s.regexes) {
                if (pathAppearsIn(epSegs, r)) { coveringSteps.push(path.basename(s.absPath)); break; }
            }
        }
        const ctrlPlusMethod = `${ep.controllerClass.replace(/Controller$/, '')} ${ep.methodName}`.toLowerCase();
        for (const feat of arts.features) {
            for (const scen of feat.scenarioNames) {
                const lower = scen.toLowerCase();
                if (lower.includes(ctrlPlusMethod) || pathAppearsIn(epSegs, scen)) {
                    coveringFeatures.push(path.basename(feat.absPath));
                    break;
                }
            }
        }
        const isCovered = coveringSteps.length > 0 || coveringFeatures.length > 0;
        if (isCovered) covered++;
        rows.push({
            endpointId: ep.id, verb: ep.verb, path: ep.path,
            controller: ep.controllerClass,
            coveringSteps: Array.from(new Set(coveringSteps)),
            coveringFeatures: Array.from(new Set(coveringFeatures)),
            covered: isCovered,
        });
    }
    return { rows, totals: { total: rows.length, covered, coveragePercent: rows.length === 0 ? 100 : Math.round((covered / rows.length) * 100) } };
}

function rollupByTc(arts: TestArtifacts): { rows: TcRollupRow[]; totals: { totalTcs: number; coveredTcs: number } } {
    // TC id tags — @TC1234, @tc1234, @TestCase1234 — canonicalized to "TC<n>".
    const TC_TAG_RE = /@(?:tc|testcase)(\d+)/gi;
    const perTc = new Map<string, { scenarios: Set<string>; features: Set<string> }>();
    for (const feat of arts.features) {
        const lines = feat.content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            TC_TAG_RE.lastIndex = 0;
            const matches = Array.from(line.matchAll(TC_TAG_RE));
            if (matches.length === 0) continue;
            // Grab the next Scenario line for context.
            let scenName = '';
            for (let j = i + 1; j < Math.min(lines.length, i + 10); j++) {
                const sm = /^\s*Scenario(?:\s+Outline)?\s*:\s*(.+)$/.exec(lines[j]);
                if (sm) { scenName = sm[1].trim(); break; }
            }
            for (const m of matches) {
                const key = `TC${m[1]}`;
                const rec = perTc.get(key) || { scenarios: new Set<string>(), features: new Set<string>() };
                if (scenName) rec.scenarios.add(scenName);
                rec.features.add(path.basename(feat.absPath));
                perTc.set(key, rec);
            }
        }
    }
    const rows: TcRollupRow[] = [];
    for (const [tcId, rec] of perTc.entries()) {
        rows.push({ tcId, scenarios: Array.from(rec.scenarios), features: Array.from(rec.features), covered: rec.scenarios.size > 0 || rec.features.size > 0 });
    }
    rows.sort((a, b) => a.tcId.localeCompare(b.tcId, undefined, { numeric: true }));
    const coveredTcs = rows.filter((r) => r.covered).length;
    return { rows, totals: { totalTcs: rows.length, coveredTcs } };
}

function rollupByAc(workspaceRoot: string, arts: TestArtifacts): { rows: AcRollupRow[]; totals: { total: number; covered: number; coveragePercent: number } } {
    const rows: AcRollupRow[] = [];
    const runStateDir = path.join(workspaceRoot, '.cs-qa', 'run-state');
    if (!fs.existsSync(runStateDir)) return { rows, totals: { total: 0, covered: 0, coveragePercent: 100 } };
    let checkpoints: Array<{ storyId: number; acs: Array<{ index: number; text: string }> }>;
    try {
        checkpoints = fs.readdirSync(runStateDir)
            .filter((f) => /^story-\d+-acs\.json$/.test(f))
            .map((f) => {
                try { return JSON.parse(fs.readFileSync(path.join(runStateDir, f), 'utf-8')) as { storyId: number; acs: Array<{ index: number; text: string }> }; }
                catch { return null; }
            })
            .filter((c): c is { storyId: number; acs: Array<{ index: number; text: string }> } => !!c && Array.isArray(c.acs));
    } catch { checkpoints = []; }

    // Build a map of storyId → set of ac indices found in features (tag @ac<n>
    // or @storyXXX-ac<n>), plus scenario name for context.
    const perStoryAc = new Map<number, Map<number, string[]>>();
    const AC_TAG_RE = /@ac(\d+)/gi;
    for (const feat of arts.features) {
        const content = feat.content;
        const lines = content.split(/\r?\n/);
        // Detect story id from feature tag @storyXXX / feature name / directory hint.
        let storyIdFromFile: number | undefined;
        const featStoryMatch = /@story(\d+)/i.exec(content);
        if (featStoryMatch) storyIdFromFile = Number(featStoryMatch[1]);
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            AC_TAG_RE.lastIndex = 0;
            const acMatches = Array.from(line.matchAll(AC_TAG_RE));
            if (acMatches.length === 0) continue;
            let scenName = '';
            for (let j = i + 1; j < Math.min(lines.length, i + 10); j++) {
                const sm = /^\s*Scenario(?:\s+Outline)?\s*:\s*(.+)$/.exec(lines[j]);
                if (sm) { scenName = sm[1].trim(); break; }
            }
            for (const m of acMatches) {
                const idx = Number(m[1]);
                // Attribute to whichever story has that AC — if only one ck matches, use it.
                const matchingStories = storyIdFromFile
                    ? [storyIdFromFile]
                    : checkpoints.filter((c) => c.acs.some((a) => a.index === idx)).map((c) => c.storyId);
                for (const sid of matchingStories) {
                    const map = perStoryAc.get(sid) || new Map<number, string[]>();
                    const arr = map.get(idx) || [];
                    if (scenName) arr.push(scenName);
                    map.set(idx, arr);
                    perStoryAc.set(sid, map);
                }
            }
        }
    }
    let covered = 0;
    for (const ck of checkpoints) {
        const map = perStoryAc.get(ck.storyId) || new Map<number, string[]>();
        for (const ac of ck.acs) {
            const scenarios = map.get(ac.index) || [];
            const isCovered = scenarios.length > 0;
            if (isCovered) covered++;
            rows.push({ storyId: ck.storyId, acIndex: ac.index, text: ac.text, scenarios, covered: isCovered });
        }
    }
    return { rows, totals: { total: rows.length, covered, coveragePercent: rows.length === 0 ? 100 : Math.round((covered / rows.length) * 100) } };
}

function rollupByStory(workspaceRoot: string, arts: TestArtifacts): { rows: StoryRollupRow[]; totals: { totalStories: number } } {
    const rows: StoryRollupRow[] = [];
    const runStateDir = path.join(workspaceRoot, '.cs-qa', 'run-state');
    let checkpoints: Array<{ storyId: number; acs?: Array<unknown> }> = [];
    if (fs.existsSync(runStateDir)) {
        try {
            checkpoints = fs.readdirSync(runStateDir)
                .filter((f) => /^story-\d+-acs\.json$/.test(f))
                .map((f) => {
                    try { return JSON.parse(fs.readFileSync(path.join(runStateDir, f), 'utf-8')) as { storyId: number; acs?: unknown[] }; }
                    catch { return null; }
                })
                .filter((c): c is { storyId: number; acs?: unknown[] } => !!c && Number.isFinite(c.storyId));
        } catch { /* ignore */ }
    }
    const STORY_TAG_RE = /@story(\d+)/gi;
    const TC_TAG_RE = /@(?:tc|testcase)(\d+)/gi;
    const AC_TAG_RE = /@ac(\d+)/gi;
    const perStory = new Map<number, { tcs: Set<string>; scenarios: Set<string>; features: Set<string>; acs: Set<number> }>();
    for (const feat of arts.features) {
        const content = feat.content;
        STORY_TAG_RE.lastIndex = 0;
        const storyMatches = Array.from(content.matchAll(STORY_TAG_RE));
        const storyIds = new Set(storyMatches.map((m) => Number(m[1])));
        if (storyIds.size === 0) continue;
        const scenNames = feat.scenarioNames;
        TC_TAG_RE.lastIndex = 0; AC_TAG_RE.lastIndex = 0;
        const tcs = Array.from(content.matchAll(TC_TAG_RE)).map((m) => `TC${m[1]}`);
        const acs = Array.from(content.matchAll(AC_TAG_RE)).map((m) => Number(m[1]));
        for (const sid of storyIds) {
            const rec = perStory.get(sid) || { tcs: new Set<string>(), scenarios: new Set<string>(), features: new Set<string>(), acs: new Set<number>() };
            for (const t of tcs) rec.tcs.add(t);
            for (const s of scenNames) rec.scenarios.add(s);
            rec.features.add(path.basename(feat.absPath));
            for (const a of acs) rec.acs.add(a);
            perStory.set(sid, rec);
        }
    }
    // Merge in stories that have checkpoint but no feature tag (uncovered story).
    for (const ck of checkpoints) {
        if (!perStory.has(ck.storyId)) perStory.set(ck.storyId, { tcs: new Set(), scenarios: new Set(), features: new Set(), acs: new Set() });
    }
    for (const [sid, rec] of perStory.entries()) {
        const ck = checkpoints.find((c) => c.storyId === sid);
        const totalAcs = ck && Array.isArray(ck.acs) ? ck.acs.length : rec.acs.size;
        rows.push({
            storyId: sid,
            testCaseIds: Array.from(rec.tcs).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
            scenarios: Array.from(rec.scenarios),
            features: Array.from(rec.features),
            totalAcs,
            coveredAcs: rec.acs.size,
        });
    }
    rows.sort((a, b) => a.storyId - b.storyId);
    return { rows, totals: { totalStories: rows.length } };
}

// Explicit re-export so the compiler emits this file's registrations.
export { CoverageSchema };
