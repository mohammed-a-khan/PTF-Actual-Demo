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
