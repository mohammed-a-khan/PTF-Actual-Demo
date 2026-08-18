/**
 * On-disk governance config helpers.
 *
 * The Phase E tools store their state under `<workspaceRoot>/.cs-qa/gov/`.
 * Each helper is defensive: a missing directory is created; a missing file is
 * treated as an empty policy (never throws), and a corrupt file surfaces a
 * warning but still returns a safe default so callers can proceed.
 *
 * File layout:
 *   .cs-qa/gov/attachment-blocklist.json   → { hashes: [ { sha256, note?, addedAt? } ] }
 *   .cs-qa/gov/ado-policies.json           → { requiredTagsPerArea, minSeverityForBlocker, ... }
 *   .cs-qa/gov/pat-history.json            → { pats: [ { id, scope, createdAt, lastRotatedAt, expiresAt?, notes? } ] }
 */

import * as fs from 'fs';
import * as path from 'path';

export const GOV_DIR = '.cs-qa/gov';
export const ATTACHMENT_BLOCKLIST_FILE = 'attachment-blocklist.json';
export const ADO_POLICIES_FILE = 'ado-policies.json';
export const PAT_HISTORY_FILE = 'pat-history.json';

export function govDir(workspaceRoot: string): string {
    return path.join(workspaceRoot, GOV_DIR);
}

export function ensureGovDir(workspaceRoot: string): string {
    const d = govDir(workspaceRoot);
    try { fs.mkdirSync(d, { recursive: true }); } catch { /* best effort */ }
    return d;
}

function readJsonSafe<T>(filePath: string, fallback: T): { value: T; warning?: string; existed: boolean } {
    if (!fs.existsSync(filePath)) return { value: fallback, existed: false };
    try {
        const text = fs.readFileSync(filePath, 'utf-8');
        if (!text.trim()) return { value: fallback, existed: true };
        return { value: JSON.parse(text) as T, existed: true };
    } catch (e) {
        return { value: fallback, existed: true, warning: `${filePath} exists but is not valid JSON — ${(e as Error).message}. Falling back to empty policy.` };
    }
}

// ---------------------------------------------------------------------------
// Attachment blocklist
// ---------------------------------------------------------------------------

export interface AttachmentBlocklistEntry {
    sha256: string;
    note?: string;
    addedAt?: string;
}

export interface AttachmentBlocklist {
    hashes: AttachmentBlocklistEntry[];
}

export function loadAttachmentBlocklist(workspaceRoot: string): { blocklist: AttachmentBlocklist; warning?: string; path: string; existed: boolean } {
    const p = path.join(govDir(workspaceRoot), ATTACHMENT_BLOCKLIST_FILE);
    const { value, warning, existed } = readJsonSafe<AttachmentBlocklist>(p, { hashes: [] });
    // Defensive normalisation.
    const hashes = Array.isArray(value?.hashes) ? value.hashes.filter((h) => h && typeof h.sha256 === 'string' && h.sha256.length === 64) : [];
    return { blocklist: { hashes }, warning, path: p, existed };
}

export function ensureAttachmentBlocklistFile(workspaceRoot: string): string {
    ensureGovDir(workspaceRoot);
    const p = path.join(govDir(workspaceRoot), ATTACHMENT_BLOCKLIST_FILE);
    if (!fs.existsSync(p)) {
        fs.writeFileSync(p, JSON.stringify({ hashes: [], _note: 'Add { sha256, note?, addedAt? } entries to block matching attachments during cs_qa_gov_attachment_audit.' }, null, 2));
    }
    return p;
}

// ---------------------------------------------------------------------------
// ADO policies
// ---------------------------------------------------------------------------

export interface AdoPolicyConfig {
    requiredTagsPerArea?: Array<{ areaPathContains: string; requiredTags: string[] }>;
    minSeverityForBlocker?: '1 - Critical' | '2 - High' | '3 - Medium' | '4 - Low';
    forbiddenStateTransitions?: Array<{ from: string; to: string; reason?: string }>;
    requiredLinkedStoryForTc?: boolean;
    minReproStepsForBug?: number;
    maxTitleLength?: number;
    /** Tags that MUST NOT appear (e.g. 'do-not-ship'). */
    forbiddenTags?: string[];
    /** WI types that require an assignedTo before create. */
    requireAssignedToForTypes?: string[];
}

export function loadAdoPolicies(workspaceRoot: string): { policies: AdoPolicyConfig; warning?: string; path: string; existed: boolean } {
    const p = path.join(govDir(workspaceRoot), ADO_POLICIES_FILE);
    const { value, warning, existed } = readJsonSafe<AdoPolicyConfig>(p, {});
    return { policies: value ?? {}, warning, path: p, existed };
}

