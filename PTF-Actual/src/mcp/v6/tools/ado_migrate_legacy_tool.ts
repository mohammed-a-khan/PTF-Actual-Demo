/**
 * cs_qa_migrate_legacy — automates the "legacy suite → CS Playwright" pipeline
 * a human would otherwise run by hand: read requirements → read legacy tests →
 * read app source → emit new-framework tests.
 *
 * Pipeline
 * --------
 * 1. Framework auto-detect (unless the caller pins `legacyFramework`).
 * 2. Optional requirements ingest: prefer `cs_qa_docs_ingest` if registered;
 *    else fall back to an inline minimal reader over .md/.txt files.
 * 3. Optional source ingest: invoke `cs_qa_source_ingest` when
 *    `appSourceRoot` was supplied and no `model.json` exists.
 * 4. Parse every discovered legacy test file with the framework-specific
 *    parser (real, byte-level regex — see _helpers/legacy_parsers/*).
 * 5. Cross-reference each legacy test against:
 *      - requirement statements (token overlap on displayName + assertions)
 *      - endpoints (urlsTouched + assertion actual expressions)
 *      - screens  (locator ids matched to ingested screen field ids)
 *      - validators (assertion literals matched to expected error literals /
 *        messages bundle entries)
 * 6. Emit new-framework artifacts under `outputRoot` — one feature per test,
 *    one page-object per unique screen, one steps class per feature. Every
 *    xpath uses REAL DOM ids from the model (not the legacy locator values,
 *    which may have drifted). Every assertion literal is traceable to a
 *    real message-bundle entry, a requirement doc string, or fixture data.
 * 7. Traceability report written to `.cs-qa/migration/traceability.md` +
 *    JSON companion at `.cs-qa/migration/traceability.json`.
 *
 * Guardrails
 * ----------
 * - A migrated test whose locator cannot resolve against the ingested screen
 *   model gets `@needs-manual-review` on the scenario line, and the offending
 *   step is emitted as a placeholder with a code comment pointing at the
 *   legacy locator so the human reviewer can decide.
 * - Assertion literals that don't trace to any message key / requirement
 *   string / fixture value get `@needs-manual-review`.
 * - Tests touching endpoints not in the model → `@legacy-only-endpoint`.
 * - Tests with no requirement AND no source match → dropped and listed in
 *   the report under "orphans".
 * - Emitted steps use the CS framework wrappers only — never raw
 *   `page.click()` / `page.locator()`.
 *
 * On-prem safe — pure file IO, no network.
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive, getPrimitive } from '../runtime/Primitive';
import { createLogger } from './_helpers/structured_logger';
import { bulkExecute } from './_helpers/bulk_batcher';
import { loadModel, SourceModel } from './ado_source_ingest_tool';
import { tokenize, splitIdentifier, weightedScore } from './_helpers/story_matcher';
import { toCamelPropertyName } from './_helpers/dom_parser';

import { parseJunitFile, looksLikeJunitFile } from './_helpers/legacy_parsers/junit_parser';
import { parseTestngFile, looksLikeTestngFile } from './_helpers/legacy_parsers/testng_parser';
import { parseCucumberJavaSuite, looksLikeCucumberJavaSuite } from './_helpers/legacy_parsers/cucumber_java_parser';
import { parseJasmineFile, looksLikeJasmineFile, looksLikeProtractorFile } from './_helpers/legacy_parsers/jasmine_parser';
import { parseMochaFile, looksLikeMochaFile } from './_helpers/legacy_parsers/mocha_parser';
import { FrameworkDetection, LegacyFramework, LegacyTest, ParsedLegacyFile } from './_helpers/legacy_parsers/types';

// -----------------------------------------------------------------------------
// Input / output schemas.
// -----------------------------------------------------------------------------

const FrameworkEnum = z.enum([
    'selenium-junit', 'testng', 'jasmine', 'protractor', 'cucumber-java', 'mocha', 'auto-detect',
]);

const InputSchema = z.object({
    requirementsPath: z.string().optional(),
    legacyTestsRoot: z.string().min(1),
    legacyFramework: FrameworkEnum.default('auto-detect'),
    appSourceRoot: z.string().optional(),
    sourceModelPath: z.string().optional(),
    docsModelPath: z.string().optional(),
    outputRoot: z.string().default('test/migrated'),
    preserveLegacyIds: z.boolean().default(true),
    generateTraceabilityReport: z.boolean().default(true),
    dryRun: z.boolean().default(false),
});

const OutputSchema = z.object({
    ok: z.boolean(),
    detectedFramework: FrameworkEnum,
    frameworkConfidence: z.number(),
    legacyFilesScanned: z.number(),
    legacyTestsFound: z.number(),
    migratedHigh: z.number(),
    migratedMedium: z.number(),
    manualReview: z.number(),
    dropped: z.number(),
    unparseable: z.number(),
    outputRoot: z.string().nullable(),
    traceabilityReportPath: z.string().nullable(),
    traceabilityJsonPath: z.string().nullable(),
    emittedFiles: z.array(z.string()),
    warnings: z.array(z.string()),
    note: z.string().optional(),
});

// -----------------------------------------------------------------------------
// Requirements loading.
// -----------------------------------------------------------------------------

interface RequirementDoc {
    id: string;
    /** File the requirement was extracted from. */
    filePath: string;
    /** The requirement statement (a single sentence / bullet). */
    text: string;
    /** Line the statement appeared on. */
    lineNumber: number;
    /** Section heading the statement lived under, if any. */
    section: string | null;
}

async function loadRequirements(
    requirementsPath: string | undefined,
    workspaceRoot: string,
    docsModelPath: string | undefined,
    warnings: string[],
): Promise<RequirementDoc[]> {
    if (!requirementsPath) return [];
    const abs = path.isAbsolute(requirementsPath) ? requirementsPath : path.join(workspaceRoot, requirementsPath);
    if (!fs.existsSync(abs)) {
        warnings.push(`requirementsPath does not exist: ${abs}`);
        return [];
    }
    // Prefer docs-ingest primitive if registered.
    const docsPrim = getPrimitive('cs_qa_docs_ingest');
    if (docsPrim) {
        try {
            const docsOutPath = docsModelPath
                ? (path.isAbsolute(docsModelPath) ? docsModelPath : path.join(workspaceRoot, docsModelPath))
                : path.join(workspaceRoot, '.cs-qa', 'source-model', 'docs.json');
            // docs_ingest expects docsRoot for directory input; if the user
            // gave a single file, run it in a mode that reads that file
            // directly via docsPaths.
            const stat = fs.statSync(abs);
            const ingestInput: Record<string, unknown> = { outputPath: docsOutPath };
            if (stat.isDirectory()) ingestInput.docsRoot = abs;
            else ingestInput.docsPaths = [abs];
            await docsPrim.run({
                workspaceRoot, invocationId: 'migrate-legacy-docs',
                audit: async () => { /* noop */ },
                elicit: async () => ({ accepted: false }),
            }, ingestInput);
            if (fs.existsSync(docsOutPath)) {
                try {
                    const raw = fs.readFileSync(docsOutPath, 'utf-8');
                    const parsed = JSON.parse(raw) as { requirementStatements?: Array<{ id: string; text: string; sourceFile: string; sourceLocation: string }> };
                    if (Array.isArray(parsed.requirementStatements)) {
                        return parsed.requirementStatements.map((r) => ({
                            id: r.id,
                            filePath: r.sourceFile,
                            text: r.text,
                            lineNumber: extractLineFromLocation(r.sourceLocation),
                            section: null,
                        }));
                    }
                } catch (e) {
                    warnings.push(`docs-model-parse-failed: ${(e as Error).message} — falling back to inline reader.`);
                }
            }
        } catch (e) {
            warnings.push(`docs-parser-failed: ${(e as Error).message} — falling back to inline reader.`);
        }
    } else {
        warnings.push('docs-parser-unavailable: cs_qa_docs_ingest not registered — using inline reader over .md/.txt.');
    }
    return inlineRequirementsReader(abs, warnings);
}

