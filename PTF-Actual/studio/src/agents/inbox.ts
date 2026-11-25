/**
 * The inbox: everything agents wait for a person on, in one place, answered there.
 *
 *  - Questions and plans of missions (mission_ask), approvals of missions and their team members, approvals of
 *    agent conversations (a command, a file change, a Studio change), missions done whose work waits for a decision
 *    (bring it in, open a pull request, discard), and agents whose last evaluation has regressions.
 *  - Each item says what it is, where from and how old it is, and is answered in place (answer, approve once /
 *    for the rest of the session, reject) or opens its mission or conversation.
 *  - New items go to the notification channels that ask for them (Teams, Slack, a webhook), once each.
 */
import type { MissionRun } from './missions';
import type { EvalRun } from './evals';

export type InboxKind = 'question' | 'plan' | 'approval' | 'review' | 'regression';
export interface InboxItem {
    /** Stable: the same thing waiting keeps its id (notifications are sent once per id). */
    id: string;
    kind: InboxKind;
    title: string;
    detail?: string;
    /** Where it comes from (the screen that opens it). */
    source: { type: 'mission' | 'conversation' | 'evaluation'; id: string; title: string };
    at: string;
    /** Answer choices a question offers. */
    options?: string[];
    /** What can be done here: answer (questions and plans), approve / reject (approvals), open (the rest). */
    actions: Array<'answer' | 'approve' | 'approve-session' | 'reject' | 'open'>;
    /** Who asked, inside the source (a team member of a mission). */
    who?: string;
}

export interface InboxSources {
    missions: () => MissionRun[];
    /** Agent conversations (not missions) waiting for an approval. */
    conversations: () => Array<{ id: string; title: string; pending: Array<{ id: string; title: string; detail: string; kind: string; at?: string }> }>;
    /** The last evaluation run of each agent. */
    evaluations: () => EvalRun[];
}

const cut = (s: string | undefined, n: number) => { const t = String(s ?? '').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

export function collectInbox(src: InboxSources): InboxItem[] {
    const out: InboxItem[] = [];
    for (const m of src.missions()) {
        const source = { type: 'mission' as const, id: m.id, title: m.title };
        if (!['succeeded', 'partial', 'failed', 'blocked', 'over-budget', 'stopped'].includes(m.state)) {
            for (const c of m.checkpoints.filter((x) => x.answer === undefined)) {
                out.push({ id: `m:${m.id}:cp:${c.id}`, kind: c.kind === 'plan' ? 'plan' : 'question', title: cut(c.question, 300), ...(c.content ? { detail: cut(c.content, 20000) } : {}), source, at: c.at, ...(c.options?.length ? { options: c.options } : {}), actions: ['answer', 'open'] });
            }
            for (const a of m.approvals ?? []) {
                out.push({ id: `m:${m.id}:ap:${a.id}`, kind: 'approval', title: cut(a.title, 300), detail: cut(a.detail, 6000), source, at: m.timeline.filter((t) => t.kind === 'ask').at(-1)?.at ?? m.createdAt, actions: ['approve', 'approve-session', 'reject', 'open'], ...(a.who ? { who: a.who } : {}) });
            }
        } else if ((m.state === 'succeeded' || m.state === 'partial') && m.commit && !m.result) {
            out.push({ id: `m:${m.id}:review`, kind: 'review', title: `${m.title}: ${m.changes.length} file(s) ready to review`, detail: cut(m.report?.summary, 2000), source, at: m.endedAt ?? m.createdAt, actions: ['open'] });
        }
    }
    for (const c of src.conversations()) {
        for (const p of c.pending) out.push({ id: `c:${c.id}:${p.id}`, kind: 'approval', title: cut(p.title, 300), detail: cut(p.detail, 6000), source: { type: 'conversation', id: c.id, title: c.title }, at: p.at ?? new Date().toISOString(), actions: ['approve', 'approve-session', 'reject', 'open'] });
    }
    for (const r of src.evaluations()) {
        if (r.state === 'done' && r.compared?.regressions) {
            const names = r.cases.filter((c) => c.regression).map((c) => c.name);
            out.push({ id: `e:${r.agent}:${r.id}`, kind: 'regression', title: `${r.agentName}: ${r.compared.regressions} evaluation case(s) got worse`, detail: names.map((n) => `- ${n}`).join('\n'), source: { type: 'evaluation', id: r.agent, title: r.agentName }, at: r.endedAt ?? r.startedAt, actions: ['open'] });
        }
    }
    return out.sort((a, b) => b.at.localeCompare(a.at));
}

/** Sends each new item once (ids already sent are remembered while they wait); items no longer waiting are forgotten. */
export class InboxNotifier {
    private sent = new Set<string>();
    private first = true;
    constructor(private readonly send: (item: InboxItem) => void, private readonly o: { notifyExisting?: boolean } = {}) {}
    /** Call with the current items (on a timer or after a change); returns the items sent now. */
    update(items: InboxItem[]): InboxItem[] {
        const ids = new Set(items.map((i) => i.id));
        for (const id of [...this.sent]) if (!ids.has(id)) this.sent.delete(id);
        const fresh = items.filter((i) => !this.sent.has(i.id));
        for (const i of fresh) this.sent.add(i.id);
        // What was already waiting when the Studio started is not sent again (it was sent before, or is old).
        const now = this.first && !this.o.notifyExisting ? [] : fresh;
        this.first = false;
        for (const i of now) { try { this.send(i); } catch { /* a channel failing does not stop the others */ } }
        return now;
    }
}
