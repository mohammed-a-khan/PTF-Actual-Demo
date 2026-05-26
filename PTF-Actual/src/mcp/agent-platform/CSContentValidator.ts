/**
 * Content-quality gate. Catches translator output defects: placeholder
 * strings in Gherkin, empty scenario bodies, duplicate imports, duplicate
 * @Page decorators, wrong-subpath imports from the framework package,
 * double-prefix sha lines, declared scenarios without matching step defs.
 *
 * Every rule corresponds to a concrete defect class. Run this gate before
 * persisting any LLM-produced translation.
 *
 * @module agent-platform/CSContentValidator
 */

import { FORBIDDEN_PLACEHOLDER_PATTERNS } from './CSDelegationSchemas';

export interface ContentViolation {
    /** Relative path of the file inside the translation map. */
    relativePath: string;
    /** Rule identifier — stable across versions for filtering. */
    ruleId: string;
    /** Severity — error blocks persistence, warning is informational. */
    severity: 'error' | 'warning';
    /** Human-readable message including the offending line where possible. */
    message: string;
    /** 1-indexed line number if known. */
    line?: number;
}

export interface TranslationFile {
    relativePath: string;
    kind: 'feature' | 'page' | 'steps' | 'data';
    content: string;
}

/** Valid framework subpaths — anything else is rejected. Kept in sync with
 *  the `exports` block in package.json. */
const VALID_FRAMEWORK_SUBPATHS: readonly string[] = [
    '', // bare import from package root
    'ado', 'ai', 'api', 'assertions', 'auth', 'bdd', 'codegen',
    'browser', 'core', 'dashboard', 'data', 'database',
    'database-utils', 'diagnostics', 'element', 'evidence',
    'media', 'mobile', 'monitoring', 'navigation', 'network',
    'parallel', 'performance', 'pipeline', 'reporting', 'reporter',
    'self-healing', 'spec', 'steps', 'types', 'utils', 'utilities',
    'visual', 'suite', 'accessibility', 'flaky', 'recording', 'cli',
];

/** Symbol → required subpath. Catches misroutes like
 *  `import { CSBDDStepDef } from '<pkg>/reporter'` (wrong; should be /bdd). */
const SYMBOL_SUBPATH_MAP: Record<string, string> = {
    CSBDDStepDef: 'bdd',
    StepDefinitions: 'bdd',
    Page: 'bdd',
    CSBDDContext: 'bdd',
    CSScenarioContext: 'bdd',
    CSReporter: 'reporting',
    CSBasePage: 'core',
    CSPage: 'core',
    CSGetElement: 'core',
    CSConfigurationManager: 'core',
    CSWebElement: 'element',
    CSElementFactory: 'element',
    CSValueResolver: 'utilities',
    CSDBUtils: 'database-utils',
    CSExcelUtility: 'utilities',
};

