/**
 * The life of a failure's bug, kept in step with the test results:
 *  - file:    a cause of failure judged a product bug is failing and has no bug yet;
 *  - update:  its bug is open and the failure goes on: a comment with the new occurrences;
 *  - reopen:  its bug was resolved or closed, and the failure is back;
 *  - resolve: the failing scenarios have passed since (in at least `passesNeeded` runs each): propose resolving it.
 * Nothing changes in Azure DevOps until the person applies the actions they choose. Bug states follow the project's
 * process through the states' categories (Proposed, InProgress, Resolved, Completed), so Agile, Scrum, Basic and CMMI
 * all work.
 */
import type { FailureGroup, QualityScenario } from './quality';
import type { TriageEntry } from './triage';
import { signatureTag } from './triage';

export interface BugInfo { id: number; title: string; state: string; tags: string[]; changed: string; url?: string }
export interface StateCategories { reopen: string; resolve: string; open: Set<string>; done: Set<string> }
export type BugAction =
    | { kind: 'file'; tag: string; signature: string; title: string; why: string }
    | { kind: 'update'; tag: string; bug: number; comment: string; why: string }
    | { kind: 'reopen'; tag: string; bug: number; from: string; to: string; comment: string; why: string }
    | { kind: 'resolve'; tag: string; bug: number; from: string; to: string; comment: string; why: string };

/** The states to use, from the Bug type's states and their categories (GET wit/workitemtypes/Bug/states). */
export function stateCategories(states: Array<{ name: string; category: string }>): StateCategories {
    const of = (c: string) => states.filter((s) => s.category === c).map((s) => s.name);
    const open = new Set([...of('Proposed'), ...of('InProgress')]);
    const done = new Set([...of('Resolved'), ...of('Completed'), ...of('Removed')]);
    const reopen = of('InProgress')[0] ?? of('Proposed')[0] ?? 'Active';
    const resolve = of('Resolved')[0] ?? of('Completed')[0] ?? 'Resolved';
    return { reopen, resolve, open, done };
}

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function planBugActions(o: {
    groups: FailureGroup[]; scenarios: QualityScenario[]; triage: Record<string, TriageEntry>; bugs: BugInfo[]; states: StateCategories;
    /** Runs in a row a scenario must pass in before its bug is proposed for resolving. */
    passesNeeded?: number;
}): BugAction[] {
    const need = o.passesNeeded ?? 3;
    const out: BugAction[] = [];
    const byTag = new Map<string, BugInfo[]>();
    for (const b of o.bugs) for (const t of b.tags) byTag.set(t, [...(byTag.get(t) ?? []), b]);
    const byId = new Map(o.bugs.map((b) => [b.id, b]));
    const scen = new Map(o.scenarios.map((s) => [s.key, s]));
    const seen = new Set<string>();
    for (const g of o.groups) {
        const tag = signatureTag(g.signature);
        seen.add(tag);
        const tri = o.triage[tag];
        const bug = (tri?.bug ? byId.get(tri.bug) : undefined) ?? (byTag.get(tag) ?? []).sort((a, b) => b.changed.localeCompare(a.changed))[0];
        // Still failing: in the latest run, or failing in a row up to now in any of its scenarios.
        const failingNow = g.inLatest || g.scenarios.some((s) => (scen.get(s.key)?.failingFor ?? 0) > 0);
        // Passed since its last failure, in enough runs, in every scenario it failed in.
        const passedSince = g.scenarios.every((s) => {
            const rs = scen.get(s.key)?.results ?? [];
            const after = rs.filter((r) => r.at > g.lastSeen && r.status !== 'skipped');
            return after.length >= need && after.every((r) => r.status === 'passed');
        });
        const where = `${g.scenarios.length} scenario${g.scenarios.length === 1 ? '' : 's'} (${g.scenarios.slice(0, 3).map((s) => s.name).join(', ')}${g.scenarios.length > 3 ? ', …' : ''})`;
        if (!bug) {
            if (failingNow && tri?.verdict === 'product-bug')
                out.push({ kind: 'file', tag, signature: g.signature, title: `[Automation] ${g.sample.split('\n')[0].slice(0, 120)}`, why: `Judged a product bug, failing in ${where}, no bug yet.` });
            continue;
        }
        const closed = o.states.done.has(bug.state);
        if (failingNow && closed) {
            out.push({ kind: 'reopen', tag, bug: bug.id, from: bug.state, to: o.states.reopen, why: `Bug ${bug.id} is ${bug.state}, but the failure is back (last seen ${g.lastSeen}).`,
                comment: `<p><b>Failing again</b> (CS Test Studio): ${g.failures} failure${g.failures === 1 ? '' : 's'} in ${g.runs} run${g.runs === 1 ? '' : 's'}, last ${esc(g.lastSeen)}, in ${esc(where)}.</p><pre>${esc(g.sample.slice(0, 2000))}</pre>` });
        } else if (failingNow && !closed) {
            // Only when there is something new since the bug last changed.
            if (g.lastSeen > bug.changed)
                out.push({ kind: 'update', tag, bug: bug.id, why: `Bug ${bug.id} (${bug.state}): failing again since it last changed.`,
                    comment: `<p>Still failing (CS Test Studio): ${g.failures} failure${g.failures === 1 ? '' : 's'} in ${g.runs} run${g.runs === 1 ? '' : 's'}, last ${esc(g.lastSeen)}, in ${esc(where)}.</p>` });
        } else if (!failingNow && !closed && passedSince) {
            out.push({ kind: 'resolve', tag, bug: bug.id, from: bug.state, to: o.states.resolve, why: `Bug ${bug.id} is ${bug.state}; its scenarios have passed in the last ${need}+ runs since ${g.lastSeen}.`,
                comment: `<p><b>Passing</b> (CS Test Studio): ${esc(where)} passed in every run since ${esc(g.lastSeen)} (at least ${need} each). Proposed as resolved; reopened automatically if it fails again.</p>` });
        }
    }
    return out;
}
