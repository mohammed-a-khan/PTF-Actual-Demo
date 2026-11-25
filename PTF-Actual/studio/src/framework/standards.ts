/**
 * The framework's standards, checked on every plan before anything is written (the same rules for
 * the Recorder, the API and Database screens, agents and new projects):
 *  - undefined-step: every feature line has a step definition the project loads (its own, the
 *    framework's, or one the same plan adds); data-driven lines are checked with sample values.
 *  - step-not-loaded: a line is defined only in a file the framework does not load.
 *  - steps-folder-not-loaded: a planned step file sits in a folder STEP_DEFINITIONS_PATH does not
 *    load (and the plan does not add it).
 *  - duplicate-step: a new definition repeats the wording of an existing one.
 *  - secret-in-file: a secret value (from the Studio's secret store) appears in a file.
 *  - plain-password: a password-like key with a readable value in test data or configuration.
 *  - hard-coded-url: an address in a feature, page or step instead of a configuration key.
 *  - naming: feature, page, step and data file names the framework and the team expect.
 *  - invalid-data: a test data file that is not valid JSON.
 *  - fragile-locator: a new element located by position, generated class names or a long chain.
 *  - empty-feature: a feature without scenarios.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as TS from 'typescript';
import { closestHint, extractStepDefs, featureSteps, isStepFile, matches, StepDef } from '../lang/steps';
import { parsePageObject } from './code';
import { LINT_MIN_SCORE, locatorSupport } from './locators';
import type { ProjectModel } from './model';
import type { ChangePlan, Finding } from './plan';

export const SENSITIVE_KEY = /pass(word|code|phrase)?|pwd|secret|\bpin\b|otp|token|api.?key|ssn|card.?number|cvv|security.?code/i;
const SAFE_VALUE = /^(ENCRYPTED:|\{env:|\{config:|<[^>]+>$|\$\{|__CS_ENCRYPT_\d+__$|\*+$)/;

const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length;
const isComment = (l: string) => /^\s*(\/\/|\*|\/\*|#)/.test(l);

/** A step's variants with <placeholders> filled with sample values (text first, then a number). */
function samples(v: string): string[] {
    if (!/<[^<>\s]+>/.test(v)) return [v];
    return [v.replace(/<[^<>\s]+>/g, 'x'), v.replace(/<[^<>\s]+>/g, '1')];
}

export interface CheckOptions {
    /** Values of the Studio's secrets: none may appear in a file. */
    secretValues?: string[];
    /** A file as it is now (null: new). Line checks report only what the change adds. */
    before?: (path: string) => string | null;
    /** The repository: its framework's locator linter checks the page objects (when the framework has one). */
    repoRoot?: string;
}

/**
 * The framework's own locator linter (cs-playwright-locator-lint: its parser and scores) on a page object
 * file: the locators the new text has that the old one did not, below the linter's minimum, and raw
 * page.locator() calls (the framework's policy). Null when the project's framework has no linter.
 */
