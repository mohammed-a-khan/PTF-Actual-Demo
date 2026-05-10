/**
 * Agentic Test Platform — Legacy Analyzer (Rebuild M6, the brain)
 *
 * Recursive Java/C# analyzer. Walks every method call from each `@Test` /
 * `[Test]` method body to leaf-level Selenium primitives, resolves
 * imports across the legacy project, detects login flow, reads referenced
 * data files, and produces a structured `AnalysisReport`.
 *
 * The analysis is regex + line-level (not full AST) — sufficient for the
 * legacy test patterns common in QAF / TestNG / NUnit / xUnit / Cucumber
 * suites. Where ambiguity remains, the LLM fills in via M3's gate engine
 * (3-retry pattern). The structural 80% is deterministic.
 *
 * **Output contract.** A `AnalysisReport` with these top-level fields:
 *   - source            — entry file metadata
 *   - imports           — all import lines + resolution status
 *   - resolvedDeps      — files actually read recursively
 *   - unresolvedDeps    — referenced classes whose source we couldn't find
 *   - tests             — every @Test / [Test] method with full call tree
 *   - loginContract     — detected login pattern + config keys + selectors
 *   - dataReferences    — every external data file referenced (xlsx/csv/xml)
 *   - configReferences  — every property key looked up via Configuration.get / props.get
 *   - dbReferences      — embedded SQL strings discovered
 *   - pageObjects       — page-object classes referenced and their elements
 *   - reuseDecisions    — existing CS Playwright pages that match (rank-ordered)
 *   - gaps              — missing files / configs / pages / data — severities
 *   - outputPlan        — files to write (target paths + content contracts)
 *   - readinessVerdict  — READY | READY_WITH_GAPS | BLOCKED + score 0..1
 *
 * Privacy: the report stores raw class / method names from the legacy
 * source (those are the user's own code). It does NOT phone home or
 * leak any of that — the report lives only in the run folder.
 *
 * @module agent-platform/CSLegacyAnalyzer
 */

import * as fs from 'fs';
import * as path from 'path';
import { LegacyInventory, LegacyFile } from './CSDiscovery';
import { CSLegacyDataReader, LegacyDataResult } from './CSLegacyDataReader';

// ============================================================================
// Public Types
// ============================================================================

export interface AnalysisReport {
    source: SourceMeta;
    imports: ImportInfo[];
    resolvedDeps: string[];      // absolute paths
    unresolvedDeps: UnresolvedDep[];
    tests: TestAnalysis[];
    loginContract: LoginContract;
    dataReferences: DataReference[];
    configReferences: ConfigReference[];
    dbReferences: DbReference[];
    pageObjects: PageObjectInfo[];
    gaps: GapEntry[];
    outputPlan: OutputPlan;
    readinessVerdict: 'READY' | 'READY_WITH_GAPS' | 'BLOCKED';
    readinessScore: number;
    summary: AnalysisSummary;
}

export interface SourceMeta {
    path: string;
    relativePath: string;
    className: string;
    packageName?: string;
    baseClasses: string[];
    annotations: string[];
    sizeBytes: number;
    lineCount: number;
    framework: 'testng-qaf' | 'testng' | 'cucumber-bdd' | 'nunit' | 'xunit' | 'mstest' | 'unknown';
}

export interface ImportInfo {
    raw: string;
    fqcn: string;
    /** 'internal' = same legacy project; 'external' = third-party / stdlib. */
    kind: 'internal' | 'external';
    resolvedPath?: string;
}

export interface UnresolvedDep {
    fqcn: string;
    referencedFrom: string;
    severity: 'high' | 'medium' | 'low';
    reason: string;
}

export interface TestAnalysis {
    methodName: string;
    /** Method-level annotation block, raw. */
    annotationsRaw: string;
    /** Parsed @Test / [Test] / @MetaData fields. */
    annotations: TestAnnotations;
    parameterTypes: string[];
    /** Full method body. */
    body: string;
    /** Recursively resolved call tree. */
    callTree: CallTreeNode;
    dataRefs: string[];           // file paths, resolved against project root
    dbStatements: string[];       // SQL literals encountered
    configKeysUsed: string[];     // property keys looked up
    pagesTouched: string[];       // page class names
    assertionCount: number;       // count of assert* / verify* primitives reached
    leafCallCount: number;        // total Selenium driver / WebElement primitives reached
    /** Suggested Gherkin scenario id derived from name + MetaData. */
    suggestedScenarioId: string;
    suggestedScenarioTitle: string;
    suggestedTags: string[];
}

export interface TestAnnotations {
    testCaseId?: string;
    testName?: string;
    description?: string;
    dataFile?: string;
    dataSheet?: string;
    dataKey?: string;
    groups?: string[];
    enabled?: boolean;
}

/**
 * One node in the call tree. Each node represents a single method call;
 * `children` are the calls made inside that method's body, recursively.
 * `kind = 'leaf'` marks Selenium / WebElement / Assert primitives the
 * recursion bottoms out at.
 */
export interface CallTreeNode {
    /** Display label — `Class.method(...)` or `obj.method(...)`. */
    label: string;
    /** Bare method name (without receiver). */
    methodName: string;
    /** Receiver class when known. */
    receiverClass?: string;
    /** Source file the method was found in. */
    definedIn?: string;
    /** Line in `definedIn`. */
    definedAtLine?: number;
    /** Captured argument literals (best-effort parse). */
    args: string[];
    /** Raw line of source where this call appears. */
    rawLine: string;
    /** Kind tag for downstream rendering. */
    kind: 'helper' | 'page' | 'page_element' | 'assertion' | 'navigate' | 'click' | 'fill' | 'select' | 'wait' | 'config' | 'data' | 'db' | 'leaf' | 'unresolved';
    children: CallTreeNode[];
    /** Why we stopped recursing here ('leaf' / 'unresolved' / 'depth-cap'). */
    stopReason?: string;
}

export interface LoginContract {
    detected: boolean;
    /** 'before-method' / 'before-class' / 'inline-helper' / 'page-object' / 'unknown'. */
    pattern?: 'before-method' | 'before-class' | 'inline-helper' | 'page-object' | 'unknown';
    methodFqcn?: string;
    /** Config keys used by the login (e.g. APP_USERNAME, APP_PASSWORD). */
    configKeys: string[];
    /** Page-object selectors touched by login (xpath/css/id strings). */
    selectors: string[];
    /** True when the legacy test passes a per-row username (from data) — vs a single shared user. */
    perRowUser: boolean;
    /** Suggested Gherkin step text for the migrated suite. */
    suggestedGherkinStep: string;
}

