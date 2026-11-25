/**
 * What can be run: every feature file of the repository with its title, tags and scenarios, so the
 * Run screen can offer "pick features, then (optionally) tags or scenarios of those features".
 *
 * How the framework selects (verified in CSBDDRunner / index.ts of the framework):
 *  - --features=a,b: those files (or folders/globs).
 *  - Without --features: test/<project>/features when it exists, else FEATURE_PATH, else test/features.
 *  - --tags=@a,@b: scenarios having ANY of the tags (feature tags count for every scenario).
 *    No boolean expressions ("and", "not") and no exclude option on the command line.
 *  - --scenarios=n1,n2: exact names (case-insensitive, with substring fallbacks for outlines).
 *  - @enabled:false on a feature or scenario skips it.
 */
import { gherkinFor, gherkinProblems } from '../lang/gherkin';
import * as fs from 'fs';
import * as path from 'path';

export interface CatalogScenario { name: string; line: number; tags: string[]; outline: boolean; examples: number }
export interface CatalogFeature { path: string; name: string; tags: string[]; scenarios: CatalogScenario[]; /** The framework cannot parse it (it is left out of runs): the first problem. */ parseError?: string }

const SKIP = new Set(['node_modules', 'reports', 'dist', 'build', 'coverage', 'test-results', '.git']);
const TAGS = /^\s*(@\S+(\s+@\S+)*)\s*(#.*)?$/;

/** Parse the parts of a feature file that matter for choosing what to run. */
export function parseFeatureOutline(text: string, file: string): CatalogFeature | null {
    const lines = text.split(/\r?\n/);
    let pending: string[] = [];
    let feature: CatalogFeature | null = null;
    let doc: string | null = null;
    let current: CatalogScenario | null = null;
    let inExamples = false;
    let examplesHeader = false;
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const t = raw.trim();
        if (doc) { if (t.startsWith(doc)) doc = null; continue; }
        if (t.startsWith('"""') || t.startsWith('```')) { doc = t.slice(0, 3); continue; }
        if (!t || t.startsWith('#')) continue;
        const tm = TAGS.exec(t);
        if (tm) { pending.push(...tm[1].split(/\s+/)); continue; }
        const kw = /^(Feature|Rule|Background|Scenario Outline|Scenario Template|Scenario|Example|Examples|Scenarios):\s*(.*)$/.exec(t);
        if (kw) {
            const [, k, name] = kw;
            if (k === 'Feature') { feature = { path: file, name: name.trim(), tags: pending, scenarios: [] }; }
            else if (k === 'Scenario' || k === 'Example' || k === 'Scenario Outline' || k === 'Scenario Template') {
                current = { name: name.trim(), line: i + 1, tags: pending, outline: k === 'Scenario Outline' || k === 'Scenario Template', examples: 0 };
                feature?.scenarios.push(current);
                inExamples = false;
            } else if (k === 'Examples' || k === 'Scenarios') { inExamples = true; examplesHeader = true; }
            else { current = k === 'Background' || k === 'Rule' ? null : current; inExamples = false; }
            pending = [];
            continue;
        }
        if (inExamples && current && t.startsWith('|')) {
            if (examplesHeader) examplesHeader = false; else current.examples++;
        }
    }
    return feature;
}

/** All feature files of the repository (relative paths, sorted). */
export function readCatalog(repoRoot: string): CatalogFeature[] {
    const out: CatalogFeature[] = [];
    const gherkin = gherkinFor(repoRoot);
    const walk = (dir: string, depth: number) => {
        if (depth > 12 || out.length > 5000) return;
        let entries: fs.Dirent[] = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (e.name.startsWith('.')) continue;
            const a = path.join(dir, e.name);
            if (e.isDirectory()) { if (!SKIP.has(e.name) && !/^test-results-/.test(e.name)) walk(a, depth + 1); }
            else if (e.isFile() && e.name.endsWith('.feature')) {
                let text = '';
                try { if (fs.statSync(a).size > 2 * 1024 * 1024) continue; text = fs.readFileSync(a, 'utf8'); } catch { continue; }
                const rel = path.relative(repoRoot, a).split(path.sep).join('/');
                const f = parseFeatureOutline(text, rel);
                if (f) {
                    const p = gherkinProblems(text, gherkin);
                    if (p.length) f.parseError = `line ${p[0].line}: ${p[0].message.replace(/^The framework cannot parse this feature, so it is left out of the run: /, '')}`;
                    out.push(f);
                }
            }
        }
    };
    walk(repoRoot, 0);
    return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** The folder the framework runs for a project when no features are given (if it exists). */
export function projectFeatureFolder(repoRoot: string, project: string): string | null {
    if (!project || /[\\/]|\.\./.test(project)) return null;
    const rel = `test/${project}/features`;
    return fs.existsSync(path.join(repoRoot, rel)) ? rel : null;
}

/** A feature or scenario switched off with @enabled:false (the framework skips it). */
export const disabledByTag = (tags: string[]) => tags.some((t) => /^@?enabled:\s*(false|no|0)$/i.test(t));
