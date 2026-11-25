/**
 * Scans what is about to enter Git history:
 *  - `scanStaged`: the staged changes (what the next commit would contain);
 *  - `scanUnpushed`: every commit that a push would send (including commits made outside the Studio).
 *
 * Hardening against things in the user's repository/config that could hide content from the scan:
 *  - `--text` + `--no-textconv`: `.gitattributes` `-diff` / `binary` / textconv drivers cannot turn
 *    a text file into "Binary files differ" (files with real NUL bytes are still treated as binary);
 *  - explicit `a/` `b/` prefixes and `core.quotePath=false`: diff.noprefix / diff.mnemonicPrefix
 *    cannot break path parsing;
 *  - merge commits are scanned with `--remerge-diff`, so lines written while resolving conflicts
 *    (or "evil" merge edits) are seen;
 *  - files are diffed in bounded batches; a file too large to scan becomes a finding the user must
 *    look at (never a crash that blocks every commit, never a silent pass);
 *  - Git LFS pointers: the real content (working tree / local LFS cache) is used for content checks.
 */
import * as fs from 'fs';
import * as path from 'path';
import { GitError, runGit } from '../git/run';
import { DiffFile, parseAddedLines } from '../git/parse';
import { FILE_RULES } from './rules';
import { scanLines, scanPath } from './scanner';
import { fingerprint } from './util';
import { RawFinding, ScanOptions } from './types';

export interface ScanResult {
    findings: RawFinding[];
    filesScanned: number;
    linesScanned: number;
    /** Plain-language notes about things that could not be scanned completely. */
    warnings: string[];
}

const CONTENT_CHECK_MAX_BYTES = 2 * 1024 * 1024;
/** Files (new blob size) above this are not diffed; they are reported instead. */
export const MAX_SCAN_FILE_BYTES = 32 * 1024 * 1024;
/** Diff output allowed for one batch / one file. */
const MAX_DIFF_OUTPUT_BYTES = 96 * 1024 * 1024;
const BATCH_MAX_FILES = 100;
const BATCH_MAX_BYTES = 16 * 1024 * 1024;
const BATCH_MAX_ARG_CHARS = 16_000; // stay well below Windows' command-line limit
const LITERAL = { GIT_LITERAL_PATHSPECS: '1' };
const LFS_POINTER = 'version https://git-lfs.github.com/spec/v1';
export const TOO_LARGE_RULE_ID = 'file-too-large-to-scan';

/** Diff flags shared by every scan: see the header comment. */
const SCAN_DIFF_FLAGS = ['-U0', '--no-color', '--no-ext-diff', '--no-renames', '--no-textconv', '--text', '--src-prefix=a/', '--dst-prefix=b/'];
const NO_QUOTE = ['-c', 'core.quotePath=false'];

interface ChangedFile { path: string; size: number | null; deleted: boolean }

export async function scanStaged(repoRoot: string, opts: ScanOptions = {}): Promise<ScanResult> {
    const changed = await changedFiles(repoRoot, ['diff', '--cached', '--raw', '-z', '--no-renames', '--abbrev=40', '--no-ext-diff'], repoRoot);
    return scanChanged(repoRoot, changed, opts,
        (paths) => [...NO_QUOTE, 'diff', '--cached', ...SCAN_DIFF_FLAGS, '--', ...paths],
        (p) => stagedContent(repoRoot, p));
}

/** Commits that `git push` would send: not reachable from any remote-tracking ref. */
export async function unpushedCommits(repoRoot: string): Promise<string[]> {
    const head = await runGit(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: repoRoot, allowFailure: true });
    if (head.code !== 0) return [];
    const r = await runGit(['rev-list', '--reverse', 'HEAD', '--not', '--remotes'], { cwd: repoRoot });
    return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

export async function scanUnpushed(repoRoot: string, opts: ScanOptions = {}): Promise<ScanResult & { commits: string[]; findingsByCommit: Record<string, RawFinding[]> }> {
    const commits = await unpushedCommits(repoRoot);
    const all: RawFinding[] = [];
    const byCommit: Record<string, RawFinding[]> = {};
    const warnings: string[] = [];
    let filesScanned = 0;
    let linesScanned = 0;
    for (const sha of commits) {
        const parents = (await runGit(['rev-list', '--parents', '-n', '1', sha], { cwd: repoRoot })).stdout.trim().split(' ').slice(1);
        const listArgs = parents.length === 0
            ? ['diff-tree', '-r', '--root', '--raw', '-z', '--no-renames', '--abbrev=40', '--no-commit-id', sha]
            : ['diff-tree', '-r', '--raw', '-z', '--no-renames', '--abbrev=40', '--no-commit-id', parents[0], sha];
        const changed = await changedFiles(repoRoot, listArgs, repoRoot);
        let diffArgs: (paths: string[]) => string[];
        if (parents.length > 1 && await supportsRemergeDiff(repoRoot, sha)) {
            // What the merge itself introduced: the difference between git's automatic re-merge
            // and the committed result (conflict resolutions, extra edits).
            diffArgs = (paths) => [...NO_QUOTE, 'show', '--format=', '--remerge-diff', ...SCAN_DIFF_FLAGS, sha, '--', ...paths];
        } else if (parents.length >= 1) {
            // Normal commit, or a merge on a git without --remerge-diff: everything vs. the first parent.
            diffArgs = (paths) => [...NO_QUOTE, 'diff', ...SCAN_DIFF_FLAGS, parents[0], sha, '--', ...paths];
        } else {
            diffArgs = (paths) => [...NO_QUOTE, 'show', '--format=', ...SCAN_DIFF_FLAGS, sha, '--', ...paths];
        }
        const res = await scanChanged(repoRoot, changed, opts, diffArgs, (p) => blobContent(repoRoot, sha, p));
        byCommit[sha] = res.findings;
        all.push(...res.findings);
        warnings.push(...res.warnings.map((w) => `${sha.slice(0, 8)}: ${w}`));
        filesScanned += res.filesScanned;
        linesScanned += res.linesScanned;
    }
    return { findings: all, filesScanned, linesScanned, warnings, commits, findingsByCommit: byCommit };
}

