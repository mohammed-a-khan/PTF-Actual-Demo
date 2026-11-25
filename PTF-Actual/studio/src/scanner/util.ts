import { createHash, createHmac, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { studioHome } from '../core/paths';

/** Shannon entropy in bits per character. */
export function shannonEntropy(s: string): number {
    if (!s) return 0;
    const counts = new Map<string, number>();
    for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    let h = 0;
    const n = s.length;
    for (const c of counts.values()) {
        const p = c / n;
        h -= p * Math.log2(p);
    }
    return h;
}

/**
 * Key for fingerprints of flagged values: a per-user random key in the private Studio folder.
 * Fingerprints appear in API responses and in commit-override digests (also computed by the git
 * hook process, hence a stable key on disk); keyed, they cannot be used to guess a weak password
 * offline. Falls back to a per-process key if the folder is not writable.
 */
let fpKey: Buffer | null = null;
function fingerprintKey(): Buffer {
    if (fpKey) return fpKey;
    const f = path.join(studioHome(), 'keys', 'fingerprint.key');
    try {
        const k = fs.readFileSync(f);
        if (k.length === 32) return (fpKey = k);
    } catch { /* create below */ }
    const k = randomBytes(32);
    try {
        fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
        fs.writeFileSync(f, k, { mode: 0o600, flag: 'wx' });
        fpKey = k;
    } catch {
        try { const again = fs.readFileSync(f); fpKey = again.length === 32 ? again : k; } catch { fpKey = k; }
    }
    return fpKey;
}

export function fingerprint(ruleId: string, value: string): string {
    return createHmac('sha256', fingerprintKey()).update(ruleId).update('\0').update(value).digest('hex');
}

/** Unkeyed hash used by allowlist files written before keyed fingerprints. */
export function legacyFingerprint(ruleId: string, value: string): string {
    return createHash('sha256').update(ruleId).update('\0').update(value).digest('hex');
}

export function sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

/**
 * Mask a secret for display: keep at most 2 leading and 2 trailing characters, and only when
 * the value is long enough that this reveals little (>= 10 chars). Short values are fully masked.
 */
export function maskSecret(value: string): string {
    const v = value ?? '';
    if (v.length >= 10) return `${v.slice(0, 2)}${'•'.repeat(Math.min(8, v.length - 4))}${v.slice(-2)}`;
    return '•'.repeat(Math.max(4, Math.min(8, v.length)));
}

const PLACEHOLDER_PATTERNS: RegExp[] = [
    /^\$\{[^}]*\}$/, // ${VAR} / ${VAR:-default}
    /^\{\{[^}]*\}\}$/, // {{var}}
    /^\$\{\{[^}]*\}\}$/, // ${{ github/azure expressions }}
    /^\$\([^)]+\)$/, // $(Pipeline.Variable)
    /^#\{[^}]+\}#$/, // #{token-replace}#
    /^__[A-Z0-9_]+__$/i, // __TOKEN__
    /^\{(secret|config|env|scenario|context):[^}]+\}$/i, // framework references
    /^<[^>]+>$/, // <placeholder>
    /^%[A-Z0-9_]+%$/i, // %VAR%
    /^\$[A-Z_][A-Z0-9_]*$/i, // $VAR
    /^(\*+|x{3,}|•+|\.{3,}|-+)$/i,
    /^(changeme|change_me|password|passw0rd|pass|pw|pwd|passwd|secret|token|test|dummy|example|sample|placeholder|redacted|your[-_ ].*|my[-_ ].*|todo|tbd|none|null|undefined|true|false|string|number)$/i,
];

/** True when a value is obviously not a real secret (a reference, template or dummy word). */
export function isPlaceholder(value: string): boolean {
    const v = value.trim().replace(/^['"`]|['"`]$/g, '');
    if (v.length === 0) return true;
    return PLACEHOLDER_PATTERNS.some((re) => re.test(v));
}

/** Normalise a path to repository-relative forward-slash form. */
export function normPath(p: string): string {
    return p.replace(/\\/g, '/').replace(/^\.\//, '');
}
