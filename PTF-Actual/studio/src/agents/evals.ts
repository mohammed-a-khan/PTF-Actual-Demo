/**
 * Agent evaluations: test cases for the team's agents, so a change to an agent's instructions, model, tools or
 * knowledge is measured before the team relies on it.
 *
 *  - A suite per agent in .cs-studio/evals/<agent>.json (reviewed and shared like code): cases, each a prompt
 *    (and, for a mission agent, its inputs) with checks on the answer and on what the agent did.
 *  - Checks: the answer contains / does not contain a text, matches a pattern, a tool was called (with arguments
 *    containing a text) or was not, the answer cites the knowledge ([K:…]), at most N model calls or seconds, and
 *    a grader: another agent with no tools judges the answer against written criteria (PASS / FAIL and why).
 *  - Safe to run: each case is a fresh session that cannot change anything (no file changes, no commands, no
 *    Studio calls that write; what would ask the person is refused at once).
 *  - Each case can run several times (a pass rate, for answers that vary). Results are kept per run; a run is
 *    compared with the one before it (cases that passed and now fail are regressions).
 */
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import type { AgentEvent, MissionSessionOptions } from './host';
import type { MissionAgent } from './missions';
import { profileOf, teamMember, type AgentProfile, type TeamAgent } from './builder';

export type EvalCheck =
    | { kind: 'contains'; text: string }
    | { kind: 'not-contains'; text: string }
    | { kind: 'matches'; pattern: string }
    | { kind: 'tool-called'; tool: string; args?: string }
    | { kind: 'tool-not-called'; tool: string }
    | { kind: 'cites-knowledge' }
    | { kind: 'max-calls'; calls: number }
    | { kind: 'max-seconds'; seconds: number }
    | { kind: 'judge'; criteria: string };
export interface EvalCase { id: string; name: string; prompt: string; inputs?: Record<string, string>; checks: EvalCheck[]; repeat?: number }
export interface EvalSuite { agent: string; cases: EvalCase[]; updatedAt?: string; updatedBy?: string }

export interface CheckResult { check: EvalCheck; pass: boolean; detail: string }
export interface Attempt { pass: boolean; answer: string; tools: Array<{ tool: string; args: string }>; calls: number; ms: number; checks: CheckResult[]; error?: string }
export interface CaseResult { id: string; name: string; passRate: number; pass: boolean; attempts: Attempt[]; regression?: boolean; fixed?: boolean }
export interface EvalRun {
    id: string; agent: string; agentName: string; startedAt: string; endedAt?: string; by: string;
    state: 'running' | 'done' | 'failed' | 'stopped';
    /** What was evaluated: the agent as it was (its model, tools and a fingerprint of its instructions). */
    subject: { model?: string; tools: string[]; instructions: string };
    cases: CaseResult[]; passed: number; total: number; error?: string;
    /** Against the previous run: cases now failing that passed, and the reverse. */
    compared?: { run: string; regressions: number; fixed: number };
}

export const EVALS_DIR = '.cs-studio/evals';
const KINDS = ['contains', 'not-contains', 'matches', 'tool-called', 'tool-not-called', 'cites-knowledge', 'max-calls', 'max-seconds', 'judge'];

export function validateSuite(v: unknown, agent: string): EvalSuite {
    const s = (v ?? {}) as EvalSuite;
    const err = (m: string) => { throw new Error(m); };
    if (!Array.isArray(s.cases)) err('cases is a list.');
    if (s.cases.length > 100) err('At most 100 cases.');
    const ids = new Set<string>();
    const cases = s.cases.map((c, i) => {
        const id = String(c.id || `case-${i + 1}`);
        const where = c.name?.trim() ? `Case "${c.name.trim()}"` : `Case ${i + 1}`;
        if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) err(`${where}: an id of a-z, 0-9 and -.`);
        if (ids.has(id)) err(`Two cases are "${id}".`);
        ids.add(id);
        if (!String(c.prompt ?? '').trim()) err(`${where}: write the prompt.`);
        if (!Array.isArray(c.checks) || !c.checks.length) err(`${where}: add at least one check.`);
        const checks = c.checks.map((k) => {
            if (!KINDS.includes(k.kind)) err(`${where}: unknown check "${(k as { kind: string }).kind}".`);
            if ((k.kind === 'contains' || k.kind === 'not-contains') && !String(k.text ?? '').trim()) err(`${where}: the text to look for.`);
            if (k.kind === 'matches') { if (!String(k.pattern ?? '').trim()) err(`${where}: the pattern to match.`); try { new RegExp(k.pattern, 'i'); } catch (e) { err(`${where}: ${k.pattern} is not a valid pattern (${(e as Error).message.replace(/^Invalid regular expression: /, '')}).`); } }
            if ((k.kind === 'tool-called' || k.kind === 'tool-not-called') && !/^[\w.-]{1,80}$/.test(String(k.tool ?? ''))) err(`${where}: a tool name.`);
            if (k.kind === 'max-calls' && !(Number(k.calls) >= 1)) err(`${where}: max-calls needs a number.`);
            if (k.kind === 'max-seconds' && !(Number(k.seconds) >= 1)) err(`${where}: max-seconds needs a number.`);
            if (k.kind === 'judge' && String(k.criteria ?? '').trim().length < 10) err(`${where}: write the grader's criteria.`);
            return k;
        });
        return { id, name: String(c.name || id).slice(0, 120), prompt: String(c.prompt).slice(0, 8000), ...(c.inputs && Object.keys(c.inputs).length ? { inputs: c.inputs } : {}), checks, ...(c.repeat && c.repeat > 1 ? { repeat: Math.min(Math.floor(c.repeat), 10) } : {}) };
    });
    return { agent, cases };
}