function frameworkLint(repoRoot: string, file: string, text: string, before: string | null): Finding[] | null {
    const sup = locatorSupport(repoRoot);
    if (!sup.parseFile || !sup.scorer) return null;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-lint-'));
    const read = (t: string) => {
        const abs = path.join(dir, 'Page.ts');
        fs.writeFileSync(abs, t);
        const r = sup.parseFile!(abs, dir);
        const locs: Array<{ strategy: string; value: string; line: number }> = [];
        for (const d of r.decorators) {
            for (const o of d.options) locs.push({ strategy: o.key, value: o.value, line: o.line });
            for (const a of d.alternatives) locs.push({ strategy: altStrategy(a.value), value: a.value, line: a.line });
        }
        return { locs, raw: r.rawCalls };
    };
    try {
        const now = read(text);
        const old = before ? read(before) : { locs: [], raw: [] };
        const had = new Set(old.locs.map((l) => `${l.strategy}\u0000${l.value}`));
        const out: Finding[] = [];
        for (const l of now.locs.filter((x) => !had.has(`${x.strategy}\u0000${x.value}`))) {
            const s = sup.scorer!(l.strategy, l.value);
            if (s.score >= LINT_MIN_SCORE) continue;
            out.push({ level: s.tier === 'anti-pattern' ? 'error' : 'warning', rule: 'locator-lint', file, line: l.line,
                message: `The framework's locator linter scores ${l.strategy} "${l.value.slice(0, 80)}" ${s.score} (${s.tier}): ${s.suggestions[0] ?? s.reasons[s.reasons.length - 1] ?? ''}` });
        }
        const hadRaw = new Set(old.raw.map((r) => r.value));
        for (const r of now.raw.filter((x) => !hadRaw.has(x.value))) out.push({ level: 'error', rule: 'locator-lint', file, line: r.line, message: `page.locator('${r.value.slice(0, 80)}'): the framework's locator linter forbids raw page.locator() (its policy); use a @CSGetElement element.` });
        return out;
    } catch {
        return null;
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
/** The strategy of an alternativeLocators entry, as the linter reads it (prefix, else xpath / css). */
function altStrategy(v: string): string {
    const m = /^(xpath|css|text|role|testId|placeholder)[:=]/i.exec(v);
    if (m) return m[1].toLowerCase() === 'testid' ? 'testId' : m[1].toLowerCase();
    return v.startsWith('/') || v.startsWith('(/') ? 'xpath' : 'css';
}

export function checkPlan(ts: typeof TS, plan: ChangePlan, model: ProjectModel, o: CheckOptions = {}): Finding[] {
    const out: Finding[] = [];
    // Definitions after the change: the project's, with planned step files replacing their old text.
    const replaced = new Set(plan.files.filter((f) => f.kind === 'steps').map((f) => f.path));
    const plannedDefs = plan.files.filter((f) => f.kind === 'steps').flatMap((f) => extractStepDefs(f.text, f.path, false));
    // Step folders loaded after the change. The project's own configuration setting STEP_DEFINITIONS_PATH
    // replaces what it loads (a shared folder it leaves out is no longer loaded); another file adds to it.
    let loaded = new Set(model.loadedStepFolders);
    const folderList = (v: string) => v.split(';').map((x) => x.trim()).filter((x) => x && !/node_modules/.test(x)).map((x) => x.replace(/\{project\}/g, model.project).replace(/\/+$/, ''));
    for (const f of plan.files.filter((x) => x.kind === 'config')) {
        const m = /^\s*STEP_DEFINITIONS_PATH\s*=\s*(.*)$/m.exec(f.text);
        if (!m) continue;
        if (f.path.startsWith(`config/${model.project}/`)) loaded = new Set(folderList(m[1]));
        else for (const x of folderList(m[1])) loaded.add(x);
    }
    const inLoaded = (file: string) => [...loaded].some((x) => file === x || file.startsWith(`${x}/`));
    const projectConfigChanged = plan.files.some((f) => f.kind === 'config' && f.path.startsWith(`config/${model.project}/`) && /^\s*STEP_DEFINITIONS_PATH\s*=/m.test(f.text));
    const defs: StepDef[] = [...model.allSteps.filter((d) => !replaced.has(d.file)), ...plannedDefs]
        .map((d) => (projectConfigChanged && !d.builtIn ? { ...d, notLoaded: !inLoaded(d.file) } : d));
    const loadedDefs = defs.filter((d) => !d.notLoaded);

    for (const f of plan.files) {
        const lines = f.text.split('\n');
        // What the change adds: a line the file already had is not this change's problem.
        const prev = o.before?.(f.path) ?? null;
        const prevLines = new Set((prev ?? '').split('\n').map((l) => l.trim()));
        const added = (l: string) => !prevLines.has(l.trim());
        if (f.kind === 'feature') {
            if (!/^\s*Scenario( Outline)?:/m.test(f.text)) out.push({ level: 'error', rule: 'empty-feature', file: f.path, message: 'The feature has no scenario.' });
            if (!/^[a-z0-9]+(-[a-z0-9]+)*\.feature$/.test(path.basename(f.path))) out.push({ level: 'warning', rule: 'naming', file: f.path, message: `Feature files are named in lower case with hyphens (e.g. ${path.basename(f.path).toLowerCase().replace(/[^a-z0-9.]+/g, '-')}).` });
            for (const s of featureSteps(f.text)) {
                const variants = s.variants.flatMap(samples);
                if (!variants.length) continue;
                const hit = (ds: StepDef[]) => s.variants.every((v) => samples(v).some((x) => ds.some((d) => matches(d, x))));
                if (hit(loadedDefs)) continue;
                const elsewhere = defs.find((d) => d.notLoaded && variants.some((x) => matches(d, x)));
                out.push(elsewhere
                    ? { level: 'error', rule: 'step-not-loaded', file: f.path, line: s.line, message: `"${s.text}" is defined in ${elsewhere.file}:${elsewhere.line}, which the framework does not load: add its folder to STEP_DEFINITIONS_PATH.` }
                    : { level: 'error', rule: 'undefined-step', file: f.path, line: s.line, message: `No step definition matches "${s.text}".${closestHint(variants[0], loadedDefs)}` });
            }
            lines.forEach((l, i) => { if (added(l) && !isComment(l) && /^\s*(Given|When|Then|And|But|\*)\s/.test(l) && /https?:\/\//i.test(l)) out.push({ level: 'warning', rule: 'hard-coded-url', file: f.path, line: i + 1, message: 'The step holds an address: use a configuration key (e.g. BASE_URL) so the test runs in every environment.' }); });
        }
        if (f.kind === 'steps') {
            if (!isStepFile(path.basename(f.path))) out.push({ level: 'error', rule: 'naming', file: f.path, message: 'The framework only loads step files named *.steps.ts, *.step.ts or *Steps.ts.' });
            const folder = path.posix.dirname(f.path);
            if (![...loaded].some((x) => folder === x || folder.startsWith(`${x}/`))) out.push({ level: 'error', rule: 'steps-folder-not-loaded', file: f.path, message: `The framework does not load step files from ${folder}: add it to STEP_DEFINITIONS_PATH in the project's configuration.` });
            const before = model.allSteps.filter((d) => d.file === f.path).map((d) => d.pattern);
            for (const d of extractStepDefs(f.text, f.path, false)) {
                if (before.includes(d.pattern)) continue;
                // Only definitions the project loads: another project's step with the same words is not a duplicate.
                const twin = model.allSteps.find((x) => !x.notLoaded && x.file !== f.path && x.pattern === d.pattern);
                if (twin) out.push({ level: 'warning', rule: 'duplicate-step', file: f.path, line: d.line, message: `"${d.pattern}" is already defined in ${twin.file}${twin.line ? `:${twin.line}` : ''}: reuse it instead of a second definition.` });
            }
        }
        if (f.kind === 'page') {
            const now = parsePageObject(ts, f.text, f.path);
            if (now) {
                if (!/Page$/.test(now.className)) out.push({ level: 'warning', rule: 'naming', file: f.path, message: `Page classes end with "Page" (${now.className}).` });
                if (path.basename(f.path, '.ts') !== now.className) out.push({ level: 'warning', rule: 'naming', file: f.path, message: `The file is named after its class (${now.className}.ts).` });
                const old = model.pages.find((p) => p.file === f.path);
                const known = new Set(old?.elements.map((e) => e.prop) ?? []);
                // The framework's locator linter when the project's framework has one; else the Studio's own rule.
                const linted = o.repoRoot ? frameworkLint(o.repoRoot, f.path, f.text, o.before?.(f.path) ?? old?.text ?? null) : null;
                if (linted) out.push(...linted);
                else for (const e of now.elements.filter((x) => !known.has(x.prop))) {
                    const loc = e.css ?? e.xpath ?? '';
                    // A table cell by its row's text and its column is not "by position": the column is its name.
                    const cellOfRow = /internal:role=row\[name=[^\]]+\] >> :scope > \* >> nth=\d+$/.test(loc)
                        // A table column (every row's cell of a column, for a column check): the column is its position.
                        || /> tbody > tr(?:\.[\w-]+)* > td:nth-child\(\d+\)$/.test(loc);
                    const why = !cellOfRow && /:nth-(child|of-type|match)|>>\s*nth=|\bnth=/.test(loc) ? 'its position on the page'
                        : /^\/html|\/\w+\[\d+\]/.test(e.xpath ?? '') ? 'an absolute or indexed XPath'
                            : /\.(css|sc|jss|emotion)-[a-zA-Z0-9]{5,}|\.[a-z]+-[a-f0-9]{6,}\b/.test(loc) ? 'generated class names'
                                : loc.split(' >> ').filter((p) => !p.startsWith('internal:')).some((p) => (p.match(/\s*>\s*|\s+(?=[.#\w[])/g) ?? []).length > 4) ? 'a long chain of elements' : '';
                    if (why) out.push({ level: 'warning', rule: 'fragile-locator', file: f.path, line: lineOf(f.text, Math.max(0, f.text.indexOf(`${e.prop}!`))), message: `${e.prop} is found by ${why} (${loc.slice(0, 80)}): prefer a test id, id, label or role where the page has one.` });
                }
            }
        }
        if (f.kind === 'data' && f.path.endsWith('.json')) {
            let data: unknown;
            try { data = JSON.parse(f.text); } catch (e) { out.push({ level: 'error', rule: 'invalid-data', file: f.path, message: `Not valid JSON: ${(e as Error).message}` }); data = undefined; }
            // Pairs the file already had (any formatting): not this change's problem.
            const had = new Set<string>();
            const collect = (v: unknown, into: Set<string>) => {
                if (Array.isArray(v)) { v.forEach((x) => collect(x, into)); return; }
                if (!v || typeof v !== 'object') return;
                for (const [k, x] of Object.entries(v as Record<string, unknown>)) { if (typeof x === 'string') into.add(`${k}\u0000${x}`); else collect(x, into); }
            };
            try { if (prev) collect(JSON.parse(prev), had); } catch { /* not JSON before */ }
            let from = 0;
            const visit = (v: unknown) => {
                if (Array.isArray(v)) { v.forEach(visit); return; }
                if (!v || typeof v !== 'object') return;
                for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
                    if (typeof x === 'string' && x && SENSITIVE_KEY.test(k) && !SAFE_VALUE.test(x) && !had.has(`${k}\u0000${x}`)) {
                        // The line of this value (searching on from the last one: the same key repeats in rows).
                        const at = f.text.indexOf(JSON.stringify(x), Math.max(from, f.text.indexOf(JSON.stringify(k), from)));
                        if (at >= 0) from = at + 1;
                        out.push({ level: 'warning', rule: 'plain-password', file: f.path, line: lineOf(f.text, Math.max(0, at)), message: `"${k}" holds a readable value: use an ENCRYPTED: value or a Studio secret ({env:NAME}).` });
                    } else visit(x);
                }
            };
            visit(data);
        }
        if (f.kind === 'config') {
            lines.forEach((l, i) => {
                const m = /^\s*([A-Za-z_][\w.]*)\s*=\s*(.*)$/.exec(l);
                if (m && added(l) && SENSITIVE_KEY.test(m[1]) && m[2].trim() && !SAFE_VALUE.test(m[2].trim())) out.push({ level: 'warning', rule: 'plain-password', file: f.path, line: i + 1, message: `${m[1]} holds a readable value: use an ENCRYPTED: value or a Studio secret.` });
            });
        }
        if (f.kind === 'page' || f.kind === 'steps') {
            lines.forEach((l, i) => { if (added(l) && !isComment(l) && /['"`]https?:\/\/[^'"`]+['"`]/.test(l)) out.push({ level: 'warning', rule: 'hard-coded-url', file: f.path, line: i + 1, message: 'An address in code: read it from the configuration (this.config.get(\'BASE_URL\')) so the test runs in every environment.' }); });
        }
        // Secret values never go into files, whatever the file.
        for (const v of (o.secretValues ?? []).filter((x) => x.length >= 6)) {
            const at = f.text.indexOf(v);
            if (at < 0) continue;
            const already = (prev ?? '').includes(v);
            out.push({ level: already ? 'warning' : 'error', rule: 'secret-in-file', file: f.path, line: lineOf(f.text, at), message: already ? 'The file already holds the value of a Studio secret (before this change): replace it with {env:NAME}.' : 'The value of a Studio secret is in this file: reference it as {env:NAME} instead.' });
            break;
        }
    }
    const order = { error: 0, warning: 1, info: 2 };
    return out.sort((a, b) => order[a.level] - order[b.level] || (a.file ?? '').localeCompare(b.file ?? '') || (a.line ?? 0) - (b.line ?? 0));
}
