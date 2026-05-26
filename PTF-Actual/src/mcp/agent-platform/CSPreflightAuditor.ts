/**
 * Agentic Test Platform — Pre-Flight Auditor (Phase 7.5)
 *
 * Inserts between `csaa_write` (Phase 7) and `csaa_execute` (Phase 8) to
 * give the agent a deterministic "is this generated code actually ready
 * to run?" check before paying for browser execution.
 *
 * Three tiers, all static (no live app needed):
 *
 *   Tier 1 — content validator. Re-runs `CSContentValidator.validateAll`
 *            on every file under `test/<project>/<module>/` to catch any
 *            patterns that slipped past finalize (e.g. agent edited a
 *            file post-write).
 *
 *   Tier 2 — regex audit (PO012–PO015 + DB / SD rule families). Walks
 *            generated .ts files and flags `@CSGetElement` shape errors,
 *            non-existent method calls, raw `this.page.*`, raw dialog
 *            handling, and duplicate `@CSBDDStepDef` patterns across
 *            files.
 *
 *   Tier 3 — readiness verdict. Aggregates findings + emits a single
 *            `passed | blocked` decision the orchestrator can act on.
 *            Blocking conditions: any error-severity violation, any
 *            duplicate step-def, any raw dialog usage.
 *
 * Live-app browser probing (Tier 4 in the VDI design) is intentionally
 * deferred — Copilot/VDI environments can drive that from the agent
 * directly via `browser_*` tools using the env config injected at write
 * time. The auditor's job here is the STATIC pre-flight.
 *
 * @module agent-platform/CSPreflightAuditor
 */

import * as fs from 'fs';
import * as path from 'path';
import { CSContentValidator, ContentViolation, TranslationFile } from './CSContentValidator';

// ============================================================================
// Public Types
// ============================================================================

export type PreflightSeverity = 'error' | 'warn';

export interface PreflightFinding {
    /** Relative path under workspaceRoot. */
    relativePath: string;
    /** Rule id (validator rule id or regex audit id). */
    ruleId: string;
    severity: PreflightSeverity;
    message: string;
    /** Optional: 1-indexed line number in the file (when ruleId derives from a line match). */
    line?: number;
}

export interface PreflightReport {
    /** Overall verdict — `passed` only if zero error-severity findings AND no duplicate step-defs. */
    verdict: 'passed' | 'blocked';
    /** Files scanned during this pre-flight pass. */
    filesScanned: number;
    /** Findings sorted by severity (error first), then relativePath. */
    findings: PreflightFinding[];
    /** Duplicate `@CSBDDStepDef` patterns observed across step files. */
    duplicateStepDefs: Array<{ pattern: string; paths: string[] }>;
    /** Aggregate counts for the orchestrator's STATUS.md. */
    summary: {
        errorCount: number;
        warnCount: number;
        duplicateStepDefCount: number;
    };
}

// ============================================================================
// CSPreflightAuditor
// ============================================================================

/**
 * Static utility class. All methods are pure functions over the
 * filesystem — no LLM, no browser, no MCP context. The orchestrator
 * decides what to do with the report.
 */
export class CSPreflightAuditor {
    /**
     * Audit every file under `test/<project>/<module>/` (or
     * `test/<project>/` if no module) plus `config/<project>/`. Returns
     * a single report aggregating all findings.
     */
    public static audit(
        workspaceRoot: string,
        project: string,
        module?: string,
    ): PreflightReport {
        const findings: PreflightFinding[] = [];
        const testRoot = path.join(workspaceRoot, 'test', project);

        // ----- Collect every file once -----
        const files: TranslationFile[] = [];
        if (fs.existsSync(testRoot)) {
            CSPreflightAuditor.collectTranslationFiles(testRoot, workspaceRoot, files, module);
        }

        // ----- Tier 1: content validator -----
        try {
            const v = CSContentValidator.validateAll(files);
            for (const violation of v) {
                findings.push(CSPreflightAuditor.fromValidator(violation));
            }
        } catch (e) {
            findings.push({
                relativePath: testRoot,
                ruleId: 'preflight-internal-error',
                severity: 'error',
                message: `content validator threw: ${(e as Error).message}`,
            });
        }

        // ----- Tier 2: regex audit (PO012-PO015 belt-and-suspenders) -----
        for (const file of files) {
            findings.push(...CSPreflightAuditor.regexAuditFile(file));
        }

        // ----- Tier 3: cross-file duplicate-step-def detection -----
        const duplicateStepDefs = CSPreflightAuditor.detectDuplicateStepDefs(
            files.filter((f) => f.kind === 'steps'),
        );
        for (const dup of duplicateStepDefs) {
            findings.push({
                relativePath: dup.paths[0],
                ruleId: 'duplicate-step-def-across-files',
                severity: 'error',
                message:
                    `pre-flight: @CSBDDStepDef pattern "${dup.pattern}" appears in ` +
                    `${dup.paths.length} files (${dup.paths.join(', ')}). Cucumber will throw ` +
                    '"ambiguous step definition" at runtime. Move to one canonical file.',
            });
        }

        // ----- Sort + aggregate -----
        findings.sort((a, b) => {
            if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1;
            return a.relativePath.localeCompare(b.relativePath);
        });
        const errorCount = findings.filter((f) => f.severity === 'error').length;
        const warnCount = findings.filter((f) => f.severity === 'warn').length;

        return {
            verdict: errorCount === 0 && duplicateStepDefs.length === 0 ? 'passed' : 'blocked',
            filesScanned: files.length,
            findings,
            duplicateStepDefs,
            summary: {
                errorCount,
                warnCount,
                duplicateStepDefCount: duplicateStepDefs.length,
            },
        };
    }

