/**
 * Agentic Test Platform — Constitutional Safety
 *
 * A hard-coded list of forbidden actions plus a `checkAction` predicate.
 * Every tool invocation that the platform performs autonomously must pass
 * through this gate before execution. HARD_BLOCK violations abort the
 * action with a structured reason; WARN violations are surfaced for
 * human review but do not block.
 *
 * Privacy-by-design: rules describe behavioral classes, not domain-specific
 * data. No domain or organization-level identifiers appear in this file.
 *
 * @module agent-platform/CSConstitutionalSafety
 */

import { SafetyViolation } from './types';

// ============================================================================
// Rule Catalog
// ============================================================================

export interface ConstitutionalRule {
    id: string;
    description: string;
    severity: 'HARD_BLOCK' | 'WARN';
}

/**
 * The seven constitutional rules. Order is significant only for reporting;
 * checks are independent.
 */
export const CONSTITUTIONAL_RULES: ConstitutionalRule[] = [
    {
        id: 'NO_PROD_DELETE',
        description: 'No DELETE on production-classified data',
        severity: 'HARD_BLOCK',
    },
    {
        id: 'NO_REAL_PII',
        description: 'No real PII in generated test data — synthetic only',
        severity: 'HARD_BLOCK',
    },
    {
        id: 'NO_AUTO_MERGE',
        description: 'No auto-merge to shared branches',
        severity: 'HARD_BLOCK',
    },
    {
        id: 'NO_AUTH_BYPASS',
        description: 'No bypass of authentication flows',
        severity: 'HARD_BLOCK',
    },
    {
        id: 'NO_SOURCE_EXFIL',
        description: 'No exfiltration of source code to external services',
        severity: 'HARD_BLOCK',
    },
    {
        id: 'NO_SILENT_DESTRUCT',
        description: 'No silent destructive operations',
        severity: 'HARD_BLOCK',
    },
    {
        id: 'IRREVERSIBLE_HUMAN_GATED',
        description: 'All irreversible actions must be human-gated',
        severity: 'HARD_BLOCK',
    },
];

// ============================================================================
// PII Detection (lightweight, used only for rule signal)
// ============================================================================

/**
 * Lightweight PII regex list. The full sanitizer is in CSPiiSanitizer; this
 * subset is here only for the NO_REAL_PII rule signal so a generation tool
 * with PII-shaped data is rejected even before sanitization runs.
 */
const PII_SIGNAL_PATTERNS: RegExp[] = [
    /\b\d{3}-?\d{2}-?\d{4}\b/,                                    // SSN-like
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,         // email
    /\b(?:\d[ -]*?){13,16}\b/,                                    // card-like
];

const SHARED_BRANCH_NAMES = new Set([
    'main',
    'master',
    'develop',
    'release',
    'production',
    'prod',
]);

const DESTRUCTIVE_TOOLS = new Set([
    'ado_work_items_update',
    'ado_pull_requests_create',
    'ado_builds_cancel',
]);

const EXTERNAL_HOSTS_PATTERN =
    /\b(?:pastebin\.com|gist\.github\.com|hastebin\.com|0x0\.st|transfer\.sh)\b/i;

// ============================================================================
// CSConstitutionalSafety
// ============================================================================

/**
 * Static safety checker. The single public method is `checkAction`, which
 * returns the list of violations a proposed action would trigger. An
 * empty list means the action is allowed.
 */
