/**
 * Agentic Test Platform — Repo Inventory
 *
 * Scans `test/<project>/` for the framework's standard artefact layout
 * and returns a structured manifest of what already exists. Phase 2.4d
 * uses this to compute deltas before generation: never regenerate a
 * page object that already exists and works; never overwrite a step
 * file the user has hand-tuned.
 *
 * Layout assumed (matches the framework's canonical output):
 *
 *   test/<project>/features/[<module>/]<feature>.feature
 *   test/<project>/pages/[<module>/]<...>.page.ts
 *   test/<project>/steps/[<module>/]<...>.steps.ts
 *   test/<project>/data/[<module>/]<feature>-data.json
 *
 * Parsing is regex-based and deterministic — no ts-morph, no AST. The
 * goal is "what exists and roughly what's in it", not full semantic
 * extraction. The pre-gate audit and the heal loop's gate handle
 * deeper validation downstream.
 *
 * @module agent-platform/CSRepoInventory
 */

import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Public Types
// ============================================================================

export interface PageElementEntry {
    /** TS field name (e.g., `loginButton`). */
    name: string;
    /** Primary xpath from the decorator, if extractable. */
    xpath?: string;
    /** Description from the decorator. */
    description?: string;
    /** True when `selfHeal: true` is set on the decorator. */
    selfHeal?: boolean;
}

export interface PageInventoryEntry {
    /** Absolute path to the .page.ts file. */
    path: string;
    /** Workspace-relative path for display. */
    relativePath: string;
    /** Class name (e.g., `LoginPage`). */
    className: string;
    /** ID from `@CSPage('id')` — the framework's stable handle. */
    pageId: string | null;
    /** Elements discovered by scanning `@CSGetElement` blocks. */
    elements: PageElementEntry[];
    /** Module folder if module-grouped layout (otherwise undefined). */
    moduleName?: string;
}

export interface StepDefEntry {
    /** Pattern string from `@CSBDDStepDef('...')`. */
    pattern: string;
    /** TS method name. */
    method: string;
}

export interface StepInventoryEntry {
    path: string;
    relativePath: string;
    className: string;
    steps: StepDefEntry[];
    moduleName?: string;
}

export interface FeatureScenarioEntry {
    /** Tag like `@TC_0001` if present, else null. */
    id: string | null;
    /** Scenario or Scenario Outline name. */
    name: string;
    /** Tags directly above the scenario. */
    tags: string[];
}

export interface FeatureInventoryEntry {
    path: string;
    relativePath: string;
    /** Feature: ... line. */
    featureName: string;
    /** Top-level tags (between Feature: and the first Background/Scenario). */
    tags: string[];
    scenarios: FeatureScenarioEntry[];
    moduleName?: string;
}

export interface DataFileEntry {
    path: string;
    relativePath: string;
    /** Scenario IDs present in the JSON array. */
    scenarioIds: string[];
    moduleName?: string;
}

export interface ConfigInventoryEntry {
    path: string;
    relativePath: string;
    /** Top-level config keys present (excludes encrypted-prefix marker). */
    keys: string[];
}

export interface RepoInventory {
    project: string;
    module?: string;
    workspaceRoot: string;
    summary: {
        pageCount: number;
        stepCount: number;
        featureCount: number;
        dataFileCount: number;
        scenarioCount: number;
        configFileCount: number;
    };
    pages: PageInventoryEntry[];
    steps: StepInventoryEntry[];
    features: FeatureInventoryEntry[];
    dataFiles: DataFileEntry[];
    configFiles: ConfigInventoryEntry[];
}

// ============================================================================
// CSRepoInventory
// ============================================================================

