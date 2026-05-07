/**
 * Agentic Test Platform — PII / Secret Sanitizer
 *
 * Scans content at trust boundaries (inbound user prompts, outbound LLM
 * sampling, outbound ADO write-back). Picks a policy per boundary:
 *
 *   redact               — replace matches with <REDACTED:TYPE> tokens;
 *                          decision='REDACTED' if any matched, 'PASSED'
 *                          if none did. Use for outbound LLM sampling
 *                          where the model should see neither PII nor
 *                          secrets.
 *   reject               — refuse the call on any match (PII or secret).
 *                          decision='REJECTED'. Strict; rarely the right
 *                          choice for inbound prompts because legitimate
 *                          test fixture data trips PII patterns.
 *   reject_secrets_only  — reject only on SECRET matches; PII passes
 *                          through unchanged. Use for inbound user
 *                          prompts where test fixture identifiers
 *                          (emails, account numbers, dates) are normal
 *                          but real API keys / PATs are not.
 *
 * Patterns are intentionally generic — emails, SSNs, credit-card-like
 * digit runs, common API key prefixes, bearer tokens, connection strings.
 * No domain or organization-specific patterns are baked in.
 *
 * @module agent-platform/CSPiiSanitizer
 */

// ============================================================================
// Types
// ============================================================================

/**
 * One violation kind detected in the input. `pattern` is a short label
 * naming the matched pattern (e.g. 'email', 'ssn'). `count` is the number
 * of matches in the input.
 */
export interface SanitizationViolation {
    type: 'PII' | 'SECRET';
    pattern: string;
    count: number;
}

/**
 * Result of a sanitize call. `cleaned` is the redacted text (always
 * present). `decision` reflects what the caller should do.
 */
export interface SanitizationResult {
    cleaned: string;
    violations: SanitizationViolation[];
    decision: 'PASSED' | 'REDACTED' | 'REJECTED';
}

// ============================================================================
// Pattern Catalog
// ============================================================================

interface PatternDef {
    label: string;
    type: 'PII' | 'SECRET';
    regex: RegExp;
}

const PATTERNS: PatternDef[] = [
    // ----- PII -----------------------------------------------------------
    {
        label: 'email',
        type: 'PII',
        regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    },
    {
        label: 'ssn',
        type: 'PII',
        regex: /\b\d{3}-?\d{2}-?\d{4}\b/g,
    },
    {
        label: 'credit_card',
        type: 'PII',
        // 13–16 digit run, possibly separated by spaces or dashes.
        regex: /\b(?:\d[ -]?){13,16}\b/g,
    },
    {
        label: 'phone_intl',
        type: 'PII',
        // +CC (XXX) XXX-XXXX or +CC XXXXXXXXXX. Conservative.
        regex: /\+\d{1,3}[\s-]?\(?\d{2,4}\)?[\s-]?\d{3,4}[\s-]?\d{3,4}\b/g,
    },
    {
        label: 'phone_us',
        type: 'PII',
        regex: /\b\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g,
    },
    {
        label: 'dob_like',
        type: 'PII',
        // ISO yyyy-mm-dd or mm/dd/yyyy in a 1900–2099 year range.
        regex: /\b(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])\b|\b(?:0[1-9]|1[0-2])\/(?:0[1-9]|[12]\d|3[01])\/(?:19|20)\d{2}\b/g,
    },

    // ----- SECRETS -------------------------------------------------------
    {
        label: 'openai_key',
        type: 'SECRET',
        regex: /\bsk-[A-Za-z0-9]{20,}\b/g,
    },
    {
        label: 'anthropic_key',
        type: 'SECRET',
        regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    },
    {
        label: 'aws_access_key',
        type: 'SECRET',
        regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    },
    {
        label: 'google_api_key',
        type: 'SECRET',
        regex: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    },
    {
        label: 'gitlab_pat',
        type: 'SECRET',
        regex: /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
    },
    {
        label: 'github_pat',
        type: 'SECRET',
        regex: /\bghp_[A-Za-z0-9]{30,}\b/g,
    },
    {
        label: 'github_oauth',
        type: 'SECRET',
        regex: /\bgho_[A-Za-z0-9]{30,}\b/g,
    },
    {
        label: 'slack_token',
        type: 'SECRET',
        regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    },
    {
        label: 'bearer_token',
        type: 'SECRET',
        regex: /\bBearer\s+[A-Za-z0-9._\-+/=]{16,}\b/g,
    },
    {
        label: 'jwt',
        type: 'SECRET',
        regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    },
    {
        label: 'connection_string',
        type: 'SECRET',
        // Generic conn string with embedded password=...
        regex: /\b(?:Server|Data Source|Host)\s*=\s*[^;]+;[^;]*(?:Password|Pwd)\s*=\s*[^;]+/gi,
    },
    {
        label: 'private_key_block',
        type: 'SECRET',
        regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PRIVATE )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PRIVATE )?PRIVATE KEY-----/g,
    },
];

// ============================================================================
// CSPiiSanitizer
// ============================================================================

/**
 * Static sanitizer. Single public entry point: `sanitize`.
 */
export class CSPiiSanitizer {
    /**
     * Scan and (optionally) redact the given content.
     *
     * @param content  Text to scan
     * @param mode     `'redact'` (default) replaces every match and returns
     *                 decision='REDACTED' if any matched, else 'PASSED'.
     *                 `'reject'` returns decision='REJECTED' on any match
     *                 (PII or SECRET) without modifying the content.
     *                 `'reject_secrets_only'` rejects only when a SECRET
     *                 pattern matches; PII matches pass through unchanged.
     *                 Recommended for inbound user prompts where legitimate
     *                 test fixture data (emails, account numbers, dates)
     *                 must be allowed.
     */
    public static sanitize(
        content: string,
        mode: 'redact' | 'reject' | 'reject_secrets_only' = 'redact',
    ): SanitizationResult {
        const violations: SanitizationViolation[] = [];
        let cleaned = content ?? '';

        for (const def of PATTERNS) {
            const re = new RegExp(def.regex.source, def.regex.flags);
            const matches = cleaned.match(re);
            const count = matches ? matches.length : 0;
            if (count === 0) continue;

            violations.push({ type: def.type, pattern: def.label, count });

            if (mode === 'redact') {
                cleaned = cleaned.replace(
                    new RegExp(def.regex.source, def.regex.flags),
                    `<REDACTED:${def.label.toUpperCase()}>`,
                );
            }
        }

        if (violations.length === 0) {
            return { cleaned, violations, decision: 'PASSED' };
        }

        if (mode === 'reject') {
            return {
                cleaned: content ?? '',
                violations,
                decision: 'REJECTED',
            };
        }

        if (mode === 'reject_secrets_only') {
            const hasSecret = violations.some((v) => v.type === 'SECRET');
            if (hasSecret) {
                // Surface only the SECRET violations to the caller — they
                // are the actionable ones. PII matches are intentionally
                // omitted so the user is not nagged about test data.
                return {
                    cleaned: content ?? '',
                    violations: violations.filter((v) => v.type === 'SECRET'),
                    decision: 'REJECTED',
                };
            }
            // No secrets — pass the original content through untouched.
            return {
                cleaned: content ?? '',
                violations: [],
                decision: 'PASSED',
            };
        }

        return { cleaned, violations, decision: 'REDACTED' };
    }

    /**
     * Convenience: returns true iff sanitize would produce any violations.
     */
    public static containsSensitive(content: string): boolean {
        for (const def of PATTERNS) {
            const re = new RegExp(def.regex.source, def.regex.flags);
            if (re.test(content)) return true;
        }
        return false;
    }
}
