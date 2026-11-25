/**
 * Missions: agents that work toward a goal on their own and are checked by the Studio, not by their own word.
 *
 *  - A mission is a goal (a template: fix a failed run, automate a story, heal locators, hunt a flaky test, find
 *    coverage gaps, review a pull request, or the team's own in .cs-studio/missions.json) with inputs.
 *  - Isolation: a mission that changes files works in its own copy of the repository (a Git worktree on the branch
 *    cs-studio/mission-<id>, from the person's current commit), so the person's working copy is never touched.
 *    Inside that copy its file changes need no approval when started with that autonomy (the repository's agent
 *    policy can still ask for every change); anything outside it (Azure DevOps, Git push) asks the person.
 *  - Budget: minutes of work, model calls and verification attempts. Over budget, the mission stops.
 *  - Checkpoints: the agent asks the person (mission_ask: a question, or a plan to approve) and waits; the mission
 *    shows "waiting for you" and notifies. Waiting time does not count against the budget.
 *  - Verification: when the agent reports (mission_report), the Studio runs the proof itself in the mission's copy
 *    (the failed scenarios again, the features it wrote, a scenario N times in a row). A failed verification goes
 *    back to the agent with the failures, up to the attempts in the budget.
 *  - Result: the work committed on the mission's branch with a report (what was done, findings, verification),
 *    ready to bring into the working copy, publish as a pull request, or discard.
 *  - Triggers: a failed run, a schedule (cron) — from .cs-studio/missions.json — or a person.
 *  - Memory: the agent proposes notes for the team (.cs-studio/agent-memory.md); a person accepts them.
 */
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { runGit } from '../git/run';
import { prepareCopy, removeCopy } from '../git/prWorktree';
import type { RunInfo, RunRequest, RunSummary } from '../run/runner';
import type { AgentEvent, MissionSessionOptions, Usage } from './host';
import type { ToolDef } from './tools';
import type { StudioBrowser } from './browser';
import { asTeamMission, BUDGET_LIMITS, listAgents, profileOf, simpleTriggers, teamMember, wholeProblem, type AgentProfile, type TeamAgent, type ToolGroup } from './builder';

// ---------------------------------------------------------------------------------------------- definitions

export interface MissionInput { key: string; label: string; required?: boolean; multiline?: boolean; placeholder?: string; kind?: 'project' | 'env' | 'run' | 'text' | 'number' }
export interface Budget { minutes: number; modelCalls: number; attempts: number }
export type Autonomy = 'supervised' | 'autonomous';

/** What the agent reports with mission_report. */
export interface MissionReport {
    outcome: 'done' | 'partial' | 'blocked';
    summary: string;
    findings?: Array<{ scenario?: string; cause?: 'test' | 'product' | 'environment' | 'flaky' | 'data' | 'unknown'; detail: string; fixed?: boolean }>;
    /** What proves the work (the Studio runs it). */
    verify?: { features?: string[]; scenarios?: string[]; tags?: string };
    /** Defects in the application, for the person to raise. */
    bugs?: Array<{ title: string; detail: string; filed?: { id: number; url: string; by: string; at: string } }>;
}

/** The proof the Studio runs: tests in the mission's copy, or the report alone (read-only missions). */
export type VerifyPlan = { kind: 'tests'; request: RunRequest; repeat: number; why: string } | { kind: 'report'; why: string } | { kind: 'fail'; why: string };

export interface MissionContext { inputs: Record<string, string>; run?: RunInfo; reproduced?: RunSummary; changedFiles: string[] }

export interface MissionTemplate {
    key: string; title: string; about: string;
    inputs: MissionInput[];
    /** Inputs of which at least one must be given (a failed run, or a project to run first). */
    oneOf?: string[];
    /** Changes files (works in its own copy) or only reads and reports. */
    writes: boolean;
    budget: Budget;
    /** Run the failed scenarios first, in the copy, before the agent starts (what still fails, what was flaky). */
    reproduce?: boolean;
    goal: (c: MissionContext) => string;
    verify: (c: MissionContext, r: MissionReport) => VerifyPlan;
    /** A team agent's tools, knowledge, model and instructions (Agent Builder). */
    profile?: AgentProfile;
    /** Team members the mission may hand work to (agent ids: the team's own or built-in specialists). */
    team?: string[];
    /** An exploratory session: findings are logged with explore_note; the report needs the screens covered. */
    explore?: boolean;
}

const P: MissionInput = { key: 'project', label: 'Project', required: true, kind: 'project' };
const E: MissionInput = { key: 'env', label: 'Environment', required: true, kind: 'env' };

const failuresText = (s?: RunSummary, max = 15) => (s?.scenarios ?? []).filter((x) => x.status === 'failed').slice(0, max)
    .map((x, i) => `${i + 1}. "${x.name}" (${x.feature})${x.error ? `\n   Error: ${x.error.replace(/\s+/g, ' ').slice(0, 600)}` : ''}`).join('\n');

const PROTOCOL = `How a mission works:
- You work alone toward the goal; the person is not watching. Decide, act, check your work, and keep going until the goal is met or you are truly blocked.
- When you need the person (a decision only they can make, access you lack, a plan they must approve), call mission_ask and wait for the answer. Do not ask for things you can find out yourself.
- When you are done, call mission_report once: outcome (done / partial / blocked), a short summary, your findings, and what proves the work (verify: the feature files, scenario names or tags to run). The Studio then runs that proof itself in your copy; if it fails, you get the failures and continue.
- Run tests with tests_run (in your copy) as often as you need while working.
- Something the team should know next time (an application quirk, a sign-in detail, a convention)? Propose it with memory_propose.
- Never change production data, never weaken a check to make a test pass, never hard-code passwords or environment addresses.`;

export const TEMPLATES: MissionTemplate[] = [
    {
        key: 'fix-failing', title: 'Fix a failed run', oneOf: ['run', 'project'],
        about: 'Reproduces the failures, finds the cause of each (test, application, environment, data, flaky), fixes the tests where the test is wrong and lists application bugs. The Studio reruns the fixed scenarios to prove it.',
        inputs: [{ key: 'run', label: 'Failed run', kind: 'run', placeholder: 'Or give the project, environment and tags: the tests run first' },
            { key: 'project', label: 'Project (instead of a run)', kind: 'project' }, { key: 'env', label: 'Environment (instead of a run)', kind: 'env' }, { key: 'tags', label: 'Tags (instead of a run)', placeholder: 'e.g. @smoke' }],
        writes: true, reproduce: true, budget: { minutes: 45, modelCalls: 120, attempts: 3 },
        goal: (c) => {
            const r = c.run!;
            const still = new Set((c.reproduced?.scenarios ?? []).filter((x) => x.status === 'failed').map((x) => x.name));
            const flaky = (r.summary?.scenarios ?? []).filter((x) => x.status === 'failed' && c.reproduced && !still.has(x.name)).map((x) => x.name);
            return `Goal: the scenarios that failed in run ${r.id} (project ${r.request.project}, environment ${r.request.env}) pass again — or each one has its real cause explained.
Failures in that run:
${failuresText(r.summary)}
${c.reproduced ? `\nThe Studio ran them again in your copy before you started: ${still.size} still fail${flaky.length ? `; these passed this time (look for timing or data dependence): ${flaky.map((n) => `"${n}"`).join(', ')}` : ''}.\n` : ''}
For each failure:
1. Find the cause: read the error and the evidence (studio_call GET /api/runs/${r.id}/evidence), the feature, its steps and page objects; open the application in the Studio browser to see the screen as it is now.
2. Classify it: test (a locator, wait, step or data in the test is wrong or out of date), product (the application does not do what the story says), environment (the system or a service was down), data, or flaky.
3. Fix only test causes, in the test code (page objects, steps, data); keep the check's intent. For product bugs write what a bug report needs (steps, expected, actual) in bugs.
4. Run the fixed scenarios with tests_run until they pass.
Report with findings for every failure (scenario, cause, detail, fixed) and verify.scenarios = the scenarios you fixed.`;
        },
        verify: (c, r) => {
            const failed = new Set((c.run?.summary?.scenarios ?? []).filter((x) => x.status === 'failed').map((x) => x.name));
            const fixed = [...new Set((r.findings ?? []).filter((f) => f.fixed && f.scenario && failed.has(f.scenario)).map((f) => f.scenario!))];
            const claimed = [...new Set([...fixed, ...(r.verify?.scenarios ?? []).filter((n) => failed.has(n))])];
            if (!claimed.length) {
                const explained = (r.findings ?? []).filter((f) => f.scenario && failed.has(f.scenario)).length;
                return explained >= failed.size ? { kind: 'report', why: 'No test was changed: every failure is explained as not a test problem.' } : { kind: 'fail', why: `Report a finding for each of the ${failed.size} failures (or fix them): ${explained} explained.` };
            }
            return { kind: 'tests', request: { project: c.run!.request.project, env: c.run!.request.env, scenarios: claimed, headless: true }, repeat: 1, why: `The ${claimed.length} scenario(s) reported fixed run again in the mission's copy.` };
        },
    },
    {
        key: 'automate-story', title: 'Automate a story',
        about: 'Plans the scenarios (you approve the plan), explores the application, writes the feature, test data, page objects and steps to the framework\'s standards, and runs them until they pass. The Studio runs the new features to prove it.',
        inputs: [P, E, { key: 'story', label: 'Story', required: true, multiline: true, placeholder: 'Azure DevOps work item number, or the story and its acceptance criteria' }, { key: 'url', label: 'Application address', placeholder: 'Empty: BASE_URL of the environment' }],
        writes: true, budget: { minutes: 90, modelCalls: 250, attempts: 3 },
        goal: (c) => `Goal: the story below is automated in project ${c.inputs.project}, environment ${c.inputs.env}, and its new feature passes.
Story: ${/^\d+$/.test(c.inputs.story.trim()) ? `Azure DevOps work item ${c.inputs.story.trim()} (read it and its acceptance criteria: studio_call GET /api/ado/workitems/${c.inputs.story.trim()})` : c.inputs.story}
Application: ${c.inputs.url || `the BASE_URL of ${c.inputs.env}`}.
1. Read the existing features, steps and pages of the project first; reuse them.
2. Write the plan: one scenario per acceptance criterion (positive and negative), steps worded like existing ones. Submit it with mission_ask (kind "plan", the feature text as content) and wait for approval or changes.
3. Explore the screens in the Studio browser for locators and data; write the feature (Scenario Outline with JSON test data and runFlag), page objects, steps and data to the framework's standards.
4. Run the feature with tests_run and fix it until it passes; run it once more.
Report with verify.features = the feature files you wrote.`,
        verify: (c, r) => {
            const features = [...new Set([...c.changedFiles.filter((f) => f.endsWith('.feature')), ...(r.verify?.features ?? []).filter((f) => c.changedFiles.includes(f))])];
            if (!features.length) return { kind: 'fail', why: 'No feature file was written in the mission\'s copy.' };
            return { kind: 'tests', request: { project: c.inputs.project, env: c.inputs.env, features, headless: true }, repeat: 1, why: `The ${features.length} new or changed feature(s) run in the mission's copy.` };
        },
    },
    {
        key: 'heal-locators', title: 'Update healed locators',
        about: 'Takes the locators the framework had to heal in recent runs, updates the page objects with stable locators, and proves them by running the scenarios that use them without healing.',
        inputs: [P, E],
        writes: true, budget: { minutes: 40, modelCalls: 100, attempts: 2 },
        goal: (c) => `Goal: the page objects of project ${c.inputs.project} use locators that work without healing.
1. List the healed locators waiting for review: studio_call GET /api/healing (and the details of each group).
2. For each, look at the element in the Studio browser (environment ${c.inputs.env}) and choose a stable locator (role + name, label, test id; the healed one only if it is stable). Update the page object in your copy.
3. Run the scenarios that use those pages with tests_run until they pass without healing.
Report with findings per locator and verify.scenarios (or features) = what uses the changed pages.`,
        verify: (c, r) => {
            const v = r.verify ?? {};
            if (!v.scenarios?.length && !v.features?.length && !v.tags) return { kind: 'fail', why: 'Say what proves the new locators: verify.scenarios, verify.features or verify.tags.' };
            return { kind: 'tests', request: { project: c.inputs.project, env: c.inputs.env, ...(v.scenarios?.length ? { scenarios: v.scenarios } : {}), ...(v.features?.length ? { features: v.features } : {}), ...(v.tags ? { tags: v.tags } : {}), headless: true }, repeat: 1, why: 'The scenarios using the changed page objects run in the mission\'s copy.' };
        },
    },
    {
        key: 'flaky-hunter', title: 'Make a flaky scenario stable',
        about: 'Runs a scenario that passes and fails by turns, finds why (timing, data, order, environment) and fixes the test. The Studio runs it several times in a row: all must pass.',
        inputs: [P, E, { key: 'scenario', label: 'Scenario name', required: true }, { key: 'repeat', label: 'Runs in a row to prove it', kind: 'number', placeholder: '5' }],
        writes: true, budget: { minutes: 60, modelCalls: 150, attempts: 3 },
        goal: (c) => `Goal: the scenario "${c.inputs.scenario}" (project ${c.inputs.project}, environment ${c.inputs.env}) passes every time.
1. Look at its history (studio_call GET /api/quality/history) and its failures; run it several times with tests_run.
2. Find the cause: waits on a fixed time instead of a state, data shared with other scenarios or left over, order dependence, animations, slow services.
3. Fix the test (wait for the state that matters, unique test data, clean-up); never add fixed sleeps or weaken the check.
Report with the cause in findings. The Studio runs it ${Number(c.inputs.repeat) || 5} times in a row.`,
        verify: (c) => ({ kind: 'tests', request: { project: c.inputs.project, env: c.inputs.env, scenarios: [c.inputs.scenario], headless: true }, repeat: Math.min(Math.max(Number(c.inputs.repeat) || 5, 2), 20), why: 'The scenario runs several times in a row in the mission\'s copy; every run must pass.' }),
    },
    {
        key: 'coverage-gaps', title: 'Find coverage gaps',
        about: 'Compares the stories and test cases in Azure DevOps (an area or sprint) with the automated scenarios, and reports what is not covered, what is covered twice, and what to automate first. Reads only.',
        inputs: [P, { key: 'scope', label: 'Which work items', required: true, placeholder: 'e.g. area Shop\\Checkout, the current sprint, or a list of work item numbers' }],
        writes: false, budget: { minutes: 30, modelCalls: 80, attempts: 1 },
        goal: (c) => `Goal: a coverage report for project ${c.inputs.project}: which stories and acceptance criteria in "${c.inputs.scope}" have automated scenarios, which do not, and what to automate first.
Use the Azure DevOps work items and test plans (studio_catalog area ado) and the project's features (tags such as @TestCaseId, @story, names). Read only.
Report: summary = the overview; findings = one per story or criterion without coverage (detail: what is missing and why it matters), most important first.`,
        verify: () => ({ kind: 'report', why: 'A read-only mission: the report is the result.' }),
    },
    {
        key: 'review-pr', title: 'Review a pull request\'s tests',
        about: 'Reads a pull request\'s changes, picks the tests it affects, runs them, and writes a review: what is covered, what is missing, risks. You decide whether to post it. Reads only.',
        inputs: [{ key: 'repository', label: 'Repository', required: true }, { key: 'pr', label: 'Pull request number', required: true, kind: 'number' }],
        writes: false, budget: { minutes: 40, modelCalls: 80, attempts: 1 },
        goal: (c) => `Goal: a review of pull request ${c.inputs.pr} in ${c.inputs.repository} from the testing side.
1. Read it: studio_call GET /api/ado/prs/${encodeURIComponent(c.inputs.repository)}/${c.inputs.pr} (changes, work items) and the impact (studio_call GET /api/ado/prs/${encodeURIComponent(c.inputs.repository)}/${c.inputs.pr}/impact).
2. Say which scenarios cover the change, which acceptance criteria or paths have no test, and the risks.
3. If you can run the impacted tests (studio_call POST /api/ado/prs/.../run, the person approves), do and include the result.
Report: summary = the review as you would post it (Markdown); findings = each gap or risk. Do not post anything.`,
        verify: () => ({ kind: 'report', why: 'A read-only mission: the review is the result.' }),
    },
];