export function ensureAdoPoliciesFile(workspaceRoot: string): string {
    ensureGovDir(workspaceRoot);
    const p = path.join(govDir(workspaceRoot), ADO_POLICIES_FILE);
    if (!fs.existsSync(p)) {
        const sample: AdoPolicyConfig & { _note?: string } = {
            _note: 'Edit these values to enforce ADO write governance. Consumed by cs_qa_gov_ado_policy_guard.',
            requiredTagsPerArea: [],
            minReproStepsForBug: 20,
            requiredLinkedStoryForTc: false,
            forbiddenTags: [],
            forbiddenStateTransitions: [
                { from: 'Closed', to: 'Active', reason: 'Re-opening closed work items requires PM sign-off.' },
            ],
        };
        fs.writeFileSync(p, JSON.stringify(sample, null, 2));
    }
    return p;
}

// ---------------------------------------------------------------------------
// PAT history (rotation tracker)
// ---------------------------------------------------------------------------

export interface PatHistoryEntry {
    /** Human-readable identifier (e.g. "ado-pat-ci", "ado-pat-alice"). Never the PAT itself. */
    id: string;
    /** Scope tag — 'read', 'read-write', 'full-access', etc. Descriptive only. */
    scope: string;
    /** ISO string. */
    createdAt: string;
    /** ISO string of the most recent rotation. */
    lastRotatedAt: string;
    /** Optional ISO string of the expiry set at ADO issuance time. */
    expiresAt?: string;
    /** Free-form note (owner, purpose, host). Never the token. */
    notes?: string;
}

export interface PatHistory {
    pats: PatHistoryEntry[];
    /** ISO timestamp when the file itself was last touched. */
    updatedAt?: string;
}

export function loadPatHistory(workspaceRoot: string): { history: PatHistory; warning?: string; path: string; existed: boolean } {
    const p = path.join(govDir(workspaceRoot), PAT_HISTORY_FILE);
    const { value, warning, existed } = readJsonSafe<PatHistory>(p, { pats: [] });
    const pats = Array.isArray(value?.pats)
        ? value.pats.filter((entry) => entry && typeof entry.id === 'string' && typeof entry.lastRotatedAt === 'string')
        : [];
    return { history: { pats, updatedAt: value?.updatedAt }, warning, path: p, existed };
}

export function ensurePatHistoryFile(workspaceRoot: string): string {
    ensureGovDir(workspaceRoot);
    const p = path.join(govDir(workspaceRoot), PAT_HISTORY_FILE);
    if (!fs.existsSync(p)) {
        fs.writeFileSync(p, JSON.stringify({
            pats: [],
            _note: 'Add { id, scope, createdAt, lastRotatedAt, expiresAt?, notes? } per PAT. Consumed by cs_qa_gov_pat_rotation_reminder. NEVER store the PAT itself here — only metadata.',
        }, null, 2));
    }
    return p;
}

/**
 * Atomic file write. Write to `<p>.tmp` then rename over the destination —
 * survives POSIX and Windows without a partial-write window. If the destination
 * lives on a different filesystem the rename can EXDEV — fall back to a
 * write-then-swap on the same filesystem (best-effort).
 */
function atomicWrite(p: string, contents: string): void {
    const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, contents);
    try {
        fs.renameSync(tmp, p);
    } catch (e) {
        // EXDEV / EBUSY on Windows can happen; fall back to overwrite + unlink.
        try {
            fs.writeFileSync(p, contents);
            try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
        } catch {
            throw e;
        }
    }
}

export function writePatHistory(workspaceRoot: string, history: PatHistory): string {
    ensureGovDir(workspaceRoot);
    const p = path.join(govDir(workspaceRoot), PAT_HISTORY_FILE);
    atomicWrite(p, JSON.stringify({ ...history, updatedAt: new Date().toISOString() }, null, 2));
    return p;
}

export function writeAttachmentBlocklist(workspaceRoot: string, blocklist: AttachmentBlocklist): string {
    ensureGovDir(workspaceRoot);
    const p = path.join(govDir(workspaceRoot), ATTACHMENT_BLOCKLIST_FILE);
    atomicWrite(p, JSON.stringify(blocklist, null, 2));
    return p;
}

export function writeAdoPolicies(workspaceRoot: string, policies: AdoPolicyConfig): string {
    ensureGovDir(workspaceRoot);
    const p = path.join(govDir(workspaceRoot), ADO_POLICIES_FILE);
    atomicWrite(p, JSON.stringify(policies, null, 2));
    return p;
}
