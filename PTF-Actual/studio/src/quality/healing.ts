/**
 * Healed locators: elements the framework found with another locator than the page object's own, from the
 * runs' reports, so they can be reviewed and the page object updated (or the heal dismissed).
 *
 * Verified in the framework:
 *  - A heal is recorded on the step (report-data.json: steps[].aiData.healings, healing = the last one):
 *    element (description), pageClass and property (where @CSGetElement declares it), originalLocator, healedLocator,
 *    strategy ('alternative' when one of alternativeLocators found it; else the self-healing engine's
 *    accessibility-tree / fingerprint / fuzzy-text / visual) and confidence (0-1).
 *  - An alternative is written "<kind>:<value>" (testId:, css:, xpath:, text:, role:, id:, name:, label:,
 *    placeholder:, title:, alt:, class:); a locator from the engine is a Playwright selector (used as css).
 *  - Older framework versions record no pageClass/property: such heals are listed but cannot be applied.
 */
import * as fs from 'fs';
import * as path from 'path';
import type * as TS from 'typescript';
import { QualityRun } from './quality';

export interface HealEvent {
    run: string; at: string; scenario: string; feature: string; step: string;
    element: string; pageClass?: string; property?: string;
    original: string; healed: string; strategy: string; confidence: number;
}
export type HealStatus = 'review' | 'applied' | 'confirmed' | 'dismissed';
export interface HealGroup {
    key: string; element: string; pageClass?: string; property?: string;
    original: string;
    /** The locator it was found with most often (the suggestion), and every one seen. */
    healed: string; variants: Array<{ healed: string; count: number }>;
    strategy: string; confidence: number;
    count: number; runs: number; firstSeen: string; lastSeen: string;
    scenarios: Array<{ name: string; feature: string; project?: string; env?: string }>;
    status: HealStatus; decidedAt?: string;
    events: HealEvent[];
}
export interface HealDecision { healed: string; action: 'applied' | 'dismissed'; at: string; file?: string }

const keyOf = (e: Pick<HealEvent, 'pageClass' | 'property' | 'element' | 'original'>) => (e.pageClass && e.property ? `${e.pageClass}.${e.property}` : `${e.element}\u0000${e.original}`);

/** The heals in a run's report data file (suite.scenarios[].steps[].aiData). */
export function healsInReport(json: string, run: Pick<QualityRun, 'id' | 'at'>): HealEvent[] {
    let data: { suite?: { scenarios?: Array<Record<string, unknown>> } };
    try { data = JSON.parse(fs.readFileSync(json, 'utf8')); } catch { return []; }
    const out: HealEvent[] = [];
    for (const sc of data.suite?.scenarios ?? []) {
        for (const st of (Array.isArray(sc.steps) ? sc.steps : []) as Array<Record<string, unknown>>) {
            const ai = st.aiData as { healings?: unknown[]; healing?: unknown } | undefined;
            const list = (Array.isArray(ai?.healings) ? ai!.healings : ai?.healing ? [ai.healing] : []) as Array<Record<string, unknown>>;
            for (const h of list) {
                if (!h || h.success !== true || typeof h.healedLocator !== 'string' || !h.healedLocator) continue;
                out.push({
                    run: run.id, at: run.at, scenario: String(sc.name ?? ''), feature: String(sc.feature ?? ''), step: String(st.name ?? ''),
                    element: String(h.element ?? h.originalLocator ?? 'Element'),
                    ...(typeof h.pageClass === 'string' && h.pageClass ? { pageClass: h.pageClass } : {}),
                    ...(typeof h.property === 'string' && h.property ? { property: h.property } : {}),
                    original: String(h.originalLocator ?? ''), healed: h.healedLocator,
                    strategy: String(h.strategy ?? 'unknown'), confidence: Math.round(Number(h.confidence ?? 0) * 100),
                });
            }
        }
    }
    return out;
}

/**
 * Heals per element. A decision (applied / dismissed) holds for the locator it was made for: a heal to another
 * locator is up for review again. An applied change is confirmed once a later run ran a scenario that used
 * the element and it no longer healed.
 */