/** A team mission from .cs-studio/missions.json. */
{
    const story = TEMPLATES.find((t) => t.key === 'automate-story')!;
    TEMPLATES.push({
        key: 'team-story', title: 'Automate a story as a team',
        about: 'A lead agent runs a team: the analyst lists the scenarios, the explorer walks the screens, the author writes and runs the tests, the reviewer checks them against the standards. You approve the plan; the Studio runs the new features to prove it.',
        inputs: story.inputs, writes: true, budget: { minutes: 120, modelCalls: 400, attempts: 3 },
        team: ['analyst', 'explorer', 'author', 'test-reviewer'],
        goal: (c) => `${story.goal(c)}

You lead a team; work through them:
1. analyst and explorer at the same time: the analyst lists the scenarios and what to reuse; the explorer walks the screens of the story and reports locators and data.
2. Combine their answers into the plan; submit it with mission_ask (kind "plan") and wait.
3. author: the approved plan, the explorer's locators and data, the files to reuse. It writes and runs the tests.
4. test-reviewer: the files the author wrote. If it finds problems, hand them back to the author.
5. Run the features yourself with tests_run, then report.`,
        verify: story.verify,
    });
}

TEMPLATES.push({
    key: 'explore-app', title: 'Explore the application',
    about: 'An exploratory testing session on a charter: tours the screens like a tester (wrong input, limits, back and refresh, double submit, empty and long values), logs what it covered, bugs with steps and screenshots, risks, questions and test ideas. Several explorers can tour at once, each in its own browser. Changes nothing.',
    inputs: [P, E, { key: 'charter', label: 'Charter', required: true, multiline: true, placeholder: 'What to explore and what to look for, e.g. the checkout with discount codes: wrong, expired and stacked codes, rounding' }, { key: 'url', label: 'Application address', placeholder: 'Empty: BASE_URL of the environment' }, { key: 'explorers', label: 'Explorers at once (1 to 3)', kind: 'number', placeholder: '1' }],
    writes: false, explore: true, team: ['explorer'], budget: { minutes: 60, modelCalls: 200, attempts: 1 },
    goal: (c) => {
        const n = Math.min(Math.max(parseInt(c.inputs.explorers || '1', 10) || 1, 1), TEAM_PARALLEL);
        return `Goal: an exploratory testing session on this charter, in project ${c.inputs.project}, environment ${c.inputs.env}.
Charter: ${c.inputs.charter}
Application: ${c.inputs.url || `the BASE_URL of ${c.inputs.env} (read it with studio_call GET /api/env/resolve?project=${c.inputs.project}&env=${c.inputs.env})`}.

Explore like an experienced tester, not a script:
- Tours: the main flow first; then wrong and missing input, limits (0, negative, very long, special characters, other languages), back / refresh / a second tab mid-flow, double submit, empty states, sorting and paging, what a user without the right role sees, messages and their wording.
- Look the area up in the knowledge first (earlier bugs, stories, existing tests): go where tests do not.
- Log everything with explore_note as you go: each screen or flow you covered (and what you tried), each bug (severity, steps, screenshot: true), risks, questions for the team, and test ideas worth automating.
- Change nothing in the repository; do not use production data you cannot undo.
${n > 1 ? `
Split the charter into ${n} tours and hand each to an explorer with team_delegate at the same time (each has its own browser); tell each to log with explore_note. Then explore what they missed yourself.
` : ''}
Report with a summary: what was covered, the most important findings, and what should be explored or automated next.`;
    },
    verify: () => ({ kind: 'report', why: 'An exploration ends with its log and report.' }),
});

export interface TeamMission { key: string; title: string; about?: string; goal: string; inputs?: MissionInput[]; writes?: boolean; team?: string[]; budget?: Partial<Budget>; verify?: { kind: 'tests'; features?: 'changed' | string[]; tags?: string; scenarios?: string[]; repeat?: number } | { kind: 'report' } }
export interface MissionTrigger { mission: string; on: 'run-failed' | 'schedule'; cron?: string; projects?: string[]; envs?: string[]; inputs?: Record<string, string>; autonomy?: Autonomy; maxPerDay?: number; enabled?: boolean }
export interface MissionsFile { missions?: TeamMission[]; triggers?: MissionTrigger[] }
export const MISSIONS_FILE = '.cs-studio/missions.json';

export function readMissionsFile(repoRoot: string): { file: MissionsFile; problems: string[] } {
    const f = path.join(repoRoot, MISSIONS_FILE);
    if (!fs.existsSync(f)) return { file: {}, problems: [] };
    try {
        const v = JSON.parse(fs.readFileSync(f, 'utf8')) as MissionsFile;
        const problems: string[] = [];
        for (const t of v.triggers ?? []) {
            if (t.on === 'schedule' && (!t.cron || !parseCron(t.cron))) problems.push(`Trigger for ${t.mission}: "${t.cron ?? ''}" is not a cron line (five fields).`);
            if (!['run-failed', 'schedule'].includes(t.on)) problems.push(`Trigger for ${t.mission}: on is run-failed or schedule.`);
        }
        for (const m of v.missions ?? []) if (!/^[a-z0-9-]{2,40}$/.test(m.key ?? '') || !m.title || !m.goal) problems.push(`Team mission "${m.key ?? '?'}": key (a-z, 0-9, -), title and goal are needed.`);
        return { file: v, problems };
    } catch (e) { return { file: {}, problems: [`${MISSIONS_FILE} is not valid JSON: ${(e as Error).message}`] }; }
}

const fill = (t: string, v: Record<string, string>) => t.replace(/\{(\w+)\}/g, (m, k) => v[k] ?? m);
export function teamTemplate(t: TeamMission & { profile?: AgentProfile }): MissionTemplate {
    const writes = t.writes !== false;
    return {
        ...(t.profile ? { profile: t.profile } : {}),
        ...(t.team?.length ? { team: t.team } : {}),
        key: t.key, title: t.title, about: t.about ?? t.goal.slice(0, 200), inputs: t.inputs ?? [P, E], writes,
        budget: { minutes: 45, modelCalls: 120, attempts: writes ? 3 : 1, ...(t.budget ?? {}) },
        goal: (c) => `Goal: ${fill(t.goal, c.inputs)}\nReport with what proves it in verify.`,
        verify: (c, r) => {
            const v = t.verify ?? (writes ? { kind: 'tests', features: 'changed' } : { kind: 'report' });
            if (v.kind === 'report') return { kind: 'report', why: 'The team mission ends with its report.' };
            const features = v.features === 'changed' ? c.changedFiles.filter((f) => f.endsWith('.feature')) : v.features;
            const req: RunRequest = { project: c.inputs.project, env: c.inputs.env, headless: true, ...(features?.length ? { features } : {}), ...(v.tags ? { tags: fill(v.tags, c.inputs) } : {}), ...(v.scenarios?.length ? { scenarios: v.scenarios } : {}) };
            if (!req.features && !req.tags && !req.scenarios) {
                const rv = r.verify ?? {};
                if (!rv.features?.length && !rv.scenarios?.length && !rv.tags) return { kind: 'fail', why: 'Nothing to run as proof: change a feature or say what to run in verify.' };
                Object.assign(req, rv.features?.length ? { features: rv.features } : {}, rv.scenarios?.length ? { scenarios: rv.scenarios } : {}, rv.tags ? { tags: rv.tags } : {});
            }
            return { kind: 'tests', request: req, repeat: Math.min(Math.max(v.repeat ?? 1, 1), 20), why: 'The team mission\'s proof runs in the mission\'s copy.' };
        },
    };
}

