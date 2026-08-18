/**
 * cucumber_java_parser — extract scenarios + step definitions from a
 * cucumber-java legacy suite.
 *
 * Handles two file kinds:
 *   1. `.feature` files — Gherkin scenarios. We extract Feature, Scenario /
 *      Scenario Outline, tags, Examples tables.
 *   2. `.java` files with cucumber annotations (@Given/@When/@Then/@And/@But
 *      from io.cucumber.java.en or cucumber.api.java.en) — we extract each
 *      annotation regex → method body mapping and scan the body for driver
 *      calls + assertions.
 *
 * The parser then STITCHES: for each scenario step text, we find the step
 * def whose regex matches, and inherit its actions/assertions into the
 * LegacyTest. When a step has no matching def, we still emit the step (with
 * an `unresolved-step` warning) so the migrator can surface it to the user.
 */

import * as fs from 'fs';
import { LegacyAction, LegacyAssertion, LegacyLocator, LegacyTest, ParsedLegacyFile } from './types';

const FEATURE_HEADER_RE = /^\s*Feature\s*:\s*(.+)$/m;
const SCENARIO_LINE_RE = /^\s*(?:Scenario|Scenario Outline|Example)\s*:\s*(.+)$/;
const STEP_LINE_RE = /^\s*(Given|When|Then|And|But)\s+(.+)$/;
const TAG_LINE_RE = /^\s*(@[\w:@\s\-.]+)\s*$/;
const EXAMPLES_LINE_RE = /^\s*Examples\s*:?\s*$/;
const TABLE_ROW_RE = /^\s*\|(.+)\|\s*$/;

const STEP_DEF_ANN_RE = /@(Given|When|Then|And|But)\s*\(\s*"((?:[^"\\]|\\.)*)"\s*\)/;

const BY_CALL_RE = /By\.(id|css|cssSelector|xpath|name|className|linkText|partialLinkText|tagName)\s*\(\s*"((?:[^"\\]|\\.)*)"\s*\)/;
const DRIVER_GET_RE = /(?:driver|browser|webDriver|wd|page)\.(?:get|navigate\(\)\.to|goto)\s*\(\s*"((?:[^"\\]|\\.)*)"\s*\)/;
const SEND_KEYS_RE = /\.sendKeys\s*\(\s*"((?:[^"\\]|\\.)*)"\s*\)/;
const CLICK_RE = /\.click\s*\(\s*\)/;

const ASSERT_EQUALS_RE = /(?:assertEquals|assertThat|Assert\.assertEquals|Assertions\.assertEquals)\s*\(\s*("((?:[^"\\]|\\.)*)"|[^,)]+?)\s*,\s*(.+?)\s*\)\s*;/;
const ASSERT_TRUE_RE = /(?:assertTrue|Assert\.assertTrue|Assertions\.assertTrue)\s*\(\s*(.+?)\s*(?:,\s*"((?:[^"\\]|\\.)*)")?\s*\)\s*;/;
const ASSERT_CONTAINS_RE = /(?:assertTrue|assertThat)\s*\(\s*(.+?)\.(?:contains|containsIgnoreCase)\s*\(\s*"((?:[^"\\]|\\.)*)"\s*\)/;

interface ParsedFeature {
    filePath: string;
    featureName: string;
    featureTags: string[];
    scenarios: Array<{
        name: string;
        tags: string[];
        startLine: number;
        steps: Array<{ keyword: string; text: string; lineNumber: number }>;
        examples: { headers: string[]; rows: string[][] } | null;
    }>;
}

interface StepDefinition {
    filePath: string;
    keyword: string;
    /** Original regex string as written between the quotes. */
    pattern: string;
    /** RegExp compiled with cucumber parameter type substitution. */
    compiled: RegExp;
    /** Method body scan results (inherit into every scenario that uses this step). */
    actions: LegacyAction[];
    assertions: LegacyAssertion[];
    /** Cite: line of the annotation. */
    lineNumber: number;
    /** Method name (for tracing). */
    methodName: string;
}

// --- Feature parsing ------------------------------------------------------

