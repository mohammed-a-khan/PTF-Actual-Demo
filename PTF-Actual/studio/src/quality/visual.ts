/**
 * Visual and accessibility review: the framework's visual baselines and accessibility (aria) snapshots, with what
 * the last run saw, so a change can be looked at and approved as the new baseline; and the accessibility issues
 * the runs found.
 *
 * Verified in the framework:
 *  - Visual checks ("the page should visually match smart snapshot …", region checks) keep their files in
 *    VISUAL_AI_DIR (default test/visual-ai): baseline/<name>.png, .pixel-hash (sha256 of the png), .phash,
 *    .structural.json, .aria.yaml; actual/<name>.png, .phash, .structural.json, .aria.yaml (the last run, same
 *    formats); diff/<name>.smart-result.json (the last comparison) and diff/<name>.diff.png (changed pixels red).
 *    With no baseline, the run's screenshot becomes it and the check passes (result: baselineCreated).
 *  - Aria snapshot checks keep <name>.yaml in ARIA_SNAPSHOT_DIR (default test/accessibility/snapshots), and
 *    <name>.actual.yaml when the last comparison differed.
 *  - Each check also writes a record into its run's results folder: accessibility/*.json (check: 'violations'
 *    with url and violations[], or 'aria-snapshot'), visual/*.json (the comparison).
 * Approving a visual change copies the last run's files to the baseline (the next run compares with them);
 * approving an aria change makes the .actual.yaml the baseline.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export type VisualStatus = 'new' | 'changed' | 'cosmetic' | 'same';
export interface VisualSnapshot {
    /** The folder (VISUAL_AI_DIR, relative to the repository) and the snapshot name. */
    dir: string; name: string; key: string;
    status: VisualStatus;
    verdict?: string; message?: string; passed?: boolean; at?: string;
    scenario?: string; feature?: string; region?: boolean;
    pixels?: { percent: number; changed?: number; total?: number; area?: { x: number; y: number; width: number; height: number } | null; sizeChanged?: boolean };
    ariaChanges: string[];
    layoutChanges: Array<{ element: string; type: string; before?: Box; after?: Box }>;
    files: { baseline: string | null; actual: string | null; diff: string | null };
    reviewed?: { action: 'approved' | 'accepted'; at: string };
    /** What the reviewer saw (sent back with approve/accept: a newer run in between is refused). */
    baselineSha: string; actualSha: string | null;
}
type Box = { x: number; y: number; width: number; height: number };

export interface AriaSnapshot {
    dir: string; name: string; key: string;
    status: 'changed' | 'same';
    baseline: string; actual: string | null;
    /** The changed snapshot's sha256 (sent back with approve). */
    actualSha?: string;
    /** Line by line (baseline → actual), when it changed. */
    diff?: DiffLine[];
    at?: string;
}
export interface DiffLine { kind: 'same' | 'add' | 'del'; text: string }

export interface A11yViolation { id: string; impact: string; description: string; element?: string; help?: string; helpUrl?: string }
export interface A11yCheck {
    url: string; scenario?: string; feature?: string; at: string; run: string;
    passed: boolean; violations: A11yViolation[]; passes?: number;
}

export interface ReviewDecision { action: 'approved' | 'accepted'; at: string; sha: string }

const IGNORE = new Set(['node_modules', '.git', 'dist', 'reports']);

/** The values of a setting in the project's env files (config/**), with its default; folders that exist. */
export function configuredDirs(root: string, key: string, fallback: string): string[] {
    const found = new Set<string>([fallback]);
    const walk = (dir: string, depth: number) => {
        if (depth > 5) return;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const p = path.join(dir, e.name);
            if (e.isDirectory() && !IGNORE.has(e.name)) walk(p, depth + 1);
            else if (e.isFile() && e.name.endsWith('.env')) {
                let text = '';
                try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
                const m = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, 'm').exec(text);
                if (m) found.add(m[1].replace(/^["']|["']$/g, ''));
            }
        }
    };
    walk(path.join(root, 'config'), 0);
    const out: string[] = [];
    for (const v of found) {
        if (!v || v.includes('{')) continue;
        const abs = path.resolve(root, v);
        const rel = path.relative(root, abs);
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
        if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) out.push(rel.split(path.sep).join('/'));
    }
    return [...new Set(out)].sort();
}

const sha = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const exists = (p: string) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

/** A change the reviewer did not see (a run finished meanwhile). */
export class StaleReview extends Error {}

