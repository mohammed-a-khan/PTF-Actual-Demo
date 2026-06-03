/**
 * CSLocatorLinter - orchestrator.
 *
 * Walks the configured roots, parses every `.ts` it can read, scores
 * each locator, and rolls up a single `LocatorLintReport`. The runner
 * decides what to do with that report — print, fail CI, or persist.
 *
 * Config keys (all opt-in, defaults are conservative):
 *
 *   LOCATOR_LINT_ENABLED       — master switch                       (default false)
 *   LOCATOR_LINT_ROOTS         — comma-separated roots to scan       (default "src,test")
 *   LOCATOR_LINT_INCLUDE       — comma-separated globs (suffix match) (default ".ts")
 *   LOCATOR_LINT_EXCLUDE       — comma-separated path fragments       (default "node_modules,dist,.cs-ai")
 *   LOCATOR_LINT_MIN_SCORE     — fail threshold                       (default 60)
 *   LOCATOR_LINT_FAIL_ON_POLICY — fail on raw page.locator() finds    (default true)
 *
 * Singleton (matches the rest of `src/`).
 *
 * @module locator-lint
 */

import * as fs from 'fs';
import * as path from 'path';
import { CSConfigurationManager } from '../core/CSConfigurationManager';
import {
    LocatorFinding,
    LocatorLintReport,
    LocatorSeverity,
    LocatorStrategy,
} from './CSLocatorTypes';
import { scoreLocator } from './CSLocatorScorer';
import { parseFile } from './CSLocatorParser';

export interface LintOptions {
    roots?: string[];
    minScore?: number;
    failOnPolicy?: boolean;
    /** Override config-driven enablement; useful for direct CLI runs. */
    forceEnabled?: boolean;
}

export class CSLocatorLinter {
    private static instance: CSLocatorLinter;
    private config: CSConfigurationManager;

    private constructor() {
        this.config = CSConfigurationManager.getInstance();
    }

    public static getInstance(): CSLocatorLinter {
        if (!CSLocatorLinter.instance) {
            CSLocatorLinter.instance = new CSLocatorLinter();
        }
        return CSLocatorLinter.instance;
    }

    public isEnabled(): boolean {
        return this.config.getBoolean('LOCATOR_LINT_ENABLED', false);
    }

    public getMinScore(): number {
        return this.config.getNumber('LOCATOR_LINT_MIN_SCORE', 60);
    }

    public getFailOnPolicy(): boolean {
        return this.config.getBoolean('LOCATOR_LINT_FAIL_ON_POLICY', true);
    }

    public getRoots(): string[] {
        const raw = this.config.get('LOCATOR_LINT_ROOTS', 'src,test');
        return raw.split(',').map((s: string) => s.trim()).filter(Boolean);
    }

    public getInclude(): string[] {
        const raw = this.config.get('LOCATOR_LINT_INCLUDE', '.ts');
        return raw.split(',').map((s: string) => s.trim()).filter(Boolean);
    }

    public getExclude(): string[] {
        const raw = this.config.get('LOCATOR_LINT_EXCLUDE', 'node_modules,dist,.cs-ai');
        return raw.split(',').map((s: string) => s.trim()).filter(Boolean);
    }

    // ------------------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------------------

    /**
     * Run the linter against a set of roots. When called from the runner this
     * is gated by `LOCATOR_LINT_ENABLED`; when called from the dedicated CLI
     * the caller passes `forceEnabled: true` so the lint runs regardless.
     */
    public lint(options: LintOptions = {}): LocatorLintReport {
        const enabled = options.forceEnabled ?? this.isEnabled();
        if (!enabled) {
            return emptyReport(this.getMinScore());
        }
        const repoRoot = process.cwd();
        const roots = options.roots ?? this.getRoots();
        const minScore = options.minScore ?? this.getMinScore();
        const failOnPolicy = options.failOnPolicy ?? this.getFailOnPolicy();
        const include = this.getInclude();
        const exclude = this.getExclude();

        const files: string[] = [];
        for (const root of roots) {
            const abs = path.resolve(repoRoot, root);
            if (!fs.existsSync(abs)) continue;
            const stat = fs.statSync(abs);
            if (stat.isFile()) {
                // Single-file invocation — include it directly so users can
                // run the linter on one page object during development.
                files.push(abs);
            } else if (stat.isDirectory()) {
                walk(abs, include, exclude, files);
            }
        }

        const findings: LocatorFinding[] = [];
        for (const file of files) {
            try {
                const parsed = parseFile(file, repoRoot);
                for (const dec of parsed.decorators) {
                    for (const opt of dec.options) {
                        findings.push(buildFinding({
                            file: parsed.file,
                            line: opt.line,
                            column: opt.column,
                            source: 'decorator-primary',
                            strategy: opt.key as LocatorStrategy,
                            value: opt.value,
                            minScore,
                        }));
                    }
                    for (const alt of dec.alternatives) {
                        const strategy = guessStrategy(alt.value);
                        findings.push(buildFinding({
                            file: parsed.file,
                            line: alt.line,
                            column: alt.column,
                            source: 'decorator-alternative',
                            strategy,
                            value: alt.value,
                            minScore,
                        }));
                    }
                }
                for (const raw of parsed.rawCalls) {
                    findings.push(buildFinding({
                        file: parsed.file,
                        line: raw.line,
                        column: raw.column,
                        source: 'raw-page-locator',
                        strategy: 'raw',
                        value: raw.value,
                        minScore,
                        policy: failOnPolicy,
                    }));
                }
            } catch (e) {
                // A single unreadable file should not blow the whole lint.
                // We surface it as info and keep going.
                findings.push({
                    file: path.relative(repoRoot, file).split(path.sep).join('/'),
                    line: 1, column: 1,
                    source: 'decorator-primary',
                    strategy: 'raw',
                    value: '',
                    score: 0,
                    tier: 'anti-pattern',
                    severity: 'info',
                    reasons: [`parse failed: ${(e as Error).message}`],
                    suggestions: [],
                });
            }
        }

        findings.sort((a, b) =>
            a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file));

