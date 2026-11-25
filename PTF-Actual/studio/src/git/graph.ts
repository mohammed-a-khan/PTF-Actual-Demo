/**
 * Commit graph for the History view (like TortoiseGit's Log graph).
 * Input: commits in topological order (children before parents) with their parent SHAs.
 * Output per commit: the column of its dot and which lines to draw in its row:
 *   into        columns whose line comes from above into the dot (the dot's own column included)
 *   passThrough columns with a line straight through the row (other branches)
 *   out         columns the dot connects to below (its parents' lanes; first parent stays in col)
 * Columns are stable (a branch keeps its column), so lines are straight and easy to follow.
 */
export interface GraphInput { sha: string; parents: string[] }
export interface GraphRow { col: number; into: number[]; passThrough: number[]; out: number[]; width: number }

export function layoutGraph(commits: GraphInput[]): GraphRow[] {
    const lanes: Array<string | null> = [];
    const rows: GraphRow[] = [];
    const free = () => { const i = lanes.indexOf(null); return i < 0 ? lanes.length : i; };
    for (const c of commits) {
        const into: number[] = [];
        lanes.forEach((s, j) => { if (s === c.sha) into.push(j); });
        let col: number;
        if (into.length === 0) { col = free(); lanes[col] = c.sha; } else col = into[0];
        for (const j of into) if (j !== col) lanes[j] = null;
        const passThrough: number[] = [];
        lanes.forEach((s, j) => { if (s !== null && j !== col) passThrough.push(j); });
        const out: number[] = [];
        if (c.parents.length === 0) lanes[col] = null;
        else {
            lanes[col] = c.parents[0];
            out.push(col);
            for (const p of c.parents.slice(1)) {
                let k = lanes.indexOf(p);
                if (k < 0) { k = free(); lanes[k] = p; }
                out.push(k);
            }
        }
        while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
        const width = Math.max(col, ...into, ...passThrough, ...out, lanes.length - 1) + 1;
        rows.push({ col, into, passThrough, out, width });
    }
    return rows;
}

export interface LogCommit {
    sha: string;
    parents: string[];
    authorName: string;
    authorEmail: string;
    date: string;
    subject: string;
    refs: Array<{ name: string; kind: 'head' | 'branch' | 'remote' | 'tag' | 'stash' }>;
}

export const GRAPH_LOG_FORMAT = '%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%D%x1e';

/**
 * Parse `git log --format=GRAPH_LOG_FORMAT`. Decorations should come from `--decorate=full` so
 * refs are classified by their full name (a local `feature/x` is a branch, not a remote); short
 * decorations are still understood with a best-effort guess.
 */
export function parseGraphLog(out: string): LogCommit[] {
    return out.split('\x1e').map((r) => r.replace(/^\n/, '')).filter((r) => r.trim()).map((r) => {
        const [sha, parents, authorName, authorEmail, date, subject, deco] = r.split('\x1f');
        const refs: LogCommit['refs'] = [];
        for (const d of (deco ?? '').split(', ').map((x) => x.trim()).filter(Boolean)) {
            const ref = classifyRef(d);
            if (ref) refs.push(...ref);
        }
        return { sha, parents: parents ? parents.split(' ').filter(Boolean) : [], authorName, authorEmail, date, subject, refs };
    });
}

function classifyRef(d: string): LogCommit['refs'] | null {
    if (d.startsWith('HEAD -> ')) {
        const b = d.slice(8);
        return [{ name: 'HEAD', kind: 'head' }, { name: b.replace(/^refs\/heads\//, ''), kind: 'branch' }];
    }
    if (d === 'HEAD') return [{ name: 'HEAD', kind: 'head' }];
    if (d.startsWith('tag: ')) return [{ name: d.slice(5).replace(/^refs\/tags\//, ''), kind: 'tag' }];
    if (d === 'refs/stash') return [{ name: 'stash', kind: 'stash' }];
    if (d.startsWith('refs/heads/')) return [{ name: d.slice(11), kind: 'branch' }];
    if (d.startsWith('refs/remotes/')) return [{ name: d.slice(13), kind: 'remote' }];
    if (d.startsWith('refs/tags/')) return [{ name: d.slice(10), kind: 'tag' }];
    if (d.startsWith('refs/')) return null; // other namespaces (recovery points, notes, ...) are not labels
    // Short decoration (no namespace): a name with a slash is most likely remote/branch.
    return [{ name: d, kind: /\//.test(d) ? 'remote' : 'branch' }];
}
