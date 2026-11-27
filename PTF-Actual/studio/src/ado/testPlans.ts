/**
 * Azure DevOps Test Plans: plans, suites, test points (a test case in a suite for a configuration, with its
 * latest outcome), and the scenarios that automate them in this repository.
 *
 * Verified against the Test Plans REST API (7.1) and the framework:
 *  - testplan/plans, testplan/Plans/{plan}/suites (flat list, parentSuite), testplan/Plans/{plan}/Suites/{suite}/
 *    TestPoint (testCaseReference, configuration, tester, results.outcome / lastResultDetails, isAutomated).
 *  - A scenario automates a test case with @TestCaseId:<id> (or {a,b}); the framework publishes results to the
 *    test points of ADO_TEST_PLAN_ID / ADO_TEST_SUITE_ID (or @TestPlanId / @TestSuiteId) when
 *    ADO_INTEGRATION_ENABLED is on (usually in the pipeline).
 *  - A test case's steps (Microsoft.VSTS.TCM.Steps) are XML holding escaped HTML: ActionStep (action only) or
 *    ValidateStep (action and expected result).
 *  - Creating a test case (wit/workitems/$Test Case) and adding it to a static suite
 *    (testplan/Plans/{plan}/Suites/{suite}/TestCase) need "Work Items (Read & write)" and "Test Management (Read & write)".
 */
import { AdoClient } from './client';
import { TestStep } from './workItems';

export interface TestPlan { id: number; name: string; state: string; rootSuite: number; iteration?: string; areaPath?: string; owner?: string; web: string }
export interface TestSuite { id: number; name: string; type: string; parent: number | null; requirementId?: number; query?: string }
export interface TestPoint {
    id: number; testCase: number; title: string; state?: string; configuration: string; tester?: string;
    outcome: string; lastRun?: string; lastRunBy?: string; runId?: number; isAutomated: boolean; active: boolean;
}

const person = (v: unknown) => (v && typeof v === 'object' ? String((v as { displayName?: unknown }).displayName ?? '') || undefined : undefined);
const realDate = (v: unknown) => (typeof v === 'string' && !v.startsWith('0001-') && !isNaN(Date.parse(v)) ? new Date(v).toISOString() : undefined);
/** Azure DevOps outcomes in a small set: passed, failed, blocked, not applicable, in progress, not run. */
export function outcomeOf(v: unknown): string {
    const o = String(v ?? '').toLowerCase();
    if (o === 'passed') return 'passed';
    if (o === 'failed' || o === 'error' || o === 'aborted' || o === 'timeout') return 'failed';
    if (o === 'blocked') return 'blocked';
    if (o === 'notapplicable') return 'not applicable';
    if (o === 'inprogress') return 'in progress';
    if (o === 'paused') return 'paused';
    return 'not run';
}

export class TestPlans {
    constructor(private readonly ado: AdoClient) {}
    private get webBase(): string { return `${this.ado.orgUrl}/${encodeURIComponent(this.ado.projectName)}`; }

    /** All pages of a list (Azure DevOps returns a continuation token). */
    private async all<T>(path: string): Promise<T[]> {
        const out: T[] = [];
        let token: string | undefined;
        for (let i = 0; i < 20; i++) {
            const r = await this.ado.page<{ value: T[] }>(path + (token ? `${path.includes('?') ? '&' : '?'}continuationToken=${encodeURIComponent(token)}` : ''), 'Test Management (Read)');
            out.push(...(r.data?.value ?? []));
            if (!r.next) break;
            token = r.next;
        }
        return out;
    }

    async plans(includeInactive = false): Promise<TestPlan[]> {
        const raw = await this.all<Record<string, any>>(`testplan/plans?filterActivePlans=${includeInactive ? 'false' : 'true'}&includePlanDetails=true`);
        return raw.map((p) => ({
            id: p.id, name: String(p.name ?? ''), state: String(p.state ?? ''), rootSuite: p.rootSuite?.id,
            iteration: p.iteration, areaPath: p.areaPath, owner: person(p.owner),
            web: `${this.webBase}/_testPlans/define?planId=${p.id}&suiteId=${p.rootSuite?.id}`,
        })).sort((a, b) => b.id - a.id);
    }