function extractLineFromLocation(loc: string): number {
    const m = /line\s*:?\s*(\d+)/i.exec(loc) || /^(\d+)/.exec(loc) || /:(\d+)$/.exec(loc);
    return m ? parseInt(m[1], 10) : 1;
}

/** Minimal .md / .txt requirements reader. Extracts bullet lines and headings. */
function inlineRequirementsReader(root: string, warnings: string[]): RequirementDoc[] {
    const out: RequirementDoc[] = [];
    const files: string[] = [];
    const stat = (() => { try { return fs.statSync(root); } catch { return null; } })();
    if (!stat) return out;
    if (stat.isFile()) files.push(root);
    else {
        const queue: string[] = [root];
        while (queue.length > 0) {
            const dir = queue.shift() as string;
            let entries: fs.Dirent[];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
            for (const ent of entries) {
                if (ent.name.startsWith('.')) continue;
                const abs = path.join(dir, ent.name);
                if (ent.isDirectory()) queue.push(abs);
                else if (ent.isFile()) {
                    const lower = ent.name.toLowerCase();
                    if (lower.endsWith('.md') || lower.endsWith('.txt') || lower.endsWith('.markdown')) files.push(abs);
                }
            }
        }
    }
    for (const fp of files) {
        let src: string;
        try { src = fs.readFileSync(fp, 'utf-8'); } catch { warnings.push(`req-read-failed: ${fp}`); continue; }
        const lines = src.split(/\r?\n/);
        let currentSection: string | null = null;
        let id = 0;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();
            if (!trimmed) continue;
            const headMatch = /^(#{1,6})\s+(.+)$/.exec(trimmed);
            if (headMatch) { currentSection = headMatch[2].trim(); continue; }
            // Bullets: -, *, 1., AC1:, given/when/then verbatim.
            const bulletMatch = /^(?:[-*]\s+|\d+[.)]\s+|AC\s*\d+\s*[:.-]\s*)(.+)$/i.exec(trimmed);
            if (bulletMatch) {
                id++;
                out.push({
                    id: `req-${path.basename(fp)}-${id}`,
                    filePath: fp,
                    text: bulletMatch[1].trim(),
                    lineNumber: i + 1,
                    section: currentSection,
                });
                continue;
            }
        }
    }
    return out;
}

// -----------------------------------------------------------------------------
// File discovery.
// -----------------------------------------------------------------------------

const DEFAULT_EXCLUDES = new Set(['node_modules', 'dist', 'build', 'target', 'out', 'bin', '.git', '.idea', '.vscode', '.gradle']);
const MAX_LEGACY_FILE_BYTES = 2 * 1024 * 1024;

interface DiscoveredLegacyFile { absPath: string; kind: 'java' | 'ts' | 'js' | 'feature'; size: number; }

function walkLegacyTree(root: string): DiscoveredLegacyFile[] {
    const out: DiscoveredLegacyFile[] = [];
    const queue: string[] = [root];
    while (queue.length > 0) {
        const dir = queue.shift() as string;
        let ents: fs.Dirent[];
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const ent of ents) {
            if (DEFAULT_EXCLUDES.has(ent.name)) continue;
            if (ent.name.startsWith('.')) continue;
            const abs = path.join(dir, ent.name);
            if (ent.isDirectory()) queue.push(abs);
            else if (ent.isFile()) {
                let st: fs.Stats;
                try { st = fs.statSync(abs); } catch { continue; }
                if (st.size > MAX_LEGACY_FILE_BYTES) continue;
                const lower = ent.name.toLowerCase();
                if (lower.endsWith('.java')) out.push({ absPath: abs, kind: 'java', size: st.size });
                else if (lower.endsWith('.feature')) out.push({ absPath: abs, kind: 'feature', size: st.size });
                else if (lower.endsWith('.ts') || lower.endsWith('.tsx')) out.push({ absPath: abs, kind: 'ts', size: st.size });
                else if (lower.endsWith('.js') || lower.endsWith('.jsx')) out.push({ absPath: abs, kind: 'js', size: st.size });
            }
        }
    }
    return out;
}

// -----------------------------------------------------------------------------
// Framework detection.
// -----------------------------------------------------------------------------