function parseFeatureFile(filePath: string, source: string): ParsedFeature | null {
    const featureMatch = FEATURE_HEADER_RE.exec(source);
    if (!featureMatch) return null;
    const featureName = featureMatch[1].trim();
    const lines = source.split(/\r?\n/);

    let pendingTags: string[] = [];
    let featureTags: string[] = [];
    let currentScenario: ParsedFeature['scenarios'][number] | null = null;
    const scenarios: ParsedFeature['scenarios'] = [];
    let inExamples = false;
    let examplesHeaders: string[] | null = null;
    let sawFeatureLine = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;

        // Feature line
        if (/^Feature\s*:/i.test(trimmed)) {
            featureTags = pendingTags;
            pendingTags = [];
            sawFeatureLine = true;
            continue;
        }
        // Tag lines
        const tagMatch = TAG_LINE_RE.exec(line);
        if (tagMatch && !SCENARIO_LINE_RE.test(line) && !STEP_LINE_RE.test(line)) {
            const tags = tagMatch[1].trim().split(/\s+/).filter((t) => t.startsWith('@'));
            pendingTags.push(...tags);
            continue;
        }
        // Scenario line.
        const scMatch = SCENARIO_LINE_RE.exec(line);
        if (scMatch) {
            if (currentScenario) scenarios.push(currentScenario);
            currentScenario = {
                name: scMatch[1].trim(),
                tags: pendingTags.slice(),
                startLine: i + 1,
                steps: [],
                examples: null,
            };
            pendingTags = [];
            inExamples = false;
            examplesHeaders = null;
            continue;
        }
        if (!sawFeatureLine || !currentScenario) continue;

        // Examples block.
        if (EXAMPLES_LINE_RE.test(line)) {
            inExamples = true;
            examplesHeaders = null;
            continue;
        }
        if (inExamples) {
            const tableMatch = TABLE_ROW_RE.exec(line);
            if (tableMatch) {
                const cells = tableMatch[1].split('|').map((c) => c.trim());
                if (!examplesHeaders) {
                    examplesHeaders = cells;
                    currentScenario.examples = { headers: cells, rows: [] };
                } else {
                    currentScenario.examples!.rows.push(cells);
                }
                continue;
            }
            // fall through: non-table line ends the examples block
            inExamples = false;
        }

        const stepMatch = STEP_LINE_RE.exec(line);
        if (stepMatch) {
            currentScenario.steps.push({
                keyword: stepMatch[1],
                text: stepMatch[2].trim(),
                lineNumber: i + 1,
            });
        }
    }
    if (currentScenario) scenarios.push(currentScenario);

    return { filePath, featureName, featureTags, scenarios };
}

// --- Step-def parsing -----------------------------------------------------

/**
 * Compile a cucumber-style regex/pattern to a JS RegExp for matching against
 * concrete step text. Handles the common cucumber-expression tokens:
 *
 *   {int}     → (\d+)
 *   {float}   → (\d+(?:\.\d+)?)
 *   {word}    → (\w+)
 *   {string}  → "([^"]*)"
 *   {}        → (.+)
 *   ".+?"     → left as-is (already regex-safe)
 *
 * If the pattern already looks like a regex (contains ^ … $ or unescaped
 * regex metacharacters), we use it as-is.
 */
function compileStepPattern(pattern: string): RegExp {
    let src = pattern;
    // If the pattern already has anchors, treat verbatim.
    if (/^\^/.test(src) && /\$$/.test(src)) {
        try { return new RegExp(src); } catch { /* fall through */ }
    }
    // Cucumber-expression conversion.
    src = src
        .replace(/\{int\}/g, '(\\d+)')
        .replace(/\{float\}/g, '(\\d+(?:\\.\\d+)?)')
        .replace(/\{word\}/g, '(\\w+)')
        .replace(/\{string\}/g, '"([^"]*)"')
        .replace(/\{\}/g, '(.+)');
    // Anchor for full-string match, escape stray regex-only tokens NOT already introduced.
    // We conservatively assume the rest is literal text.
    // Escape regex metacharacters except for the parens/backslashes we just inserted.
    // Safer approach: escape everything, then re-insert the groups.
    try {
        return new RegExp('^' + src + '$');
    } catch {
        // Fallback: escape and match as literal.
        return new RegExp('^' + pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$');
    }
}

function matchBraces(src: string, openIdx: number): number {
    if (src[openIdx] !== '{') return -1;
    let depth = 0;
    let inString: '"' | "'" | null = null;
    let inLineComment = false;
    let inBlockComment = false;
    for (let i = openIdx; i < src.length; i++) {
        const c = src[i];
        const next = src[i + 1];
        if (inLineComment) { if (c === '\n') inLineComment = false; continue; }
        if (inBlockComment) { if (c === '*' && next === '/') { inBlockComment = false; i++; } continue; }
        if (inString) {
            if (c === '\\') { i++; continue; }
            if (c === inString) inString = null;
            continue;
        }
        if (c === '/' && next === '/') { inLineComment = true; i++; continue; }
        if (c === '/' && next === '*') { inBlockComment = true; i++; continue; }
        if (c === '"' || c === '\'') { inString = c; continue; }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return i; }
    }
    return -1;
}