export function templates(repoRoot: string): MissionTemplate[] {
    const team = (readMissionsFile(repoRoot).file.missions ?? []).filter((m) => /^[a-z0-9-]{2,40}$/.test(m.key ?? '') && m.title && m.goal && !TEMPLATES.some((t) => t.key === m.key));
    // Mission agents made in the Agent Builder (.cs-studio/agents).
    const agents = listAgents(repoRoot).agents.filter((a) => a.mode === 'mission' && !TEMPLATES.some((t) => t.key === a.id) && !team.some((m) => m.key === a.id)).map(asTeamMission);
    return [...TEMPLATES, ...team.map(teamTemplate), ...agents.map(teamTemplate)];
}

// ---------------------------------------------------------------------------------------------- cron

export { cronMatches, parseCron } from './cron';
import { cronMatches, parseCron } from './cron';

// ---------------------------------------------------------------------------------------------- runs

export type MissionState = 'queued' | 'preparing' | 'working' | 'waiting' | 'verifying' | 'succeeded' | 'partial' | 'failed' | 'blocked' | 'over-budget' | 'stopped';
export const FINISHED: MissionState[] = ['succeeded', 'partial', 'failed', 'blocked', 'over-budget', 'stopped'];

export interface Verification { at: string; attempt: number; passed: boolean; why: string; runs: Array<{ id: string; state: string; passed?: number; failed?: number }>; failures: Array<{ name: string; error?: string }> }
export interface Checkpoint { id: string; kind: 'question' | 'plan'; question: string; content?: string; options?: string[]; at: string; answer?: string; answeredAt?: string; by?: string }

export interface MissionRun {
    id: string; key: string; title: string; inputs: Record<string, string>;
    state: MissionState; reason?: string;
    trigger: { kind: 'manual' | 'run-failed' | 'schedule' | 'pipeline' | 'work-item' | 'pull-request'; by: string; ref?: string };
    autonomy: Autonomy;
    /** No one answers (a pipeline): questions get "decide yourself", plans proceed, approvals are refused. */
    unattended?: boolean;
    createdAt: string; endedAt?: string;
    budget: Budget; used: { activeMs: number; modelCalls: number; inputTokens: number; outputTokens: number; cost: number; attempts: number };
    session?: string;
    /** The mission's copy: folder relative to the repository, its branch, the commit it started from. */
    copy?: { rel: string; branch: string; base: string; dirtyAtStart?: boolean };
    commit?: string;
    changes: Array<{ path: string; status: string }>;
    timeline: Array<{ at: string; text: string; kind: 'phase' | 'note' | 'tool' | 'verify' | 'ask' | 'error' | 'team' }>;
    checkpoints: Checkpoint[];
    /** Approvals the agent is waiting for now (shown in the mission; answered there or in the conversation). */
    approvals?: Array<{ id: string; title: string; detail: string; kind: string; session?: string; who?: string }>;
    /** Work handed to team members: each in its own session, with its own tools. */
    team?: TeamTask[];
    /** An exploratory session's log: what was covered, bugs, risks, questions, test ideas. */
    exploration?: { notes: ExploreNote[] };
    report?: MissionReport;
    verifications: Verification[];
    memory: Array<{ id: string; note: string; state: 'proposed' | 'accepted' | 'dismissed' }>;
    result?: { kind: 'applied' | 'pr' | 'discarded'; at: string; detail?: string };
}

export type ExploreKind = 'covered' | 'bug' | 'risk' | 'question' | 'idea';
export interface ExploreNote { id: string; kind: ExploreKind; title: string; detail?: string; screen?: string; severity?: 'high' | 'medium' | 'low'; steps?: string[]; shot?: string; by?: string; at: string }
export interface TeamTask {
    id: string; member: string; name: string; task: string; session?: string;
    state: 'working' | 'done' | 'failed' | 'stopped'; answer?: string; startedAt: string; endedAt?: string;
    used?: { modelCalls: number; inputTokens: number; outputTokens: number; cost: number };
}
/** At most this many members work at once, and this many tasks per mission. */
export const TEAM_PARALLEL = 3, TEAM_TASKS = 12;
/** Tool groups a member keeps in a mission that only reads. */
const READ_ONLY_GROUPS: ToolGroup[] = ['knowledge', 'studio-read', 'tests', 'browser', 'app-code'];

export interface MissionAgent {
    start(o: { title: string; workflow: string; mission: MissionSessionOptions }): Promise<{ id: string }>;
    send(id: string, text: string): Promise<void>;
    abort(id: string): Promise<void>;
    usageOf(id: string): { usage: Usage; busy: boolean; pending: number } | null;
    /** Approvals the agent waits for (a shell command, a change outside its copy…). */
    pendingOf?(id: string): Array<{ id: string; title: string; detail: string; kind: string }>;
    decide?(id: string, approval: string, decision: 'once' | 'session' | 'reject'): void;
}

export interface MissionDeps {
    repoRoot: string;
    gitDir: string;
    agent: MissionAgent;
    /** Run tests (in a folder relative to the repository, or the repository) and wait for the end. */
    runTests: (req: RunRequest, workdir?: string) => Promise<{ id: string; state: string; summary?: RunSummary; message?: string }>;
    runInfo: (id: string) => RunInfo | undefined;
    userName?: string;
    notify?: (m: MissionRun) => void;
    log: (action: string, text: string, data?: Record<string, string>) => void;
    /** Folders the framework writes test output into (besides the usual ones). */
    outputDirs?: () => string[];
    /** For tests: a smaller watchdog interval. */
    tickMs?: number;
    /** The Studio browser (an exploration's screenshots). */
    browser?: Pick<StudioBrowser, 'screenshot' | 'pageNow'>;
    /** A browser of its own for a team member that explores (closed when its task ends). */
    newBrowser?: () => StudioBrowser;
}