export function readSuite(repoRoot: string, agent: string): EvalSuite | null {
    try { return validateSuite(JSON.parse(fs.readFileSync(path.join(repoRoot, EVALS_DIR, `${agent}.json`), 'utf8')), agent); } catch { return null; }
}
export function saveSuite(repoRoot: string, agent: string, v: unknown, by: string): EvalSuite {
    const s = { ...validateSuite(v, agent), updatedAt: new Date().toISOString(), updatedBy: by };
    const f = path.join(repoRoot, EVALS_DIR, `${agent}.json`);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, `${JSON.stringify(s, null, 2)}\n`);
    return s;
}

// "Contains" is the text as written (paths like /api/products included); patterns are the "matches" check.
const has = (answer: string, t: string) => answer.toLowerCase().includes(t.toLowerCase());

/** The checks that need no model (the grader runs separately). */
export function grade(c: EvalCheck, a: { answer: string; tools: Array<{ tool: string; args: string }>; calls: number; ms: number }): CheckResult | null {
    switch (c.kind) {
        case 'contains': return { check: c, pass: has(a.answer, c.text), detail: has(a.answer, c.text) ? 'found' : `"${c.text}" is not in the answer` };
        case 'not-contains': return { check: c, pass: !has(a.answer, c.text), detail: has(a.answer, c.text) ? `the answer has "${c.text}"` : 'not in the answer' };
        case 'matches': { let ok = false; try { ok = new RegExp(c.pattern, 'i').test(a.answer); } catch { /* checked when saved */ } return { check: c, pass: ok, detail: ok ? 'matches' : `does not match /${c.pattern}/` }; }
        case 'tool-called': {
            const calls = a.tools.filter((t) => t.tool === c.tool);
            const ok = calls.some((t) => !c.args || t.args.toLowerCase().includes(c.args.toLowerCase()));
            return { check: c, pass: ok, detail: ok ? `called ${calls.length} time(s)` : calls.length ? `called, but never with "${c.args}"` : `${c.tool} was not called (called: ${[...new Set(a.tools.map((t) => t.tool))].join(', ') || 'nothing'})` };
        }
        case 'tool-not-called': { const n = a.tools.filter((t) => t.tool === c.tool).length; return { check: c, pass: n === 0, detail: n ? `called ${n} time(s)` : 'not called' }; }
        case 'cites-knowledge': { const ok = /\[K:[^\]]+\]/.test(a.answer); return { check: c, pass: ok, detail: ok ? 'cites the knowledge' : 'no [K:…] citation' }; }
        case 'max-calls': return { check: c, pass: a.calls <= c.calls, detail: `${a.calls} model call(s)` };
        case 'max-seconds': return { check: c, pass: a.ms <= c.seconds * 1000, detail: `${Math.round(a.ms / 1000)} s` };
        default: return null;
    }
}

export interface EvalDeps {
    repoRoot: string; gitDir: string; agent: MissionAgent; userName?: string;
    log: (action: string, text: string, data?: Record<string, string>) => void;
    /** For tests: how long a case may take. */
    caseTimeoutMs?: number;
}

const now = () => new Date().toISOString();
const GRADER = 'You grade an AI agent\'s answer for a test team. You get the task the agent was given, its answer, and the criteria. Judge only against the criteria. Answer with PASS or FAIL on the first line, then one or two sentences why.';

export class EvalRunner {
    private running = new Map<string, { stop: boolean; sessions: Set<string> }>();
    constructor(private readonly d: EvalDeps) {}
    private dir(agent: string) { return path.join(this.d.gitDir, 'cs-studio', 'evals', agent); }