export interface DataReference {
    rawReference: string;
    resolvedPath?: string;
    sheet?: string;
    key?: string;
    sample?: LegacyDataResult;
    severity: 'high' | 'medium' | 'low';
}

export interface ConfigReference {
    key: string;
    referencedAt: string[];
    /** When found in a discovered .properties file. */
    valueFromProperties?: string;
    propertiesPath?: string;
}

export interface DbReference {
    sqlPreview: string;
    type: 'select' | 'insert' | 'update' | 'delete' | 'other';
    table?: string;
    referencedAt: string;
}

export interface PageObjectInfo {
    className: string;
    fqcn?: string;
    sourcePath?: string;
    /** Extracted elements (`@FindBy`, `@QAFTestStep`, etc). */
    elements: PageElement[];
    /** Public methods we resolved at least partially. */
    publicMethods: string[];
}

export interface PageElement {
    fieldName: string;
    locatorType: 'xpath' | 'css' | 'id' | 'name' | 'tagName' | 'linkText' | 'partialLinkText' | 'className' | 'unknown';
    locatorValue: string;
    description?: string;
}

export interface GapEntry {
    severity: 'high' | 'medium' | 'low';
    type: 'missing_file' | 'missing_config' | 'missing_page' | 'missing_data' | 'parse_warning';
    detail: string;
    suggestion: string;
}

export interface OutputPlan {
    project: string;
    module?: string;
    feature: string;
    files: PlannedFile[];
}

export interface PlannedFile {
    relativePath: string;
    kind: 'feature' | 'page' | 'steps' | 'data' | 'config';
    /** Will this file overlap with an existing CS Playwright file? */
    existsInTarget: boolean;
    /** Reuse decision: 'create' / 'reuse_existing' / 'merge'. */
    reuseDecision: 'create' | 'reuse_existing' | 'merge';
    notes?: string;
}

export interface AnalysisSummary {
    testCount: number;
    callTreeAvgDepth: number;
    callTreeMaxDepth: number;
    leafCallTotal: number;
    resolvedDepCount: number;
    unresolvedDepCount: number;
    gapCount: number;
    highSeverityGapCount: number;
}

// ============================================================================
// CSLegacyAnalyzer
// ============================================================================

export class CSLegacyAnalyzer {
    private static readonly MAX_RECURSION_DEPTH = 8;
    /** External-import prefixes we never try to resolve from the project tree. */
    private static readonly EXTERNAL_PREFIXES = [
        'java.', 'javax.', 'org.testng.', 'org.testing.', 'org.junit.',
        'org.openqa.selenium.', 'org.apache.', 'org.slf4j.', 'org.hamcrest.',
        'com.google.', 'com.fasterxml.', 'com.quarry.qaf', 'io.cucumber.',
        'cucumber.', 'NUnit.', 'Microsoft.', 'System.',
    ];

