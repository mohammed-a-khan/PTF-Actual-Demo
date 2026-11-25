/**
 * Team results: load runs shared in a folder the team can reach (a network share such as \\files\perf-results, or a
 * synced folder), so results from everyone's computers and the pipelines form one history and one trend.
 *   <folder>/<project>/<scenario>/<started>-<id>.json          the run (as kept on the computer that ran it)
 *   <folder>/<project>/<scenario>/<started>-<id>.summary.json  its main numbers, for quick listings and trends
 * A run is written to a temporary name first and renamed, so a reader never sees half a file. Results from
 * Azure DevOps pipelines (an artifact with the --json results) are imported the same way.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { LoadRunDetail } from './runs';

export interface TeamRun {
    file: string; id: string; project: string; scenario: string; name: string; env: string; startedAt: string;
    passed: boolean; stopReason?: string; maxUsers: number; duration: number;
    summary: { requests: number; errorRate: number; avg: number; p95: number; p99: number; throughput: number };
    /** Who published it and from where (a computer, or a pipeline run). */
    by: { user: string; machine: string; pipeline?: string };
    publishedAt: string;
}

const slugOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'scenario';
const safe = (s: string) => /^[\w.-]{1,120}$/.test(s);

function checkFolder(folder: string): string {
    if (!folder?.trim()) throw new Error('Set the team results folder first (Settings).');
    const abs = path.resolve(folder.trim());
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error(`The team results folder ${folder} cannot be reached.`);
    return abs;
}

/** Publish a finished run to the team folder (again: replaced). */
export function publishRun(folder: string, d: LoadRunDetail, by: Partial<TeamRun['by']> = {}): TeamRun {
    const root = checkFolder(folder);
    const r = d.result;
    if (!r || d.state !== 'finished') throw new Error('Only a finished run can be shared.');
    if (!safe(d.project)) throw new Error('Not a project name.');
    const scenario = slugOf(path.basename(d.scenario).replace(/\.load\.json$/, '') || d.name);
    const base = `${r.startedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${String(d.id).replace(/[^\w-]/g, '').slice(0, 40)}`;
    const dir = path.join(root, d.project, scenario);
    fs.mkdirSync(dir, { recursive: true });
    const summary: TeamRun = {
        file: `${d.project}/${scenario}/${base}.json`, id: d.id, project: d.project, scenario: d.scenario, name: d.name, env: d.env, startedAt: r.startedAt,
        passed: r.passed, stopReason: r.stopReason, maxUsers: d.maxUsers, duration: d.duration,
        summary: { requests: r.total.count, errorRate: r.total.errorRate, avg: r.total.avg, p95: r.total.p95, p99: r.total.p99, throughput: r.total.throughput },
        by: { user: by.user ?? os.userInfo().username, machine: by.machine ?? os.hostname(), ...(by.pipeline ? { pipeline: by.pipeline } : {}) },
        publishedAt: new Date().toISOString(),
    };
    const write = (name: string, text: string) => { const tmp = path.join(dir, `.${name}.${process.pid}.tmp`); fs.writeFileSync(tmp, text); fs.renameSync(tmp, path.join(dir, name)); };
    write(`${base}.json`, JSON.stringify({ ...d, live: undefined }));
    write(`${base}.summary.json`, JSON.stringify(summary));
    return summary;
}

/** The team's runs (newest first), of a project and scenario file when given. */
export function listTeamRuns(folder: string, o: { project?: string; scenario?: string; limit?: number } = {}): TeamRun[] {
    const root = checkFolder(folder);
    const out: TeamRun[] = [];
    const projects = o.project ? [o.project] : fs.readdirSync(root).filter((n) => safe(n) && fs.statSync(path.join(root, n)).isDirectory());
    for (const p of projects) {
        if (!safe(p)) continue;
        let scenarios: string[] = [];
        try { scenarios = fs.readdirSync(path.join(root, p)).filter(safe); } catch { continue; }
        for (const s of scenarios) {
            let files: string[] = [];
            try { files = fs.readdirSync(path.join(root, p, s)).filter((f) => f.endsWith('.summary.json')); } catch { continue; }
            for (const f of files) {
                try {
                    const x = JSON.parse(fs.readFileSync(path.join(root, p, s, f), 'utf8')) as TeamRun;
                    if (o.scenario && x.scenario !== o.scenario) continue;
                    out.push({ ...x, file: `${p}/${s}/${f.replace(/\.summary\.json$/, '.json')}` });
                } catch { /* a file being written, or not ours */ }
            }
        }
    }
    return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, o.limit ?? 500);
}

/** One shared run (its full results). */
export function readTeamRun(folder: string, file: string): LoadRunDetail {
    const root = checkFolder(folder);
    const parts = file.split('/');
    if (parts.length !== 3 || !parts.every(safe) || !parts[2].endsWith('.json') || parts[2].endsWith('.summary.json')) throw new Error('Not a shared run.');
    return JSON.parse(fs.readFileSync(path.join(root, ...parts), 'utf8')) as LoadRunDetail;
}

/** Results files (cs-test-studio load … --json) in a folder, e.g. a downloaded pipeline artifact. */
export function findRunResults(dir: string, max = 50): LoadRunDetail[] {
    const out: LoadRunDetail[] = [];
    const walk = (d: string, depth: number) => {
        if (depth > 4 || out.length >= max) return;
        let es: fs.Dirent[] = [];
        try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of es) {
            const a = path.join(d, e.name);
            if (e.isDirectory()) walk(a, depth + 1);
            else if (e.name.endsWith('.json') && fs.statSync(a).size < 300 * 1024 * 1024) {
                try {
                    const x = JSON.parse(fs.readFileSync(a, 'utf8')) as LoadRunDetail;
                    if (x && x.result && Array.isArray(x.result.transactions) && x.definition && typeof x.scenario === 'string') out.push(x);
                } catch { /* not a results file */ }
            }
        }
    };
    walk(dir, 0);
    return out;
}
