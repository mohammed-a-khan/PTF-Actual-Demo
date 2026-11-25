/**
 * Agent Builder: the team's own agents, made on a screen and kept in the repository (.cs-studio/agents/<id>.json,
 * reviewed and shared like code).
 *
 *  - An agent is an assistant (a chat with its own instructions and starters) or a mission (a goal it works on alone,
 *    in its own copy, checked by the Studio — see missions.ts).
 *  - What it may use is a list of tool groups: reading the Studio, changing things through the Studio, the browser,
 *    test runs, the application's code, changing files, running commands, tool servers (MCP), the knowledge. Anything
 *    outside them is refused, and the repository's agent policy still applies on top.
 *  - What it may look up: some knowledge sources, or all.
 *  - When a mission agent starts by itself: a failed run, a schedule, new or changed work items (a query), new pull
 *    requests (into a branch) — see MissionTriggers.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Budget, MissionInput, MissionTrigger, TeamMission } from './missions';
import { parseCron } from './cron';

export type ToolGroup = 'studio-read' | 'studio-change' | 'browser' | 'tests' | 'app-code' | 'files' | 'shell' | 'tool-servers' | 'knowledge';
export const TOOL_GROUPS: Array<{ id: ToolGroup; label: string; about: string; tools?: string[]; kinds?: string[] }> = [
    { id: 'knowledge', label: 'Knowledge', about: 'Search and read the team\'s knowledge (documents, code, work items, wiki, what runs learned).', tools: ['knowledge_search', 'knowledge_read'] },
    { id: 'studio-read', label: 'Read the Studio', about: 'See every screen\'s data: runs and results, code, API collections, databases (read-only queries), Azure DevOps work items, pull requests, pipelines.', tools: ['studio_context', 'studio_catalog', 'studio_call'] },
    { id: 'studio-change', label: 'Change things through the Studio', about: 'Save files from the screens, start runs, post to Azure DevOps (each change asks for approval unless allowed).' },
    { id: 'tests', label: 'Run tests', about: 'Run features, tags or scenarios with the framework and read the failures.', tools: ['tests_run'] },
    { id: 'browser', label: 'Studio browser', about: 'Open the application, read screens, act and check like a tester; save a manual run as a test.', tools: ['browser_open', 'browser_snapshot', 'browser_scrape', 'browser_screenshot', 'browser_act', 'browser_check', 'browser_recording', 'browser_save_as_test', 'plan_submit'] },
    { id: 'app-code', label: 'Application code', about: 'Check out the application\'s repository (read-only) and search and read it.', tools: ['app_code_checkout', 'app_code_search', 'app_code_read'] },
    { id: 'files', label: 'Change files', about: 'Create and edit files in the repository (or in a mission\'s own copy).', kinds: ['write'] },
    { id: 'shell', label: 'Run commands', about: 'Run shell commands (always asks; refused in unattended runs).', kinds: ['shell'] },
    { id: 'tool-servers', label: 'Tool servers (MCP)', about: 'Use the MCP tool servers added under Agents → Tool servers.', kinds: ['mcp'] },
];
export const ALL_GROUPS = TOOL_GROUPS.map((g) => g.id);

export type AgentTriggerDef =
    | { on: 'run-failed'; projects?: string[]; envs?: string[]; maxPerDay?: number; enabled?: boolean }
    | { on: 'schedule'; cron: string; inputs?: Record<string, string>; maxPerDay?: number; enabled?: boolean }
    | { on: 'work-item'; query: string; input?: string; inputs?: Record<string, string>; maxPerDay?: number; enabled?: boolean; project?: string }
    | { on: 'pull-request'; target?: string; repository?: string; inputs?: Record<string, string>; maxPerDay?: number; enabled?: boolean; project?: string };

export interface TeamAgent {
    id: string; name: string; description?: string;
    mode: 'assistant' | 'mission';
    /** How it works: its role, rules, the steps it follows, what a good result is. */
    instructions: string;
    /** Assistant: suggested first messages. */
    starters?: string[];
    tools: ToolGroup[];
    /** Knowledge sources it may search (none: all). */
    knowledge?: string[];
    /** A model for this agent (within the repository's policy); none: the person's setting. */
    model?: string;
    /** Mission: the goal ({input} filled from its inputs), its inputs, whether it changes files, its budget and proof. */
    goal?: string;
    inputs?: MissionInput[];
    writes?: boolean;
    budget?: Partial<Budget>;
    verify?: TeamMission['verify'];
    triggers?: AgentTriggerDef[];
    /** Mission: the team members it may hand work to (team agents or built-in specialists, by id). */
    team?: string[];
    updatedAt?: string; updatedBy?: string;
}