    async suites(plan: number): Promise<TestSuite[]> {
        const raw = await this.all<Record<string, any>>(`testplan/Plans/${plan}/suites`);
        return raw.map((s) => ({
            id: s.id, name: String(s.name ?? ''), type: String(s.suiteType ?? 'staticTestSuite'), parent: s.parentSuite?.id ?? null,
            ...(s.requirementId ? { requirementId: s.requirementId } : {}), ...(s.queryString ? { query: s.queryString } : {}),
        }));
    }

    async points(plan: number, suite: number): Promise<TestPoint[]> {
        const raw = await this.all<Record<string, any>>(`testplan/Plans/${plan}/Suites/${suite}/TestPoint?includePointDetails=true`);
        return raw.map((p) => ({
            id: p.id, testCase: p.testCaseReference?.id, title: String(p.testCaseReference?.name ?? ''), state: p.testCaseReference?.state,
            configuration: String(p.configuration?.name ?? ''), tester: person(p.tester),
            outcome: outcomeOf(p.results?.outcome), lastRun: realDate(p.results?.lastResultDetails?.dateCompleted),
            lastRunBy: person(p.results?.lastResultDetails?.runBy), runId: p.results?.lastTestRunId || undefined,
            isAutomated: p.isAutomated === true, active: p.isActive !== false,
        }));
    }

    /** Automation fields of test cases (state, automation status, the automated test's name). */
    async testCases(ids: number[]): Promise<Map<number, { title?: string; automationStatus?: string; automatedTestName?: string; steps?: string }>> {
        const out = new Map<number, { title?: string; automationStatus?: string; automatedTestName?: string; steps?: string }>();
        for (let i = 0; i < ids.length; i += 200) {
            const chunk = ids.slice(i, i + 200);
            if (!chunk.length) break;
            const r = await this.ado.post<{ value: Array<{ id: number; fields: Record<string, unknown> }> }>('wit/workitemsbatch', {
                ids: chunk, fields: ['System.Id', 'System.Title', 'Microsoft.VSTS.TCM.AutomationStatus', 'Microsoft.VSTS.TCM.AutomatedTestName', 'Microsoft.VSTS.TCM.Steps'], errorPolicy: 'omit',
            }, 'project', 'Work Items (Read)');
            for (const w of r.value ?? []) if (w) out.set(w.id, {
                title: w.fields['System.Title'] as string | undefined,
                automationStatus: w.fields['Microsoft.VSTS.TCM.AutomationStatus'] as string | undefined,
                automatedTestName: w.fields['Microsoft.VSTS.TCM.AutomatedTestName'] as string | undefined,
                steps: w.fields['Microsoft.VSTS.TCM.Steps'] as string | undefined,
            });
        }
        return out;
    }

    /** Create a test case with these steps; returns its id. */
    async createTestCase(t: { title: string; steps: TestStep[]; areaPath?: string; iterationPath?: string; automatedTestName?: string; automatedTestStorage?: string; parameters?: { names: string[]; rows: Array<Record<string, string>> } }): Promise<number> {
        const ops: Array<{ op: 'add'; path: string; value: string }> = [
            { op: 'add', path: '/fields/System.Title', value: t.title },
            { op: 'add', path: '/fields/Microsoft.VSTS.TCM.Steps', value: stepsXml(t.steps) },
        ];
        if (t.parameters?.names.length) ops.push({ op: 'add', path: '/fields/Microsoft.VSTS.TCM.Parameters', value: parametersXml(t.parameters.names) }, { op: 'add', path: '/fields/Microsoft.VSTS.TCM.LocalDataSource', value: localDataSourceXml(t.parameters.names, t.parameters.rows) });
        if (t.areaPath) ops.push({ op: 'add', path: '/fields/System.AreaPath', value: t.areaPath });
        if (t.iterationPath) ops.push({ op: 'add', path: '/fields/System.IterationPath', value: t.iterationPath });
        ops.push(...automationOps(t.automatedTestName, t.automatedTestStorage));
        const r = await this.ado.jsonPatch<{ id: number }>('POST', 'wit/workitems/$Test%20Case', ops);
        return r.id;
    }