export class CSContentValidator {
    /** Validate every file in a translation map. Returns a flat list. */
    static validateAll(files: TranslationFile[]): ContentViolation[] {
        const all: ContentViolation[] = [];
        const declaredScenarios = new Set<string>();
        const stepDefTexts = new Set<string>();
        // Pattern → list of step files declaring it. Used by cross-file
        // gate 0c (duplicate step-def across files).
        const stepDefByPattern = new Map<string, string[]>();

        for (const file of files) {
            all.push(...CSContentValidator.validateFile(file));
            if (file.kind === 'feature') {
                CSContentValidator.collectScenarioStepText(file.content, declaredScenarios);
            }
            if (file.kind === 'steps') {
                const local = new Set<string>();
                CSContentValidator.collectStepDefTexts(file.content, local);
                for (const p of local) {
                    stepDefTexts.add(p);
                    const list = stepDefByPattern.get(p) ?? [];
                    list.push(file.relativePath);
                    stepDefByPattern.set(p, list);
                }
            }
        }

        // Cross-file gate 0c: duplicate @CSBDDStepDef patterns across files.
        // Splitting a translation into multiple step files (e.g.
        // `<module>.actions.steps.ts`, `<module>.validations.steps.ts`) is
        // fine — but if the same `@CSBDDStepDef('I see {string}')` pattern
        // appears in two files, BDD registration fails at runtime with
        // "ambiguous step definition." Catch it at content-gate time so
        // the agent dedupes before write rather than at execute.
        for (const [pattern, paths] of stepDefByPattern.entries()) {
            if (paths.length >= 2) {
                all.push({
                    relativePath: paths[0],
                    ruleId: 'duplicate-step-def-across-files',
                    severity: 'error',
                    message:
                        `@CSBDDStepDef pattern "${pattern}" is defined in ${paths.length} files: ` +
                        `${paths.join(', ')}. Each step pattern must live in exactly one file or BDD ` +
                        'registration throws "ambiguous step definition" at runtime. Move the duplicates ' +
                        'into one canonical file (typically the first one alphabetically) and delete the rest.',
                });
            }
        }

        // Cross-file gate 0d: data-driven JSON has parameter columns
        // (anything beyond scenarioId / scenarioName / runFlag) but the
        // feature uses plain `Scenario:` (no Scenario Outline, no <placeholder>
        // in step text). Either the feature should be a Scenario Outline
        // wired to the JSON, or the JSON columns are unused — both shapes
        // produce silent data drift. Flag at validate so the synthesizer
        // converts to the data-driven shape (per ff-scenario-outline skill).
        for (const dataFile of files.filter((f) => f.kind === 'data')) {
            let dataRows: unknown[];
            try {
                const parsed = JSON.parse(dataFile.content);
                if (!Array.isArray(parsed) || parsed.length === 0) continue;
                dataRows = parsed;
            } catch {
                continue; // separate JSON-parse gate covers this
            }
            const ignored = new Set(['scenarioId', 'scenarioName', 'runFlag', 'runflag']);
            const firstRow = dataRows[0] as Record<string, unknown>;
            const paramColumns = Object.keys(firstRow).filter((k) => !ignored.has(k));
            if (paramColumns.length === 0) continue;

            for (const featureFile of files.filter((f) => f.kind === 'feature')) {
                const blocks = CSContentValidator.splitScenarios(featureFile.content);
                if (blocks.length === 0) continue;
                const hasPlaceholderInStep = /^\s*(Given|When|Then|And|But)[^\n]*<\w+>/m.test(featureFile.content);
                const hasOutline = blocks.some((b) => b.isOutline);
                if (!hasOutline && !hasPlaceholderInStep) {
                    all.push({
                        relativePath: featureFile.relativePath,
                        ruleId: 'plain-scenario-with-data-params',
                        severity: 'error',
                        message:
                            `data file ${dataFile.relativePath} declares ${paramColumns.length} ` +
                            `parameter column(s) (${paramColumns.slice(0, 5).join(', ')}` +
                            `${paramColumns.length > 5 ? ', …' : ''}) but the feature uses plain ` +
                            '`Scenario:` blocks with hardcoded data. Convert to `Scenario Outline:` ' +
                            'with `<placeholder>` tokens referencing those columns + an `Examples:` ' +
                            'block sourced from the JSON. See ff-scenario-outline skill.',
                    });
                }
                // Note: the existing FF003 rule covers the `Examples:` JSON
                // envelope shape; we do not duplicate that check here.
            }
        }

        // Cross-file gate 0a: duplicate scenario titles in the same feature.
        // Legacy test methods sometimes share `testName` in @MetaData (the
        // suite path disambiguates them in Java). Once collapsed into a
        // single feature file the duplicate titles confuse reports and tag
        // filters. Require a disambiguator (legacy method name suffix is
        // typical).
        for (const featureFile of files.filter((f) => f.kind === 'feature')) {
            const titleCounts = new Map<string, number>();
            const blocks = CSContentValidator.splitScenarios(featureFile.content);
            for (const b of blocks) titleCounts.set(b.title, (titleCounts.get(b.title) ?? 0) + 1);
            for (const [title, count] of titleCounts.entries()) {
                if (count >= 2) {
                    all.push({
                        relativePath: featureFile.relativePath,
                        ruleId: 'duplicate-scenario-title',
                        severity: 'error',
                        message: `${count} scenarios share the title "${title}". Each Scenario in a feature must have a unique title — disambiguate by appending the legacy method name or the variant (e.g. "${title} — SQL flavor" vs "${title} — Oracle flavor"). Report grouping and @<tag> filters break when titles collide.`,
                    });
                }
            }
        }

        // Cross-file gate 0b: orphan @CSBDDStepDef. Steps file declares a
        // pattern that no feature step matches → dead code. Inverse of the
        // existing unmatched-feature-step gate.
        if (declaredScenarios.size > 0 && stepDefTexts.size > 0) {
            const featureStepTexts = new Set<string>();
            for (const declared of declaredScenarios) {
                const t = declared.split('::')[1] ?? declared;
                featureStepTexts.add(t);
            }
            const orphans: string[] = [];
            for (const stepDef of stepDefTexts) {
                const re = CSContentValidator.cucumberToRegex(stepDef);
                const matched = Array.from(featureStepTexts).some((ft) => re.test(ft));
                if (!matched) orphans.push(stepDef);
            }
            if (orphans.length > 0) {
                const stepsFile = files.find((f) => f.kind === 'steps');
                if (stepsFile) {
                    all.push({
                        relativePath: stepsFile.relativePath,
                        ruleId: 'orphan-step-def',
                        severity: 'error',
                        message: `${orphans.length} @CSBDDStepDef pattern(s) have no matching feature step (dead code): ${orphans.slice(0, 5).map((p) => `"${p}"`).join(', ')}${orphans.length > 5 ? ` and ${orphans.length - 5} more` : ''}. Delete the unused step defs or add the matching scenario step.`,
                    });
                }
            }
        }

        // Cross-file gate 1: every scenario step keyword+text must have a
        // matching @CSBDDStepDef. Catches the 12-undefined-steps failure
        // class — partial coverage that the coarse check missed.
        if (stepDefTexts.size === 0 && declaredScenarios.size > 0) {
            const stepsFile = files.find((f) => f.kind === 'steps');
            if (stepsFile) {
                all.push({
                    relativePath: stepsFile.relativePath,
                    ruleId: 'no-step-defs-for-declared-scenarios',
                    severity: 'error',
                    message: `feature declares ${declaredScenarios.size} scenario(s) with step lines but steps file contains 0 @CSBDDStepDef decorators`,
                });
            }
        } else if (declaredScenarios.size > 0) {
            // Convert step-def regex patterns to actual regexes and check
            // every feature step text matches at least one.
            const stepDefRegexes = Array.from(stepDefTexts).map(CSContentValidator.cucumberToRegex);
            const unmatched: string[] = [];
            for (const stepText of declaredScenarios) {
                const text = stepText.split('::')[1] ?? stepText;
                if (!stepDefRegexes.some((re) => re.test(text))) {
                    unmatched.push(text);
                }
            }
            if (unmatched.length > 0) {
                const featureFile = files.find((f) => f.kind === 'feature');
                const stepsFile = files.find((f) => f.kind === 'steps');
                const target = stepsFile ?? featureFile;
                if (target) {
                    all.push({
                        relativePath: target.relativePath,
                        ruleId: 'unmatched-feature-step',
                        severity: 'error',
                        message: `${unmatched.length} feature step(s) have no matching @CSBDDStepDef: ${unmatched.slice(0, 5).map((s) => `"${s}"`).join(', ')}${unmatched.length > 5 ? ` and ${unmatched.length - 5} more` : ''}. Add step defs whose pattern matches each feature step text exactly.`,
                    });
                }
            }
        }

        return all;
    }

    /**
     * Translate a Cucumber expression like `I create order {string}` to a
     * RegExp that matches the literal text with type placeholders.
     *   {string} → "[^"]+" OR '[^']+'
     *   {int}    → \d+
     *   {float}  → \d+(?:\.\d+)?
     *   {word}   → \S+
     */
    private static cucumberToRegex(pattern: string): RegExp {
        let body = pattern.replace(/[.*+?^=!:${}()|[\]\\]/g, '\\$&');
        // v1.39.5 — also accept Gherkin Scenario Outline `<placeholder>`
        // syntax (with or without surrounding quotes) as a valid match for
        // every Cucumber expression class. At runtime Gherkin substitutes
        // `<param>` with the Examples-row value BEFORE the step-def regex
        // runs, so the step-def matches the substituted value. But the
        // content-gate validator sees the PRE-substitution text and must
        // accept the placeholder shape OR every Scenario Outline step
        // unconditionally fails `unmatched-feature-step`.
        const PLACEHOLDER = '<[A-Za-z_][\\w-]*>';
        body = body.replace(/\\\{string\\\}/g, `(?:"[^"]+"|'[^']+'|"${PLACEHOLDER}"|'${PLACEHOLDER}'|${PLACEHOLDER})`);
        body = body.replace(/\\\{int\\\}/g, `(?:\\d+|${PLACEHOLDER})`);
        body = body.replace(/\\\{float\\\}/g, `(?:\\d+(?:\\.\\d+)?|${PLACEHOLDER})`);
        body = body.replace(/\\\{word\\\}/g, `(?:\\S+|${PLACEHOLDER})`);
        return new RegExp(`^${body}$`);
    }

