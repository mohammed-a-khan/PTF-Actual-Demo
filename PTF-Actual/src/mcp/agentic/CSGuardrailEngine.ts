/**
 * Agentic SDLC Platform — Guardrail Engine
 *
 * The redesign's rule: no orphaned safety code. Every guardrail here is
 * invoked on the live path by the meta-tools / playbook engine:
 *
 *   intake      — PII redaction + secret rejection (CSPiiSanitizer)
 *   action      — constitutional rules on handoffs/writes (CSConstitutionalSafety)
 *   budget      — token/wall-clock/$ ceilings, warn at 80%, block at 100%
 *   submission  — JSON-schema gate on every csaa_submit (CSSchemaValidator)
 *   limits      — bounded loops (stages, submit retries, heal cycles)
 *   trust       — unified CSTrustScore verdict at finalize
 *
 * Token accounting: the MCP server cannot see the host model's true token
 * meter, so we estimate chars/4 for everything that flows through the
 * boundary (inputs, envelopes, submissions, reports). Estimates are
 * deliberately conservative — the point is stopping runaway sessions
 * before they exhaust a user's Copilot credit allowance.
 *
 * @module agentic/CSGuardrailEngine
 */

import { CSPiiSanitizer } from '../agent-platform/CSPiiSanitizer';
import { CSConstitutionalSafety } from '../agent-platform/CSConstitutionalSafety';
import { CSSchemaValidator } from '../agent-platform/CSSchemaValidator';
import { CSTrustScore } from '../agent-platform/CSTrustScore';
import type { JsonSchema } from '../agent-platform/CSDelegationSchemas';
import type { SafetyViolation, TrustScoreInputs } from '../agent-platform/types';
import { SessionRecord } from './types';
import { CSSessionStore } from './CSSessionStore';

// ============================================================================
// Limits
// ============================================================================

export const GUARDRAIL_LIMITS = {
    /** Hard ceiling on engine steps per session (runaway protection). */
    maxStepsPerSession: 200,
    /** Retries per cognitive envelope before the session blocks. */
    maxSubmitRetries: 3,
    /** Heal cycles per session. */
    maxHealCycles: 20,
    /** Warn threshold as a fraction of any budget axis. */
    warnAt: 0.8,
    /** User-approved +50% budget extensions per session (then truly hard). */
    maxBudgetExtensions: 3,
    /** Max chars a chunked csaa_submit buffer may accumulate. */
    maxSubmitBufferChars: 2_000_000,
};

export interface BudgetVerdict {
    ok: boolean;
    warn: boolean;
    pctUsed: number;
    reason?: string;
}

export interface IntakeVerdict {
    ok: boolean;
    cleaned: Record<string, string | number | boolean>;
    reason?: string;
}

// ============================================================================
// CSGuardrailEngine
// ============================================================================

export class CSGuardrailEngine {
    // ------------------------------------------------------------------
    // Intake: PII redaction + secret rejection on all user inputs
    // ------------------------------------------------------------------

    public static intake(
        inputs: Record<string, string | number | boolean>,
    ): IntakeVerdict {
        const cleaned: Record<string, string | number | boolean> = {};
        for (const [key, value] of Object.entries(inputs)) {
            if (typeof value !== 'string') {
                cleaned[key] = value;
                continue;
            }
            const result = CSPiiSanitizer.sanitize(value, 'reject_secrets_only');
            if (result.decision === 'REJECTED') {
                return {
                    ok: false,
                    cleaned: {},
                    reason:
                        `Input "${key}" appears to contain a credential/secret ` +
                        `(${result.violations.map((v) => v.pattern).join(', ')}). ` +
                        'Remove it — credentials are configured through the encrypted ' +
                        'config flow, never through chat input.',
                };
            }
            cleaned[key] = result.cleaned;
        }
        return { ok: true, cleaned };
    }

    // ------------------------------------------------------------------
    // Constitutional action check (writes, executions, publishes)
    // ------------------------------------------------------------------