const now = () => new Date().toISOString();
/** Folders the framework writes into while tests run: never part of a mission's work. */
export const FRAMEWORK_OUTPUTS = ['.flaky-test-data', 'reports', 'test-results'];
const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export class MissionEngine {
    private runs: MissionRun[] = [];
    private live = new Map<string, { template: MissionTemplate; waiters: Map<string, (answer: string) => void>; nudges: number; lastTick: number; timer?: NodeJS.Timeout; idleBusy: boolean; spent?: boolean; members?: Map<string, { task: TeamTask; last: string; done: (answer: string) => void }>; running?: number; queue?: Array<() => void>; closed?: boolean }>();
    private file: string;
    private listeners = new Set<(m: MissionRun) => void>();

    constructor(private readonly d: MissionDeps) {
        this.file = path.join(d.gitDir, 'cs-studio', 'missions.json');
        try { this.runs = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.runs = []; }
        // Missions of an earlier Studio run that had not finished: their agent is gone.
        for (const m of this.runs) if (!FINISHED.includes(m.state)) { m.reason = m.state === 'queued' ? 'The Studio was closed before the mission started.' : 'The Studio was closed while the mission was working.'; m.state = 'stopped'; m.endedAt ??= now(); }
        this.save();
    }

    onChange(fn: (m: MissionRun) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    list(): MissionRun[] { return [...this.runs].reverse(); }
    get(id: string): MissionRun | undefined { return this.runs.find((m) => m.id === id); }
    running(): MissionRun[] { return this.runs.filter((m) => !FINISHED.includes(m.state)); }
    template(key: string) { return templates(this.d.repoRoot).find((t) => t.key === key); }

    private save() {
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            const keep = this.runs.slice(-100);
            fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(keep));
            fs.renameSync(`${this.file}.tmp`, this.file);
            this.runs = keep;
        } catch { /* kept in memory */ }
    }
    private changed(m: MissionRun) { this.save(); for (const l of this.listeners) { try { l(m); } catch { /* listener */ } } }
    private note(m: MissionRun, text: string, kind: MissionRun['timeline'][number]['kind'] = 'note') {
        m.timeline.push({ at: now(), text: short(text, 2000), kind });
        if (m.timeline.length > 400) m.timeline.splice(0, m.timeline.length - 400);
        this.changed(m);
    }
    private copyDir(m: MissionRun) { return m.copy ? path.resolve(this.d.repoRoot, m.copy.rel) : this.d.repoRoot; }

    /** Start a mission (validated inputs; one at a time per repository). */
    async start(key: string, inputs: Record<string, string>, o: { trigger?: MissionRun['trigger']; autonomy?: Autonomy; budget?: Partial<Budget>; queue?: boolean; unattended?: boolean } = {}): Promise<MissionRun> {
        const t = this.template(key);
        if (!t) throw new Error(`No mission "${key}".`);
        // A budget given for this mission (the Start dialog): whole numbers in range, refused as sent, never rounded or clamped.
        for (const [k, label, min, max] of BUDGET_LIMITS) {
            const x = o.budget?.[k];
            if (x !== undefined && x !== null) { const p = wholeProblem(x, label, min, max); if (p) throw new Error(p); }
        }
        const busy = this.running().filter((x) => x.state !== 'queued');
        if (busy.length && !o.queue) throw new Error(`A mission is already working (${busy[0].title}): wait for it, stop it, or queue this one.`);
        if (this.runs.filter((x) => x.state === 'queued').length >= 10) throw new Error('Ten missions are already queued.');
        const clean: Record<string, string> = {};
        for (const i of t.inputs) {
            const v = String(inputs[i.key] ?? '').trim();
            if (i.required && !v) throw new Error(`${i.label} is needed.`);
            if (v && i.kind === 'number' && !/^\d{1,9}$/.test(v)) throw new Error(`${i.label}: a whole number (not "${v.slice(0, 40)}").`);
            if (v && i.key === 'url' && !/^https?:\/\/[^\s/?#]+[^\s]*$/i.test(v)) throw new Error(`${i.label}: a web address starting with http:// or https:// (not "${v.slice(0, 40)}"), or leave it empty for the environment's BASE_URL.`);
            // Names that end up in addresses and file paths (a repository, a project, an environment).
            if (v && (i.key === 'repository' || i.kind === 'project' || i.kind === 'env') && !/^[\w.\- ]{1,120}$/.test(v)) throw new Error(`${i.label}: letters, digits, spaces, dots, dashes and underscores only (not "${v.slice(0, 40)}").`);
            if (v) clean[i.key] = v.slice(0, 8000);
        }
        let run: RunInfo | undefined;
        if (clean.run) {
            run = this.d.runInfo(clean.run);
            if (!run) throw new Error(`No run ${clean.run}.`);
            if (!run.summary?.scenarios.some((s) => s.status === 'failed')) throw new Error('That run has no failed scenario.');
            clean.project = run.request.project; clean.env = run.request.env;
        } else if (key === 'fix-failing' && (!clean.project || !clean.env)) throw new Error('Choose a failed run, or a project and environment (the tests run first).');
        const b = { ...t.budget, ...(o.budget ?? {}) };
        const budget: Budget = { minutes: Math.min(Math.max(Math.round(b.minutes), 5), 480), modelCalls: Math.min(Math.max(Math.round(b.modelCalls), 10), 2000), attempts: Math.min(Math.max(Math.round(b.attempts), 1), 10) };
        const m: MissionRun = {
            id: `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`, key, title: `${t.title}${clean.scenario ? `: ${clean.scenario}` : clean.story ? `: ${short(clean.story.split('\n')[0], 60)}` : clean.run ? `: run ${clean.run}` : clean.pr ? `: !${clean.pr}` : ''}`,
            inputs: clean, state: busy.length ? 'queued' : 'preparing', ...(o.unattended ? { unattended: true } : {}), trigger: o.trigger ?? { kind: 'manual', by: this.d.userName ?? 'you' }, autonomy: o.autonomy ?? 'autonomous',
            createdAt: now(), budget, used: { activeMs: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0, cost: 0, attempts: 0 },
            changes: [], timeline: [], checkpoints: [], verifications: [], memory: [],
        };
        this.runs.push(m);
        if (m.state === 'queued') {
            this.queue.set(m.id, { template: t, run });
            this.note(m, `Queued behind ${busy[0].title}.`, 'phase');
            return m;
        }
        this.begin(m, t, run);
        return m;
    }

    private queue = new Map<string, { template: MissionTemplate; run?: RunInfo }>();
    /** The next queued mission starts when one ends. */
    private next() {
        if (this.running().some((x) => x.state !== 'queued')) return;
        const m = this.runs.find((x) => x.state === 'queued');
        const q = m && this.queue.get(m.id);
        if (!m || !q) return;
        this.queue.delete(m.id);
        m.state = 'preparing';
        this.begin(m, q.template, q.run);
    }

    private begin(m: MissionRun, t: MissionTemplate, run?: RunInfo) {
        const budget = m.budget;
        this.live.set(m.id, { template: t, waiters: new Map(), nudges: 0, lastTick: Date.now(), idleBusy: false });
        this.note(m, `Started by ${m.trigger.kind === 'manual' ? m.trigger.by : `a ${m.trigger.kind === 'run-failed' ? 'failed run' : m.trigger.kind === 'pipeline' ? 'pipeline (unattended)' : m.trigger.kind === 'work-item' ? 'work item' : m.trigger.kind === 'pull-request' ? 'pull request' : 'schedule'}${m.trigger.ref ? ` (${m.trigger.ref})` : ''}`}. Budget: ${budget.minutes} min, ${budget.modelCalls} model calls, ${budget.attempts} verification attempt(s).`, 'phase');
        this.d.log('mission.start', `Started the mission ${m.title}`, { mission: m.id });
        void this.prepare(m, run).catch((e) => this.finish(m, 'failed', `Could not start: ${(e as Error).message}`));
    }

    private async prepare(m: MissionRun, run?: RunInfo) {
        const live = this.live.get(m.id)!;
        const t = live.template;
        if (t.writes) {
            const base = (await runGit(['rev-parse', 'HEAD'], { cwd: this.d.repoRoot })).stdout.trim();
            const dirty = (await runGit(['status', '--porcelain', '--untracked-files=no'], { cwd: this.d.repoRoot })).stdout.trim().length > 0;
            const dir = missionDir(this.d.repoRoot, this.d.gitDir, m.id);
            const branch = `cs-studio/mission-${m.id}`;
            fs.mkdirSync(path.dirname(dir), { recursive: true });
            await runGit(['worktree', 'prune'], { cwd: this.d.repoRoot, allowFailure: true });
            const r = await runGit(['worktree', 'add', '-b', branch, dir, base], { cwd: this.d.repoRoot, allowFailure: true });
            if (r.code !== 0) throw new Error(`the mission's copy could not be made: ${r.stderr.trim().split('\n').pop()}`);
            const prep = await prepareCopy(this.d.repoRoot, dir);
            m.copy = { rel: path.relative(this.d.repoRoot, dir).split(path.sep).join('/'), branch, base, ...(dirty ? { dirtyAtStart: true } : {}) };
            this.note(m, `Working in its own copy on branch ${branch} (from ${base.slice(0, 8)}).${dirty ? ' Your working copy has changes not committed: the mission does not see them.' : ''}${prep.notes.length ? ` ${prep.notes.join(' ')}` : ''}`, 'phase');
        }
        // No run given: the tests run first in the mission's copy, and their failures are the goal.
        let ranFirst: RunSummary | undefined;
        if (t.key === 'fix-failing' && !run) {
            const req: RunRequest = { project: m.inputs.project, env: m.inputs.env, headless: true, ...(m.inputs.tags ? { tags: m.inputs.tags } : {}) };
            this.note(m, `Running the tests first (${describe(req)})…`, 'phase');
            const r = await this.d.runTests(req, m.copy?.rel);
            run = r.id ? this.d.runInfo(r.id) : undefined;
            if (!run && r.summary) run = { id: r.id, state: r.state, request: req, startedAt: now(), summary: r.summary } as unknown as RunInfo;
            const failed = (run?.summary?.scenarios ?? []).filter((s) => s.status === 'failed').length;
            if (!run?.summary) return this.finish(m, 'failed', `The tests could not run: ${r.message ?? r.state}`);
            if (!failed) { m.report = { outcome: 'done', summary: `All ${run.summary.total} scenario(s) passed: nothing to fix.` }; return this.finish(m, 'succeeded', 'Nothing failed.'); }
            m.inputs.run = run.id;
            ranFirst = run.summary;
            this.note(m, `${failed} scenario(s) failed (run ${run.id}).`, 'verify');
        }
        const ctx: MissionContext = { inputs: m.inputs, run, changedFiles: [], ...(ranFirst ? { reproduced: ranFirst } : {}) };
        if (t.reproduce && run?.summary && !ranFirst) {
            const failed = run.summary.scenarios.filter((s) => s.status === 'failed').map((s) => s.name);
            this.note(m, `Reproducing ${failed.length} failure(s) first…`, 'phase');
            const r = await this.d.runTests({ project: run.request.project, env: run.request.env, scenarios: failed, headless: true }, m.copy?.rel);
            ctx.reproduced = r.summary;
            const still = (r.summary?.scenarios ?? []).filter((s) => s.status === 'failed').length;
            this.note(m, r.summary ? `Reproduced: ${still} of ${failed.length} still fail (run ${r.id}).` : `The reproduction run ended without results (${r.message ?? r.state}).`, 'verify');
            if (r.summary && still === 0) {
                m.report = { outcome: 'done', summary: `All ${failed.length} failure(s) passed when run again: they were flaky or caused by the environment at the time. Nothing was changed.`, findings: failed.map((n) => ({ scenario: n, cause: 'flaky', detail: 'Passed when run again in the same code.' })) };
                return this.finish(m, 'succeeded', 'Nothing to fix: the failures did not happen again.');
            }
        }
        (live as { ctx?: MissionContext }).ctx = ctx;
        const team = this.teamOf(t);
        const teamText = team.length ? `\n\nYour team (hand them work with team_delegate; up to ${this.parallelOf(m)} work at once (more wait their turn), each in its own session with its own tools, in the same working folder; you lead: split the goal, give each a precise task with everything it needs, check and combine their answers, and you report):\n${team.map((a) => `- ${a.id}: ${a.name}${a.description ? ` — ${a.description}` : ''} (tools: ${a.tools.join(', ')})`).join('\n')}` : '';
        const workflow = `${t.title}. ${PROTOCOL}${teamText}${m.copy ? `\nYour working folder is your own copy of the repository: ${this.copyDir(m)} (branch ${m.copy.branch}). Change files only there.` : '\nThis mission only reads: change nothing in the repository.'}`;
        const s = await this.d.agent.start({
            title: `Mission: ${m.title}`, workflow,
            mission: { workdir: this.copyDir(m), isolated: !!m.copy, autoFiles: m.autonomy === 'autonomous', ...(m.unattended ? { unattended: true } : {}), ...(t.profile ? { profile: t.profile, ...(t.profile.knowledge ? { knowledgeSources: t.profile.knowledge } : {}) } : {}), tools: this.tools(m), listener: (e) => this.onEvent(m, e), onCall: () => this.onCall(m) },
        });
        m.session = s.id;
        m.state = 'working';
        this.note(m, 'The agent is working on the goal.', 'phase');
        live.lastTick = Date.now();
        live.timer = setInterval(() => this.watch(m), this.d.tickMs ?? 5000);
        live.timer.unref?.();
        await this.d.agent.send(s.id, t.goal(ctx));
    }

    /** The team members a template may use (unknown ids are left out). */
    private teamOf(t: MissionTemplate) {
        return (t.team ?? []).map((id) => teamMember(this.d.repoRoot, id)).filter((a): a is NonNullable<typeof a> => !!a);
    }

    /** Hand a task to a team member and wait for its answer. */
    private async delegate(m: MissionRun, memberId: string, task: string): Promise<string> {
        const live = this.live.get(m.id);
        if (!live || FINISHED.includes(m.state)) return 'The mission has ended.';
        const allowed = this.teamOf(live.template);
        const a = allowed.find((x) => x.id === memberId);
        if (!a) return `No team member "${memberId}". The team: ${allowed.map((x) => x.id).join(', ') || 'none'}.`;
        const text = String(task ?? '').trim();
        if (text.length < 10) return 'Give the member a precise task (what to do, with what, and what to answer with).';
        m.team ??= [];
        if (live.closed) return 'The mission has ended.';
        if (m.team.length + (live.queue?.length ?? 0) >= TEAM_TASKS) return `The mission has handed out ${TEAM_TASKS} tasks (the most it may): finish the work yourself.`;
        // At most parallelOf(m) members work at once (an exploration's "Explorers at once"): the others wait their turn.
        const limit = this.parallelOf(m);
        if ((live.running ?? 0) >= limit) {
            this.note(m, `Queued for ${a.name} (${limit} at once): ${short(text, 200)}`, 'team');
            while ((live.running ?? 0) >= limit) {
                await new Promise<void>((r) => (live.queue ??= []).push(r));
                if (FINISHED.includes(m.state) || live.closed) return 'The mission has ended.';
            }
        }
        live.running = (live.running ?? 0) + 1;
        try { return await this.delegateNow(m, live, a, text); }
        finally { live.running = Math.max(0, (live.running ?? 1) - 1); live.queue?.shift()?.(); }
    }

    /** How many team members may work at once: an exploration's "Explorers at once" (1 to 3), else TEAM_PARALLEL. */
    parallelOf(m: Pick<MissionRun, 'id' | 'key' | 'inputs'>): number {
        const tpl = this.live.get(m.id)?.template;
        if (!(tpl ? tpl.explore : m.key === 'explore-app')) return TEAM_PARALLEL;
        return Math.min(Math.max(parseInt(m.inputs?.explorers || '1', 10) || 1, 1), TEAM_PARALLEL);
    }

    private async delegateNow(m: MissionRun, live: NonNullable<ReturnType<MissionEngine['liveOf']>>, a: TeamAgent, text: string): Promise<string> {
        m.team ??= [];
        this.sample(m);
        if (this.overLimit(m) || m.used.modelCalls >= m.budget.modelCalls) return `Not handed out: the mission's budget is used up (${m.used.modelCalls} of ${m.budget.modelCalls} model calls). Finish with what you have and report.`;
        const base = profileOf(a);
        // A member never does more than the mission may: in a mission that only reads, it only reads too.
        const profile: AgentProfile = { ...base, tools: m.copy ? base.tools : base.tools.filter((g) => READ_ONLY_GROUPS.includes(g)) };
        const tt: TeamTask = { id: randomBytes(4).toString('hex'), member: a.id, name: a.name, task: text.slice(0, 8000), state: 'working', startedAt: now() };
        m.team.push(tt);
        this.note(m, `Handed to ${a.name}: ${short(text, 300)}`, 'team');
        const workflow = `${a.name}, a member of the team working on the mission "${m.title}". The lead gives you a task: do it fully, then answer with your result as your final message (what you found or did, the files you created or changed, the evidence). You cannot ask the person: when something is missing, say so in your answer.${m.copy ? `\nYour working folder is the mission's copy of the repository: ${this.copyDir(m)} (branch ${m.copy.branch}). Change files only there; other members work in it too, so change only what your task needs.` : '\nThis mission only reads: change nothing.'}`;
        // A member that uses the browser gets its own: members explore at the same time without disturbing each other.
        const browser = profile.tools.includes('browser') && this.d.newBrowser ? this.d.newBrowser() : undefined;
        const answer = await new Promise<string>((resolve) => {
            const entry = { task: tt, last: '', done: resolve };
            void (async () => {
                try {
                    const s = await this.d.agent.start({
                        title: `${m.title}: ${a.name}`, workflow,
                        mission: { workdir: this.copyDir(m), isolated: !!m.copy, autoFiles: m.autonomy === 'autonomous', ...(m.unattended ? { unattended: true } : {}), profile, ...(profile.knowledge ? { knowledgeSources: profile.knowledge } : {}), ...(browser ? { browser } : {}), tools: this.tools(m, { browser, who: a.name }).filter((x) => ['tests_run', 'explore_note'].includes(x.name)), listener: (e) => this.onMemberEvent(m, entry, e), onCall: () => this.onCall(m) },
                    });
                    tt.session = s.id;
                    (live.members ??= new Map()).set(s.id, entry);
                    this.changed(m);
                    await this.d.agent.send(s.id, text);
                } catch (e) { tt.state = 'failed'; resolve(`${a.name} could not start: ${(e as Error).message}`); }
            })();
        });
        if (tt.session) live.members?.delete(tt.session);
        if (browser) await browser.close().catch(() => undefined);
        if (tt.state === 'working') tt.state = 'done';
        tt.endedAt = now();
        tt.answer = short(answer, 20000);
        this.sample(m);
        this.note(m, `${a.name} ${tt.state === 'done' ? 'answered' : tt.state}: ${short(answer.replace(/\s+/g, ' '), 300)}`, 'team');
        const overNow = this.overLimit(m);
        if (overNow && !FINISHED.includes(m.state)) { void this.overBudget(m, overNow); return 'The mission is over its budget and stops now.'; }
        return `${a.name} (${tt.state}):\n${answer.slice(0, 30000)}`;
    }

    private onMemberEvent(m: MissionRun, entry: { task: TeamTask; last: string; done: (answer: string) => void }, e: AgentEvent) {
        if (e.type === 'assistant' && e.text.trim()) entry.last = e.text;
        else if (e.type === 'tool-start' && !FINISHED.includes(m.state)) {
            const last = m.timeline[m.timeline.length - 1];
            const text = `${entry.task.name}: ${e.tool} ${short(e.args.replace(/\s+/g, ' '), 120)}`;
            if (!(last?.kind === 'tool' && last.text.startsWith(`${entry.task.name}: ${e.tool}`))) { m.timeline.push({ at: now(), text, kind: 'tool' }); }
        } else if (e.type === 'error' || (e.type === 'info' && (e.text.startsWith('Possible prompt injection') || e.text.startsWith('Refused (') || e.text.startsWith('Tool server ')))) this.note(m, `${entry.task.name}: ${e.text}`, e.type === 'info' && e.text.startsWith('Refused (') ? 'ask' : 'error');
        else if (e.type === 'idle') entry.done(entry.last.trim() || `${entry.task.name} stopped without an answer.`);
    }

    private shotsDir(id: string) { return path.join(this.d.gitDir, 'cs-studio', 'mission-shots', id); }
    /** A screenshot an exploration kept (its file name only). */
    shot(id: string, file: string): string | null {
        if (!/^[a-z0-9-]+\.png$/.test(file) || !this.get(id)) return null;
        const f = path.join(this.shotsDir(id), file);
        return fs.existsSync(f) ? f : null;
    }
    private async exploreNote(m: MissionRun, a: { kind: ExploreKind; title: string; detail?: string; screen?: string; severity?: 'high' | 'medium' | 'low'; steps?: string[]; screenshot?: boolean }, browser?: Pick<StudioBrowser, 'screenshot' | 'pageNow'>, who?: string): Promise<string> {
        const kinds: ExploreKind[] = ['covered', 'bug', 'risk', 'question', 'idea'];
        if (!kinds.includes(a.kind)) return `kind: ${kinds.join(', ')}.`;
        const title = String(a.title ?? '').trim().slice(0, 300);
        if (!title) return 'Give the note a title.';
        m.exploration ??= { notes: [] };
        if (m.exploration.notes.length >= 300) return 'The exploration log is full (300 notes): report now.';
        const n: ExploreNote = { id: randomBytes(4).toString('hex'), kind: a.kind, title, at: now(), ...(a.detail ? { detail: String(a.detail).slice(0, 6000) } : {}), ...(a.screen ? { screen: String(a.screen).slice(0, 500) } : {}), ...(a.kind === 'bug' ? { severity: ['high', 'medium', 'low'].includes(a.severity ?? '') ? a.severity : 'medium' } : {}), ...(Array.isArray(a.steps) && a.steps.length ? { steps: a.steps.slice(0, 30).map((x) => String(x).slice(0, 500)) } : {}), ...(who ? { by: who } : {}) };
        let extra = '';
        if (a.screenshot) {
            if (!browser?.pageNow()) extra = ' No screenshot: the browser is not open.';
            else {
                try {
                    const png = await browser.screenshot();
                    fs.mkdirSync(this.shotsDir(m.id), { recursive: true });
                    n.shot = `${n.id}.png`;
                    fs.writeFileSync(path.join(this.shotsDir(m.id), n.shot), png);
                } catch (e) { extra = ` No screenshot: ${(e as Error).message}`; }
            }
        }
        m.exploration.notes.push(n);
        this.note(m, `${who ? `${who}: ` : ''}${a.kind === 'bug' ? `Bug (${n.severity})` : a.kind === 'covered' ? 'Covered' : a.kind[0].toUpperCase() + a.kind.slice(1)}: ${short(title, 200)}`, a.kind === 'bug' ? 'error' : 'note');
        return `Logged (${m.exploration.notes.length} notes).${extra}`;
    }

    /** The mission's sessions: the lead's and its working members'. */
    private sessions(m: MissionRun): string[] {
        return [...(m.session ? [m.session] : []), ...(m.team ?? []).filter((x) => x.session && x.state === 'working').map((x) => x.session!)];
    }
    /** Stop every member still working (the mission ends). */
    private async stopMembers(m: MissionRun) {
        const live = this.live.get(m.id);
        // From now on no task starts (one waiting its turn is told the mission ended).
        if (live) live.closed = true;
        for (const [sid, entry] of live?.members ?? []) {
            entry.task.state = 'stopped';
            await this.d.agent.abort(sid).catch(() => undefined);
            entry.done('The mission has ended.');
        }
        live?.members?.clear();
        // Tasks still waiting their turn: told the mission ended (none starts any more).
        for (const r of live?.queue?.splice(0) ?? []) r();
    }

    private liveOf(id: string) { return this.live.get(id); }

    /** The mission's own tools. */
    private tools(m: MissionRun, o: { browser?: Pick<StudioBrowser, 'screenshot' | 'pageNow'>; who?: string } = {}): ToolDef[] {
        const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties: props, required });
        const tpl = this.live.get(m.id)?.template;
        const team = this.teamOf(tpl ?? ({} as MissionTemplate));
        const browser = o.browser ?? this.d.browser;
        return [
            ...(tpl?.explore ? [{
                name: 'explore_note', skipPermission: true,
                description: 'Log what you find while exploring, as you go: covered (a screen or flow you went through, and what you tried there), bug (with severity and the steps to reproduce), risk, question (for the team), idea (a test worth automating). screenshot: true keeps a picture of the browser as it is now as evidence.',
                parameters: obj({ kind: { type: 'string', enum: ['covered', 'bug', 'risk', 'question', 'idea'] }, title: { type: 'string' }, detail: { type: 'string' }, screen: { type: 'string', description: 'The page address or name' }, severity: { type: 'string', enum: ['high', 'medium', 'low'] }, steps: { type: 'array', items: { type: 'string' } }, screenshot: { type: 'boolean' } }, ['kind', 'title']),
                handler: async (a: { kind: ExploreKind; title: string; detail?: string; screen?: string; severity?: 'high' | 'medium' | 'low'; steps?: string[]; screenshot?: boolean }) => this.exploreNote(m, a, browser, o.who),
            } as ToolDef] : []),
            ...(team.length ? [{
                name: 'team_delegate', skipPermission: true,
                description: `Hand a task to a member of your team and wait for its answer (call it several times at once to work in parallel, up to ${TEAM_PARALLEL}). Members: ${team.map((a) => `${a.id} (${a.name})`).join(', ')}. Give a precise, self-contained task: they see only what you write.`,
                parameters: obj({ member: { type: 'string', enum: team.map((a) => a.id) }, task: { type: 'string' } }, ['member', 'task']),
                handler: async (a: { member: string; task: string }) => this.delegate(m, String(a.member ?? ''), String(a.task ?? '')),
            } as ToolDef] : []),
            {
                name: 'mission_report', skipPermission: true,
                description: 'Report the mission\'s result (once, when done or blocked). The Studio then verifies it itself by running the proof in your copy; if that fails you get the failures and continue.',
                parameters: obj({
                    outcome: { type: 'string', enum: ['done', 'partial', 'blocked'] }, summary: { type: 'string' },
                    findings: { type: 'array', items: obj({ scenario: { type: 'string' }, cause: { type: 'string', enum: ['test', 'product', 'environment', 'flaky', 'data', 'unknown'] }, detail: { type: 'string' }, fixed: { type: 'boolean' } }, ['detail']) },
                    verify: obj({ features: { type: 'array', items: { type: 'string' } }, scenarios: { type: 'array', items: { type: 'string' } }, tags: { type: 'string' } }),
                    bugs: { type: 'array', items: obj({ title: { type: 'string' }, detail: { type: 'string' } }, ['title', 'detail']) },
                }, ['outcome', 'summary']),
                handler: async (a: MissionReport) => {
                    if (!['done', 'partial', 'blocked'].includes(a.outcome)) return 'outcome: done, partial or blocked.';
                    if (tpl?.explore && a.outcome !== 'blocked' && !(m.exploration?.notes ?? []).some((n) => n.kind === 'covered')) return 'Not reported: log the screens and flows you covered with explore_note (kind covered) first, and each finding as you go.';
                    m.report = { outcome: a.outcome, summary: String(a.summary ?? '').slice(0, 20000), ...(Array.isArray(a.findings) ? { findings: a.findings.slice(0, 200) } : {}), ...(a.verify ? { verify: a.verify } : {}), ...(Array.isArray(a.bugs) ? { bugs: a.bugs.slice(0, 50) } : {}) };
                    this.note(m, `Reported ${a.outcome}: ${short(m.report.summary, 300)}`, 'phase');
                    return a.outcome === 'blocked' ? 'Reported as blocked. Stop now.' : 'Reported. The Studio verifies it now in your copy: stop and wait; if it fails you will get the failures.';
                },
            },
            {
                name: 'mission_ask', skipPermission: true,
                description: 'Ask the person and wait for the answer: a question only they can answer, or a plan to approve (kind "plan", the feature text as content). The mission waits; waiting does not use the budget.',
                parameters: obj({ kind: { type: 'string', enum: ['question', 'plan'] }, question: { type: 'string' }, content: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }, ['question']),
                handler: async (a: { kind?: 'question' | 'plan'; question: string; content?: string; options?: string[] }) => {
                    const cp: Checkpoint = { id: randomBytes(4).toString('hex'), kind: a.kind === 'plan' ? 'plan' : 'question', question: String(a.question).slice(0, 4000), ...(a.content ? { content: String(a.content).slice(0, 40000) } : {}), ...(a.options?.length ? { options: a.options.slice(0, 6).map(String) } : {}), at: now() };
                    m.checkpoints.push(cp);
                    if (m.unattended) {
                        cp.answer = cp.kind === 'plan' ? 'Approved (no one is watching this run: go on with your plan).' : 'No one is available to answer (an unattended run). Decide yourself, and say what you assumed in your report.';
                        cp.answeredAt = now(); cp.by = 'unattended';
                        this.note(m, `Asked "${short(cp.question, 200)}": unattended, it decides itself.`, 'ask');
                        return cp.answer;
                    }
                    m.state = 'waiting';
                    this.note(m, `Waiting for you: ${short(cp.question, 300)}`, 'ask');
                    this.d.notify?.(m);
                    const answer = await new Promise<string>((resolve) => this.live.get(m.id)?.waiters.set(cp.id, resolve));
                    return answer;
                },
            },
            {
                name: 'memory_propose', skipPermission: true,
                description: 'Propose a note for the team\'s agent memory (.cs-studio/agent-memory.md): something agents should know next time (an application quirk, a sign-in detail, a convention). A person accepts it.',
                parameters: obj({ note: { type: 'string' } }, ['note']),
                handler: async ({ note }: { note: string }) => {
                    const n = String(note ?? '').trim().slice(0, 1000);
                    if (!n) return 'Empty note.';
                    m.memory.push({ id: randomBytes(4).toString('hex'), note: n, state: 'proposed' });
                    this.changed(m);
                    return 'Proposed: a person will accept it into the team notes.';
                },
            },
            {
                name: 'tests_run', skipPermission: true,
                description: m.copy ? 'Run tests with the framework in YOUR COPY of the repository and wait for the result: features (repository-relative paths), tags, scenario names; project and environment. Returns counts and each failure.' : 'Run tests with the framework and wait for the result.',
                parameters: obj({ project: { type: 'string' }, env: { type: 'string' }, features: { type: 'array', items: { type: 'string' } }, tags: { type: 'string' }, scenarios: { type: 'array', items: { type: 'string' } }, scenario: { type: 'string' } }, ['project', 'env']),
                handler: async (a: { project: string; env: string; features?: string[]; tags?: string; scenarios?: string[]; scenario?: string }) => {
                    const req: RunRequest = { project: a.project, env: a.env, headless: true, ...(a.features?.length ? { features: a.features } : {}), ...(a.tags ? { tags: a.tags } : {}), ...(a.scenarios?.length ? { scenarios: a.scenarios } : {}), ...(a.scenario ? { scenario: a.scenario } : {}) };
                    this.note(m, `Agent runs tests: ${describe(req)}`, 'tool');
                    const r = await this.d.runTests(req, m.copy?.rel);
                    const s = r.summary;
                    return { run: r.id, state: r.state, ...(r.message ? { message: r.message } : {}), passed: s?.passed, failed: s?.failed, skipped: s?.skipped, failures: (s?.scenarios ?? []).filter((x) => x.status === 'failed').map((x) => ({ scenario: x.name, feature: x.feature, error: x.error?.slice(0, 3000) })) };
                },
            },
        ];
    }

    private onEvent(m: MissionRun, e: AgentEvent) {
        if (FINISHED.includes(m.state)) return;
        if (e.type === 'tool-start' && !e.tool.startsWith('mission_') && e.tool !== 'tests_run' && e.tool !== 'memory_propose') {
            // A few tool names, not every call: the timeline stays readable.
            const last = m.timeline[m.timeline.length - 1];
            if (!(last?.kind === 'tool' && last.text.startsWith(e.tool))) { m.timeline.push({ at: now(), text: `${e.tool} ${short(e.args.replace(/\s+/g, ' '), 140)}`, kind: 'tool' }); }
        } else if (e.type === 'error') this.note(m, `Agent error: ${e.text}`, 'error');
        else if (e.type === 'info' && e.text.startsWith('Refused (')) this.note(m, e.text, 'ask');
        else if (e.type === 'info' && (e.text.startsWith('Possible prompt injection') || e.text.startsWith('Tool server '))) this.note(m, e.text, 'error');
        else if (e.type === 'idle') void this.onIdle(m).catch((err) => this.finish(m, 'failed', `Verification failed to run: ${(err as Error).message}`));
    }

    /** Budget: active time (waiting for the person does not count) and model calls. */
    private watch(m: MissionRun) {
        const live = this.live.get(m.id);
        if (!live || FINISHED.includes(m.state)) return;
        this.sample(m);
        if (m.state === 'verifying') return;
        // An approval the agent waits for: the mission waits for the person (and says so once).
        // Approvals of the lead and of every working member (each says whose it is).
        const who = (sid: string) => (sid === m.session ? undefined : m.team?.find((x) => x.session === sid)?.name);
        const pend = this.sessions(m).flatMap((sid) => (this.d.agent.pendingOf?.(sid) ?? []).map((a) => ({ ...a, session: sid, ...(who(sid) ? { who: who(sid) } : {}), title: who(sid) ? `${who(sid)}: ${a.title}` : a.title })));
        const before = (m.approvals ?? []).map((a) => a.id).join();
        m.approvals = pend;
        const askedQuestion = m.checkpoints.some((c) => c.answer === undefined);
        if (pend.length && m.unattended && this.d.agent.decide) {
            // No one to approve: refused, and the agent is told why.
            for (const a of pend) { this.d.agent.decide(a.session, a.id, 'reject'); this.note(m, `Refused (unattended): ${short(a.title, 200)}`, 'ask'); }
            m.approvals = [];
            return;
        }
        if (pend.length && m.state === 'working') {
            m.state = 'waiting';
            this.note(m, `Waiting for your approval: ${short(pend[0].title, 300)}`, 'ask');
            this.d.notify?.(m);
            return;
        }
        if (!pend.length && m.state === 'waiting' && !askedQuestion) { m.state = 'working'; this.changed(m); }
        else if (pend.map((a) => a.id).join() !== before) this.changed(m);
        const over = this.overLimit(m);
        if (over) void this.overBudget(m, over);
        else this.save();
    }
    /** Time worked (not waiting for the person) and the model's use, up to now. */
    private sample(m: MissionRun) {
        const live = this.live.get(m.id);
        if (!live) return;
        const t = Date.now();
        if (m.state !== 'waiting' && m.state !== 'queued') m.used.activeMs += t - live.lastTick;
        live.lastTick = t;
        const u = m.session ? this.d.agent.usageOf(m.session) : null;
        // The members' model use counts against the mission's budget too.
        for (const tt of m.team ?? []) {
            const mu = tt.session ? this.d.agent.usageOf(tt.session) : null;
            if (mu) tt.used = { modelCalls: mu.usage.calls, inputTokens: mu.usage.inputTokens, outputTokens: mu.usage.outputTokens, cost: mu.usage.cost };
        }
        const sum = (k: 'modelCalls' | 'inputTokens' | 'outputTokens' | 'cost') => (m.team ?? []).reduce((n, tt) => n + (tt.used?.[k] ?? 0), 0);
        if (u || m.team?.length) Object.assign(m.used, { modelCalls: (u?.usage.calls ?? 0) + sum('modelCalls'), inputTokens: (u?.usage.inputTokens ?? 0) + sum('inputTokens'), outputTokens: (u?.usage.outputTokens ?? 0) + sum('outputTokens'), cost: (u?.usage.cost ?? 0) + sum('cost') });
    }

    /** Which budget is used up (the lead's and its members' model calls together), or null. */
    private overLimit(m: MissionRun): string | null {
        if (m.used.activeMs > m.budget.minutes * 60_000) return `${m.budget.minutes} minutes of work used.`;
        if (m.used.modelCalls > m.budget.modelCalls) return `${m.used.modelCalls} model calls used (the budget is ${m.budget.modelCalls}).`;
        return null;
    }
    private async overBudget(m: MissionRun, why: string) {
        await this.stopMembers(m);
        if (m.session) await this.d.agent.abort(m.session).catch(() => undefined);
        // Calls made while stopping count: the reason says what the mission shows.
        this.sample(m);
        await this.finish(m, 'over-budget', `Over budget: ${this.overLimit(m) ?? why}`);
    }
    /**
     * After every model call (the lead's or a member's): when the calls reach the budget, every session stops at once,
     * so no call is made beyond it. A report already made is still verified; otherwise the mission ends over budget.
     */
    private onCall(m: MissionRun) {
        const live = this.live.get(m.id);
        if (!live || live.spent || FINISHED.includes(m.state) || m.state === 'verifying') return;
        this.sample(m);
        if (m.used.modelCalls < m.budget.modelCalls) return;
        live.spent = true;
        void (async () => {
            await this.stopMembers(m);
            if (m.session) await this.d.agent.abort(m.session).catch(() => undefined);
            this.sample(m);
            if (FINISHED.includes(m.state)) return;
            if (m.report && m.report.outcome !== 'blocked' && !this.overLimit(m)) { live.idleBusy = true; try { await this.verify(m); } finally { live.idleBusy = false; } return; }
            if (m.report?.outcome === 'blocked') return this.finish(m, 'blocked', short(m.report.summary, 500));
            await this.finish(m, 'over-budget', `Over budget: ${this.overLimit(m) ?? `all ${m.budget.modelCalls} model calls of the budget are used (${m.used.modelCalls}).`}`);
        })().catch((e) => this.finish(m, 'failed', `Verification failed to run: ${(e as Error).message}`));
    }

    private async onIdle(m: MissionRun) {
        const live = this.live.get(m.id);
        // The budget's calls are used up: onCall ends the mission (no nudge: it would be one more call).
        if (!live || m.state !== 'working' || live.idleBusy || live.spent) return;
        live.idleBusy = true;
        try {
            if (!m.report) {
                if (live.nudges >= 2) return await this.finish(m, 'failed', 'The agent stopped without reporting a result.');
                live.nudges++;
                this.note(m, 'The agent stopped without a report: asked to finish.', 'note');
                await this.d.agent.send(m.session!, 'You stopped without calling mission_report. Continue toward the goal; when it is met (or you are blocked) call mission_report.');
                return;
            }
            if (m.report.outcome === 'blocked') return await this.finish(m, 'blocked', short(m.report.summary, 500));
            // The budget is checked again before the proof runs: calls made since the last check count.
            this.sample(m);
            const over = this.overLimit(m);
            if (over) return await this.overBudget(m, over);
            await this.verify(m);
        } finally { live.idleBusy = false; }
    }

    private async changedFiles(m: MissionRun): Promise<Array<{ path: string; status: string }>> {
        if (!m.copy) return [];
        const dir = this.copyDir(m);
        // What the framework writes while running (reports, its flaky store) is not the mission's work.
        const outputs = ['node_modules', ...FRAMEWORK_OUTPUTS, ...(this.d.outputDirs?.() ?? [])];
        await runGit(['add', '-A', '--', '.', ...[...new Set(outputs)].map((o) => `:(exclude)${o}`)], { cwd: dir, allowFailure: true });
        await runGit(['reset', '-q', '--', ...[...new Set(outputs)]], { cwd: dir, allowFailure: true });
        const r = await runGit(['diff', '--cached', '--name-status', '--no-renames', m.copy.base], { cwd: dir, allowFailure: true });
        return r.stdout.split('\n').filter(Boolean).map((l) => { const [st, ...p] = l.split('\t'); return { status: st, path: p.join('\t') }; }).filter((x) => x.path !== 'node_modules');
    }

    private async verify(m: MissionRun) {
        const live = this.live.get(m.id)!;
        m.state = 'verifying';
        m.used.attempts++;
        m.changes = await this.changedFiles(m);
        const ctx: MissionContext = { ...((live as { ctx?: MissionContext }).ctx ?? { inputs: m.inputs }), changedFiles: m.changes.filter((c) => c.status !== 'D').map((c) => c.path) };
        const plan = live.template.verify(ctx, m.report!);
        this.note(m, `Verifying (attempt ${m.used.attempts} of ${m.budget.attempts}): ${plan.why}`, 'verify');
        const v: Verification = { at: now(), attempt: m.used.attempts, passed: false, why: plan.why, runs: [], failures: [] };
        if (plan.kind === 'report') v.passed = true;
        else if (plan.kind === 'tests') {
            for (let i = 0; i < plan.repeat; i++) {
                const r = await this.d.runTests(plan.request, m.copy?.rel);
                v.runs.push({ id: r.id, state: r.state, passed: r.summary?.passed, failed: r.summary?.failed });
                const fails = (r.summary?.scenarios ?? []).filter((s) => s.status === 'failed');
                if (r.state !== 'passed' || !r.summary || r.summary.total === 0 || fails.length) {
                    v.failures = fails.length ? fails.map((s) => ({ name: s.name, ...(s.error ? { error: s.error.slice(0, 2000) } : {}) })) : [{ name: describe(plan.request), error: r.message ?? (r.summary?.total === 0 ? 'No scenario ran: the proof matched nothing.' : `The run ended ${r.state}.`) }];
                    if (plan.repeat > 1) v.why += ` Failed on run ${i + 1} of ${plan.repeat}.`;
                    break;
                }
                if (i === plan.repeat - 1) v.passed = true;
            }
        } else v.failures = [{ name: 'proof', error: plan.why }];
        m.verifications.push(v);
        this.note(m, v.passed ? `Verified: ${plan.kind === 'tests' ? `${v.runs.length} run(s) passed` : 'report accepted'}.` : `Verification failed: ${v.failures.map((f) => `${f.name}${f.error ? ` — ${short(f.error.replace(/\s+/g, ' '), 200)}` : ''}`).join('; ')}`, 'verify');
        if (v.passed) return this.finish(m, m.report!.outcome === 'partial' ? 'partial' : 'succeeded', m.report!.outcome === 'partial' ? 'Partly done; what was done is verified.' : 'Done and verified.');
        if (m.used.attempts >= m.budget.attempts) return this.finish(m, 'failed', `The work did not pass verification after ${m.used.attempts} attempt(s).`);
        // No model calls left to fix it with.
        if (live.spent) return this.finish(m, 'over-budget', `Over budget: the work did not pass verification, and all ${m.budget.modelCalls} model calls of the budget are used (${m.used.modelCalls}).`);
        // Back to the agent with the failures: it continues where it was.
        m.report = undefined;
        m.state = 'working';
        this.changed(m);
        await this.d.agent.send(m.session!, `The Studio's verification failed (${plan.why}):\n${v.failures.map((f) => `- ${f.name}${f.error ? `: ${f.error.slice(0, 1500)}` : ''}`).join('\n')}\nFix it and call mission_report again (attempt ${m.used.attempts + 1} of ${m.budget.attempts}).`);
    }

    private async finish(m: MissionRun, state: MissionState, reason: string) {
        const live = this.live.get(m.id);
        if (FINISHED.includes(m.state) || (live as { ending?: boolean } | undefined)?.ending) return;
        if (live) (live as { ending?: boolean }).ending = true;
        this.sample(m);
        if (live?.timer) clearInterval(live.timer);
        for (const [, w] of live?.waiters ?? []) w('The mission has ended.');
        await this.stopMembers(m);
        // Calls that ended while stopping count too: the reason and the numbers shown agree.
        this.sample(m);
        if (state === 'over-budget') { const o = this.overLimit(m); if (o) reason = `Over budget: ${o}`; }
        // An exploration's bugs become the report's bugs (to file in Azure DevOps from the mission).
        const bugNotes = (m.exploration?.notes ?? []).filter((n) => n.kind === 'bug');
        if (bugNotes.length) {
            m.report ??= { outcome: 'partial', summary: 'The exploration ended before its report.' };
            m.report.bugs ??= [];
            for (const n of bugNotes) if (!m.report.bugs.some((b) => b.title === n.title)) m.report.bugs.push({ title: n.title, detail: [n.severity ? `Severity: ${n.severity}.` : '', n.screen ? `Where: ${n.screen}.` : '', n.detail ?? '', n.steps?.length ? `Steps:\n${n.steps.map((x, i) => `${i + 1}. ${x}`).join('\n')}` : ''].filter(Boolean).join('\n') });
        }
        // The work is committed first: the mission shows as finished only with its result in place.
        if (m.copy) {
            try {
                m.changes = await this.changedFiles(m);
                if (m.changes.length) {
                    const id = await identity(this.d.repoRoot, this.d.userName);
                    const msg = `${m.title}\n\n${m.report?.summary ? `${m.report.summary.slice(0, 3000)}\n\n` : ''}Mission ${m.id}: ${state}${m.verifications.at(-1)?.passed ? ' (verified)' : ''}.`;
                    const c = await runGit([...id, 'commit', '-q', '--no-verify', '-m', msg], { cwd: this.copyDir(m), allowFailure: true });
                    if (c.code === 0) m.commit = (await runGit(['rev-parse', 'HEAD'], { cwd: this.copyDir(m) })).stdout.trim();
                    else m.timeline.push({ at: now(), text: `Could not commit the work: ${c.stderr.trim().split('\n').pop()}`, kind: 'error' });
                }
            } catch (e) { m.timeline.push({ at: now(), text: `Could not collect the changes: ${(e as Error).message}`, kind: 'error' }); }
        }
        m.state = state; m.reason = reason; m.endedAt = now();
        // The reason may already start with the state's name ("Over budget: …"): said once.
        const said = reason.toLowerCase().startsWith(`${label(state).toLowerCase()}:`) ? reason : `${label(state)}: ${reason}`;
        m.timeline.push({ at: now(), text: `${said}${m.commit ? ` ${m.changes.length} file(s) on ${m.copy!.branch}.` : ''}`, kind: 'phase' });
        this.live.delete(m.id);
        this.changed(m);
        this.d.log('mission.end', `The mission ${m.title} ended: ${label(state)}`, { mission: m.id, state });
        this.d.notify?.(m);
        this.next();
    }

    /** A bug of the report filed in Azure DevOps. */
    bugFiled(id: string, index: number, wi: { id: number; url: string }, by: string) {
        const m = this.get(id);
        const b = m?.report?.bugs?.[index];
        if (!m || !b) return;
        b.filed = { ...wi, by, at: now() };
        this.note(m, `${by} filed bug ${wi.id}: ${short(b.title, 200)}`, 'phase');
    }

    // ------------------------------------------------------------------------------------- the person's actions

    answer(id: string, checkpoint: string, answer: string, by: string) {
        const m = this.get(id);
        const cp = m?.checkpoints.find((c) => c.id === checkpoint);
        const w = this.live.get(id)?.waiters.get(checkpoint);
        if (!m || !cp || !w || cp.answer !== undefined) throw new Error('No such question waiting (it may have been answered).');
        const a = String(answer ?? '').trim().slice(0, 20000);
        if (!a) throw new Error('Write an answer.');
        cp.answer = a; cp.answeredAt = now(); cp.by = by;
        this.live.get(id)!.waiters.delete(checkpoint);
        if (m.state === 'waiting') m.state = 'working';
        this.note(m, `${by} answered: ${short(a, 300)}`, 'ask');
        w(cp.kind === 'plan' && /^(approved?|yes|ok)\b/i.test(a) ? 'Approved. Go on with the plan as it is.' : `The person answered: ${a}`);
    }

    /** Approve or reject what the agent waits for, from the mission. */
    approve(id: string, approval: string, decision: 'once' | 'session' | 'reject', by: string) {
        const m = this.get(id);
        if (!m?.session || !this.d.agent.decide || !(m.approvals ?? []).some((a) => a.id === approval)) throw new Error('No such approval waiting (it may have been answered).');
        const a = m.approvals!.find((x) => x.id === approval)!;
        this.d.agent.decide(a.session ?? m.session, approval, decision);
        m.approvals = m.approvals!.filter((x) => x.id !== approval);
        if (!m.approvals.length && m.state === 'waiting' && !m.checkpoints.some((c) => c.answer === undefined)) m.state = 'working';
        this.note(m, `${by} ${decision === 'reject' ? 'rejected' : decision === 'session' ? 'approved for the rest of the mission' : 'approved'}: ${short(a.title, 200)}`, 'ask');
    }

    async stop(id: string, by: string) {
        const m = this.get(id);
        if (!m || FINISHED.includes(m.state)) throw new Error('The mission is not working.');
        if (m.state === 'queued') {
            this.queue.delete(m.id);
            m.state = 'stopped'; m.reason = `Taken out of the queue by ${by}.`; m.endedAt = now();
            this.note(m, m.reason, 'phase');
            return;
        }
        await this.stopMembers(m);
        if (m.session) await this.d.agent.abort(m.session).catch(() => undefined);
        await this.finish(m, 'stopped', `Stopped by ${by}.`);
    }

    /** The mission's changes as a patch (for review). */
    async diff(id: string): Promise<string> {
        const m = this.get(id);
        if (!m?.copy) return '';
        const head = m.commit ?? 'HEAD';
        if (!m.commit) await runGit(['add', '-A'], { cwd: this.copyDir(m), allowFailure: true });
        const r = await runGit(m.commit ? ['diff', m.copy.base, head] : ['diff', '--cached', m.copy.base], { cwd: this.copyDir(m), allowFailure: true, maxOutputBytes: 5 * 1024 * 1024 });
        return r.stdout;
    }

    /** Bring the mission's commit into the person's working copy (as changes, not committed). Refused when a file it changed has changes there too. */
    async apply(id: string, by: string): Promise<{ files: string[] }> {
        const m = this.get(id);
        if (!m || !FINISHED.includes(m.state) || !m.commit) throw new Error('Only a finished mission with changes can be brought in.');
        if (m.result) throw new Error(`Already ${m.result.kind}.`);
        const mine = (await runGit(['status', '--porcelain'], { cwd: this.d.repoRoot })).stdout.split('\n').filter(Boolean).map((l) => l.slice(3).replace(/^.* -> /, ''));
        const overlap = m.changes.map((c) => c.path).filter((p) => mine.includes(p));
        if (overlap.length) throw new Error(`These files have changes in your working copy too: ${overlap.join(', ')}. Commit or stash them first.`);
        const r = await runGit(['cherry-pick', '--no-commit', m.commit], { cwd: this.d.repoRoot, allowFailure: true });
        if (r.code !== 0) {
            await runGit(['cherry-pick', '--abort'], { cwd: this.d.repoRoot, allowFailure: true });
            await runGit(['reset', '--merge'], { cwd: this.d.repoRoot, allowFailure: true });
            throw new Error(`The changes do not apply to your current branch: ${r.stderr.trim().split('\n').pop()}`);
        }
        // Brought in as changes: nothing is committed for the person.
        await runGit(['reset', '-q'], { cwd: this.d.repoRoot, allowFailure: true });
        m.result = { kind: 'applied', at: now(), detail: by };
        await this.removeCopy(m);
        this.note(m, `${by} brought the changes into the working copy.`, 'phase');
        return { files: m.changes.map((c) => c.path) };
    }

    /** After the branch was published as a pull request. */
    published(id: string, pr: { id: number; url: string }, by: string) {
        const m = this.get(id);
        if (!m) return;
        m.result = { kind: 'pr', at: now(), detail: `${pr.id} ${pr.url}` };
        this.note(m, `${by} opened pull request ${pr.id}.`, 'phase');
    }

    async discard(id: string, by: string) {
        const m = this.get(id);
        if (!m || !FINISHED.includes(m.state)) throw new Error('Stop the mission first.');
        await this.removeCopy(m);
        if (m.copy && m.result?.kind !== 'pr') await runGit(['branch', '-D', m.copy.branch], { cwd: this.d.repoRoot, allowFailure: true });
        if (!m.result) m.result = { kind: 'discarded', at: now(), detail: by };
        this.note(m, `${by} discarded the mission's copy${m.result.kind === 'pr' ? ' (the branch stays: it has a pull request)' : ' and branch'}.`, 'phase');
    }

    /**
     * Delete a finished mission from the list: its copy, its screenshots and (unless a pull request uses it) its branch
     * go too. Work never brought in or published is lost: the screen asks first.
     */
    async remove(id: string, by: string): Promise<void> {
        const m = this.get(id);
        if (!m) throw new Error('No such mission.');
        if (!FINISHED.includes(m.state)) throw new Error('Stop the mission first: only a finished mission can be deleted.');
        await this.removeCopy(m);
        if (m.copy && m.result?.kind !== 'pr') await runGit(['branch', '-D', m.copy.branch], { cwd: this.d.repoRoot, allowFailure: true });
        try { fs.rmSync(this.shotsDir(m.id), { recursive: true, force: true }); } catch { /* gone */ }
        this.runs = this.runs.filter((x) => x.id !== id);
        this.save();
        this.d.log('mission.delete', `${by} deleted the mission ${m.title}`, { mission: m.id });
    }

    private async removeCopy(m: MissionRun) {
        if (!m.copy) return;
        const dir = this.copyDir(m);
        if (fs.existsSync(dir)) await removeCopy(this.d.repoRoot, dir);
    }

    /** A proposed note accepted into the team's memory (or dismissed). */
    memory(id: string, noteId: string, accept: boolean): string | null {
        const m = this.get(id);
        const n = m?.memory.find((x) => x.id === noteId);
        if (!m || !n || n.state !== 'proposed') throw new Error('No such proposed note.');
        n.state = accept ? 'accepted' : 'dismissed';
        this.changed(m);
        return accept ? n.note : null;
    }
}

