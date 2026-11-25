/**
 * Mirrors how the framework builds its configuration (CSConfigurationManager.initialize), so the
 * Studio can show exactly which file each value comes from and what a run will see.
 *
 * Load order (later wins), taken from the framework CODE (its doc comment differs slightly):
 *   1. config/global.env
 *   2. config/common/common.env
 *   3. every other config/common/*.env (sorted)
 *   4. config/common/environments/<env>.env
 *   5. config/<project>/common/common.env
 *   6. every other config/<project>/common/*.env (sorted)
 *   7. every config/<project>/*.env (sorted, top level only)
 *   8. config/<project>/environments/<env>.env
 *   9. process environment variables  (the Studio adds your stored secrets here)
 *  10. command-line arguments
 * Files are parsed with dotenv (same library and major version as the framework).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

export interface Layer {
    /** Repo-relative path with forward slashes, or a pseudo-source for env/CLI. */
    source: string;
    kind: 'file' | 'process-env' | 'secret' | 'cli';
    /** Human label, e.g. "Project environment (qa)". */
    label: string;
    exists: boolean;
    values: Record<string, string>;
    /** 1-based line where each key is (last) defined, for files. */
    lines: Record<string, number>;
}

export const CONFIG_DIR = 'config';
const NON_PROJECT_DIRS = new Set(['common', 'environments']);

const rel = (...p: string[]) => [CONFIG_DIR, ...p].join('/');

function envFilesIn(repoRoot: string, dir: string, exclude: string[] = []): string[] {
    const abs = path.join(repoRoot, dir);
    if (!fs.existsSync(abs)) return [];
    return fs.readdirSync(abs, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith('.env') && !exclude.includes(e.name))
        .map((e) => e.name)
        .sort() // framework uses Array.prototype.sort() — code-unit order, same as here
        .map((n) => `${dir}/${n}`);
}

/** The ordered file list the framework would load for a project + environment. */
export function fileLayerPaths(repoRoot: string, project: string, environment: string): Array<{ source: string; label: string }> {
    const out: Array<{ source: string; label: string }> = [];
    out.push({ source: rel('global.env'), label: 'Global defaults' });
    out.push({ source: rel('common', 'common.env'), label: 'Common' });
    for (const f of envFilesIn(repoRoot, rel('common'), ['common.env'])) out.push({ source: f, label: `Common (${path.basename(f)})` });
    out.push({ source: rel('common', 'environments', `${environment}.env`), label: `Common environment (${environment})` });
    out.push({ source: rel(project, 'common', 'common.env'), label: 'Project common' });
    for (const f of envFilesIn(repoRoot, rel(project, 'common'), ['common.env'])) out.push({ source: f, label: `Project common (${path.basename(f)})` });
    for (const f of envFilesIn(repoRoot, rel(project), ['common.env'])) out.push({ source: f, label: `Project (${path.basename(f)})` });
    out.push({ source: rel(project, 'environments', `${environment}.env`), label: `Project environment (${environment})` });
    return out;
}

/** Line of the LAST definition of each key (dotenv: later duplicates win). */
export function keyLines(text: string): Record<string, number> {
    const lines: Record<string, number> = {};
    const re = /^\s*(?:export\s+)?([\w.-]+)\s*[=:]/;
    text.split(/\r?\n/).forEach((l, i) => {
        const m = re.exec(l);
        if (m) lines[m[1]] = i + 1;
    });
    return lines;
}

export function readFileLayer(repoRoot: string, source: string, label: string): Layer {
    const abs = path.join(repoRoot, source);
    if (!fs.existsSync(abs)) return { source, kind: 'file', label, exists: false, values: {}, lines: {} };
    const text = fs.readFileSync(abs, 'utf8');
    return { source, kind: 'file', label, exists: true, values: dotenv.parse(text), lines: keyLines(text) };
}

export interface ProjectsAndEnvironments {
    projects: string[];
    /** Environments per project (union of common and project environment files). */
    environments: Record<string, string[]>;
    commonEnvironments: string[];
}

function envNames(repoRoot: string, dir: string): string[] {
    return envFilesIn(repoRoot, dir).map((f) => path.basename(f, '.env'));
}

export function discover(repoRoot: string): ProjectsAndEnvironments {
    const cfg = path.join(repoRoot, CONFIG_DIR);
    const commonEnvironments = envNames(repoRoot, rel('common', 'environments'));
    const projects: string[] = [];
    const environments: Record<string, string[]> = {};
    if (fs.existsSync(cfg)) {
        for (const e of fs.readdirSync(cfg, { withFileTypes: true })) {
            if (!e.isDirectory() || NON_PROJECT_DIRS.has(e.name)) continue;
            const dir = rel(e.name);
            const hasEnv = envFilesIn(repoRoot, dir).length > 0
                || fs.existsSync(path.join(repoRoot, dir, 'environments'))
                || fs.existsSync(path.join(repoRoot, dir, 'common'));
            if (!hasEnv) continue; // e.g. config/report-specs holds other files
            projects.push(e.name);
            environments[e.name] = [...new Set([...commonEnvironments, ...envNames(repoRoot, rel(e.name, 'environments'))])].sort();
        }
    }
    projects.sort();
    return { projects, environments, commonEnvironments };
}