    public static checkAction(
        tool: string,
        params: Record<string, unknown>,
    ): { ok: boolean; violations: SafetyViolation[]; reason?: string } {
        const violations = CSConstitutionalSafety.checkAction({ tool, params });
        const hard = violations.filter((v) => v.severity === 'HARD_BLOCK');
        if (hard.length > 0) {
            return {
                ok: false,
                violations,
                reason: hard.map((v) => `${v.rule}: ${v.description}`).join('; '),
            };
        }
        return { ok: true, violations };
    }

    // ------------------------------------------------------------------
    // Read-only SQL guard (agentic sessions NEVER mutate a database)
    // ------------------------------------------------------------------

    /**
     * Enforce the platform's hard database rule: SELECT-only. The agent may
     * discover schema and read data, but INSERT/UPDATE/DELETE/DDL are
     * rejected server-side regardless of what the model asks for. Test
     * data that doesn't exist is created through the application UI
     * (the ui_create fallback), exactly like a human tester would.
     */
    public static checkReadOnlySql(sql: string): { ok: boolean; reason?: string } {
        const raw = String(sql ?? '');
        if (!raw.trim()) return { ok: true };

        // Strip string literals and comments in a SINGLE left-to-right scan.
        // Sequential regex passes are bypassable via strip-order confusion
        // (an apostrophe inside a `--` comment opens a fake "string" that
        // swallows real SQL the DB would execute). A lexical scan consumes
        // each construct in the order the DB parser would. Two deliberate
        // hardenings: MySQL executable comments (`/*! ... */`) are treated as
        // CODE (their body reaches the keyword scan), and backslash escapes
        // inside strings are consumed so `\'` can't prematurely close one.
        const stripped = CSGuardrailEngine.stripSqlLiteralsAndComments(raw);

        const statements = stripped
            .split(';')
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
        if (statements.length > 1) {
            return {
                ok: false,
                reason: 'multi-statement SQL batches are not allowed in agentic sessions',
            };
        }

        const stmt = (statements[0] ?? '').toUpperCase();
        const firstWord = stmt.split(/\s+/)[0] ?? '';
        const allowedStarts = ['SELECT', 'WITH', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN'];
        if (!allowedStarts.includes(firstWord)) {
            return {
                ok: false,
                reason: `only read statements (${allowedStarts.join('/')}) are allowed — got "${firstWord}"`,
            };
        }

        const forbidden =
            /\b(INSERT|UPDATE|DELETE|MERGE|UPSERT|REPLACE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|EXEC|EXECUTE|CALL|LOCK)\b|\bSELECT\b[\s\S]*\bINTO\b|\bFOR\s+UPDATE\b/;
        const match = stmt.match(forbidden);
        if (match) {
            return {
                ok: false,
                reason: `write/DDL keyword "${match[0].trim()}" is blocked — the agentic platform is strictly SELECT-only; create missing test data through the application UI instead`,
            };
        }
        return { ok: true };
    }

    /**
     * Single-pass lexical stripper: replaces string literals with '' / "" and
     * removes comments, consuming constructs strictly left-to-right so no
     * pass can be confused by tokens inside an earlier construct.
     */
    private static stripSqlLiteralsAndComments(raw: string): string {
        let out = '';
        let i = 0;
        const n = raw.length;
        while (i < n) {
            const c = raw[i];
            const next = i + 1 < n ? raw[i + 1] : '';

            // -- line comment → skip to end of line
            if (c === '-' && next === '-') {
                while (i < n && raw[i] !== '\n') i++;
                out += ' ';
                continue;
            }

            // /* block comment */ — but MySQL executable comments (/*! ... */)
            // are EXECUTED by MySQL, so their body must be kept as code.
            if (c === '/' && next === '*') {
                const executable = raw[i + 2] === '!';
                if (executable) {
                    i += 3; // consume '/*!' and optional version digits
                    while (i < n && /[0-9]/.test(raw[i])) i++;
                    out += ' ';
                    // body continues as CODE until '*/', which we also consume
                    while (i < n) {
                        if (raw[i] === '*' && raw[i + 1] === '/') { i += 2; break; }
                        out += raw[i];
                        i++;
                    }
                } else {
                    i += 2;
                    while (i < n) {
                        if (raw[i] === '*' && raw[i + 1] === '/') { i += 2; break; }
                        i++;
                    }
                    out += ' ';
                }
                continue;
            }

            // 'string' — '' doubling is honored (ANSI, works in every dialect).
            // Backslash is treated as a LITERAL, not an escape: under ANSI /
            // PostgreSQL standard_conforming_strings a backslash does not
            // escape the closing quote, so `'\'` CLOSES the string and any
            // following `; DELETE` is a separate statement the multi-statement
            // check must see. Treating `\` as an escape (MySQL-only) would
            // hide exactly that attack — so we err toward exposing it.
            if (c === "'" || c === '"' || c === '`') {
                const quote = c;
                i++;
                while (i < n) {
                    if (raw[i] === quote && raw[i + 1] === quote) { i += 2; continue; } // '' doubling
                    if (raw[i] === quote) { i++; break; }
                    i++;
                }
                out += quote === '`' ? '``' : quote + quote;
                continue;
            }

            out += c;
            i++;
        }
        return out;
    }

    /**
     * Inspect a tool call's params for SQL-bearing fields and enforce the
     * read-only rule on each. Used by the data pack's handler interceptor.
     */
    public static checkSqlParams(
        params: Record<string, unknown>,
    ): { ok: boolean; reason?: string } {
        for (const key of ['sql', 'query', 'statement', 'command']) {
            const value = params[key];
            if (typeof value !== 'string') continue;
            // Named-query lookups (identifiers) are not SQL text — skip pure identifiers.
            if (key === 'query' && /^[A-Za-z0-9_.-]+$/.test(value.trim())) continue;
            const verdict = CSGuardrailEngine.checkReadOnlySql(value);
            if (!verdict.ok) return verdict;
        }
        return { ok: true };
    }

    // ------------------------------------------------------------------
    // Budget
    // ------------------------------------------------------------------

    /** chars/4 heuristic — record boundary-crossing content on the session. */
    public static recordTokens(session: SessionRecord, chars: number): void {
        const tokens = Math.ceil(Math.max(0, chars) / 4);
        session.usage.estimatedTokens += tokens;
        // Mid-tier blended rate ≈ $9/1M tokens (avg of input/output list rates).
        session.usage.estimatedCostUsd += (tokens / 1_000_000) * 9;
    }

    private static activeMs(session: SessionRecord): number {
        const base = session.activeSince ?? session.createdAt;
        return Date.now() - new Date(base).getTime();
    }

    public static recordToolCall(session: SessionRecord): void {
        session.usage.toolCalls += 1;
        session.usage.wallClockMs = CSGuardrailEngine.activeMs(session);
    }

    public static checkBudget(session: SessionRecord): BudgetVerdict {
        const u = session.usage;
        u.wallClockMs = CSGuardrailEngine.activeMs(session);
        const axes: Array<{ pct: number; reason: string }> = [
            {
                pct: u.estimatedTokens / u.budgetMaxTokens,
                reason: `token budget exhausted (~${u.estimatedTokens.toLocaleString()} of ${u.budgetMaxTokens.toLocaleString()} estimated tokens)`,
            },
            {
                pct: u.wallClockMs / u.budgetMaxWallClockMs,
                reason: `wall-clock budget exhausted (${Math.round(u.wallClockMs / 60000)} min of ${Math.round(u.budgetMaxWallClockMs / 60000)} min)`,
            },
            {
                pct: u.estimatedCostUsd / u.budgetMaxCostUsd,
                reason: `cost ceiling reached (~$${u.estimatedCostUsd.toFixed(2)} of $${u.budgetMaxCostUsd.toFixed(2)})`,
            },
        ];
        const worst = axes.reduce((a, b) => (a.pct >= b.pct ? a : b));
        if (worst.pct >= 1) {
            return { ok: false, warn: true, pctUsed: worst.pct, reason: worst.reason };
        }
        return { ok: true, warn: worst.pct >= GUARDRAIL_LIMITS.warnAt, pctUsed: worst.pct };
    }

    /**
     * User-approved extension: +50% on every axis, logged. Capped at
     * maxBudgetExtensions — after that the ceiling is genuinely hard and the
     * session must be finished in a new, deliberately-scoped session instead
     * of extended forever (an uncapped extend loop is no budget at all).
     */
    public static extendBudget(session: SessionRecord): { ok: boolean; reason?: string } {
        const u = session.usage;
        if (u.budgetExtensions >= GUARDRAIL_LIMITS.maxBudgetExtensions) {
            return {
                ok: false,
                reason:
                    `budget already extended ${u.budgetExtensions}× (max ${GUARDRAIL_LIMITS.maxBudgetExtensions}). ` +
                    'Start a new session with a narrower scope instead.',
            };
        }
        u.budgetMaxTokens = Math.round(u.budgetMaxTokens * 1.5);
        u.budgetMaxWallClockMs = Math.round(u.budgetMaxWallClockMs * 1.5);
        u.budgetMaxCostUsd = Math.round(u.budgetMaxCostUsd * 1.5 * 100) / 100;
        u.budgetExtensions += 1;
        CSSessionStore.appendTimeline(session, {
            event: 'budget_extended',
            extensions: u.budgetExtensions,
            newMaxTokens: u.budgetMaxTokens,
        });
        return { ok: true };
    }

    // ------------------------------------------------------------------
    // Loop limits
    // ------------------------------------------------------------------

    public static checkStepLimit(session: SessionRecord): BudgetVerdict {
        if (session.stepsExecuted >= GUARDRAIL_LIMITS.maxStepsPerSession) {
            return {
                ok: false,
                warn: true,
                pctUsed: 1,
                reason: `session exceeded ${GUARDRAIL_LIMITS.maxStepsPerSession} engine steps — halting as runaway protection`,
            };
        }
        return {
            ok: true,
            warn: false,
            pctUsed: session.stepsExecuted / GUARDRAIL_LIMITS.maxStepsPerSession,
        };
    }

    // ------------------------------------------------------------------
    // Submission gate
    // ------------------------------------------------------------------

    public static validateSubmission(
        payload: unknown,
        schema: JsonSchema,
    ): { ok: boolean; errors: string[] } {
        const errors = CSSchemaValidator.validate(payload, schema).map(
            (e) => `${e.path}: ${e.message}`,
        );
        return { ok: errors.length === 0, errors };
    }

    // ------------------------------------------------------------------
    // Config preflight — warn about missing dependencies BEFORE work starts
    // ------------------------------------------------------------------

    /**
     * Check that the infrastructure a mode needs is actually present, so the
     * user is told up-front (not after paying for several stages) when a live
     * app URL, database config, ADO credentials, or a git repo is missing.
     * Returns human-readable warnings; never blocks — some deps are optional
     * and modes degrade gracefully.
     */
    public static preflight(
        mode: string,
        inputs: Record<string, string | number | boolean>,
        workspaceRoot: string,
    ): string[] {
        const warnings: string[] = [];
        const has = (p: string): boolean => {
            try {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                return require('fs').existsSync(require('path').join(workspaceRoot, p));
            } catch {
                return false;
            }
        };
        const cfgHas = (key: string): boolean => {
            try {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const { CSConfigurationManager } = require('../../core/CSConfigurationManager');
                const v = CSConfigurationManager.getInstance().get(key, '');
                return typeof v === 'string' && v.trim().length > 0;
            } catch {
                return !!process.env[key];
            }
        };

        const planUsesAdo = mode === 'plan' && String(inputs.source ?? '') === 'ado_plan';
        // Modes that CANNOT proceed without ADO config. plan-from-ado_plan
        // belongs here too: its plan.source stage emits an ADO fetch handoff
        // that can only fail (or pressure fabrication) without credentials.
        const adoModes = new Set(['ado_plan', 'ado_automate', 'pr_impact', ...(planUsesAdo ? ['plan'] : [])]);
        const adoOptional = new Set(['release']);
        const gitModes = new Set(['pr_review', 'regression']);
        const runModes = new Set(['run', 'heal', 'regression', 'performance']);
        const liveUrlModes = new Set(['accessibility', 'security', 'load']);

        if (adoModes.has(mode) || adoOptional.has(mode)) {
            const missing = ['ADO_ORGANIZATION', 'ADO_PROJECT', 'ADO_PAT'].filter((k) => !cfgHas(k));
            if (missing.length > 0) {
                const msg = `Azure DevOps config missing (${missing.join(', ')}). Set them in config/<project> (PAT as ENCRYPTED:) or pass as params.`;
                warnings.push(adoModes.has(mode) ? `BLOCKER: ${msg}` : `NOTE: ${msg} — the ADO evidence step will be skipped.`);
            } else if (cfgHas('ADO_PROXY_ENABLED') || process.env.HTTPS_PROXY) {
                warnings.push('NOTE: ADO calls will route through the configured proxy (ADO_PROXY_* / HTTPS_PROXY).');
            }
        }
        if (gitModes.has(mode) && !has('.git')) {
            warnings.push('NOTE: no .git directory found — change detection falls back to HEAD~1 or the full suite.');
        }
        if (runModes.has(mode)) {
            const project = String(inputs.project ?? '');
            if (project && !has(`test/${project}/features`)) {
                warnings.push(`NOTE: test/${project}/features not found — there may be nothing to execute.`);
            }
        }
        if (liveUrlModes.has(mode)) {
            const url = String(inputs.targetUrl ?? inputs.appUrl ?? '');
            if (!/^https?:\/\//i.test(url)) {
                warnings.push('NOTE: this mode drives a live application; ensure the target URL is reachable and Playwright browsers are installed.');
            }
        }
        if ((mode === 'author' || mode === 'migrate')) {
            const project = String(inputs.project ?? '');
            const dbConfigured = project ? (() => {
                try {
                    // eslint-disable-next-line @typescript-eslint/no-var-requires
                    const fs = require('fs'); const path = require('path');
                    const dir = path.join(workspaceRoot, 'config', project);
                    if (!fs.existsSync(dir)) return false;
                    // shallow scan for any DB_* key in the project's .env files
                    return fs.readdirSync(dir, { withFileTypes: true }).some((e: { isFile: () => boolean; name: string }) => {
                        if (!e.isFile() || !e.name.endsWith('.env')) return false;
                        return /\bDB_[A-Z]/.test(fs.readFileSync(path.join(dir, e.name), 'utf-8'));
                    });
                } catch {
                    return false;
                }
            })() : false;
            if (!dbConfigured) {
                warnings.push('NOTE: no database config detected for this project — data-first resolution will fall back to UI-created / static test data.');
            }
        }
        return warnings;
    }

    // ------------------------------------------------------------------
    // Trust (single, unified model — CSTrustScore weighted sum)
    // ------------------------------------------------------------------

    public static computeTrust(
        session: SessionRecord,
        signals: Partial<TrustScoreInputs>,
    ): { score: number; level: string; recommendation: string } {
        const inputs: TrustScoreInputs = {
            sourceGrounded: signals.sourceGrounded ?? true,
            executed: signals.executed ?? false,
            judgeVerdict: signals.judgeVerdict ?? 'PASS_WEAK',
            hasAlternativeLocators: signals.hasAlternativeLocators ?? false,
            hasMeaningfulAssertions: signals.hasMeaningfulAssertions ?? true,
            commitReadyCheckPassed: signals.commitReadyCheckPassed ?? false,
            healCyclesUsed: signals.healCyclesUsed ?? session.healCycles,
        };
        const score = CSTrustScore.compute(inputs);
        const interp = CSTrustScore.interpretScore(score);
        session.trustScore = score;
        session.trustLevel = interp.level;
        return { score, level: interp.level, recommendation: interp.recommendation };
    }
}