const remergeSupport = new Map<string, boolean>();
async function supportsRemergeDiff(repoRoot: string, sha: string): Promise<boolean> {
    if (remergeSupport.has(repoRoot)) return remergeSupport.get(repoRoot)!;
    const r = await runGit(['show', '--format=', '--remerge-diff', '--name-only', sha, '--'], { cwd: repoRoot, allowFailure: true });
    const ok = !(r.code !== 0 && /unrecognized argument|unknown option|remerge-diff/i.test(r.stderr));
    remergeSupport.set(repoRoot, ok);
    return ok;
}

/** Changed paths with the size of their new blob, from `--raw -z` output. */
async function changedFiles(repoRoot: string, args: string[], cwd: string): Promise<ChangedFile[]> {
    const out = (await runGit(args, { cwd })).stdout;
    const parts = out.split('\0');
    const files: Array<ChangedFile & { sha: string; mode: string }> = [];
    for (let i = 0; i < parts.length; i++) {
        const meta = parts[i];
        if (!meta.startsWith(':')) continue;
        const p = parts[++i];
        if (p === undefined) break;
        // :<srcmode> <dstmode> <srcsha> <dstsha> <status>
        const [, dstMode, , dstSha, status] = meta.slice(1).split(' ');
        files.push({ path: p, size: null, deleted: status === 'D', sha: dstSha, mode: dstMode });
    }
    // Sizes of the new blobs in one call (submodules / missing objects stay null).
    const blobs = files.filter((f) => !f.deleted && f.mode !== '160000' && !/^0+$/.test(f.sha));
    if (blobs.length) {
        const r = await runGit(['cat-file', '--batch-check=%(objectname) %(objectsize)'], { cwd: repoRoot, input: blobs.map((f) => f.sha).join('\n') + '\n', allowFailure: true });
        const sizes = new Map<string, number>();
        for (const l of r.stdout.split('\n')) { const [s, n] = l.split(' '); if (s && /^\d+$/.test(n ?? '')) sizes.set(s, Number(n)); }
        for (const f of blobs) f.size = sizes.get(f.sha) ?? null;
    }
    return files.map(({ path: p, size, deleted }) => ({ path: p, size, deleted }));
}

async function scanChanged(
    repoRoot: string,
    changed: ChangedFile[],
    opts: ScanOptions,
    diffArgs: (paths: string[]) => string[],
    readContent: (path: string) => Promise<string | undefined>,
): Promise<ScanResult> {
    const findings: RawFinding[] = [];
    const warnings: string[] = [];
    const tooLarge: string[] = [];
    const files: DiffFile[] = [];
    const todo = changed.filter((f) => !f.deleted);
    const scannable: ChangedFile[] = [];
    for (const f of todo) {
        if (f.size !== null && f.size > MAX_SCAN_FILE_BYTES) tooLarge.push(f.path);
        else scannable.push(f);
    }
    for (const batch of batches(scannable)) {
        const paths = batch.map((f) => f.path);
        try {
            files.push(...await diffFiles(repoRoot, diffArgs(paths)));
        } catch (e) {
            if (!isOutputTooLarge(e)) throw e;
            // Retry one file at a time; whatever is still too big is reported, not scanned.
            for (const p of paths) {
                try { files.push(...await diffFiles(repoRoot, diffArgs([p]))); }
                catch (e2) { if (isOutputTooLarge(e2)) tooLarge.push(p); else throw e2; }
            }
        }
    }
    const res = await scanDiffFiles(files, opts, readContent);
    findings.push(...res.findings);
    for (const p of tooLarge) {
        const f = tooLargeFinding(p);
        if (!opts.allowlist?.has(f.ruleId, f.value, f.fingerprint)) findings.push(f);
        warnings.push(`${p} is too large to scan for secrets (over ${Math.round(MAX_SCAN_FILE_BYTES / 1024 / 1024)} MB).`);
    }
    return { findings, filesScanned: res.filesScanned + tooLarge.length, linesScanned: res.linesScanned, warnings };
}

