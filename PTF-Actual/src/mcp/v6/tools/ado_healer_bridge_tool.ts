/**
 * cs_qa_healer_bridge — Bridge from a live test failure (report-data.json +
 * screenshot on disk) to the runtime healer.
 *
 * Given a failure's `reportPath` (report-data.json) and the page-object files
 * in scope, this tool:
 *   1. Reads the failing scenario(s) + selector clues from report-data.json.
 *   2. Calls `cs_qa_detect_drift` (verb: live-selector-drift) scoped to the
 *      relevant page objects.
 *   3. For each drift where a workingAlternative was found, calls
 *      `cs_qa_auto_heal_drift` in DRY-RUN mode to preview the patch.
 *   4. Returns the diff + confidence per drift.
 *   5. If `apply:true`, delegates to `cs_qa_auto_heal_drift` (dryRun:false)
 *      which handles git branch, commit, PR creation via cs_qa_ado_write —
 *      we do NOT reimplement any of that here.
 *
 * Every step goes through the primitive registry — no import loop.
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive, getPrimitive } from '../runtime/Primitive';
import { createLogger } from './_helpers/structured_logger';

interface ReportStep {
    keyword?: string;
    text?: string;
    status?: string;
    error?: string;
    errorMessage?: string;
    selector?: string;
}

interface ReportScenario {
    name?: string;
    status?: string;
    steps?: ReportStep[];
    error?: string;
    stack?: string;
    selector?: string;
    tags?: unknown;
    pageObject?: string;
}

interface ReportData {
    suite?: {
        scenarios?: ReportScenario[];
    };
    [k: string]: unknown;
}

function extractSelectorClues(report: ReportData): { selectors: string[]; scenarioNames: string[]; sampleErrorMessage: string } {
    const selectors = new Set<string>();
    const scenarioNames: string[] = [];
    let sampleErrorMessage = '';
    for (const s of report.suite?.scenarios || []) {
        if ((s.status || '').toLowerCase() === 'passed') continue;
        scenarioNames.push(s.name || '(unnamed)');
        for (const step of s.steps || []) {
            if ((step.status || '').toLowerCase() !== 'failed') continue;
            if (step.selector) selectors.add(step.selector);
            const msg = step.errorMessage || step.error || '';
            if (msg && !sampleErrorMessage) sampleErrorMessage = String(msg).slice(0, 500);
            const patterns: RegExp[] = [
                /waiting for (?:selector|locator)\s+["']([^"']+)["']/i,
                /locator\(["']([^"']+)["']\)/,
                /xpath=([^\s,'"]+)/i,
                /css=([^\s,'"]+)/i,
            ];
            for (const re of patterns) {
                const m = msg.match(re);
                if (m) selectors.add(m[1]);
            }
        }
        if (s.selector) selectors.add(s.selector);
    }
    return { selectors: Array.from(selectors), scenarioNames, sampleErrorMessage };
}

interface Drift {
    pageObject: string;
    propertyName: string;
    primarySelector: string;
    allSelectorsFailed: boolean;
    workingAlternative?: string;
    driftKind: string;
    httpStatus?: number;
    url?: string;
    suggestedFix: string;
    description?: string;
    allTriedSelectors?: string[];
}

registerPrimitive({
    name: 'cs_qa_healer_bridge',
    description: 'Bridge from a live test failure (report-data.json path + optional screenshot path) to the runtime healer. Reads failing scenarios + selector clues; calls cs_qa_detect_drift (live-selector-drift) scoped to pagesRoot; for each drift with a workingAlternative, calls cs_qa_auto_heal_drift in dryRun to preview the patch; returns confidence + diff. If apply:true, delegates a real heal + PR via cs_qa_auto_heal_drift (dryRun:false) — this tool does NOT reimplement git/PR. Example: cs_qa_healer_bridge reportPath:"reports/2026-08-15T10-00/reports/report-data.json" pagesRoot:"test" apply:false.',
    inputSchema: z.object({
        reportPath: z.string().min(1).describe('Absolute or workspace-relative path to a report-data.json produced by the framework runner.'),
        screenshotPath: z.string().optional(),
        pagesRoot: z.string().default('test'),
        baseUrlOverride: z.string().url().optional(),
        timeoutMs: z.number().int().positive().max(60_000).default(15_000),
        apply: z.boolean().default(false).describe('If true, calls cs_qa_auto_heal_drift with dryRun:false to apply the heal + open a PR.'),
        prTitle: z.string().optional(),
        prDescription: z.string().optional(),
        repositoryId: z.string().optional(),
        targetBranchForPr: z.string().optional(),
        orgUrl: z.string().url().optional(),
        project: z.string().min(1).optional(),
        pat: z.string().min(1).optional(),
    }),
    outputSchema: z.object({
        ok: z.boolean(),
        failingScenarios: z.array(z.string()).default([]),
        selectorClues: z.array(z.string()).default([]),
        sampleErrorMessage: z.string().optional(),
        screenshotFound: z.boolean().default(false),
        driftsDetected: z.array(z.object({
            pageObject: z.string(),
            propertyName: z.string(),
            primarySelector: z.string(),
            driftKind: z.string(),
            workingAlternative: z.string().optional(),
            suggestedFix: z.string(),
            allTriedSelectors: z.array(z.string()).default([]),
        })).default([]),
        healSuggestions: z.array(z.object({
            file: z.string(),
            driftsHealed: z.number(),
            healSummary: z.array(z.string()),
            confidence: z.enum(['high', 'medium', 'low']),
        })).default([]),
        unhealed: z.array(z.object({ drift: z.record(z.string(), z.any()), reason: z.string() })).default([]),
        applied: z.boolean().default(false),
        prUrl: z.string().optional(),
        warnings: z.array(z.string()).default([]),
        note: z.string().optional(),
    }),
    run: async (ctx, input) => {
        const log = createLogger(ctx.invocationId, 'cs_qa_healer_bridge', { workspaceRoot: ctx.workspaceRoot });
        const warnings: string[] = [];
        const reportAbs = path.isAbsolute(input.reportPath) ? input.reportPath : path.join(ctx.workspaceRoot, input.reportPath);
        if (!fs.existsSync(reportAbs)) {
            return {
                ok: false,
                failingScenarios: [], selectorClues: [], screenshotFound: false,
                driftsDetected: [], healSuggestions: [], unhealed: [], applied: false,
                warnings: [`report-data.json not found at ${reportAbs}`],
                note: 'Cannot bridge — report file missing.',
            };
        }
        let report: ReportData;
        try { report = JSON.parse(fs.readFileSync(reportAbs, 'utf-8')) as ReportData; }
        catch (e) {
            return {
                ok: false,
                failingScenarios: [], selectorClues: [], screenshotFound: false,
                driftsDetected: [], healSuggestions: [], unhealed: [], applied: false,
                warnings: [`report-data.json parse failed: ${(e as Error).message}`],
                note: 'Cannot bridge — report unparseable.',
            };
        }

        const { selectors, scenarioNames, sampleErrorMessage } = extractSelectorClues(report);
        let screenshotFound = false;
        if (input.screenshotPath) {
            const abs = path.isAbsolute(input.screenshotPath) ? input.screenshotPath : path.join(ctx.workspaceRoot, input.screenshotPath);
            screenshotFound = fs.existsSync(abs);
            if (!screenshotFound) warnings.push(`screenshot not found at ${abs}`);
        }

        // Delegate — call cs_qa_detect_drift (live-selector-drift).
        const detect = getPrimitive('cs_qa_detect_drift');
        if (!detect) {
            return {
                ok: false,
                failingScenarios: scenarioNames, selectorClues: selectors, sampleErrorMessage, screenshotFound,
                driftsDetected: [], healSuggestions: [], unhealed: [], applied: false,
                warnings: ['cs_qa_detect_drift not registered'],
                note: 'Bridge requires cs_qa_detect_drift.',
            };
        }
        const detectInput: Record<string, unknown> = {
            verb: 'live-selector-drift',
            pagesRoot: input.pagesRoot,
            timeoutMs: input.timeoutMs,
            headers: {},
            followRedirects: true,
        };
        if (input.baseUrlOverride) detectInput.baseUrlOverride = input.baseUrlOverride;
        const detectRes = await detect.run(ctx, detectInput as never);
        const detectOut = detectRes as { ok?: boolean; drifts?: Drift[]; warnings?: string[]; note?: string };
        for (const w of detectOut.warnings || []) warnings.push(`detect: ${w}`);
        const drifts = (detectOut.drifts || []) as Drift[];

        // Confidence heuristic: workingAlternative present → high; ambiguous → medium; unresolved → low.
        const healSuggestions: Array<{ file: string; driftsHealed: number; healSummary: string[]; confidence: 'high' | 'medium' | 'low' }> = [];
        const unhealed: Array<{ drift: Record<string, unknown>; reason: string }> = [];
        const heal = getPrimitive('cs_qa_auto_heal_drift');
        if (!heal) {
            warnings.push('cs_qa_auto_heal_drift not registered — heal previews skipped.');
        } else if (drifts.length > 0) {
            const dryRunRes = await heal.run(ctx, {
                driftReport: { liveSelectorDrifts: drifts },
                dryRun: true,
                autoOpenPr: false,
                baseBranch: 'main',
                heals: { sourceSignature: false, acText: false, liveSelector: true },
            } as never);
            const dryOut = dryRunRes as {
                ok?: boolean;
                filesModified?: Array<{ file: string; driftsHealed: number; healSummary: string[] }>;
                unhealedDrifts?: Array<{ drift: unknown; reason: string }>;
                warnings?: string[];
            };
            for (const w of dryOut.warnings || []) warnings.push(`heal-dry: ${w}`);
            for (const f of dryOut.filesModified || []) {
                // Confidence: prefer high when every drift on the file had a workingAlternative.
                const driftsForFile = drifts.filter((d) => d.pageObject && f.file.endsWith(path.basename(d.pageObject)));
                const withAlt = driftsForFile.filter((d) => !!d.workingAlternative).length;
                const conf: 'high' | 'medium' | 'low' = driftsForFile.length > 0 && withAlt === driftsForFile.length
                    ? 'high'
                    : (withAlt > 0 ? 'medium' : 'low');
                healSuggestions.push({ file: f.file, driftsHealed: f.driftsHealed, healSummary: f.healSummary, confidence: conf });
            }
            for (const u of dryOut.unhealedDrifts || []) {
                unhealed.push({ drift: u.drift as Record<string, unknown>, reason: u.reason });
            }
        }

        let applied = false;
        let prUrl: string | undefined;
        if (input.apply && drifts.length > 0 && heal) {
            const applyRes = await heal.run(ctx, {
                driftReport: { liveSelectorDrifts: drifts },
                dryRun: false,
                autoOpenPr: true,
                baseBranch: 'main',
                heals: { sourceSignature: false, acText: false, liveSelector: true },
                prTitle: input.prTitle,
                prDescription: input.prDescription,
                repositoryId: input.repositoryId,
                targetBranchForPr: input.targetBranchForPr,
                orgUrl: input.orgUrl,
                project: input.project,
                pat: input.pat,
            } as never);
            const applyOut = applyRes as { ok?: boolean; prUrl?: string; warnings?: string[] };
            applied = applyOut.ok === true;
            prUrl = applyOut.prUrl;
            for (const w of applyOut.warnings || []) warnings.push(`heal-apply: ${w}`);
        }

        log.info('bridge complete', {
            scenarios: scenarioNames.length, selectors: selectors.length, drifts: drifts.length,
            suggestions: healSuggestions.length, applied,
        });

        return {
            ok: true,
            failingScenarios: scenarioNames,
            selectorClues: selectors,
            sampleErrorMessage: sampleErrorMessage || undefined,
            screenshotFound,
            driftsDetected: drifts.map((d) => ({
                pageObject: d.pageObject,
                propertyName: d.propertyName,
                primarySelector: d.primarySelector,
                driftKind: d.driftKind,
                workingAlternative: d.workingAlternative,
                suggestedFix: d.suggestedFix,
                allTriedSelectors: d.allTriedSelectors || [],
            })),
            healSuggestions,
            unhealed,
            applied,
            prUrl,
            warnings,
            note: `${scenarioNames.length} failing scenario(s), ${selectors.length} selector clue(s), ${drifts.length} live-selector drift(s), ${healSuggestions.length} heal suggestion(s)${applied ? `, applied → PR ${prUrl || '(url unknown)'}` : ''}.`,
        };
    },
});
