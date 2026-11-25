/**
 * The history of one request of a collection, from Git: every commit that changed it (author, date, message) with
 * what changed (a diff of the request as it was before and after). Requests are followed by their id, so a rename or
 * a move to another folder is the same request; renames of the collection file are followed too.
 */
import { runGit } from '../git/run';
import { unifiedDiff } from '../framework/plan';
import { allRequests, ApiCollection, ApiRequest } from './model';

export interface RequestChange { sha: string; author: string; date: string; message: string; kind: 'added' | 'changed' | 'removed'; diff: string; added: number; removed: number }

const SEP = '\u001f';
/** Stable text of a request (keys sorted) without the comments (discussion is not a change of the request). */
function text(r: ApiRequest | undefined): string | null {
    if (!r) return null;
    const { comments: _c, ...rest } = r as ApiRequest & { comments?: unknown };
    void _c;
    const sort = (v: unknown): unknown => (Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])])) : v);
    return `${JSON.stringify(sort(rest), null, 2)}\n`;
}

export async function requestHistory(repoRoot: string, file: string, requestId: string, limit = 50): Promise<RequestChange[]> {
    const log = await runGit(['log', '--follow', `--max-count=${Math.max(1, Math.min(limit * 4, 400))}`, `--format=%H${SEP}%an${SEP}%aI${SEP}%s`, '--name-only', '--', file], { cwd: repoRoot, allowFailure: true, timeoutMs: 30_000 });
    // Commits newest first, each with the path the file had then.
    const commits: Array<{ sha: string; author: string; date: string; message: string; path: string }> = [];
    let cur: { sha: string; author: string; date: string; message: string } | null = null;
    for (const line of log.stdout.split('\n')) {
        if (line.includes(SEP)) { const [sha, author, date, message] = line.split(SEP); cur = { sha, author, date, message }; continue; }
        if (cur && line.trim()) { commits.push({ ...cur, path: line.trim() }); cur = null; }
    }
    const at = async (sha: string, p: string): Promise<ApiRequest | undefined> => {
        const r = await runGit(['show', `${sha}:${p}`], { cwd: repoRoot, allowFailure: true, timeoutMs: 30_000 });
        if (r.code !== 0) return undefined;
        try { return allRequests((JSON.parse(r.stdout) as ApiCollection).items ?? []).map((x) => x.request).find((x) => x.id === requestId); } catch { return undefined; }
    };
    const out: RequestChange[] = [];
    // Oldest first: compare each version with the one before.
    const ordered = [...commits].reverse();
    let prev: string | null = null;
    for (const c of ordered) {
        const now = text(await at(c.sha, c.path));
        if (now !== prev) {
            const d = await unifiedDiff(prev, now ?? '', 'request.json');
            out.push({ sha: c.sha, author: c.author, date: c.date, message: c.message, kind: prev === null ? 'added' : now === null ? 'removed' : 'changed', diff: d.diff, added: d.added, removed: d.removed });
        }
        prev = now;
    }
    return out.reverse().slice(0, limit);
}