export function groupHeals(events: HealEvent[], decisions: Record<string, HealDecision>, laterRuns: Array<{ at: string; scenarios: Set<string> }>,
    runInfo: Map<string, { project?: string; env?: string }>, stillApplied?: (d: HealDecision) => boolean): HealGroup[] {
    const by = new Map<string, HealEvent[]>();
    for (const e of events) { const k = keyOf(e); by.set(k, [...(by.get(k) ?? []), e]); }
    const groups: HealGroup[] = [];
    for (const [key, evs] of by) {
        evs.sort((a, b) => a.at.localeCompare(b.at));
        const counts = new Map<string, number>();
        for (const e of evs) counts.set(e.healed, (counts.get(e.healed) ?? 0) + 1);
        const variants = [...counts.entries()].map(([healed, count]) => ({ healed, count })).sort((a, b) => b.count - a.count);
        const last = evs[evs.length - 1];
        const suggestion = variants[0].healed;
        const scen = new Map<string, HealGroup['scenarios'][number]>();
        for (const e of evs) scen.set(`${e.feature}\u0000${e.scenario}`, { name: e.scenario, feature: e.feature, ...runInfo.get(e.run) });
        const d = decisions[key];
        let status: HealStatus = 'review';
        // Dismissed until it heals to another locator after the decision.
        if (d && d.action === 'dismissed' && !evs.some((e) => e.at > d.at && e.healed !== d.healed)) status = 'dismissed';
        if (d && d.action === 'applied') {
            const after = evs.filter((e) => e.at > d.at);
            if (after.length) status = 'review';
            // The change was taken back in the page object (reverted, edited): to review again.
            else if (stillApplied && !stillApplied(d)) status = 'review';
            else {
                const names = [...scen.values()].map((s) => s.name);
                status = laterRuns.some((r) => r.at > d.at && names.some((n) => r.scenarios.has(n))) ? 'confirmed' : 'applied';
            }
        }
        groups.push({
            key, element: last.element, pageClass: last.pageClass, property: last.property, original: last.original,
            healed: suggestion, variants, strategy: evs.filter((e) => e.healed === suggestion).pop()!.strategy,
            confidence: Math.max(...evs.filter((e) => e.healed === suggestion).map((e) => e.confidence)),
            count: evs.length, runs: new Set(evs.map((e) => e.run)).size, firstSeen: evs[0].at, lastSeen: last.at,
            scenarios: [...scen.values()], status, ...(d ? { decidedAt: d.at } : {}), events: evs.slice(-50),
        });
    }
    const order: Record<HealStatus, number> = { review: 0, applied: 1, confirmed: 2, dismissed: 3 };
    return groups.sort((a, b) => order[a.status] - order[b.status] || b.lastSeen.localeCompare(a.lastSeen));
}

// ---- The page object change

/** Decorator options that locate the element (the ones a healed locator replaces). */
const LOCATOR_KEYS = ['css', 'xpath', 'id', 'testId', 'text', 'role', 'name', 'label', 'placeholder', 'title', 'alt', 'className'];
const PREFIX: Record<string, string> = { css: 'css', xpath: 'xpath', id: 'id', testid: 'testId', text: 'text', role: 'role', name: 'name', label: 'label', placeholder: 'placeholder', title: 'title', alt: 'alt', class: 'className' };

/** A healed locator as a decorator option: "testId:x" → testId 'x'; a selector from the engine → css. */
export function healedOption(healed: string): { key: string; value: string } {
    const m = /^([A-Za-z]+):(.*)$/s.exec(healed);
    if (m && PREFIX[m[1].toLowerCase()]) return { key: PREFIX[m[1].toLowerCase()], value: m[2] };
    if (/^(\/\/|\(\/\/|\.\/)/.test(healed)) return { key: 'xpath', value: healed };
    return { key: 'css', value: healed };
}

/** Files that may declare the page class (TypeScript under the repository, not dependencies or output). */
export function filesDeclaring(repoRoot: string, className: string): string[] {
    const out: string[] = [];
    const re = new RegExp(`\\bclass\\s+${className.replace(/[^\w$]/g, '')}\\b`);
    const skip = new Set(['node_modules', 'dist', 'build', 'reports', 'test-results', 'coverage', '.git']);
    const walk = (dir: string, depth: number) => {
        if (depth > 12 || out.length > 5) return;
        let entries: fs.Dirent[] = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (e.name.startsWith('.') || skip.has(e.name)) continue;
            const a = path.join(dir, e.name);
            if (e.isDirectory()) walk(a, depth + 1);
            else if (e.isFile() && /\.ts$/.test(e.name) && !e.name.endsWith('.d.ts')) {
                try { if (fs.statSync(a).size < 1024 * 1024 && re.test(fs.readFileSync(a, 'utf8'))) out.push(path.relative(repoRoot, a).split(path.sep).join('/')); } catch { /* unreadable */ }
            }
        }
    };
    walk(repoRoot, 0);
    return out.sort();
}

