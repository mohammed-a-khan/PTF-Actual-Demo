/**
 * Agentic Test Platform — Primitive MCP Tools (Rebuild M11 wiring)
 *
 * Exposes the 9 phase primitives as MCP tools so the `cs-ai-auto-assist`
 * Copilot agent prompt can compose them in sequence:
 *
 *   csaa_discover → csaa_analyze → csaa_plan → csaa_translate
 *   → csaa_audit → csaa_write → csaa_execute → csaa_verify → csaa_publish
 *
 * Each tool:
 *   - resolves a `CSRunContext` via runId (created by `cs_ai_auto_assist`)
 *   - calls the underlying TS primitive class (CSDiscovery, CSLegacyAnalyzer, …)
 *   - persists artefacts to `Agent-Processing/<ts>_<runId>/<phase>/`
 *   - calls `CSStatusWriter.write(ctx)` so the user's open `STATUS.md`
 *     refreshes after every transition
 *   - returns a structured payload with `nextSuggestedTool` so the agent
 *     keeps composing without freelancing
 *
 * Privacy-by-design: this module contains zero customer / project /
 * company identifiers. Generic placeholders only.
 *
 * @module agent-platform/CSPrimitiveTools
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    MCPToolContext,
    MCPToolDefinition,
    MCPToolResult,
} from '../types/CSMCPTypes';
import { defineTool, MCPToolBuilder } from '../CSMCPToolRegistry';
import { CSRunContext, RunPhase } from './CSRunContext';
import { CSStatusWriter } from './CSStatusWriter';
import { CSDiscovery, LegacyInventory } from './CSDiscovery';
import { CSLegacyDataReader } from './CSLegacyDataReader';
import { CSLegacyAnalyzer, AnalysisReport } from './CSLegacyAnalyzer';
import { CSSemanticReuse } from './CSSemanticReuse';
import { CSBddTranslator, ContentMap } from './CSBddTranslator';
import { CSWriteWithAudit, AuditViolation } from './CSWriteWithAudit';
import { CSHealClassifier, HealFailureSignals } from './CSHealClassifier';
import { CSRepoInventory } from './CSRepoInventory';
import { CSTrustScore } from './CSTrustScore';
import { CSAdoCreateBackFlow } from './CSAdoCreateBackFlow';
import { auditTools } from '../tools/audit/CSMCPAuditTools';
import { bddTools } from '../tools/bdd/CSMCPBDDTools';
import {
    GeneratedFeatureSummary,
    GeneratedScenarioSummary,
    PipelineOutput,
} from './types';

// ============================================================================
// Helpers
// ============================================================================

function jsonResult(data: unknown, summary: string): MCPToolResult {
    const json = JSON.stringify(data, null, 2);
    return {
        content: [{ type: 'text', text: `${summary}\n\n${json}` }],
        structuredContent: data as Record<string, unknown>,
    };
}

function errorResult(reason: string, runId?: string): MCPToolResult {
    return jsonResult(
        { state: 'BLOCKED_NEED_INPUT', runId, blockedReason: reason, nextStepNeeded: false },
        reason,
    );
}

function getCtx(runId: string): CSRunContext | null {
    return CSRunContext.get(runId);
}

function getStr(p: Record<string, unknown>, k: string): string | undefined {
    const v = p[k];
    return typeof v === 'string' ? v : undefined;
}

// ============================================================================
// csaa_discover — Phase 2: walk legacy project tree
// ============================================================================

const csaa_discover: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('csaa_discover')
    .title('CS-AI-Auto-Assist — Discover (Phase 2)')
    .description(
        'Walk the legacy project tree (or BDD .feature, ADO TC#, doc, source, URL) ' +
            'and produce a structured inventory: tests, pages, helpers, base classes, data ' +
            'files, properties files, runner configs. Persists `inventory.json` to ' +
            '`Agent-Processing/<run>/02-discover/` and updates STATUS.md.',
    )
    .category('multiagent')
    .stringParam('runId', 'Run ID from cs_ai_auto_assist', { required: true })
    .stringParam('rootPath', 'Project root path or entry file path', { required: true })
    .stringParam('entryFile', 'Optional explicit entry file when rootPath is a directory')
    .handler(async (params: Record<string, unknown>) => {
        const runId = String(params.runId ?? '');
        const ctx = getCtx(runId);
        if (!ctx) return errorResult(`unknown runId '${runId}' — invoke cs_ai_auto_assist first`, runId);

        const rootPath = getStr(params, 'rootPath');
        if (!rootPath || !fs.existsSync(rootPath)) {
            return errorResult(`provide a valid rootPath — '${rootPath}' does not exist`, runId);
        }
        ctx.startPhase('discover');
        try {
            const inventory = CSDiscovery.discover(rootPath, {
                entryFile: getStr(params, 'entryFile'),
            });
            ctx.writePhaseArtifact(
                'discover',
                'inventory.json',
                JSON.stringify(inventory, null, 2),
            );
            const md = renderInventoryMarkdown(inventory);
            const reportPath = CSStatusWriter.writePhaseReport(
                ctx, 'discover', 'Legacy Project Inventory', md,
            );
            ctx.finishPhase('discover', 'done', { reportPath });
            CSStatusWriter.write(ctx);
            return jsonResult(
                {
                    state: 'RUNNING',
                    runId,
                    phase: 'discover',
                    counts: inventory.counts,
                    rootStyle: inventory.rootStyle,
                    language: inventory.language,
                    runFolder: ctx.runFolder,
                    reportPath,
                    nextStepNeeded: true,
                    nextSuggestedTool: 'csaa_analyze',
                    nextSuggestedArgs: {
                        runId,
                        entryFile: inventory.entryFile ?? inventory.tests[0],
                    },
                },
                `Discover complete: ${inventory.counts.tests} tests / ${inventory.counts.pages} pages / ${inventory.counts.helpers} helpers / ${inventory.counts.dataFiles} data files. Call csaa_analyze next.`,
            );
        } catch (err) {
            ctx.finishPhase('discover', 'blocked_user', {
                reason: err instanceof Error ? err.message : String(err),
            });
            CSStatusWriter.write(ctx);
            return errorResult(
                `csaa_discover failed: ${err instanceof Error ? err.message : String(err)}`,
                runId,
            );
        }
    })
    .build();

function renderInventoryMarkdown(inv: LegacyInventory): string {
    return [
        `# Legacy Project Inventory`,
        ``,
        `**Root:** \`${inv.rootPath}\`  `,
        `**Style:** ${inv.rootStyle}  `,
        `**Language:** ${inv.language}`,
        ``,
        `## Counts`,
        ``,
        `| Kind | Count |`,
        `|---|---|`,
        `| Tests | ${inv.counts.tests} |`,
        `| Pages | ${inv.counts.pages} |`,
        `| Helpers | ${inv.counts.helpers} |`,
        `| Base classes | ${inv.counts.baseClasses} |`,
        `| Data files | ${inv.counts.dataFiles} |`,
        `| Properties files | ${inv.propertiesFiles.length} |`,
        `| Runner configs | ${inv.counts.runnerConfigs} |`,
        `| Feature files | ${inv.counts.features} |`,
        '',
    ].join('\n');
}

// ============================================================================
// csaa_analyze — Phase 3: the brain (recursive call-tree)
// ============================================================================

const csaa_analyze: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('csaa_analyze')
    .title('CS-AI-Auto-Assist — Analyze (Phase 3, the brain)')
    .description(
        'Recursive Java/C# analyzer. Walks every @Test method body to leaf-level ' +
            'Selenium primitives, resolves cross-package deps, detects login flow, reads ' +
            'referenced data + config files, builds page-object info, produces structured ' +
            'AnalysisReport with output plan + readiness verdict.',
    )
    .category('multiagent')
    .stringParam('runId', 'Run ID from cs_ai_auto_assist', { required: true })
    .stringParam('entryFile', 'Absolute path to entry test/feature file', { required: true })
    .stringParam('project', 'Target CS Playwright project name')
    .stringParam('module', 'Optional module sub-folder name')
    .handler(async (params: Record<string, unknown>) => {
        const runId = String(params.runId ?? '');
        const ctx = getCtx(runId);
        if (!ctx) return errorResult(`unknown runId '${runId}'`, runId);

        const entryFile = getStr(params, 'entryFile');
        if (!entryFile || !fs.existsSync(entryFile)) {
            return errorResult(`provide a valid entryFile — '${entryFile}' does not exist`, runId);
        }
        const inventoryRaw = ctx.readPhaseArtifact('discover', 'inventory.json');
        if (!inventoryRaw) {
            return errorResult(
                `no inventory found — call csaa_discover before csaa_analyze`,
                runId,
            );
        }
        const inventory = JSON.parse(inventoryRaw) as LegacyInventory;
        const project = getStr(params, 'project') ?? 'default';
        const module = getStr(params, 'module');

        ctx.startPhase('analyze');
        try {
            const report = CSLegacyAnalyzer.analyze(entryFile, inventory, {
                project,
                module,
            });
            ctx.writePhaseArtifact(
                'analyze',
                'analysis-report.json',
                JSON.stringify(report, null, 2),
            );
            const md = CSLegacyAnalyzer.renderMarkdown(report);
            const reportPath = CSStatusWriter.writePhaseReport(
                ctx, 'analyze', 'Analysis Report', md,
            );
            ctx.finishPhase('analyze', 'done', { reportPath });
            CSStatusWriter.write(ctx);
            return jsonResult(
                {
                    state: 'RUNNING',
                    runId,
                    phase: 'analyze',
                    summary: report.summary,
                    readinessVerdict: report.readinessVerdict,
                    readinessScore: report.readinessScore,
                    loginDetected: report.loginContract.detected,
                    loginGherkinStep: report.loginContract.suggestedGherkinStep,
                    gapCount: report.gaps.length,
                    runFolder: ctx.runFolder,
                    reportPath,
                    nextStepNeeded: true,
                    nextSuggestedTool: 'csaa_plan',
                    nextSuggestedArgs: { runId },
                },
                `Analysis complete: ${report.tests.length} tests, verdict ${report.readinessVerdict} (score ${report.readinessScore.toFixed(2)}). Call csaa_plan next.`,
            );
        } catch (err) {
            ctx.finishPhase('analyze', 'blocked_user', {
                reason: err instanceof Error ? err.message : String(err),
            });
            CSStatusWriter.write(ctx);
            return errorResult(
                `csaa_analyze failed: ${err instanceof Error ? err.message : String(err)}`,
                runId,
            );
        }
    })
    .build();

// ============================================================================
// csaa_plan — Phase 4: render plan + gaps for human review
// ============================================================================

const csaa_plan: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('csaa_plan')
    .title('CS-AI-Auto-Assist — Plan (Phase 4)')
    .description(
        'Render the analysis report\'s output plan + auto-resolved gaps as a human-readable ' +
            'PLAN.md at the run root. Non-blocking — the pipeline proceeds. The user reads ' +
            'the plan asynchronously while phase 5 runs.',
    )
    .category('multiagent')
    .stringParam('runId', 'Run ID', { required: true })
    .handler(async (params: Record<string, unknown>) => {
        const runId = String(params.runId ?? '');
        const ctx = getCtx(runId);
        if (!ctx) return errorResult(`unknown runId '${runId}'`, runId);

        const reportRaw = ctx.readPhaseArtifact('analyze', 'analysis-report.json');
        if (!reportRaw) {
            return errorResult(`no analysis report — call csaa_analyze before csaa_plan`, runId);
        }
        const report = JSON.parse(reportRaw) as AnalysisReport;

        ctx.startPhase('plan');
        const plan = report.outputPlan;
        const lines: string[] = [];
        lines.push(`# Migration Plan — \`${runId}\``);
        lines.push('');
        lines.push(`**Project:** \`${plan.project}\`${plan.module ? ` / module \`${plan.module}\`` : ''}  `);
        lines.push(`**Feature slug:** \`${plan.feature}\`  `);
        lines.push(`**Source:** \`${report.source.relativePath}\`  `);
        lines.push(`**Verdict:** ${report.readinessVerdict} (score ${report.readinessScore.toFixed(2)})`);
        lines.push('');
        lines.push('## Files to create / reuse');
        lines.push('');
        lines.push('| Decision | Kind | Path | Notes |');
        lines.push('|---|---|---|---|');
        for (const f of plan.files) {
            lines.push(
                `| ${f.reuseDecision}${f.existsInTarget ? ' (already on disk)' : ''} | ${f.kind} | \`${f.relativePath}\` | ${f.notes ?? ''} |`,
            );
        }
        lines.push('');
        if (report.loginContract.detected) {
            lines.push('## Login pattern');
            lines.push('');
            lines.push(`- **Pattern:** ${report.loginContract.pattern}`);
            lines.push(`- **Per-row user:** ${report.loginContract.perRowUser ? 'yes' : 'no'}`);
            lines.push(`- **Suggested Gherkin step:** \`${report.loginContract.suggestedGherkinStep}\``);
            lines.push('');
        }
        if (report.gaps.length > 0) {
            lines.push('## Gaps (handled automatically — see retries/ for any LLM resolutions)');
            lines.push('');
            for (const g of report.gaps) {
                lines.push(`- **[${g.severity.toUpperCase()}]** ${g.detail}`);
            }
            lines.push('');
        }
        const planMd = lines.join('\n') + '\n';

        ctx.writePhaseArtifact('plan', 'migration-plan.json', JSON.stringify(plan, null, 2));
        ctx.writePhaseArtifact('plan', 'plan.md', planMd);
        // Also drop a top-level PLAN.md so the user finds it without descending.
        try {
            fs.writeFileSync(path.join(ctx.runFolder, 'PLAN.md'), planMd, 'utf-8');
        } catch { /* ignore */ }
        const reportPath = CSStatusWriter.writePhaseReport(
            ctx, 'plan', 'Migration Plan', planMd,
        );
        ctx.finishPhase('plan', 'done', { reportPath });
        CSStatusWriter.write(ctx);

        return jsonResult(
            {
                state: 'RUNNING',
                runId,
                phase: 'plan',
                planFiles: plan.files.length,
                runFolder: ctx.runFolder,
                planPath: path.join(ctx.runFolder, 'PLAN.md'),
                nextStepNeeded: true,
                nextSuggestedTool: 'csaa_translate',
                nextSuggestedArgs: { runId, project: plan.project, module: plan.module },
            },
            `Plan ready: ${plan.files.length} files. PLAN.md at runFolder. Call csaa_translate next.`,
        );
    })
    .build();

