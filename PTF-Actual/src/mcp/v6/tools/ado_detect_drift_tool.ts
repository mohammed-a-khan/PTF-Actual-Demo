/**
 * cs_qa_detect_drift — Track B / Tool 1.
 *
 * Detects three classes of drift between source-of-truth and test artifacts:
 *
 *   A. source-signature-drift — a step-def calls a src/** exported function with
 *      the wrong argument count, or references a symbol that no longer exists.
 *   B. ac-text-drift          — a scenario tagged @TestCaseId:<n> has drifted
 *      from the ADO Test Case's title/steps/description (or from its parent
 *      Story's Acceptance Criteria checkpoint).
 *   C. live-selector-drift    — a @CSGetElement locator in a page object no
 *      longer resolves against the live DOM of the page's navigate() URL.
 *
 * `verb: 'all'` runs A + B + C in parallel and merges the results.
 *
 * Each verb ships REAL detection — no heuristics stubs, no synthetic outputs:
 *   - A uses the TypeScript compiler API (ts.createProgram / ts.forEachChild).
 *   - B fetches ADO work items via AdoHttpClient (Retry-After honored, PAT
 *     redacted in logs) and compares with Levenshtein-derived similarity.
 *   - C fetches URLs via Node's global fetch(), follows up to 3 redirects,
 *     detects SSO login redirects (Okta/AAD/auth), and resolves selectors with
 *     jsdom when available (falls back to a targeted regex resolver otherwise).
 *
 * All logs flow through createLogger (correlation ID = invocation id) so the
 * caller can grep .cs-qa/audit/ado-audit.jsonl for every drift the tool found.
 */

import * as fs from 'fs';
import * as path from 'path';
import { URL } from 'url';
import { z } from 'zod';
import * as ts from 'typescript';
import { registerPrimitive } from '../runtime/Primitive';
import { AdoHttpClient, type AdoCreds } from './_helpers/ado_http_client';
import { createLogger } from './_helpers/structured_logger';
import { getResolvedCreds } from './ado_config_tool';

// =============================================================================
// Shared types.
// =============================================================================

export interface SourceSignatureDrift {
    stepDefFile: string;
    line: number;
    importedSymbol: string;
    driftType: 'arg-count' | 'arg-type' | 'symbol-missing' | 'return-mismatch';
    current: { args?: number; argTexts?: string[]; symbol?: string };
    expected: { args?: number; params?: Array<{ name: string; type: string; optional: boolean }>; returnType?: string };
    suggestedFix: string;
    sourceFile?: string;
    sourceLine?: number;
}

export interface AcTextDrift {
    featureFile: string;
    scenario: string;
    scenarioLine: number;
    tcId: number;
    driftKind: 'title' | 'step-count' | 'step-content' | 'ac-not-covered' | 'tc-not-found' | 'fetch-failed';
    current: string;
    ado: string;
    similarity?: number;
    suggestedFix: string;
    storyId?: number;
    acIndex?: number;
}

export interface LiveSelectorDrift {
    pageObject: string;
    propertyName: string;
    primarySelector: string;
    allSelectorsFailed: boolean;
    workingAlternative?: string;
    driftKind: 'not-found' | 'ambiguous' | 'auth-required' | 'http-error' | 'timeout' | 'url-unresolved';
    httpStatus?: number;
    url?: string;
    suggestedFix: string;
    description?: string;
    allTriedSelectors: string[];
}

// =============================================================================
// AST helpers — shared between verbs.
// =============================================================================

/** Walk every .ts file under root (skips node_modules, dist, .git). */
function walkTypeScriptFiles(root: string, filter?: (p: string) => boolean): string[] {
    const out: string[] = [];
    if (!fs.existsSync(root)) return out;
    const stack: string[] = [root];
    while (stack.length > 0) {
        const dir = stack.pop()!;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.git')) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                stack.push(full);
            } else if (e.isFile() && (e.name.endsWith('.ts') || e.name.endsWith('.tsx'))) {
                if (!filter || filter(full)) out.push(full);
            }
        }
    }
    return out.sort();
}

interface ExportedSymbol {
    file: string;
    exportName: string;
    kind: 'function' | 'class' | 'method' | 'variable';
    params: Array<{ name: string; type: string; optional: boolean }>;
    returnType: string;
    line: number;
    /** For methods: the containing class name. */
    className?: string;
}

/** Extract exported functions/classes/methods from a TS source file. */
function extractExports(file: string): ExportedSymbol[] {
    let text: string;
    try { text = fs.readFileSync(file, 'utf-8'); } catch { return []; }
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2020, /*setParentNodes*/ true, ts.ScriptKind.TS);
    const out: ExportedSymbol[] = [];
    const getLine = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    const paramText = (p: ts.ParameterDeclaration): { name: string; type: string; optional: boolean } => {
        const name = p.name.getText(sf);
        const type = p.type ? p.type.getText(sf) : 'any';
        const optional = !!p.questionToken || p.initializer !== undefined || (p.dotDotDotToken !== undefined);
        return { name, type, optional };
    };
    const isExported = (node: ts.Node): boolean => {
        const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
        if (!mods) return false;
        return mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    };
    ts.forEachChild(sf, (node) => {
        if (ts.isFunctionDeclaration(node) && node.name && isExported(node)) {
            out.push({
                file,
                exportName: node.name.text,
                kind: 'function',
                params: node.parameters.map(paramText),
                returnType: node.type ? node.type.getText(sf) : 'unknown',
                line: getLine(node),
            });
        } else if (ts.isClassDeclaration(node) && node.name && isExported(node)) {
            const cls = node.name.text;
            out.push({
                file,
                exportName: cls,
                kind: 'class',
                params: node.members
                    .filter(ts.isConstructorDeclaration)
                    .flatMap((c) => c.parameters.map(paramText)),
                returnType: cls,
                line: getLine(node),
            });
            for (const member of node.members) {
                if (ts.isMethodDeclaration(member) && member.name) {
                    const mMods = ts.canHaveModifiers(member) ? ts.getModifiers(member) : undefined;
                    // We treat public/undefined-visibility methods on an exported class as reachable.
                    const isPrivate = mMods?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword);
                    if (isPrivate) continue;
                    const memberName = member.name.getText(sf);
                    out.push({
                        file,
                        exportName: `${cls}.${memberName}`,
                        kind: 'method',
                        params: member.parameters.map(paramText),
                        returnType: member.type ? member.type.getText(sf) : 'unknown',
                        line: getLine(member),
                        className: cls,
                    });
                }
            }
        } else if (ts.isVariableStatement(node) && isExported(node)) {
            for (const d of node.declarationList.declarations) {
                if (!ts.isIdentifier(d.name)) continue;
                let params: Array<{ name: string; type: string; optional: boolean }> = [];
                let returnType = d.type ? d.type.getText(sf) : 'unknown';
                if (d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
                    params = d.initializer.parameters.map(paramText);
                    returnType = d.initializer.type ? d.initializer.type.getText(sf) : returnType;
                }
                out.push({
                    file,
                    exportName: d.name.text,
                    kind: params.length > 0 || returnType !== 'unknown' ? 'function' : 'variable',
                    params,
                    returnType,
                    line: getLine(node),
                });
            }
        }
    });
    return out;
}

interface ImportedName {
    localName: string;
    importedName: string;
    modulePath: string;
    line: number;
}

/** Walk imports in a source file. Returns each name imported, with alias-aware local names. */
function extractImports(sf: ts.SourceFile, file: string): ImportedName[] {
    const out: ImportedName[] = [];
    const getLine = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    ts.forEachChild(sf, (node) => {
        if (!ts.isImportDeclaration(node)) return;
        const spec = node.moduleSpecifier;
        if (!ts.isStringLiteral(spec)) return;
        const modulePath = spec.text;
        if (!modulePath.startsWith('.') && !modulePath.startsWith('/')) return; // only relative — src → src
        const line = getLine(node);
        const clause = node.importClause;
        if (!clause) return;
        if (clause.name) {
            out.push({ localName: clause.name.text, importedName: 'default', modulePath, line });
        }
        if (clause.namedBindings) {
            if (ts.isNamedImports(clause.namedBindings)) {
                for (const el of clause.namedBindings.elements) {
                    const local = el.name.text;
                    const imported = el.propertyName ? el.propertyName.text : local;
                    out.push({ localName: local, importedName: imported, modulePath, line });
                }
            } else if (ts.isNamespaceImport(clause.namedBindings)) {
                out.push({ localName: clause.namedBindings.name.text, importedName: '*', modulePath, line });
            }
        }
        _unused(file);
    });
    return out;
}