function lineOf(src: string, idx: number): number {
    let n = 1;
    for (let i = 0; i < idx && i < src.length; i++) if (src[i] === '\n') n++;
    return n;
}

function normalizeStrategy(raw: string): string { return raw === 'cssSelector' ? 'css' : raw; }

function scanBody(body: string, bodyStartLine: number): { actions: LegacyAction[]; assertions: LegacyAssertion[] } {
    const actions: LegacyAction[] = [];
    const assertions: LegacyAssertion[] = [];
    const lines = body.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const trimmed = raw.trim();
        if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
        const lineNumber = bodyStartLine + i;
        const navMatch = DRIVER_GET_RE.exec(raw);
        if (navMatch) {
            actions.push({ kind: 'navigate', value: navMatch[1], rawLine: trimmed, lineNumber });
            continue;
        }
        const byMatch = BY_CALL_RE.exec(raw);
        const locator: LegacyLocator | undefined = byMatch ? { strategy: normalizeStrategy(byMatch[1]), value: byMatch[2], lineNumber } : undefined;
        const skMatch = SEND_KEYS_RE.exec(raw);
        if (skMatch) { actions.push({ kind: 'sendKeys', locator, value: skMatch[1], rawLine: trimmed, lineNumber }); continue; }
        if (CLICK_RE.test(raw)) { actions.push({ kind: 'click', locator, rawLine: trimmed, lineNumber }); continue; }

        const aeMatch = ASSERT_EQUALS_RE.exec(raw);
        if (aeMatch) {
            assertions.push({ kind: 'equals', expectedLiteral: aeMatch[2] ?? null, actualExpression: aeMatch[3], rawLine: trimmed, lineNumber });
            continue;
        }
        const atMatch = ASSERT_TRUE_RE.exec(raw);
        if (atMatch) {
            assertions.push({ kind: 'true', expectedLiteral: null, actualExpression: atMatch[1], rawLine: trimmed, lineNumber });
            continue;
        }
        const cMatch = ASSERT_CONTAINS_RE.exec(raw);
        if (cMatch) {
            assertions.push({ kind: 'contains', expectedLiteral: cMatch[2], actualExpression: cMatch[1], rawLine: trimmed, lineNumber });
            continue;
        }
    }
    return { actions, assertions };
}

function parseStepDefFile(filePath: string, source: string, fileErrors: string[]): StepDefinition[] {
    const out: StepDefinition[] = [];
    const METHOD_HEADER_RE = /(?<=[\s;}]|^)(?:public|private|protected)?\s*(?:static\s+)?(?:void|[\w<>,?]+)\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?:throws\s[^{]+)?\{/g;
    let m: RegExpExecArray | null;
    while ((m = METHOD_HEADER_RE.exec(source)) !== null) {
        const headerIdxAbs = m.index;
        const openBraceAbs = m.index + m[0].length - 1;
        // annotation block
        let blockStart = headerIdxAbs - 1;
        let seenAnn = false;
        while (blockStart >= 0) {
            const ch = source[blockStart];
            if (ch === '\n') {
                let ls = blockStart - 1;
                while (ls > 0 && source[ls] !== '\n') ls--;
                const line = source.slice(ls + 1, blockStart).trim();
                if (line === '' || line.startsWith('@') || line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) {
                    blockStart = ls;
                    if (line === '' && seenAnn) { blockStart = ls; break; }
                    if (line.startsWith('@')) seenAnn = true;
                    continue;
                }
                blockStart = ls;
                break;
            }
            blockStart--;
        }
        const annBlock = source.slice(Math.max(0, blockStart), headerIdxAbs);
        const stepMatch = STEP_DEF_ANN_RE.exec(annBlock);
        if (!stepMatch) continue;
        const closeIdx = matchBraces(source, openBraceAbs);
        if (closeIdx === -1) { fileErrors.push(`unmatched-braces near line ${lineOf(source, openBraceAbs)}`); continue; }
        const body = source.slice(openBraceAbs + 1, closeIdx);
        const scanned = scanBody(body, lineOf(source, openBraceAbs));
        out.push({
            filePath,
            keyword: stepMatch[1],
            pattern: stepMatch[2],
            compiled: compileStepPattern(stepMatch[2]),
            actions: scanned.actions,
            assertions: scanned.assertions,
            lineNumber: lineOf(source, headerIdxAbs),
            methodName: m[1],
        });
    }
    return out;
}

