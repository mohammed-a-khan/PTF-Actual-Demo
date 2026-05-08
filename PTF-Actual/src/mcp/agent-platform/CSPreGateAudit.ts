/**
 * Agentic Test Platform — Pre-Gate Audit
 *
 * Runs the framework's deterministic `audit_file` rule engine across every
 * generated artefact (page objects, step files, feature files, scenarios
 * JSON, DB helpers) before the master tool dispatches to the heal loop.
 *
 * **Why before the gate, not inside it:** the gate's `commit_ready_check`
 * step does a similar audit, but it runs after a full BDD execution
 * (~30s+ per feature) that's wasted if the file has a structural rule
 * violation no test run will resolve. Surfacing PO005 ("missing
 * description on @CSGetElement") at audit time gives Copilot a precise,
 * actionable failure (`file:line + ruleId + message`) that it can fix
 * via `replace_string_in_file` in seconds, then loop back into the
 * pipeline.
 *
 * The audit is run in parallel across all generated files. Aggregated
 * violations come back grouped by file with severity counts. Callers
 * (the master tool) decide policy: fail-fast on errors, log warnings,
 * etc. This module is policy-free.
 *
 * @module agent-platform/CSPreGateAudit
 */

import * as path from 'path';
import { auditTools } from '../tools/audit/CSMCPAuditTools';
import { MCPToolContext, MCPToolDefinition, MCPToolResult } from '../types/CSMCPTypes';

/**
 * Single violation from the audit engine — `ruleId` is one of the 30+
 * documented rule codes (PO/SD/FF/DF/DB/CC), `severity` is `error` or
 * `warning`, `line` is 1-based.
 */
export interface AuditViolation {
    ruleId: string;
    severity: 'error' | 'warning';
    line?: number;
    message: string;
}

/** Per-file audit verdict. */
export interface FileAuditResult {
    file: string;
    fileType: 'page' | 'step' | 'feature' | 'data' | 'helper' | 'ts';
    pass: boolean;
    violations: AuditViolation[];
    errors: number;
    warnings: number;
}

/** Aggregated audit report across every generated file. */
export interface PreGateAuditResult {
    /** True iff every file passed (no error-severity violations). */
    pass: boolean;
    totalFiles: number;
    totalErrors: number;
    totalWarnings: number;
    /** Per-file results, in input order. Files with no audit type detected are omitted. */
    files: FileAuditResult[];
    /**
     * Human-readable single-line summary for response prose. Active-tense
     * imperative when failures exist ("Action required: fix N rule
     * violation(s) in M file(s) before re-running.").
     */
    summary: string;
}

/**
 * Detect the audit fileType from the path. Returns null for files the
 * rule engine doesn't recognise (e.g. .env, .md provenance, config).
 */
function detectFileType(filePath: string): FileAuditResult['fileType'] | null {
    const lower = filePath.toLowerCase().replace(/\\/g, '/');
    if (lower.endsWith('.feature')) return 'feature';
    if (/[\\/]data[\\/].+\.json$/i.test(lower) || lower.endsWith('-data.json')) return 'data';
    if (lower.endsWith('.steps.ts')) return 'step';
    if (lower.endsWith('.page.ts')) return 'page';
    if (/[\\/]helpers?[\\/].+\.ts$/i.test(lower) || lower.endsWith('helper.ts')) return 'helper';
    if (lower.endsWith('.ts')) return 'ts';
    return null;
}