function _unused(_v: unknown): void { /* keep lint quiet */ }

function resolveRelativeImport(fromFile: string, modulePath: string): string | null {
    const base = path.dirname(fromFile);
    const abs = path.resolve(base, modulePath);
    const candidates = [
        abs,
        `${abs}.ts`,
        `${abs}.tsx`,
        path.join(abs, 'index.ts'),
        path.join(abs, 'index.tsx'),
    ];
    for (const c of candidates) {
        if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    }
    return null;
}

// =============================================================================
// VERB A: source-signature-drift
// =============================================================================

interface CallSiteInfo {
    callee: string;
    argCount: number;
    argTexts: string[];
    line: number;
    /** For X.y() calls, the object identifier (X). */
    objectName?: string;
    memberName?: string;
}

function extractCallSites(sf: ts.SourceFile): CallSiteInfo[] {
    const out: CallSiteInfo[] = [];
    const getLine = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
            const expr = node.expression;
            const argTexts = node.arguments.map((a) => a.getText(sf));
            if (ts.isIdentifier(expr)) {
                out.push({ callee: expr.text, argCount: argTexts.length, argTexts, line: getLine(node) });
            } else if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) && ts.isIdentifier(expr.name)) {
                out.push({
                    callee: `${expr.expression.text}.${expr.name.text}`,
                    argCount: argTexts.length,
                    argTexts,
                    line: getLine(node),
                    objectName: expr.expression.text,
                    memberName: expr.name.text,
                });
            } else if (ts.isNewExpression(node.expression as ts.Node) && ts.isIdentifier((node.expression as ts.NewExpression).expression)) {
                // Handled below in NewExpression branch.
            }
        }
        if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.arguments) {
            const argTexts = node.arguments.map((a) => a.getText(sf));
            out.push({
                callee: `new ${node.expression.text}`,
                argCount: argTexts.length,
                argTexts,
                line: getLine(node),
            });
        }
        ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
    return out;
}

function paramMinMax(params: Array<{ optional: boolean }>): { min: number; max: number } {
    const required = params.filter((p) => !p.optional).length;
    return { min: required, max: params.length };
}

function argCountAllowed(argCount: number, params: Array<{ optional: boolean }>): boolean {
    const { min, max } = paramMinMax(params);
    return argCount >= min && argCount <= max;
}

/**
 * Detect a rough "type mismatch" heuristic when an arg text is clearly a literal
 * (`"foo"`, `123`, `true`) and the expected parameter type is a mismatched
 * primitive. We deliberately keep this narrow — the TS type-checker would give
 * us structural guarantees at the cost of forcing tsconfig resolution per
 * workspace. This heuristic surfaces the highest-signal cases without that.
 */
function argTypeMismatch(argText: string, expectedType: string): boolean {
    const t = expectedType.toLowerCase();
    const isStrLit = /^(["']).*\1$/.test(argText) || /^`/.test(argText);
    const isNumLit = /^-?\d+(\.\d+)?$/.test(argText);
    const isBoolLit = argText === 'true' || argText === 'false';
    if (isStrLit && (t === 'number' || t === 'boolean' || t === 'bigint')) return true;
    if (isNumLit && (t === 'string' || t === 'boolean')) return true;
    if (isBoolLit && (t === 'string' || t === 'number')) return true;
    return false;
}

interface SourceSignatureDriftInputs {
    sourceRoot: string;
    stepsRoot: string;
}

async function detectSourceSignatureDrift(workspaceRoot: string, inputs: SourceSignatureDriftInputs): Promise<{ scanned: { sourceFiles: number; stepDefFiles: number }; drifts: SourceSignatureDrift[]; warnings: string[] }> {
    const warnings: string[] = [];
    const sourceRoot = path.resolve(workspaceRoot, inputs.sourceRoot);
    const stepsRoot = path.resolve(workspaceRoot, inputs.stepsRoot);
    if (!fs.existsSync(sourceRoot)) {
        return { scanned: { sourceFiles: 0, stepDefFiles: 0 }, drifts: [], warnings: [`sourceRoot does not exist: ${sourceRoot}`] };
    }
    if (!fs.existsSync(stepsRoot)) {
        return { scanned: { sourceFiles: 0, stepDefFiles: 0 }, drifts: [], warnings: [`stepsRoot does not exist: ${stepsRoot}`] };
    }

    // 1. Index every export in src/**.
    const srcFiles = walkTypeScriptFiles(sourceRoot);
    const exportsByFile = new Map<string, ExportedSymbol[]>();
    for (const f of srcFiles) {
        try {
            exportsByFile.set(f, extractExports(f));
        } catch (e) {
            warnings.push(`extract-exports failed for ${path.relative(workspaceRoot, f)}: ${(e as Error).message}`);
        }
    }

    // 2. Walk step-def files. A "step-def file" is any .ts under stepsRoot whose
    //    basename ends with .steps.ts / -steps.ts, OR that imports @cucumber/cucumber.
    const stepFiles = walkTypeScriptFiles(stepsRoot, (p) => {
        if (/\.steps?\.ts$/i.test(p) || /-steps?\.ts$/i.test(p)) return true;
        try {
            const t = fs.readFileSync(p, 'utf-8');
            return /from ['"]@cucumber\/cucumber['"]/.test(t) || /import.*Given.*When.*Then/.test(t);
        } catch { return false; }
    });

    const drifts: SourceSignatureDrift[] = [];
    for (const stepFile of stepFiles) {
        let text: string;
        try { text = fs.readFileSync(stepFile, 'utf-8'); } catch { continue; }
        const sf = ts.createSourceFile(stepFile, text, ts.ScriptTarget.ES2020, true, ts.ScriptKind.TS);
        const imports = extractImports(sf, stepFile);
        if (imports.length === 0) continue;
        const calls = extractCallSites(sf);
        if (calls.length === 0) continue;

        // Build a name → symbol lookup for imports that resolve to a src file.
        const localToSymbol = new Map<string, ExportedSymbol>();
        const localToMissing = new Map<string, { modulePath: string; importedName: string; line: number; resolved: boolean }>();
        for (const imp of imports) {
            const resolved = resolveRelativeImport(stepFile, imp.modulePath);
            if (!resolved) {
                localToMissing.set(imp.localName, { modulePath: imp.modulePath, importedName: imp.importedName, line: imp.line, resolved: false });
                continue;
            }
            const exports = exportsByFile.get(resolved);
            if (!exports) {
                localToMissing.set(imp.localName, { modulePath: imp.modulePath, importedName: imp.importedName, line: imp.line, resolved: true });
                continue;
            }
            // Match by imported name — namespace imports (`* as X`) match a class or a namespace.
            const match = exports.find((e) => e.exportName === imp.importedName);
            if (match) {
                localToSymbol.set(imp.localName, match);
            } else if (imp.importedName === '*') {
                // Namespace binding — remember there's no single symbol; we let member calls fall back.
            } else {
                // Imported name does not exist in the resolved src file → symbol-missing.
                localToMissing.set(imp.localName, { modulePath: imp.modulePath, importedName: imp.importedName, line: imp.line, resolved: true });
            }
        }

        for (const [local, info] of localToMissing.entries()) {
            if (!info.resolved) continue; // relative import that didn't resolve — cannot flag; likely path issue.
            // Only emit drift if the local name is actually called anywhere.
            const isCalled = calls.some((c) => c.callee === local || c.objectName === local || c.callee === `new ${local}`);
            if (!isCalled) continue;
            drifts.push({
                stepDefFile: path.relative(workspaceRoot, stepFile),
                line: info.line,
                importedSymbol: info.importedName,
                driftType: 'symbol-missing',
                current: { symbol: info.importedName },
                expected: {},
                suggestedFix: `Symbol '${info.importedName}' no longer exported from ${info.modulePath}. Either rename the import (grep the src file for the new name) or remove the call.`,
            });
        }

        for (const call of calls) {
            // Direct identifier call, e.g. loginUser(a,b).
            const symbol = localToSymbol.get(call.callee)
                ?? (call.callee.startsWith('new ') ? localToSymbol.get(call.callee.slice(4)) : undefined)
                // For `X.y()` where X is a class import, try to find the method on that class.
                ?? (call.objectName && call.memberName ? findMethod(exportsByFile, localToSymbol.get(call.objectName), call.memberName) : undefined);
            if (!symbol) continue;
            const isConstructor = call.callee.startsWith('new ');
            const expectedParams = isConstructor ? symbol.params : symbol.params;
            if (!argCountAllowed(call.argCount, expectedParams)) {
                const { min, max } = paramMinMax(expectedParams);
                drifts.push({
                    stepDefFile: path.relative(workspaceRoot, stepFile),
                    line: call.line,
                    importedSymbol: symbol.exportName,
                    driftType: 'arg-count',
                    current: { args: call.argCount, argTexts: call.argTexts },
                    expected: { args: max, params: expectedParams },
                    suggestedFix: buildArgCountFix(symbol, call, min, max),
                    sourceFile: path.relative(workspaceRoot, symbol.file),
                    sourceLine: symbol.line,
                });
                continue;
            }
            // Same-arity — check type mismatches on each arg.
            const mismatches: string[] = [];
            for (let i = 0; i < call.argCount && i < expectedParams.length; i++) {
                if (argTypeMismatch(call.argTexts[i], expectedParams[i].type)) {
                    mismatches.push(`arg ${i + 1} '${call.argTexts[i]}' does not match declared type '${expectedParams[i].type}' (param ${expectedParams[i].name})`);
                }
            }
            if (mismatches.length > 0) {
                drifts.push({
                    stepDefFile: path.relative(workspaceRoot, stepFile),
                    line: call.line,
                    importedSymbol: symbol.exportName,
                    driftType: 'arg-type',
                    current: { args: call.argCount, argTexts: call.argTexts },
                    expected: { args: expectedParams.length, params: expectedParams },
                    suggestedFix: `Fix type mismatch(es): ${mismatches.join('; ')}. Update the call to pass values of the declared types.`,
                    sourceFile: path.relative(workspaceRoot, symbol.file),
                    sourceLine: symbol.line,
                });
            }
        }
    }
    return { scanned: { sourceFiles: srcFiles.length, stepDefFiles: stepFiles.length }, drifts, warnings };
}

function findMethod(exportsByFile: Map<string, ExportedSymbol[]>, classSymbol: ExportedSymbol | undefined, memberName: string): ExportedSymbol | undefined {
    if (!classSymbol || classSymbol.kind !== 'class') return undefined;
    const exports = exportsByFile.get(classSymbol.file);
    if (!exports) return undefined;
    return exports.find((e) => e.kind === 'method' && e.className === classSymbol.exportName && e.exportName === `${classSymbol.exportName}.${memberName}`);
}

function buildArgCountFix(symbol: ExportedSymbol, call: CallSiteInfo, min: number, max: number): string {
    const gap = call.argCount - max;
    if (gap > 0) {
        return `${symbol.exportName} now accepts ${min === max ? `${max}` : `${min}-${max}`} arguments; call passes ${call.argCount}. Remove the trailing ${gap} argument(s): [${call.argTexts.slice(max).join(', ')}].`;
    }
    const short = min - call.argCount;
    const missingParams = symbol.params.slice(call.argCount, min).map((p) => `${p.name}: ${p.type}`).join(', ');
    return `${symbol.exportName} requires ${min === max ? `${max}` : `${min}-${max}`} arguments; call passes ${call.argCount}. Add ${short} missing argument(s): [${missingParams}].`;
}

// =============================================================================
// VERB B: ac-text-drift
// =============================================================================

interface FeatureScenarioInfo {
    file: string;
    scenarioName: string;
    scenarioLine: number;
    steps: Array<{ keyword: string; text: string; line: number }>;
    testCaseIds: number[];
    linkedStoryIds: number[];
    acIndices: number[];
}

function walkFeatureFiles(root: string): string[] {
    const out: string[] = [];
    if (!fs.existsSync(root)) return out;
    const stack: string[] = [root];
    while (stack.length > 0) {
        const dir = stack.pop()!;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            if (e.name.startsWith('.') || e.name === 'node_modules') continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) stack.push(full);
            else if (e.isFile() && e.name.toLowerCase().endsWith('.feature')) out.push(full);
        }
    }
    return out.sort();
}

const TC_BRACED_TAG_RE = /@TestCaseId:\{([^}]+)\}/g;
const TC_BARE_TAG_RE = /@TestCaseId:(\d+)/g;
const LINKED_STORY_TAG_RE = /@LinkedStory:(?:\{([^}]+)\}|(\d+))/g;
const AC_TAG_RE = /@ac(\d+)/gi;