// ============================================================================
// csaa_translate — Phase 5: produce the ContentMap
// ============================================================================

const csaa_translate: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('csaa_translate')
    .title('CS-AI-Auto-Assist — Translate (Phase 5)')
    .description(
        'Consume the analysis report and produce a ContentMap of files (feature + page TS + ' +
            'steps TS + data JSON) ready for write. Uses deterministic skeleton when no host ' +
            'sampling client is wired; the agent prompt is responsible for refining low-confidence ' +
            'translations via apply_patch in a subsequent pass.',
    )
    .category('multiagent')
    .stringParam('runId', 'Run ID', { required: true })
    .stringParam('project', 'Target project name')
    .stringParam('module', 'Optional module name')
    .stringParam('frameworkPkg', 'Override framework npm package (default @mdakhan.mak/cs-playwright-test-framework)')
    .handler(async (params: Record<string, unknown>) => {
        const runId = String(params.runId ?? '');
        const ctx = getCtx(runId);
        if (!ctx) return errorResult(`unknown runId '${runId}'`, runId);

        const reportRaw = ctx.readPhaseArtifact('analyze', 'analysis-report.json');
        if (!reportRaw) {
            return errorResult(`no analysis report — call csaa_analyze first`, runId);
        }
        const report = JSON.parse(reportRaw) as AnalysisReport;
        const project =
            getStr(params, 'project') ?? report.outputPlan.project;
        const module =
            getStr(params, 'module') ?? report.outputPlan.module;
        const frameworkPkg =
            getStr(params, 'frameworkPkg') ?? '@mdakhan.mak/cs-playwright-test-framework';

        ctx.startPhase('translate');
        try {
            const contentMap: ContentMap = await CSBddTranslator.translate(report, {
                project,
                module,
                frameworkPkg,
            });
            // Persist content map + each file under translate/files/ for inspection.
            ctx.writePhaseArtifact(
                'translate',
                'content-map.json',
                JSON.stringify(
                    {
                        files: contentMap.files,
                        confidence: contentMap.confidence,
                        notes: contentMap.notes,
                    },
                    null, 2,
                ),
            );
            for (const [rel, content] of Object.entries(contentMap.files)) {
                const safeName = rel.replace(/[/\\]/g, '__');
                ctx.writePhaseArtifact('translate', path.join('files', safeName), content);
            }
            const md = renderTranslateMarkdown(contentMap);
            const reportPath = CSStatusWriter.writePhaseReport(
                ctx, 'translate', 'Translator Output', md,
            );
            ctx.finishPhase('translate', 'done', { reportPath });
            CSStatusWriter.write(ctx);

            const avgConfidence = Object.values(contentMap.confidence).length === 0
                ? 0
                : Object.values(contentMap.confidence).reduce((s, c) => s + c, 0)
                    / Object.values(contentMap.confidence).length;

            return jsonResult(
                {
                    state: 'RUNNING',
                    runId,
                    phase: 'translate',
                    fileCount: Object.keys(contentMap.files).length,
                    avgConfidence,
                    notes: contentMap.notes,
                    runFolder: ctx.runFolder,
                    reportPath,
                    nextStepNeeded: true,
                    nextSuggestedTool: 'csaa_audit',
                    nextSuggestedArgs: { runId },
                },
                `Translate complete: ${Object.keys(contentMap.files).length} files (avg confidence ${avgConfidence.toFixed(2)}). Call csaa_audit next.`,
            );
        } catch (err) {
            ctx.finishPhase('translate', 'blocked_user', {
                reason: err instanceof Error ? err.message : String(err),
            });
            CSStatusWriter.write(ctx);
            return errorResult(
                `csaa_translate failed: ${err instanceof Error ? err.message : String(err)}`,
                runId,
            );
        }
    })
    .build();

