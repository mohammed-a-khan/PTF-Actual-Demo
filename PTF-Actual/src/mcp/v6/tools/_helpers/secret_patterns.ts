/**
 * Named secret-shape detectors used by cs_qa_gov_secret_scanner and the
 * cs_qa_gov_code_mutation_audit rules. Every pattern carries:
 *  - kind: short stable id for reporters
 *  - severity: 'error' | 'warn' (error = block, warn = surface)
 *  - description: human phrase for the report card
 *  - re: RegExp (with /g so scanners can iterate matches)
 *
 * The library is intentionally conservative to keep false positives low —
 * anchored prefixes (AKIA, ghp_, xoxb-, …) and length bounds are preferred
 * over "looks like a token" heuristics.
 *
 * NOTE: nothing here mentions any consumer project or brand. Every pattern
 * is a public secret shape published by AWS / Azure / GitHub / Google / Slack.
 */

export type SecretSeverity = 'error' | 'warn';

export interface SecretPattern {
    kind: string;
    severity: SecretSeverity;
    description: string;
    re: RegExp;
    /** Return the confidence bucket used in the report. */
    confidence: 'high' | 'medium';
    /** Optional filter — only match when file path matches (or does NOT match). */
    onlyInFiles?: RegExp;
    /** Optional filter — skip when file path matches. */
    ignoreInFiles?: RegExp;
}

export const SECRET_PATTERNS: SecretPattern[] = [
    // AWS ------------------------------------------------------------------
    {
        kind: 'aws-access-key-id',
        severity: 'error',
        description: 'AWS Access Key ID (AKIA / ASIA prefix + 16 base32)',
        re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g,
        confidence: 'high',
    },
    {
        kind: 'aws-secret-access-key',
        severity: 'error',
        description: 'AWS secret access key assignment',
        re: /aws_secret_access_key\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})["']?/gi,
        confidence: 'high',
    },
    // Azure ---------------------------------------------------------------
    {
        kind: 'azure-sas-signature',
        severity: 'error',
        description: 'Azure SAS token (sig= query parameter)',
        re: /[?&]sig=[A-Za-z0-9%+/=_-]{20,}/g,
        confidence: 'high',
    },
    {
        kind: 'azure-storage-connection',
        severity: 'error',
        description: 'Azure storage connection string with account key',
        re: /DefaultEndpointsProtocol=https?;AccountName=[^;]+;AccountKey=[A-Za-z0-9+/=]{20,}/g,
        confidence: 'high',
    },
    // ADO PAT (52-char alphanum) — high confidence with a context word. The
    // context keyword may be followed by a closing JSON key-quote before the
    // colon (e.g. `"personalAccessToken":`) hence the ["']? after the keyword.
    {
        kind: 'ado-pat-in-context',
        severity: 'error',
        description: 'Azure DevOps PAT (52-char) assigned to a pat/token/authorization field',
        re: /(?:personalAccessToken|pat|token|authorization)["']?\s*[:=]\s*["']([A-Za-z0-9]{52})["']/gi,
        confidence: 'high',
    },
    {
        kind: 'ado-pat-bare',
        severity: 'warn',
        description: 'Bare 52-char alphanum string (ADO PAT shape) — may be a false positive',
        re: /\b[a-z2-7]{52}\b/g,
        confidence: 'medium',
        // Only surface bare-shape matches in JSON/env/yaml/ts config; skip source noise.
        onlyInFiles: /\.(json|env|ya?ml|ts|tsx|js|properties)$/i,
        ignoreInFiles: /(?:^|[\\/])(?:node_modules|dist|coverage|\.git)[\\/]/,
    },
    // GitHub ---------------------------------------------------------------
    {
        kind: 'github-pat',
        severity: 'error',
        description: 'GitHub PAT (ghp_ / gho_ / ghu_ / ghs_ / ghr_ prefix)',
        re: /\b(gh[pousr])_[A-Za-z0-9_]{20,}\b/g,
        confidence: 'high',
    },
    // Slack ----------------------------------------------------------------
    {
        kind: 'slack-token',
        severity: 'error',
        description: 'Slack token (xox[bpoas]- prefix)',
        re: /\bxox[bpoas]-[A-Za-z0-9-]{10,}\b/g,
        confidence: 'high',
    },
    // Google API key --------------------------------------------------------
    {
        kind: 'google-api-key',
        severity: 'error',
        description: 'Google API key (AIza prefix)',
        re: /\bAIza[0-9A-Za-z\-_]{35}\b/g,
        confidence: 'high',
    },
    // JWT ------------------------------------------------------------------
    {
        kind: 'jwt-bearer',
        severity: 'warn',
        description: 'JWT-shaped token (header.payload.signature)',
        re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
        confidence: 'medium',
    },
    // Bearer authorization header ------------------------------------------
    {
        kind: 'bearer-authorization',
        severity: 'warn',
        description: 'Bearer authorization header with an opaque token',
        re: /Authorization\s*:\s*Bearer\s+[A-Za-z0-9\-_.~+/=]{20,}/gi,
        confidence: 'high',
    },
    // Private keys ---------------------------------------------------------
    {
        kind: 'private-key-block',
        severity: 'error',
        description: 'PEM-encoded private key block',
        re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
        confidence: 'high',
    },
    // Password assignment (last — highest FP risk) --------------------------
    // NOTE: test/tests/__tests__/specs are the primary target of this scanner —
    // this IS the QA framework and its consumer test artefacts. Do NOT ignore
    // those directories. FP control comes from the placeholder skip list below
    // (CHANGE_ME / *** / xxx / empty / <angle-brackets>).
    {
        kind: 'password-assignment',
        severity: 'warn',
        description: 'password= / passwd= / pwd= assignment with a literal',
        re: /(?<![A-Za-z0-9_])(?:password|passwd|pwd)\s*[:=]\s*["']([^"']{4,})["']/gi,
        confidence: 'medium',
        ignoreInFiles: /(?:^|[\\/])(?:node_modules|dist|coverage|\.git)[\\/]/,
    },
];