    /** Replace a test case's steps (and mark it automated by the scenario when given). */
    async updateTestCase(id: number, steps: TestStep[], automation?: { name: string; storage: string }, parameters?: { names: string[]; rows: Array<Record<string, string>> }): Promise<void> {
        await this.ado.jsonPatch('PATCH', `wit/workitems/${id}`, [
            { op: 'add', path: '/fields/Microsoft.VSTS.TCM.Steps', value: stepsXml(steps) },
            ...(parameters?.names.length ? [{ op: 'add', path: '/fields/Microsoft.VSTS.TCM.Parameters', value: parametersXml(parameters.names) }, { op: 'add', path: '/fields/Microsoft.VSTS.TCM.LocalDataSource', value: localDataSourceXml(parameters.names, parameters.rows) }] : []),
            ...automationOps(automation?.name, automation?.storage),
        ]);
    }

    /**
     * Publish results to a test plan: one test run on exactly these test points (of one or more of its suites), each point's outcome,
     * duration, error and comment (the scenario, and each data iteration as the framework writes them), then the
     * run completed. Every point must belong to the plan and to its entry's test case (checked by the caller).
     */
    async publishTo(plan: number, name: string, entries: PublishEntry[], comment?: string): Promise<{ runId: number; url: string; published: number }> {
        const TM = 'Test Management (Read & write)';
        const byPoint = new Map<number, PublishEntry>();
        for (const e of entries) for (const p of e.pointIds) byPoint.set(p, e);
        if (!byPoint.size) throw new Error('Choose at least one test point.');
        const run = await this.ado.post<{ id: number; webAccessUrl?: string }>('test/runs', {
            name: name.slice(0, 250), plan: { id: String(plan) }, pointIds: [...byPoint.keys()], automated: true, state: 'InProgress', ...(comment ? { comment: comment.slice(0, 1000) } : {}),
        }, 'project', TM);
        const created = await this.ado.get<{ value: Array<{ id: number; testPoint?: { id: string }; testCase?: { id: string } }> }>(`test/runs/${run.id}/results?$top=1000`, 'project', TM);
        const updates = (created.value ?? []).map((res) => {
            const e = byPoint.get(Number(res.testPoint?.id)) ?? entries.find((x) => x.testCase === Number(res.testCase?.id));
            if (!e) return null;
            return { id: res.id, state: 'Completed', outcome: e.outcome, durationInMs: Math.round(e.durationMs), automatedTestName: e.scenario.slice(0, 250),
                ...(e.error ? { errorMessage: e.error.slice(0, 4000) } : {}), comment: e.comment.slice(0, 1000) };
        }).filter(Boolean);
        if (updates.length) await this.ado.patch(`test/runs/${run.id}/results`, updates, 'project', TM);
        await this.ado.patch(`test/runs/${run.id}`, { state: 'Completed' }, 'project', TM);
        return { runId: run.id, url: run.webAccessUrl ?? `${this.webBase}/_testManagement/runs?_a=resultQuery&runId=${run.id}`, published: updates.length };
    }

    /** Add test cases to a static suite (a test point per configuration of the suite). */
    async addToSuite(plan: number, suite: number, ids: number[]): Promise<void> {
        await this.ado.post(`testplan/Plans/${plan}/Suites/${suite}/TestCase`, ids.map((id) => ({ workItem: { id } })), 'project', 'Test Management (Read & write)');
    }
}

/**
 * Fields that associate the test case with automation: Azure DevOps shows it as Automated. The test is the
 * scenario ("Feature: Scenario") in its feature file; the id is a stable name-based GUID.
 */
function automationOps(name?: string, storage?: string): Array<{ op: 'add'; path: string; value: string }> {
    if (!name || !storage) return [];
    return [
        { op: 'add', path: '/fields/Microsoft.VSTS.TCM.AutomatedTestName', value: name.slice(0, 255) },
        { op: 'add', path: '/fields/Microsoft.VSTS.TCM.AutomatedTestStorage', value: storage.slice(0, 255) },
        { op: 'add', path: '/fields/Microsoft.VSTS.TCM.AutomatedTestType', value: 'CS Playwright BDD' },
        { op: 'add', path: '/fields/Microsoft.VSTS.TCM.AutomatedTestId', value: nameGuid(`${storage}\u0000${name}`) },
    ];
}