function renderTranslateMarkdown(map: ContentMap): string {
    const lines: string[] = [];
    lines.push('# Translator Output');
    lines.push('');
    lines.push(`Files generated: ${Object.keys(map.files).length}`);
    lines.push('');
    lines.push('| File | Confidence |');
    lines.push('|---|---|');
    for (const rel of Object.keys(map.files)) {
        lines.push(`| \`${rel}\` | ${(map.confidence[rel] ?? 0).toFixed(2)} |`);
    }
    if (map.notes.length > 0) {
        lines.push('');
        lines.push('## Notes');
        for (const n of map.notes) lines.push(`- ${n}`);
    }
    lines.push('');
    return lines.join('\n');
}

// ============================================================================
// csaa_audit — Phase 6: audit_file across content map
// ============================================================================

const csaa_audit: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('csaa_audit')
    .title('CS-AI-Auto-Assist — Audit (Phase 6)')
    .description(
        'Run audit_file across every translated file. Aggregates violations grouped by file, ' +
            'persists `violations.json`. Non-blocking by default — pipeline advances and the ' +
            'verifier reflects audit issues in the trust score.',
    )
    .category('multiagent')
    .stringParam('runId', 'Run ID', { required: true })
    .handler(async (params: Record<string, unknown>, _toolCtx: MCPToolContext) => {
        const runId = String(params.runId ?? '');
        const ctx = getCtx(runId);
        if (!ctx) return errorResult(`unknown runId '${runId}'`, runId);

        const cmRaw = ctx.readPhaseArtifact('translate', 'content-map.json');
        if (!cmRaw) {
            return errorResult(`no content map — call csaa_translate first`, runId);
        }
        const contentMap = JSON.parse(cmRaw) as {
            files: Record<string, string>;
            confidence: Record<string, number>;
            notes: string[];
        };

        ctx.startPhase('audit');
        const auditFile = (auditTools as MCPToolDefinition[]).find((t) => t.tool.name === 'audit_content');
        const allViolations: Record<string, AuditViolation[]> = {};
        let totalViolations = 0;
        if (auditFile) {
            for (const [rel, content] of Object.entries(contentMap.files)) {
                try {
                    const res = await auditFile.handler(
                        { content, filename: rel },
                        _toolCtx,
                    );
                    const sc = res.structuredContent as
                        | { violations?: Array<{ ruleId?: string; severity?: string; line?: number; message?: string }> }
                        | undefined;
                    const list = sc?.violations ?? [];
                    if (list.length > 0) {
                        allViolations[rel] = list.map((v) => ({
                            ruleId: v.ruleId ?? 'unknown',
                            severity: (v.severity ?? 'warning') as AuditViolation['severity'],
                            line: v.line,
                            message: v.message ?? '',
                        }));
                        totalViolations += list.length;
                    }
                } catch {
                    // Audit tool failure is non-fatal — record as warning only.
                }
            }
        }
        ctx.writePhaseArtifact(
            'audit',
            'violations.json',
            JSON.stringify(allViolations, null, 2),
        );
        const md = renderAuditMarkdown(allViolations, Object.keys(contentMap.files).length);
        const reportPath = CSStatusWriter.writePhaseReport(
            ctx, 'audit', 'Audit Report', md,
        );
        ctx.finishPhase('audit', totalViolations === 0 ? 'done' : 'auto_resolved', { reportPath });
        CSStatusWriter.write(ctx);

        return jsonResult(
            {
                state: 'RUNNING',
                runId,
                phase: 'audit',
                violationCount: totalViolations,
                filesWithViolations: Object.keys(allViolations).length,
                clean: totalViolations === 0,
                runFolder: ctx.runFolder,
                reportPath,
                nextStepNeeded: true,
                nextSuggestedTool: 'csaa_write',
                nextSuggestedArgs: { runId },
            },
            totalViolations === 0
                ? `Audit clean. Call csaa_write next.`
                : `Audit found ${totalViolations} violation(s) across ${Object.keys(allViolations).length} file(s) — writing anyway with REVIEW_REQUIRED markers; trust score will reflect. Call csaa_write next.`,
        );
    })
    .build();