    /**
     * Analyse one entry test file end-to-end.
     */
    public static analyze(
        entryFile: string,
        inventory: LegacyInventory,
        opts?: { project?: string; module?: string; existingPages?: Set<string> },
    ): AnalysisReport {
        const sourceText = fs.readFileSync(entryFile, 'utf-8');
        const sizeBytes = Buffer.byteLength(sourceText);
        const lineCount = sourceText.split(/\r?\n/).length;
        const className = CSLegacyAnalyzer.extractClassName(sourceText, entryFile);
        const packageName = CSLegacyAnalyzer.extractPackage(sourceText);
        const baseClasses = CSLegacyAnalyzer.extractExtendsImplements(sourceText);
        const classAnnotations = CSLegacyAnalyzer.extractClassAnnotations(sourceText);
        const framework = CSLegacyAnalyzer.detectFramework(sourceText);

        const sourceMeta: SourceMeta = {
            path: entryFile,
            relativePath: path.relative(inventory.rootPath, entryFile),
            className,
            packageName,
            baseClasses,
            annotations: classAnnotations,
            sizeBytes,
            lineCount,
            framework,
        };

        const imports = CSLegacyAnalyzer.parseImports(sourceText, inventory);
        const resolvedDeps = imports
            .filter((i) => i.kind === 'internal' && i.resolvedPath)
            .map((i) => i.resolvedPath as string);
        const unresolvedDeps: UnresolvedDep[] = imports
            .filter((i) => i.kind === 'internal' && !i.resolvedPath)
            .map((i) => ({
                fqcn: i.fqcn,
                referencedFrom: entryFile,
                severity: 'medium',
                reason: 'internal import not found in inventory',
            }));

        // Read every resolved internal dep into a method index — used by
        // the call-tree expander to find method bodies.
        const methodIndex = CSLegacyAnalyzer.buildMethodIndex([entryFile, ...resolvedDeps]);

        const tests: TestAnalysis[] = [];
        const dataReferences: DataReference[] = [];
        const configReferencesMap = new Map<string, ConfigReference>();
        const dbReferences: DbReference[] = [];
        const pageObjectsMap = new Map<string, PageObjectInfo>();

        // Walk every @Test method.
        const testBlocks = CSLegacyAnalyzer.extractTestMethods(sourceText);
        for (const tb of testBlocks) {
            const callTree = CSLegacyAnalyzer.expandCallTree(
                tb.body,
                tb.methodName,
                entryFile,
                methodIndex,
                0,
            );
            const ann = CSLegacyAnalyzer.parseTestAnnotations(tb.annotationsRaw);
            const dataFile = ann.dataFile
                ? CSLegacyAnalyzer.resolveDataPath(ann.dataFile, inventory)
                : undefined;

            // Collect leaf-level signals from the tree.
            const visitor = CSLegacyAnalyzer.collectFromTree(callTree);

            // Record data refs.
            if (ann.dataFile) {
                dataReferences.push({
                    rawReference: ann.dataFile,
                    resolvedPath: dataFile?.path,
                    sheet: ann.dataSheet,
                    key: ann.dataKey,
                    sample: dataFile
                        ? CSLegacyDataReader.read(dataFile.path, { sheet: ann.dataSheet })
                        : undefined,
                    severity: dataFile ? 'low' : 'medium',
                });
            }

            // Aggregate config refs.
            for (const k of visitor.configKeys) {
                let cur = configReferencesMap.get(k);
                if (!cur) {
                    const props = CSLegacyAnalyzer.findConfigKeyInProperties(
                        k, inventory,
                    );
                    cur = {
                        key: k,
                        referencedAt: [],
                        valueFromProperties: props?.value,
                        propertiesPath: props?.path,
                    };
                    configReferencesMap.set(k, cur);
                }
                cur.referencedAt.push(`${className}.${tb.methodName}`);
            }

            // Aggregate db refs.
            for (const sql of visitor.sqlStatements) {
                dbReferences.push({
                    sqlPreview: sql.slice(0, 120),
                    type: CSLegacyAnalyzer.classifySql(sql),
                    table: CSLegacyAnalyzer.extractTable(sql),
                    referencedAt: `${className}.${tb.methodName}`,
                });
            }

            // Aggregate pages.
            for (const pageClass of visitor.pageClasses) {
                if (pageObjectsMap.has(pageClass)) continue;
                const file = inventory.pages.find(
                    (p) => path.basename(p, path.extname(p)) === pageClass,
                );
                const info: PageObjectInfo = {
                    className: pageClass,
                    fqcn: undefined,
                    sourcePath: file,
                    elements: file
                        ? CSLegacyAnalyzer.extractPageElements(file)
                        : [],
                    publicMethods: file
                        ? CSLegacyAnalyzer.extractPublicMethods(file)
                        : [],
                };
                pageObjectsMap.set(pageClass, info);
            }

            const callMetrics = CSLegacyAnalyzer.measureTree(callTree);

            const suggestedTags: string[] = [];
            if (ann.testCaseId) suggestedTags.push(`@TS_${ann.testCaseId}`);
            if (ann.groups) for (const g of ann.groups) suggestedTags.push(`@${g}`);

            tests.push({
                methodName: tb.methodName,
                annotationsRaw: tb.annotationsRaw,
                annotations: ann,
                parameterTypes: tb.parameterTypes,
                body: tb.body,
                callTree,
                dataRefs: ann.dataFile && dataFile ? [dataFile.path] : [],
                dbStatements: visitor.sqlStatements,
                configKeysUsed: Array.from(visitor.configKeys),
                pagesTouched: Array.from(visitor.pageClasses),
                assertionCount: visitor.assertionCount,
                leafCallCount: callMetrics.leafCount,
                suggestedScenarioId: ann.testCaseId
                    ? `TS_${ann.testCaseId}`
                    : tb.methodName,
                suggestedScenarioTitle: ann.testName
                    ? ann.testName
                    : CSLegacyAnalyzer.humaniseMethodName(tb.methodName),
                suggestedTags,
            });
        }

        const loginContract = CSLegacyAnalyzer.detectLoginContract(
            sourceText,
            tests,
            methodIndex,
            inventory,
        );

        // Output plan + reuse decisions.
        const project = opts?.project ?? CSLegacyAnalyzer.suggestProjectFromPackage(packageName, className);
        const moduleName = opts?.module;
        const featureSlug = CSLegacyAnalyzer.kebabCase(className);
        const targetPagesPrefix = path.posix.join(
            'test', project, 'pages', moduleName ?? '', '',
        ).replace(/\/$/, '');
        const targetStepsPrefix = path.posix.join(
            'test', project, 'steps', moduleName ?? '', '',
        ).replace(/\/$/, '');
        const targetFeaturesPrefix = path.posix.join(
            'test', project, 'features', moduleName ?? '', '',
        ).replace(/\/$/, '');
        const targetDataPrefix = path.posix.join(
            'test', project, 'data', moduleName ?? '', '',
        ).replace(/\/$/, '');

        const plannedFiles: PlannedFile[] = [];
        plannedFiles.push({
            relativePath: `${targetFeaturesPrefix}/${featureSlug}.feature`,
            kind: 'feature',
            existsInTarget: false,
            reuseDecision: 'create',
        });
        for (const pageInfo of pageObjectsMap.values()) {
            const targetPage = `${targetPagesPrefix}/${pageInfo.className}.ts`;
            const exists = opts?.existingPages?.has(targetPage) === true;
            plannedFiles.push({
                relativePath: targetPage,
                kind: 'page',
                existsInTarget: exists,
                reuseDecision: exists ? 'reuse_existing' : 'create',
                notes: pageInfo.elements.length === 0
                    ? 'no @FindBy elements found in legacy source — manual review of selectors'
                    : undefined,
            });
        }
        plannedFiles.push({
            relativePath: `${targetStepsPrefix}/${featureSlug}.steps.ts`,
            kind: 'steps',
            existsInTarget: false,
            reuseDecision: 'create',
        });
        plannedFiles.push({
            relativePath: `${targetDataPrefix}/${featureSlug}_scenarios.json`,
            kind: 'data',
            existsInTarget: false,
            reuseDecision: 'create',
        });

        const outputPlan: OutputPlan = {
            project,
            module: moduleName,
            feature: featureSlug,
            files: plannedFiles,
        };

        // Gap synthesis.
        const gaps: GapEntry[] = [];
        for (const ud of unresolvedDeps) {
            gaps.push({
                severity: ud.severity,
                type: 'missing_file',
                detail: `Internal class \`${ud.fqcn}\` referenced but not found in project tree (${ud.referencedFrom}).`,
                suggestion: 'Provide the source file or grant the LLM permission to mock its behaviour during translation.',
            });
        }
        for (const dr of dataReferences) {
            if (!dr.resolvedPath) {
                gaps.push({
                    severity: dr.severity,
                    type: 'missing_data',
                    detail: `Data file \`${dr.rawReference}\` referenced but not found.`,
                    suggestion: 'Place the data file at the expected path or override `dataFile=` in the migration plan.',
                });
            }
        }
        for (const cr of configReferencesMap.values()) {
            if (!cr.valueFromProperties) {
                gaps.push({
                    severity: 'low',
                    type: 'missing_config',
                    detail: `Config key \`${cr.key}\` used by tests but not present in any discovered .properties file.`,
                    suggestion: 'Set the key in your `config/<project>/environments/<env>.env`. Encrypted values use the `ENCRYPTED:` prefix.',
                });
            }
        }
        for (const pageInfo of pageObjectsMap.values()) {
            if (!pageInfo.sourcePath) {
                gaps.push({
                    severity: 'high',
                    type: 'missing_page',
                    detail: `Page object \`${pageInfo.className}\` referenced by tests but its source was not found in inventory.`,
                    suggestion: 'Add the page-object source file to the project tree or accept LLM-generated selectors flagged for review.',
                });
            }
        }

        const summary: AnalysisSummary = {
            testCount: tests.length,
            callTreeAvgDepth:
                tests.length === 0
                    ? 0
                    : tests.reduce((s, t) => s + CSLegacyAnalyzer.measureTree(t.callTree).maxDepth, 0)
                        / tests.length,
            callTreeMaxDepth: tests.reduce(
                (m, t) => Math.max(m, CSLegacyAnalyzer.measureTree(t.callTree).maxDepth),
                0,
            ),
            leafCallTotal: tests.reduce((s, t) => s + t.leafCallCount, 0),
            resolvedDepCount: resolvedDeps.length,
            unresolvedDepCount: unresolvedDeps.length,
            gapCount: gaps.length,
            highSeverityGapCount: gaps.filter((g) => g.severity === 'high').length,
        };

        // Readiness verdict.
        let readinessVerdict: AnalysisReport['readinessVerdict'];
        let readinessScore: number;
        if (summary.highSeverityGapCount === 0 && summary.gapCount <= 2) {
            readinessVerdict = 'READY';
            readinessScore = 0.95;
        } else if (summary.highSeverityGapCount === 0) {
            readinessVerdict = 'READY_WITH_GAPS';
            readinessScore = Math.max(0.6, 0.9 - 0.05 * summary.gapCount);
        } else if (summary.highSeverityGapCount <= 2) {
            readinessVerdict = 'READY_WITH_GAPS';
            readinessScore = 0.55;
        } else {
            readinessVerdict = 'BLOCKED';
            readinessScore = 0.3;
        }

        return {
            source: sourceMeta,
            imports,
            resolvedDeps,
            unresolvedDeps,
            tests,
            loginContract,
            dataReferences,
            configReferences: Array.from(configReferencesMap.values()),
            dbReferences,
            pageObjects: Array.from(pageObjectsMap.values()),
            gaps,
            outputPlan,
            readinessVerdict,
            readinessScore,
            summary,
        };
    }

