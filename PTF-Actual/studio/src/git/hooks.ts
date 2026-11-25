/**
 * Git hooks that apply the same secret scan to commits made OUTSIDE the Studio
 * (command line, another editor). Installed per repository; existing hooks are kept and chained.
 *
 *  pre-commit : scans staged changes; blocks on findings unless
 *               - the Studio already reviewed exactly these findings (APPROVED_DIGEST_ENV), or
 *               - the user sets CS_STUDIO_OVERRIDE_REASON="why" (if policy allows) — the reason is
 *                 then recorded by commit-msg as a `Secret-Scan-Override:` trailer.
 *  commit-msg : appends that trailer.
 */
import * as fs from 'fs';
import * as path from 'path';
import { runGit } from './run';
import { UserError } from '../core/errors';
import { APPROVED_DIGEST_ENV } from './service';
import { scanStaged } from '../scanner/gitScan';
import { allowlistSet } from '../scanner/allowlist';
import { OVERRIDE_TRAILER, overrideRefusal, readPolicy, validateOverrideReason } from '../scanner/policy';
import { findingsDigest, toPublic } from '../scanner/scanner';
import { KnownSecret } from '../scanner/types';

export const OVERRIDE_ENV = 'CS_STUDIO_OVERRIDE_REASON';
const MARKER = 'cs-studio-override';
const HOOK_TAG = '# cs-test-studio hook';
const PREVIOUS_SUFFIX = '.cs-studio-previous';
export const HOOK_NAMES = ['pre-commit', 'commit-msg'] as const;
export type HookName = (typeof HOOK_NAMES)[number];

async function gitPath(repo: string, p: string): Promise<string> {
    const r = await runGit(['rev-parse', '--git-path', p], { cwd: repo });
    return path.resolve(repo, r.stdout.trim());
}

/** POSIX sh script (Git for Windows also runs hooks with its bundled sh). */
function hookScript(name: HookName, nodePath: string, cliPath: string): string {
    const q = (s: string) => `'${s.replace(/\\/g, '/').replace(/'/g, `'\\''`)}'`;
    return [
        '#!/bin/sh',
        HOOK_TAG,
        `prev="$(dirname "$0")/${name}${PREVIOUS_SUFFIX}"`,
        'if [ -x "$prev" ]; then "$prev" "$@" || exit $?; fi',
        `exec ${q(nodePath)} ${q(cliPath)} hook run ${name} "$@"`,
        '',
    ].join('\n');
}

/**
 * Refuse to install when hooks live somewhere the Studio must not write: a folder inside the
 * working tree (tracked, e.g. husky's .husky) or a folder outside this repository's git directory
 * (core.hooksPath shared by several repositories).
 */
export async function assertHooksDirWritable(repo: string): Promise<string> {
    const hooksDir = await gitPath(repo, 'hooks');
    const top = path.resolve((await runGit(['rev-parse', '--show-toplevel'], { cwd: repo })).stdout.trim());
    const common = path.resolve(repo, (await runGit(['rev-parse', '--git-common-dir'], { cwd: repo })).stdout.trim());
    const cfg = await runGit(['config', '--get', 'core.hooksPath'], { cwd: repo, allowFailure: true });
    const configured = cfg.code === 0 ? cfg.stdout.trim() : '';
    const inside = (dir: string, parent: string) => { const rel = path.relative(real(parent), real(dir)); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
    const cmd = (n: string) => `npx cs-test-studio hook run ${n}`;
    if (inside(hooksDir, top) && !inside(hooksDir, common)) {
        const rel = path.relative(real(top), real(hooksDir)).replace(/\\/g, '/');
        throw new UserError(
            `Your repo manages hooks with core.hooksPath=${configured || rel}; those hook files are part of the project, so the Studio will not change them. ` +
            `Add \`${cmd('pre-commit')}\` to ${rel}/pre-commit and \`${cmd('commit-msg')} "$1"\` to ${rel}/commit-msg instead.`);
    }
    if (!inside(hooksDir, common)) {
        throw new UserError(
            `Git hooks for this repo come from core.hooksPath=${configured || hooksDir}, a folder outside this repository that other repositories may share, so the Studio will not change it. ` +
            `Add \`${cmd('pre-commit')}\` to its pre-commit hook and \`${cmd('commit-msg')} "$1"\` to its commit-msg hook instead.`);
    }
    return hooksDir;
}

function real(p: string): string {
    try { return fs.realpathSync(p); } catch {
        // Not created yet: resolve the nearest existing parent.
        const parent = path.dirname(p);
        return parent === p ? p : path.join(real(parent), path.basename(p));
    }
}