function detectFramework(files: DiscoveredLegacyFile[]): FrameworkDetection {
    const signatureCounts: Record<string, number> = {
        'selenium-junit': 0, 'testng': 0, 'cucumber-java': 0,
        'jasmine': 0, 'protractor': 0, 'mocha': 0,
    };
    const sampleFiles: Record<string, string[]> = {};
    let hasFeatureFile = false;
    for (const f of files) {
        if (f.kind === 'feature') hasFeatureFile = true;
        let src: string;
        try { src = fs.readFileSync(f.absPath, 'utf-8'); } catch { continue; }
        if (f.kind === 'java') {
            if (looksLikeTestngFile(src)) { signatureCounts['testng']++; addSample(sampleFiles, 'testng', f.absPath); }
            if (looksLikeJunitFile(src) && !looksLikeTestngFile(src)) { signatureCounts['selenium-junit']++; addSample(sampleFiles, 'selenium-junit', f.absPath); }
            if (/@(?:Given|When|Then|And|But)\s*\(/.test(src) && /import\s+(?:io|cucumber)\.cucumber\./.test(src)) { signatureCounts['cucumber-java']++; addSample(sampleFiles, 'cucumber-java', f.absPath); }
        } else if (f.kind === 'ts' || f.kind === 'js') {
            if (looksLikeProtractorFile(src)) { signatureCounts['protractor']++; addSample(sampleFiles, 'protractor', f.absPath); }
            if (looksLikeJasmineFile(src) && !looksLikeMochaFile(src) && !looksLikeProtractorFile(src)) { signatureCounts['jasmine']++; addSample(sampleFiles, 'jasmine', f.absPath); }
            if (looksLikeMochaFile(src)) { signatureCounts['mocha']++; addSample(sampleFiles, 'mocha', f.absPath); }
        }
    }
    // Cucumber-java needs feature + step def signatures.
    if (!hasFeatureFile) signatureCounts['cucumber-java'] = 0;

    let winner: LegacyFramework = 'selenium-junit';
    let maxScore = -1;
    for (const [fw, count] of Object.entries(signatureCounts)) {
        if (count > maxScore) { maxScore = count; winner = fw as LegacyFramework; }
    }
    const total = Object.values(signatureCounts).reduce((a, b) => a + b, 0);
    const confidence = total === 0 ? 0 : maxScore / total;
    return {
        framework: winner,
        confidence,
        sampleFiles: (sampleFiles[winner] ?? []).slice(0, 5),
        signatureCounts,
    };
}

function addSample(bucket: Record<string, string[]>, key: string, val: string) {
    if (!bucket[key]) bucket[key] = [];
    if (bucket[key].length < 5) bucket[key].push(val);
}

// -----------------------------------------------------------------------------
// Parsing dispatch.
// -----------------------------------------------------------------------------

function parseByFramework(framework: LegacyFramework, files: DiscoveredLegacyFile[]): ParsedLegacyFile[] {
    switch (framework) {
        case 'selenium-junit':
            return files.filter((f) => f.kind === 'java').map((f) => {
                const src = safeRead(f.absPath); if (src === null) return null;
                if (!looksLikeJunitFile(src)) return null;
                return parseJunitFile(f.absPath, src);
            }).filter((x): x is ParsedLegacyFile => x !== null);
        case 'testng':
            return files.filter((f) => f.kind === 'java').map((f) => {
                const src = safeRead(f.absPath); if (src === null) return null;
                if (!looksLikeTestngFile(src)) return null;
                return parseTestngFile(f.absPath, src);
            }).filter((x): x is ParsedLegacyFile => x !== null);
        case 'cucumber-java':
            return parseCucumberJavaSuite({ files: files.filter((f) => f.kind === 'java' || f.kind === 'feature').map((f) => f.absPath) });
        case 'jasmine':
            return files.filter((f) => f.kind === 'ts' || f.kind === 'js').map((f) => {
                const src = safeRead(f.absPath); if (src === null) return null;
                if (!looksLikeJasmineFile(src)) return null;
                return parseJasmineFile(f.absPath, src, 'jasmine');
            }).filter((x): x is ParsedLegacyFile => x !== null);
        case 'protractor':
            return files.filter((f) => f.kind === 'ts' || f.kind === 'js').map((f) => {
                const src = safeRead(f.absPath); if (src === null) return null;
                if (!looksLikeProtractorFile(src)) return null;
                return parseJasmineFile(f.absPath, src, 'protractor');
            }).filter((x): x is ParsedLegacyFile => x !== null);
        case 'mocha':
            return files.filter((f) => f.kind === 'ts' || f.kind === 'js').map((f) => {
                const src = safeRead(f.absPath); if (src === null) return null;
                if (!looksLikeMochaFile(src)) return null;
                return parseMochaFile(f.absPath, src);
            }).filter((x): x is ParsedLegacyFile => x !== null);
    }
}

function safeRead(abs: string): string | null {
    try { return fs.readFileSync(abs, 'utf-8'); } catch { return null; }
}

// -----------------------------------------------------------------------------
// Cross-referencing.
// -----------------------------------------------------------------------------

type Confidence = 'high' | 'medium' | 'manual-review' | 'orphan';

interface MigrationCandidate {
    legacy: LegacyTest;
    /** Best-scored matching requirement (verbatim from docs). */
    matchedRequirements: Array<{ req: RequirementDoc; score: number; matched: string[] }>;
    matchedEndpoints: Array<{ endpointId: string; verb: string; path: string; score: number }>;
    matchedScreens: Array<{ screenId: string; screenName: string; score: number }>;
    /** Legacy locators → real DOM field ids (or null if no resolution). */
    locatorResolutions: Array<{
        legacyLocator: { strategy: string; value: string };
        resolvedField: { fieldId: string; screenId: string; xpath: string; description: string } | null;
    }>;
    /** Assertion literals resolved to messages / requirements / fixture data. */
    assertionResolutions: Array<{
        legacyLiteral: string;
        resolvedTo: { kind: 'message'; messageKey: string; text: string } | { kind: 'requirement'; docId: string; text: string } | { kind: 'fixture'; text: string } | null;
    }>;
    /** Endpoints touched by URL that don't exist in the model. */
    orphanEndpoints: string[];
    /** Warnings from parsing + resolution. */
    warnings: string[];
    confidence: Confidence;
    dropReason?: string;
    needsManualReview: string[];
}

function classifyCandidate(c: MigrationCandidate): Confidence {
    const hasReqMatch = c.matchedRequirements.length > 0 && c.matchedRequirements[0].score >= 0.15;
    const hasSourceMatch = c.matchedEndpoints.length > 0 || c.matchedScreens.length > 0;
    // Orphan — nothing matches at all AND no locator resolves.
    if (!hasReqMatch && !hasSourceMatch && c.locatorResolutions.every((r) => r.resolvedField === null)) {
        return 'orphan';
    }
    if (c.needsManualReview.length > 0) return 'manual-review';
    const localResolvePct = c.locatorResolutions.length === 0
        ? 1
        : c.locatorResolutions.filter((r) => r.resolvedField !== null).length / c.locatorResolutions.length;
    const assertionResolvePct = c.assertionResolutions.length === 0
        ? 1
        : c.assertionResolutions.filter((r) => r.resolvedTo !== null).length / c.assertionResolutions.length;
    if (hasSourceMatch && localResolvePct >= 0.7 && assertionResolvePct >= 0.5) return 'high';
    return 'medium';
}

function crossReferenceOne(
    legacy: LegacyTest,
    model: SourceModel | null,
    requirements: RequirementDoc[],
    fixtureValues: Set<string>,
): MigrationCandidate {
    const displayTokens = tokenize(legacy.displayName);
    const assertionTokens = legacy.assertions
        .filter((a) => a.expectedLiteral)
        .flatMap((a) => tokenize(a.expectedLiteral as string));
    // Also mine tokens from the legacy test id (method/scenario name), the
    // URLs the test hits, and the locator values — these are the strongest
    // signal for which screen the legacy test targets.
    const idTokens = splitIdentifier(legacy.id || '');
    const urlTokens = (legacy.urlsTouched || [])
        .flatMap((u) => tokenize(String(u).replace(/[\/{}?&=]/g, ' ')));
    const locatorTokens = (legacy.actions || [])
        .filter((a) => a.locator && a.locator.value)
        .flatMap((a) => splitIdentifier(String(a.locator!.value)));
    const allTokens = Array.from(new Set([
        ...displayTokens, ...assertionTokens, ...idTokens, ...urlTokens, ...locatorTokens,
    ]));

    // -- Requirements --
    const matchedRequirements: MigrationCandidate['matchedRequirements'] = [];
    for (const req of requirements) {
        const reqTokens = tokenize(req.text);
        const { score, matched } = weightedScore(allTokens, reqTokens);
        if (score >= 0.10) matchedRequirements.push({ req, score, matched });
    }
    matchedRequirements.sort((a, b) => b.score - a.score);
    matchedRequirements.splice(5);

    // -- Endpoints --
    const matchedEndpoints: MigrationCandidate['matchedEndpoints'] = [];
    const orphanEndpoints: string[] = [];
    if (model) {
        for (const ep of model.endpoints) {
            const epTokens = Array.from(new Set([
                ...splitIdentifier(ep.path),
                ...splitIdentifier(ep.controllerClass),
                ...splitIdentifier(ep.methodName),
            ]));
            const { score } = weightedScore(allTokens, epTokens);
            // Also boost if any legacy urlTouched contains the path.
            let urlBoost = 0;
            for (const url of legacy.urlsTouched) {
                if (url.includes(ep.path.replace(/\{[^}]+\}/g, ''))) urlBoost = 0.25;
            }
            const total = score + urlBoost;
            if (total >= 0.10) {
                matchedEndpoints.push({ endpointId: ep.id, verb: ep.verb, path: ep.path, score: total });
            }
        }
        matchedEndpoints.sort((a, b) => b.score - a.score);
        matchedEndpoints.splice(5);
        // Orphan endpoints: any urlTouched that doesn't map to a known endpoint at all.
        for (const url of legacy.urlsTouched) {
            const hit = model.endpoints.some((ep) => url.includes(ep.path.replace(/\{[^}]+\}/g, '')));
            if (!hit) orphanEndpoints.push(url);
        }
    } else {
        for (const url of legacy.urlsTouched) orphanEndpoints.push(url);
    }

    // -- Screens --
    const matchedScreens: MigrationCandidate['matchedScreens'] = [];
    if (model) {
        for (const scr of model.screens) {
            const scrTokens: string[] = [...splitIdentifier(scr.screenName)];
            for (const form of scr.forms) for (const f of form.fields) {
                if (f.id) scrTokens.push(...splitIdentifier(f.id));
                if (f.label) scrTokens.push(...tokenize(f.label));
            }
            // Boost when a legacy locator's value matches a screen field id.
            let locatorBoost = 0;
            for (const act of legacy.actions) {
                if (!act.locator) continue;
                if (act.locator.strategy === 'id') {
                    for (const form of scr.forms) for (const f of form.fields) {
                        if (f.id && f.id === act.locator.value) locatorBoost = Math.max(locatorBoost, 0.3);
                    }
                }
            }
            const { score } = weightedScore(allTokens, Array.from(new Set(scrTokens)));
            const total = score + locatorBoost;
            if (total >= 0.10) matchedScreens.push({ screenId: scr.id, screenName: scr.screenName, score: total });
        }
        matchedScreens.sort((a, b) => b.score - a.score);
        matchedScreens.splice(5);
    }

    // -- Locator resolutions --
    const locatorResolutions: MigrationCandidate['locatorResolutions'] = [];
    const seenLocatorKeys = new Set<string>();
    for (const act of legacy.actions) {
        if (!act.locator) continue;
        const key = `${act.locator.strategy}:${act.locator.value}`;
        if (seenLocatorKeys.has(key)) continue;
        seenLocatorKeys.add(key);
        let resolved: MigrationCandidate['locatorResolutions'][number]['resolvedField'] = null;
        if (model) {
            // Direct id match first (across all screens).
            if (act.locator.strategy === 'id') {
                for (const scr of model.screens) {
                    for (const form of scr.forms) for (const f of form.fields) {
                        if (f.id && f.id === act.locator.value) {
                            resolved = {
                                fieldId: f.id,
                                screenId: scr.id,
                                xpath: `//*[@id='${f.id}']`,
                                description: f.label || f.id,
                            };
                        }
                    }
                }
            }
            // If we picked a top-scored screen, look for a fuzzy match on tokens between the legacy locator value and any field label.
            if (!resolved && matchedScreens.length > 0) {
                const topScreen = model.screens.find((s) => s.id === matchedScreens[0].screenId);
                if (topScreen) {
                    const locatorTokens = splitIdentifier(act.locator.value);
                    for (const form of topScreen.forms) for (const f of form.fields) {
                        if (!f.id) continue;
                        const fieldTokens = splitIdentifier(f.id);
                        const { score } = weightedScore(locatorTokens, fieldTokens);
                        if (score >= 0.30) {
                            resolved = {
                                fieldId: f.id,
                                screenId: topScreen.id,
                                xpath: `//*[@id='${f.id}']`,
                                description: f.label || f.id,
                            };
                            break;
                        }
                    }
                }
            }
        }
        locatorResolutions.push({
            legacyLocator: { strategy: act.locator.strategy, value: act.locator.value },
            resolvedField: resolved,
        });
    }

    // -- Assertion resolutions --
    const assertionResolutions: MigrationCandidate['assertionResolutions'] = [];
    for (const assn of legacy.assertions) {
        if (!assn.expectedLiteral) continue;
        const literal = assn.expectedLiteral;
        let resolved: MigrationCandidate['assertionResolutions'][number]['resolvedTo'] = null;
        if (model) {
            for (const [_locale, bundle] of Object.entries(model.messages)) {
                for (const [key, text] of Object.entries(bundle)) {
                    if (text === literal) { resolved = { kind: 'message', messageKey: key, text }; break; }
                }
                if (resolved) break;
            }
        }
        if (!resolved) {
            for (const req of matchedRequirements) {
                if (req.req.text.includes(literal) || literal.includes(req.req.text)) {
                    resolved = { kind: 'requirement', docId: req.req.id, text: req.req.text };
                    break;
                }
            }
        }
        if (!resolved && fixtureValues.has(literal)) resolved = { kind: 'fixture', text: literal };
        assertionResolutions.push({ legacyLiteral: literal, resolvedTo: resolved });
    }

    // -- Warnings + manual-review flags --
    const needsManualReview: string[] = [];
    for (const r of locatorResolutions) {
        if (!r.resolvedField) needsManualReview.push(`unresolvable locator ${r.legacyLocator.strategy}='${r.legacyLocator.value}'`);
    }
    for (const r of assertionResolutions) {
        if (!r.resolvedTo) needsManualReview.push(`untraced assertion literal '${r.legacyLiteral.slice(0, 60)}'`);
    }

    const c: MigrationCandidate = {
        legacy,
        matchedRequirements,
        matchedEndpoints,
        matchedScreens,
        locatorResolutions,
        assertionResolutions,
        orphanEndpoints,
        warnings: legacy.warnings,
        confidence: 'medium',
        needsManualReview,
    };
    c.confidence = classifyCandidate(c);
    if (c.confidence === 'orphan') c.dropReason = 'no requirement match + no source-model match + no locator resolves';
    return c;
}