function isOutputTooLarge(e: unknown): boolean {
    return e instanceof GitError && /output exceeded/.test(e.message);
}

function tooLargeFinding(file: string): RawFinding {
    const f = file.replace(/\\/g, '/');
    return {
        ruleId: TOO_LARGE_RULE_ID,
        type: 'File too large to scan',
        reason: `This file is larger than ${Math.round(MAX_SCAN_FILE_BYTES / 1024 / 1024)} MB, so it was not checked for secrets. Make sure it contains none (or keep it out of Git), then commit with a reason.`,
        confidence: 'medium',
        file: f, line: 0, column: 0, value: f, fingerprint: fingerprint(TOO_LARGE_RULE_ID, f),
    };
}

function* batches(files: ChangedFile[]): Generator<ChangedFile[]> {
    let cur: ChangedFile[] = [];
    let bytes = 0, chars = 0;
    for (const f of files) {
        const size = f.size ?? 0;
        if (cur.length && (cur.length >= BATCH_MAX_FILES || bytes + size > BATCH_MAX_BYTES || chars + f.path.length > BATCH_MAX_ARG_CHARS)) {
            yield cur; cur = []; bytes = 0; chars = 0;
        }
        cur.push(f); bytes += size; chars += f.path.length + 3;
    }
    if (cur.length) yield cur;
}

async function diffFiles(repoRoot: string, args: string[]): Promise<DiffFile[]> {
    const r = await runGit(args, { cwd: repoRoot, env: LITERAL, maxOutputBytes: MAX_DIFF_OUTPUT_BYTES });
    return parseAddedLines(r.stdout);
}

async function scanDiffFiles(
    files: DiffFile[],
    opts: ScanOptions,
    readContent: (path: string) => Promise<string | undefined>,
): Promise<{ findings: RawFinding[]; filesScanned: number; linesScanned: number }> {
    const findings: RawFinding[] = [];
    let lines = 0;
    let scanned = 0;
    for (const f of files) {
        if (f.deleted || !f.path) continue;
        scanned++;
        // File-level rules; fetch content only when a rule needs it.
        const needsContent = FILE_RULES.some((r) => r.re.test(f.path) && r.contentCheck);
        const content = needsContent ? await readContent(f.path) : undefined;
        findings.push(...scanPath(f.path, content, opts));
        // `--text` shows every file as text; content with NUL bytes really is binary.
        const binary = f.binary || f.added.some((a) => a.text.includes('\0'));
        if (!binary) {
            lines += f.added.length;
            findings.push(...scanLines(f.added, opts));
        }
    }
    return { findings, filesScanned: scanned, linesScanned: lines };
}

async function stagedContent(repoRoot: string, p: string): Promise<string | undefined> {
    const r = await runGit(['show', `:${p}`], { cwd: repoRoot, allowFailure: true, maxOutputBytes: CONTENT_CHECK_MAX_BYTES }).catch(() => undefined);
    if (!r || r.code !== 0) return undefined;
    if (!r.stdout.startsWith(LFS_POINTER)) return r.stdout;
    // Git LFS: the index holds a pointer; the real content is in the working tree (just added)
    // or in the local LFS object store.
    const abs = path.resolve(repoRoot, p);
    try {
        const st = fs.statSync(abs);
        if (st.isFile() && st.size <= CONTENT_CHECK_MAX_BYTES) {
            const text = fs.readFileSync(abs, 'utf8');
            if (!text.startsWith(LFS_POINTER)) return text;
        }
    } catch { /* not in the working tree */ }
    return (await lfsObject(repoRoot, r.stdout)) ?? r.stdout;
}

async function blobContent(repoRoot: string, sha: string, p: string): Promise<string | undefined> {
    const r = await runGit(['show', `${sha}:${p}`], { cwd: repoRoot, allowFailure: true, maxOutputBytes: CONTENT_CHECK_MAX_BYTES }).catch(() => undefined);
    if (!r || r.code !== 0) return undefined;
    if (r.stdout.startsWith(LFS_POINTER)) return (await lfsObject(repoRoot, r.stdout)) ?? r.stdout;
    return r.stdout;
}

/** Content of an LFS object from the local store (.git/lfs/objects/aa/bb/<oid>), if present. */
async function lfsObject(repoRoot: string, pointer: string): Promise<string | undefined> {
    const oid = /^oid sha256:([0-9a-f]{64})$/m.exec(pointer)?.[1];
    if (!oid) return undefined;
    const r = await runGit(['rev-parse', '--git-common-dir'], { cwd: repoRoot, allowFailure: true });
    if (r.code !== 0) return undefined;
    const file = path.join(path.resolve(repoRoot, r.stdout.trim()), 'lfs', 'objects', oid.slice(0, 2), oid.slice(2, 4), oid);
    try {
        if (fs.statSync(file).size > CONTENT_CHECK_MAX_BYTES) return undefined;
        return fs.readFileSync(file, 'utf8');
    } catch { return undefined; }
}
