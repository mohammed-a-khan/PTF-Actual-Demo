/**
 * Project allowlist of findings marked "not a secret". Stored in the repository at
 * `.cs-studio/secret-allowlist.json` so the whole team benefits once it is committed.
 *
 * The flagged value is never stored. Each entry holds scrypt(salt, rule + value) with a random
 * per-repository salt, so a committed allowlist cannot be used to guess a weak password quickly.
 * Entries written by earlier versions (unsalted sha256 `fingerprint`) are still honoured.
 */
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes, scryptSync } from 'crypto';
import { AllowlistMatcher } from './types';
import { fingerprint, legacyFingerprint } from './util';
import { UserError } from '../core/errors';
import { safeRepoPath, writeFileInRepo } from '../core/safePath';

export interface AllowlistEntry {
    /** scrypt hash (version 2). */
    hash?: string;
    /** Legacy unsalted fingerprint (version 1). */
    fingerprint?: string;
    ruleId: string;
    file: string;
    reason: string;
    addedBy: string;
    addedAt: string;
}

export interface AllowlistFile {
    version: 2;
    salt: string;
    entries: AllowlistEntry[];
}

export const ALLOWLIST_PATH = '.cs-studio/secret-allowlist.json';
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

const hashOf = (salt: string, ruleId: string, value: string) =>
    scryptSync(`${ruleId}\0${value}`, Buffer.from(salt, 'hex'), 32, SCRYPT).toString('hex');

export function readAllowlist(repoRoot: string): AllowlistFile {
    const p = path.join(repoRoot, ALLOWLIST_PATH);
    try {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (data && Array.isArray(data.entries)) {
            const entries = data.entries.filter((e: AllowlistEntry) => !!e && (/^[0-9a-f]{64}$/.test(e.hash ?? '') || /^[0-9a-f]{64}$/.test(e.fingerprint ?? '')));
            const salt = typeof data.salt === 'string' && /^[0-9a-f]{32}$/.test(data.salt) ? data.salt : randomBytes(16).toString('hex');
            return { version: 2, salt, entries };
        }
    } catch {
        /* missing or invalid file → empty allowlist */
    }
    return { version: 2, salt: randomBytes(16).toString('hex'), entries: [] };
}

/** Matcher for scanning; hashes are cached per value for the life of the process. */
export function allowlistSet(repoRoot: string): AllowlistMatcher {
    const a = readAllowlist(repoRoot);
    const hashes = new Set(a.entries.map((e) => e.hash).filter((x): x is string => !!x));
    const legacy = new Set(a.entries.map((e) => e.fingerprint).filter((x): x is string => !!x));
    const cache = new Map<string, boolean>();
    return {
        size: a.entries.length,
        has(ruleId, value, fp) {
            if (a.entries.length === 0) return false;
            if (legacy.size && (legacy.has(fp) || legacy.has(legacyFingerprint(ruleId, value)))) return true;
            if (!hashes.size) return false;
            const k = `${ruleId}\0${value}`;
            if (!cache.has(k)) cache.set(k, hashes.has(hashOf(a.salt, ruleId, value)));
            return cache.get(k)!;
        },
    };
}

/** Mark (rule, value) as "not a secret". Stored values of the user's own secrets cannot be. */
export function addToAllowlist(repoRoot: string, entry: { ruleId: string; value?: string; fingerprint?: string; file: string; reason: string; addedBy: string; addedAt: string }): void {
    if (entry.ruleId === 'known-secret-value') throw new UserError('This is the value of one of your stored secrets, so it cannot be marked as "not a secret". Remove it from the file instead.');
    const current = readAllowlist(repoRoot);
    let stored: AllowlistEntry;
    if (entry.value !== undefined) {
        const hash = hashOf(current.salt, entry.ruleId, entry.value);
        if (current.entries.some((e) => e.hash === hash)) return;
        stored = { hash, ruleId: entry.ruleId, file: entry.file, reason: entry.reason, addedBy: entry.addedBy, addedAt: entry.addedAt };
    } else if (entry.fingerprint && /^[0-9a-f]{64}$/.test(entry.fingerprint)) {
        if (current.entries.some((e) => e.fingerprint === entry.fingerprint)) return;
        stored = { fingerprint: entry.fingerprint, ruleId: entry.ruleId, file: entry.file, reason: entry.reason, addedBy: entry.addedBy, addedAt: entry.addedAt };
    } else throw new UserError('Nothing to add to the allowlist.');
    current.entries.push(stored);
    const p = safeRepoPath(repoRoot, ALLOWLIST_PATH, { write: true });
    fs.mkdirSync(path.dirname(p), { recursive: true });
    writeFileInRepo(p, JSON.stringify(current, null, 2) + '\n');
}

export { fingerprint };