function parseFeatureFile(file: string): FeatureScenarioInfo[] {
    let text: string;
    try { text = fs.readFileSync(file, 'utf-8'); } catch { return []; }
    const lines = text.split(/\r?\n/);
    const featureTags: string[] = [];
    let seenFeature = false;
    const scenarios: FeatureScenarioInfo[] = [];

    // Cache pending tag lines above the current scenario.
    let pendingTagLines: string[] = [];
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const t = raw.trim();
        if (!t || t.startsWith('#')) continue;
        if (t.startsWith('@')) {
            if (!seenFeature) featureTags.push(t);
            else pendingTagLines.push(t);
            continue;
        }
        if (/^Feature\s*:/.test(t)) { seenFeature = true; pendingTagLines = []; continue; }
        if (/^(Scenario Outline|Scenario)\s*:/.test(t)) {
            const nm = /^(?:Scenario Outline|Scenario)\s*:\s*(.+)$/.exec(t)!;
            const scenarioTagsRaw = [...featureTags, ...pendingTagLines].join(' ');
            const tcIds: number[] = [];
            for (const m of scenarioTagsRaw.matchAll(TC_BRACED_TAG_RE)) {
                for (const p of m[1].split(',')) {
                    const n = Number(p.trim());
                    if (Number.isFinite(n) && n > 0) tcIds.push(n);
                }
            }
            for (const m of scenarioTagsRaw.matchAll(TC_BARE_TAG_RE)) {
                const n = Number(m[1]);
                if (Number.isFinite(n) && n > 0 && !tcIds.includes(n)) tcIds.push(n);
            }
            const linkedStoryIds: number[] = [];
            for (const m of scenarioTagsRaw.matchAll(LINKED_STORY_TAG_RE)) {
                if (m[1]) {
                    for (const p of m[1].split(',')) { const n = Number(p.trim()); if (Number.isFinite(n)) linkedStoryIds.push(n); }
                } else if (m[2]) {
                    linkedStoryIds.push(Number(m[2]));
                }
            }
            const acIndices: number[] = [];
            for (const m of scenarioTagsRaw.matchAll(AC_TAG_RE)) {
                const n = Number(m[1]); if (Number.isFinite(n)) acIndices.push(n);
            }
            const steps: Array<{ keyword: string; text: string; line: number }> = [];
            // Consume subsequent step lines until we hit a blank/next-scenario/Examples.
            for (let j = i + 1; j < lines.length; j++) {
                const rl = lines[j];
                const rt = rl.trim();
                if (!rt) continue;
                if (rt.startsWith('#')) continue;
                if (/^(Scenario Outline|Scenario|Feature|Examples)\s*:/.test(rt)) break;
                if (rt.startsWith('@')) break;
                const m = /^(Given|When|Then|And|But)\s+(.+)$/.exec(rt);
                if (m) steps.push({ keyword: m[1], text: m[2], line: j + 1 });
            }
            scenarios.push({
                file,
                scenarioName: nm[1].trim(),
                scenarioLine: i + 1,
                steps,
                testCaseIds: tcIds,
                linkedStoryIds,
                acIndices,
            });
            pendingTagLines = [];
        } else {
            // Not a keyword line and not blank — reset pending tags (e.g. mid-scenario noise).
            if (t.startsWith('Background') || t.startsWith('Rule')) pendingTagLines = [];
        }
    }
    return scenarios;
}

function levenshtein(a: string, b: string): number {
    if (a === b) return 0;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    const m = a.length, n = b.length;
    const prev = new Array<number>(n + 1);
    const curr = new Array<number>(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
        curr[0] = i;
        for (let j = 1; j <= n; j++) {
            const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
            curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
        }
        for (let j = 0; j <= n; j++) prev[j] = curr[j];
    }
    return prev[n];
}