/** One test case's result as sent to its chosen test points. */
export interface PublishEntry { testCase: number; pointIds: number[]; outcome: Outcome; durationMs: number; error?: string; comment: string; scenario: string }
export type Outcome = 'Passed' | 'Failed' | 'NotExecuted' | 'Blocked';
const RANK: Record<Outcome, number> = { Failed: 3, Blocked: 2, NotExecuted: 1, Passed: 0 };
const worst = (list: Outcome[]): Outcome => list.reduce<Outcome>((a, b) => (RANK[a] >= RANK[b] ? a : b), 'Passed');
const outcomeOfStatus = (s: string): Outcome => { const st = s.toLowerCase(); return st === 'passed' ? 'Passed' : st === 'failed' || st === 'broken' ? 'Failed' : st === 'blocked' ? 'Blocked' : 'NotExecuted'; };

/**
 * A scenario of a finished run, as one thing to publish: a data-driven scenario's iterations ("…_Iteration-2",
 * "… (Example 2)") are one scenario with its iterations, as the framework publishes them. `key` is the
 * scenario's place in the repository (file:line) when it is found there, else its feature and name.
 */
export interface RunScenario {
    key: string; name: string; feature: string; file?: string; line?: number;
    outcome: Outcome; durationMs: number; error?: string;
    iterations: Array<{ n: number; outcome: Outcome; durationMs: number; error?: string }>;
    /** Where its tags send it (empty / undefined when it has no @TestCaseId, plan or suite). */
    testCases: number[]; plan?: number; suite?: number; planFrom?: PublishTarget['planFrom']; suiteFrom?: PublishTarget['suiteFrom'];
}
const ITER = /^(.*?)(?:_Iteration-(\d+)|\s*\(Example (\d+)\))$/i;
export function runScenarios(results: Array<{ name: string; feature: string; status: string; duration: number; error?: string }>, targets: PublishTarget[], prefer: (file: string) => number = () => 0): RunScenario[] {
    const norm = (x: string) => x.trim().toLowerCase();
    const out = new Map<string, RunScenario>();
    for (const sc of results) {
        const m = ITER.exec(sc.name);
        const n = m ? parseInt(m[2] ?? m[3], 10) : 0;
        // The scenario in the repository: same name, else the longest one whose name starts it (outlines,
        // iterations). A feature copied into another folder has the same names: the run's own files win.
        const best = (list: PublishTarget[]) => list.sort((a, b) => prefer(b.file) - prefer(a.file) || b.name.length - a.name.length)[0];
        const t = best(targets.filter((x) => norm(x.feature) === norm(sc.feature) && norm(x.name) === norm(sc.name)))
            ?? best(targets.filter((x) => norm(x.feature) === norm(sc.feature) && norm(sc.name).startsWith(norm(x.name))));
        const name = t?.name ?? (m ? m[1].trim() : sc.name);
        const key = t ? `${t.file}:${t.line}` : `${sc.feature}: ${name}`;
        const it = { n, outcome: outcomeOfStatus(sc.status), durationMs: Math.max(0, Number(sc.duration) || 0), ...(sc.error ? { error: sc.error } : {}) };
        const cur = out.get(key);
        if (!cur) {
            out.set(key, { key, name, feature: sc.feature, ...(t ? { file: t.file, line: t.line } : {}), outcome: it.outcome, durationMs: it.durationMs, ...(it.error ? { error: it.error } : {}), iterations: n ? [it] : [],
                testCases: t?.testCases ?? [], ...(t?.plan ? { plan: t.plan, planFrom: t.planFrom } : {}), ...(t?.suite ? { suite: t.suite, suiteFrom: t.suiteFrom } : {}) });
            continue;
        }
        // Another iteration (or example) of the same scenario.
        if (!cur.iterations.length) cur.iterations.push({ n: 1, outcome: cur.outcome, durationMs: cur.durationMs, ...(cur.error ? { error: cur.error } : {}) });
        cur.iterations.push({ ...it, n: n || cur.iterations.length + 1 });
        cur.outcome = worst([cur.outcome, it.outcome]);
        cur.durationMs += it.durationMs;
    }
    for (const s of out.values()) if (s.iterations.length > 1) {
        s.iterations.sort((a, b) => a.n - b.n);
        const failed = s.iterations.filter((i) => i.outcome === 'Failed');
        s.error = failed.length ? `${failed.length} of ${s.iterations.length} iterations failed. See comment for details.` : undefined;
    }
    return [...out.values()];
}