export function label(s: MissionState): string {
    return ({ queued: 'Queued', preparing: 'Preparing', working: 'Working', waiting: 'Waiting for you', verifying: 'Verifying', succeeded: 'Done', partial: 'Partly done', failed: 'Failed', blocked: 'Blocked', 'over-budget': 'Over budget', stopped: 'Stopped' } as Record<MissionState, string>)[s];
}

export function describe(r: RunRequest): string {
    return [r.features?.length ? `${r.features.length} feature(s)` : '', r.scenarios?.length ? `${r.scenarios.length} scenario(s)` : '', r.tags ? `tags ${r.tags}` : '', r.scenario ? `"${r.scenario}"` : ''].filter(Boolean).join(', ') || 'all tests';
}

/** The mission copies' folder: inside .git when it is in the repository (like the pull request copies). */
export function missionDir(repoRoot: string, gitDir: string, id: string): string {
    if (!/^[a-z0-9]{4,30}$/.test(id)) throw new Error('Invalid mission id.');
    const rel = path.relative(repoRoot, gitDir);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return path.join(gitDir, 'cs-studio', 'missions', id);
    const base = path.join(repoRoot, '.cs-studio', 'missions');
    try {
        const exclude = path.join(gitDir, 'info', 'exclude');
        const cur = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
        if (!/^\/\.cs-studio\/missions\/\r?$/m.test(cur)) { fs.mkdirSync(path.dirname(exclude), { recursive: true }); fs.appendFileSync(exclude, `${cur && !cur.endsWith('\n') ? '\n' : ''}/.cs-studio/missions/\n`); }
    } catch { /* best effort */ }
    return path.join(base, id);
}