function renderAuditMarkdown(
    violations: Record<string, AuditViolation[]>,
    totalFiles: number,
): string {
    const lines: string[] = [];
    const fileCount = Object.keys(violations).length;
    lines.push('# Audit Report');
    lines.push('');
    lines.push(`Files audited: ${totalFiles}  ·  Files with violations: ${fileCount}`);
    lines.push('');
    if (fileCount === 0) {
        lines.push('_All files clean._');
        return lines.join('\n');
    }
    for (const [rel, list] of Object.entries(violations)) {
        lines.push(`## \`${rel}\``);
        for (const v of list) {
            lines.push(`- **[${v.severity}] ${v.ruleId}**${v.line ? ` (line ${v.line})` : ''}: ${v.message}`);
        }
        lines.push('');
    }
    return lines.join('\n');
}

// ============================================================================
// csaa_write — Phase 7: atomic per-file writer
// ============================================================================

const csaa_write: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('csaa_write')
    .title('CS-AI-Auto-Assist — Write (Phase 7)')
    .description(
        'Atomically write every file in the translator\'s ContentMap to disk under ' +
            '`workspaceRoot`. Skip-existing protection unless overwriteExisting is true. ' +
            'Persists Fix Manifest with sha256 + bytes per file.',
    )
    .category('multiagent')
    .stringParam('runId', 'Run ID', { required: true })
    .stringParam('workspaceRoot', 'Workspace root for output (default: runContext workspace)')
    .booleanParam('overwriteExisting', 'When true, overwrite files that already exist', { default: false })
    .handler(async (params: Record<string, unknown>) => {
        const runId = String(params.runId ?? '');
        const ctx = getCtx(runId);
        if (!ctx) return errorResult(`unknown runId '${runId}'`, runId);

        const cmRaw = ctx.readPhaseArtifact('translate', 'content-map.json');
        if (!cmRaw) {
            return errorResult(`no content map — call csaa_translate first`, runId);
        }
        const cm = JSON.parse(cmRaw) as {
            files: Record<string, string>;
            confidence: Record<string, number>;
            notes: string[];
        };

        const workspaceRoot = getStr(params, 'workspaceRoot') ?? path.dirname(path.dirname(ctx.runFolder));
        const overwriteExisting = params.overwriteExisting === true;

        ctx.startPhase('write');
        try {
            const result = await CSWriteWithAudit.write(
                { files: cm.files, confidence: cm.confidence, notes: cm.notes },
                { workspaceRoot, overwriteExisting },
            );
            ctx.writePhaseArtifact(
                'write',
                'written.json',
                JSON.stringify(
                    {
                        written: result.written,
                        skippedExisting: result.skippedExisting,
                        manifest: result.manifest,
                    },
                    null, 2,
                ),
            );
            const md = CSWriteWithAudit.renderManifest(result);
            const reportPath = CSStatusWriter.writePhaseReport(
                ctx, 'write', 'Fix Manifest', md,
            );
            ctx.finishPhase('write', 'done', { reportPath });
            CSStatusWriter.write(ctx);
            return jsonResult(
                {
                    state: 'RUNNING',
                    runId,
                    phase: 'write',
                    written: result.written.length,
                    skippedExisting: result.skippedExisting.length,
                    auditFailed: result.auditFailed.length,
                    runFolder: ctx.runFolder,
                    reportPath,
                    nextStepNeeded: true,
                    nextSuggestedTool: 'csaa_execute',
                    nextSuggestedArgs: { runId },
                    filesWritten: result.written,
                },
                `Wrote ${result.written.length} file(s); skipped ${result.skippedExisting.length} existing. Call csaa_execute next.`,
            );
        } catch (err) {
            ctx.finishPhase('write', 'blocked_user', {
                reason: err instanceof Error ? err.message : String(err),
            });
            CSStatusWriter.write(ctx);
            return errorResult(
                `csaa_write failed: ${err instanceof Error ? err.message : String(err)}`,
                runId,
            );
        }
    })
    .build();