/** A test case's result from the scenarios chosen for it (failed if any failed; iterations listed as the framework does). */
export function entryFor(testCase: number, pointIds: number[], scenarios: RunScenario[]): PublishEntry {
    const lines: string[] = [];
    for (const s of scenarios) {
        if (s.iterations.length > 1) {
            lines.push(`Data-Driven Test Results (${s.iterations.length} iterations): ${s.feature}: ${s.name}`, `Overall Status: ${s.outcome}`, '', 'Iteration Results:');
            for (const i of s.iterations) lines.push(`Iteration ${i.n}: ${i.outcome === 'Passed' ? '✅ Passed' : i.outcome === 'Failed' ? '❌ Failed' : i.outcome}${i.error ? ` — ${i.error.split('\n')[0].slice(0, 200)}` : ''}`);
        } else lines.push(`Scenario: ${s.feature}: ${s.name} — ${s.outcome}`);
    }
    const errs = scenarios.map((s) => (s.iterations.length > 1 ? [s.error, ...s.iterations.filter((i) => i.error).map((i) => `Iteration ${i.n}: ${i.error}`)].filter(Boolean).join('\n') : s.error)).filter(Boolean) as string[];
    return {
        testCase, pointIds, outcome: worst(scenarios.map((s) => s.outcome)), durationMs: scenarios.reduce((n, s) => n + s.durationMs, 0),
        ...(errs.length ? { error: errs.join('\n\n') } : {}), comment: lines.join('\n'), scenario: scenarios.map((s) => `${s.feature}: ${s.name}`).join('; '),
    };
}

/**
 * The tags that make a scenario publish to the test cases it was mapped to (`ids`, with those it had) in the
 * suite(s) it was published to (`targets`, "plan/suite"). A scenario's tags name one plan and suite, as the
 * framework reads them: one that already sends test cases to another suite is left as it is (moving it would
 * stop those results), as is one published to several suites.
 */
export function tagsForMapping(s: Pick<RunScenario, 'testCases' | 'plan' | 'suite'>, ids: Set<number>, targets: Set<string>): { tags: string[] } | { skip: string } {
    if (targets.size > 1) return { skip: `published to ${targets.size} suites; a scenario's tags hold one plan and suite` };
    const [plan, suite] = [...targets][0].split('/').map(Number);
    if (s.testCases.length && s.plan && s.suite && (s.plan !== plan || s.suite !== suite)) {
        return { skip: `its tags send test case${s.testCases.length === 1 ? '' : 's'} ${s.testCases.join(', ')} to plan ${s.plan} / suite ${s.suite}; changing them would stop those results` };
    }
    const all = new Set([...s.testCases, ...ids]);
    const unchanged = all.size === s.testCases.length;
    return { tags: [...(unchanged ? [] : [testCaseTag([...all])]), ...tagsToPublishTo(s, plan, suite)] };
}

/** The @TestCaseId tag for these ids (one id, or {a,b}). */
export function testCaseTag(ids: number[]): string {
    const u = [...new Set(ids)].sort((a, b) => a - b);
    return u.length === 1 ? `@TestCaseId:${u[0]}` : `@TestCaseId:{${u.join(',')}}`;
}