        return summarise(findings, files.length, minScore);
    }
}

// ============================================================================
// Helpers
// ============================================================================

function buildFinding(args: {
    file: string;
    line: number;
    column: number;
    source: LocatorFinding['source'];
    strategy: LocatorStrategy;
    value: string;
    minScore: number;
    policy?: boolean;
}): LocatorFinding {
    const scored = scoreLocator(args.strategy, args.value);
    let severity: LocatorSeverity;
    if (args.policy && args.source === 'raw-page-locator') {
        severity = 'policy';
    } else if (scored.score < args.minScore) {
        severity = scored.tier === 'anti-pattern' ? 'error' : 'warning';
    } else if (scored.tier === 'acceptable') {
        severity = 'info';
    } else {
        severity = 'info';
    }
    return {
        file: args.file,
        line: args.line,
        column: args.column,
        source: args.source,
        strategy: args.strategy,
        value: args.value,
        score: scored.score,
        tier: scored.tier,
        severity,
        reasons: scored.reasons,
        suggestions: scored.suggestions,
    };
}

function guessStrategy(value: string): LocatorStrategy {
    // Playwright-style prefixed locators: `xpath:`, `xpath=`, `text:`, `text=`,
    // `role:`, `role=`, `css:`, `css=`. The framework's alternativeLocators[]
    // commonly uses these.
    const stripped = value.replace(/^xpath[:=]|^css[:=]|^text[:=]|^role[:=]/i, '');
    if (/^xpath[:=]/i.test(value) || stripped.startsWith('//') || stripped.startsWith('(/')) return 'xpath';
    if (/^text[:=]/i.test(value)) return 'text';
    if (/^role[:=]/i.test(value)) return 'role';
    if (value.startsWith('[data-testid') || /^data-testid[:=]/i.test(value)) return 'testId';
    if (stripped.startsWith('/') && !stripped.startsWith('//')) return 'xpath'; // absolute xpath
    return 'css';
}

function walk(dir: string, include: string[], exclude: string[], out: string[]): void {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (exclude.some(ex => full.includes(`${path.sep}${ex}${path.sep}`) || full.endsWith(`${path.sep}${ex}`))) {
            continue;
        }
        if (e.isDirectory()) {
            walk(full, include, exclude, out);
        } else if (e.isFile()) {
            if (include.some(suffix => e.name.endsWith(suffix))) {
                // Cheap content guard: skip files whose body doesn't mention
                // any locator construct. Saves the parser doing real work on
                // 90% of the suite.
                try {
                    // Read a small head — far cheaper than tokenising every file.
                    const head = fs.readFileSync(full, 'utf-8');
                    if (head.includes('@CSGetElement') || head.includes('@CSElement') ||
                        head.includes('.locator(')) {
                        out.push(full);
                    }
                } catch { /* unreadable — skip silently */ }
            }
        }
    }
}

function summarise(findings: LocatorFinding[], scanned: number, minScore: number): LocatorLintReport {
    const tierCounts: LocatorLintReport['tierCounts'] = {
        stable: 0, acceptable: 0, fragile: 0, 'anti-pattern': 0,
    };
    const severityCounts: LocatorLintReport['severityCounts'] = {
        info: 0, warning: 0, error: 0, policy: 0,
    };
    let total = 0;
    for (const f of findings) {
        tierCounts[f.tier]++;
        severityCounts[f.severity]++;
        total += f.score;
    }
    const failed = severityCounts.error > 0 || severityCounts.policy > 0;
    const averageScore = findings.length === 0 ? 0 : Math.round(total / findings.length);
    return {
        scannedFiles: scanned,
        locators: findings.length,
        findings,
        tierCounts,
        severityCounts,
        averageScore,
        minScore,
        failed,
    };
}

function emptyReport(minScore: number): LocatorLintReport {
    return {
        scannedFiles: 0,
        locators: 0,
        findings: [],
        tierCounts: { stable: 0, acceptable: 0, fragile: 0, 'anti-pattern': 0 },
        severityCounts: { info: 0, warning: 0, error: 0, policy: 0 },
        averageScore: 0,
        minScore,
        failed: false,
    };
}