/**
 * The real path of p, which must be inside the real repository folder (a symbolic link pointing out of it is
 * refused). For a file to be written, `write`: it must not be a link itself.
 */
export function insideRepo(root: string, p: string, write = false): string {
    const realRoot = fs.realpathSync(root);
    const dir = fs.realpathSync(path.dirname(p));
    const full = path.join(dir, path.basename(p));
    let target = full;
    if (fs.existsSync(full)) {
        if (write && fs.lstatSync(full).isSymbolicLink()) throw new Error(`${path.basename(p)} is a link: not written.`);
        target = fs.realpathSync(full);
    }
    const rel = path.relative(realRoot, target);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Outside the repository.');
    return target;
}
const readJson = (p: string): Record<string, any> | null => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

/** The visual snapshots of the folders, with what their last comparison saw. */
export function visualSnapshots(root: string, dirs: string[], decisions: Record<string, ReviewDecision>): VisualSnapshot[] {
    const out: VisualSnapshot[] = [];
    for (const dir of dirs) {
        const base = path.join(root, dir);
        let names: string[] = [];
        try { names = fs.readdirSync(path.join(base, 'baseline')).filter((f) => f.endsWith('.pixel-hash')).map((f) => f.slice(0, -'.pixel-hash'.length)); } catch { continue; }
        for (const name of names) {
            const key = `${dir}/${name}`;
            const rel = (sub: string, file: string) => (exists(path.join(base, sub, file)) ? `${dir}/${sub}/${file}` : null);
            const baselinePng = path.join(base, 'baseline', `${name}.png`), actualPng = path.join(base, 'actual', `${name}.png`);
            const r = readJson(path.join(base, 'diff', `${name}.smart-result.json`));
            const baselineSha = (() => { try { return fs.readFileSync(path.join(base, 'baseline', `${name}.pixel-hash`), 'utf8').trim(); } catch { return ''; } })();
            const actualSha = exists(actualPng) ? sha(actualPng) : null;
            const d = decisions[key];
            const reviewed = d && d.sha === baselineSha ? { action: d.action, at: d.at } : undefined;
            // A comparison from before the baseline was last written (a baseline update since) no longer applies.
            const baselineAt = (() => { try { return fs.statSync(path.join(base, 'baseline', `${name}.pixel-hash`)).mtimeMs; } catch { return 0; } })();
            const stale = !!(r?.timestamp && Date.parse(String(r.timestamp)) < baselineAt - 1000);
            let status: VisualStatus;
            if (r && r.passed === false && !stale && actualSha) status = 'changed'; // also the same picture with another structure (an alt text)
            else if (!actualSha || actualSha === baselineSha || stale) status = r?.baselineCreated && !reviewed && !stale ? 'new' : 'same';
            else if (r && r.passed === true) status = 'cosmetic';
            else status = 'changed';
            const px = r?.pixelResult;
            out.push({
                dir, name, key, status,
                ...(r ? { verdict: String(r.verdict ?? ''), message: String(r.message ?? ''), passed: r.passed === true, ...(r.timestamp ? { at: String(r.timestamp) } : {}) } : {}),
                ...(r?.scenario ? { scenario: String(r.scenario) } : {}), ...(r?.feature ? { feature: String(r.feature) } : {}),
                ...(name.includes('_region_') ? { region: true } : {}),
                ...(px && typeof px.diffPercentage === 'number' && (status === 'changed' || status === 'cosmetic') ? { pixels: { percent: px.diffPercentage, changed: px.changedPixels, total: px.totalPixels, area: px.changedArea ?? null, sizeChanged: !!px.sizeChanged } } : {}),
                ariaChanges: status === 'same' || status === 'new' ? [] : (Array.isArray(r?.structuralResult?.ariaChanges) ? r!.structuralResult.ariaChanges.map(String) : []),
                layoutChanges: status === 'same' || status === 'new' ? [] : (Array.isArray(r?.structuralResult?.layoutChanges) ? r!.structuralResult.layoutChanges.slice(0, 200).map((c: Record<string, any>) => ({ element: String(c.element ?? ''), type: String(c.type ?? ''), ...(c.before ? { before: c.before } : {}), ...(c.after ? { after: c.after } : {}) })) : []),
                files: {
                    baseline: exists(baselinePng) ? `${dir}/baseline/${name}.png` : null,
                    actual: actualSha && actualSha !== baselineSha && !stale ? `${dir}/actual/${name}.png` : null,
                    diff: actualSha && actualSha !== baselineSha && !stale ? rel('diff', `${name}.diff.png`) : null,
                },
                ...(reviewed ? { reviewed } : {}),
                baselineSha, actualSha,
            });
        }
    }
    const order: Record<VisualStatus, number> = { changed: 0, new: 1, cosmetic: 2, same: 3 };
    return out.sort((a, b) => order[a.status] - order[b.status] || (b.at ?? '').localeCompare(a.at ?? '') || a.key.localeCompare(b.key));
}

