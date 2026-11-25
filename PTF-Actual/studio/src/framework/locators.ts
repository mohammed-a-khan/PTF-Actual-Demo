/**
 * Element locators as the project's CS Playwright Test Framework resolves them.
 *
 * What the framework's CSWebElement uses to find an element (and the only options the Studio writes):
 *  - id        → `#id`                      testId → getByTestId (frames: [data-testid="…"])
 *  - name      → `[name="…"]`               text   → getByText (frames: text=…)
 *  - role      → getByRole; with an accessible name (`button[name="Pay"]`) only in framework versions that
 *                have CSRoleSelector (role + name support)
 *  - css / xpath, and `alternativeLocators` with the prefixes css: xpath: text: testId: role: placeholder:
 *    (tried in order; `selfHeal: true` reports a healed element).
 * Options the decorator accepts but CSWebElement does not use to find an element (label, placeholder,
 * title, alt, className…) are never written.
 *
 * Scores come from the project's own locator linter (CSLocatorScorer), so the Studio ranks locators exactly
 * as the framework's `cs-playwright-locator-lint` grades them.
 */
import * as fs from 'fs';
import * as path from 'path';
import { frameworkPackage } from './package';


/** A framework locator strategy and its value, as written in @CSGetElement. */
export interface FwLocator { key: 'testId' | 'id' | 'name' | 'role' | 'text' | 'placeholder'; value: string; score: number }

type Scorer = (strategy: string, value: string) => { score: number; tier: string; reasons: string[]; suggestions: string[] };

export interface LocatorSupport {
    /** The framework finds `role: 'button[name="Pay"]'` (role + accessible name). */
    roleNames: boolean;
    /** The framework linter's score for a strategy and value. */
    score: (strategy: string, value: string) => number;
    /** The linter itself (null in framework versions without it). */
    scorer: Scorer | null;
    /** The linter's parser (reads @CSGetElement blocks and raw page.locator calls of a file). */
    parseFile: ((absPath: string, repoRoot: string) => { decorators: Array<{ options: Array<{ key: string; value: string; line: number }>; alternatives: Array<{ value: string; line: number }> }>; rawCalls: Array<{ line: number; value: string }> }) | null;
}

/** The project's framework package folder (any scope: see frameworkPackage). */
export function frameworkDir(repoRoot: string): string | null {
    return frameworkPackage(repoRoot)?.dir ?? null;
}

// The linter's base scores (CSLocatorScorer), for framework versions without the linter.
const BASE: Record<string, number> = { testId: 100, id: 100, name: 95, role: 85, placeholder: 80, text: 70, css: 45, xpath: 40 };

const load = <T>(file: string): T | null => { try { return fs.existsSync(file) ? (require(file) as T) : null; } catch { return null; } };

export function locatorSupport(repoRoot: string): LocatorSupport {
    const dir = frameworkDir(repoRoot);
    const dist = dir ? path.join(dir, 'dist') : '';
    const scorer = dir ? load<{ scoreLocator: Scorer }>(path.join(dist, 'locator-lint', 'CSLocatorScorer.js'))?.scoreLocator ?? null : null;
    const parser = dir ? load<{ parseFile: LocatorSupport['parseFile'] }>(path.join(dist, 'locator-lint', 'CSLocatorParser.js'))?.parseFile ?? null : null;
    return {
        roleNames: !!dir && fs.existsSync(path.join(dist, 'element', 'CSRoleSelector.js')),
        scorer,
        parseFile: parser,
        score: (strategy, value) => {
            if (scorer) { try { return scorer(strategy, value).score; } catch { /* as below */ } }
            return BASE[strategy] ?? 45;
        },
    };
}

/** A value inside "…" of a role name: backslashes and quotes escaped (the framework's parser unescapes them). */
export const roleName = (role: string, name: string, exact: boolean) => `${role}[name="${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"${exact ? 's' : ''}]`;

/** An alternative locator entry as the framework reads it (alternativeLocators). */
export function alternativeOf(l: Pick<FwLocator, 'key' | 'value'>): string {
    switch (l.key) {
        case 'testId': return `testId:${l.value}`;
        case 'role': return `role:${l.value}`;
        case 'text': return `text:${l.value}`;
        case 'placeholder': return `placeholder:${l.value}`;
        case 'id': return `css:#${l.value}`;
        case 'name': return `css:[name="${l.value}"]`;
    }
}

/** The lowest score the framework's locator linter accepts (LOCATOR_LINT_MIN_SCORE, default 60). */
export const LINT_MIN_SCORE = 60;

/**
 * The project's locator policy for recorded elements (config/<project>/common/common.env):
 *  - RECORDER_LOCATOR_ORDER: strategies in the order the team prefers them (e.g. "testId,role,name,id,text");
 *    unlisted ones come after, by the linter's score.
 *  - RECORDER_IGNORE_ID_PATTERN: ids that change between builds or sessions (a regular expression, e.g.
 *    "^(mat-|cdk-|ext-)" or "\\d{3,}"): never used to find an element.
 *  - RECORDER_IGNORE_CLASS_PATTERN: classes never used in CSS paths (generated, styling).
 */
export interface LocatorPolicy { order?: FwLocator['key'][]; ignoreId?: RegExp; ignoreClass?: RegExp }

const FW_KEYS: FwLocator['key'][] = ['testId', 'id', 'name', 'role', 'text', 'placeholder'];

/** The policy from a project's config values; problems (a pattern that is not a regular expression) as notes. */
export function locatorPolicy(values: Record<string, string | undefined>): { policy: LocatorPolicy; problems: string[] } {
    const problems: string[] = [];
    const re = (k: string): RegExp | undefined => {
        const v = (values[k] ?? '').trim();
        if (!v) return undefined;
        // Short, and no nested repetition ((a+)+): it runs on every element of the application's pages.
        if (v.length > 200 || /\([^)]*[+*][^)]*\)\s*[+*{]/.test(v)) { problems.push(`${k} is not used: keep it short and without nested repetition such as (a+)+.`); return undefined; }
        try { return new RegExp(v); } catch { problems.push(`${k} is not a regular expression: ${v}`); return undefined; }
    };
    const order = (values.RECORDER_LOCATOR_ORDER ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    const bad = order.filter((x) => !FW_KEYS.includes(x as FwLocator['key']));
    if (bad.length) problems.push(`RECORDER_LOCATOR_ORDER: unknown ${bad.join(', ')} (use ${FW_KEYS.join(', ')}).`);
    const policy: LocatorPolicy = {};
    const ok = order.filter((x): x is FwLocator['key'] => FW_KEYS.includes(x as FwLocator['key']));
    if (ok.length) policy.order = [...new Set(ok)];
    const id = re('RECORDER_IGNORE_ID_PATTERN'), cls = re('RECORDER_IGNORE_CLASS_PATTERN');
    if (id) policy.ignoreId = id;
    if (cls) policy.ignoreClass = cls;
    return { policy, problems };
}

/** Locators without those the policy ignores, best first: the policy's order, then the linter's score. */
export function rankLocators(list: FwLocator[], policy?: LocatorPolicy): FwLocator[] {
    const kept = list.filter((x) => !(policy?.ignoreId && x.key === 'id' && policy.ignoreId.test(x.value)));
    const rank = (k: FwLocator['key']) => { const i = policy?.order?.indexOf(k) ?? -1; return i < 0 ? Infinity : i; };
    return kept.map((x, i) => ({ x, i })).sort((a, b) => (rank(a.x.key) - rank(b.x.key)) || (b.x.score - a.x.score) || (a.i - b.i)).map((y) => y.x);
}