    /**
     * Render the report as readable Markdown for `STATUS.md` link target +
     * human review. Mirrors the JSON shape but in tables.
     */
    public static renderMarkdown(report: AnalysisReport): string {
        const lines: string[] = [];
        lines.push(`# Analysis Report — \`${report.source.relativePath}\``);
        lines.push('');
        lines.push(`**Class:** \`${report.source.className}\`  `);
        if (report.source.packageName) lines.push(`**Package:** \`${report.source.packageName}\`  `);
        lines.push(`**Framework:** \`${report.source.framework}\`  `);
        lines.push(`**Lines:** ${report.source.lineCount}  `);
        lines.push(`**Verdict:** ${report.readinessVerdict} (${report.readinessScore.toFixed(2)})`);
        lines.push('');

        lines.push('## Summary');
        lines.push('');
        lines.push('| Metric | Value |');
        lines.push('|---|---|');
        lines.push(`| Tests | ${report.summary.testCount} |`);
        lines.push(`| Call-tree avg depth | ${report.summary.callTreeAvgDepth.toFixed(1)} |`);
        lines.push(`| Call-tree max depth | ${report.summary.callTreeMaxDepth} |`);
        lines.push(`| Leaf calls total | ${report.summary.leafCallTotal} |`);
        lines.push(`| Internal deps resolved | ${report.summary.resolvedDepCount} |`);
        lines.push(`| Internal deps unresolved | ${report.summary.unresolvedDepCount} |`);
        lines.push(`| Gaps (total / high) | ${report.summary.gapCount} / ${report.summary.highSeverityGapCount} |`);
        lines.push('');

        lines.push('## Login flow');
        lines.push('');
        if (report.loginContract.detected) {
            lines.push(`- **Pattern:** ${report.loginContract.pattern}`);
            if (report.loginContract.methodFqcn) lines.push(`- **Method:** \`${report.loginContract.methodFqcn}\``);
            lines.push(`- **Per-row user:** ${report.loginContract.perRowUser ? 'yes' : 'no'}`);
            if (report.loginContract.configKeys.length > 0)
                lines.push(`- **Config keys:** \`${report.loginContract.configKeys.join('`, `')}\``);
            if (report.loginContract.selectors.length > 0)
                lines.push(`- **Selectors:** \`${report.loginContract.selectors.slice(0, 5).join('`, `')}\`${report.loginContract.selectors.length > 5 ? ' + …' : ''}`);
            lines.push(`- **Suggested Gherkin step:** \`${report.loginContract.suggestedGherkinStep}\``);
        } else {
            lines.push('- No explicit login flow detected. Translator will assume the framework default `Given I am logged in as "<userName>"` Background step.');
        }
        lines.push('');

        lines.push('## Tests');
        lines.push('');
        for (const t of report.tests) {
            lines.push(`### \`${t.methodName}\` → \`${t.suggestedScenarioId}\``);
            lines.push('');
            lines.push(`*Title:* ${t.suggestedScenarioTitle}  `);
            if (t.suggestedTags.length > 0) lines.push(`*Tags:* ${t.suggestedTags.join(' ')}  `);
            if (t.annotations.dataFile) lines.push(`*Data:* \`${t.annotations.dataFile}\`${t.annotations.dataSheet ? ` (sheet \`${t.annotations.dataSheet}\`)` : ''}${t.annotations.dataKey ? ` key \`${t.annotations.dataKey}\`` : ''}`);
            lines.push(`*Leaf calls:* ${t.leafCallCount} | *Asserts:* ${t.assertionCount} | *Pages touched:* ${t.pagesTouched.length}`);
            lines.push('');
            lines.push('Call tree:');
            lines.push('```');
            lines.push(CSLegacyAnalyzer.renderTree(t.callTree));
            lines.push('```');
            lines.push('');
        }

        if (report.dataReferences.length > 0) {
            lines.push('## Data references');
            lines.push('');
            for (const dr of report.dataReferences) {
                lines.push(`- \`${dr.rawReference}\`${dr.sheet ? ` (sheet \`${dr.sheet}\`)` : ''}${dr.resolvedPath ? ` → \`${dr.resolvedPath}\`` : ' → **NOT FOUND**'}`);
                if (dr.sample && dr.sample.kind === 'rows') {
                    lines.push(`  - ${dr.sample.rowCount} rows, ${dr.sample.columns.length} cols (${dr.sample.columns.slice(0, 6).join(', ')}${dr.sample.columns.length > 6 ? ', …' : ''})`);
                }
            }
            lines.push('');
        }

        if (report.configReferences.length > 0) {
            lines.push('## Config keys used');
            lines.push('');
            lines.push('| Key | Value found in properties? |');
            lines.push('|---|---|');
            for (const cr of report.configReferences) {
                lines.push(`| \`${cr.key}\` | ${cr.valueFromProperties ? `\`${cr.valueFromProperties.slice(0, 40)}\`` : '— missing —'} |`);
            }
            lines.push('');
        }

        if (report.pageObjects.length > 0) {
            lines.push('## Page objects');
            lines.push('');
            for (const po of report.pageObjects) {
                lines.push(`### \`${po.className}\`${po.sourcePath ? ` — [src](${po.sourcePath})` : ' — **source not found**'}`);
                lines.push('');
                if (po.elements.length > 0) {
                    lines.push('| Field | Locator type | Value |');
                    lines.push('|---|---|---|');
                    for (const el of po.elements) {
                        lines.push(`| \`${el.fieldName}\` | ${el.locatorType} | \`${el.locatorValue}\` |`);
                    }
                } else {
                    lines.push('_No elements extracted (page-object format unfamiliar; LLM will reconstruct)._');
                }
                lines.push('');
            }
        }

        if (report.gaps.length > 0) {
            lines.push('## Gaps');
            lines.push('');
            for (const g of report.gaps) {
                lines.push(`- **[${g.severity.toUpperCase()}] ${g.type}**: ${g.detail}`);
                lines.push(`  - _Suggestion:_ ${g.suggestion}`);
            }
            lines.push('');
        }

        lines.push('## Output plan');
        lines.push('');
        lines.push(`**Project:** \`${report.outputPlan.project}\`${report.outputPlan.module ? ` / module \`${report.outputPlan.module}\`` : ''} / feature \`${report.outputPlan.feature}\``);
        lines.push('');
        lines.push('| File | Kind | Decision |');
        lines.push('|---|---|---|');
        for (const f of report.outputPlan.files) {
            lines.push(`| \`${f.relativePath}\` | ${f.kind} | ${f.reuseDecision}${f.existsInTarget ? ' (already exists)' : ''} |`);
        }
        lines.push('');

        return lines.join('\n') + '\n';
    }

