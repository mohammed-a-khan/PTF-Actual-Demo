/**
 * One way for every module to change the project: a plan of files → a review (each file before and
 * after, its diff, the standards check) → apply.
 *  - Review shows exactly what will be written; nothing is written.
 *  - Apply writes only files inside the repository, refuses when a file changed since the review (so
 *    nobody's edits are overwritten unseen), and keeps a copy of every file it replaces in the
 *    Studio's recovery folder (.git/cs-studio/recovery/<time>), like Discard does.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { runGit } from '../git/run';

export type FileKind = 'feature' | 'data' | 'page' | 'steps' | 'config' | 'other';
export interface PlannedFile {
    path: string; kind: FileKind; text: string;
    /** A file written as bytes (an Excel workbook): text is its readable form (CSV) for the review, made into bytes on apply. */
    encode?: { as: 'xlsx'; sheet: string };
    /** The readable form of the file as it is now (for files written as bytes; null: it does not exist). */
    shownBefore?: string | null;
}
export interface ChangePlan {
    /** What the change is (for the activity log and the review's title). */
    title: string;
    files: PlannedFile[];
    /** Notes from the generator (what to look at). */
    warnings: string[];
}

export interface Finding {
    level: 'error' | 'warning' | 'info';
    /** Rule id (stable, for filtering): undefined-step, secret-in-file, … */
    rule: string;
    file?: string;
    line?: number;
    message: string;
}

export interface ReviewedFile extends PlannedFile {
    change: 'new' | 'update' | 'same';
    /** The file as it is now (null: it does not exist). */
    before: string | null;
    /** Hash of the file as it is now (null: it does not exist): apply checks it again. */
    baseHash: string | null;
    /** Unified diff (git format), empty when unchanged. */
    diff: string;
    added: number;
    removed: number;
}

export interface Review {
    title: string;
    files: ReviewedFile[];
    findings: Finding[];
    warnings: string[];
    /** Errors in the findings: applying needs an explicit "apply anyway". */
    blocked: boolean;
}

export const hashOf = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 32);

/** The repository path of a planned file, refused when it leaves the repository or enters .git. */
export function safePath(repoRoot: string, p: string): string {
    const norm = p.replace(/\\/g, '/');
    if (!norm || norm.startsWith('/') || /^[A-Za-z]:/.test(norm) || norm.split('/').some((x) => x === '..') || /^\.git(\/|$)/.test(norm)) throw new Error(`${p} is not a file of the repository.`);
    const abs = path.resolve(repoRoot, norm);
    const root = path.resolve(repoRoot) + path.sep;
    if (!abs.startsWith(root)) throw new Error(`${p} is not a file of the repository.`);
    return abs;
}

const readNow = (abs: string): string | null => { try { return fs.readFileSync(abs, 'utf8'); } catch { return null; } };

/** A unified diff of two texts (git's own algorithm, through `git diff --no-index`). */
export async function unifiedDiff(before: string | null, after: string, name: string): Promise<{ diff: string; added: number; removed: number }> {
    if (before === after) return { diff: '', added: 0, removed: 0 };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-studio-diff-'));
    try {
        const base = path.basename(name) || 'file';
        fs.mkdirSync(path.join(dir, 'a')); fs.mkdirSync(path.join(dir, 'b'));
        fs.writeFileSync(path.join(dir, 'a', base), before ?? '');
        fs.writeFileSync(path.join(dir, 'b', base), after);
        const r = await runGit(['-c', 'core.quotepath=off', 'diff', '--no-index', '--no-color', '--no-ext-diff', '-U3', '--', `a/${base}`, `b/${base}`], { cwd: dir, allowFailure: true, timeoutMs: 30_000 });
        const diff = r.stdout;
        let added = 0, removed = 0;
        for (const l of diff.split('\n')) { if (l.startsWith('+') && !l.startsWith('+++')) added++; else if (l.startsWith('-') && !l.startsWith('---')) removed++; }
        return { diff, added, removed };
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** Each file before and after, with its diff; the findings come from the caller's checks. */
export async function reviewPlan(repoRoot: string, plan: ChangePlan, findings: Finding[], display: (text: string) => string = (t) => t): Promise<Review> {
    const files: ReviewedFile[] = [];
    const seen = new Set<string>();
    for (const f of plan.files) {
        if (seen.has(f.path)) throw new Error(`${f.path} is planned twice.`);
        seen.add(f.path);
        const raw = readNow(safePath(repoRoot, f.path));
        // A file written as bytes is compared in its readable form; its hash is of the file itself.
        const before = f.encode ? (raw === null ? null : f.shownBefore ?? '') : raw;
        const text = display(f.text);
        const d = await unifiedDiff(before, text, f.path);
        files.push({ ...f, text, before, baseHash: raw === null ? null : hashOf(raw), change: before === null ? 'new' : before === f.text ? 'same' : 'update', ...d });
    }
    return { title: plan.title, files, findings, warnings: plan.warnings, blocked: findings.some((x) => x.level === 'error') };
}

export class PlanConflictError extends Error {
    constructor(public readonly paths: string[]) {
        super(`Changed since the review: ${paths.join(', ')}. Review the changes again.`);
        this.name = 'PlanConflictError';
    }
}

export interface ApplyOptions {
    /** Hashes from the review (path → hash, null = did not exist): files changed since are refused. */
    baseHashes?: Record<string, string | null>;
    /** The text written for a file (e.g. secret values encrypted at the last moment). */
    transform?: (file: PlannedFile, text: string) => string;
    /** The bytes of a file planned with encode (e.g. an Excel workbook from its CSV form). */
    encode?: (file: PlannedFile, text: string) => Buffer;
    /** Where copies of replaced files go (default .git/cs-studio/recovery/<time>). */
    recoveryDir?: string;
}

/** Write the plan. Throws PlanConflictError (nothing written) when a file changed since the review. */
export function applyPlan(repoRoot: string, plan: ChangePlan, o: ApplyOptions = {}): { written: Array<{ path: string; change: 'new' | 'update' }>; unchanged: string[]; recoveryDir: string | null } {
    const targets = plan.files.map((f) => ({ f, abs: safePath(repoRoot, f.path) }));
    if (o.baseHashes) {
        const changed = targets.filter(({ f, abs }) => {
            if (!(f.path in o.baseHashes!)) return false;
            const now = readNow(abs);
            const want = o.baseHashes![f.path];
            return want === null ? now !== null : now === null || hashOf(now) !== want;
        }).map(({ f }) => f.path);
        if (changed.length) throw new PlanConflictError(changed);
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const recoveryDir = o.recoveryDir ?? path.join(repoRoot, '.git', 'cs-studio', 'recovery', stamp);
    let usedRecovery = false;
    const written: Array<{ path: string; change: 'new' | 'update' }> = [];
    const unchanged: string[] = [];
    for (const { f, abs } of targets) {
        const text = o.transform ? o.transform(f, f.text) : f.text;
        const now = readNow(abs);
        if (f.encode ? (now !== null && f.shownBefore === text) : now === text) { unchanged.push(f.path); continue; }
        if (f.encode && !o.encode) throw new Error(`${f.path} cannot be written here (no ${f.encode.as} writer).`);
        if (now !== null) {
            const copy = path.join(recoveryDir, f.path);
            fs.mkdirSync(path.dirname(copy), { recursive: true });
            fs.copyFileSync(abs, copy);
            usedRecovery = true;
        }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, f.encode ? o.encode!(f, text) : text);
        written.push({ path: f.path, change: now === null ? 'new' : 'update' });
    }
    return { written, unchanged, recoveryDir: usedRecovery ? recoveryDir : null };
}