// --- Public API -----------------------------------------------------------

export interface CucumberScanOpts {
    /** Files already discovered by the caller (absolute paths). */
    files: string[];
}

export function parseCucumberJavaSuite(opts: CucumberScanOpts): ParsedLegacyFile[] {
    const features: ParsedFeature[] = [];
    const stepDefs: StepDefinition[] = [];
    const fileErrorsByFile = new Map<string, string[]>();
    for (const abs of opts.files) {
        const lower = abs.toLowerCase();
        let source: string;
        try { source = fs.readFileSync(abs, 'utf-8'); } catch { continue; }
        if (lower.endsWith('.feature')) {
            const parsed = parseFeatureFile(abs, source);
            if (parsed) features.push(parsed);
        } else if (lower.endsWith('.java') && (/import\s+(?:io|cucumber)\.cucumber\./.test(source) || STEP_DEF_ANN_RE.test(source))) {
            const errs: string[] = [];
            const defs = parseStepDefFile(abs, source, errs);
            if (errs.length > 0) fileErrorsByFile.set(abs, errs);
            for (const d of defs) stepDefs.push(d);
        }
    }
    const parsedFiles: ParsedLegacyFile[] = [];
    for (const feat of features) {
        const tests: LegacyTest[] = [];
        for (const scenario of feat.scenarios) {
            const allActions: LegacyAction[] = [];
            const allAssertions: LegacyAssertion[] = [];
            const urls = new Set<string>();
            const warnings: string[] = [];
            for (const step of scenario.steps) {
                const def = stepDefs.find((d) => d.compiled.test(step.text) && (d.keyword === step.keyword || step.keyword === 'And' || step.keyword === 'But'));
                if (!def) {
                    warnings.push(`unresolved-step: "${step.keyword} ${step.text}" (line ${step.lineNumber})`);
                    continue;
                }
                for (const a of def.actions) {
                    allActions.push(a);
                    if (a.value && a.kind === 'navigate') urls.add(a.value);
                }
                for (const a of def.assertions) allAssertions.push(a);
            }
            const dataRows = scenario.examples
                ? { columns: scenario.examples.headers, rows: scenario.examples.rows.map((r) => Object.fromEntries(scenario.examples!.headers.map((h, i) => [h, r[i] ?? '']))) }
                : null;
            tests.push({
                id: scenario.name.replace(/\s+/g, '_').slice(0, 80),
                displayName: scenario.name,
                filePath: feat.filePath,
                startLine: scenario.startLine,
                framework: 'cucumber-java',
                tags: Array.from(new Set([...feat.featureTags, ...scenario.tags])),
                actions: allActions,
                assertions: allAssertions,
                setupHooks: [],
                teardownHooks: [],
                dataRows,
                urlsTouched: Array.from(urls),
                warnings,
            });
        }
        parsedFiles.push({ filePath: feat.filePath, framework: 'cucumber-java', tests, fileErrors: fileErrorsByFile.get(feat.filePath) ?? [] });
    }
    return parsedFiles;
}

export function looksLikeCucumberJavaSuite(files: string[]): boolean {
    let hasFeature = false;
    let hasStepDef = false;
    for (const f of files) {
        const lower = f.toLowerCase();
        if (lower.endsWith('.feature')) hasFeature = true;
        if (hasStepDef && hasFeature) break;
        if (lower.endsWith('.java')) {
            try {
                const src = fs.readFileSync(f, 'utf-8');
                if (/@(?:Given|When|Then|And|But)\s*\(/.test(src) && /import\s+(?:io|cucumber)\.cucumber\./.test(src)) {
                    hasStepDef = true;
                }
            } catch { /* ignore */ }
        }
    }
    return hasFeature && hasStepDef;
}