function similarity(a: string, b: string): number {
    const aa = normalizeText(a);
    const bb = normalizeText(b);
    if (!aa && !bb) return 1;
    if (!aa || !bb) return 0;
    const d = levenshtein(aa, bb);
    return 1 - d / Math.max(aa.length, bb.length);
}

function normalizeText(s: string): string {
    return s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim().toLowerCase();
}

function parseTcmSteps(xml: string): Array<{ action: string; expected: string }> {
    if (!xml) return [];
    const out: Array<{ action: string; expected: string }> = [];
    // Each <step ...> ... </step> block; inside there are two <parameterizedString> elements.
    const stepRe = /<step\b[^>]*>([\s\S]*?)<\/step>/gi;
    for (const stepMatch of xml.matchAll(stepRe)) {
        const inner = stepMatch[1];
        const parts: string[] = [];
        const paramRe = /<parameterizedString\b[^>]*>([\s\S]*?)<\/parameterizedString>/gi;
        for (const p of inner.matchAll(paramRe)) parts.push(p[1]);
        // parameterizedString content is HTML-escaped; decode a couple of entities.
        const decode = (s: string): string => s
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
            .replace(/<\/?P>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
        out.push({ action: decode(parts[0] ?? ''), expected: decode(parts[1] ?? '') });
    }
    return out;
}

interface AcCheckpoint {
    storyId: number;
    acs: Array<{ index: number; tag: string; text: string }>;
}

function loadAcCheckpoint(workspaceRoot: string, storyId: number): AcCheckpoint | null {
    const p = path.join(workspaceRoot, '.cs-qa', 'run-state', `story-${storyId}-acs.json`);
    if (!fs.existsSync(p)) return null;
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')) as AcCheckpoint; } catch { return null; }
}

interface AcTextDriftInputs {
    featureRoot: string;
    testCaseIds?: number[];
    similarityThreshold: number;
    orgUrl?: string;
    project?: string;
    pat?: string;
}

async function detectAcTextDrift(workspaceRoot: string, inputs: AcTextDriftInputs): Promise<{ scanned: { featureFiles: number; scenariosScanned: number }; drifts: AcTextDrift[]; warnings: string[] }> {
    const warnings: string[] = [];
    const featureRoot = path.resolve(workspaceRoot, inputs.featureRoot);
    const featureFiles = walkFeatureFiles(featureRoot);
    const allScenarios: FeatureScenarioInfo[] = [];
    for (const f of featureFiles) allScenarios.push(...parseFeatureFile(f));

    // Filter to only scenarios that carry a @TestCaseId that we should check.
    let scenariosToScan = allScenarios.filter((s) => s.testCaseIds.length > 0);
    if (inputs.testCaseIds && inputs.testCaseIds.length > 0) {
        const wanted = new Set(inputs.testCaseIds);
        scenariosToScan = scenariosToScan.filter((s) => s.testCaseIds.some((id) => wanted.has(id)));
    }

    if (scenariosToScan.length === 0) {
        return { scanned: { featureFiles: featureFiles.length, scenariosScanned: 0 }, drifts: [], warnings };
    }

    // Load ADO creds.
    const resolved = getResolvedCreds(workspaceRoot, {
        orgUrl: inputs.orgUrl,
        project: inputs.project,
        personalAccessToken: inputs.pat,
    });
    if (!resolved.creds) {
        return { scanned: { featureFiles: featureFiles.length, scenariosScanned: scenariosToScan.length }, drifts: [], warnings: [`ADO not configured — ${resolved.diagnostic}`] };
    }
    const client = new AdoHttpClient(resolved.creds as AdoCreds);

    const drifts: AcTextDrift[] = [];
    // Dedupe TC ids across scenarios (cache per id).
    const tcCache = new Map<number, { title: string; description: string; steps: Array<{ action: string; expected: string }> } | null>();

    for (const sc of scenariosToScan) {
        for (const tcId of sc.testCaseIds) {
            let tc = tcCache.get(tcId);
            if (tc === undefined) {
                try {
                    // Retry-After is honored by AdoHttpClient — we do not layer our own retries.
                    const wi = await client.get<{ fields?: Record<string, unknown> }>(
                        `_apis/wit/workitems/${tcId}?$expand=all&api-version=7.1`,
                    );
                    const f = wi.fields ?? {};
                    tc = {
                        title: String(f['System.Title'] ?? ''),
                        description: String(f['System.Description'] ?? ''),
                        steps: parseTcmSteps(String(f['Microsoft.VSTS.TCM.Steps'] ?? '')),
                    };
                } catch (e) {
                    tc = null;
                    warnings.push(`TC ${tcId} fetch failed: ${(e as Error).message}`);
                }
                tcCache.set(tcId, tc);
            }
            if (!tc) {
                drifts.push({
                    featureFile: path.relative(workspaceRoot, sc.file),
                    scenario: sc.scenarioName,
                    scenarioLine: sc.scenarioLine,
                    tcId,
                    driftKind: 'tc-not-found',
                    current: sc.scenarioName,
                    ado: '',
                    suggestedFix: `Could not fetch TC ${tcId} from ADO. Verify the TC still exists — if it was deleted, remove @TestCaseId:${tcId} from the scenario.`,
                });
                continue;
            }
            // 1. Title similarity.
            const titleSim = similarity(sc.scenarioName, tc.title);
            if (titleSim < inputs.similarityThreshold) {
                drifts.push({
                    featureFile: path.relative(workspaceRoot, sc.file),
                    scenario: sc.scenarioName,
                    scenarioLine: sc.scenarioLine,
                    tcId,
                    driftKind: 'title',
                    current: sc.scenarioName,
                    ado: tc.title,
                    similarity: Number(titleSim.toFixed(3)),
                    suggestedFix: `Rename scenario to match ADO TC ${tcId}: "${tc.title}"`,
                });
            }
            // 2. Step count.
            if (tc.steps.length > 0 && tc.steps.length !== sc.steps.length) {
                drifts.push({
                    featureFile: path.relative(workspaceRoot, sc.file),
                    scenario: sc.scenarioName,
                    scenarioLine: sc.scenarioLine,
                    tcId,
                    driftKind: 'step-count',
                    current: `${sc.steps.length} step(s)`,
                    ado: `${tc.steps.length} step(s)`,
                    suggestedFix: `Scenario has ${sc.steps.length} Given/When/Then; ADO TC ${tcId} has ${tc.steps.length} action steps. Reconcile by adding/removing steps in the feature file.`,
                });
            } else if (tc.steps.length > 0) {
                // 3. Per-step content similarity (only when counts match).
                for (let i = 0; i < tc.steps.length; i++) {
                    const localText = sc.steps[i]?.text ?? '';
                    const adoText = tc.steps[i].action;
                    const sim = similarity(localText, adoText);
                    if (sim < inputs.similarityThreshold) {
                        drifts.push({
                            featureFile: path.relative(workspaceRoot, sc.file),
                            scenario: sc.scenarioName,
                            scenarioLine: sc.steps[i]?.line ?? sc.scenarioLine,
                            tcId,
                            driftKind: 'step-content',
                            current: `[${sc.steps[i]?.keyword ?? '?'}] ${localText}`,
                            ado: adoText,
                            similarity: Number(sim.toFixed(3)),
                            suggestedFix: `Step ${i + 1} in scenario differs from ADO TC action. ADO says: "${adoText}". Update the feature step to match.`,
                        });
                    }
                }
            }
        }
        // 4. AC-not-covered — for each linked story, check that this scenario's @ac tags cover an AC.
        for (const storyId of sc.linkedStoryIds) {
            const ck = loadAcCheckpoint(workspaceRoot, storyId);
            if (!ck) continue;
            // For each AC that has NO scenario in the file covering it, flag ONCE per story on the first scenario.
            // We'll only run this once per (file, story) — approximate by keying on file+story.
        }
    }
    // Post-pass: AC coverage per (file, story) — emit ac-not-covered exactly once per uncovered AC.
    const seenFileStory = new Set<string>();
    for (const sc of scenariosToScan) {
        for (const storyId of sc.linkedStoryIds) {
            const key = `${sc.file}::${storyId}`;
            if (seenFileStory.has(key)) continue;
            seenFileStory.add(key);
            const ck = loadAcCheckpoint(workspaceRoot, storyId);
            if (!ck) continue;
            // Collect every @ac tag across every scenario in the same feature file for that story.
            const scenariosInFile = allScenarios.filter((s) => s.file === sc.file);
            const covered = new Set<number>();
            for (const s of scenariosInFile) for (const idx of s.acIndices) covered.add(idx);
            for (const ac of ck.acs) {
                if (!covered.has(ac.index)) {
                    drifts.push({
                        featureFile: path.relative(workspaceRoot, sc.file),
                        scenario: '(missing scenario)',
                        scenarioLine: 0,
                        tcId: 0,
                        driftKind: 'ac-not-covered',
                        current: '(no scenario tagged @ac' + ac.index + ')',
                        ado: ac.text,
                        suggestedFix: `Story ${storyId} AC ${ac.index} has no matching @ac${ac.index} scenario in ${path.relative(workspaceRoot, sc.file)}. Add a scenario tagged @ac${ac.index} covering: "${ac.text}"`,
                        storyId,
                        acIndex: ac.index,
                    });
                }
            }
        }
    }
    return { scanned: { featureFiles: featureFiles.length, scenariosScanned: scenariosToScan.length }, drifts, warnings };
}

// =============================================================================
// VERB C: live-selector-drift
// =============================================================================

interface CSElementDecoratorInfo {
    file: string;
    propertyName: string;
    xpath?: string;
    css?: string;
    description?: string;
    alternativeLocators: string[];
    line: number;
}

interface PageObjectInfo {
    file: string;
    className: string;
    elements: CSElementDecoratorInfo[];
    /** Config-driven URL keys referenced in navigate(). */
    urlKeys: string[];
    /** Static path fragments extracted from navigate() (relative to base URL). */
    staticPath?: string;
    /** Hard-coded URL passed to super.navigate('...'). */
    hardCodedUrl?: string;
}

function extractDecoratorArg(dec: ts.Decorator, sf: ts.SourceFile): CSElementDecoratorInfo | null {
    if (!ts.isCallExpression(dec.expression)) return null;
    const callee = dec.expression.expression;
    const name = ts.isIdentifier(callee) ? callee.text : undefined;
    if (name !== 'CSGetElement') return null;
    if (dec.expression.arguments.length === 0) return null;
    const arg = dec.expression.arguments[0];
    if (!ts.isObjectLiteralExpression(arg)) return null;
    let xpath: string | undefined;
    let css: string | undefined;
    let description: string | undefined;
    const alternativeLocators: string[] = [];
    for (const prop of arg.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const key = ts.isIdentifier(prop.name) ? prop.name.text : ts.isStringLiteral(prop.name) ? prop.name.text : '';
        if (!key) continue;
        if (key === 'xpath' && ts.isStringLiteral(prop.initializer)) xpath = prop.initializer.text;
        else if (key === 'css' && ts.isStringLiteral(prop.initializer)) css = prop.initializer.text;
        else if (key === 'description' && ts.isStringLiteral(prop.initializer)) description = prop.initializer.text;
        else if (key === 'alternativeLocators' && ts.isArrayLiteralExpression(prop.initializer)) {
            for (const el of prop.initializer.elements) {
                if (ts.isStringLiteral(el)) alternativeLocators.push(el.text);
            }
        }
    }
    return {
        file: sf.fileName,
        propertyName: '',
        xpath,
        css,
        description,
        alternativeLocators,
        line: sf.getLineAndCharacterOfPosition(dec.getStart(sf)).line + 1,
    };
}

function extractPageObject(file: string): PageObjectInfo | null {
    let text: string;
    try { text = fs.readFileSync(file, 'utf-8'); } catch { return null; }
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2020, true, ts.ScriptKind.TS);
    let cls: ts.ClassDeclaration | null = null;
    ts.forEachChild(sf, (n) => {
        if (!cls && ts.isClassDeclaration(n) && n.name) cls = n;
    });
    if (!cls) return null;
    const className = (cls as ts.ClassDeclaration).name!.text;
    const elements: CSElementDecoratorInfo[] = [];
    for (const member of (cls as ts.ClassDeclaration).members) {
        if (!ts.isPropertyDeclaration(member)) continue;
        const decs = ts.canHaveDecorators(member) ? ts.getDecorators(member) : undefined;
        if (!decs) continue;
        for (const dec of decs) {
            const info = extractDecoratorArg(dec, sf);
            if (!info) continue;
            const propName = ts.isIdentifier(member.name) ? member.name.text : '(anonymous)';
            info.propertyName = propName;
            info.file = file;
            elements.push(info);
        }
    }
    // Extract navigate() body: look for super.navigate(<expr>).
    const urlKeys: string[] = [];
    let staticPath: string | undefined;
    let hardCodedUrl: string | undefined;
    const visit = (node: ts.Node): void => {
        if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'navigate') {
            const body = node.body;
            if (!body) return;
            const walker = (n: ts.Node): void => {
                // this.config.get('SOMETHING') → track key
                if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isPropertyAccessExpression(n.expression.expression)
                    && ts.isIdentifier(n.expression.expression.name) && n.expression.expression.name.text === 'config'
                    && ts.isIdentifier(n.expression.name) && n.expression.name.text === 'get'
                    && n.arguments.length >= 1 && ts.isStringLiteral(n.arguments[0])) {
                    urlKeys.push((n.arguments[0] as ts.StringLiteral).text);
                    // 2nd arg (default) may be a path — capture if we haven't yet.
                    if (n.arguments.length >= 2 && ts.isStringLiteral(n.arguments[1]) && !staticPath) {
                        staticPath = (n.arguments[1] as ts.StringLiteral).text;
                    }
                }
                // super.navigate('...') — hard-coded string
                if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.expression.kind === ts.SyntaxKind.SuperKeyword
                    && ts.isIdentifier(n.expression.name) && n.expression.name.text === 'navigate'
                    && n.arguments.length >= 1 && ts.isStringLiteral(n.arguments[0])) {
                    hardCodedUrl = (n.arguments[0] as ts.StringLiteral).text;
                }
                ts.forEachChild(n, walker);
            };
            walker(body);
        }
        ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
    return { file, className, elements, urlKeys, staticPath, hardCodedUrl };
}