    // ------------------------------------------------------------------
    // Internal helpers — extraction, tree expansion, helpers
    // ------------------------------------------------------------------

    private static extractClassName(text: string, p: string): string {
        const m = text.match(/(?:public\s+)?(?:abstract\s+)?(?:final\s+)?class\s+(\w+)/);
        if (m) return m[1];
        return path.basename(p, path.extname(p));
    }

    private static extractPackage(text: string): string | undefined {
        const m = text.match(/^\s*package\s+([\w.]+)\s*;/m);
        return m ? m[1] : undefined;
    }

    private static extractExtendsImplements(text: string): string[] {
        const out: string[] = [];
        const ext = text.match(/class\s+\w+\s+extends\s+([\w.]+)/);
        if (ext) out.push(ext[1]);
        const impl = text.match(/implements\s+([\w.,\s]+)\{/);
        if (impl) {
            for (const i of impl[1].split(',')) out.push(i.trim());
        }
        return out;
    }

    private static extractClassAnnotations(text: string): string[] {
        const out: string[] = [];
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            const l = lines[i].trim();
            if (l.startsWith('@') && !l.includes('(')) out.push(l);
            else if (l.startsWith('@')) {
                // Capture annotation including multi-line parens
                let buf = l;
                while (!CSLegacyAnalyzer.parensBalanced(buf) && i + 1 < lines.length) {
                    i++;
                    buf += ' ' + lines[i].trim();
                }
                out.push(buf);
            }
            if (l.startsWith('public class') || l.startsWith('class')) break;
        }
        return out;
    }

    private static parensBalanced(s: string): boolean {
        let depth = 0;
        for (const ch of s) {
            if (ch === '(') depth++;
            else if (ch === ')') depth--;
            if (depth < 0) return false;
        }
        return depth === 0;
    }

    private static detectFramework(text: string): SourceMeta['framework'] {
        if (/com\.quarry\.qaf|com\.qmetry\.qaf/.test(text)) return 'testng-qaf';
        if (/io\.cucumber|cucumber\.api/.test(text)) return 'cucumber-bdd';
        if (/org\.testng|org\.testing/.test(text)) return 'testng';
        if (/using\s+NUnit\.Framework/.test(text)) return 'nunit';
        if (/using\s+Xunit/.test(text)) return 'xunit';
        if (/using\s+Microsoft\.VisualStudio\.TestTools/.test(text)) return 'mstest';
        return 'unknown';
    }