/** Commit identity: the repository's, else the Studio user's name. */
async function identity(repoRoot: string, userName?: string): Promise<string[]> {
    const n = (await runGit(['config', 'user.name'], { cwd: repoRoot, allowFailure: true })).stdout.trim();
    const e = (await runGit(['config', 'user.email'], { cwd: repoRoot, allowFailure: true })).stdout.trim();
    if (n && e) return [];
    return ['-c', `user.name=${n || userName || 'CS Test Studio user'}`, '-c', `user.email=${e || 'studio@localhost'}`];
}

// ---------------------------------------------------------------------------------------------- triggers

/** Starts missions on the team's triggers (.cs-studio/missions.json): a failed run, a schedule. */
export class MissionTriggers {
    private count = new Map<string, { day: string; n: number }>();
    private lastMinute = '';
    constructor(private readonly engine: MissionEngine, private readonly repoRoot: string, private readonly log: MissionDeps['log']) {}

    private allowed(t: MissionTrigger): boolean {
        const key = `${t.mission}:${t.on}:${t.cron ?? ''}`;
        const day = new Date().toISOString().slice(0, 10);
        const c = this.count.get(key);
        const n = c?.day === day ? c.n : 0;
        if (n >= (t.maxPerDay ?? 3)) return false;
        this.count.set(key, { day, n: n + 1 });
        return true;
    }

