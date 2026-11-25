/**
 * The CS Playwright Test Framework package of a repository. It is published as
 * @mdakhan.mak/cs-playwright-test-framework, and may also be published under another npm scope (an
 * organisation's own registry): any @<scope>/cs-playwright-test-framework. The Studio loads the one the
 * repository has installed and code it writes imports from that name.
 */
import * as fs from 'fs';
import * as path from 'path';

export const DEFAULT_FRAMEWORK_PACKAGE = '@mdakhan.mak/cs-playwright-test-framework';
const NAME = 'cs-playwright-test-framework';
/** A framework package name: the published one, or the framework under any scope. */
export const isFrameworkPackage = (name: string) => name === NAME || /^@[\w.-]+\/cs-playwright-test-framework$/.test(name);

/** The framework packages the repository's package.json depends on. */
function declared(repoRoot: string): string[] {
    try {
        const j = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
        return ['dependencies', 'devDependencies', 'peerDependencies'].flatMap((k) => Object.keys(j[k] ?? {})).filter(isFrameworkPackage);
    } catch { return []; }
}

/** The framework packages installed in a node_modules folder (the published name first). */
function installedIn(nodeModules: string): Array<{ name: string; dir: string }> {
    const out: Array<{ name: string; dir: string }> = [];
    const add = (name: string, dir: string) => { if (fs.existsSync(path.join(dir, 'package.json'))) out.push({ name, dir }); };
    add(NAME, path.join(nodeModules, NAME));
    let scopes: string[] = [];
    try { scopes = fs.readdirSync(nodeModules).filter((d) => d.startsWith('@')); } catch { return out; }
    for (const s of scopes) add(`${s}/${NAME}`, path.join(nodeModules, s, NAME));
    return out.sort((a, b) => Number(b.name === DEFAULT_FRAMEWORK_PACKAGE) - Number(a.name === DEFAULT_FRAMEWORK_PACKAGE));
}

/**
 * The installed framework package (its name and folder): in the repository's node_modules or one above it
 * (hoisted workspaces); the one its package.json names when several are installed. Null when none is.
 */
export function frameworkPackage(repoRoot: string): { name: string; dir: string } | null {
    const want = declared(repoRoot);
    for (let dir = path.resolve(repoRoot); ; dir = path.dirname(dir)) {
        const here = installedIn(path.join(dir, 'node_modules'));
        if (here.length) return here.find((p) => want.includes(p.name)) ?? here[0];
        if (path.dirname(dir) === dir) return null;
    }
}

/** The package name code the Studio writes imports from (the installed one, else the declared one, else the default). */
export function frameworkPackageName(repoRoot: string): string {
    return frameworkPackage(repoRoot)?.name ?? declared(repoRoot)[0] ?? DEFAULT_FRAMEWORK_PACKAGE;
}