export class CSRepoInventory {
    /**
     * Scan `test/<project>/` (and `config/<project>/`) and return a
     * structured manifest of every artefact present.
     *
     * @param project       Project name (folder under `test/` and `config/`)
     * @param options.module          Optional module-name filter — only includes artefacts under `<artefact>/<module>/`
     * @param options.workspaceRoot   Defaults to `process.cwd()`
     */
    public static inventory(
        project: string,
        options: { module?: string; workspaceRoot?: string } = {},
    ): RepoInventory {
        const workspaceRoot = options.workspaceRoot ?? process.cwd();
        const module = options.module?.trim() || undefined;

        const testRoot = path.join(workspaceRoot, 'test', project);
        const configRoot = path.join(workspaceRoot, 'config', project);

        const pages = fs.existsSync(testRoot)
            ? CSRepoInventory.scanPages(testRoot, workspaceRoot, module)
            : [];
        const steps = fs.existsSync(testRoot)
            ? CSRepoInventory.scanSteps(testRoot, workspaceRoot, module)
            : [];
        const features = fs.existsSync(testRoot)
            ? CSRepoInventory.scanFeatures(testRoot, workspaceRoot, module)
            : [];
        const dataFiles = fs.existsSync(testRoot)
            ? CSRepoInventory.scanDataFiles(testRoot, workspaceRoot, module)
            : [];
        const configFiles = fs.existsSync(configRoot)
            ? CSRepoInventory.scanConfigFiles(configRoot, workspaceRoot)
            : [];

        const scenarioCount = features.reduce((s, f) => s + f.scenarios.length, 0);

        return {
            project,
            module,
            workspaceRoot,
            summary: {
                pageCount: pages.length,
                stepCount: steps.length,
                featureCount: features.length,
                dataFileCount: dataFiles.length,
                scenarioCount,
                configFileCount: configFiles.length,
            },
            pages,
            steps,
            features,
            dataFiles,
            configFiles,
        };
    }

    // ---------------------------------------------------------------------
    // Page-object scanner
    // ---------------------------------------------------------------------

    private static scanPages(
        testRoot: string,
        workspaceRoot: string,
        moduleFilter: string | undefined,
    ): PageInventoryEntry[] {
        const pagesRoot = path.join(testRoot, 'pages');
        if (!fs.existsSync(pagesRoot)) return [];
        const files = CSRepoInventory.findFiles(pagesRoot, /\.page\.ts$/);
        const entries: PageInventoryEntry[] = [];
        for (const abs of files) {
            const moduleName = CSRepoInventory.extractModuleName(abs, pagesRoot);
            // When a moduleFilter is set, admit entries from the module's
            // own folder AND from the shared `common/` folder (LoginPage,
            // GridComponents, header/footer/sidebar/navbar). Without this,
            // the BDD author loses access to the shared component library.
            if (moduleFilter && moduleName !== moduleFilter && moduleName !== 'common') continue;
            const content = CSRepoInventory.safeRead(abs);
            if (!content) continue;
            entries.push({
                path: abs,
                relativePath: path.relative(workspaceRoot, abs).replace(/\\/g, '/'),
                className: CSRepoInventory.extractClassName(content) ?? path.basename(abs, '.page.ts'),
                pageId: CSRepoInventory.extractPageId(content),
                elements: CSRepoInventory.extractElements(content),
                moduleName,
            });
        }
        return entries;
    }

    private static extractClassName(content: string): string | null {
        const m = /\bexport\s+class\s+([A-Z][A-Za-z0-9_]*)/.exec(content);
        return m ? m[1] : null;
    }