    /** A run ended: a "run-failed" trigger starts its mission (not for runs in a pull request's or a mission's copy). */
    async onRunEnded(run: RunInfo): Promise<MissionRun | null> {
        if (run.state !== 'failed' || run.workdir || run.pr || !run.summary?.failed) return null;
        for (const t of [...(readMissionsFile(this.repoRoot).file.triggers ?? []), ...simpleTriggers(listAgents(this.repoRoot).agents)]) {
            if (t.enabled === false || t.on !== 'run-failed') continue;
            if (t.projects?.length && !t.projects.includes(run.request.project)) continue;
            if (t.envs?.length && !t.envs.includes(run.request.env)) continue;
            if (!this.allowed(t)) continue;
            try { return await this.engine.start(t.mission, { ...(t.inputs ?? {}), run: run.id }, { trigger: { kind: 'run-failed', by: 'trigger', ref: run.id }, autonomy: t.autonomy ?? 'autonomous', queue: true }); }
            catch (e) { this.log('mission.trigger', `A failed run did not start the mission ${t.mission}: ${(e as Error).message}`); }
        }
        return null;
    }

    /** Called every minute: schedules that match now. */
    async tick(d = new Date()): Promise<MissionRun[]> {
        const minute = d.toISOString().slice(0, 16);
        if (minute === this.lastMinute) return [];
        this.lastMinute = minute;
        const out: MissionRun[] = [];
        for (const t of [...(readMissionsFile(this.repoRoot).file.triggers ?? []), ...simpleTriggers(listAgents(this.repoRoot).agents)]) {
            if (t.enabled === false || t.on !== 'schedule' || !t.cron || !cronMatches(t.cron, d)) continue;
            if (!this.allowed(t)) continue;
            try { out.push(await this.engine.start(t.mission, t.inputs ?? {}, { trigger: { kind: 'schedule', by: 'trigger', ref: t.cron }, autonomy: t.autonomy ?? 'autonomous', queue: true })); }
            catch (e) { this.log('mission.trigger', `The schedule "${t.cron}" did not start the mission ${t.mission}: ${(e as Error).message}`); }
        }
        return out;
    }
}