export class CSPreGateAudit {
    /**
     * Audit every file in `generatedFiles`. Files outside the framework's
     * audit scope (env, config, markdown) are silently skipped. Network
     * and disk are not touched beyond what `audit_file` itself does
     * (file read + rule evaluation).
     *
     * @param generatedFiles  Absolute or workspace-relative paths produced by a mode handler
     * @param context         MCP tool context for invoking audit_file
     * @param options.includeCompileErrors  When true, audit_file also runs `tsc --noEmit` on each .ts file. Slower (~3-8s per file). Default false; the gate's compile_check step covers this once across the workspace.
     */
    public static async run(
        generatedFiles: string[],
        context: MCPToolContext,
        options: { includeCompileErrors?: boolean; cwd?: string } = {},
    ): Promise<PreGateAuditResult> {
        const cwd = options.cwd ?? process.cwd();
        const includeCompile = options.includeCompileErrors === true;

        // Resolve auditable files; skip non-auditable types (env, config, .md).
        const targets: Array<{ absPath: string; fileType: FileAuditResult['fileType'] }> = [];
        for (const f of generatedFiles) {
            const fileType = detectFileType(f);
            if (!fileType) continue;
            const absPath = path.isAbsolute(f) ? f : path.resolve(cwd, f);
            targets.push({ absPath, fileType });
        }

        // Run audits in parallel — each audit is a pure rule eval over file
        // content, no shared state, so concurrency is safe.
        const results = await Promise.all(
            targets.map((t) => CSPreGateAudit.auditOne(t.absPath, t.fileType, includeCompile, cwd, context)),
        );

        const totalErrors = results.reduce((s, r) => s + r.errors, 0);
        const totalWarnings = results.reduce((s, r) => s + r.warnings, 0);
        const failingFileCount = results.filter((r) => !r.pass).length;
        const pass = failingFileCount === 0;

        const summary = pass
            ? `Audit clean: ${results.length} file(s) passed all framework rules${totalWarnings > 0 ? ` (${totalWarnings} warning(s) only — review later)` : ''}.`
            : `Action required: fix ${totalErrors} rule violation(s) across ${failingFileCount} file(s) before re-running. Each violation has a ruleId (e.g. PO005), file path, and line number — apply the fix via replace_string_in_file then re-invoke cs_ai_auto_assist.`;

        return {
            pass,
            totalFiles: results.length,
            totalErrors,
            totalWarnings,
            files: results,
            summary,
        };
    }

    private static async auditOne(
        absPath: string,
        fileType: FileAuditResult['fileType'],
        includeCompile: boolean,
        cwd: string,
        context: MCPToolContext,
    ): Promise<FileAuditResult> {
        const params: Record<string, unknown> = {
            path: absPath,
            fileType,
            cwd,
        };
        if (includeCompile && (fileType === 'page' || fileType === 'step' || fileType === 'helper' || fileType === 'ts')) {
            params.includeCompileErrors = true;
        }

        const tool = auditTools.find((d: MCPToolDefinition) => d.tool.name === 'audit_file');
        if (!tool) {
            return {
                file: absPath,
                fileType,
                pass: false,
                violations: [{ ruleId: 'INTERNAL', severity: 'error', message: 'audit_file tool not registered' }],
                errors: 1,
                warnings: 0,
            };
        }

        const raw = await tool.handler(params, context);
        return CSPreGateAudit.parseAuditResult(raw, absPath, fileType);
    }

    private static parseAuditResult(
        raw: MCPToolResult,
        absPath: string,
        fileType: FileAuditResult['fileType'],
    ): FileAuditResult {
        if (raw.isError) {
            return {
                file: absPath,
                fileType,
                pass: false,
                violations: [
                    {
                        ruleId: 'INTERNAL',
                        severity: 'error',
                        message: CSPreGateAudit.firstText(raw) || 'audit_file returned error result',
                    },
                ],
                errors: 1,
                warnings: 0,
            };
        }

        const text = CSPreGateAudit.firstText(raw);
        let parsed: { pass?: boolean; violations?: AuditViolation[]; stats?: { errors?: number; warnings?: number } };
        try {
            parsed = JSON.parse(text);
        } catch {
            return {
                file: absPath,
                fileType,
                pass: false,
                violations: [
                    {
                        ruleId: 'INTERNAL',
                        severity: 'error',
                        message: 'audit_file returned non-JSON output',
                    },
                ],
                errors: 1,
                warnings: 0,
            };
        }

        const violations = Array.isArray(parsed.violations) ? parsed.violations : [];
        const errors = parsed.stats?.errors ?? violations.filter((v) => v.severity === 'error').length;
        const warnings = parsed.stats?.warnings ?? violations.filter((v) => v.severity === 'warning').length;

        return {
            file: absPath,
            fileType,
            pass: parsed.pass === true,
            violations,
            errors,
            warnings,
        };
    }

    private static firstText(result: MCPToolResult): string {
        for (const c of result.content ?? []) {
            if (c.type === 'text') return c.text;
        }
        return '';
    }
}