    runs(agent: string): EvalRun[] {
        const dir = this.dir(agent);
        let files: string[] = [];
        try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
        return files.map((f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as EvalRun; } catch { return null; } })
            .filter((r): r is EvalRun => !!r).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    }
    /** The last finished run of every agent evaluated (the inbox's regressions). */
    latestAll(): EvalRun[] {
        let agents: string[] = [];
        try { agents = fs.readdirSync(path.join(this.d.gitDir, 'cs-studio', 'evals')); } catch { return []; }
        return agents.map((a) => this.runs(a).find((r) => r.state !== 'running')).filter((r): r is EvalRun => !!r);
    }
    get(agent: string, id: string): EvalRun | undefined { return this.runs(agent).find((r) => r.id === id); }
    isRunning(agent: string) { return this.running.has(agent); }

    private save(r: EvalRun) {
        const dir = this.dir(r.agent);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${r.id}.json`), JSON.stringify(r));
        // Keep the last 30 runs of an agent.
        const old = this.runs(r.agent).slice(30);
        for (const o of old) { try { fs.rmSync(path.join(dir, `${o.id}.json`)); } catch { /* gone */ } }
    }

    /** Start a run in the background (one at a time per agent); the run is returned at once. */
    start(agentId: string, by: string, only?: string[]): EvalRun {
        const a = teamMember(this.d.repoRoot, agentId);
        if (!a) throw new Error(`No agent "${agentId}".`);
        const suite = readSuite(this.d.repoRoot, agentId);
        if (!suite?.cases.length) throw new Error(`No evaluation cases for ${a.name}: add them first (${EVALS_DIR}/${agentId}.json).`);
        if (this.running.has(agentId)) throw new Error(`${a.name} is being evaluated now.`);
        const cases = only?.length ? suite.cases.filter((c) => only.includes(c.id)) : suite.cases;
        if (!cases.length) throw new Error('None of those cases exist.');
        const r: EvalRun = { id: `${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`, agent: agentId, agentName: a.name, startedAt: now(), by, state: 'running', subject: { ...(a.model ? { model: a.model } : {}), tools: a.tools, instructions: a.instructions.slice(0, 400) }, cases: [], passed: 0, total: cases.length };
        this.save(r);
        const ctl = { stop: false, sessions: new Set<string>() };
        this.running.set(agentId, ctl);
        this.d.log('agent.eval', `Started evaluating ${a.name} (${cases.length} case(s))`, { agent: agentId });
        void this.run(r, a, cases, ctl).catch((e) => { r.state = 'failed'; r.error = (e as Error).message; }).finally(() => {
            r.endedAt = now();
            if (r.state === 'running') r.state = ctl.stop ? 'stopped' : 'done';
            this.compare(r);
            this.save(r);
            this.running.delete(agentId);
            this.d.log('agent.eval', `Evaluated ${a.name}: ${r.passed} of ${r.total} case(s) passed${r.compared?.regressions ? `, ${r.compared.regressions} regression(s)` : ''}`, { agent: agentId });
        });
        return r;
    }
    async stop(agentId: string) {
        const ctl = this.running.get(agentId);
        if (!ctl) throw new Error('Nothing is being evaluated.');
        ctl.stop = true;
        for (const s of ctl.sessions) await this.d.agent.abort(s).catch(() => undefined);
    }

    private compare(r: EvalRun) {
        const prev = this.runs(r.agent).find((x) => x.id !== r.id && x.state === 'done' && x.startedAt < r.startedAt);
        if (!prev) return;
        let regressions = 0, fixed = 0;
        for (const c of r.cases) {
            const p = prev.cases.find((x) => x.id === c.id);
            if (!p) continue;
            if (p.pass && !c.pass) { c.regression = true; regressions++; }
            if (!p.pass && c.pass) { c.fixed = true; fixed++; }
        }
        r.compared = { run: prev.id, regressions, fixed };
    }

    private async run(r: EvalRun, a: TeamAgent, cases: EvalCase[], ctl: { stop: boolean; sessions: Set<string> }) {
        for (const c of cases) {
            if (ctl.stop) break;
            const res: CaseResult = { id: c.id, name: c.name, passRate: 0, pass: false, attempts: [] };
            r.cases.push(res);
            for (let i = 0; i < (c.repeat ?? 1) && !ctl.stop; i++) {
                res.attempts.push(await this.attempt(a, c, ctl));
                this.save(r);
            }
            res.passRate = res.attempts.length ? res.attempts.filter((x) => x.pass).length / res.attempts.length : 0;
            res.pass = res.attempts.length > 0 && res.attempts.every((x) => x.pass);
            if (res.pass) r.passed++;
            this.save(r);
        }
    }

    /** One fresh, safe session: the agent's instructions, tools and knowledge; nothing it does can change anything. */
    private async session(title: string, workflow: string, profile: AgentProfile, ctl: { sessions: Set<string> }, message: string): Promise<{ answer: string; tools: Array<{ tool: string; args: string }>; calls: number; ms: number; error?: string }> {
        const t0 = Date.now();
        const tools: Array<{ tool: string; args: string }> = [];
        let answer = '', error: string | undefined, id = '';
        const done = new Promise<void>((resolve) => {
            const timer = setTimeout(() => { error = `No answer within ${Math.round((this.d.caseTimeoutMs ?? 300_000) / 1000)} s.`; resolve(); }, this.d.caseTimeoutMs ?? 300_000);
            timer.unref?.();
            const listener = (e: AgentEvent) => {
                if (e.type === 'assistant' && e.text.trim()) answer = e.text;
                else if (e.type === 'tool-start') tools.push({ tool: e.tool, args: e.args.slice(0, 2000) });
                else if (e.type === 'error') error = e.text;
                else if (e.type === 'idle') { clearTimeout(timer); resolve(); }
            };
            const mission: MissionSessionOptions = { workdir: this.d.repoRoot, isolated: true, autoFiles: false, unattended: true, readOnly: true, tools: [], profile, ...(profile.knowledge ? { knowledgeSources: profile.knowledge } : {}), listener };
            void this.d.agent.start({ title, workflow, mission }).then(async (s) => { id = s.id; ctl.sessions.add(id); await this.d.agent.send(id, message); })
                .catch((e) => { error = (e as Error).message; clearTimeout(timer); resolve(); });
        });
        await done;
        const calls = id ? this.d.agent.usageOf(id)?.usage.calls ?? 0 : 0;
        if (id) { ctl.sessions.delete(id); await this.d.agent.abort(id).catch(() => undefined); }
        return { answer, tools, calls, ms: Date.now() - t0, ...(error ? { error } : {}) };
    }

    private async attempt(a: TeamAgent, c: EvalCase, ctl: { stop: boolean; sessions: Set<string> }): Promise<Attempt> {
        const goal = a.mode === 'mission' && a.goal ? `Goal: ${a.goal.replace(/\{(\w+)\}/g, (m, k) => c.inputs?.[k] ?? m)}\n\n` : '';
        const s = await this.session(`Evaluation: ${a.name} — ${c.name}`, `An evaluation of the agent ${a.name}: answer the task as you would for the team. This session cannot change anything; say what you would change instead.`, profileOf(a), ctl, `${goal}${c.prompt}`);
        const checks: CheckResult[] = [];
        for (const k of c.checks) {
            const g = grade(k, s);
            if (g) { checks.push(g); continue; }
            if (k.kind === 'judge') {
                if (s.error && !s.answer) { checks.push({ check: k, pass: false, detail: 'no answer to grade' }); continue; }
                const j = await this.session(`Evaluation grader: ${a.name} — ${c.name}`, GRADER, { id: 'grader', name: 'Grader', instructions: GRADER, tools: [], ...(a.model ? { model: a.model } : {}) }, ctl,
                    `Task given to the agent:\n${goal}${c.prompt}\n\nThe agent's answer:\n${s.answer || '(no answer)'}\n\nTools it called: ${s.tools.map((t) => t.tool).join(', ') || 'none'}\n\nCriteria:\n${k.criteria}`);
                const verdict = /^\s*\**\s*(PASS|FAIL)\b/i.exec(j.answer)?.[1]?.toUpperCase();
                checks.push({ check: k, pass: verdict === 'PASS', detail: verdict ? j.answer.replace(/^\s*\**\s*(PASS|FAIL)\**[:.\s-]*/i, '').trim().slice(0, 600) || verdict : `the grader gave no verdict${j.error ? ` (${j.error})` : ''}` });
            }
        }
        return { pass: !s.error && checks.every((x) => x.pass), answer: s.answer.slice(0, 20000), tools: s.tools.slice(0, 200), calls: s.calls, ms: s.ms, checks, ...(s.error ? { error: s.error } : {}) };
    }
}

/** JUnit for a pipeline: each case a test case; failures with the checks that failed. */
export function evalJUnit(r: EvalRun): string {
    const x = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const cases = r.cases.map((c) => {
        const fails = c.attempts.flatMap((a, i) => [...(a.error ? [`attempt ${i + 1}: ${a.error}`] : []), ...a.checks.filter((k) => !k.pass).map((k) => `attempt ${i + 1}: ${k.check.kind}: ${k.detail}`)]);
        const secs = c.attempts.reduce((n, a) => n + a.ms, 0) / 1000;
        return `  <testcase classname="${x(`agent.${r.agent}`)}" name="${x(c.name)}" time="${secs.toFixed(1)}">${c.pass ? '' : `<failure message="${x(`${Math.round(c.passRate * 100)}% of attempts passed${c.regression ? ' (regression)' : ''}`)}">${x(fails.join('\n'))}</failure>`}</testcase>`;
    });
    return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${x(`Evaluation: ${r.agentName}`)}" tests="${r.total}" failures="${r.total - r.passed}">\n${cases.join('\n')}\n</testsuite>\n`;
}
