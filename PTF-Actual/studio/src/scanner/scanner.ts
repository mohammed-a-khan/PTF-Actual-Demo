/**
 * Secret scanner core: scans lines of text and file paths and returns findings.
 * Pure functions — no I/O — so they are fast and fully unit-testable.
 */
import { CONTENT_RULES, FILE_RULES } from './rules';
import { AllowlistMatcher, KnownSecret, PublicFinding, RawFinding, ScanLine, ScanOptions } from './types';
import { fingerprint, maskSecret, normPath, sha256 } from './util';

/** Long lines (minified JSON, session dumps) are scanned in overlapping windows, never cut off. */
const WINDOW = 20_000;
const OVERLAP = 2_000;
/** Stored values shorter than this are too likely to be ordinary words ("admin") to flag everywhere. */
const MIN_KNOWN_SECRET = 6;
const INDICES = new WeakMap<RegExp, RegExp>();
/** The rule's regex with the `d` flag (match positions of named groups), compiled once. */
function withIndices(re: RegExp): RegExp {
    let r = INDICES.get(re);
    if (!r) { r = new RegExp(re.source, re.flags.includes('d') ? re.flags : re.flags + 'd'); INDICES.set(re, r); }
    return r;
}
const isWordChar = (c: string | undefined) => !!c && /[A-Za-z0-9_]/.test(c);

export function scanLines(lines: ScanLine[], opts: ScanOptions = {}): RawFinding[] {
    const out: RawFinding[] = [];
    const known = (opts.knownSecrets ?? []).filter((k) => k.value && k.value.length >= MIN_KNOWN_SECRET);

    for (const ln of lines) {
        const file = normPath(ln.file);
        const full = ln.text;

        // 1) Exact occurrences of the user's own stored secrets — strongest signal. Full line, and
        //    only as a whole token (a stored "Passw0rd1" inside "MyPassw0rd1x" is still flagged only
        //    when it is not part of a longer word).
        for (const k of known) {
            let from = 0;
            while (true) {
                const idx = full.indexOf(k.value, from);
                if (idx < 0) break;
                if (isWordChar(k.value[0]) && isWordChar(full[idx - 1]) || isWordChar(k.value[k.value.length - 1]) && isWordChar(full[idx + k.value.length])) { from = idx + 1; continue; }
                out.push(makeFinding({
                    ruleId: 'known-secret-value',
                    type: 'Stored secret value',
                    reason: `This is the value of your stored secret "${k.name}".`,
                    confidence: 'high',
                }, file, ln.line, idx + 1, k.value));
                out[out.length - 1].suggestedName = k.name.replace(/ \(.*\)$/, '');
                from = idx + k.value.length;
            }
        }

        // 2) Pattern rules, window by window.
        for (let start = 0; start < Math.max(1, full.length); start += WINDOW - OVERLAP) {
            const text = full.length > WINDOW ? full.slice(start, start + WINDOW) : full;
            for (const rule of CONTENT_RULES) {
                if (rule.fileFilter && !rule.fileFilter.test(file)) continue;
                const re = withIndices(rule.re);
                re.lastIndex = 0;
                let m: RegExpExecArray | null;
                while ((m = re.exec(text)) !== null) {
                    if (m[0].length === 0) { re.lastIndex++; continue; }
                    const v = m.groups?.v;
                    if (!v) continue;
                    if (rule.accept && !rule.accept(v, text)) continue;
                    // Exact position of the captured value (not the first occurrence of the same text:
                    // in https://admin:admin@host the password is the second "admin").
                    const at = (m as RegExpExecArray & { indices?: { groups?: Record<string, [number, number]> } }).indices?.groups?.v?.[0] ?? (m.index + m[0].indexOf(v));
                    const col = start + at + 1;
                    const f = makeFinding(rule, file, ln.line, col, v);
                    f.suggestedName = suggestName(full.slice(Math.max(0, col - 201), col - 1)); // the key is right before the value
                    out.push(f);
                }
            }
            if (full.length <= WINDOW) break;
        }
    }
    return filterAllowlisted(dedupe(out), opts.allowlist);
}

/** File-level rules (risky file types). `content` is optional text for content checks. */
export function scanPath(path: string, content: string | undefined, opts: ScanOptions = {}): RawFinding[] {
    const file = normPath(path);
    const out: RawFinding[] = [];
    for (const rule of FILE_RULES) {
        if (!rule.re.test(file)) continue;
        if (rule.contentCheck && (content === undefined || !rule.contentCheck(content))) continue;
        // The "value" of a file-level finding is the path itself (fingerprint is path-based).
        out.push(makeFinding(rule, file, 0, 0, file));
    }
    return filterAllowlisted(out, opts.allowlist);
}

function makeFinding(
    rule: { id?: string; ruleId?: string; type: string; reason: string; confidence: 'high' | 'medium' },
    file: string, line: number, column: number, value: string,
): RawFinding {
    const ruleId = (rule.ruleId ?? rule.id)!;
    return { ruleId, type: rule.type, reason: rule.reason, confidence: rule.confidence, file, line, column, value, fingerprint: fingerprint(ruleId, value) };
}

/**
 * The same value on the same line can match several rules (e.g. a stored secret that is also a
 * GitHub token). Keep one finding per (file, line, value): the first in priority order — known
 * secrets, then specific rules (rule order), then generic ones.
 */
function dedupe(findings: RawFinding[]): RawFinding[] {
    const seen = new Set<string>();
    const out: RawFinding[] = [];
    for (const f of findings) {
        const key = `${f.file}\0${f.line}\0${f.column}\0${f.value}`;
        if (seen.has(key)) continue;
        // A value contained inside an already-reported longer value on the same line is redundant.
        if (out.some((o) => o.file === f.file && o.line === f.line && o.value.includes(f.value))) continue;
        seen.add(key);
        out.push(f);
    }
    return out;
}

function filterAllowlisted(findings: RawFinding[], allowlist?: AllowlistMatcher): RawFinding[] {
    if (!allowlist || allowlist.size === 0) return findings;
    return findings.filter((f) => f.ruleId === 'known-secret-value' || !allowlist.has(f.ruleId, f.value, f.fingerprint));
}

/** Strip the raw value; produce what the UI / CLI may show. */
export function toPublic(f: RawFinding, id: string): PublicFinding {
    return {
        id, ruleId: f.ruleId, type: f.type, reason: f.reason, confidence: f.confidence,
        file: f.file, line: f.line, column: f.column,
        preview: f.line === 0 ? f.file : maskSecret(f.value),
        fingerprint: f.fingerprint,
        suggestedName: f.suggestedName,
    };
}

/**
 * Secret-store name from the text before the value: `DB_PASSWORD=` → DB_PASSWORD,
 * `"apiKey": "` → API_KEY, `password: '` → PASSWORD. Undefined when there is no key.
 */
export function suggestName(before: string): string | undefined {
    const m = /([A-Za-z_][A-Za-z0-9_.-]*)["'`]?\s*[:=]\s*["'`]?$/.exec(before.trimEnd() === before ? before : before.trimEnd() + ' ');
    if (!m) return undefined;
    const name = m[1]
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/[^A-Za-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .toUpperCase();
    return /^[A-Z][A-Z0-9_]{0,63}$/.test(name) ? name : undefined;
}

/** Hash used to bind an override to the exact content that was reviewed. */
export function findingsDigest(findings: RawFinding[]): string {
    return sha256(findings.map((f) => `${f.fingerprint}@${f.file}:${f.line}`).sort().join('\n'));
}

export type { KnownSecret };