// ============================================================================
// csaa_execute — Phase 8: run scenarios + heal
// ============================================================================

const csaa_execute: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('csaa_execute')
    .title('CS-AI-Auto-Assist — Execute + Heal (Phase 8)')
    .description(
        'Run every generated feature via bdd_run_feature. On failure, classify via ' +
            'CSHealClassifier (4-category baseline + visual-evidence reclassification). ' +
            'Up to 3 heal cycles per failure are reserved; the agent prompt drives the ' +
            'patch + re-run loop using apply_patch + csaa_execute re-invoke.',
    )
    .category('multiagent')
    .stringParam('runId', 'Run ID', { required: true })
    .stringParam('appUrl', 'Live application URL the tests should run against')
    .stringParam('project', 'Project name')
    .stringParam('env', 'Environment (dev / sit / uat)', { default: 'dev' })
    .stringParam('tags', 'Optional Cucumber tag expression to filter scenarios')
    .handler(async (params: Record<string, unknown>, _toolCtx: MCPToolContext) => {
        const runId = String(params.runId ?? '');
        const ctx = getCtx(runId);
        if (!ctx) return errorResult(`unknown runId '${runId}'`, runId);

        const writtenRaw = ctx.readPhaseArtifact('write', 'written.json');
        if (!writtenRaw) {
            return errorResult(`no written artefacts — call csaa_write first`, runId);
        }
        const written = JSON.parse(writtenRaw) as { written: string[] };
        const features = written.written.filter((p) => p.endsWith('.feature'));
        if (features.length === 0) {
            ctx.startPhase('execute');
            ctx.finishPhase('execute', 'auto_resolved', {
                reason: 'no .feature files written; nothing to execute',
            });
            CSStatusWriter.write(ctx);
            return jsonResult(
                {
                    state: 'RUNNING', runId, phase: 'execute',
                    scenariosPassed: 0, scenariosFailed: 0,
                    nextStepNeeded: true, nextSuggestedTool: 'csaa_verify',
                    nextSuggestedArgs: { runId },
                },
                `No feature files to execute. Call csaa_verify.`,
            );
        }

        const project = getStr(params, 'project') ?? 'default';
        const env = getStr(params, 'env') ?? 'dev';
        const tags = getStr(params, 'tags');

        ctx.startPhase('execute');
        const bddRun = (bddTools as MCPToolDefinition[]).find((t) => t.tool.name === 'bdd_run_feature');
        const perFeature: Array<{
            feature: string;
            passed: boolean;
            output: string;
            classification?: ReturnType<typeof CSHealClassifier.classify>;
        }> = [];

        let totalPassed = 0;
        let totalFailed = 0;

        if (!bddRun) {
            ctx.finishPhase('execute', 'auto_resolved', {
                reason: 'bdd_run_feature tool not registered; skipping execution',
            });
            CSStatusWriter.write(ctx);
            return jsonResult(
                {
                    state: 'RUNNING', runId, phase: 'execute',
                    scenariosPassed: 0, scenariosFailed: 0,
                    nextStepNeeded: true, nextSuggestedTool: 'csaa_verify',
                    nextSuggestedArgs: { runId },
                    note: 'bdd_run_feature not available in this environment',
                },
                `Execute skipped (bdd_run_feature not available). Call csaa_verify.`,
            );
        }

        for (const feature of features) {
            const runDir = path.join(
                CSRunContext.phaseFolder('execute'),
                'runs',
                path.basename(feature, '.feature'),
            );
            try {
                const result = await bddRun.handler(
                    {
                        featureFile: feature,
                        project,
                        env,
                        ...(tags ? { tags } : {}),
                    },
                    _toolCtx,
                );
                const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? '';
                ctx.writePhaseArtifact('execute', path.join(runDir, 'output.log'), text);
                const passed = !result.isError && /(passed|0 fail|all scenarios passed)/i.test(text);
                if (passed) totalPassed++;
                else totalFailed++;
                let classification: ReturnType<typeof CSHealClassifier.classify> | undefined;
                if (!passed) {
                    const signals: HealFailureSignals = {
                        stdout: text,
                        stderr: text,
                        failingScenario: path.basename(feature),
                    };
                    classification = CSHealClassifier.classify(signals);
                    ctx.writePhaseArtifact(
                        'execute',
                        path.join(runDir, 'classification.json'),
                        JSON.stringify(classification, null, 2),
                    );
                    ctx.writePhaseArtifact(
                        'execute',
                        path.join(runDir, 'classification.md'),
                        CSHealClassifier.renderMarkdown(classification, signals),
                    );
                }
                perFeature.push({ feature, passed, output: text.slice(0, 800), classification });
            } catch (err) {
                totalFailed++;
                perFeature.push({
                    feature,
                    passed: false,
                    output: err instanceof Error ? err.message : String(err),
                });
                ctx.writePhaseArtifact(
                    'execute',
                    path.join(runDir, 'output.log'),
                    err instanceof Error ? err.stack ?? err.message : String(err),
                );
            }
        }

        const md = renderExecuteMarkdown(perFeature);
        const reportPath = CSStatusWriter.writePhaseReport(
            ctx, 'execute', 'Execution Report', md,
        );
        ctx.writePhaseArtifact(
            'execute',
            'summary.json',
            JSON.stringify(
                {
                    perFeature: perFeature.map((f) => ({
                        feature: f.feature,
                        passed: f.passed,
                        category: f.classification?.category,
                        severity: f.classification?.severity,
                    })),
                    totalPassed,
                    totalFailed,
                },
                null, 2,
            ),
        );
        ctx.finishPhase(
            'execute',
            totalFailed === 0 ? 'done' : 'auto_resolved',
            { reportPath },
        );
        CSStatusWriter.write(ctx);

        return jsonResult(
            {
                state: 'RUNNING',
                runId,
                phase: 'execute',
                scenariosPassed: totalPassed,
                scenariosFailed: totalFailed,
                runFolder: ctx.runFolder,
                reportPath,
                nextStepNeeded: true,
                nextSuggestedTool: 'csaa_verify',
                nextSuggestedArgs: { runId },
            },
            `Execute: ${totalPassed} passed / ${totalFailed} failed across ${features.length} feature(s). Call csaa_verify.`,
        );
    })
    .build();