/** What a session of the agent gets (host.ts). */
export interface AgentProfile { id: string; name: string; instructions: string; tools: ToolGroup[]; knowledge?: string[]; model?: string }
export const profileOf = (a: TeamAgent): AgentProfile => ({ id: a.id, name: a.name, instructions: a.instructions, tools: a.tools, ...(a.knowledge?.length ? { knowledge: a.knowledge } : {}), ...(a.model ? { model: a.model } : {}) });

export const AGENTS_DIR = '.cs-studio/agents';
const ID = /^[a-z0-9][a-z0-9-]{1,39}$/;

export function validateAgent(v: unknown, o: { knowledgeIds?: string[] } = {}): TeamAgent {
    const a = (v ?? {}) as TeamAgent;
    const err = (m: string) => { throw new Error(m); };
    if (!ID.test(String(a.id))) err('The agent id: lower-case letters, digits and - (2 to 40).');
    if (!String(a.name ?? '').trim()) err('Give the agent a name.');
    if (!['assistant', 'mission'].includes(a.mode)) err('Mode: assistant or mission.');
    if (String(a.instructions ?? '').trim().length < 20) err(`Write the agent's instructions: what it does and how, at least 20 characters (now ${String(a.instructions ?? '').trim().length}).`);
    if (!Array.isArray(a.tools)) err('tools is a list of tool groups.');
    for (const t of a.tools) if (!ALL_GROUPS.includes(t)) err(`Unknown tool group "${t}".`);
    if (a.knowledge?.length && o.knowledgeIds) for (const k of a.knowledge) if (!o.knowledgeIds.includes(k)) err(`Unknown knowledge source "${k}".`);
    const seen = new Set<string>();
    const inputs = (a.inputs ?? []).map((i) => {
        if (seen.has(String(i.key))) err(`Two inputs are named "${i.key}": each input needs its own name.`);
        seen.add(String(i.key));
        if (String(i.key).length > 30) err(`Input "${String(i.key).slice(0, 30)}…": at most 30 characters.`);
        else if (!/^[a-z][a-zA-Z0-9]{0,29}$/.test(String(i.key))) err(`Input "${i.key}": a name of letters and digits, starting with a small letter (for example storyId).`);
        return { key: i.key, label: String(i.label || i.key).slice(0, 80), ...(i.required ? { required: true } : {}), ...(i.multiline ? { multiline: true } : {}), ...(i.placeholder ? { placeholder: String(i.placeholder).slice(0, 200) } : {}), ...(i.kind ? { kind: i.kind } : {}) };
    });
    if (a.mode === 'mission') {
        if (!String(a.goal ?? '').trim()) err('A mission agent needs its goal.');
        for (const m of String(a.goal).matchAll(/\{(\w+)\}/g)) if (!inputs.some((i) => i.key === m[1])) err(`The goal uses {${m[1]}}: add that input.`);
        if (a.writes !== false && !a.tools.includes('files')) err('A mission that changes files needs the "Change files" tools (or set it to read only).');
        if (a.verify && !['tests', 'report'].includes(a.verify.kind)) err('Proof: tests or report.');
    }
    const team = [...new Set((a.team ?? []).map(String))];
    if (team.length && a.mode !== 'mission') err('Only a mission agent leads a team.');
    if (team.length > 8) err('A team has at most 8 members.');
    for (const t of team) { if (!ID.test(t)) err(`Team member "${t}": an agent id.`); if (t === a.id) err('An agent is not a member of its own team.'); }
    const triggers = (a.triggers ?? []).map((t) => {
        if (a.mode !== 'mission') err('Only mission agents start by themselves.');
        if (!['run-failed', 'schedule', 'work-item', 'pull-request'].includes(t.on)) err(`Unknown trigger "${(t as { on: string }).on}".`);
        if (t.on === 'schedule' && !parseCron(String(t.cron ?? ''))) err(`"${String(t.cron ?? '').trim()}" is not a schedule: five fields (minute 0-59, hour 0-23, day 1-31, month 1-12, weekday 0-7), e.g. "0 2 * * 1-5" for 02:00 on weekdays.`);
        // A schedule starts the mission with the values it gives: its required inputs must be given (a failed run gives the run).
        if (t.on === 'schedule' && t.enabled !== false) {
            const missing = inputs.filter((i) => i.required && !String(t.inputs?.[i.key] ?? '').trim()).map((i) => i.label);
            if (missing.length) err(`The schedule "${String(t.cron).trim()}" must give the required input${missing.length > 1 ? 's' : ''} ${missing.join(', ')} (or turn the trigger off).`);
        }
        if (t.on === 'work-item' && !/^\s*select\b/i.test(String(t.query ?? ''))) err('A work-item trigger needs a WIQL query (SELECT [System.Id] FROM WorkItems WHERE …).');
        if (t.on === 'work-item' && !inputs.some((i) => i.key === (t.input ?? 'story'))) err(`A work-item trigger fills the input "${t.input ?? 'story'}": add it.`);
        if (t.on === 'pull-request' && !(inputs.some((i) => i.key === 'pr') && inputs.some((i) => i.key === 'repository'))) err('A pull-request trigger fills the inputs "repository" and "pr": add them.');
        return t;
    });
    const allStarters = (a.starters ?? []).map(String).filter((x) => x.trim());
    if (allStarters.length > 6) err(`At most 6 conversation starters (now ${allStarters.length}).`);
    const starters = allStarters;
    return {
        id: a.id, name: String(a.name).trim().slice(0, 80), ...(a.description ? { description: String(a.description).slice(0, 400) } : {}), mode: a.mode,
        instructions: String(a.instructions).slice(0, 20000), ...(starters.length ? { starters } : {}), tools: [...new Set(a.tools)],
        ...(a.knowledge?.length ? { knowledge: [...new Set(a.knowledge)] } : {}), ...(a.model ? { model: String(a.model).slice(0, 80) } : {}),
        ...(a.mode === 'mission' ? { goal: String(a.goal).slice(0, 8000), inputs, writes: a.writes !== false, ...(a.budget ? { budget: a.budget } : {}), ...(a.verify ? { verify: a.verify } : {}), ...(triggers.length ? { triggers } : {}), ...(team.length ? { team } : {}) } : {}),
        ...(a.updatedAt ? { updatedAt: a.updatedAt } : {}), ...(a.updatedBy ? { updatedBy: a.updatedBy } : {}),
    };
}

