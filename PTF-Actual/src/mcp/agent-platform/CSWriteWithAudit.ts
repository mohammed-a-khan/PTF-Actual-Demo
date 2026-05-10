/**
 * Agentic Test Platform — Audit-Gated Writer (Rebuild M9)
 *
 * Writes a `ContentMap` to disk one file at a time, running the framework's
 * `audit_file` rule engine before each write. On rule violation, the file
 * is NOT written; the caller (orchestrator) feeds the violations back to
 * the translator's LLM resolver via the gate engine for one targeted
 * re-translation pass.
 *
 * Implements the colleague's **Fix Manifest** discipline: every write
 * action is announced with the file path + violation count + reuse
 * decision before bytes hit disk. Atomic per-file (no partial writes).
 *
 * Skip-existing protection: when a target file already exists and the
 * caller has not opted-in via `overwriteExisting: true`, the file is
 * skipped and recorded in `skippedExisting`.
 *
 * @module agent-platform/CSWriteWithAudit
 */

import * as fs from 'fs';
import * as path from 'path';
import { ContentMap } from './CSBddTranslator';

// ============================================================================
// Public Types
// ============================================================================

export interface WriteOptions {
    workspaceRoot: string;
    overwriteExisting?: boolean;
    /** Max line count per file before warning (very large files often = bug). */
    largeFileWarnLines?: number;
    /**
     * Optional auditor function — passed in by the caller so this module
     * stays decoupled from the audit-rule engine. The caller wires
     * audit_file from `tools/audit/CSMCPAuditTools`.
     */
    auditor?: (filePath: string, content: string) => Promise<AuditResult>;
}

export interface AuditResult {
    passed: boolean;
    violations: AuditViolation[];
}

export interface AuditViolation {
    ruleId: string;
    severity: 'error' | 'warning' | 'info';
    line?: number;
    message: string;
}

export interface FixManifestEntry {
    relativePath: string;
    absPath: string;
    bytes: number;
    sha256: string;
    decision: 'wrote' | 'skipped_existing' | 'audit_failed' | 'large_file_warning';
    violations?: AuditViolation[];
    confidence: number;
}

export interface WriteResult {
    manifest: FixManifestEntry[];
    written: string[];          // absolute paths
    skippedExisting: string[];  // absolute paths
    auditFailed: Array<{ relativePath: string; violations: AuditViolation[] }>;
    warnings: string[];
}

// ============================================================================
// CSWriteWithAudit
// ============================================================================

import { createHash } from 'crypto';

export class CSWriteWithAudit {
    /**
     * Write every file in the content map with audit gating.
     */
    public static async write(
        contentMap: ContentMap,
        options: WriteOptions,
    ): Promise<WriteResult> {
        const result: WriteResult = {
            manifest: [],
            written: [],
            skippedExisting: [],
            auditFailed: [],
            warnings: [],
        };
        const largeWarn = options.largeFileWarnLines ?? 2000;

        for (const [relativePath, content] of Object.entries(contentMap.files)) {
            const absPath = path.resolve(options.workspaceRoot, relativePath);
            const exists = fs.existsSync(absPath);

            if (exists && !options.overwriteExisting) {
                result.skippedExisting.push(absPath);
                result.manifest.push({
                    relativePath,
                    absPath,
                    bytes: 0,
                    sha256: '',
                    decision: 'skipped_existing',
                    confidence: contentMap.confidence[relativePath] ?? 0.5,
                });
                continue;
            }

            // Audit gate.
            if (options.auditor) {
                const audit = await options.auditor(absPath, content);
                if (!audit.passed) {
                    result.auditFailed.push({ relativePath, violations: audit.violations });
                    result.manifest.push({
                        relativePath,
                        absPath,
                        bytes: 0,
                        sha256: '',
                        decision: 'audit_failed',
                        violations: audit.violations,
                        confidence: contentMap.confidence[relativePath] ?? 0.5,
                    });
                    continue;
                }
            }

            // Large-file warning.
            const lines = content.split(/\r?\n/).length;
            if (lines > largeWarn) {
                result.warnings.push(
                    `${relativePath} has ${lines} lines (>${largeWarn}); review for split.`,
                );
            }

            // Write atomically: write to .tmp + rename.
            CSWriteWithAudit.ensureDir(path.dirname(absPath));
            const tmp = absPath + '.tmp';
            fs.writeFileSync(tmp, content, 'utf-8');
            fs.renameSync(tmp, absPath);

            const sha = createHash('sha256').update(content).digest('hex');
            result.written.push(absPath);
            result.manifest.push({
                relativePath,
                absPath,
                bytes: Buffer.byteLength(content),
                sha256: sha.slice(0, 16),
                decision: lines > largeWarn ? 'large_file_warning' : 'wrote',
                confidence: contentMap.confidence[relativePath] ?? 0.5,
            });
        }

        return result;
    }

    /**
     * Render the Fix Manifest as user-readable Markdown for `STATUS.md`
     * link target. Always written; caller decides where it lands.
     */
    public static renderManifest(result: WriteResult): string {
        const lines: string[] = [];
        lines.push('# Fix Manifest');
        lines.push('');
        lines.push(
            `Wrote: ${result.written.length}  ·  Skipped (existing): ${result.skippedExisting.length}  ·  Audit-failed: ${result.auditFailed.length}  ·  Warnings: ${result.warnings.length}`,
        );
        lines.push('');
        lines.push('| Decision | File | Bytes | SHA-256 | Confidence |');
        lines.push('|---|---|---|---|---|');
        for (const m of result.manifest) {
            const conf = m.confidence.toFixed(2);
            lines.push(
                `| ${m.decision} | \`${m.relativePath}\` | ${m.bytes} | \`${m.sha256}\` | ${conf} |`,
            );
        }
        if (result.auditFailed.length > 0) {
            lines.push('');
            lines.push('## Audit failures');
            lines.push('');
            for (const af of result.auditFailed) {
                lines.push(`### \`${af.relativePath}\``);
                for (const v of af.violations) {
                    lines.push(
                        `- **[${v.severity}] ${v.ruleId}**${v.line ? ` (line ${v.line})` : ''}: ${v.message}`,
                    );
                }
                lines.push('');
            }
        }
        if (result.warnings.length > 0) {
            lines.push('');
            lines.push('## Warnings');
            for (const w of result.warnings) lines.push(`- ${w}`);
        }
        return lines.join('\n') + '\n';
    }

    private static ensureDir(p: string): void {
        try {
            fs.mkdirSync(p, { recursive: true });
        } catch {
            // ignore EEXIST
        }
    }
}