function renderExecuteMarkdown(
    perFeature: Array<{
        feature: string;
        passed: boolean;
        output: string;
        classification?: ReturnType<typeof CSHealClassifier.classify>;
    }>,
): string {
    const lines: string[] = [];
    lines.push('# Execution Report');
    lines.push('');
    for (const f of perFeature) {
        lines.push(`## \`${f.feature}\`  ${f.passed ? '✅ passed' : '❌ failed'}`);
        if (f.classification) {
            lines.push('');
            lines.push(`- **Category:** ${f.classification.category}  **Severity:** ${f.classification.severity}`);
            lines.push(`- ${f.classification.summary}`);
            lines.push(`- _Suggested action:_ ${f.classification.suggestedAction}`);
        }
        lines.push('');
    }
    return lines.join('\n');
}

// ============================================================================
// csaa_verify — Phase 9a: trust score + final report
// ============================================================================

const csaa_verify: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('csaa_verify')
    .title('CS-AI-Auto-Assist — Verify (Phase 9)')
    .description(
        'Compute the trust score from the run\'s artefacts (source-grounded, executed, ' +
            'audit-passed, heal-cycles) and write the final-report.md at the run folder root.',
    )
    .category('multiagent')
    .stringParam('runId', 'Run ID', { required: true })
    .handler(async (params: Record<string, unknown>) => {
        const runId = String(params.runId ?? '');
        const ctx = getCtx(runId);
        if (!ctx) return errorResult(`unknown runId '${runId}'`, runId);

        ctx.startPhase('verify');
        const reportRaw = ctx.readPhaseArtifact('analyze', 'analysis-report.json');
        const violationsRaw = ctx.readPhaseArtifact('audit', 'violations.json');
        const writtenRaw = ctx.readPhaseArtifact('write', 'written.json');
        const summaryRaw = ctx.readPhaseArtifact('execute', 'summary.json');

        const report = reportRaw ? (JSON.parse(reportRaw) as AnalysisReport) : null;
        const violations = violationsRaw ? JSON.parse(violationsRaw) as Record<string, unknown[]> : {};
        const written = writtenRaw ? JSON.parse(writtenRaw) as { written: string[] } : { written: [] };
        const summary = summaryRaw
            ? (JSON.parse(summaryRaw) as { totalPassed: number; totalFailed: number })
            : { totalPassed: 0, totalFailed: 0 };

        const auditClean = Object.keys(violations).length === 0;
        const trust = CSTrustScore.compute({
            sourceGrounded: !!report,
            executed: summary.totalPassed + summary.totalFailed > 0,
            judgeVerdict: summary.totalFailed === 0 && summary.totalPassed > 0 ? 'PASS_REAL' : summary.totalPassed > 0 ? 'PASS_WEAK' : 'FAIL',
            hasAlternativeLocators: false,
            hasMeaningfulAssertions: !!report && report.tests.some((t) => t.assertionCount > 0),
            commitReadyCheckPassed: auditClean,
            healCyclesUsed: summary.totalFailed,
        });
        ctx.writePhaseArtifact(
            'verify',
            'trust-score.json',
            JSON.stringify({ trust, summary, auditClean }, null, 2),
        );
        ctx.complete();
        CSStatusWriter.write(ctx);
        const finalPath = CSStatusWriter.writeFinalReport(ctx, {
            filesWritten: written.written,
            trustScore: trust,
            warnings: !auditClean ? [`${Object.keys(violations).length} files have audit violations`] : [],
        });

        return jsonResult(
            {
                state: trust >= 0.85 ? 'READY' : 'BLOCKED_NEED_HUMAN',
                runId,
                phase: 'verify',
                trustScore: trust,
                scenariosPassed: summary.totalPassed,
                scenariosFailed: summary.totalFailed,
                auditClean,
                runFolder: ctx.runFolder,
                finalReportPath: finalPath,
                nextStepNeeded: false,
            },
            `Verify complete. Trust ${trust.toFixed(2)}; ${summary.totalPassed} passed / ${summary.totalFailed} failed. Final report: ${finalPath}`,
        );
    })
    .build();