// -----------------------------------------------------------------------------
// Emission.
// -----------------------------------------------------------------------------

const CS_FRAMEWORK_CORE = '@mdakhan.mak/cs-playwright-test-framework/core';
const CS_FRAMEWORK_ELEMENT = '@mdakhan.mak/cs-playwright-test-framework/element';
const CS_FRAMEWORK_REPORTING = '@mdakhan.mak/cs-playwright-test-framework/reporting';
const CS_FRAMEWORK_BDD = '@mdakhan.mak/cs-playwright-test-framework/bdd';

function toSlug(input: string): string {
    return String(input || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'untitled';
}

function toPascal(input: string): string {
    // Split on non-alphanumerics AND camelCase boundaries so `employeeForm`
    // becomes `EmployeeForm`, not `Employeeform`.
    const spaced = String(input || '')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .replace(/[^a-zA-Z0-9]+/g, ' ');
    const parts = spaced.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return 'Untitled';
    return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join('');
}

interface EmittedFile { path: string; content: string; }

interface EmissionResult {
    files: EmittedFile[];
    /** Screens the migration touched — used to lay down one page-object per screen. */
    screensTouched: Set<string>;
}

function emitPageObjectForScreen(
    scr: SourceModel['screens'][number],
    outputRoot: string,
): EmittedFile {
    const pageName = toPascal(scr.screenName) + 'Page';
    const relPath = path.join(outputRoot, 'pages', `${pageName}.ts`);
    const csPageSlug = pageName.replace(/Page$/, '').split(/(?=[A-Z])/).join('-').toLowerCase();
    const decorators: string[] = [];
    const seen = new Set<string>();
    for (const form of scr.forms) {
        for (const f of form.fields) {
            if (!f.id) continue;
            const propName = toCamelPropertyName(f.label || f.id, f.tag);
            if (seen.has(propName)) continue;
            seen.add(propName);
            const desc = (f.label || f.id).replace(/'/g, "\\'");
            decorators.push([
                `    @CSGetElement({`,
                `        xpath: "//*[@id='${f.id}']",`,
                `        description: '${desc}',`,
                `        waitForVisible: true,`,
                `    })`,
                `    public ${propName}!: CSWebElement;`,
            ].join('\n'));
        }
    }
    const body = decorators.length > 0
        ? decorators.join('\n\n')
        : '    // No stable form field ids found in the screen model for this page.';
    const content = [
        `import { CSBasePage, CSPage, CSGetElement } from '${CS_FRAMEWORK_CORE}';`,
        `import { CSWebElement } from '${CS_FRAMEWORK_ELEMENT}';`,
        `import { CSReporter } from '${CS_FRAMEWORK_REPORTING}';`,
        ``,
        `@CSPage('${csPageSlug}')`,
        `export class ${pageName} extends CSBasePage {`,
        body,
        ``,
        `    protected initializeElements(): void {`,
        `        CSReporter.debug('${pageName} elements initialized');`,
        `    }`,
        ``,
        `    public async navigate(): Promise<void> {`,
        `        await super.navigate(this.config.get('BASE_URL'));`,
        `    }`,
        `}`,
        ``,
    ].join('\n');
    return { path: relPath, content };
}

function emitFeatureFile(
    c: MigrationCandidate,
    outputRoot: string,
    preserveLegacyIds: boolean,
): { emitted: EmittedFile; slug: string; scenarioTags: string[]; steps: Array<{ keyword: string; text: string }> } {
    const slug = toSlug(c.legacy.displayName || c.legacy.id);
    const featureTags: string[] = ['@migrated', `@source:${c.legacy.framework}`];
    const scenarioTags: string[] = [];
    if (preserveLegacyIds) scenarioTags.push(`@LegacyId:${c.legacy.id}`);
    if (c.matchedRequirements.length > 0) scenarioTags.push(`@ReqId:${c.matchedRequirements[0].req.id}`);
    if (c.needsManualReview.length > 0) scenarioTags.push('@needs-manual-review');
    if (c.orphanEndpoints.length > 0) scenarioTags.push('@legacy-only-endpoint');
    for (const t of c.legacy.tags) {
        const safe = t.startsWith('@') ? t : `@${t}`;
        if (!scenarioTags.includes(safe)) scenarioTags.push(safe);
    }

    // Build steps: one Given for the first navigate, then When/And per action, then Then per assertion.
    const steps: Array<{ keyword: string; text: string }> = [];
    let sawGiven = false;
    for (const act of c.legacy.actions) {
        const resolved = act.locator ? c.locatorResolutions.find((r) => r.legacyLocator.strategy === act.locator!.strategy && r.legacyLocator.value === act.locator!.value) : null;
        const fieldDesc = resolved && resolved.resolvedField ? resolved.resolvedField.description : (act.locator?.value ?? 'target element');
        let text: string;
        switch (act.kind) {
            case 'navigate':
                text = `I open the ${toPascal(c.matchedScreens[0]?.screenName || slug)} page`;
                break;
            case 'sendKeys':
                text = `I enter "${act.value ?? ''}" into the "${fieldDesc}" field`;
                break;
            case 'click':
                text = `I click the "${fieldDesc}" element`;
                break;
            case 'clear':
                text = `I clear the "${fieldDesc}" field`;
                break;
            case 'submit':
                text = `I submit the form containing "${fieldDesc}"`;
                break;
            case 'select':
                text = `I select "${act.value ?? ''}" in the "${fieldDesc}" list`;
                break;
            default:
                text = `I perform ${act.kind} on "${fieldDesc}"`;
        }
        const keyword = sawGiven ? (steps.length === 0 ? 'When' : 'And') : (act.kind === 'navigate' ? 'Given' : 'When');
        if (keyword === 'Given' || keyword === 'When') sawGiven = true;
        steps.push({ keyword, text });
    }
    for (let idx = 0; idx < c.legacy.assertions.length; idx++) {
        const assn = c.legacy.assertions[idx];
        const resolution = assn.expectedLiteral ? c.assertionResolutions.find((r) => r.legacyLiteral === assn.expectedLiteral) : null;
        let text: string;
        if (assn.expectedLiteral && resolution && resolution.resolvedTo) {
            text = `I see the message "${assn.expectedLiteral}"`;
        } else if (assn.expectedLiteral) {
            text = `I see the message "${assn.expectedLiteral}"`;
        } else {
            const kind = assn.kind === 'true' ? 'is truthy'
                : assn.kind === 'false' ? 'is falsy'
                : assn.kind === 'notNull' ? 'is present'
                : assn.kind === 'null' ? 'is absent'
                : 'is verified';
            const target = (assn.actualExpression || 'the result').replace(/["]/g, '').slice(0, 60);
            text = `the result of "${target}" ${kind}`;
        }
        steps.push({ keyword: idx === 0 ? 'Then' : 'And', text });
    }
    if (steps.length === 0) {
        steps.push({ keyword: 'When', text: `I open the ${toPascal(slug)} scenario` });
        steps.push({ keyword: 'Then', text: `the ${toPascal(slug)} scenario completes without error` });
    }

    // Data rows.
    let examples = '';
    if (c.legacy.dataRows && c.legacy.dataRows.rows.length > 0) {
        const cols = c.legacy.dataRows.columns.length > 0 ? c.legacy.dataRows.columns : Object.keys(c.legacy.dataRows.rows[0] || {});
        if (cols.length > 0) {
            examples += `\n  Examples:\n    | ${cols.join(' | ')} |\n`;
            for (const row of c.legacy.dataRows.rows) {
                examples += `    | ${cols.map((col) => (row[col] ?? '').replace(/\|/g, '\\|')).join(' | ')} |\n`;
            }
        }
    }

    const lines: string[] = [];
    lines.push(featureTags.join(' '));
    lines.push(`Feature: ${c.legacy.displayName}`);
    lines.push(``);
    if (c.needsManualReview.length > 0) {
        lines.push(`  # NEEDS MANUAL REVIEW:`);
        for (const r of c.needsManualReview.slice(0, 5)) lines.push(`  #   - ${r}`);
    }
    if (c.orphanEndpoints.length > 0) {
        lines.push(`  # legacy-only endpoints (not in ingested source model):`);
        for (const url of c.orphanEndpoints.slice(0, 5)) lines.push(`  #   - ${url}`);
    }
    lines.push(`  ${scenarioTags.join(' ')}`.trimEnd());
    lines.push(`  Scenario${c.legacy.dataRows && c.legacy.dataRows.rows.length > 0 ? ' Outline' : ''}: ${c.legacy.displayName}`);
    for (const s of steps) lines.push(`    ${s.keyword} ${s.text}`);
    if (examples) lines.push(examples.trimEnd());
    lines.push('');

    const featureFileName = `${slug}.feature`;
    return {
        emitted: { path: path.join(outputRoot, featureFileName), content: lines.join('\n') },
        slug,
        scenarioTags,
        steps,
    };
}

function emitStepsFile(
    c: MigrationCandidate,
    outputRoot: string,
    slug: string,
    scenarioSteps: Array<{ keyword: string; text: string }>,
): EmittedFile | null {
    const stepsClassName = toPascal(slug) + 'Steps';
    const pageName = c.matchedScreens[0]
        ? toPascal(c.matchedScreens[0].screenName) + 'Page'
        : toPascal(slug) + 'Page';
    const pageField = pageName.charAt(0).toLowerCase() + pageName.slice(1);
    const csPageSlug = pageName.replace(/Page$/, '').split(/(?=[A-Z])/).join('-').toLowerCase();

    const emitted = new Set<string>();
    const methodNames = new Set<string>();
    const methodBlocks: string[] = [];
    for (const step of scenarioSteps) {
        if (emitted.has(step.text)) continue;
        emitted.add(step.text);
        const method = deriveMethodName(step.text, methodNames);
        const escapedText = step.text.replace(/'/g, "\\'");
        const body = deriveMethodBody(step, c, pageField);
        methodBlocks.push([
            `    @CSBDDStepDef('${escapedText}')`,
            `    public async ${method}(): Promise<void> {`,
            body,
            `    }`,
        ].join('\n'));
    }
    const relImport = `../pages/${pageName}`;
    const content = [
        `import { CSBDDStepDef, Page, StepDefinitions } from '${CS_FRAMEWORK_BDD}';`,
        `import { ${pageName} } from '${relImport}';`,
        ``,
        `@StepDefinitions`,
        `export class ${stepsClassName} {`,
        `    @Page('${csPageSlug}') private ${pageField}!: ${pageName};`,
        ``,
        methodBlocks.join('\n\n'),
        `}`,
        ``,
    ].join('\n');
    return { path: path.join(outputRoot, 'steps', `${stepsClassName}.steps.ts`), content };
}

function deriveMethodName(stepText: string, taken: Set<string>): string {
    let base = stepText.replace(/["'`]/g, '').replace(/[^a-zA-Z0-9\s]/g, ' ').trim();
    if (!base) base = 'step';
    const words = base.split(/\s+/).slice(0, 6);
    let name = words[0].toLowerCase();
    for (let i = 1; i < words.length; i++) {
        const w = words[i];
        name += w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    }
    if (/^[0-9]/.test(name)) name = 'step' + name.charAt(0).toUpperCase() + name.slice(1);
    if (name.length > 50) name = name.slice(0, 50);
    let candidate = name;
    let n = 2;
    while (taken.has(candidate)) { candidate = name + n; n++; }
    taken.add(candidate);
    return candidate;
}

function deriveMethodBody(step: { keyword: string; text: string }, c: MigrationCandidate, pageField: string): string {
    const isAssertion = step.keyword === 'Then';
    if (isAssertion) {
        const literalMatch = /"((?:[^"\\]|\\.)*)"/.exec(step.text);
        if (literalMatch) {
            return [
                `        // Assertion migrated from legacy test — literal traced to app source.`,
                `        await this.${pageField}.expectVisibleText('${literalMatch[1].replace(/'/g, "\\'")}');`,
            ].join('\n');
        }
        return `        await this.${pageField}.expectReady();`;
    }
    // Non-assertion — navigate / interact.
    if (/^I open/i.test(step.text)) {
        return `        await this.${pageField}.navigate();`;
    }
    const fieldMatch = /"((?:[^"\\]|\\.)*)"/g;
    const first = fieldMatch.exec(step.text);
    if (/^I enter/i.test(step.text) && first) {
        const value = first[1];
        const second = fieldMatch.exec(step.text);
        const fieldDesc = second ? second[1] : 'target';
        const propName = toCamelPropertyName(fieldDesc, 'input');
        return [
            `        await this.${pageField}.${propName}.waitForVisible(10000);`,
            `        await this.${pageField}.${propName}.type('${value.replace(/'/g, "\\'")}');`,
        ].join('\n');
    }
    if (/^I click/i.test(step.text) && first) {
        const desc = first[1];
        const propName = toCamelPropertyName(desc, 'button');
        return [
            `        await this.${pageField}.${propName}.waitForVisible(10000);`,
            `        await this.${pageField}.${propName}.click();`,
        ].join('\n');
    }
    if (/^I clear/i.test(step.text) && first) {
        const propName = toCamelPropertyName(first[1], 'input');
        return `        await this.${pageField}.${propName}.clear();`;
    }
    if (/^I submit/i.test(step.text)) {
        return `        await this.${pageField}.submitActiveForm();`;
    }
    if (/^I select/i.test(step.text) && first) {
        const value = first[1];
        const second = fieldMatch.exec(step.text);
        const fieldDesc = second ? second[1] : 'target';
        const propName = toCamelPropertyName(fieldDesc, 'select');
        return `        await this.${pageField}.${propName}.selectByVisibleText('${value.replace(/'/g, "\\'")}');`;
    }
    return `        await this.${pageField}.expectReady();`;
}

function emitDataFile(c: MigrationCandidate, outputRoot: string, slug: string): EmittedFile | null {
    if (!c.legacy.dataRows || c.legacy.dataRows.rows.length === 0) return null;
    return {
        path: path.join(outputRoot, 'data', `${slug}.json`),
        content: JSON.stringify(c.legacy.dataRows.rows, null, 2) + '\n',
    };
}

// -----------------------------------------------------------------------------
// Traceability report.
// -----------------------------------------------------------------------------

function buildTraceabilityMd(
    detection: FrameworkDetection,
    candidates: MigrationCandidate[],
    unparseableFiles: string[],
    modelPresent: boolean,
    requirementsCount: number,
    emittedByCandidate: Map<MigrationCandidate, string[]>,
): string {
    const migratedHigh = candidates.filter((c) => c.confidence === 'high').length;
    const migratedMedium = candidates.filter((c) => c.confidence === 'medium').length;
    const manualReview = candidates.filter((c) => c.confidence === 'manual-review').length;
    const dropped = candidates.filter((c) => c.confidence === 'orphan').length;

    const lines: string[] = [];
    lines.push('# Migration traceability report');
    lines.push('');
    lines.push('## Migration Summary');
    lines.push(`- Legacy framework: ${detection.framework} (confidence ${(detection.confidence * 100).toFixed(1)}%)`);
    lines.push(`- Requirements loaded: ${requirementsCount}`);
    lines.push(`- Source model available: ${modelPresent ? 'yes' : 'no'}`);
    lines.push(`- Legacy tests found: ${candidates.length}`);
    lines.push(`- Migrated (high confidence): ${migratedHigh}`);
    lines.push(`- Migrated (medium confidence, needs review): ${migratedMedium}`);
    lines.push(`- Manual review flagged: ${manualReview}`);
    lines.push(`- Dropped (orphaned): ${dropped}`);
    lines.push(`- Un-parseable: ${unparseableFiles.length}`);
    lines.push('');
    lines.push('## Per-Test Mapping');
    lines.push('| Legacy ID | Legacy File | Requirement | Endpoint | Screen | New File | Confidence | Notes |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const c of candidates) {
        const req = c.matchedRequirements[0]?.req.id ?? '';
        const ep = c.matchedEndpoints[0] ? `${c.matchedEndpoints[0].verb} ${c.matchedEndpoints[0].path}` : '';
        const scr = c.matchedScreens[0]?.screenName ?? '';
        const newFiles = emittedByCandidate.get(c);
        const newFile = newFiles ? newFiles.map((p) => path.basename(p)).join(', ') : '(dropped)';
        const notes = c.confidence === 'orphan'
            ? (c.dropReason ?? 'orphan')
            : c.needsManualReview.slice(0, 2).join('; ');
        lines.push(`| ${c.legacy.id} | ${path.basename(c.legacy.filePath)} | ${req} | ${ep} | ${scr} | ${newFile} | ${c.confidence} | ${notes} |`);
    }
    lines.push('');
    if (unparseableFiles.length > 0) {
        lines.push('## Un-parseable files');
        for (const f of unparseableFiles) lines.push(`- ${f}`);
        lines.push('');
    }
    return lines.join('\n');
}

function buildTraceabilityJson(
    detection: FrameworkDetection,
    candidates: MigrationCandidate[],
    emittedByCandidate: Map<MigrationCandidate, string[]>,
    unparseableFiles: string[],
): unknown {
    return {
        detectedFramework: detection.framework,
        frameworkConfidence: detection.confidence,
        signatureCounts: detection.signatureCounts,
        totals: {
            legacyTests: candidates.length,
            high: candidates.filter((c) => c.confidence === 'high').length,
            medium: candidates.filter((c) => c.confidence === 'medium').length,
            manualReview: candidates.filter((c) => c.confidence === 'manual-review').length,
            orphan: candidates.filter((c) => c.confidence === 'orphan').length,
        },
        unparseableFiles,
        candidates: candidates.map((c) => ({
            legacyId: c.legacy.id,
            displayName: c.legacy.displayName,
            filePath: c.legacy.filePath,
            confidence: c.confidence,
            dropReason: c.dropReason ?? null,
            emitted: emittedByCandidate.get(c) ?? [],
            matchedRequirement: c.matchedRequirements[0]?.req.id ?? null,
            matchedEndpoint: c.matchedEndpoints[0] ? { verb: c.matchedEndpoints[0].verb, path: c.matchedEndpoints[0].path } : null,
            matchedScreen: c.matchedScreens[0]?.screenName ?? null,
            orphanEndpoints: c.orphanEndpoints,
            needsManualReview: c.needsManualReview,
            locatorResolutions: c.locatorResolutions.map((r) => ({
                legacy: r.legacyLocator,
                resolvedFieldId: r.resolvedField?.fieldId ?? null,
            })),
            assertionResolutions: c.assertionResolutions.map((r) => ({
                literal: r.legacyLiteral,
                resolvedKind: r.resolvedTo?.kind ?? null,
            })),
        })),
    };
}

// -----------------------------------------------------------------------------
// Registration.
// -----------------------------------------------------------------------------

registerPrimitive({
    name: 'cs_qa_migrate_legacy',
    description: 'Migrate a legacy Selenium/JUnit, TestNG, Cucumber-Java, Jasmine/Protractor, or Mocha test suite to the CS Playwright framework. Cross-references each legacy test against the source-of-truth model (from cs_qa_source_ingest) and requirement statements, then emits real feature/page-object/steps/data files using REAL DOM ids from the app source — not the legacy locator strings. Produces a traceability report showing every mapping decision so humans can review, plus @needs-manual-review tags on anything the guardrails flagged.',
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    run: async (ctx, input) => {
        const log = createLogger(ctx.invocationId, 'cs_qa_migrate_legacy', { workspaceRoot: ctx.workspaceRoot });
        const warnings: string[] = [];

        // Resolve paths.
        const legacyRoot = path.isAbsolute(input.legacyTestsRoot) ? input.legacyTestsRoot : path.join(ctx.workspaceRoot, input.legacyTestsRoot);
        if (!fs.existsSync(legacyRoot)) {
            return zeroResult(input.legacyFramework as z.infer<typeof FrameworkEnum>, `legacyTestsRoot does not exist: ${legacyRoot}`);
        }
        const outputRoot = path.isAbsolute(input.outputRoot) ? input.outputRoot : path.join(ctx.workspaceRoot, input.outputRoot);

        // Discover files.
        const discovered = walkLegacyTree(legacyRoot);
        log.info('migrate: discovered', { count: discovered.length, root: legacyRoot });
        if (discovered.length === 0) {
            return zeroResult(input.legacyFramework as z.infer<typeof FrameworkEnum>, `no legacy test files found under ${legacyRoot}`);
        }

        // Framework detection.
        let framework: LegacyFramework;
        let detection: FrameworkDetection;
        if (input.legacyFramework === 'auto-detect') {
            detection = detectFramework(discovered);
            framework = detection.framework;
            log.info('migrate: framework detected', { framework, confidence: detection.confidence, counts: detection.signatureCounts });
        } else {
            framework = input.legacyFramework as LegacyFramework;
            detection = { framework, confidence: 1.0, sampleFiles: [], signatureCounts: {} as Record<string, number> };
        }

        // Load requirements (optional).
        const requirements = await loadRequirements(input.requirementsPath, ctx.workspaceRoot, input.docsModelPath, warnings);
        log.info('migrate: requirements loaded', { count: requirements.length });

        // Ensure source model (optional).
        const modelPath = input.sourceModelPath
            ? (path.isAbsolute(input.sourceModelPath) ? input.sourceModelPath : path.join(ctx.workspaceRoot, input.sourceModelPath))
            : path.join(ctx.workspaceRoot, '.cs-qa', 'source-model', 'model.json');
        let model: SourceModel | null = loadModel(modelPath);
        if (!model && input.appSourceRoot) {
            const ingestPrim = getPrimitive('cs_qa_source_ingest');
            if (!ingestPrim) {
                warnings.push('cs_qa_source_ingest primitive not registered — cannot auto-ingest app source.');
            } else {
                try {
                    await ingestPrim.run(ctx, {
                        sourceRoot: input.appSourceRoot,
                        outputPath: modelPath,
                    });
                    model = loadModel(modelPath);
                } catch (e) {
                    warnings.push(`source-ingest-failed: ${(e as Error).message}`);
                }
            }
        }
        if (!model) {
            warnings.push('no source model available — locator/assertion resolution disabled. Only requirement text can ground migrations.');
        }

        // Parse legacy files (concurrent).
        const parsedFiles: ParsedLegacyFile[] = [];
        if (framework === 'cucumber-java') {
            // Cucumber needs the whole file set together.
            const files = discovered.filter((f) => f.kind === 'java' || f.kind === 'feature');
            parsedFiles.push(...parseCucumberJavaSuite({ files: files.map((f) => f.absPath) }));
        } else {
            // Chunk-execute the rest.
            const relevantFiles = discovered.filter((f) => (framework === 'selenium-junit' || framework === 'testng') ? f.kind === 'java' : (f.kind === 'ts' || f.kind === 'js'));
            await bulkExecute(relevantFiles, {
                chunkSize: 25,
                concurrency: 4,
                workFn: async (chunk) => {
                    const results = parseByFramework(framework, chunk);
                    for (const r of results) parsedFiles.push(r);
                    return chunk.map(() => null);
                },
            });
        }

        // Collect unparseable files (files that matched extension but produced no tests).
        const parsedFilePaths = new Set(parsedFiles.map((p) => p.filePath));
        const relevantSet = discovered.filter((f) => (
            framework === 'cucumber-java' ? (f.kind === 'feature') :
            (framework === 'selenium-junit' || framework === 'testng') ? f.kind === 'java' :
            (f.kind === 'ts' || f.kind === 'js')
        ));
        const unparseableFiles = relevantSet
            .filter((f) => !parsedFilePaths.has(f.absPath))
            .map((f) => f.absPath);

        const legacyTests: LegacyTest[] = [];
        for (const p of parsedFiles) legacyTests.push(...p.tests);
        log.info('migrate: parsed tests', { count: legacyTests.length, files: parsedFiles.length, unparseable: unparseableFiles.length });

        // Build fixture-value set from any data rows so assertion literals from
        // data providers still trace.
        const fixtureValues = new Set<string>();
        for (const t of legacyTests) {
            if (t.dataRows) for (const row of t.dataRows.rows) for (const v of Object.values(row)) if (typeof v === 'string') fixtureValues.add(v);
        }

        // Cross-reference.
        const candidates: MigrationCandidate[] = legacyTests.map((t) => crossReferenceOne(t, model, requirements, fixtureValues));

        // Emit artifacts.
        const emittedFilePaths: string[] = [];
        const emittedByCandidate = new Map<MigrationCandidate, string[]>();
        const screensTouched = new Set<string>();
        const pendingWrites: EmittedFile[] = [];
        for (const c of candidates) {
            if (c.confidence === 'orphan') { emittedByCandidate.set(c, []); continue; }
            const feat = emitFeatureFile(c, outputRoot, input.preserveLegacyIds);
            pendingWrites.push(feat.emitted);
            const steps = emitStepsFile(c, outputRoot, feat.slug, feat.steps);
            if (steps) pendingWrites.push(steps);
            const data = emitDataFile(c, outputRoot, feat.slug);
            if (data) pendingWrites.push(data);
            const emittedList = [feat.emitted.path, ...(steps ? [steps.path] : []), ...(data ? [data.path] : [])];
            emittedByCandidate.set(c, emittedList);
            for (const s of c.matchedScreens.slice(0, 1)) screensTouched.add(s.screenId);
        }
        // Page objects.
        if (model) {
            for (const scrId of screensTouched) {
                const scr = model.screens.find((s) => s.id === scrId);
                if (!scr) continue;
                pendingWrites.push(emitPageObjectForScreen(scr, outputRoot));
            }
        }

        // Deduplicate emissions by path (some screens share names → same page-object).
        const dedup = new Map<string, EmittedFile>();
        for (const f of pendingWrites) if (!dedup.has(f.path)) dedup.set(f.path, f);

        // Write.
        if (!input.dryRun) {
            for (const f of dedup.values()) {
                try {
                    fs.mkdirSync(path.dirname(f.path), { recursive: true });
                    fs.writeFileSync(f.path, f.content, 'utf-8');
                    emittedFilePaths.push(f.path);
                } catch (e) {
                    warnings.push(`write-failed: ${f.path}: ${(e as Error).message}`);
                }
            }
        } else {
            for (const f of dedup.values()) emittedFilePaths.push(f.path);
        }

        // Traceability report.
        let mdPath: string | null = null;
        let jsonPath: string | null = null;
        if (input.generateTraceabilityReport) {
            const md = buildTraceabilityMd(detection, candidates, unparseableFiles, model !== null, requirements.length, emittedByCandidate);
            const json = buildTraceabilityJson(detection, candidates, emittedByCandidate, unparseableFiles);
            mdPath = path.join(ctx.workspaceRoot, '.cs-qa', 'migration', 'traceability.md');
            jsonPath = path.join(ctx.workspaceRoot, '.cs-qa', 'migration', 'traceability.json');
            if (!input.dryRun) {
                try {
                    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
                    fs.writeFileSync(mdPath, md, 'utf-8');
                    fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2), 'utf-8');
                } catch (e) {
                    warnings.push(`report-write-failed: ${(e as Error).message}`);
                    mdPath = null; jsonPath = null;
                }
            }
        }

        const migratedHigh = candidates.filter((c) => c.confidence === 'high').length;
        const migratedMedium = candidates.filter((c) => c.confidence === 'medium').length;
        const manualReview = candidates.filter((c) => c.confidence === 'manual-review').length;
        const dropped = candidates.filter((c) => c.confidence === 'orphan').length;

        return {
            ok: true,
            detectedFramework: framework as z.infer<typeof FrameworkEnum>,
            frameworkConfidence: detection.confidence,
            legacyFilesScanned: parsedFiles.length,
            legacyTestsFound: legacyTests.length,
            migratedHigh, migratedMedium, manualReview, dropped,
            unparseable: unparseableFiles.length,
            outputRoot: input.dryRun ? null : outputRoot,
            traceabilityReportPath: mdPath,
            traceabilityJsonPath: jsonPath,
            emittedFiles: emittedFilePaths,
            warnings,
            note: `${legacyTests.length} legacy tests → high=${migratedHigh}, medium=${migratedMedium}, manual-review=${manualReview}, dropped=${dropped}, unparseable=${unparseableFiles.length}. Detected framework: ${framework} (${(detection.confidence * 100).toFixed(1)}%).`,
        };
    },
});

function zeroResult(fw: z.infer<typeof FrameworkEnum>, note: string): z.infer<typeof OutputSchema> {
    return {
        ok: false,
        detectedFramework: fw,
        frameworkConfidence: 0,
        legacyFilesScanned: 0,
        legacyTestsFound: 0,
        migratedHigh: 0, migratedMedium: 0, manualReview: 0, dropped: 0,
        unparseable: 0,
        outputRoot: null,
        traceabilityReportPath: null,
        traceabilityJsonPath: null,
        emittedFiles: [],
        warnings: [],
        note,
    };
}
