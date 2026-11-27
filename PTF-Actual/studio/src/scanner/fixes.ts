/**
 * One-click fixes for secret-scan findings in the staged changes.
 *
 *   moveToStore   – save the value in the user's secret store and replace it in the file with a
 *                   reference the framework resolves at run time; restage the file.
 *   removeValue   – blank the value in the file and restage it.
 *   unstageFile   – take the file out of this commit.
 *   ignoreFile    – unstage it and add it to .gitignore (risky files: .env.local, .har, keys ...).
 *   allowlist     – record "not a secret" (salted hash only, never the value) in the project allowlist.
 *
 * Every fix works on the exact finding the user saw (matched by its fingerprint, file and line)
 * and refuses to act if the file changed underneath.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { GitService } from '../git/service';
import { runGit } from '../git/run';
import { addToAllowlist } from './allowlist';
import { safeRepoPath, writeFileInRepo } from '../core/safePath';
import { RawFinding } from './types';
import { SecretStore } from '../secrets/store';
import { UserError } from '../core/errors';

export interface FindingRef {
    fingerprint: string;
    file: string;
    line: number;
}

const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs)$/i;

/** The text that replaces a secret value in a file. */
export function replacementFor(file: string, name: string, lineText: string, column: number, value: string): { start: number; end: number; text: string } {
    const start = column - 1;
    const end = start + value.length;
    if (CODE_FILE.test(file)) {
        // In code, swap the whole quoted literal for an environment variable read.
        const q = lineText[start - 1];
        if ((q === '"' || q === "'" || q === '`') && lineText[end] === q) {
            return { start: start - 1, end: end + 1, text: `(process.env.${name} ?? '')` };
        }
    }
    // Config, .env, JSON, YAML, feature files: the framework interpolates {env:NAME}.
    return { start, end, text: `{env:${name}}` };
}

async function findRaw(git: GitService, ref: FindingRef): Promise<RawFinding> {
    const { raw } = await git.scanStaged();
    const f = raw.find((r) => r.fingerprint === ref.fingerprint && r.file === ref.file && r.line === ref.line);
    if (!f) throw new UserError('This finding is no longer in the staged changes. Scan again.');
    return f;
}

async function editLine(git: GitService, f: RawFinding, edit: (lineText: string) => string): Promise<void> {
    if (f.line < 1) throw new UserError('This finding is about the whole file; choose "Unstage" or "Ignore file" instead.');
    git.safePath(f.file);
    const abs = safeRepoPath(git.repoRoot, f.file, { write: true });
    // The fix must apply to what is staged; refuse if the working copy differs for this file.
    const dirty = await runGit(['diff', '--quiet', '--', f.file], { cwd: git.repoRoot, allowFailure: true, env: { GIT_LITERAL_PATHSPECS: '1' } });
    if (dirty.code !== 0) throw new UserError(`${f.file} has unstaged edits. Stage or discard them first so the fix applies to exactly what you are committing.`);
    const original = fs.readFileSync(abs, 'utf8');
    const eol = original.includes('\r\n') ? '\r\n' : '\n';
    const lines = original.split(/\r?\n/);
    const lineText = lines[f.line - 1];
    if (lineText === undefined || lineText.substr(f.column - 1, f.value.length) !== f.value) {
        throw new UserError(`${f.file}:${f.line} changed since the scan. Scan again.`);
    }
    lines[f.line - 1] = edit(lineText);
    writeFileInRepo(abs, lines.join(eol));
    await git.stage([f.file]);
}

export async function moveToStore(git: GitService, store: SecretStore, ref: FindingRef, target: { name: string; project?: string; env?: string }): Promise<{ replacedWith: string }> {
    SecretStore.validate(target);
    const f = await findRaw(git, ref);
    let replacedWith = '';
    await editLine(git, f, (lineText) => {
        const r = replacementFor(f.file, target.name, lineText, f.column, f.value);
        replacedWith = r.text;
        return lineText.slice(0, r.start) + r.text + lineText.slice(r.end);
    });
    // Store only after the file edit succeeded; a failed edit must not leave a half-done fix.
    store.set(target, f.value);
    return { replacedWith };
}

export async function removeValue(git: GitService, ref: FindingRef): Promise<void> {
    const f = await findRaw(git, ref);
    await editLine(git, f, (lineText) => lineText.slice(0, f.column - 1) + lineText.slice(f.column - 1 + f.value.length));
}

export async function unstageFile(git: GitService, file: string): Promise<void> {
    git.safePath(file);
    await git.unstage([file]);
}

