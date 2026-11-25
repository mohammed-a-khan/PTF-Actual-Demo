/**
 * Secret scanner — shared types.
 *
 * A Finding never carries the secret value to callers outside the scanner/fix pipeline:
 * `publicFinding()` strips it. Only the server-side scan cache keeps the raw value so a
 * fix action ("move to secret store", "remove") can act on the exact text.
 */

export type Confidence = 'high' | 'medium';

export interface RawFinding {
    /** Stable rule identifier, e.g. `github-token`. */
    ruleId: string;
    /** Human-readable type, e.g. "GitHub token". */
    type: string;
    /** Why it was flagged, in plain language. */
    reason: string;
    confidence: Confidence;
    /** Repository-relative path with forward slashes. */
    file: string;
    /** 1-based line number in the NEW version of the file (0 when the finding is about the file itself). */
    line: number;
    /** 1-based column of the value start (0 when unknown / file-level). */
    column: number;
    /** The matched secret value. Never leave the server. */
    value: string;
    /** sha256(ruleId \0 value) — used for allowlisting; never reversible for real secrets. */
    fingerprint: string;
    /** Secret-store name suggested from the key the value is assigned to (e.g. DB_PASSWORD). */
    suggestedName?: string;
}

export interface PublicFinding {
    id: string;
    ruleId: string;
    type: string;
    reason: string;
    confidence: Confidence;
    file: string;
    line: number;
    column: number;
    /** Masked preview such as `ab••••••yz`. */
    preview: string;
    fingerprint: string;
    suggestedName?: string;
}

/** A line of content to scan, with its location. */
export interface ScanLine {
    file: string;
    line: number;
    text: string;
}

export interface KnownSecret {
    /** Display name, e.g. `QA/DB_ORDERS_PASSWORD`. */
    name: string;
    value: string;
}

export interface ScanOptions {
    /** Values from the user's secret store; an exact occurrence is a high-confidence finding. */
    knownSecrets?: KnownSecret[];
    /** Findings the project has marked "not a secret". */
    allowlist?: AllowlistMatcher;
}

/** Decides whether a (rule, value) was marked "not a secret" — without storing the value. */
export interface AllowlistMatcher {
    size: number;
    has(ruleId: string, value: string, fingerprint: string): boolean;
}