    private static parseImports(text: string, inventory: LegacyInventory): ImportInfo[] {
        const out: ImportInfo[] = [];
        const re = /^import\s+(?:static\s+)?([\w.]+)(?:\.\*)?\s*;/gm;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
            const fqcn = m[1];
            const isExternal = CSLegacyAnalyzer.EXTERNAL_PREFIXES.some((p) => fqcn.startsWith(p));
            if (isExternal) {
                out.push({ raw: m[0], fqcn, kind: 'external' });
                continue;
            }
            // Try to resolve from inventory.
            const simple = fqcn.split('.').pop() || fqcn;
            const file = inventory.files.find((f) =>
                f.className === simple
                || (f.packageName && `${f.packageName}.${f.className}` === fqcn),
            );
            out.push({
                raw: m[0],
                fqcn,
                kind: 'internal',
                resolvedPath: file?.path,
            });
        }
        return out;
    }

    private static buildMethodIndex(files: string[]): Map<string, MethodIndexEntry> {
        const idx = new Map<string, MethodIndexEntry>();
        for (const f of files) {
            try {
                const text = fs.readFileSync(f, 'utf-8');
                const className = CSLegacyAnalyzer.extractClassName(text, f);
                const methodRe = /(?:public|protected|private|static|\s)+\s+\w[\w<>,\s]*\s+(\w+)\s*\([^)]*\)\s*(?:throws\s+[\w.,\s]+)?\s*\{([\s\S]*?)^\s*\}/gm;
                let m: RegExpExecArray | null;
                while ((m = methodRe.exec(text)) !== null) {
                    const methodName = m[1];
                    const body = m[2];
                    if (methodName === 'class' || methodName === 'if' || methodName === 'for') continue;
                    const key = `${className}.${methodName}`;
                    if (!idx.has(key)) {
                        idx.set(key, { className, methodName, file: f, body });
                    }
                    const bareKey = methodName;
                    if (!idx.has(bareKey)) {
                        idx.set(bareKey, { className, methodName, file: f, body });
                    }
                }
            } catch {
                continue;
            }
        }
        return idx;
    }

    private static extractTestMethods(text: string): Array<{
        methodName: string; annotationsRaw: string; parameterTypes: string[]; body: string;
    }> {
        const out: Array<{
            methodName: string; annotationsRaw: string; parameterTypes: string[]; body: string;
        }> = [];
        const lines = text.split(/\r?\n/);
        const consumed = new Set<number>(); // line indices already absorbed into a test
        for (let i = 0; i < lines.length; i++) {
            if (consumed.has(i)) continue;
            const l = lines[i].trim();
            if (!/^@(?:Test|MetaData|QAFDataProvider|DataProvider|Tag|Tags)\b/.test(l)
                && !/^\[(?:Test(?:Case|Fixture)?|Theory|InlineData|Fact)\b/.test(l)) continue;
            // Capture every consecutive annotation line + line continuations
            // until we hit the method signature. An annotation line either
            // starts with `@`/`[`, or is a continuation of an unbalanced
            // multi-line annotation.
            const annLines: string[] = [];
            let j = i;
            let annDepth = 0;
            let inAnnotation = false;
            while (j < lines.length) {
                const raw = lines[j];
                const cur = raw.trim();
                // Empty line inside annotation block? Skip + continue.
                if (cur === '' && annDepth === 0 && annLines.length > 0) {
                    j++;
                    continue;
                }
                const startsAnn = cur.startsWith('@') || cur.startsWith('[');
                if (annDepth === 0 && !inAnnotation && !startsAnn) break;
                if (startsAnn) inAnnotation = true;
                annLines.push(cur);
                consumed.add(j);
                // Track balanced parens / brackets so multi-line annotations work.
                for (const ch of cur) {
                    if (ch === '(' || ch === '[' || ch === '{') annDepth++;
                    else if (ch === ')' || ch === ']' || ch === '}') annDepth--;
                }
                j++;
                // When parens balanced AND next non-empty line is not another
                // annotation, we're done with the annotation block.
                if (annDepth === 0) {
                    // Peek next non-empty line.
                    let k = j;
                    while (k < lines.length && lines[k].trim() === '') k++;
                    const next = k < lines.length ? lines[k].trim() : '';
                    if (!next.startsWith('@') && !next.startsWith('[')) {
                        j = k;
                        inAnnotation = false;
                        break;
                    }
                }
            }
            const headerLine = lines[j];
            if (!headerLine) continue;
            const sig = headerLine.match(/(?:public|protected|private|static|\s)+\s+\w[\w<>,\s]*\s+(\w+)\s*\(([^)]*)\)/);
            if (!sig) continue;
            const methodName = sig[1];
            const parameterTypes = sig[2]
                .split(',')
                .map((p) => p.trim())
                .filter(Boolean)
                .map((p) => p.split(/\s+/)[0]);
            // Capture body between matching braces.
            const bodyStart = headerLine.indexOf('{') >= 0 ? j : j + 1;
            let depth = 0;
            let bodyEnd = bodyStart;
            for (let k = bodyStart; k < lines.length; k++) {
                for (const ch of lines[k]) {
                    if (ch === '{') depth++;
                    else if (ch === '}') {
                        depth--;
                        if (depth === 0) { bodyEnd = k; break; }
                    }
                }
                if (depth === 0 && k > bodyStart) break;
            }
            const body = lines.slice(bodyStart + 1, bodyEnd).join('\n');
            out.push({
                methodName,
                annotationsRaw: annLines.join('\n'),
                parameterTypes,
                body,
            });
            i = bodyEnd;
        }
        return out;
    }

    private static parseTestAnnotations(raw: string): TestAnnotations {
        const out: TestAnnotations = {};
        const meta = raw.match(/@MetaData\s*\(\s*\{([^}]*)\}\s*\)/);
        if (meta) {
            const inner = meta[1];
            const tcId = inner.match(/"testCaseId"\s*:\s*"([^"]+)"/);
            const tn = inner.match(/"testName"\s*:\s*"([^"]+)"/);
            if (tcId) out.testCaseId = tcId[1];
            if (tn) out.testName = tn[1];
        }
        const dp = raw.match(/@QAFDataProvider\s*\(([^)]*)\)/) || raw.match(/@DataProvider\s*\(([^)]*)\)/);
        if (dp) {
            const file = dp[1].match(/dataFile\s*=\s*"([^"]+)"/);
            const sheet = dp[1].match(/sheetName\s*=\s*"([^"]+)"/);
            const key = dp[1].match(/key\s*=\s*"([^"]+)"/);
            if (file) out.dataFile = file[1];
            if (sheet) out.dataSheet = sheet[1];
            if (key) out.dataKey = key[1];
        }
        const groups = raw.match(/@Test\s*\([^)]*groups\s*=\s*\{([^}]+)\}/);
        if (groups) {
            out.groups = groups[1]
                .split(',')
                .map((s) => s.trim().replace(/^"|"$/g, ''))
                .filter(Boolean);
        }
        return out;
    }

    private static expandCallTree(
        body: string,
        contextMethod: string,
        contextFile: string,
        methodIndex: Map<string, MethodIndexEntry>,
        depth: number,
    ): CallTreeNode {
        const root: CallTreeNode = {
            label: contextMethod,
            methodName: contextMethod,
            args: [],
            rawLine: '',
            kind: 'helper',
            children: [],
        };
        if (depth >= CSLegacyAnalyzer.MAX_RECURSION_DEPTH) {
            root.stopReason = 'depth-cap';
            return root;
        }

        const lines = body.split(/\r?\n/);
        for (const rawLine of lines) {
            const trimmed = rawLine.trim();
            if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

            // Recognise leaf primitives first.
            const leaf = CSLegacyAnalyzer.classifyLeafLine(trimmed);
            if (leaf) {
                root.children.push({
                    ...leaf,
                    rawLine: trimmed,
                    children: [],
                    args: leaf.args ?? [],
                });
                continue;
            }

            // Generic method call: `obj.method(args)` or `Class.method(args)` or bare `method(args)`.
            const callMatch = trimmed.match(/(?:^|[^\w.])((?:\w+\.)?\w+)\s*\(([^)]*)\)/);
            if (callMatch) {
                const fullCall = callMatch[1];
                const args = CSLegacyAnalyzer.splitArgs(callMatch[2]);
                const dot = fullCall.lastIndexOf('.');
                const receiver = dot > 0 ? fullCall.slice(0, dot) : undefined;
                const methodName = dot > 0 ? fullCall.slice(dot + 1) : fullCall;
                if (CSLegacyAnalyzer.isControlKeyword(methodName)) continue;

                // Try to resolve into method index.
                const idxKey = receiver
                    ? `${receiver.split('.').pop()}.${methodName}`
                    : methodName;
                const found = methodIndex.get(idxKey) ?? methodIndex.get(methodName);
                if (found) {
                    const child = CSLegacyAnalyzer.expandCallTree(
                        found.body,
                        `${found.className}.${found.methodName}`,
                        found.file,
                        methodIndex,
                        depth + 1,
                    );
                    child.label = `${found.className}.${found.methodName}(${args.join(', ')})`;
                    child.methodName = found.methodName;
                    child.receiverClass = found.className;
                    child.definedIn = found.file;
                    child.args = args;
                    child.rawLine = trimmed;
                    child.kind = CSLegacyAnalyzer.classifyHelperKind(found.className, methodName);
                    root.children.push(child);
                } else {
                    root.children.push({
                        label: `${fullCall}(${args.join(', ')})`,
                        methodName,
                        receiverClass: receiver,
                        args,
                        rawLine: trimmed,
                        kind: 'unresolved',
                        children: [],
                        stopReason: 'unresolved',
                    });
                }
            }
        }
        return root;
    }

    private static classifyLeafLine(line: string): Partial<CallTreeNode> & { kind: CallTreeNode['kind']; methodName: string; label: string; args?: string[] } | null {
        let m: RegExpMatchArray | null;
        if ((m = line.match(/(?:driver|page|browser)\.(get|navigate(?:To)?)\s*\(\s*"([^"]+)"/))) {
            return { kind: 'navigate', methodName: m[1], label: `navigate("${m[2]}")`, args: [m[2]] };
        }
        if ((m = line.match(/(\w+)\.click\s*\(\s*\)/))) {
            return { kind: 'click', methodName: 'click', label: `${m[1]}.click()` };
        }
        if ((m = line.match(/(\w+)\.(sendKeys|fill|type|setText)\s*\(\s*"([^"]*)"\s*\)/))) {
            return { kind: 'fill', methodName: m[2], label: `${m[1]}.${m[2]}("${m[3]}")`, args: [m[3]] };
        }
        if (/(?:assertEquals|Assert\.AreEqual|assertThat|verifyEquals)\s*\(/.test(line)) {
            return { kind: 'assertion', methodName: 'assertEquals', label: line.slice(0, 80) };
        }
        if (/(?:assertTrue|Assert\.IsTrue|verifyTrue)\s*\(/.test(line)) {
            return { kind: 'assertion', methodName: 'assertTrue', label: line.slice(0, 80) };
        }
        if (/Configuration\.(?:get|read)|getProperty\s*\(\s*"|props\.get\s*\(\s*"/.test(line)) {
            const km = line.match(/"([\w.]+)"/);
            return { kind: 'config', methodName: 'getProperty', label: km ? `config:${km[1]}` : 'config:?', args: km ? [km[1]] : [] };
        }
        if (/(?:executeQuery|prepareStatement|prepareCall|execute)\s*\(/.test(line)
            && /(?:SELECT|INSERT|UPDATE|DELETE)\s/i.test(line)) {
            return { kind: 'db', methodName: 'sql', label: line.slice(0, 80) };
        }
        return null;
    }

    private static classifyHelperKind(className: string, methodName: string): CallTreeNode['kind'] {
        const lc = methodName.toLowerCase();
        if (lc.startsWith('login') || lc.includes('signin') || lc.includes('signon')) return 'helper';
        if (lc.startsWith('navigate') || lc.startsWith('goto')) return 'navigate';
        if (lc.startsWith('click') || lc.startsWith('press')) return 'click';
        if (lc.startsWith('fill') || lc.startsWith('enter') || lc.startsWith('type')) return 'fill';
        if (lc.startsWith('verify') || lc.startsWith('assert') || lc.startsWith('expect')) return 'assertion';
        if (lc.startsWith('select')) return 'select';
        if (lc.startsWith('wait')) return 'wait';
        if (className.toLowerCase().endsWith('page')) return 'page';
        return 'helper';
    }

    private static splitArgs(s: string): string[] {
        const args: string[] = [];
        let cur = '';
        let depth = 0;
        let inS = false;
        let q: string | null = null;
        for (const ch of s) {
            if (inS) {
                cur += ch;
                if (ch === q && cur[cur.length - 2] !== '\\') { inS = false; q = null; }
                continue;
            }
            if (ch === '"' || ch === '\'') { inS = true; q = ch; cur += ch; continue; }
            if (ch === '(' || ch === '[' || ch === '{') depth++;
            else if (ch === ')' || ch === ']' || ch === '}') depth--;
            if (ch === ',' && depth === 0) { args.push(cur.trim()); cur = ''; continue; }
            cur += ch;
        }
        if (cur.trim()) args.push(cur.trim());
        return args;
    }

    private static isControlKeyword(name: string): boolean {
        return new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'throw', 'new', 'super', 'this', 'true', 'false', 'null']).has(name);
    }

    private static collectFromTree(root: CallTreeNode): {
        configKeys: Set<string>;
        sqlStatements: string[];
        pageClasses: Set<string>;
        assertionCount: number;
    } {
        const configKeys = new Set<string>();
        const sqlStatements: string[] = [];
        const pageClasses = new Set<string>();
        let assertionCount = 0;
        const visit = (node: CallTreeNode) => {
            if (node.kind === 'config' && node.args && node.args.length > 0) configKeys.add(node.args[0]);
            if (node.kind === 'db') sqlStatements.push(node.rawLine);
            if (node.kind === 'page' && node.receiverClass) pageClasses.add(node.receiverClass);
            if (node.receiverClass && node.receiverClass.toLowerCase().endsWith('page')) pageClasses.add(node.receiverClass);
            if (node.kind === 'assertion') assertionCount++;
            for (const c of node.children) visit(c);
        };
        visit(root);
        return { configKeys, sqlStatements, pageClasses, assertionCount };
    }

    private static measureTree(root: CallTreeNode): { maxDepth: number; leafCount: number } {
        let leafCount = 0;
        let maxDepth = 0;
        const visit = (n: CallTreeNode, d: number) => {
            maxDepth = Math.max(maxDepth, d);
            if (n.children.length === 0
                || n.kind === 'navigate' || n.kind === 'click' || n.kind === 'fill'
                || n.kind === 'assertion' || n.kind === 'config' || n.kind === 'db'
                || n.kind === 'wait') leafCount++;
            for (const c of n.children) visit(c, d + 1);
        };
        visit(root, 0);
        return { maxDepth, leafCount };
    }

    private static renderTree(root: CallTreeNode, prefix = ''): string {
        const lines: string[] = [];
        lines.push(`${prefix}└─ ${root.label} [${root.kind}]`);
        const ipref = prefix.replace(/└─/g, '   ').replace(/├─/g, '│  ');
        for (let i = 0; i < root.children.length; i++) {
            const isLast = i === root.children.length - 1;
            const branch = isLast ? '   └─ ' : '   ├─ ';
            const childPref = ipref + branch;
            lines.push(CSLegacyAnalyzer.renderTree(root.children[i], childPref));
        }
        return lines.join('\n');
    }

    private static detectLoginContract(
        sourceText: string,
        tests: TestAnalysis[],
        methodIndex: Map<string, MethodIndexEntry>,
        inventory: LegacyInventory,
    ): LoginContract {
        const candidates: string[] = [];
        // 1. Look for @BeforeMethod / @BeforeClass / [SetUp] in the source.
        if (/@BeforeMethod|@BeforeClass|@Before\b|\[SetUp\]|\[OneTimeSetUp\]/.test(sourceText)) {
            candidates.push('before');
        }
        // 2. Look for login* helpers in the method index.
        const loginEntry = Array.from(methodIndex.values()).find(
            (e) => /login|signin|signon/i.test(e.methodName),
        );
        if (loginEntry) candidates.push(`helper:${loginEntry.className}.${loginEntry.methodName}`);
        if (candidates.length === 0) {
            return { detected: false, configKeys: [], selectors: [], perRowUser: false, suggestedGherkinStep: 'Given I am logged in as "<userName>"' };
        }

        // Gather config keys + selectors from the login method's body if found.
        const configKeys = new Set<string>();
        const selectors = new Set<string>();
        let perRowUser = false;

        if (loginEntry) {
            const tree = CSLegacyAnalyzer.expandCallTree(
                loginEntry.body, `${loginEntry.className}.${loginEntry.methodName}`, loginEntry.file, methodIndex, 0,
            );
            const collected = CSLegacyAnalyzer.collectFromTree(tree);
            for (const k of collected.configKeys) configKeys.add(k);
            // Detect parameterised user — method takes username/password params.
            const paramRe = /\(([^)]*)\)/.exec(loginEntry.body) ?? null;
            const sig = sourceText.match(new RegExp(`${loginEntry.methodName}\\s*\\(([^)]*)\\)`));
            if (sig && /String\s+\w+|Map<String/.test(sig[1])) perRowUser = true;
        }

        // Look for selector strings inside login page object source if discoverable.
        const loginPageFile = inventory.pages.find((p) => /Login/i.test(path.basename(p)));
        if (loginPageFile) {
            const t = fs.readFileSync(loginPageFile, 'utf-8');
            const re = /(?:@FindBy|@CSGetElement)[^]*?(?:xpath|id|css)\s*=?\s*"([^"]+)"/g;
            let m: RegExpExecArray | null;
            while ((m = re.exec(t)) !== null) selectors.add(m[1]);
        }

        // If any test passes a per-row data field that maps to user, also flag perRowUser.
        if (tests.some((t) => /username|userid|user|role/i.test(t.parameterTypes.join(',')))) {
            perRowUser = true;
        }

        return {
            detected: true,
            pattern: loginEntry ? 'inline-helper' : 'before-method',
            methodFqcn: loginEntry ? `${loginEntry.className}.${loginEntry.methodName}` : undefined,
            configKeys: Array.from(configKeys),
            selectors: Array.from(selectors),
            perRowUser,
            suggestedGherkinStep: perRowUser
                ? 'When I login as "<userName>"'
                : 'When I login with the configured credentials',
        };
    }

    private static findConfigKeyInProperties(
        key: string,
        inventory: LegacyInventory,
    ): { value: string; path: string } | null {
        for (const f of inventory.propertiesFiles) {
            try {
                const text = fs.readFileSync(f, 'utf-8');
                const re = new RegExp(`^\\s*${key.replace(/[.[\\\]]/g, '\\$&')}\\s*[:=]\\s*(.+)$`, 'm');
                const m = text.match(re);
                if (m) return { value: m[1].trim(), path: f };
            } catch {
                continue;
            }
        }
        return null;
    }

    private static resolveDataPath(rawRef: string, inventory: LegacyInventory): LegacyFile | null {
        const cleaned = rawRef.replace(/\$\{[\w.]+\}/g, '');
        const parts = cleaned.split(/[\\\/]/);
        const fileName = parts[parts.length - 1];
        const cand = inventory.files.find((f) => path.basename(f.path) === fileName);
        return cand ?? null;
    }

    private static classifySql(sql: string): DbReference['type'] {
        const lc = sql.toLowerCase().trim();
        if (lc.startsWith('select')) return 'select';
        if (lc.startsWith('insert')) return 'insert';
        if (lc.startsWith('update')) return 'update';
        if (lc.startsWith('delete')) return 'delete';
        return 'other';
    }

    private static extractTable(sql: string): string | undefined {
        const m = sql.match(/\b(?:FROM|INTO|UPDATE)\s+(\w+)/i);
        return m ? m[1] : undefined;
    }

    private static extractPageElements(file: string): PageElement[] {
        try {
            const text = fs.readFileSync(file, 'utf-8');
            const out: PageElement[] = [];
            const re = /@(?:FindBy|FindBys?|CacheLookup|FindAll)\s*\(([^)]+)\)\s*(?:public|protected|private)?\s*\w+\s+(\w+)\s*[;=]/g;
            let m: RegExpExecArray | null;
            while ((m = re.exec(text)) !== null) {
                const args = m[1];
                const fieldName = m[2];
                const xpath = args.match(/xpath\s*=\s*"([^"]+)"/);
                const css = args.match(/css\s*=\s*"([^"]+)"/);
                const id = args.match(/id\s*=\s*"([^"]+)"/);
                const name = args.match(/name\s*=\s*"([^"]+)"/);
                if (xpath) out.push({ fieldName, locatorType: 'xpath', locatorValue: xpath[1] });
                else if (css) out.push({ fieldName, locatorType: 'css', locatorValue: css[1] });
                else if (id) out.push({ fieldName, locatorType: 'id', locatorValue: id[1] });
                else if (name) out.push({ fieldName, locatorType: 'name', locatorValue: name[1] });
                else out.push({ fieldName, locatorType: 'unknown', locatorValue: args.trim() });
            }
            return out;
        } catch {
            return [];
        }
    }

    private static extractPublicMethods(file: string): string[] {
        try {
            const text = fs.readFileSync(file, 'utf-8');
            const out: string[] = [];
            const re = /public\s+\w+(?:<[^>]*>)?\s+(\w+)\s*\([^)]*\)/g;
            let m: RegExpExecArray | null;
            while ((m = re.exec(text)) !== null) out.push(m[1]);
            return Array.from(new Set(out));
        } catch {
            return [];
        }
    }

    private static suggestProjectFromPackage(pkg: string | undefined, className: string): string {
        if (pkg) {
            const parts = pkg.split('.');
            // Conventional layout: company.product.* — pick the second segment as project.
            if (parts.length >= 2) return parts[1].toLowerCase();
        }
        return CSLegacyAnalyzer.kebabCase(className);
    }

    private static kebabCase(s: string): string {
        return s
            .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
            .replace(/[\s_]+/g, '-')
            .toLowerCase();
    }

    private static humaniseMethodName(name: string): string {
        return name
            .replace(/_/g, ' ')
            .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
            .replace(/\s+/g, ' ')
            .trim();
    }
}

interface MethodIndexEntry {
    className: string;
    methodName: string;
    file: string;
    body: string;
}