export async function installHooks(repo: string, opts: { nodePath?: string; cliPath: string }): Promise<string[]> {
    const nodePath = opts.nodePath ?? process.execPath;
    await assertHooksDirWritable(repo);
    const installed: string[] = [];
    for (const name of HOOK_NAMES) {
        const file = await gitPath(repo, `hooks/${name}`);
        // Never touch a file that is under version control.
        const rel = path.relative(repo, file);
        if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
            const tracked = await runGit(['ls-files', '--error-unmatch', '--', rel], { cwd: repo, allowFailure: true, env: { GIT_LITERAL_PATHSPECS: '1' } });
            if (tracked.code === 0) throw new UserError(`${rel.replace(/\\/g, '/')} is part of the project, so the Studio will not change it. Add \`npx cs-test-studio hook run ${name}\` to it instead.`);
        }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        if (fs.existsSync(file)) {
            const existing = fs.readFileSync(file, 'utf8');
            if (!existing.includes(HOOK_TAG)) fs.renameSync(file, file + PREVIOUS_SUFFIX); // keep the user's own hook
        }
        fs.writeFileSync(file, hookScript(name, nodePath, opts.cliPath), { mode: 0o755 });
        fs.chmodSync(file, 0o755);
        installed.push(file);
    }
    return installed;
}

export async function uninstallHooks(repo: string): Promise<void> {
    for (const name of HOOK_NAMES) {
        const file = await gitPath(repo, `hooks/${name}`);
        if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(HOOK_TAG)) {
            fs.unlinkSync(file);
            if (fs.existsSync(file + PREVIOUS_SUFFIX)) fs.renameSync(file + PREVIOUS_SUFFIX, file);
        }
    }
}

export interface HookIO {
    env: NodeJS.ProcessEnv;
    out: (s: string) => void;
    err: (s: string) => void;
    knownSecrets?: () => Promise<KnownSecret[]>;
}

/** Returns the process exit code. */
export async function runHook(name: string, args: string[], repo: string, io: HookIO): Promise<number> {
    if (name === 'pre-commit') return preCommit(repo, io);
    if (name === 'commit-msg') return commitMsg(repo, args[0], io);
    io.err(`Unknown hook: ${name}`);
    return 2;
}

async function preCommit(repo: string, io: HookIO): Promise<number> {
    const marker = await gitPath(repo, MARKER);
    if (fs.existsSync(marker)) fs.unlinkSync(marker);

    const known = io.knownSecrets ? await io.knownSecrets().catch(() => []) : [];
    const res = await scanStaged(repo, { knownSecrets: known, allowlist: allowlistSet(repo) });
    if (res.findings.length === 0) return 0;

    const digest = findingsDigest(res.findings);
    if (io.env[APPROVED_DIGEST_ENV] && io.env[APPROVED_DIGEST_ENV] === digest) return 0; // reviewed in the Studio

    const policy = readPolicy(repo);
    const refusal = overrideRefusal(policy, res.findings);
    const reason = io.env[OVERRIDE_ENV];
    if (reason !== undefined && reason !== '') {
        if (refusal) { io.err(`Secret scan: ${refusal}`); return 1; }
        const bad = validateOverrideReason(reason);
        if (bad) { io.err(`Secret scan: ${bad}`); return 1; }
        fs.writeFileSync(marker, reason.replace(/\s+/g, ' ').trim(), 'utf8');
        io.err(`Secret scan: committing with ${res.findings.length} finding(s) because you gave an override reason. It will be recorded in the commit.`);
        return 0;
    }

    const lines = [
        '',
        `Secret scan stopped this commit: ${res.findings.length} possible secret(s) in the staged changes.`,
        '',
    ];
    res.findings.forEach((f, i) => {
        const p = toPublic(f, String(i + 1));
        const where = p.line ? `${p.file}:${p.line}:${p.column}` : p.file;
        lines.push(`  ${i + 1}. ${p.type} — ${where}  [${p.preview}]`);
        lines.push(`     ${p.reason}`);
    });
    lines.push('');
    lines.push('What you can do:');
    lines.push('  • Open CS Test Studio → Commit to fix it in one click (move to the secret store, remove, or unstage).');
    lines.push('  • Or remove the value yourself, `git add` the file again, and commit.');
    if (!refusal) {
        lines.push(`  • If this is not a real secret, or you must commit anyway, run the commit again with`);
        lines.push(`    ${OVERRIDE_ENV}="your reason" — the reason is recorded in the commit.`);
    } else {
        lines.push(`  • ${refusal}`);
    }
    lines.push('');
    io.err(lines.join('\n'));
    return 1;
}

async function commitMsg(repo: string, msgFile: string | undefined, io: HookIO): Promise<number> {
    const marker = await gitPath(repo, MARKER);
    if (!fs.existsSync(marker)) return 0;
    const reason = fs.readFileSync(marker, 'utf8').trim();
    fs.unlinkSync(marker);
    if (!msgFile || !reason) return 0;
    const target = path.resolve(repo, msgFile);
    const r = await runGit(['interpret-trailers', '--in-place', '--if-exists', 'addIfDifferent', '--trailer', `${OVERRIDE_TRAILER}: ${reason}`, target], { cwd: repo, allowFailure: true });
    if (r.code !== 0) { io.err(`Could not record the override reason: ${r.stderr.trim()}`); return 1; }
    return 0;
}