/**
 * Make the last run's screenshot (and its hashes and structure) the baseline of a snapshot. Returns the new
 * baseline's sha256.
 */
export function approveVisual(root: string, dir: string, name: string, expectedActualSha?: string): string {
    const base = path.join(root, dir);
    const actual = path.join(base, 'actual', `${name}.png`);
    if (!exists(actual)) throw new Error(`No screenshot of "${name}" from a run to approve.`);
    const from = (ext: string) => insideRepo(root, path.join(base, 'actual', `${name}${ext}`));
    const baseline = (ext: string) => insideRepo(root, path.join(base, 'baseline', `${name}${ext}`), true);
    const png = fs.readFileSync(from('.png'));
    const hash = crypto.createHash('sha256').update(png).digest('hex');
    if (expectedActualSha && hash !== expectedActualSha) throw new StaleReview(`A newer run changed the screenshot of "${name}": look at it again before approving.`);
    fs.writeFileSync(baseline('.png'), png);
    fs.writeFileSync(baseline('.pixel-hash'), hash);
    // The hashes and structure of the approved run; one it did not compute (a tier switched off then) goes, so
    // a later run is not compared with the page from before.
    for (const ext of ['.phash', '.dct-phash', '.structural.json', '.aria.yaml']) {
        const src = path.join(base, 'actual', `${name}${ext}`);
        if (exists(src)) fs.copyFileSync(from(ext), baseline(ext));
        else if (exists(path.join(base, 'baseline', `${name}${ext}`))) fs.unlinkSync(baseline(ext));
    }
    // Tolerances the framework learned for it (VISUAL_AI_LEARNED_TOLERANCE_ENABLED) describe the old picture.
    forgetLearnedScores(root, name);
    // The comparison with the old baseline no longer applies (the next run writes a new one).
    for (const f of [`${name}.diff.png`, `${name}.smart-result.json`, `${name}.structural-diff.json`]) {
        const p = path.join(base, 'diff', f);
        if (exists(p)) fs.unlinkSync(insideRepo(root, p));
    }
    return hash;
}

/** Remove a snapshot's learned scores from the framework's tolerance store (VISUAL_AI_BASELINE_STORE_DIR). */
export function forgetLearnedScores(root: string, name: string): void {
    for (const dir of configuredDirs(root, 'VISUAL_AI_BASELINE_STORE_DIR', '.cs-visual-baseline-store')) {
        const file = path.join(root, dir, 'baseline-tolerances.json');
        const data = readJson(file);
        if (!data || typeof data.entries !== 'object' || !data.entries) continue;
        const keys = Object.keys(data.entries).filter((k) => k.startsWith(`${name}__`));
        if (!keys.length) continue;
        for (const k of keys) delete data.entries[k];
        fs.writeFileSync(insideRepo(root, file, true), JSON.stringify(data, null, 2));
    }
}

/** Line diff (longest common subsequence; long files compared by their changed middle). */
export function lineDiff(a: string[], b: string[]): DiffLine[] {
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length, endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
    const x = a.slice(start, endA), y = b.slice(start, endB);
    const head = a.slice(0, start).map((text) => ({ kind: 'same' as const, text }));
    const tail = a.slice(endA).map((text) => ({ kind: 'same' as const, text }));
    if (x.length * y.length > 4_000_000) return [...head, ...x.map((text) => ({ kind: 'del' as const, text })), ...y.map((text) => ({ kind: 'add' as const, text })), ...tail];
    const t: number[][] = Array.from({ length: x.length + 1 }, () => new Array(y.length + 1).fill(0));
    for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) t[i][j] = x[i] === y[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
    const mid: DiffLine[] = [];
    let i = 0, j = 0;
    while (i < x.length || j < y.length) {
        if (i < x.length && j < y.length && x[i] === y[j]) { mid.push({ kind: 'same', text: x[i] }); i++; j++; }
        else if (i < x.length && (j >= y.length || t[i + 1][j] >= t[i][j + 1])) { mid.push({ kind: 'del', text: x[i] }); i++; }
        else { mid.push({ kind: 'add', text: y[j] }); j++; }
    }
    return [...head, ...mid, ...tail];
}