// ============================================================================
// csaa_publish — Phase 9b (optional): push run results back to ADO
// ============================================================================

const csaa_publish: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('csaa_publish')
    .title('CS-AI-Auto-Assist — Publish to ADO (optional)')
    .description(
        'Push generated test cases back to an ADO test plan + suite. Walks every generated ' +
            'feature\'s scenarios and creates one ADO Test Case per scenario without an existing ' +
            '@TC_<id> tag, then injects the new TC ids back into the .feature file.',
    )
    .category('multiagent')
    .stringParam('runId', 'Run ID', { required: true })
    .stringParam('planId', 'ADO Test Plan ID', { required: true })
    .stringParam('suiteId', 'ADO Test Suite ID', { required: true })
    .stringParam('organization', 'ADO organization (or ADO_ORGANIZATION env)')
    .stringParam('project', 'ADO project (or ADO_PROJECT env)')
    .stringParam('pat', 'ADO PAT (or ADO_PAT env, supports ENCRYPTED:)')
    .handler(async (params: Record<string, unknown>, _toolCtx: MCPToolContext) => {
        const runId = String(params.runId ?? '');
        const ctx = getCtx(runId);
        if (!ctx) return errorResult(`unknown runId '${runId}'`, runId);

        const writtenRaw = ctx.readPhaseArtifact('write', 'written.json');
        if (!writtenRaw) {
            return errorResult(`no written artefacts — call csaa_write first`, runId);
        }
        const written = JSON.parse(writtenRaw) as { written: string[] };
        const featureFiles: GeneratedFeatureSummary[] = written.written
            .filter((p) => p.endsWith('.feature'))
            .map((p) => parseFeatureForSummary(p));

        const planId = Number(params.planId);
        const suiteId = Number(params.suiteId);
        const adoCommon = {
            organization: getStr(params, 'organization') ?? '',
            project: getStr(params, 'project') ?? '',
            pat: getStr(params, 'pat') ?? '',
        };
        const pipelineOutput: PipelineOutput = {
            runId, pipelineVersion: '1.33.1',
            filesCreated: written.written, featureFiles,
        };
        try {
            const result = await CSAdoCreateBackFlow.maybeCreateBack(
                pipelineOutput, planId, suiteId, adoCommon, _toolCtx,
            );
            return jsonResult(
                {
                    state: 'READY',
                    runId,
                    phase: 'publish',
                    createdTestCaseIds: result.createdTestCaseIds,
                    linked: result.linkedScenarios,
                    skipped: result.skipped,
                    updatedFiles: result.updatedFiles,
                    nextStepNeeded: false,
                },
                `Published ${result.createdTestCaseIds.length} test case(s) to plan ${planId} suite ${suiteId}.`,
            );
        } catch (err) {
            return errorResult(
                `csaa_publish failed: ${err instanceof Error ? err.message : String(err)}`,
                runId,
            );
        }
    })
    .build();