export function listAgents(repoRoot: string): { agents: TeamAgent[]; problems: string[] } {
    const dir = path.join(repoRoot, AGENTS_DIR);
    const agents: TeamAgent[] = [], problems: string[] = [];
    let files: string[] = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch { return { agents, problems }; }
    for (const f of files) {
        try {
            const a = validateAgent(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
            if (`${a.id}.json` !== f) throw new Error(`its id is "${a.id}" (the file must be ${a.id}.json)`);
            agents.push(a);
        } catch (e) { problems.push(`${AGENTS_DIR}/${f}: ${(e as Error).message}`); }
    }
    return { agents, problems };
}
export function getAgent(repoRoot: string, id: string): TeamAgent | undefined { return ID.test(id) ? listAgents(repoRoot).agents.find((a) => a.id === id) : undefined; }

export function saveAgent(repoRoot: string, v: unknown, by: string, o: { knowledgeIds?: string[]; reserved?: string[]; isNew?: boolean } = {}): TeamAgent {
    const a = validateAgent(v, o);
    if (o.reserved?.includes(a.id)) throw new Error(`"${a.id}" is the name of a built-in mission: choose another id.`);
    const file = path.join(repoRoot, AGENTS_DIR, `${a.id}.json`);
    if (o.isNew && fs.existsSync(file)) throw new Error(`An agent "${a.id}" exists.`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const out = { ...a, updatedAt: new Date().toISOString(), updatedBy: by };
    fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
    return out;
}
export function deleteAgent(repoRoot: string, id: string): void {
    if (!ID.test(id)) throw new Error('Invalid agent id.');
    const file = path.join(repoRoot, AGENTS_DIR, `${id}.json`);
    if (!fs.existsSync(file)) throw new Error('No such agent.');
    fs.rmSync(file);
}

/** A mission agent as a team mission (missions.ts runs it) with its profile. */
export function asTeamMission(a: TeamAgent): TeamMission & { profile: AgentProfile } {
    return { key: a.id, title: a.name, about: a.description || (a.goal ?? '').replace(/\{(\w+)\}/g, (_m, k: string) => `<${(a.inputs ?? []).find((i) => i.key === k)?.label || k}>`).slice(0, 200), goal: `${a.goal}\n\nHow to work (the team's instructions for this agent):\n${a.instructions}`, inputs: a.inputs, writes: a.writes !== false, ...(a.budget ? { budget: a.budget } : {}), ...(a.verify ? { verify: a.verify } : {}), ...(a.team?.length ? { team: a.team } : {}), profile: profileOf(a) };
}
/** The run-failed and schedule triggers of mission agents, in missions.json's form; work-item / pull-request ones are polled. */
export function simpleTriggers(agents: TeamAgent[]): MissionTrigger[] {
    const out: MissionTrigger[] = [];
    for (const a of agents) for (const t of a.triggers ?? []) {
        if (t.on === 'run-failed') out.push({ mission: a.id, on: 'run-failed', ...(t.projects ? { projects: t.projects } : {}), ...(t.envs ? { envs: t.envs } : {}), ...(t.maxPerDay ? { maxPerDay: t.maxPerDay } : {}), ...(t.enabled === false ? { enabled: false } : {}) });
        if (t.on === 'schedule') out.push({ mission: a.id, on: 'schedule', cron: t.cron, ...(t.inputs ? { inputs: t.inputs } : {}), ...(t.maxPerDay ? { maxPerDay: t.maxPerDay } : {}), ...(t.enabled === false ? { enabled: false } : {}) });
    }
    return out;
}

/** Starting points for a new agent. */
export const AGENT_TEMPLATES: TeamAgent[] = [
    {
        id: 'test-reviewer', name: 'Test reviewer', mode: 'assistant', description: 'Reviews features, steps and page objects against the team\'s standards and the framework\'s conventions.',
        instructions: 'You review test code. For the file or change the person names: check it follows the framework\'s standards (Scenario Outlines with JSON test data, reused steps, page objects with @CSGetElement, no hard-coded passwords or addresses, stable locators), find duplicated or near-duplicate steps (search the knowledge), and list concrete improvements with the file and line. Do not change files: suggest the change.',
        starters: ['Review the feature open in the editor', 'Which steps in this project are near-duplicates?', 'Are there hard-coded passwords or URLs anywhere in the tests?'],
        tools: ['knowledge', 'studio-read'],
    },
    {
        id: 'failure-analyst', name: 'Failure analyst', mode: 'assistant', description: 'Explains why tests failed, with evidence, and what to do about it.',
        instructions: 'You explain test failures. Read the run\'s failures and evidence (screenshots, traces, errors) through the Studio, look up earlier failures and fixes in the knowledge, and for each failure say: the cause (test, application, environment, data, flaky), the evidence, and the next step. When it is an application bug, draft the bug text (steps, expected, actual).',
        starters: ['Why did the last run fail?', 'Which failures this week are flaky?', 'Draft a bug for the checkout failure'],
        tools: ['knowledge', 'studio-read', 'tests'],
    },
    {
        id: 'story-to-tests', name: 'Story to tests', mode: 'mission', description: 'Turns a work item into a reviewed plan, then the framework test, proven by running it.',
        instructions: 'Read the work item and its acceptance criteria. Search the knowledge for similar features, steps to reuse and how the application behaves. Submit a plan (mission_ask, kind plan) and wait. Then write the feature, data, steps and page objects to the framework\'s standards, and run them until they pass.',
        goal: 'Automate the work item {story} in project {project}, environment {env}.',
        inputs: [{ key: 'project', label: 'Project', required: true, kind: 'project' }, { key: 'env', label: 'Environment', required: true, kind: 'env' }, { key: 'story', label: 'Work item', required: true }],
        tools: ['knowledge', 'studio-read', 'tests', 'browser', 'files', 'app-code'], writes: true, verify: { kind: 'tests', features: 'changed' }, budget: { minutes: 90, modelCalls: 250, attempts: 3 },
    },
    {
        id: 'nightly-health', name: 'Nightly test health', mode: 'mission', description: 'Each night: runs the smoke tests, explains every failure, fixes what is a test problem.',
        instructions: 'Run the tests of the given tags. For each failure find the cause with the evidence and the knowledge; fix test causes only; report application bugs with their steps.',
        goal: 'The {tags} tests of project {project} in {env} pass, or each failure is explained.',
        inputs: [{ key: 'project', label: 'Project', required: true, kind: 'project' }, { key: 'env', label: 'Environment', required: true, kind: 'env' }, { key: 'tags', label: 'Tags', required: true, placeholder: '@smoke' }],
        tools: ['knowledge', 'studio-read', 'tests', 'browser', 'files'], writes: true, verify: { kind: 'tests', tags: '{tags}' }, budget: { minutes: 45, modelCalls: 120, attempts: 2 },
        triggers: [{ on: 'schedule', cron: '0 2 * * 1-5', inputs: { project: '', env: '', tags: '@smoke' }, enabled: false }],
    },
];

/**
 * Built-in specialists a mission can hand work to (besides the team's own agents). Each works in its own session
 * with its own tools; the lead combines their answers.
 */
export const SPECIALISTS: TeamAgent[] = [
    {
        id: 'analyst', name: 'Requirements analyst', mode: 'assistant', description: 'Reads the work item, its acceptance criteria and the knowledge; lists the scenarios to test (positive, negative, edge) and what to reuse.',
        instructions: 'You analyse what must be tested. Read the work item (studio_call GET /api/ado/workitems/<id>) or the story given, its acceptance criteria and linked items; search the knowledge for the area, earlier bugs, existing features and steps. Answer with: the scenarios to test (one line each: positive, negative, edge, with the data they need), the existing features, steps and page objects to reuse (paths), and open questions. Change nothing.',
        tools: ['knowledge', 'studio-read', 'app-code'],
    },
    {
        id: 'explorer', name: 'Application explorer', mode: 'assistant', description: 'Walks the screens in the Studio browser and reports the flow, stable locators, data and anything surprising.',
        instructions: 'You explore the application like a tester. Open it in the Studio browser, follow the flow you are given, and for each screen record: what it shows, the elements to use with stable locators (role and name, id, data-testid before CSS), the data that works, messages and errors. Try one or two wrong inputs. Answer with this as a list per screen. Change no files.',
        tools: ['browser', 'knowledge', 'studio-read'],
    },
    {
        id: 'author', name: 'Test author', mode: 'assistant', description: 'Writes the feature, data, steps and page objects to the framework\'s standards and runs them until they pass.',
        instructions: 'You write framework tests. Reuse existing steps and page objects first (search the knowledge). Write Scenario Outlines with JSON test data and runFlag, page objects with @CSGetElement and stable locators, steps worded like the existing ones; no hard-coded passwords or addresses. Run what you wrote with tests_run and fix it until it passes. Answer with the files you created or changed and the last run\'s result.',
        tools: ['knowledge', 'studio-read', 'files', 'tests', 'browser'],
    },
];

/** A team member by id: the team's own agent, else a built-in specialist or assistant template. */
export function teamMember(repoRoot: string, id: string): TeamAgent | undefined {
    return getAgent(repoRoot, id) ?? SPECIALISTS.find((a) => a.id === id) ?? AGENT_TEMPLATES.find((a) => a.id === id && a.mode === 'assistant');
}
/** Every agent a mission can have on its team. */
export function teamCandidates(repoRoot: string): Array<{ id: string; name: string; description?: string; tools: ToolGroup[]; builtIn: boolean }> {
    const own = listAgents(repoRoot).agents.map((a) => ({ id: a.id, name: a.name, ...(a.description ? { description: a.description } : {}), tools: a.tools, builtIn: false }));
    const builtIn = [...SPECIALISTS, ...AGENT_TEMPLATES.filter((a) => a.mode === 'assistant')].filter((a) => !own.some((o) => o.id === a.id)).map((a) => ({ id: a.id, name: a.name, ...(a.description ? { description: a.description } : {}), tools: a.tools, builtIn: true }));
    return [...own, ...builtIn];
}