// ---------------------------------------------------------------------------------------------- reports

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** The mission as JUnit (a pipeline shows it as a test result): one test case, failed unless done (or partly done) and verified. */
export function missionJUnit(m: MissionRun): string {
    const ok = m.state === 'succeeded' || m.state === 'partial';
    const secs = ((m.endedAt ? Date.parse(m.endedAt) : Date.now()) - Date.parse(m.createdAt)) / 1000;
    const body = missionMarkdown(m);
    return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="CS Test Studio missions" tests="1" failures="${ok ? 0 : 1}" time="${secs.toFixed(1)}">\n`
        + `  <testsuite name="mission ${xml(m.key)}" tests="1" failures="${ok ? 0 : 1}" time="${secs.toFixed(1)}">\n`
        + `    <testcase classname="missions.${xml(m.key)}" name="${xml(m.title)}" time="${secs.toFixed(1)}">\n`
        + (ok ? '' : `      <failure message="${xml(`${label(m.state)}: ${m.reason ?? ''}`)}">${xml(body)}</failure>\n`)
        + `      <system-out>${xml(body)}</system-out>\n    </testcase>\n  </testsuite>\n</testsuites>\n`;
}

/** The mission's result as Markdown (a pipeline summary, a pull request, a work item). */
export function missionMarkdown(m: MissionRun): string {
    const v = m.verifications.at(-1);
    const out = [`## ${m.title}`, '', `**${label(m.state)}**${m.reason ? ` — ${m.reason}` : ''}${v?.passed ? ' · verified by CS Test Studio' : ''}`, '',
        `Work: ${Math.round(m.used.activeMs / 1000)} s of ${m.budget.minutes} min · ${m.used.modelCalls} of ${m.budget.modelCalls} model calls · ${m.used.attempts} of ${m.budget.attempts} verification attempt(s)${m.copy ? ` · branch \`${m.copy.branch}\`` : ''}`, ''];
    if (m.report) out.push('### Report', '', m.report.summary, '');
    if (m.report?.findings?.length) out.push('### Findings', '', '| Scenario | Cause | Finding | Fixed |', '|---|---|---|---|', ...m.report.findings.map((f) => `| ${(f.scenario ?? '—').replace(/\|/g, '\\|')} | ${f.cause ?? ''} | ${f.detail.replace(/\|/g, '\\|').replace(/\n/g, ' ')} | ${f.fixed ? 'yes' : ''} |`), '');
    if (m.report?.bugs?.length) out.push('### Application bugs found', '', ...m.report.bugs.map((b) => `- **${b.title}**${b.filed ? ` (bug ${b.filed.id})` : ''}: ${b.detail}`), '');
    if (m.verifications.length) out.push('### Verification', '', ...m.verifications.map((x) => `- Attempt ${x.attempt}: ${x.passed ? 'passed' : 'failed'} — ${x.why}${x.runs.length ? ` (${x.runs.map((r) => `run ${r.id}: ${r.passed ?? 0} passed, ${r.failed ?? 0} failed`).join('; ')})` : ''}${x.failures.length ? `\n  ${x.failures.map((f) => `${f.name}${f.error ? `: ${f.error.split('\n')[0].slice(0, 300)}` : ''}`).join('\n  ')}` : ''}`), '');
    if (m.changes.length) out.push('### Changes', '', ...m.changes.map((c) => `- ${c.status === 'A' ? 'new' : c.status === 'D' ? 'deleted' : 'changed'}: \`${c.path}\``), '');
    return out.join('\n');
}

// ---------------------------------------------------------------------------------------------- polled triggers

/** What polling needs from Azure DevOps (the server provides it). */
export interface TriggerPollers {
    workItems: (query: string, project?: string) => Promise<number[]>;
    pullRequests: (o: { target?: string; repository?: string; project?: string }) => Promise<Array<{ repository: string; id: number; updated: string }>>;
}

/**
 * Work-item and pull-request triggers of mission agents: each check asks Azure DevOps what matches, and starts the
 * agent's mission for what is new (or updated) since the last check. The first check only records what is there,
 * so turning a trigger on never starts a mission for every old work item.
 */
export class PolledTriggers {
    private seen: Record<string, Record<string, string>> = {};
    constructor(private readonly engine: MissionEngine, private readonly repoRoot: string, private readonly stateFile: string, private readonly p: TriggerPollers, private readonly log: MissionDeps['log']) {
        try { this.seen = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { this.seen = {}; }
    }
    private save() { try { fs.mkdirSync(path.dirname(this.stateFile), { recursive: true }); fs.writeFileSync(this.stateFile, JSON.stringify(this.seen)); } catch { /* next time */ } }

    async check(): Promise<MissionRun[]> {
        const started: MissionRun[] = [];
        for (const a of listAgents(this.repoRoot).agents) {
            if (a.mode !== 'mission') continue;
            for (const [i, t] of (a.triggers ?? []).entries()) {
                if (t.enabled === false || (t.on !== 'work-item' && t.on !== 'pull-request')) continue;
                const key = `${a.id}#${i}:${t.on}`;
                let found: Array<{ id: string; stamp: string; inputs: Record<string, string> }> = [];
                try {
                    if (t.on === 'work-item') found = (await this.p.workItems(t.query, t.project)).map((id) => ({ id: String(id), stamp: '1', inputs: { ...(t.inputs ?? {}), [t.input ?? 'story']: String(id) } }));
                    else found = (await this.p.pullRequests({ target: t.target, repository: t.repository, project: t.project })).map((r) => ({ id: `${r.repository}/${r.id}`, stamp: r.updated, inputs: { ...(t.inputs ?? {}), repository: r.repository, pr: String(r.id) } }));
                } catch (e) { this.log('mission.trigger', `The ${t.on} trigger of ${a.name} could not check Azure DevOps: ${(e as Error).message}`); continue; }
                const first = !this.seen[key];
                const known = this.seen[key] ?? {};
                const fresh = first ? [] : found.filter((f) => known[f.id] !== f.stamp);
                this.seen[key] = Object.fromEntries(found.map((f) => [f.id, f.stamp]));
                for (const f of fresh.slice(0, t.maxPerDay ?? 3)) {
                    try { started.push(await this.engine.start(a.id, f.inputs, { trigger: { kind: t.on === 'work-item' ? 'work-item' : 'pull-request', by: 'trigger', ref: f.id }, queue: true })); }
                    catch (e) { this.log('mission.trigger', `${a.name} did not start for ${f.id}: ${(e as Error).message}`); }
                }
            }
        }
        this.save();
        return started;
    }
}