/** A GUID made from a name (the same name gives the same GUID). */
export function nameGuid(name: string): string {
    const { createHash } = require('crypto') as typeof import('crypto');
    const h = createHash('sha1').update(name).digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Test steps as the Steps field: XML holding escaped HTML (lines of a step joined with line breaks). */
export function stepsXml(steps: TestStep[]): string {
    const html = (t: string) => (t.trim() ? `<DIV><P>${t.split('\n').map(esc).join('<BR/>')}</P></DIV>` : '');
    const body = steps.map((s, i) => `<step id="${i + 2}" type="${s.expected.trim() ? 'ValidateStep' : 'ActionStep'}"><parameterizedString isformatted="true">${esc(html(s.action))}</parameterizedString><parameterizedString isformatted="true">${esc(html(s.expected))}</parameterizedString><description/></step>`).join('');
    return `<steps id="0" last="${steps.length + 1}">${body}</steps>`;
}

/**
 * A scenario's steps (Background first) as test steps: Given/When steps are actions, Then steps the expected
 * result of the action before them (And/But continue the kind before). Tables and doc strings stay with
 * their step.
 */
export function scenarioTestSteps(featureText: string, line: number): { name: string; steps: TestStep[]; parameters?: { names: string[]; rows: Array<Record<string, string>> } } | null {
    const lines = featureText.split(/\r?\n/);
    const head = /^\s*(Scenario Outline|Scenario Template|Scenario|Example):\s*(.*)$/.exec(lines[line - 1] ?? '');
    if (!head) return null;
    const STEP = /^\s*(Given|When|Then|And|But|\*)\s+(.*)$/;
    const collect = (from: number): string[][] => {
        const out: string[][] = [];
        let doc: string | null = null;
        for (let i = from; i < lines.length; i++) {
            const raw = lines[i];
            const t = raw.trim();
            if (doc) { out[out.length - 1]?.push(raw.replace(/^\s{0,6}/, '')); if (t.startsWith(doc)) doc = null; continue; }
            if (/^(Scenario|Scenario Outline|Scenario Template|Example|Examples|Scenarios|Rule|Background|Feature):/.test(t) || /^@/.test(t)) break;
            if (t.startsWith('"""') || t.startsWith('```')) { out[out.length - 1]?.push(t); doc = t.slice(0, 3); continue; }
            if (t.startsWith('|')) { out[out.length - 1]?.push(t); continue; }
            const m = STEP.exec(raw);
            if (m) out.push([`${m[1]} ${m[2].trim()}`]);
        }
        return out;
    };
    const bg = lines.findIndex((l, i) => i < line - 1 && /^\s*Background:/.test(l));
    const all = [...(bg >= 0 ? collect(bg + 1) : []), ...collect(line)];
    const steps: TestStep[] = [];
    let last: 'action' | 'expected' = 'action';
    for (const s of all) {
        const kw = s[0].split(' ')[0];
        const kind: 'action' | 'expected' = kw === 'Then' ? 'expected' : kw === 'Given' || kw === 'When' ? 'action' : last;
        const text = s.join('\n');
        if (kind === 'action') steps.push({ action: text, expected: '' });
        else if (steps.length) { const cur = steps[steps.length - 1]; cur.expected = cur.expected ? `${cur.expected}\n${text}` : text; }
        else steps.push({ action: 'Check', expected: text });
        last = kind;
    }
    // An outline: its <placeholders> are the test case's @parameters, its Examples rows their values.
    if (/Outline|Template/.test(head[1])) {
        const rows: string[][] = [];
        let inEx = false;
        for (let i = line; i < lines.length; i++) {
            const t = lines[i].trim();
            if (/^(Examples|Scenarios):/.test(t)) { inEx = true; continue; }
            if (/^(Scenario|Scenario Outline|Scenario Template|Example|Rule|Background|Feature):/.test(t) || (/^@/.test(t) && !inEx)) break;
            if (inEx && t.startsWith('|')) rows.push(t.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|').replace(/\\\\/g, '\\')));
            else if (inEx && t && !t.startsWith('#') && !t.startsWith('@')) break;
        }
        const names = rows[0] ?? [...new Set(steps.flatMap((s) => [...`${s.action}\n${s.expected}`.matchAll(/<([A-Za-z_][\w-]*)>/g)].map((m) => m[1])))];
        const at = (t: string) => t.replace(/<([A-Za-z_][\w-]*)>/g, (m, n: string) => (names.includes(n) ? `@${n}` : m));
        return { name: head[2].trim(), steps: steps.map((s) => ({ action: at(s.action), expected: at(s.expected) })), parameters: { names, rows: rows.slice(1).map((r) => Object.fromEntries(names.map((n, k) => [n, r[k] ?? '']))) } };
    }
    return { name: head[2].trim(), steps };
}

/** The Parameters field of a test case (the names its steps use as @name). */
export function parametersXml(names: string[]): string {
    return `<parameters>${names.map((n) => `<param name="${esc(n)}" bind="default"/>`).join('')}</parameters>`;
}

/** The LocalDataSource field: the parameter values as the dataset Azure DevOps keeps (one Table1 per row). */
export function localDataSourceXml(names: string[], rows: Array<Record<string, string>>): string {
    const ok = names.filter((n) => /^[A-Za-z_][\w.-]*$/.test(n));
    const schema = `<xs:schema id='NewDataSet' xmlns:xs='http://www.w3.org/2001/XMLSchema' xmlns:msdata='urn:schemas-microsoft-com:xml-msdata'><xs:element name='NewDataSet' msdata:IsDataSet='true' msdata:Locale=''><xs:complexType><xs:choice minOccurs='0' maxOccurs='unbounded'><xs:element name='Table1'><xs:complexType><xs:sequence>${ok.map((n) => `<xs:element name='${n}' type='xs:string' minOccurs='0' />`).join('')}</xs:sequence></xs:complexType></xs:element></xs:choice></xs:complexType></xs:element></xs:schema>`;
    return `<NewDataSet>${schema}${rows.map((r) => `<Table1>${ok.map((n) => `<${n}>${esc(r[n] ?? '')}</${n}>`).join('')}</Table1>`).join('')}</NewDataSet>`;
}

// ---- Where a scenario's results go (as the framework's CSADOTagExtractor / CSADOPublisher decide)

export interface PublishTarget {
    file: string; line: number; name: string; feature: string;
    /** @TestCaseId of the scenario; else of its feature (the framework's fallback). */
    testCases: number[];
    plan?: number; suite?: number;
    /** Where the plan and suite come from: scenario tags, feature tags, or ADO_TEST_PLAN_ID / ADO_TEST_SUITE_ID. */
    planFrom?: 'scenario' | 'feature' | 'config'; suiteFrom?: 'scenario' | 'feature' | 'config';
}
const TC = /@TestCaseId:(?:\{([^}]+)\}|(\d+))/i;
const idsIn = (tags: string[]) => tags.flatMap((t) => { const m = TC.exec(t); return m ? (m[1] ?? m[2]).split(',').map((x) => parseInt(x.trim(), 10)).filter((n) => n > 0) : []; });
const firstId = (tags: string[], re: RegExp) => { for (const t of tags) { const m = re.exec(t); if (m) return parseInt(m[1], 10); } return undefined; };

/**
 * Every scenario with the test plan and suite its results are published to: scenario tags win over feature
 * tags, which win over ADO_TEST_PLAN_ID / ADO_TEST_SUITE_ID; test case ids come from the scenario's tags, else
 * the feature's. The framework publishes only when test cases, plan and suite are all known.
 */
export function publishTargets(catalog: Array<{ path: string; name: string; tags: string[]; scenarios: Array<{ name: string; line: number; tags: string[] }> }>, config: { plan?: number; suite?: number }): PublishTarget[] {
    const PLAN = /@TestPlanId:(\d+)/i, SUITE = /@TestSuiteId:(\d+)/i;
    const out: PublishTarget[] = [];
    for (const f of catalog) for (const sc of f.scenarios) {
        const sPlan = firstId(sc.tags, PLAN), fPlan = firstId(f.tags, PLAN);
        const sSuite = firstId(sc.tags, SUITE), fSuite = firstId(f.tags, SUITE);
        const plan = sPlan ?? fPlan ?? config.plan, suite = sSuite ?? fSuite ?? config.suite;
        const own = idsIn(sc.tags);
        out.push({
            file: f.path, line: sc.line, name: sc.name, feature: f.name, testCases: own.length ? own : idsIn(f.tags),
            ...(plan ? { plan, planFrom: sPlan ? 'scenario' as const : fPlan ? 'feature' as const : 'config' as const } : {}),
            ...(suite ? { suite, suiteFrom: sSuite ? 'scenario' as const : fSuite ? 'feature' as const : 'config' as const } : {}),
        });
    }
    return out;
}

/** The tags a scenario needs so its results go to this plan and suite (none beyond @TestCaseId when it already does). */
export function tagsToPublishTo(t: Pick<PublishTarget, 'plan' | 'suite'>, plan: number, suite: number): string[] {
    return t.plan === plan && t.suite === suite ? [] : [`@TestPlanId:${plan}`, `@TestSuiteId:${suite}`];
}
