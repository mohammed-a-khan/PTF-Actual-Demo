/**
 * Plan first: before an agent writes step definitions or page objects for a story, it writes the feature (the
 * test plan in Gherkin) and the person approves it. The plan's review shows each step as reused (an existing
 * step definition matches it, framework or project) or new (code to write), so the person sees how much is new
 * and where a step could be worded like an existing one.
 */
import { closestHint, featureSteps, matches, StepDef } from '../lang/steps';

export type PlanStepStatus = 'reused' | 'new' | 'not-loaded' | 'no-examples';
export interface PlanStep {
    line: number; keyword: string; text: string; status: PlanStepStatus;
    /** The definition that matches (reused, or not loaded: in a folder the framework does not load). */
    def?: { pattern: string; file: string; line: number; builtIn: boolean };
    /** A new step worded much like an existing one: that one. */
    closest?: string;
}
export interface PlanScenario { line: number; name: string; outline: boolean; examples: number; tags: string[]; steps: PlanStep[] }
export interface PlanCoverage {
    feature: string; background: PlanStep[]; scenarios: PlanScenario[];
    counts: { scenarios: number; steps: number; reused: number; new: number; notLoaded: number };
}

const SCENARIO = /^\s*(Scenario Outline|Scenario Template|Scenario|Example)\s*:\s*(.*)$/;

/** The plan (a feature file's text) against the step definitions its project loads. */
export function planCoverage(text: string, defs: StepDef[]): PlanCoverage {
    const loaded = defs.filter((d) => !d.notLoaded), unloaded = defs.filter((d) => d.notLoaded);
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const feature = (lines.find((l) => /^\s*Feature\s*:/.test(l)) ?? '').replace(/^\s*Feature\s*:\s*/, '').trim();
    // Scenario headings, their tags and their examples rows
    const heads: Array<{ line: number; name: string; outline: boolean; tags: string[]; examples: number }> = [];
    let tags: string[] = [];
    let inExamples = false;
    for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        const m = SCENARIO.exec(lines[i]);
        if (m) { heads.push({ line: i + 1, name: m[2].trim(), outline: /Outline|Template/.test(m[1]), tags, examples: 0 }); tags = []; inExamples = false; continue; }
        if (t.startsWith('@')) { tags.push(...t.split(/\s+/).filter((x) => x.startsWith('@'))); continue; }
        if (/^(Examples|Scenarios)\s*:/.test(t)) { inExamples = true; continue; }
        if (/^(Background|Rule|Feature)\s*:/.test(t)) { inExamples = false; tags = []; continue; }
        if (inExamples && t.startsWith('|') && heads.length) heads[heads.length - 1].examples++;
    }
    for (const h of heads) h.examples = Math.max(0, h.examples - 1); // the header row
    const firstScenario = heads[0]?.line ?? Infinity;
    const step = (s: ReturnType<typeof featureSteps>[number]): PlanStep => {
        const base = { line: s.line, keyword: s.keyword, text: s.text };
        const variants = s.variants.filter((v) => !/<[^>]+>/.test(v));
        if (!variants.length) return { ...base, status: 'no-examples' };
        const def = loaded.find((d) => variants.every((v) => matches(d, v)));
        if (def) return { ...base, status: 'reused', def: { pattern: def.pattern, file: def.file, line: def.line, builtIn: def.builtIn } };
        const off = unloaded.find((d) => matches(d, variants[0]));
        if (off) return { ...base, status: 'not-loaded', def: { pattern: off.pattern, file: off.file, line: off.line, builtIn: off.builtIn } };
        const hint = closestHint(variants[0], loaded);
        return { ...base, status: 'new', ...(hint ? { closest: hint.replace(/^ Closest existing step: /, '').trim() } : {}) };
    };
    const all = featureSteps(text).map(step);
    const scenarios: PlanScenario[] = heads.map((h, i) => {
        const end = heads[i + 1]?.line ?? Infinity;
        return { line: h.line, name: h.name, outline: h.outline, examples: h.examples, tags: h.tags, steps: all.filter((s) => s.line > h.line && s.line < end) };
    });
    const background = all.filter((s) => s.line < firstScenario);
    // Each distinct step once (a step used in several scenarios is written once).
    const distinct = new Map<string, PlanStep>();
    for (const s of all) if (!distinct.has(s.text)) distinct.set(s.text, s);
    const list = [...distinct.values()];
    return {
        feature, background, scenarios,
        counts: { scenarios: scenarios.length, steps: list.length, reused: list.filter((s) => s.status === 'reused').length, new: list.filter((s) => s.status === 'new').length, notLoaded: list.filter((s) => s.status === 'not-loaded').length },
    };
}

/** The plan's review as text (the approval card in the Studio). */
export function planSummary(file: string, c: PlanCoverage): string {
    const mark = (s: PlanStep) => (s.status === 'reused' ? '✓' : s.status === 'new' ? '+' : s.status === 'not-loaded' ? '!' : '?');
    const line = (s: PlanStep) => `  ${mark(s)} ${s.keyword} ${s.text}${s.status === 'reused' && s.def ? `   — ${s.def.builtIn ? 'framework step' : `${s.def.file}:${s.def.line}`}` : s.status === 'new' ? `   — new step${s.closest ? ` (closest existing: ${s.closest})` : ''}` : s.status === 'not-loaded' && s.def ? `   — defined in ${s.def.file}, which the framework does not load` : '   — fill in the Examples'}`;
    const out = [
        `${file}${c.feature ? ` — Feature: ${c.feature}` : ''}`,
        `${c.counts.scenarios} scenario${c.counts.scenarios === 1 ? '' : 's'}, ${c.counts.steps} distinct step${c.counts.steps === 1 ? '' : 's'}: ${c.counts.reused} reused, ${c.counts.new} new${c.counts.notLoaded ? `, ${c.counts.notLoaded} in a folder not loaded` : ''}.`,
        '✓ reuses an existing step   + new step to write   ! defined but not loaded',
    ];
    if (c.background.length) out.push('', 'Background:', ...c.background.map(line));
    for (const s of c.scenarios) {
        out.push('', `${s.outline ? 'Scenario Outline' : 'Scenario'}: ${s.name}${s.tags.length ? `  ${s.tags.join(' ')}` : ''}${s.outline ? ` (${s.examples} example row${s.examples === 1 ? '' : 's'})` : ''}`);
        out.push(...s.steps.map(line));
    }
    out.push('', 'You can change the feature file before approving: the agent continues from the file as it is then.');
    return out.join('\n');
}