    private static validateFile(file: TranslationFile): ContentViolation[] {
        const violations: ContentViolation[] = [];
        const lines = file.content.split(/\r?\n/);

        // Rule 1: forbidden placeholder strings (case-insensitive on the whole file).
        const lowerContent = file.content.toLowerCase();
        for (const pat of FORBIDDEN_PLACEHOLDER_PATTERNS) {
            const idx = lowerContent.indexOf(pat.toLowerCase());
            if (idx !== -1) {
                const line = file.content.slice(0, idx).split('\n').length;
                violations.push({
                    relativePath: file.relativePath,
                    ruleId: 'forbidden-placeholder',
                    severity: 'error',
                    line,
                    message: `forbidden placeholder string "${pat}" found — content must be real or fail loudly`,
                });
            }
        }

        // Rule 2: double sha prefix `sha256: sha256-`
        if (/sha256\s*:\s*sha256[-_]/i.test(file.content)) {
            violations.push({
                relativePath: file.relativePath,
                ruleId: 'double-sha-prefix',
                severity: 'error',
                message: 'double "sha256:" prefix detected — likely template bug',
            });
        }

        // Rule 3: duplicate imports of the same identifier
        const imports = new Map<string, number[]>();
        lines.forEach((ln, i) => {
            const m = ln.match(/import\s*\{\s*([^}]+)\s*\}\s*from\s*['"]([^'"]+)['"]/);
            if (m) {
                const symbols = m[1].split(',').map((s) => s.trim()).filter(Boolean);
                for (const sym of symbols) {
                    const key = `${sym}__${m[2]}`;
                    if (!imports.has(key)) imports.set(key, []);
                    imports.get(key)!.push(i + 1);
                }
            }
        });
        for (const [key, occurrences] of imports.entries()) {
            if (occurrences.length > 1) {
                const sym = key.split('__')[0];
                violations.push({
                    relativePath: file.relativePath,
                    ruleId: 'duplicate-import',
                    severity: 'error',
                    line: occurrences[1],
                    message: `import { ${sym} } appears ${occurrences.length} times (lines ${occurrences.join(', ')})`,
                });
            }
        }