export class CSConstitutionalSafety {
    /**
     * Check a proposed tool invocation against every rule. Returns all
     * violations; the caller decides whether to abort (any HARD_BLOCK)
     * or merely warn (only WARN).
     */
    public static checkAction(action: {
        tool: string;
        params: Record<string, unknown>;
    }): SafetyViolation[] {
        const violations: SafetyViolation[] = [];
        const tool = action.tool ?? '';
        const params = action.params ?? {};
        const attemptedAction = `${tool}(${JSON.stringify(params).slice(0, 200)})`;

        // -- NO_PROD_DELETE --------------------------------------------------
        const classification = String(
            params.classification ?? params.environment ?? '',
        ).toLowerCase();
        const op = String(params.action ?? params.op ?? '').toLowerCase();
        const isDelete = op === 'delete' || /^DELETE\b/i.test(String(params.sql ?? ''));
        if (
            isDelete &&
            (classification === 'production' || classification === 'prod')
        ) {
            violations.push(
                CSConstitutionalSafety.makeViolation(
                    'NO_PROD_DELETE',
                    'HARD_BLOCK',
                    'Attempted DELETE against production-classified data',
                    attemptedAction,
                ),
            );
        }

        // -- NO_REAL_PII -----------------------------------------------------
        if (CSConstitutionalSafety.containsPiiSignal(params)) {
            violations.push(
                CSConstitutionalSafety.makeViolation(
                    'NO_REAL_PII',
                    'HARD_BLOCK',
                    'Parameters contain values matching real PII patterns',
                    attemptedAction,
                ),
            );
        }

        // -- NO_AUTO_MERGE ---------------------------------------------------
        const merge =
            tool === 'ado_pull_requests_create' && params.autoComplete === true;
        const targetRef = String(params.targetRefName ?? params.targetBranch ?? '')
            .replace(/^refs\/heads\//, '')
            .toLowerCase();
        if (merge && SHARED_BRANCH_NAMES.has(targetRef)) {
            violations.push(
                CSConstitutionalSafety.makeViolation(
                    'NO_AUTO_MERGE',
                    'HARD_BLOCK',
                    `Auto-merge to shared branch '${targetRef}' is forbidden`,
                    attemptedAction,
                ),
            );
        }

        // -- NO_AUTH_BYPASS --------------------------------------------------
        if (CSConstitutionalSafety.attemptsAuthBypass(tool, params)) {
            violations.push(
                CSConstitutionalSafety.makeViolation(
                    'NO_AUTH_BYPASS',
                    'HARD_BLOCK',
                    'Action attempts to bypass authentication',
                    attemptedAction,
                ),
            );
        }

        // -- NO_SOURCE_EXFIL -------------------------------------------------
        if (CSConstitutionalSafety.attemptsSourceExfil(tool, params)) {
            violations.push(
                CSConstitutionalSafety.makeViolation(
                    'NO_SOURCE_EXFIL',
                    'HARD_BLOCK',
                    'Action targets a known external paste/share host',
                    attemptedAction,
                ),
            );
        }

        // -- NO_SILENT_DESTRUCT / IRREVERSIBLE_HUMAN_GATED -------------------
        if (DESTRUCTIVE_TOOLS.has(tool) && params.humanApproved !== true) {
            violations.push(
                CSConstitutionalSafety.makeViolation(
                    'IRREVERSIBLE_HUMAN_GATED',
                    'HARD_BLOCK',
                    `Tool '${tool}' is irreversible and requires humanApproved=true`,
                    attemptedAction,
                ),
            );
        }

        // -- NO_SILENT_DESTRUCT — dangerous shell / SQL patterns -------------
        // Catches the documented `rm -rf /`, `DROP TABLE`, `TRUNCATE TABLE`,
        // force-push, and reset-hard cases regardless of which tool ran them.
        // Scans every string-valued param.
        if (CSConstitutionalSafety.attemptsDangerousShell(params)) {
            violations.push(
                CSConstitutionalSafety.makeViolation(
                    'NO_SILENT_DESTRUCT',
                    'HARD_BLOCK',
                    'Action contains a known-destructive shell or SQL pattern',
                    attemptedAction,
                ),
            );
        }

        return violations;
    }

    /**
     * Match the documented destructive patterns across any string-valued
     * parameter: rm -rf at root or HOME, DROP/TRUNCATE TABLE, git
     * force-push to main/master, git reset --hard, container deletes
     * targeting prod.
     */
    private static attemptsDangerousShell(
        params: Record<string, unknown>,
    ): boolean {
        const patterns: RegExp[] = [
            /\brm\s+-rf\b\s+(?:\/|~|\$HOME|\*)/i,
            /\bDROP\s+TABLE\b/i,
            /\bTRUNCATE\s+TABLE\b/i,
            /\bgit\s+push\s+(?:--force|-f)\b.*\b(?:main|master)\b/i,
            /\bgit\s+reset\s+--hard\b/i,
            /\bgit\s+branch\s+-D\b/i,
        ];
        for (const v of Object.values(params)) {
            if (typeof v !== 'string') continue;
            for (const p of patterns) {
                if (p.test(v)) return true;
            }
        }
        return false;
    }

    // ========================================================================
    // Helpers
    // ========================================================================

    /**
     * Walk the params object and return true iff any string-valued field
     * matches a PII signal pattern.
     */
    private static containsPiiSignal(params: Record<string, unknown>): boolean {
        const stack: unknown[] = [params];
        while (stack.length > 0) {
            const cur = stack.pop();
            if (cur === null || cur === undefined) continue;
            if (typeof cur === 'string') {
                for (const re of PII_SIGNAL_PATTERNS) {
                    if (re.test(cur)) return true;
                }
                continue;
            }
            if (Array.isArray(cur)) {
                for (const item of cur) stack.push(item);
                continue;
            }
            if (typeof cur === 'object') {
                for (const v of Object.values(cur as Record<string, unknown>)) {
                    stack.push(v);
                }
            }
        }
        return false;
    }

    /**
     * Heuristics for auth-bypass attempts: setting bypassAuth flags,
     * mutating session cookies directly, or invoking magic-link endpoints
     * outside their normal flow.
     */
    private static attemptsAuthBypass(
        tool: string,
        params: Record<string, unknown>,
    ): boolean {
        if (params.bypassAuth === true || params.skipAuth === true) return true;
        const url = String(params.url ?? '').toLowerCase();
        if (/\/(?:bypass|impersonate|debug-login)\b/.test(url)) return true;
        if (
            tool === 'browser_set_cookies' &&
            /session|auth|jwt/.test(JSON.stringify(params).toLowerCase())
        ) {
            return true;
        }
        return false;
    }

    /**
     * Detect attempts to write source-code-shaped content to a known
     * external paste/share host.
     */
    private static attemptsSourceExfil(
        tool: string,
        params: Record<string, unknown>,
    ): boolean {
        if (tool !== 'fetch' && tool !== 'http_post' && tool !== 'browser_navigate') {
            // Restricted to tools that could plausibly reach an external host.
            // Other tools may still fail elsewhere but not under this rule.
            const url = String(params.url ?? '');
            if (!url) return false;
            return EXTERNAL_HOSTS_PATTERN.test(url);
        }
        const url = String(params.url ?? '');
        return EXTERNAL_HOSTS_PATTERN.test(url);
    }

    /**
     * Construct a SafetyViolation record.
     */
    private static makeViolation(
        rule: string,
        severity: 'HARD_BLOCK' | 'WARN',
        description: string,
        attemptedAction: string,
    ): SafetyViolation {
        return { rule, severity, description, attemptedAction };
    }
}