/** The aria snapshots of the folders (changed: the last comparison left an .actual.yaml). */
export function ariaSnapshots(root: string, dirs: string[]): AriaSnapshot[] {
    const out: AriaSnapshot[] = [];
    for (const dir of dirs) {
        let files: string[] = [];
        try { files = fs.readdirSync(path.join(root, dir)); } catch { continue; }
        for (const f of files.filter((n) => n.endsWith('.yaml') && !n.endsWith('.actual.yaml'))) {
            const name = f.slice(0, -'.yaml'.length);
            const actualFile = path.join(root, dir, `${name}.actual.yaml`);
            const changed = exists(actualFile);
            const snap: AriaSnapshot = { dir, name, key: `${dir}/${name}`, status: changed ? 'changed' : 'same', baseline: `${dir}/${f}`, actual: changed ? `${dir}/${name}.actual.yaml` : null, ...(changed ? { actualSha: sha(actualFile) } : {}) };
            if (changed) {
                const lines = (p: string) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n').split('\n');
                snap.diff = lineDiff(lines(path.join(root, dir, f)), lines(actualFile));
                snap.at = fs.statSync(actualFile).mtime.toISOString();
            }
            out.push(snap);
        }
    }
    return out.sort((a, b) => (a.status === b.status ? a.key.localeCompare(b.key) : a.status === 'changed' ? -1 : 1));
}

/** Make the last run's aria snapshot the baseline. */
export function approveAria(root: string, dir: string, name: string, expectedActualSha?: string): void {
    const actualPath = path.join(root, dir, `${name}.actual.yaml`);
    if (!exists(actualPath)) throw new Error(`No changed aria snapshot "${name}" to approve.`);
    const actual = insideRepo(root, actualPath);
    const text = fs.readFileSync(actual);
    if (expectedActualSha && crypto.createHash('sha256').update(text).digest('hex') !== expectedActualSha) throw new StaleReview(`A newer run changed the accessibility snapshot "${name}": look at it again before approving.`);
    fs.writeFileSync(insideRepo(root, path.join(root, dir, `${name}.yaml`), true), text);
    fs.unlinkSync(actualPath);
}

/**
 * The accessibility checks the runs recorded (results folders' accessibility/*.json): for each page (and
 * scenario), the latest one.
 */
export function accessibilityChecks(resultsFolders: Array<{ folder: string; run: string }>): A11yCheck[] {
    const latest = new Map<string, A11yCheck>();
    for (const { folder, run } of resultsFolders) {
        let files: string[] = [];
        try { files = fs.readdirSync(path.join(folder, 'accessibility')).filter((f) => f.endsWith('.json')); } catch { continue; }
        for (const f of files) {
            const r = readJson(path.join(folder, 'accessibility', f));
            if (!r || r.check !== 'violations') continue;
            const c: A11yCheck = {
                url: String(r.url ?? ''), at: String(r.timestamp ?? ''), run, passed: r.passed === true,
                ...(r.scenario ? { scenario: String(r.scenario) } : {}), ...(r.feature ? { feature: String(r.feature) } : {}),
                violations: (Array.isArray(r.violations) ? r.violations : []).map((v: Record<string, unknown>) => ({
                    id: String(v.id ?? ''), impact: String(v.impact ?? 'minor'), description: String(v.description ?? ''),
                    ...(v.element ? { element: String(v.element) } : {}), ...(v.help ? { help: String(v.help) } : {}),
                    ...(typeof v.helpUrl === 'string' && /^https:\/\//.test(v.helpUrl) ? { helpUrl: v.helpUrl } : {}),
                })),
                ...(typeof r.passes === 'number' ? { passes: r.passes } : {}),
            };
            const key = `${c.url}\u0000${c.scenario ?? ''}`;
            const prev = latest.get(key);
            if (!prev || prev.at < c.at) latest.set(key, c);
        }
    }
    const rank: Record<string, number> = { critical: 0, serious: 1, moderate: 2, minor: 3 };
    const worst = (c: A11yCheck) => Math.min(4, ...c.violations.map((v) => rank[v.impact] ?? 4));
    return [...latest.values()].sort((a, b) => worst(a) - worst(b) || b.violations.length - a.violations.length || b.at.localeCompare(a.at));
}