export interface DecoratorEdit { line: number; before: string; after: string; text: string; option: { key: string; value: string } }

/**
 * The page object with the element's locator replaced by the healed one: the decorator's locator options
 * (css, xpath, id, testId…) become the healed one, and an alternative that is now the locator leaves
 * alternativeLocators. Other options (description, waits, frame…) and the rest of the file are unchanged.
 * Null when the class or the @CSGetElement property is not in the text.
 */
export function proposeEdit(ts: typeof TS, text: string, className: string, property: string, healed: string): DecoratorEdit | null {
    const sf = ts.createSourceFile('page.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    let obj: TS.ObjectLiteralExpression | null = null;
    let decoNode: TS.Decorator | null = null;
    const visit = (n: TS.Node) => {
        if (obj) return;
        if (ts.isClassDeclaration(n) && n.name?.text === className) {
            for (const m of n.members) {
                if (!ts.isPropertyDeclaration(m) || !m.name || (ts.isIdentifier(m.name) ? m.name.text : '') !== property) continue;
                for (const d of ts.getDecorators?.(m) ?? []) {
                    const c = d.expression;
                    if (ts.isCallExpression(c) && ts.isIdentifier(c.expression) && /^CSGetElements?$/.test(c.expression.text) && c.arguments[0] && ts.isObjectLiteralExpression(c.arguments[0])) { obj = c.arguments[0]; decoNode = d; }
                }
            }
        }
        ts.forEachChild(n, visit);
    };
    visit(sf);
    if (!obj || !decoNode) return null;
    const o = obj as TS.ObjectLiteralExpression;
    const opt = healedOption(healed);
    const q = (v: string) => `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
    const props = o.properties;
    const nameOf = (p: TS.ObjectLiteralElementLike) => (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : '');
    // Edits as [start, end, replacement], applied from the end of the text.
    const edits: Array<[number, number, string]> = [];
    const locatorProps = props.filter((p) => LOCATOR_KEYS.includes(nameOf(p)));
    // Removing a property removes it with the comma and spacing after it (or before it, for the last one).
    const removal = (p: TS.ObjectLiteralElementLike): [number, number] => {
        const i = props.indexOf(p);
        if (i < props.length - 1) return [p.getStart(sf), props[i + 1].getStart(sf)];
        if (i > 0) return [props[i - 1].getEnd(), p.getEnd()];
        return [p.getStart(sf), p.getEnd()];
    };
    const first = locatorProps[0];
    if (first) edits.push([first.getStart(sf), first.getEnd(), `${opt.key}: ${q(opt.value)}`]);
    for (const p of locatorProps.slice(1)) edits.push([...removal(p), '']);
    if (!first) {
        const at = props.length ? props[0].getStart(sf) : o.getStart(sf) + 1;
        edits.push([at, at, props.length ? `${opt.key}: ${q(opt.value)}, ` : ` ${opt.key}: ${q(opt.value)} `]);
    }
    // The alternative that found it is the locator now.
    const alts = props.find((p) => nameOf(p) === 'alternativeLocators');
    if (alts && ts.isPropertyAssignment(alts) && ts.isArrayLiteralExpression(alts.initializer)) {
        const els = alts.initializer.elements;
        const keep = els.filter((e) => !(ts.isStringLiteralLike(e) && e.text === healed));
        if (keep.length !== els.length) {
            if (!keep.length) edits.push([...removal(alts), '']);
            else edits.push([alts.initializer.getStart(sf), alts.initializer.getEnd(), `[${keep.map((e) => e.getText(sf)).join(', ')}]`]);
        }
    }
    let next = text;
    for (const [s, e, r] of edits.sort((a, b) => b[0] - a[0])) next = next.slice(0, s) + r + next.slice(e);
    const d = decoNode as TS.Decorator;
    const start = d.getStart(sf);
    const before = text.slice(start, d.getEnd());
    // The same decorator in the new text: it starts at the same place and ends where the change shifted it.
    const shift = next.length - text.length;
    const after = next.slice(start, d.getEnd() + shift);
    return { line: sf.getLineAndCharacterOfPosition(start).line + 1, before, after, text: next, option: opt };
}