/**
 * Placeholder values that a password= assignment may hold in template / example
 * / test fixture files — treat as non-secrets.
 */
const PASSWORD_PLACEHOLDER_RE = /^(?:CHANGE_?ME|CHANGEME|TODO|FIXME|xxx+|\*+|\.+|-+|_+|<[^>]*>|\$\{[^}]+\}|placeholder|example|dummy|sample|test|redacted|hidden)$/i;

function isPasswordPlaceholder(value: string): boolean {
    if (!value) return true;
    if (PASSWORD_PLACEHOLDER_RE.test(value.trim())) return true;
    // Repeated single char (xxx, ****) of any length.
    if (/^(.)\1+$/.test(value)) return true;
    return false;
}

export interface SecretHit {
    file: string;
    line: number;
    column: number;
    kind: string;
    severity: SecretSeverity;
    description: string;
    confidence: 'high' | 'medium';
    /** Matched value with the middle redacted so nobody re-leaks it in reports. */
    redactedMatch: string;
}

export function redactMatch(matched: string): string {
    if (matched.length <= 8) return '***';
    return `${matched.slice(0, 3)}***${matched.slice(-3)}`;
}

/**
 * Scan a single text buffer for every configured pattern. `filePath` is used
 * for onlyInFiles / ignoreInFiles filtering AND for the returned hit rows.
 */
export function scanTextForSecrets(filePath: string, content: string, patterns: SecretPattern[] = SECRET_PATTERNS): SecretHit[] {
    const hits: SecretHit[] = [];
    const lines = content.split(/\r?\n/);
    for (const pat of patterns) {
        if (pat.onlyInFiles && !pat.onlyInFiles.test(filePath)) continue;
        if (pat.ignoreInFiles && pat.ignoreInFiles.test(filePath)) continue;
        // Reset lastIndex — patterns are shared instances.
        pat.re.lastIndex = 0;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            let m: RegExpExecArray | null;
            const localRe = new RegExp(pat.re.source, pat.re.flags.includes('g') ? pat.re.flags : `${pat.re.flags}g`);
            while ((m = localRe.exec(line)) !== null) {
                // Placeholder skip for password-assignment (CHANGE_ME, ***, xxx, etc.).
                if (pat.kind === 'password-assignment' && m[1] && isPasswordPlaceholder(m[1])) {
                    if (m.index === localRe.lastIndex) localRe.lastIndex++;
                    continue;
                }
                hits.push({
                    file: filePath,
                    line: i + 1,
                    column: m.index + 1,
                    kind: pat.kind,
                    severity: pat.severity,
                    description: pat.description,
                    confidence: pat.confidence,
                    redactedMatch: redactMatch(m[0]),
                });
                // Guard against zero-length matches (would infinite-loop otherwise).
                if (m.index === localRe.lastIndex) localRe.lastIndex++;
            }
        }
    }
    return hits;
}
