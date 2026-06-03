/**
 * CSLocatorLinter - shared types
 *
 * The linter walks TypeScript source under the suite, extracts every
 * locator declaration it understands (today: `@CSGetElement({...})`
 * decorators + raw `page.locator(...)` calls), scores each one for
 * write-time stability, and returns a structured report.
 *
 * Severities are derived from the score plus the configured minimum
 * threshold. A `policy` severity is reserved for findings that aren't
 * about stability at all — e.g. "raw page.locator() is forbidden in
 * this framework, use a CSWebElement wrapper instead".
 *
 * @module locator-lint
 */

/** Strategy keys that mirror `CSElementOptions` from CSPageFactory. */
export type LocatorStrategy =
    | 'id'
    | 'testId'
    | 'name'
    | 'role'
    | 'label'
    | 'placeholder'
    | 'title'
    | 'alt'
    | 'text'
    | 'className'
    | 'css'
    | 'xpath'
    | 'raw'; // raw page.locator(...) — strategy unknown until parsed

export type LocatorSeverity = 'info' | 'warning' | 'error' | 'policy';

/** One scored locator value (the primary, or one of the alternatives). */
export interface LocatorFinding {
    /** Repo-relative POSIX path. */
    file: string;
    /** 1-based line of the locator value. */
    line: number;
    /** 1-based column where the value begins, best-effort. */
    column: number;
    /** Which declaration this came from. */
    source: 'decorator-primary' | 'decorator-alternative' | 'raw-page-locator';
    /** The strategy key, e.g. `xpath`, `testId`. */
    strategy: LocatorStrategy;
    /** Raw selector string as it appears in source. */
    value: string;
    /** Stability score 0..100, higher = more stable. */
    score: number;
    /** Human label for the score band. */
    tier: 'stable' | 'acceptable' | 'fragile' | 'anti-pattern';
    /** Severity once the threshold is applied. */
    severity: LocatorSeverity;
    /** Why the score landed where it did. */
    reasons: string[];
    /** Optional fix hints, ordered most→least impactful. */
    suggestions: string[];
}

/** Top-level report returned by the linter. */
export interface LocatorLintReport {
    /** Files actually scanned. */
    scannedFiles: number;
    /** Total locators found (primary + alternatives + raw). */
    locators: number;
    /** Findings, sorted file→line. */
    findings: LocatorFinding[];
    /** Histogram by tier. */
    tierCounts: Record<LocatorFinding['tier'], number>;
    /** Histogram by severity. */
    severityCounts: Record<LocatorSeverity, number>;
    /** Mean score across all locators (0 if none). */
    averageScore: number;
    /** Configured minimum acceptable score for this run. */
    minScore: number;
    /** True when at least one finding is `error` or `policy`. */
    failed: boolean;
}

/** A single decorator block extracted from source, pre-scoring. */
export interface DecoratorBlock {
    file: string;
    /** 1-based line of the `@CSGetElement` keyword. */
    line: number;
    /** Full literal block between the outermost braces. */
    body: string;
    /** Each `key: 'value'` pair parsed out of the top level. */
    options: Array<{ key: string; value: string; line: number; column: number }>;
    /** Entries of an `alternativeLocators: [ ... ]` array, if present. */
    alternatives: Array<{ value: string; line: number; column: number }>;
}