export async function ignoreFile(git: GitService, file: string): Promise<void> {
    git.safePath(file);
    await git.unstage([file]);
    const gi = safeRepoPath(git.repoRoot, '.gitignore', { write: true });
    const entry = '/' + file.replace(/\\/g, '/').replace(/([*?[\]!#])/g, '\\$1');
    const current = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
    if (!current.split(/\r?\n/).includes(entry)) {
        writeFileInRepo(gi, current + (current && !current.endsWith('\n') ? '\n' : '') + entry + '\n');
    }
    await git.stage(['.gitignore']);
}

export async function allowlistFinding(git: GitService, ref: FindingRef, reason: string, addedBy: string): Promise<void> {
    const f = await findRaw(git, ref);
    if (reason.trim().length < 3) throw new UserError('Please say why this is not a secret.');
    addToAllowlist(git.repoRoot, { value: f.value, ruleId: f.ruleId, file: f.file, reason: reason.trim(), addedBy, addedAt: new Date().toISOString() });
    await git.stage(['.cs-studio/secret-allowlist.json']);
}

// ---------------------------------------------------------------- several findings at once
//
// The same fixes, for many findings in one go (a commit with 80 encrypted values in config files): the staged
// changes are scanned once, each file is edited once (findings on one line from right to left) and staged
// once, and secrets are saved only after every file edit worked.

/** Where a finding's secret is used: the environment its file belongs to (config/<p>/environments/<env>.env), else every environment. */
export function envOfFile(file: string): string | undefined {
    return /^config\/[^/]+\/environments\/([A-Za-z0-9_.-]+)\.(?:env|ya?ml|json|properties)$/.exec(file.replace(/\\/g, '/'))?.[1];
}

/** A secret name from a suggestion: capitals, digits and _ (as the store takes them). */
export function secretName(s: string | undefined): string {
    const n = (s ?? '').toUpperCase().replace(/[^A-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, '_$1').slice(0, 60);
    return n || 'SECRET_VALUE';
}

export interface StorePlanItem {
    ref: FindingRef;
    /** Suggested secret name and environment (both can be changed). */
    name: string; env?: string;
    /** Findings with the same value share this id (one secret for all of them). */
    group: string;
    /** A secret with this name and scope is already in the store: with the same value, or another one. */
    exists: 'none' | 'same' | 'different';
    /** An ENCRYPTED: value read with the framework (the store keeps the real value). */
    decrypted: boolean;
}

/** The value to keep in the store: an ENCRYPTED: value decrypted when `decode` can, else as written. */
const storedValue = (v: string, decode?: (v: string) => string | null) => {
    if (!decode || !v.startsWith('ENCRYPTED:')) return { value: v, decrypted: false };
    const d = decode(v);
    return d ? { value: d, decrypted: true } : { value: v, decrypted: false };
};
const groupOf = (v: string) => crypto.createHash('sha256').update(v).digest('hex').slice(0, 12);

async function findAll(git: GitService, refs: FindingRef[]): Promise<RawFinding[]> {
    const { raw } = await git.scanStaged();
    const missing: string[] = [];
    const out = refs.map((ref) => {
        const f = raw.find((r) => r.fingerprint === ref.fingerprint && r.file === ref.file && r.line === ref.line);
        if (!f) missing.push(`${ref.file}:${ref.line}`);
        return f!;
    });
    if (missing.length) throw new UserError(`${missing.length} finding(s) are no longer in the staged changes (${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}). Scan again.`);
    return out;
}

/** Names, environments and conflicts for moving these findings to the store (nothing is changed). */
export async function planStore(git: GitService, store: SecretStore, refs: FindingRef[], project: string | undefined, decode?: (v: string) => string | null): Promise<StorePlanItem[]> {
    const found = await findAll(git, refs);
    const taken = new Map<string, string>(); // name|env → group
    return found.map((f, i) => {
        const { value, decrypted } = storedValue(f.value, decode);
        const group = groupOf(value);
        const env = envOfFile(f.file);
        const base = secretName(f.suggestedName);
        // The same name and place for another value in this batch: NAME_2, NAME_3…
        let name = base;
        for (let n = 2; taken.has(`${name}|${env ?? ''}`) && taken.get(`${name}|${env ?? ''}`) !== group; n++) name = `${base}_${n}`;
        taken.set(`${name}|${env ?? ''}`, group);
        let had: string | undefined;
        try { had = store.exists ? store.resolve(name, { project, env }) : undefined; } catch { had = undefined; }
        // resolve() falls back to the project-wide secret: only an exact match of scope counts as "exists".
        const exact = store.exists && store.list({ project }).some((m) => m.name === name && (m.env ?? '') === (env ?? '') && (m.project ?? '') === (project ?? ''));
        return { ref: refs[i], name, ...(env ? { env } : {}), group, exists: !exact || had === undefined ? 'none' : had === value ? 'same' : 'different', decrypted } as StorePlanItem;
    });
}

/** Edit many findings' lines: each file read, checked, written and staged once. */
async function editMany(git: GitService, edits: Array<{ f: RawFinding; edit: (lineText: string) => string }>): Promise<string[]> {
    const byFile = new Map<string, typeof edits>();
    for (const e of edits) {
        if (e.f.line < 1) throw new UserError(`${e.f.file} is about the whole file: leave it out of the commit instead.`);
        byFile.set(e.f.file, [...(byFile.get(e.f.file) ?? []), e]);
    }
    // Every file is checked before any is written: nothing is half done because of the last one.
    const plans: Array<{ file: string; abs: string; text: string }> = [];
    for (const [file, list] of byFile) {
        git.safePath(file);
        const abs = safeRepoPath(git.repoRoot, file, { write: true });
        const dirty = await runGit(['diff', '--quiet', '--', file], { cwd: git.repoRoot, allowFailure: true, env: { GIT_LITERAL_PATHSPECS: '1' } });
        if (dirty.code !== 0) throw new UserError(`${file} has unstaged edits. Stage or discard them first so the fixes apply to exactly what you are committing.`);
        const original = fs.readFileSync(abs, 'utf8');
        const eol = original.includes('\r\n') ? '\r\n' : '\n';
        const lines = original.split(/\r?\n/);
        // Right to left on a line, bottom to top in the file: an edit never moves a finding not yet done.
        for (const e of [...list].sort((a, b) => b.f.line - a.f.line || b.f.column - a.f.column)) {
            const lineText = lines[e.f.line - 1];
            if (lineText === undefined || lineText.substr(e.f.column - 1, e.f.value.length) !== e.f.value) throw new UserError(`${file}:${e.f.line} changed since the scan. Scan again.`);
            lines[e.f.line - 1] = e.edit(lineText);
        }
        plans.push({ file, abs, text: lines.join(eol) });
    }
    for (const p of plans) writeFileInRepo(p.abs, p.text);
    if (plans.length) await git.stage(plans.map((p) => p.file));
    return plans.map((p) => p.file);
}

/** Move many findings to the store (names and environments as chosen). */
export async function moveManyToStore(git: GitService, store: SecretStore, items: Array<{ ref: FindingRef; name: string; env?: string }>, o: { project?: string; overwrite?: boolean; decode?: (v: string) => string | null }): Promise<{ moved: number; secrets: number; files: string[] }> {
    const found = await findAll(git, items.map((x) => x.ref));
    const targets = new Map<string, { key: { name: string; project?: string; env?: string }; value: string; where: string[] }>();
    const clash: string[] = [];
    found.forEach((f, i) => {
        const key = { name: items[i].name, project: o.project, env: items[i].env || undefined };
        SecretStore.validate(key);
        const { value } = storedValue(f.value, o.decode);
        const k = `${key.name}|${key.env ?? ''}`;
        const had = targets.get(k);
        if (had && had.value !== value) clash.push(`${key.name}${key.env ? ` (${key.env})` : ''}: ${had.where[0]} and ${f.file}:${f.line} have different values`);
        else targets.set(k, { key, value, where: [...(had?.where ?? []), `${f.file}:${f.line}`] });
    });
    if (clash.length) throw new UserError(`One name for different values: ${clash.slice(0, 4).join('; ')}${clash.length > 4 ? '; …' : ''}. Give them different names.`);
    if (!o.overwrite && store.exists) {
        const differ = [...targets.values()].filter((t) => store.list({ project: o.project }).some((m) => m.name === t.key.name && (m.env ?? '') === (t.key.env ?? '') && (m.project ?? '') === (t.key.project ?? '')) && store.resolve(t.key.name, t.key) !== t.value);
        if (differ.length) throw new UserError(`Already in the secret store with another value: ${differ.map((t) => `${t.key.name}${t.key.env ? ` (${t.key.env})` : ''}`).join(', ')}. Rename them, or choose to replace the stored values.`);
    }
    const files = await editMany(git, found.map((f, i) => ({ f, edit: (lineText: string) => { const r = replacementFor(f.file, items[i].name, lineText, f.column, f.value); return lineText.slice(0, r.start) + r.text + lineText.slice(r.end); } })));
    // Stored after every file edit worked.
    for (const t of targets.values()) store.set(t.key, t.value);
    return { moved: found.length, secrets: targets.size, files };
}

/** Blank many findings' values. */
export async function removeMany(git: GitService, refs: FindingRef[]): Promise<{ files: string[] }> {
    const found = await findAll(git, refs);
    return { files: await editMany(git, found.map((f) => ({ f, edit: (lineText: string) => lineText.slice(0, f.column - 1) + lineText.slice(f.column - 1 + f.value.length) }))) };
}

/** Mark many findings as not secrets, with one reason. */
export async function allowlistMany(git: GitService, refs: FindingRef[], reason: string, addedBy: string): Promise<void> {
    if (reason.trim().length < 3) throw new UserError('Please say why these are not secrets.');
    const found = await findAll(git, refs);
    const at = new Date().toISOString();
    for (const f of found) addToAllowlist(git.repoRoot, { value: f.value, ruleId: f.ruleId, file: f.file, reason: reason.trim(), addedBy, addedAt: at });
    await git.stage(['.cs-studio/secret-allowlist.json']);
}

/** Leave many files out of the commit. */
export async function unstageMany(git: GitService, files: string[]): Promise<void> {
    const list = [...new Set(files)];
    for (const f of list) git.safePath(f);
    if (list.length) await git.unstage(list);
}