        // Rule 4: wrong subpath imports from the framework package.
        lines.forEach((ln, i) => {
            const m = ln.match(/import\s*\{\s*([^}]+)\s*\}\s*from\s*['"]([^'"]+)['"]/);
            if (!m) return;
            const from = m[2];
            // Match against any company-prefixed cs-playwright-test-framework path
            const frameworkPath = from.match(/^@[^/]+\/cs-playwright-test-framework(?:\/(.+))?$/);
            if (!frameworkPath) return;
            const subpath = frameworkPath[1] ?? '';
            if (!VALID_FRAMEWORK_SUBPATHS.includes(subpath)) {
                violations.push({
                    relativePath: file.relativePath,
                    ruleId: 'invalid-framework-subpath',
                    severity: 'error',
                    line: i + 1,
                    message: `import from invalid framework subpath "${subpath}" — not in package.json exports`,
                });
                return;
            }
            // Check each symbol routes to its required subpath
            const symbols = m[1].split(',').map((s) => s.trim()).filter(Boolean);
            for (const sym of symbols) {
                const cleanSym = sym.replace(/\s+as\s+\w+$/, '');
                const required = SYMBOL_SUBPATH_MAP[cleanSym];
                if (required && required !== subpath) {
                    violations.push({
                        relativePath: file.relativePath,
                        ruleId: 'wrong-subpath-for-symbol',
                        severity: 'error',
                        line: i + 1,
                        message: `${cleanSym} should be imported from "${required}" subpath, not "${subpath}"`,
                    });
                }
            }
        });

        // Rule 5: duplicate decorator keys / page property names (TS files)
        if (file.kind === 'page' || file.kind === 'steps') {
            const decoratorKeys = new Map<string, number[]>();
            const propNames = new Map<string, number[]>();
            lines.forEach((ln, i) => {
                const dm = ln.match(/@(?:Page|CSPage)\s*\(\s*['"]([^'"]+)['"]/);
                if (dm) {
                    const k = dm[1];
                    if (!decoratorKeys.has(k)) decoratorKeys.set(k, []);
                    decoratorKeys.get(k)!.push(i + 1);
                }
                const pm = ln.match(/^\s*(?:private|protected|public|readonly)?\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*[A-Z]/);
                if (pm) {
                    const name = pm[1];
                    if (!propNames.has(name)) propNames.set(name, []);
                    propNames.get(name)!.push(i + 1);
                }
            });
            for (const [key, occ] of decoratorKeys.entries()) {
                if (occ.length > 1) {
                    violations.push({
                        relativePath: file.relativePath,
                        ruleId: 'duplicate-page-decorator',
                        severity: 'error',
                        line: occ[1],
                        message: `@Page('${key}') decorator appears ${occ.length} times (lines ${occ.join(', ')})`,
                    });
                }
            }
            for (const [name, occ] of propNames.entries()) {
                if (occ.length > 1) {
                    violations.push({
                        relativePath: file.relativePath,
                        ruleId: 'duplicate-class-property',
                        severity: 'error',
                        line: occ[1],
                        message: `class property "${name}" declared ${occ.length} times (lines ${occ.join(', ')})`,
                    });
                }
            }
        }

        // Rule 6: feature file scenario with empty body
        if (file.kind === 'feature') {
            const blocks = CSContentValidator.splitScenarios(file.content);
            for (const block of blocks) {
                const hasRealStep = block.lines.some((l) => {
                    const t = l.trim();
                    if (!/^(Given|When|Then|And|But)\b/.test(t)) return false;
                    // 'Given I am logged in' alone doesn't count as scenario body
                    if (/^Given I am logged in/i.test(t) && block.lines.filter((x) => /^(When|Then)\b/.test(x.trim())).length === 0) {
                        return false;
                    }
                    return true;
                });
                if (!hasRealStep) {
                    violations.push({
                        relativePath: file.relativePath,
                        ruleId: 'empty-scenario-body',
                        severity: 'error',
                        line: block.startLine,
                        message: `scenario "${block.title}" has no real body (only login or no steps at all)`,
                    });
                }

                // Rule 6a: Scenario Outline must reference at least one
                // `<placeholder>` in its body. Otherwise it should be plain
                // `Scenario:`. Per ff-scenario-outline skill.
                if (block.isOutline) {
                    const referencesPlaceholder = block.lines.some((l) =>
                        /<[a-zA-Z_][a-zA-Z0-9_]*>/.test(l),
                    );
                    if (!referencesPlaceholder) {
                        violations.push({
                            relativePath: file.relativePath,
                            ruleId: 'scenario-outline-misuse',
                            severity: 'error',
                            line: block.startLine,
                            message: `scenario "${block.title}" is declared "Scenario Outline" but body has no <placeholder> reference — use plain "Scenario:" (no Outline). See skill: ff-scenario-outline.`,
                        });
                    }
                }

                // Rule 6b: Examples block, if present, MUST follow the
                // framework's JSON-envelope shape, not Gherkin's plain
                // table form. Per ff-scenario-outline skill.
                if (block.examplesLine) {
                    const ex = block.examplesLine.trim();
                    const isJsonEnvelope = /^Examples:\s*\{[\s\S]*"type"\s*:\s*"json"/.test(ex);
                    if (!isJsonEnvelope) {
                        violations.push({
                            relativePath: file.relativePath,
                            ruleId: 'examples-envelope-shape',
                            severity: 'error',
                            line: block.examplesLineNum,
                            message: `scenario "${block.title}" uses plain-table Examples; framework requires the JSON envelope: \`Examples: {"type":"json","source":"<path>","path":"$","filter":"scenarioId=<id> AND runFlag=Yes"}\`. See skill: ff-scenario-outline.`,
                        });
                    }
                }
            }

            // Rule 6c: helper-class-name leak in Gherkin. Patterns like
            // `CTSSupportMethod.TS_4963` are code references that shouldn't
            // appear in user-facing step text. Detect ClassName.methodName
            // tokens on Given/When/Then/And/But lines.
            lines.forEach((ln, i) => {
                const t = ln.trim();
                if (!/^(Given|When|Then|And|But)\b/.test(t)) return;
                const m = t.match(/\b([A-Z][a-zA-Z0-9]+)\.([A-Z][a-zA-Z0-9_]+)\b/);
                if (m) {
                    violations.push({
                        relativePath: file.relativePath,
                        ruleId: 'helper-class-leak-in-gherkin',
                        severity: 'error',
                        line: i + 1,
                        message: `step contains code reference "${m[1]}.${m[2]}" — translate to a human-readable step like "Given I am signed in as <user>"`,
                    });
                }
            });

            // Rule 6e: bare Java/internal identifier leak in Gherkin step text.
            // Catches things like:
            //   When I create a UserBean from the row
            //   And support method TS_0000 is invoked
            // The token must look like a code identifier (CamelCase
            // ending in a known suffix, or a Java-style helper id) — not
            // every CamelCase noun in a sentence.
            // Suffix list narrowed in v1.39.4: previous list included
            // `Manager`, `Helper`, `Util`, `Service`, `Builder`, `Controller`,
            // `Validator`, `Factory` — all common English nouns that produce
            // false positives on legit user-action steps ("Account Manager",
            // "Service Desk"). Only suffixes that are exclusively code-shape
            // identifiers remain; code-style usage like `ClassName.method` is
            // independently caught by rule 6c.
            const INTERNAL_ID_SUFFIXES = [
                'Bean', 'Pojo', 'POJO', 'DTO', 'Dao', 'DAO',
                'SupportMethod',
            ];
            lines.forEach((ln, i) => {
                const t = ln.trim();
                if (!/^(Given|When|Then|And|But)\b/.test(t)) return;
                // bare CamelCase ending in one of the known suffixes (no
                // space between root + suffix, no dot — those are caught
                // by 6c).
                const suffixPattern = INTERNAL_ID_SUFFIXES.map((s) =>
                    s.replace(/[.*+?^=!:${}()|[\]\\]/g, '\\$&'),
                ).join('|');
                const idRe = new RegExp(`\\b([A-Z][a-zA-Z0-9]*(?:${suffixPattern}))\\b`);
                const idMatch = t.match(idRe);
                if (idMatch) {
                    violations.push({
                        relativePath: file.relativePath,
                        ruleId: 'java-identifier-leak-in-gherkin',
                        severity: 'error',
                        line: i + 1,
                        message: `step contains internal code identifier "${idMatch[1]}" — Gherkin must describe user-visible actions, not internal class names. Translate to a real action like "When I create a new user" or remove the data-prep step entirely (data loading is handled by the Examples envelope).`,
                    });
                }
                // helper-method id pattern: `TS_<digits>` referenced as a
                // method/support call (NOT as a scenarioId placeholder).
                const tsMethodMatch = t.match(/\b(?:support\s+method|method|helper)\s+(TS_\d+)\b/i);
                if (tsMethodMatch) {
                    violations.push({
                        relativePath: file.relativePath,
                        ruleId: 'java-identifier-leak-in-gherkin',
                        severity: 'error',
                        line: i + 1,
                        message: `step references helper-method id "${tsMethodMatch[1]}" — Gherkin should describe what the support method DOES (e.g. "Given a new <entity> is staged with valid fields"), not name the internal helper.`,
                    });
                }
            });

            // Rule 6f: generic placeholder step text. Catches the
            // "I perform the steps for <scenarioId>" / "verify expected
            // outcomes for <scenarioId>" anti-pattern where the LLM
            // collapses N legacy tests into one Outline with abstract
            // steps that don't describe a real action.
            const GENERIC_STEP_PATTERNS: Array<{ re: RegExp; hint: string }> = [
                {
                    re: /^(Given|When|Then|And|But)\s+I\s+perform\s+the\s+steps?\s+for\b/i,
                    hint: '"perform the steps for <id>" is not a real action — emit one Scenario per legacy @Test with the actual click/fill/verify steps.',
                },
                {
                    re: /^(Given|When|Then|And|But)\s+verify\s+(expected\s+)?(outcomes?|results?|outputs?)\b/i,
                    hint: '"verify expected outcomes" is abstract — Then steps must name the specific assertion (e.g. "Then the user is saved and the success message is displayed").',
                },
                {
                    re: /^(Given|When|Then|And|But)\s+(do|run|execute|perform)\s+the\s+(test|scenario|actions?)\b/i,
                    hint: 'abstract "execute the test" step rejected — describe the actual interaction.',
                },
                {
                    re: /^(Given|When|Then|And|But)\s+support\s+method\s+is\s+invoked\b/i,
                    hint: '"support method is invoked" hides what was done — write the real preparation step (e.g. "Given a <entity> named <name> is staged in the test environment").',
                },
                {
                    re: /^(Given|When|Then|And|But)\s+test\s+data\s+(is|was)?\s*loaded\b/i,
                    hint: '"test data loaded" is not a user action — Examples envelope handles data loading; remove this step or convert to a precondition the test actually depends on.',
                },
                {
                    re: /^(Given|When|Then|And|But)\s+(?:I\s+)?(?:complete|finish|wrap\s+up)\s+the\s+(?:flow|process|operation)\b/i,
                    hint: 'vague "complete the flow" step — name the final action and assertion explicitly.',
                },
                {
                    // Catches: "Execute shared support flow XYZ", "Run helper method foo",
                    // "Invoke shared helper", "Trigger support routine", "Process via helper" — every
                    // variant of "delegate to internal helper" the LLM uses to dodge writing real
                    // steps. The verb list is broad on purpose: every rephrase still has a verb +
                    // helper/flow/support/routine token combo.
                    re: /^(Given|When|Then|And|But)\s+(execute|run|invoke|perform|trigger|call|process|delegate)\s+(?:the\s+|a\s+|shared\s+|legacy\s+|common\s+)?(?:support\s+)?(?:flow|helper|method|routine|procedure|operation|step|util)\b/i,
                    hint: '"execute/run/invoke <flow|helper|method>" hides what the helper actually does. The helper must be EXPANDED into its leaf actions inline: read the helper file, emit one Gherkin step per click/fill/select inside it, cite each step with the helper file + line number.',
                },
                {
                    // Catches: "Execute shared support flow XYZ" — a helper-id appears anywhere
                    // in user-facing step text. Test-case ids (`@TS_xxx` tag) are fine; helper-method
                    // ids inside step text are not.
                    re: /^(Given|When|Then|And|But)\s+.*\b(?:TS_\d{2,}|AAA[-_]\d{2,}|H[-_]\d{2,})\b/i,
                    hint: 'Step text references an internal helper/test id (TS_xxxx / AAA-xxxx). Those ids belong in @tags or the data row, never in user-facing Gherkin. Rewrite the step to describe what the helper does (e.g. "Given a SQL user is staged with valid AD-ENT id").',
                },
                {
                    re: /^(Given|When|Then|And|But)\s+(?:I\s+)?prepare\s+test\s+data(?:\s+from\b|\s*$)/i,
                    hint: '"Prepare test data" is a data-loading concern handled by the Examples envelope. Either remove this step or convert it to a precondition that actually asserts something (e.g. "Given a user with login <loginKey> exists in the test environment").',
                },
            ];
            lines.forEach((ln, i) => {
                const t = ln.trim();
                if (!/^(Given|When|Then|And|But)\b/.test(t)) return;
                for (const pat of GENERIC_STEP_PATTERNS) {
                    if (pat.re.test(t)) {
                        violations.push({
                            relativePath: file.relativePath,
                            ruleId: 'generic-placeholder-step-text',
                            severity: 'error',
                            line: i + 1,
                            message: `generic placeholder step "${t}" — ${pat.hint}`,
                        });
                        break;
                    }
                }
            });
        }

        // Rule 6d (steps file): step-def body must do at least one element
        // interaction. Bodies that only call CSReporter.pass(...) are stubs
        // dressed in success-message clothing.
        if (file.kind === 'steps') {
            const methodPattern = /@CSBDDStepDef\s*\([^)]*\)\s*\r?\n\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*[:{]/g;
            const bodies = CSContentValidator.extractStepDefBodies(file.content);
            for (const body of bodies) {
                const trimmed = body.body.trim();
                if (!trimmed) continue;
                const hasElementCall =
                    /\bawait\s+this\.[a-zA-Z_][a-zA-Z0-9_]*Page\b/.test(trimmed) ||
                    /\bawait\s+this\.[a-zA-Z_][a-zA-Z0-9_]*\.(?:click|fill|select|hover|press|type|navigate|getText|verifyText|verifyValue|waitFor|isVisible|expect)/.test(trimmed) ||
                    /\b(CSDBUtils|CSConfigurationManager|CSValueResolver)\b/.test(trimmed) ||
                    /\bnew\s+\w+/.test(trimmed);
                const onlyReporter =
                    /^[\s;]*CSReporter\.[a-z]+\([^)]*\)\s*;?[\s;]*$/i.test(trimmed) ||
                    /^[\s;]*return\s*;?\s*$/.test(trimmed);
                if (!hasElementCall && (onlyReporter || trimmed.length < 30)) {
                    violations.push({
                        relativePath: file.relativePath,
                        ruleId: 'stub-step-body',
                        severity: 'error',
                        line: body.startLine,
                        message: `@CSBDDStepDef "${body.method}" body has no element interaction (page-method call, CSDBUtils, CSConfigurationManager). Stub bodies that only call CSReporter.pass(...) are rejected — implement the step or escalate as a gap.`,
                    });
                }
            }
            void methodPattern; // reserved for future use

            // Rule 6g: identical step-def bodies. Two failure modes:
            //   (1) Bulk laziness — ≥50% of bodies share the same body.
            //   (2) Trivial-stub laziness — ANY 2+ methods share an identical
            //       body when that body is short (≤80 chars normalized) AND
            //       has ≤2 meaningful method calls. The user observed two
            //       step defs (executeSupportTS4958/4960) with identical
            //       `waitForVisible(...)` bodies; the 50% threshold missed
            //       them because the steps file had 26 methods. Trivial-stub
            //       detection catches that case without false-positiving on
            //       legitimate similar-but-distinct steps in a large file.
            const norm = new Map<string, string[]>();
            for (const b of bodies) {
                const stripped = b.body
                    .replace(/\/\/[^\n]*/g, '')
                    .replace(/\/\*[\s\S]*?\*\//g, '')
                    .replace(/CSReporter\.[a-z]+\s*\([^)]*\)\s*;?/gi, '')
                    .replace(/\s+/g, ' ')
                    .trim();
                if (stripped.length < 20) continue;
                if (!norm.has(stripped)) norm.set(stripped, []);
                norm.get(stripped)!.push(b.method);
            }
            const total = bodies.length;
            // Count distinct meaningful method calls in a body (await this.x.y(),
            // CSDBUtils.q(), etc). Used to classify "trivial" vs "rich" bodies.
            const countCalls = (body: string): number => {
                const matches = body.match(/\b(?:await\s+)?[a-zA-Z_$][\w$]*\.[a-zA-Z_$][\w$]*\s*\(/g) ?? [];
                return new Set(matches.map((m) => m.replace(/\s+/g, ''))).size;
            };
            if (total >= 2) {
                let bulkDuped = 0;
                const trivialDupes: Array<{ body: string; methods: string[] }> = [];
                const bulkDupes: Array<{ body: string; methods: string[] }> = [];
                for (const [body, methods] of norm.entries()) {
                    if (methods.length < 2) continue;
                    bulkDuped += methods.length;
                    if (body.length <= 80 && countCalls(body) <= 2) {
                        trivialDupes.push({ body, methods });
                    } else {
                        bulkDupes.push({ body, methods });
                    }
                }
                // (1) Trivial-stub: any 2+ methods sharing a short low-call body.
                if (trivialDupes.length > 0) {
                    const offending = trivialDupes.flatMap((d) => d.methods);
                    const sample = trivialDupes[0];
                    violations.push({
                        relativePath: file.relativePath,
                        ruleId: 'duplicate-step-def-bodies',
                        severity: 'error',
                        message: `${offending.length} @CSBDDStepDef method(s) share a trivial body (${trivialDupes.length} group(s)). Each step must do its OWN action — sharing a short waitForVisible/click body across multiple steps signals a stub that wasn't filled in. Methods: [${offending.slice(0, 8).join(', ')}] all do: \`${sample.body.slice(0, 120)}${sample.body.length > 120 ? '…' : ''}\`. Implement each step body with its real action sequence.`,
                    });
                }
                // (2) Bulk laziness — kept at the 50% threshold to avoid false
                // positives on intentionally similar non-trivial bodies.
                if (total >= 3 && bulkDuped >= Math.max(2, Math.floor(total * 0.5))) {
                    const example = bulkDupes[0] ?? trivialDupes[0];
                    if (example && !trivialDupes.includes(example)) {
                        violations.push({
                            relativePath: file.relativePath,
                            ruleId: 'duplicate-step-def-bodies',
                            severity: 'error',
                            message: `${bulkDuped}/${total} @CSBDDStepDef methods share the same body (after normalizing whitespace + CSReporter calls). Each step must do its OWN action. Methods sharing a body: [${example.methods.join(', ')}] all do: \`${example.body.slice(0, 120)}${example.body.length > 120 ? '…' : ''}\``,
                        });
                    }
                }
            }
        }

        // Rule 7: page object with zero elements AND zero methods
        if (file.kind === 'page') {
            const hasElement = /@CSGetElement|protected\s+\w+\s*:\s*CSWebElement|new\s+CSWebElement/.test(file.content);
            const hasMethod = /(?:public|async)\s+\w+\s*\([^)]*\)\s*[:{]/.test(file.content);
            if (!hasElement && !hasMethod) {
                violations.push({
                    relativePath: file.relativePath,
                    ruleId: 'empty-page-object',
                    severity: 'error',
                    message: 'page object has no @CSGetElement fields and no methods',
                });
            }

            // ------------------------------------------------------------
            // v1.39.2 — decorator-syntax + framework-wrapper enforcement
            // ------------------------------------------------------------
            // The synthesizer prompt was hotfixed in v1.38.9 to teach the
            // correct `xpath:` shape, but the LLM occasionally still slips
            // into the old `strategy:`/`locator:` pattern (it was the
            // documented convention until last week). These content-gate
            // rules catch any survivors at finalize time so the heal-loop's
            // deterministic compile-fixer (CSHealLoop.applyDeterministicCompileFixes)
            // can repair them before tsc fails.

            // Rule 5a: @CSGetElement uses `strategy: 'xpath'` / `locator: '...'`
            // — the CSElementOptions interface has neither property. The
            // correct shape is `xpath: '...'` or `css: '...'` directly.
            const strategyMatches = file.content.match(/@CSGetElement\s*\([^)]*strategy\s*:/g);
            if (strategyMatches && strategyMatches.length > 0) {
                violations.push({
                    relativePath: file.relativePath,
                    ruleId: 'csgetelement-wrong-shape',
                    severity: 'error',
                    message:
                        `${strategyMatches.length} @CSGetElement decorator(s) use ` +
                        '`strategy:`/`locator:` — these properties do not exist on CSElementOptions ' +
                        "and produce compile errors. Use `xpath: '...'` (or `css: '...'`) directly. " +
                        'See po-self-healing-element skill for the correct shape.',
                });
            }

            // Rule 5b: alternativeLocators is an object array (e.g. `[{ strategy: 'css', locator: '...' }]`)
            // instead of the required `string[]` with prefix syntax
            // (`['css:input#id', 'xpath://input[@id="id"]']`).
            const altObjectMatch = /alternativeLocators\s*:\s*\[\s*\{/.exec(file.content);
            if (altObjectMatch) {
                violations.push({
                    relativePath: file.relativePath,
                    ruleId: 'alternative-locators-wrong-shape',
                    severity: 'error',
                    message:
                        '`alternativeLocators` must be `string[]` with prefix syntax ' +
                        "(`['css:input#id', 'xpath://input[@id=\"id\"]']`), not an object array. " +
                        'Object literals like `[{ strategy: \'css\', locator: \'...\' }]` do not compile.',
                });
            }

            // Rule 5c: calls `.getAttributeValue(...)` — that method does not
            // exist on CSWebElement. The correct method is `.getAttribute(name)`.
            const getAttrValueMatches = file.content.match(/\.getAttributeValue\s*\(/g);
            if (getAttrValueMatches && getAttrValueMatches.length > 0) {
                violations.push({
                    relativePath: file.relativePath,
                    ruleId: 'non-existent-getAttributeValue',
                    severity: 'error',
                    message:
                        `${getAttrValueMatches.length} call(s) to non-existent ` +
                        '`.getAttributeValue(...)`. The CSWebElement method is `.getAttribute(name)` ' +
                        '(no "Value" suffix). Compile errors guaranteed.',
                });
            }

            // Rule 5d: swapped argument order on value-carrying *WithTimeout
            // methods. CSWebElement signatures put the VALUE first and the
            // timeout LAST — `fillWithTimeout(value, timeout)`,
            // `typeWithTimeout(text, timeout)`, `selectOptionWithTimeout(values,
            // timeout)`, etc. The LLM frequently emits them reversed
            // (`fillWithTimeout(1000, value)`). None of these methods take a
            // numeric literal as the first argument (the value is a string /
            // string[] / boolean / file path), so a bare digit immediately
            // after `(` is an unambiguous swapped-args bug. (Timeout-only
            // methods like `clickWithTimeout(30000)` are intentionally NOT in
            // this list — a numeric first arg is correct for those.)
            const swappedTimeoutRe =
                /\.(fill|type|pressSequentially|press|selectOption|uploadFiles|uploadFile|setChecked|getAttribute|dragTo|dispatchEvent)WithTimeout\s*\(\s*\d/g;
            const swappedHits: string[] = [];
            let swappedMatch: RegExpExecArray | null;
            while ((swappedMatch = swappedTimeoutRe.exec(file.content)) !== null) {
                swappedHits.push(`${swappedMatch[1]}WithTimeout`);
            }
            if (swappedHits.length > 0) {
                violations.push({
                    relativePath: file.relativePath,
                    ruleId: 'swapped-withtimeout-args',
                    severity: 'error',
                    message:
                        `${swappedHits.length} call(s) with swapped *WithTimeout arguments: ` +
                        `${Array.from(new Set(swappedHits)).slice(0, 5).join(', ')}. ` +
                        'These methods take the VALUE first and the timeout LAST — ' +
                        '`fillWithTimeout(value, 5000)`, NOT `fillWithTimeout(5000, value)`. ' +
                        'A numeric literal in the first argument position is always wrong here.',
                });
            }

        }

        // ----------------------------------------------------------------
        // Rules 5e/5f apply to BOTH page and steps files. Step bodies that
        // bypass the framework wrappers cause the same self-healing /
        // reporting drift as page-object code that does it. Moved out of
        // the `kind === 'page'` block so steps are covered too.
        // ----------------------------------------------------------------
        if (file.kind === 'page' || file.kind === 'steps') {
            // Rule 5e: raw `this.page.locator(...)` / `.click()` / `.fill()` /
            // `.type()` / `.hover()` / `.press()`. Every interaction MUST go
            // through @CSGetElement-decorated property + inherited CSBasePage
            // helpers — the wrapper tracks self-healing, screenshots,
            // reporting, and waits. Raw Playwright calls bypass all of that.
            const rawPageRe = /\bthis\.page\.(locator|click|fill|type|hover|press|check|uncheck|selectOption|dblclick|tap)\s*\(/g;
            const rawPageHits: string[] = [];
            let rawMatch: RegExpExecArray | null;
            while ((rawMatch = rawPageRe.exec(file.content)) !== null) {
                rawPageHits.push(`this.page.${rawMatch[1]}(`);
            }
            if (rawPageHits.length > 0) {
                violations.push({
                    relativePath: file.relativePath,
                    ruleId: 'raw-playwright-api',
                    severity: 'error',
                    message:
                        `${rawPageHits.length} raw Playwright call(s) in a ${file.kind} file: ` +
                        `${Array.from(new Set(rawPageHits)).slice(0, 5).join(', ')}. ` +
                        'Route interactions through @CSGetElement properties ' +
                        '(`this.myButton.click()`, `this.userInput.fill(value)`) or ' +
                        'inherited CSBasePage helpers. Raw `this.page.*` bypasses ' +
                        'self-healing, reporting, and the wait pipeline.',
                });
            }

            // Rule 5f: raw `this.page.once('dialog', ...)` or `dialog.accept()`
            // / `dialog.dismiss()` instead of inherited helpers. CSBasePage
            // exposes `acceptNextDialog()` / `dismissNextDialog()` — use them.
            const rawDialogRe = /this\.page\.once\s*\(\s*['"`]dialog['"`]|dialog\.(accept|dismiss)\s*\(/;
            if (rawDialogRe.test(file.content)) {
                violations.push({
                    relativePath: file.relativePath,
                    ruleId: 'raw-dialog-handling',
                    severity: 'error',
                    message:
                        `Raw Playwright dialog handling in a ${file.kind} file ` +
                        '(`this.page.once("dialog", …)` or `dialog.accept()`/`dialog.dismiss()`). ' +
                        'CSBasePage inherits `acceptNextDialog()` / `dismissNextDialog()` helpers — ' +
                        'call those instead. See dialog-handling skill.',
                });
            }

            // ----------------------------------------------------------------
            // LOGIN / NAVIGATION rules (LN001-LN004). The single most common
            // failure mode is a hand-rolled login step that escapes the
            // framework: it grabs the raw Playwright Page via `.getPage()`,
            // drives `rawPage.fill()/.click()/.goto()` directly, invents
            // project-prefixed config keys, and re-implements SSO/Citrix
            // redirect handling that CSBasePage.navigate() already does.
            // ----------------------------------------------------------------

            // LN001: `.getPage()` — the escape hatch to the raw Playwright
            // Page. Rule 5e only catches `this.page.<method>()`; aliasing via
            // `const rawPage = this.somePage.getPage()` slips past it. Cut the
            // source: generated test code must never call `.getPage()`.
            const getPageMatches = file.content.match(/\.getPage\s*\(\s*\)/g);
            if (getPageMatches && getPageMatches.length > 0) {
                violations.push({
                    relativePath: file.relativePath,
                    ruleId: 'LN001',
                    severity: 'error',
                    message:
                        `${getPageMatches.length} call(s) to \`.getPage()\` in a ${file.kind} file. ` +
                        'That returns the raw Playwright Page and every call on it bypasses ' +
                        'self-healing, reporting, and waits. Drive interactions through ' +
                        '@CSGetElement-decorated CSWebElement properties and inherited CSBasePage ' +
                        'methods (navigate / acceptNextDialog / etc.). Never obtain a raw Page handle.',
                });
            }

            // LN002: project-prefixed config keys. The canonical keys are
            // `{config:BASE_URL}`, `{config:DEFAULT_USERNAME}`,
            // `{config:DEFAULT_PASSWORD}`. The LLM invents
            // `{config:CTSG_BASE_URL}` / `{config:<PROJECT>_USERNAME}` which
            // never exist in any generated env file. (DEFAULT_ is the one
            // legitimate prefix and is excluded.)
            const badConfigKeyRe = /\{config:(?!DEFAULT_)[A-Z][A-Z0-9]*_(?:BASE_URL|USERNAME|PASSWORD)\}/g;
            const badConfigHits = file.content.match(badConfigKeyRe);
            if (badConfigHits && badConfigHits.length > 0) {
                violations.push({
                    relativePath: file.relativePath,
                    ruleId: 'LN002',
                    severity: 'error',
                    message:
                        `${badConfigHits.length} project-prefixed config key(s): ` +
                        `${Array.from(new Set(badConfigHits)).slice(0, 5).join(', ')}. ` +
                        'Use the canonical keys — `{config:BASE_URL}`, `{config:DEFAULT_USERNAME}`, ' +
                        '`{config:DEFAULT_PASSWORD}`. Project-prefixed keys are never written to the ' +
                        'generated env files and resolve to empty at runtime.',
                });
            }

            // LN003: hand-rolled Citrix / NetScaler / LDAP SSO redirect code.
            // CSBasePage.navigate() delegates to CSCrossDomainNavigationHandler
            // which handles the SSO bounce automatically when
            // CROSS_DOMAIN_NAVIGATION_ENABLED=true. Re-implementing it inline
            // is both wrong and fragile.
            const ssoRedirectRe = /nsg-x|LogonPoint|doAuthentication|NetScaler|ldap-non-prod/i;
            if (ssoRedirectRe.test(file.content)) {
                violations.push({
                    relativePath: file.relativePath,
                    ruleId: 'LN003',
                    severity: 'error',
                    message:
                        `Hand-rolled SSO/Citrix/NetScaler redirect handling in a ${file.kind} file. ` +
                        'CSBasePage.navigate() already delegates to CSCrossDomainNavigationHandler, ' +
                        'which performs the SSO bounce automatically when ' +
                        'CROSS_DOMAIN_NAVIGATION_ENABLED=true. Remove the manual redirect block and ' +
                        'just call `this.<page>.navigate()`.',
                });
            }

            // LN004: raw navigation — `.goto(...)` / `.waitForURL(...)`. These
            // only exist on the raw Playwright Page. Navigation goes through
            // the inherited CSBasePage.navigate() (reads BASE_URL from config).
            const rawNavRe = /\.(goto|waitForURL)\s*\(/g;
            const rawNavHits: string[] = [];
            let rawNavMatch: RegExpExecArray | null;
            while ((rawNavMatch = rawNavRe.exec(file.content)) !== null) {
                rawNavHits.push(`.${rawNavMatch[1]}(`);
            }
            if (rawNavHits.length > 0) {
                violations.push({
                    relativePath: file.relativePath,
                    ruleId: 'LN004',
                    severity: 'error',
                    message:
                        `${rawNavHits.length} raw navigation call(s) in a ${file.kind} file: ` +
                        `${Array.from(new Set(rawNavHits)).join(', ')}. ` +
                        'Navigation uses the inherited `this.<page>.navigate()` (no URL argument — ' +
                        'it reads BASE_URL from config and handles cross-domain auth). Raw ' +
                        '`.goto()` / `.waitForURL()` bypass that pipeline.',
                });
            }
        }

        return violations;
    }

    private static collectScenarioStepText(featureContent: string, into: Set<string>): void {
        const lines = featureContent.split(/\r?\n/);
        for (const ln of lines) {
            const t = ln.trim();
            const m = t.match(/^(Given|When|Then|And|But)\s+(.+?)(?:\s*$)/);
            if (m) into.add(`${m[1]}::${m[2].trim()}`);
        }
    }

    private static collectStepDefTexts(stepsContent: string, into: Set<string>): void {
        // v1.38.7 — proper tokenizer. The old regex
        //   /@CSBDDStepDef\s*\(\s*['"]([^'"]+)['"]/g
        // had three real bugs that broke real-world step defs:
        //   1. Embedded quotes in single-quoted JS strings
        //      e.g. @CSBDDStepDef('I see "User saved."') was truncated to
        //      `I see ` because the embedded " ended the character class.
        //   2. Backtick template literals weren't matched at all.
        //   3. Escape sequences (`\'`, `\"`, `` \` ``) weren't honoured.
        //
        // The fix: locate `@CSBDDStepDef(`, then read the next JS string
        // literal honouring its actual quote-style + escape rules.
        const decoratorRe = /@CSBDDStepDef\s*\(\s*(['"`])/g;
        let m: RegExpExecArray | null;
        while ((m = decoratorRe.exec(stepsContent)) !== null) {
            const quote = m[1];
            const start = m.index + m[0].length;
            // Read forward until we see the matching unescaped quote.
            let i = start;
            let pattern = '';
            while (i < stepsContent.length) {
                const ch = stepsContent[i];
                if (ch === '\\' && i + 1 < stepsContent.length) {
                    // Escape sequence — unescape known JS escapes; copy the
                    // raw char otherwise. Cucumber expressions only care
                    // about the unescaped pattern text.
                    const next = stepsContent[i + 1];
                    const unescaped: Record<string, string> = {
                        '\\': '\\', "'": "'", '"': '"', '`': '`',
                        n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '0': '\0',
                    };
                    pattern += unescaped[next] !== undefined ? unescaped[next] : next;
                    i += 2;
                    continue;
                }
                if (ch === quote) break; // unescaped closing quote — done
                if (quote === '`' && ch === '$' && stepsContent[i + 1] === '{') {
                    // Template-literal interpolation `${...}` — fast-forward
                    // past the closing brace. We KEEP a placeholder so the
                    // pattern continues to round-trip-match feature steps.
                    pattern += '${...}';
                    i += 2;
                    let depth = 1;
                    while (i < stepsContent.length && depth > 0) {
                        if (stepsContent[i] === '{') depth++;
                        else if (stepsContent[i] === '}') depth--;
                        i++;
                    }
                    continue;
                }
                pattern += ch;
                i++;
            }
            if (pattern.length > 0) into.add(pattern);
        }
    }

    private static splitScenarios(featureContent: string): Array<{
        title: string;
        startLine: number;
        lines: string[];
        isOutline: boolean;
        examplesLine?: string;
        examplesLineNum?: number;
    }> {
        const lines = featureContent.split(/\r?\n/);
        type Block = {
            title: string;
            startLine: number;
            lines: string[];
            isOutline: boolean;
            examplesLine?: string;
            examplesLineNum?: number;
        };
        const blocks: Block[] = [];
        let current: Block | null = null;
        for (let i = 0; i < lines.length; i++) {
            const t = lines[i].trim();
            const m = t.match(/^Scenario(\s+Outline)?\s*:\s*(.+)$/);
            if (m) {
                if (current) blocks.push(current);
                current = {
                    title: m[2].trim(),
                    startLine: i + 1,
                    lines: [],
                    isOutline: !!m[1],
                };
                continue;
            }
            if (current) {
                if (/^Examples\s*:/.test(t)) {
                    // Capture the WHOLE Examples block — not just the first
                    // line. JSON envelope shape is commonly written across
                    // multiple lines:
                    //   Examples: {
                    //     "type": "json",
                    //     "source": "..."
                    //   }
                    // Accumulate lines from `Examples:` until either a brace
                    // balance returns to zero (closing `}`) OR we hit the
                    // next Scenario/Feature/Background.
                    const startIdx = i;
                    const accumulated: string[] = [lines[i]];
                    let depth = 0;
                    let sawOpen = false;
                    for (const ch of lines[i]) {
                        if (ch === '{') { depth++; sawOpen = true; }
                        else if (ch === '}') depth--;
                    }
                    while (i + 1 < lines.length && sawOpen && depth > 0) {
                        i++;
                        accumulated.push(lines[i]);
                        for (const ch of lines[i]) {
                            if (ch === '{') depth++;
                            else if (ch === '}') depth--;
                        }
                    }
                    current.examplesLine = accumulated.join('\n');
                    current.examplesLineNum = startIdx + 1;
                    continue;
                }
                if (/^(Scenario|Feature|Background|Rule)\b/.test(t)) {
                    blocks.push(current);
                    current = null;
                } else {
                    current.lines.push(lines[i]);
                }
            }
        }
        if (current) blocks.push(current);
        return blocks;
    }

    /**
     * Extract step-def method bodies from a steps file by counting braces.
     * Returns the method name + the raw body text between `{` and `}` for
     * each `@CSBDDStepDef`-decorated method.
     */
    private static extractStepDefBodies(stepsContent: string): Array<{
        method: string;
        body: string;
        startLine: number;
    }> {
        const results: Array<{ method: string; body: string; startLine: number }> = [];
        const lines = stepsContent.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            if (!/@CSBDDStepDef\s*\(/.test(lines[i])) continue;
            // Find the method name on the next non-empty line(s).
            let j = i + 1;
            while (j < lines.length && !lines[j].trim()) j++;
            const declarationLines: string[] = [];
            while (j < lines.length && !/\{\s*$/.test(lines[j]) && !lines[j].includes('{')) {
                declarationLines.push(lines[j]);
                j++;
                if (j - i > 6) break;
            }
            if (j >= lines.length) continue;
            declarationLines.push(lines[j]);
            const decl = declarationLines.join(' ');
            const methodMatch = decl.match(/(?:async\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/);
            const methodName = methodMatch?.[1] ?? '?';
            // Walk from the opening brace forward, tracking depth.
            let depth = 0;
            let bodyStart = -1;
            const bodyChars: string[] = [];
            for (let k = j; k < lines.length; k++) {
                for (const ch of lines[k]) {
                    if (ch === '{') {
                        if (depth === 0) bodyStart = k + 1;
                        depth++;
                    } else if (ch === '}') {
                        depth--;
                        if (depth === 0) {
                            results.push({
                                method: methodName,
                                body: bodyChars.join(''),
                                startLine: bodyStart,
                            });
                            i = k;
                            k = lines.length;
                            break;
                        }
                    } else if (depth >= 1) {
                        bodyChars.push(ch);
                    }
                }
                if (depth >= 1) bodyChars.push('\n');
            }
        }
        return results;
    }
}