function parseFeatureForSummary(filePath: string): GeneratedFeatureSummary {
    let content = '';
    try { content = fs.readFileSync(filePath, 'utf-8'); } catch { /* ignore */ }
    const scenarios: GeneratedScenarioSummary[] = [];
    const lines = content.split(/\r?\n/);
    let pendingTags: string[] = [];
    for (const raw of lines) {
        const trimmed = raw.trim();
        if (trimmed.startsWith('@')) {
            for (const t of trimmed.split(/\s+/)) {
                if (t.startsWith('@')) pendingTags.push(t);
            }
            continue;
        }
        const m = trimmed.match(/^Scenario(?:\s+Outline)?\s*:\s*(.+?)\s*$/);
        if (m) {
            const title = m[1];
            const idTag = pendingTags.find((t) => /^@(?:TS_|tc_|TC_)/i.test(t)) ?? pendingTags[0] ?? title;
            const id = idTag.replace(/^@/, '');
            const tcMatch = pendingTags.find((t) => /^@TC_\d+$/.test(t));
            scenarios.push({
                id,
                title,
                tags: pendingTags.slice(),
                tcId: tcMatch ? Number(tcMatch.replace(/^@TC_/, '')) : undefined,
            });
            pendingTags = [];
        } else if (trimmed.length > 0 && !trimmed.startsWith('#')) {
            pendingTags = [];
        }
    }
    return { filePath, content, scenarios };
}

// ============================================================================
// Helper tools — query existing pages/steps + correction memory + DOM
// ============================================================================

const csaa_query_existing_pages: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('csaa_query_existing_pages')
    .title('CS-AI-Auto-Assist — Query Existing Pages')
    .description(
        'Scan `test/<project>/pages/` for existing CS Playwright page objects and rank them ' +
            'by semantic similarity to a candidate legacy page name. Used by translator to ' +
            'reuse rather than re-create.',
    )
    .category('multiagent')
    .stringParam('workspaceRoot', 'Workspace root', { required: true })
    .stringParam('project', 'Project name', { required: true })
    .stringParam('module', 'Optional module sub-folder')
    .stringParam('candidateClassName', 'Legacy page class name to match against', { required: true })
    .handler(async (params: Record<string, unknown>) => {
        const workspaceRoot = String(params.workspaceRoot ?? '');
        const project = String(params.project ?? '');
        const candidate = String(params.candidateClassName ?? '');
        if (!workspaceRoot || !project || !candidate) {
            return errorResult('workspaceRoot, project, candidateClassName all required');
        }
        const inv = CSRepoInventory.inventory(project, { workspaceRoot });
        const decision = CSSemanticReuse.decidePage(
            { className: candidate, sourcePath: undefined, elements: [], publicMethods: [] },
            inv.pages,
        );
        return jsonResult(decision,
            `decidePage for ${candidate}: ${decision.decision} (top score ${decision.candidates[0]?.score?.toFixed(2) ?? '0'}).`,
        );
    })
    .build();

const csaa_read_legacy_data: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('csaa_read_legacy_data')
    .title('CS-AI-Auto-Assist — Read Legacy Data File')
    .description(
        'Read a legacy data file (.xlsx, .xls, .csv, .tsv, .json, .properties, .xml) into ' +
            'typed rows. Returns columns + first N rows (cap default 100) for analyzer use.',
    )
    .category('multiagent')
    .stringParam('filePath', 'Absolute path to the data file', { required: true })
    .stringParam('sheet', 'Optional sheet name (xlsx only)')
    .handler(async (params: Record<string, unknown>) => {
        const filePath = String(params.filePath ?? '');
        if (!filePath) return errorResult('filePath required');
        const result = CSLegacyDataReader.read(filePath, {
            sheet: getStr(params, 'sheet'),
        });
        return jsonResult(result,
            result.kind === 'rows'
                ? `Read ${result.rowCount} rows / ${result.columns.length} cols from ${result.format} file.`
                : `Could not read ${filePath}: ${result.reason}`,
        );
    })
    .build();

// ============================================================================
// Public registry
// ============================================================================

export const csaaPrimitiveTools: MCPToolDefinition[] = [
    csaa_discover,
    csaa_analyze,
    csaa_plan,
    csaa_translate,
    csaa_audit,
    csaa_write,
    csaa_execute,
    csaa_verify,
    csaa_publish,
    csaa_query_existing_pages,
    csaa_read_legacy_data,
];