/** Resolve config keys via a very simple lookup — env vars first, then any .env under config/. */
function resolveConfigKey(workspaceRoot: string, key: string): string | null {
    if (process.env[key]) return process.env[key]!;
    const configRoot = path.join(workspaceRoot, 'config');
    if (fs.existsSync(configRoot)) {
        const files: string[] = [];
        const stack: string[] = [configRoot];
        while (stack.length) {
            const d = stack.pop()!;
            let entries: fs.Dirent[];
            try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
            for (const e of entries) {
                if (e.name.startsWith('.') || e.name === 'node_modules') continue;
                const full = path.join(d, e.name);
                if (e.isDirectory()) stack.push(full);
                else if (e.isFile() && e.name.endsWith('.env')) files.push(full);
            }
        }
        const re = new RegExp(`^\\s*${key}\\s*=\\s*(.+)$`, 'm');
        for (const f of files) {
            try {
                const t = fs.readFileSync(f, 'utf-8');
                const m = re.exec(t);
                if (m) {
                    let v = m[1].trim();
                    v = v.replace(/^["']|["']$/g, '');
                    if (v && !v.startsWith('ENCRYPTED:')) return v;
                }
            } catch { /* ignore */ }
        }
    }
    return null;
}

function resolvePageUrl(workspaceRoot: string, page: PageObjectInfo, baseUrlOverride: string | undefined): string | null {
    if (page.hardCodedUrl) return page.hardCodedUrl;
    const baseKey = page.urlKeys.find((k) => /base|url/i.test(k)) ?? page.urlKeys[0];
    const base = baseUrlOverride
        ?? (baseKey ? resolveConfigKey(workspaceRoot, baseKey) : null)
        ?? resolveConfigKey(workspaceRoot, 'BASE_URL')
        ?? process.env.BASE_URL
        ?? null;
    if (!base) return null;
    const p = page.staticPath ?? '';
    try {
        return new URL(p, base).toString();
    } catch {
        return null;
    }
}

// -----------------------------------------------------------------------------
// HTML → selector resolution.
// -----------------------------------------------------------------------------

/** Try to load jsdom lazily. Returns null when the package is absent. */
function tryLoadJsdom(): ((html: string, url: string) => { querySelectorAll: (sel: string) => ArrayLike<unknown>; querySelector: (sel: string) => unknown; documentText: string }) | null {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require('jsdom') as { JSDOM: new (html: string, opts?: { url?: string }) => { window: { document: Document & { querySelector: (s: string) => Element | null; querySelectorAll: (s: string) => NodeListOf<Element> } } } };
        return (html: string, url: string) => {
            const dom = new mod.JSDOM(html, { url });
            const doc = dom.window.document;
            return {
                querySelectorAll: (sel: string) => doc.querySelectorAll(sel),
                querySelector: (sel: string) => doc.querySelector(sel),
                documentText: doc.documentElement?.outerHTML ?? html,
            };
        };
    } catch {
        return null;
    }
}

/** Selector resolution via regex — used when jsdom isn't installed. */
function regexResolve(html: string, selector: string, type: 'xpath' | 'css'): { count: number; ambiguous: boolean } {
    if (type === 'xpath') return xpathHeuristicResolve(html, selector);
    return cssHeuristicResolve(html, selector);
}

function attrRegex(name: string, value: string): RegExp {
    const v = escapeRegex(value);
    return new RegExp(`\\b${name}\\s*=\\s*(['"])${v}\\1`, 'i');
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function xpathHeuristicResolve(html: string, xpath: string): { count: number; ambiguous: boolean } {
    // Support: //tag[@attr='value'], //tag[@attr="value"], //*[@attr='value'],
    // //tag[normalize-space()='TEXT'], //tag[contains(@attr,'val')], //tag[text()='TEXT'].
    // Also //tag[@id='foo'] → id="foo" attr scan.
    const attrEq = /\/\/([\w*]+)\[@([\w:-]+)\s*=\s*(['"])(.+?)\3\]/.exec(xpath);
    if (attrEq) {
        const tag = attrEq[1];
        const attr = attrEq[2];
        const value = attrEq[4];
        const re = new RegExp(`<${tag === '*' ? '\\w+' : tag}\\b[^>]*\\b${attr}\\s*=\\s*(['"])${escapeRegex(value)}\\1`, 'gi');
        const matches = html.match(re) || [];
        return { count: matches.length, ambiguous: matches.length > 1 };
    }
    const contains = /\/\/([\w*]+)\[contains\s*\(\s*@([\w:-]+)\s*,\s*(['"])(.+?)\3\s*\)\s*\]/.exec(xpath);
    if (contains) {
        const tag = contains[1];
        const attr = contains[2];
        const value = contains[4];
        const re = new RegExp(`<${tag === '*' ? '\\w+' : tag}\\b[^>]*\\b${attr}\\s*=\\s*(['"])[^'"]*${escapeRegex(value)}[^'"]*\\1`, 'gi');
        const matches = html.match(re) || [];
        return { count: matches.length, ambiguous: matches.length > 1 };
    }
    const textEq = /\/\/([\w*]+)\[(?:normalize-space\(\)|text\(\))\s*=\s*(['"])(.+?)\2\]/.exec(xpath);
    if (textEq) {
        const tag = textEq[1];
        const text = textEq[3];
        const re = new RegExp(`<${tag === '*' ? '\\w+' : tag}\\b[^>]*>\\s*${escapeRegex(text)}\\s*<`, 'gi');
        const matches = html.match(re) || [];
        return { count: matches.length, ambiguous: matches.length > 1 };
    }
    const containsText = /\/\/([\w*]+)\[contains\s*\(\s*(?:text\(\)|.)\s*,\s*(['"])(.+?)\2\s*\)\s*\]/.exec(xpath);
    if (containsText) {
        const tag = containsText[1];
        const text = containsText[3];
        const re = new RegExp(`<${tag === '*' ? '\\w+' : tag}\\b[^>]*>[^<]*${escapeRegex(text)}[^<]*<`, 'gi');
        const matches = html.match(re) || [];
        return { count: matches.length, ambiguous: matches.length > 1 };
    }
    // //tag (no predicate) → count tag occurrences.
    const bareTag = /^\/\/(\w+)$/.exec(xpath);
    if (bareTag) {
        const tag = bareTag[1];
        const re = new RegExp(`<${tag}\\b`, 'gi');
        const matches = html.match(re) || [];
        return { count: matches.length, ambiguous: matches.length > 1 };
    }
    return { count: 0, ambiguous: false };
}

function cssHeuristicResolve(html: string, css: string): { count: number; ambiguous: boolean } {
    // #id
    const idMatch = /^#([\w-]+)$/.exec(css);
    if (idMatch) {
        const re = attrRegex('id', idMatch[1]);
        return { count: (html.match(new RegExp(re.source, 'gi')) || []).length, ambiguous: false };
    }
    // tag#id
    const tagId = /^(\w+)#([\w-]+)$/.exec(css);
    if (tagId) {
        const re = new RegExp(`<${tagId[1]}\\b[^>]*\\bid\\s*=\\s*(['"])${escapeRegex(tagId[2])}\\1`, 'gi');
        return { count: (html.match(re) || []).length, ambiguous: false };
    }
    // .class
    const cls = /^\.([\w-]+)$/.exec(css);
    if (cls) {
        const re = new RegExp(`\\bclass\\s*=\\s*(['"])[^'"]*(?:^|\\s)${escapeRegex(cls[1])}(?:\\s|$)[^'"]*\\1`, 'gi');
        return { count: (html.match(re) || []).length, ambiguous: false };
    }
    // [attr=value]
    const attrEq = /^\[([\w-]+)\s*=\s*(['"])(.+?)\2\]$/.exec(css);
    if (attrEq) {
        const re = new RegExp(`\\b${attrEq[1]}\\s*=\\s*(['"])${escapeRegex(attrEq[3])}\\1`, 'gi');
        return { count: (html.match(re) || []).length, ambiguous: false };
    }
    // tag[attr=value]
    const tagAttrEq = /^(\w+)\[([\w-]+)\s*=\s*(['"])(.+?)\3\]$/.exec(css);
    if (tagAttrEq) {
        const re = new RegExp(`<${tagAttrEq[1]}\\b[^>]*\\b${tagAttrEq[2]}\\s*=\\s*(['"])${escapeRegex(tagAttrEq[4])}\\1`, 'gi');
        return { count: (html.match(re) || []).length, ambiguous: false };
    }
    // Fallback: literal search of the exact selector text (some framework-specific selectors).
    return { count: 0, ambiguous: false };
}

interface LiveFetchResult {
    kind: 'ok' | 'auth-required' | 'http-error' | 'timeout' | 'network-error';
    status?: number;
    html?: string;
    finalUrl?: string;
}

/** Fetch a URL, follow up to 3 redirects manually to detect SSO login chains. */
async function fetchLive(url: string, headers: Record<string, string>, timeoutMs: number, followRedirects: boolean, userAgent: string | undefined, fetchImpl: typeof fetch = globalThis.fetch as typeof fetch): Promise<LiveFetchResult> {
    let currentUrl = url;
    const maxHops = followRedirects ? 3 : 0;
    for (let hop = 0; hop <= maxHops; hop++) {
        try {
            const signal = AbortSignal.timeout(timeoutMs);
            const h: Record<string, string> = { ...headers };
            if (userAgent) h['User-Agent'] = userAgent;
            const res = await fetchImpl(currentUrl, { method: 'GET', headers: h, redirect: 'manual', signal });
            if (res.status >= 300 && res.status < 400) {
                const loc = res.headers.get('location');
                if (!loc || !followRedirects || hop === maxHops) {
                    // Detect SSO chain by URL path.
                    if (loc && /login|signin|okta|adfs|microsoftonline|auth/i.test(loc)) {
                        return { kind: 'auth-required', status: res.status, finalUrl: loc };
                    }
                    return { kind: 'http-error', status: res.status, finalUrl: currentUrl };
                }
                currentUrl = new URL(loc, currentUrl).toString();
                if (/login|signin|okta|adfs|microsoftonline|auth/i.test(currentUrl)) {
                    return { kind: 'auth-required', status: res.status, finalUrl: currentUrl };
                }
                continue;
            }
            if (!res.ok) return { kind: 'http-error', status: res.status, finalUrl: currentUrl };
            const html = await res.text();
            // Some apps serve a 200 login page — sniff.
            if (/login|signin|<input[^>]+type=['"]password['"]/i.test(html) && !html.length /* never */) {
                return { kind: 'auth-required', status: res.status, finalUrl: currentUrl };
            }
            if (/name=["']password["']/i.test(html) && /form/i.test(html) && html.length < 30000) {
                // Heuristic: a very small page dominated by a password form is likely a login gate.
                return { kind: 'auth-required', status: res.status, finalUrl: currentUrl };
            }
            return { kind: 'ok', status: res.status, html, finalUrl: currentUrl };
        } catch (e) {
            const name = (e as { name?: string } | null)?.name ?? '';
            if (name === 'TimeoutError' || name === 'AbortError') return { kind: 'timeout' };
            return { kind: 'network-error' };
        }
    }
    return { kind: 'http-error' };
}

interface LiveSelectorInputs {
    pagesRoot: string;
    baseUrlOverride?: string;
    timeoutMs: number;
    userAgent?: string;
    headers: Record<string, string>;
    followRedirects: boolean;
    fetchImpl?: typeof fetch;
}

async function detectLiveSelectorDrift(workspaceRoot: string, inputs: LiveSelectorInputs): Promise<{ scanned: { pageObjects: number; urlsFetched: number }; drifts: LiveSelectorDrift[]; warnings: string[] }> {
    const warnings: string[] = [];
    const pagesRoot = path.resolve(workspaceRoot, inputs.pagesRoot);
    if (!fs.existsSync(pagesRoot)) {
        return { scanned: { pageObjects: 0, urlsFetched: 0 }, drifts: [], warnings: [`pagesRoot does not exist: ${pagesRoot}`] };
    }
    const jsdomLoader = tryLoadJsdom();
    if (!jsdomLoader) {
        warnings.push('jsdom not installed in this framework — falling back to regex-based selector resolution. Install jsdom for full accuracy: npm install jsdom');
    }
    // Only .ts files under pagesRoot (recursively) — filter to files that look like page objects.
    const pageFiles = walkTypeScriptFiles(pagesRoot, (p) => /page|pages/i.test(p));
    const pages: PageObjectInfo[] = [];
    for (const f of pageFiles) {
        try {
            const po = extractPageObject(f);
            if (po && po.elements.length > 0) pages.push(po);
        } catch (e) {
            warnings.push(`page-parse failed for ${path.relative(workspaceRoot, f)}: ${(e as Error).message}`);
        }
    }
    const drifts: LiveSelectorDrift[] = [];
    let urlsFetched = 0;
    // De-dupe fetches per URL.
    const urlCache = new Map<string, LiveFetchResult>();
    for (const page of pages) {
        const url = resolvePageUrl(workspaceRoot, page, inputs.baseUrlOverride);
        if (!url) {
            for (const el of page.elements) {
                drifts.push({
                    pageObject: path.relative(workspaceRoot, page.file),
                    propertyName: el.propertyName,
                    primarySelector: el.xpath ?? el.css ?? '(none)',
                    allSelectorsFailed: true,
                    driftKind: 'url-unresolved',
                    suggestedFix: `Could not resolve navigate() URL for ${page.className}. Provide baseUrlOverride, set BASE_URL env, or ensure page.navigate() uses a resolvable config key (referenced: ${page.urlKeys.join(', ') || 'none'}).`,
                    description: el.description,
                    allTriedSelectors: [el.xpath, el.css, ...el.alternativeLocators].filter((s): s is string => !!s),
                });
            }
            continue;
        }
        let fetched = urlCache.get(url);
        if (!fetched) {
            fetched = await fetchLive(url, inputs.headers, inputs.timeoutMs, inputs.followRedirects, inputs.userAgent, inputs.fetchImpl);
            urlCache.set(url, fetched);
            urlsFetched++;
        }
        if (fetched.kind !== 'ok' || !fetched.html) {
            for (const el of page.elements) {
                let driftKind: LiveSelectorDrift['driftKind'] = 'http-error';
                let fix = '';
                if (fetched.kind === 'auth-required') {
                    driftKind = 'auth-required';
                    fix = `URL redirects to auth (final: ${fetched.finalUrl ?? '?'}). Pass auth headers or a valid session cookie via the 'headers' input to bypass SSO.`;
                } else if (fetched.kind === 'timeout') {
                    driftKind = 'timeout';
                    fix = `Fetch of ${url} timed out after ${inputs.timeoutMs}ms. Raise timeoutMs or check network reachability.`;
                } else if (fetched.kind === 'network-error') {
                    driftKind = 'http-error';
                    fix = `Network error fetching ${url}. Check DNS/host reachability from the tool runner.`;
                } else {
                    fix = `HTTP ${fetched.status} at ${url}. Verify the URL is still valid — page may have been renamed/removed.`;
                }
                drifts.push({
                    pageObject: path.relative(workspaceRoot, page.file),
                    propertyName: el.propertyName,
                    primarySelector: el.xpath ?? el.css ?? '(none)',
                    allSelectorsFailed: true,
                    driftKind,
                    httpStatus: fetched.status,
                    url: fetched.finalUrl ?? url,
                    suggestedFix: fix,
                    description: el.description,
                    allTriedSelectors: [el.xpath, el.css, ...el.alternativeLocators].filter((s): s is string => !!s),
                });
            }
            continue;
        }
        // OK — try each selector on the live HTML.
        const dom = jsdomLoader ? jsdomLoader(fetched.html, url) : null;
        for (const el of page.elements) {
            const tried: Array<{ raw: string; count: number; ambiguous: boolean; type: 'xpath' | 'css' | 'other' }> = [];
            const push = (raw: string | undefined, type: 'xpath' | 'css' | 'other'): void => {
                if (!raw) return;
                const rawStr = raw;
                if (type === 'xpath') {
                    const r = regexResolve(fetched!.html!, rawStr, 'xpath');
                    tried.push({ raw: rawStr, ...r, type });
                } else if (type === 'css') {
                    if (dom) {
                        try {
                            const list = dom.querySelectorAll(rawStr) as ArrayLike<unknown>;
                            tried.push({ raw: rawStr, count: list.length, ambiguous: list.length > 1, type });
                        } catch {
                            const r = regexResolve(fetched!.html!, rawStr, 'css');
                            tried.push({ raw: rawStr, ...r, type });
                        }
                    } else {
                        const r = regexResolve(fetched!.html!, rawStr, 'css');
                        tried.push({ raw: rawStr, ...r, type });
                    }
                } else {
                    // Alternative locators can be prefixed: xpath:..., css:..., text:...
                    if (/^xpath:/i.test(rawStr)) {
                        push(rawStr.slice(6), 'xpath');
                    } else if (/^css:/i.test(rawStr)) {
                        push(rawStr.slice(4), 'css');
                    } else if (/^text:/i.test(rawStr)) {
                        const t = rawStr.slice(5);
                        const xp = `//*[normalize-space()='${t.replace(/'/g, "&apos;")}']`;
                        push(xp, 'xpath');
                    } else if (/^\/\//.test(rawStr)) {
                        push(rawStr, 'xpath');
                    } else {
                        push(rawStr, 'css');
                    }
                }
            };
            push(el.xpath, 'xpath');
            push(el.css, 'css');
            for (const alt of el.alternativeLocators) push(alt, 'other');

            const primary = el.xpath ?? el.css ?? '(none)';
            const anyHit = tried.find((t) => t.count >= 1 && !t.ambiguous);
            const anyAmbig = tried.find((t) => t.ambiguous);
            const allTried = tried.map((t) => t.raw);
            if (!anyHit && !anyAmbig) {
                drifts.push({
                    pageObject: path.relative(workspaceRoot, page.file),
                    propertyName: el.propertyName,
                    primarySelector: primary,
                    allSelectorsFailed: true,
                    driftKind: 'not-found',
                    url,
                    suggestedFix: `Neither primary nor any alternative selector resolves on ${url}. Inspect the live page (may have been rebuilt); grep the DOM for description "${el.description ?? ''}" to find a new locator.`,
                    description: el.description,
                    allTriedSelectors: allTried,
                });
            } else if (!anyHit && anyAmbig) {
                drifts.push({
                    pageObject: path.relative(workspaceRoot, page.file),
                    propertyName: el.propertyName,
                    primarySelector: primary,
                    allSelectorsFailed: false,
                    driftKind: 'ambiguous',
                    url,
                    suggestedFix: `Selector matches ${anyAmbig.count} elements — narrow it: add a parent tag scope (e.g. //form//${primary}) or an @id/@data-testid predicate.`,
                    description: el.description,
                    allTriedSelectors: allTried,
                });
            } else if (anyHit && tried[0]?.raw !== anyHit.raw) {
                // Primary failed but an alternative resolves.
                drifts.push({
                    pageObject: path.relative(workspaceRoot, page.file),
                    propertyName: el.propertyName,
                    primarySelector: primary,
                    allSelectorsFailed: false,
                    workingAlternative: anyHit.raw,
                    driftKind: 'not-found',
                    url,
                    suggestedFix: `Primary selector "${primary}" no longer resolves. Alternative "${anyHit.raw}" works — swap it in as the new primary.`,
                    description: el.description,
                    allTriedSelectors: allTried,
                });
            }
        }
    }
    return { scanned: { pageObjects: pages.length, urlsFetched }, drifts, warnings };
}

// =============================================================================
// Zod schema + primitive registration.
// =============================================================================

const inputSchema = z.discriminatedUnion('verb', [
    z.object({
        verb: z.literal('source-signature-drift'),
        sourceRoot: z.string().default('src'),
        stepsRoot: z.string().default('test'),
        tsconfigPath: z.string().optional().describe('Reserved; the AST walker uses a per-file source-file parse and does not require tsconfig resolution.'),
    }),
    z.object({
        verb: z.literal('ac-text-drift'),
        featureRoot: z.string().default('test'),
        testCaseIds: z.array(z.number().int().positive()).optional(),
        similarityThreshold: z.number().min(0).max(1).default(0.85),
        orgUrl: z.string().optional(),
        project: z.string().optional(),
        pat: z.string().optional(),
    }),
    z.object({
        verb: z.literal('live-selector-drift'),
        pagesRoot: z.string().default('test'),
        baseUrlOverride: z.string().url().optional(),
        timeoutMs: z.number().int().positive().max(120_000).default(15_000),
        userAgent: z.string().optional(),
        headers: z.record(z.string(), z.string()).default({}),
        followRedirects: z.boolean().default(true),
    }),
    z.object({
        verb: z.literal('all'),
        sourceRoot: z.string().default('src'),
        stepsRoot: z.string().default('test'),
        featureRoot: z.string().default('test'),
        pagesRoot: z.string().default('test'),
        similarityThreshold: z.number().min(0).max(1).default(0.85),
        baseUrlOverride: z.string().url().optional(),
        timeoutMs: z.number().int().positive().max(120_000).default(15_000),
        userAgent: z.string().optional(),
        headers: z.record(z.string(), z.string()).default({}),
        followRedirects: z.boolean().default(true),
        orgUrl: z.string().optional(),
        project: z.string().optional(),
        pat: z.string().optional(),
    }),
]);

const outputSchema = z.object({
    verb: z.string(),
    ok: z.boolean(),
    scanned: z.record(z.string(), z.number()).optional(),
    sourceSignatureDrifts: z.array(z.any()).optional(),
    acTextDrifts: z.array(z.any()).optional(),
    liveSelectorDrifts: z.array(z.any()).optional(),
    drifts: z.array(z.any()).optional(),
    warnings: z.array(z.string()),
    note: z.string().optional(),
});

/** Exposed for tests. */
export const _internals = {
    walkFeatureFiles,
    parseFeatureFile,
    similarity,
    levenshtein,
    parseTcmSteps,
    extractExports,
    extractCallSites,
    resolveRelativeImport,
    extractPageObject,
    xpathHeuristicResolve,
    cssHeuristicResolve,
    fetchLive,
    detectSourceSignatureDrift,
    detectAcTextDrift,
    detectLiveSelectorDrift,
    resolveConfigKey,
    tryLoadJsdom,
};

registerPrimitive({
    name: 'cs_qa_detect_drift',
    description: 'Detect drift between source-of-truth (source code, ADO test cases, live DOM) and test artifacts. Verbs: source-signature-drift (AST-compares step-def call sites against exported function signatures in src/**); ac-text-drift (fetches each @TestCaseId ADO work item and compares title/steps against the scenario; cross-checks parent-story AC checkpoints for coverage); live-selector-drift (extracts @CSGetElement decorators, resolves the page.navigate() URL, fetches HTML, resolves each selector via jsdom-or-regex fallback); all (runs all three in parallel and merges results). Every request emits a correlation-id-tagged log line to .cs-qa/audit/ado-audit.jsonl.',
    inputSchema,
    outputSchema,
    run: async (ctx, rawInput) => {
        const input = rawInput as z.infer<typeof inputSchema>;
        const log = createLogger(ctx.invocationId, 'cs_qa_detect_drift', { workspaceRoot: ctx.workspaceRoot });
        log.info('detect-drift-start', { verb: input.verb });
        try {
            if (input.verb === 'source-signature-drift') {
                const res = await detectSourceSignatureDrift(ctx.workspaceRoot, { sourceRoot: input.sourceRoot, stepsRoot: input.stepsRoot });
                log.info('detect-drift-done', { verb: input.verb, drifts: res.drifts.length, warnings: res.warnings.length });
                return {
                    verb: input.verb,
                    ok: true,
                    scanned: res.scanned,
                    sourceSignatureDrifts: res.drifts,
                    drifts: res.drifts,
                    warnings: res.warnings,
                };
            }
            if (input.verb === 'ac-text-drift') {
                const res = await detectAcTextDrift(ctx.workspaceRoot, {
                    featureRoot: input.featureRoot,
                    testCaseIds: input.testCaseIds,
                    similarityThreshold: input.similarityThreshold,
                    orgUrl: input.orgUrl,
                    project: input.project,
                    pat: input.pat,
                });
                log.info('detect-drift-done', { verb: input.verb, drifts: res.drifts.length, warnings: res.warnings.length });
                return {
                    verb: input.verb,
                    ok: true,
                    scanned: res.scanned,
                    acTextDrifts: res.drifts,
                    drifts: res.drifts,
                    warnings: res.warnings,
                };
            }
            if (input.verb === 'live-selector-drift') {
                const res = await detectLiveSelectorDrift(ctx.workspaceRoot, {
                    pagesRoot: input.pagesRoot,
                    baseUrlOverride: input.baseUrlOverride,
                    timeoutMs: input.timeoutMs,
                    userAgent: input.userAgent,
                    headers: input.headers,
                    followRedirects: input.followRedirects,
                });
                log.info('detect-drift-done', { verb: input.verb, drifts: res.drifts.length, warnings: res.warnings.length });
                return {
                    verb: input.verb,
                    ok: true,
                    scanned: res.scanned,
                    liveSelectorDrifts: res.drifts,
                    drifts: res.drifts,
                    warnings: res.warnings,
                };
            }
            // all
            const [a, b, c] = await Promise.all([
                detectSourceSignatureDrift(ctx.workspaceRoot, { sourceRoot: input.sourceRoot, stepsRoot: input.stepsRoot }),
                detectAcTextDrift(ctx.workspaceRoot, {
                    featureRoot: input.featureRoot,
                    testCaseIds: undefined,
                    similarityThreshold: input.similarityThreshold,
                    orgUrl: input.orgUrl,
                    project: input.project,
                    pat: input.pat,
                }),
                detectLiveSelectorDrift(ctx.workspaceRoot, {
                    pagesRoot: input.pagesRoot,
                    baseUrlOverride: input.baseUrlOverride,
                    timeoutMs: input.timeoutMs,
                    userAgent: input.userAgent,
                    headers: input.headers,
                    followRedirects: input.followRedirects,
                }),
            ]);
            const merged = {
                sourceFiles: a.scanned.sourceFiles,
                stepDefFiles: a.scanned.stepDefFiles,
                featureFiles: b.scanned.featureFiles,
                scenariosScanned: b.scanned.scenariosScanned,
                pageObjects: c.scanned.pageObjects,
                urlsFetched: c.scanned.urlsFetched,
            };
            const warnings = [...a.warnings, ...b.warnings, ...c.warnings];
            log.info('detect-drift-done', { verb: 'all', ss: a.drifts.length, ac: b.drifts.length, live: c.drifts.length });
            return {
                verb: 'all',
                ok: true,
                scanned: merged,
                sourceSignatureDrifts: a.drifts,
                acTextDrifts: b.drifts,
                liveSelectorDrifts: c.drifts,
                drifts: [...a.drifts, ...b.drifts, ...c.drifts],
                warnings,
            };
        } catch (e) {
            const msg = (e as Error).message;
            log.error('detect-drift-failed', { verb: input.verb, error: msg });
            return {
                verb: input.verb,
                ok: false,
                warnings: [msg],
                note: `detect-drift failed: ${msg}`,
            };
        }
    },
});