    /**
     * Render a one-screen text summary suitable for `STATUS.md` or a chat
     * reply. Quiet on success, structured on blockage so the agent can
     * remediate without re-reading the entire findings list.
     */
    public static renderReport(report: PreflightReport): string {
        if (report.verdict === 'passed') {
            return [
                `Pre-flight: PASSED (${report.filesScanned} files scanned, ` +
                    `${report.summary.warnCount} warning${report.summary.warnCount === 1 ? '' : 's'}). ` +
                    'Ready for execute.',
            ].join('\n');
        }
        const lines: string[] = [
            `Pre-flight: BLOCKED — ${report.summary.errorCount} error(s), ` +
                `${report.summary.warnCount} warning(s), ` +
                `${report.summary.duplicateStepDefCount} duplicate step-def(s). ` +
                'Fix before re-running execute.',
            '',
        ];
        const errors = report.findings.filter((f) => f.severity === 'error').slice(0, 25);
        for (const f of errors) {
            lines.push(`  [${f.ruleId}] ${f.relativePath}${f.line ? `:${f.line}` : ''} — ${f.message}`);
        }
        if (report.summary.errorCount > 25) {
            lines.push(`  …and ${report.summary.errorCount - 25} more error(s).`);
        }
        return lines.join('\n');
    }

    // ------------------------------------------------------------------
    // Tier helpers
    // ------------------------------------------------------------------