    private static extractPageId(content: string): string | null {
        // @CSPage('id-string')  — same-quote backreference, like extractKeyString.
        const m = /@CSPage\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1\s*\)/.exec(content);
        return m ? m[2] : null;
    }

    private static extractElements(content: string): PageElementEntry[] {
        const elements: PageElementEntry[] = [];
        // Match each @CSGetElement({...}) block followed by a property declaration.
        // Greedy scan: the regex captures the decorator's options object and
        // the field name on the next non-whitespace line.
        const re = /@CSGetElement\s*\(\s*\{([\s\S]*?)\}\s*\)\s*(?:public|private|protected)?\s*([A-Za-z_$][\w$]*)\s*[!:]/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(content)) !== null) {
            const optionsBlock = m[1];
            const fieldName = m[2];
            const xpath = CSRepoInventory.extractKeyString(optionsBlock, 'xpath');
            const description = CSRepoInventory.extractKeyString(optionsBlock, 'description');
            const selfHealMatch = /\bselfHeal\s*:\s*true\b/.test(optionsBlock);
            elements.push({
                name: fieldName,
                xpath,
                description,
                selfHeal: selfHealMatch || undefined,
            });
        }
        return elements;
    }

    /**
     * Extract a quoted string value for `key: '<value>'` from an options
     * block. Handles single-quoted, double-quoted, and backtick-quoted
     * forms — and correctly tolerates inner quotes of the OTHER kind
     * (e.g. `xpath: "//input[@id='x']"` returns `//input[@id='x']`,
     * not just `//input[@id=`). Returns undefined if not present.
     */
    private static extractKeyString(block: string, key: string): string | undefined {
        // Build a regex with a backreference so the closing quote
        // matches the opening one. `[^]*?` is "any char inc. newline, lazy".
        // We allow a backslash-escape inside (e.g. \" inside a "..." string).
        const re = new RegExp(
            `\\b${key}\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1).)*)\\1`,
        );
        const m = re.exec(block);
        return m ? m[2] : undefined;
    }

    // ---------------------------------------------------------------------
    // Step-definition scanner
    // ---------------------------------------------------------------------

    private static scanSteps(
        testRoot: string,
        workspaceRoot: string,
        moduleFilter: string | undefined,
    ): StepInventoryEntry[] {
        const stepsRoot = path.join(testRoot, 'steps');
        if (!fs.existsSync(stepsRoot)) return [];
        const files = CSRepoInventory.findFiles(stepsRoot, /\.steps\.ts$/);
        const entries: StepInventoryEntry[] = [];
        for (const abs of files) {
            const moduleName = CSRepoInventory.extractModuleName(abs, stepsRoot);
            // When a moduleFilter is set, admit entries from the module's
            // own folder AND from the shared `common/` folder (LoginPage,
            // GridComponents, header/footer/sidebar/navbar). Without this,
            // the BDD author loses access to the shared component library.
            if (moduleFilter && moduleName !== moduleFilter && moduleName !== 'common') continue;
            const content = CSRepoInventory.safeRead(abs);
            if (!content) continue;
            entries.push({
                path: abs,
                relativePath: path.relative(workspaceRoot, abs).replace(/\\/g, '/'),
                className: CSRepoInventory.extractClassName(content) ?? path.basename(abs, '.steps.ts'),
                steps: CSRepoInventory.extractStepDefs(content),
                moduleName,
            });
        }
        return entries;
    }

    private static extractStepDefs(content: string): StepDefEntry[] {
        const steps: StepDefEntry[] = [];
        const re = /@CSBDDStepDef\s*\(\s*['"`]([^'"`]+)['"`]\s*(?:,[\s\S]*?)?\)\s*(?:async\s+)?([A-Za-z_$][\w$]*)/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(content)) !== null) {
            steps.push({ pattern: m[1], method: m[2] });
        }
        return steps;
    }

    // ---------------------------------------------------------------------
    // Feature-file scanner
    // ---------------------------------------------------------------------

    private static scanFeatures(
        testRoot: string,
        workspaceRoot: string,
        moduleFilter: string | undefined,
    ): FeatureInventoryEntry[] {
        const featuresRoot = path.join(testRoot, 'features');
        if (!fs.existsSync(featuresRoot)) return [];
        const files = CSRepoInventory.findFiles(featuresRoot, /\.feature$/);
        const entries: FeatureInventoryEntry[] = [];
        for (const abs of files) {
            const moduleName = CSRepoInventory.extractModuleName(abs, featuresRoot);
            // When a moduleFilter is set, admit entries from the module's
            // own folder AND from the shared `common/` folder (LoginPage,
            // GridComponents, header/footer/sidebar/navbar). Without this,
            // the BDD author loses access to the shared component library.
            if (moduleFilter && moduleName !== moduleFilter && moduleName !== 'common') continue;
            const content = CSRepoInventory.safeRead(abs);
            if (!content) continue;
            entries.push({
                path: abs,
                relativePath: path.relative(workspaceRoot, abs).replace(/\\/g, '/'),
                featureName: CSRepoInventory.extractFeatureName(content) ?? path.basename(abs, '.feature'),
                tags: CSRepoInventory.extractFeatureTags(content),
                scenarios: CSRepoInventory.extractScenarios(content),
                moduleName,
            });
        }
        return entries;
    }

    private static extractFeatureName(content: string): string | null {
        const m = /^Feature:\s*(.+)$/m.exec(content);
        return m ? m[1].trim() : null;
    }

    private static extractFeatureTags(content: string): string[] {
        // Tags on the line(s) immediately before "Feature:".
        const lines = content.split(/\r?\n/);
        const tags: string[] = [];
        for (let i = 0; i < lines.length; i++) {
            const ln = lines[i].trim();
            if (ln.startsWith('Feature:')) break;
            if (ln.startsWith('@')) {
                tags.push(...ln.split(/\s+/).filter((t) => t.startsWith('@')));
            }
        }
        return tags;
    }

    private static extractScenarios(content: string): FeatureScenarioEntry[] {
        const scenarios: FeatureScenarioEntry[] = [];
        const lines = content.split(/\r?\n/);
        let pendingTags: string[] = [];
        for (let i = 0; i < lines.length; i++) {
            const ln = lines[i].trim();
            if (ln.startsWith('@')) {
                pendingTags.push(...ln.split(/\s+/).filter((t) => t.startsWith('@')));
                continue;
            }
            const sc = /^Scenario(?:\s+Outline)?:\s*(.+)$/.exec(ln);
            if (sc) {
                // Look for a TC/TS-shaped tag in pendingTags.
                const idTag = pendingTags.find((t) => /^@(TC|TS)[_#-]?\d+/i.test(t));
                scenarios.push({
                    id: idTag ?? null,
                    name: sc[1].trim(),
                    tags: [...pendingTags],
                });
                pendingTags = [];
                continue;
            }
            // Reset tag accumulator on non-tag, non-scenario, non-blank line.
            if (ln && !ln.startsWith('#')) {
                if (!ln.startsWith('Background:') && !ln.startsWith('Examples:')) {
                    pendingTags = [];
                }
            }
        }
        return scenarios;
    }

    // ---------------------------------------------------------------------
    // Data-file scanner
    // ---------------------------------------------------------------------

    private static scanDataFiles(
        testRoot: string,
        workspaceRoot: string,
        moduleFilter: string | undefined,
    ): DataFileEntry[] {
        const dataRoot = path.join(testRoot, 'data');
        if (!fs.existsSync(dataRoot)) return [];
        const files = CSRepoInventory.findFiles(dataRoot, /-data\.json$/);
        const entries: DataFileEntry[] = [];
        for (const abs of files) {
            const moduleName = CSRepoInventory.extractModuleName(abs, dataRoot);
            // When a moduleFilter is set, admit entries from the module's
            // own folder AND from the shared `common/` folder (LoginPage,
            // GridComponents, header/footer/sidebar/navbar). Without this,
            // the BDD author loses access to the shared component library.
            if (moduleFilter && moduleName !== moduleFilter && moduleName !== 'common') continue;
            const content = CSRepoInventory.safeRead(abs);
            if (!content) continue;
            let scenarioIds: string[] = [];
            try {
                const rows = JSON.parse(content);
                if (Array.isArray(rows)) {
                    scenarioIds = rows
                        .map((r: { scenarioId?: string }) => r.scenarioId)
                        .filter((id): id is string => typeof id === 'string');
                }
            } catch {
                // Malformed JSON — leave empty; pre-gate audit will catch.
            }
            entries.push({
                path: abs,
                relativePath: path.relative(workspaceRoot, abs).replace(/\\/g, '/'),
                scenarioIds,
                moduleName,
            });
        }
        return entries;
    }

    // ---------------------------------------------------------------------
    // Config-file scanner
    // ---------------------------------------------------------------------

    private static scanConfigFiles(
        configRoot: string,
        workspaceRoot: string,
    ): ConfigInventoryEntry[] {
        const files = CSRepoInventory.findFiles(configRoot, /\.env$/);
        const entries: ConfigInventoryEntry[] = [];
        for (const abs of files) {
            const content = CSRepoInventory.safeRead(abs);
            if (!content) continue;
            const keys: string[] = [];
            for (const ln of content.split(/\r?\n/)) {
                const m = /^([A-Z_][A-Z0-9_]*)\s*=/.exec(ln.trim());
                if (m) keys.push(m[1]);
            }
            entries.push({
                path: abs,
                relativePath: path.relative(workspaceRoot, abs).replace(/\\/g, '/'),
                keys,
            });
        }
        return entries;
    }

    // ---------------------------------------------------------------------
    // Filesystem helpers
    // ---------------------------------------------------------------------

    private static findFiles(root: string, pattern: RegExp): string[] {
        const results: string[] = [];
        const stack: string[] = [root];
        while (stack.length > 0) {
            const dir = stack.pop()!;
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
                continue;
            }
            for (const entry of entries) {
                const abs = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    stack.push(abs);
                } else if (entry.isFile() && pattern.test(entry.name)) {
                    results.push(abs);
                }
            }
        }
        return results.sort();
    }

    /**
     * Given an absolute file path and the artefact root (e.g. `test/<project>/pages`),
     * extract the immediate sub-folder name as the module. Returns undefined
     * for flat layout (file directly under the artefact root).
     */
    private static extractModuleName(abs: string, artefactRoot: string): string | undefined {
        const rel = path.relative(artefactRoot, abs).replace(/\\/g, '/');
        const parts = rel.split('/');
        if (parts.length <= 1) return undefined;
        return parts[0] || undefined;
    }

    private static safeRead(filePath: string): string {
        try {
            return fs.readFileSync(filePath, 'utf-8');
        } catch {
            return '';
        }
    }
}
