#!/usr/bin/env node
/**
 * cs-playwright-locator-lint - dedicated CLI for the locator stability linter.
 *
 * Usage:
 *   cs-playwright-locator-lint                  # scan default roots (src,test)
 *   cs-playwright-locator-lint test/myproject   # scan a specific root
 *   cs-playwright-locator-lint --min-score=70   # raise the failure threshold
 *   cs-playwright-locator-lint --json           # emit JSON instead of TTY output
 *   cs-playwright-locator-lint --no-fail-on-policy  # don't fail on raw page.locator()
 *
 * Exit codes:
 *   0 — clean (no errors, no policy violations)
 *   1 — one or more findings below threshold or raw page.locator() found
 *
 * The CLI ignores `LOCATOR_LINT_ENABLED`; that switch is for the runner.
 * Direct invocation always runs.
 *
 * @module locator-lint
 */

import { CSLocatorLinter, LintOptions } from './CSLocatorLinter';
import { LocatorLintReport, LocatorFinding } from './CSLocatorTypes';

function parseArgs(argv: string[]): { roots: string[]; opts: LintOptions; json: boolean } {
    const roots: string[] = [];
    const opts: LintOptions = { forceEnabled: true };
    let json = false;

    for (const arg of argv) {
        if (arg.startsWith('--min-score=')) {
            opts.minScore = Number(arg.split('=')[1]);
        } else if (arg === '--no-fail-on-policy') {
            opts.failOnPolicy = false;
        } else if (arg === '--json') {
            json = true;
        } else if (arg === '--help' || arg === '-h') {
            printHelp();
            process.exit(0);
        } else if (!arg.startsWith('-')) {
            roots.push(arg);
        }
    }
    if (roots.length) opts.roots = roots;
    return { roots, opts, json };
}

function printHelp(): void {
    /* eslint-disable no-console */
    console.log([
        'cs-playwright-locator-lint - score every locator in your suite for write-time stability.',
        '',
        'Usage:',
        '  cs-playwright-locator-lint [roots...] [options]',
        '',
        'Options:',
        '  --min-score=N        Fail when any locator scores below N (default 60)',
        '  --no-fail-on-policy  Do not fail when raw page.locator() is detected',
        '  --json               Emit machine-readable JSON instead of TTY output',
        '  -h, --help           Show this help',
        '',
        'Exit codes: 0 clean, 1 below threshold or policy violation.',
    ].join('\n'));
}

function main(): void {
    const { opts, json } = parseArgs(process.argv.slice(2));
    const report = CSLocatorLinter.getInstance().lint(opts);
    if (json) {
        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else {
        printReport(report);
    }
    process.exit(report.failed ? 1 : 0);
}

function printReport(report: LocatorLintReport): void {
    /* eslint-disable no-console */
    console.log('');
    console.log('Locator stability lint');
    console.log('---------------------------------------------------------------');
    console.log(`Scanned files       : ${report.scannedFiles}`);
    console.log(`Locators evaluated  : ${report.locators}`);
    console.log(`Mean stability score: ${report.averageScore}/100  (threshold ${report.minScore})`);
    console.log('');
    console.log(`Tier  stable=${report.tierCounts.stable}  acceptable=${report.tierCounts.acceptable}  ` +
                `fragile=${report.tierCounts.fragile}  anti-pattern=${report.tierCounts['anti-pattern']}`);
    console.log(`Sev   info=${report.severityCounts.info}  warning=${report.severityCounts.warning}  ` +
                `error=${report.severityCounts.error}  policy=${report.severityCounts.policy}`);
    console.log('');

    const blockers = report.findings.filter(f => f.severity === 'error' || f.severity === 'policy');
    const warnings = report.findings.filter(f => f.severity === 'warning');

    if (blockers.length) {
        console.log('Blocking findings:');
        for (const f of blockers) printFinding(f);
        console.log('');
    }
    if (warnings.length) {
        console.log('Warnings:');
        for (const f of warnings) printFinding(f);
        console.log('');
    }
    if (report.failed) {
        console.log('FAIL: at least one locator is below the configured threshold or violates policy.');
    } else {
        console.log('OK: no blocking findings.');
    }
}

function printFinding(f: LocatorFinding): void {
    /* eslint-disable no-console */
    const sev = f.severity.toUpperCase().padEnd(7);
    console.log(`  ${sev}  ${f.file}:${f.line}:${f.column}  [${f.strategy}, ${f.score}/100, ${f.tier}]`);
    console.log(`            value: ${truncate(f.value, 140)}`);
    for (const r of f.reasons.slice(0, 3)) console.log(`            why  : ${r}`);
    for (const s of f.suggestions.slice(0, 2)) console.log(`            fix  : ${s}`);
}

function truncate(s: string, n: number): string {
    if (s.length <= n) return s;
    return s.slice(0, n - 1) + '…';
}

main();