    /**
     * Walk `test/<project>/` and load every file the validator can
     * inspect (.feature, .ts, .json under expected sub-folders).
     */
    private static collectTranslationFiles(
        root: string,
        workspaceRoot: string,
        out: TranslationFile[],
        moduleFilter?: string,
    ): void {
        const stack: string[] = [root];
        const tryKind = (rel: string): TranslationFile['kind'] | null => {
            if (rel.endsWith('.feature')) return 'feature';
            if (rel.endsWith('.steps.ts')) return 'steps';
            if (rel.endsWith('.page.ts') || /\/pages\//.test(rel)) return 'page';
            if (rel.endsWith('-scenarios.json') || /\/data\//.test(rel)) return 'data';
            return null;
        };
        while (stack.length > 0) {
            const cur = stack.pop()!;
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(cur, { withFileTypes: true });
            } catch {
                continue;
            }
            for (const e of entries) {
                const abs = path.join(cur, e.name);
                if (e.isDirectory()) {
                    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
                    stack.push(abs);
                    continue;
                }
                const rel = path.relative(workspaceRoot, abs).replace(/\\/g, '/');
                if (moduleFilter && !rel.includes(`/${moduleFilter}/`) && !rel.includes('/common/')) {
                    continue;
                }
                const kind = tryKind(rel);
                if (!kind) continue;
                try {
                    const content = fs.readFileSync(abs, 'utf-8');
                    out.push({ relativePath: rel, kind, content });
                } catch {
                    // unreadable — skip
                }
            }
        }
    }

    /**
     * Per-file regex audit. Mirrors the regex rules in
     * `src/mcp/skills/audit-rules/rules.yaml` for PO012-PO015 plus a
     * small set of cross-cutting checks. Belt-and-suspenders to
     * `CSContentValidator` — catches anything that bypassed the
     * content gate.
     */
    private static regexAuditFile(file: TranslationFile): PreflightFinding[] {
        const out: PreflightFinding[] = [];
        if (file.kind !== 'page' && file.kind !== 'steps') return out;
        const lines = file.content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            const ln = lines[i];
            if (file.kind === 'page') {
                if (/@CSGetElement\s*\([^)]*\bstrategy\s*:/.test(ln)) {
                    out.push({
                        relativePath: file.relativePath,
                        ruleId: 'PO012',
                        severity: 'error',
                        message: '@CSGetElement uses non-existent `strategy:` property. Use `xpath:` / `css:` directly.',
                        line: i + 1,
                    });
                }
                if (/alternativeLocators\s*:\s*\[\s*\{/.test(ln)) {
                    out.push({
                        relativePath: file.relativePath,
                        ruleId: 'PO013',
                        severity: 'error',
                        message: '`alternativeLocators` is a string[] with `css:`/`xpath:` prefix, never an object array.',
                        line: i + 1,
                    });
                }
                if (/\.getAttributeValue\s*\(/.test(ln)) {
                    out.push({
                        relativePath: file.relativePath,
                        ruleId: 'PO014',
                        severity: 'error',
                        message: '`.getAttributeValue()` does not exist on CSWebElement. Use `.getAttribute(name)`.',
                        line: i + 1,
                    });
                }
                if (/this\.page\.once\s*\(\s*['"`]dialog['"`]/.test(ln)) {
                    out.push({
                        relativePath: file.relativePath,
                        ruleId: 'PO015',
                        severity: 'error',
                        message: 'Raw `this.page.once("dialog", …)`. Use inherited `acceptNextDialog()` / `dismissNextDialog()`.',
                        line: i + 1,
                    });
                }
            }
            // PO016 — swapped *WithTimeout argument order. Applies to page
            // AND steps files (steps can call page-element methods too).
            // Value-carrying *WithTimeout methods take the value first and
            // the timeout last; a numeric literal as the first arg is an
            // unambiguous swapped-args bug. Timeout-only methods
            // (clickWithTimeout, hoverWithTimeout, …) are deliberately
            // excluded — a numeric first arg is correct for those.
            if (/\.(fill|type|pressSequentially|press|selectOption|uploadFiles|uploadFile|setChecked|getAttribute|dragTo|dispatchEvent)WithTimeout\s*\(\s*\d/.test(ln)) {
                out.push({
                    relativePath: file.relativePath,
                    ruleId: 'PO016',
                    severity: 'error',
                    message: 'Swapped *WithTimeout arguments — value comes first, timeout last (`fillWithTimeout(value, 5000)`, not `fillWithTimeout(5000, value)`).',
                    line: i + 1,
                });
            }

            // LN001-LN004 — login / navigation anti-patterns. Apply to page
            // AND steps files. Belt-and-suspenders to CSContentValidator.
            if (/\.getPage\s*\(\s*\)/.test(ln)) {
                out.push({
                    relativePath: file.relativePath,
                    ruleId: 'LN001',
                    severity: 'error',
                    message: '`.getPage()` returns the raw Playwright Page — bypasses self-healing/reporting/waits. Drive interactions through @CSGetElement CSWebElement properties and CSBasePage methods.',
                    line: i + 1,
                });
            }
            if (/\{config:(?!DEFAULT_)[A-Z][A-Z0-9]*_(?:BASE_URL|USERNAME|PASSWORD)\}/.test(ln)) {
                out.push({
                    relativePath: file.relativePath,
                    ruleId: 'LN002',
                    severity: 'error',
                    message: 'Project-prefixed config key. Use the canonical keys: `{config:BASE_URL}`, `{config:DEFAULT_USERNAME}`, `{config:DEFAULT_PASSWORD}`.',
                    line: i + 1,
                });
            }
            if (/nsg-x|LogonPoint|doAuthentication|NetScaler|ldap-non-prod/i.test(ln)) {
                out.push({
                    relativePath: file.relativePath,
                    ruleId: 'LN003',
                    severity: 'error',
                    message: 'Hand-rolled SSO/Citrix/NetScaler redirect handling. CSBasePage.navigate() handles the SSO bounce automatically when CROSS_DOMAIN_NAVIGATION_ENABLED=true — remove the manual block.',
                    line: i + 1,
                });
            }
            if (/\.(goto|waitForURL)\s*\(/.test(ln)) {
                out.push({
                    relativePath: file.relativePath,
                    ruleId: 'LN004',
                    severity: 'error',
                    message: 'Raw navigation (`.goto()` / `.waitForURL()`). Use the inherited `this.<page>.navigate()` — it reads BASE_URL from config and handles cross-domain auth.',
                    line: i + 1,
                });
            }
        }
        return out;
    }

    /**
     * Cross-file duplicate `@CSBDDStepDef` detector. Two step files
     * defining the same pattern triggers Cucumber "ambiguous step
     * definition" at runtime — better caught here.
     */
    private static detectDuplicateStepDefs(
        stepFiles: TranslationFile[],
    ): Array<{ pattern: string; paths: string[] }> {
        const byPattern = new Map<string, string[]>();
        const decoratorRe = /@CSBDDStepDef\s*\(\s*['"`]([^'"`]+)['"`]/g;
        for (const f of stepFiles) {
            let m: RegExpExecArray | null;
            const local = new Set<string>();
            while ((m = decoratorRe.exec(f.content)) !== null) {
                local.add(m[1]);
            }
            for (const p of local) {
                const list = byPattern.get(p) ?? [];
                list.push(f.relativePath);
                byPattern.set(p, list);
            }
        }
        const dups: Array<{ pattern: string; paths: string[] }> = [];
        for (const [pattern, paths] of byPattern.entries()) {
            if (paths.length >= 2) dups.push({ pattern, paths });
        }
        return dups;
    }

    private static fromValidator(v: ContentViolation): PreflightFinding {
        return {
            relativePath: v.relativePath,
            ruleId: v.ruleId,
            severity: v.severity === 'warning' ? 'warn' : (v.severity as PreflightSeverity),
            message: v.message,
        };
    }
}
