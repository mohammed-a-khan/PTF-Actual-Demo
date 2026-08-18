/**
 * Per-invocation structured logger.
 *
 * Every log line is a single JSON object on stderr (so it never pollutes the
 * MCP stdout channel) and also appended to `.cs-qa/audit/ado-audit.jsonl` in
 * the workspace root. The audit file is append-only so users can `git log`
 * their ADO history and correlate a failure to the exact tool invocation.
 *
 * Redaction:
 * - Authorization headers → ***REDACTED***
 * - Basic-auth base64 tokens (Basic xxx) → Basic ***
 * - ENCRYPTED: values are kept as-is (already sealed)
 * - Raw `pat`/`personalAccessToken` string field values are masked
 *
 * The logger NEVER throws — if the audit file can't be written, it silently
 * degrades to stderr only.
 */

import * as fs from 'fs';
import * as path from 'path';

export type LogLevel = 'info' | 'warn' | 'error';

export interface Logger {
    info(msg: string, extra?: Record<string, unknown>): void;
    warn(msg: string, extra?: Record<string, unknown>): void;
    error(msg: string, extra?: Record<string, unknown>): void;
    flush(): void;
}

const AUTH_HEADER_RE = /"authorization"\s*:\s*"([^"]+)"/gi;
const BASIC_TOKEN_RE = /Basic\s+[A-Za-z0-9+/=]+/g;
const PAT_FIELD_RE = /("(?:personalAccessToken|pat|token)"\s*:\s*")([^"]{4,})(")/gi;

function redact(text: string): string {
    return text
        .replace(AUTH_HEADER_RE, '"authorization":"***REDACTED***"')
        .replace(BASIC_TOKEN_RE, 'Basic ***')
        .replace(PAT_FIELD_RE, (_full, pre, val, post) => {
            const keepLast4 = val.length > 8 ? `***${String(val).slice(-4)}` : '***';
            return `${pre}${keepLast4}${post}`;
        });
}

function safeStringify(obj: unknown): string {
    try {
        return JSON.stringify(obj, (_k, v) => {
            if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack };
            return v;
        });
    } catch {
        return JSON.stringify({ _stringifyError: true });
    }
}

export function createLogger(invocationId: string, toolName: string, opts: { workspaceRoot?: string; auditFile?: string; enableAudit?: boolean } = {}): Logger {
    const enableAudit = opts.enableAudit !== false;
    const auditPath = opts.auditFile
        ?? (opts.workspaceRoot ? path.join(opts.workspaceRoot, '.cs-qa', 'audit', 'ado-audit.jsonl') : null);
    let auditReady = false;
    let auditFailedOnce = false;

    if (enableAudit && auditPath) {
        try {
            fs.mkdirSync(path.dirname(auditPath), { recursive: true });
            auditReady = true;
        } catch {
            auditReady = false;
        }
    }

    function write(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
        const record: Record<string, unknown> = {
            ts: new Date().toISOString(),
            invocationId,
            toolName,
            level,
            msg,
        };
        if (extra) {
            for (const [k, v] of Object.entries(extra)) {
                if (k === 'ts' || k === 'invocationId' || k === 'toolName' || k === 'level' || k === 'msg') continue;
                record[k] = v;
            }
        }
        const line = redact(safeStringify(record));
        // stderr keeps MCP stdout clean.
        try { process.stderr.write(line + '\n'); } catch { /* ignore */ }
        if (auditReady && auditPath && !auditFailedOnce) {
            try {
                fs.appendFileSync(auditPath, line + '\n', { encoding: 'utf-8' });
            } catch {
                // Give up on audit file after one failure to avoid retry spam.
                auditFailedOnce = true;
            }
        }
    }

    return {
        info: (msg, extra) => write('info', msg, extra),
        warn: (msg, extra) => write('warn', msg, extra),
        error: (msg, extra) => write('error', msg, extra),
        flush: () => { /* stderr + appendFileSync are already synchronous */ },
    };
}

/** Exposed for tests. */
export const _redactForTests = redact;

/**
 * Public redactor for any tool that needs to emit a payload that MAY carry
 * secrets — output notes, error messages, echo-back of config the user asked
 * to see. Uses the same rules as the audit-log redactor:
 *  - Authorization headers → ***REDACTED***
 *  - Basic-auth base64 tokens → Basic ***
 *  - `pat` / `personalAccessToken` / `token` string field values (in JSON-y
 *    text) → ***last4
 *  - ADO PAT-shape tokens (52 chars base64-url alphabet) → ***REDACTED***
 *  - Azure SAS `sig=` values → sig=***REDACTED***
 *  - GitHub PAT prefixes (ghp_, gho_, ghu_, ghs_, ghr_) → prefix+***
 *
 * Accepts either an object (returns redacted deep-clone) or a string (returns
 * redacted string).
 */

const ADO_PAT_SHAPE_RE = /\b[A-Za-z0-9]{52}\b/g;
const AZURE_SAS_SIG_RE = /(\bsig=)[A-Za-z0-9%+/=_-]{20,}/gi;
const GITHUB_PAT_RE = /\b(gh[pousr])_[A-Za-z0-9_]{20,}\b/g;
const PRIVATE_KEY_RE = /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g;
const PASSWORD_ASSIGN_RE = /("?(?:password|passwd|pwd)"?\s*[:=]\s*"?)([^"'\s;,}\]]{4,})("?)/gi;

export function redactSecrets(input: string | Record<string, unknown>): string | Record<string, unknown> {
    if (typeof input === 'string') return redactString(input);
    const s = safeStringify(input);
    const cleaned = redactString(s);
    try { return JSON.parse(cleaned) as Record<string, unknown>; }
    catch { return { redactedText: cleaned }; }
}

function redactString(text: string): string {
    let out = redact(text);
    out = out.replace(PRIVATE_KEY_RE, '-----BEGIN PRIVATE KEY-----***REDACTED***-----END PRIVATE KEY-----');
    out = out.replace(GITHUB_PAT_RE, (_full, prefix) => `${prefix}_***REDACTED***`);
    out = out.replace(AZURE_SAS_SIG_RE, (_full, pre) => `${pre}***REDACTED***`);
    out = out.replace(ADO_PAT_SHAPE_RE, '***REDACTED-PAT***');
    out = out.replace(PASSWORD_ASSIGN_RE, (_full, pre, _val, post) => `${pre}***REDACTED***${post}`);
    return out;
}
