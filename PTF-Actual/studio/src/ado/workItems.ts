/**
 * Azure DevOps work items for the Studio (read-only): my work, the current sprint, search, and the
 * details of one item, including a test case's steps. Nothing is written to Azure DevOps.
 *
 * Verified against a real organization (REST 7.1):
 *  - WIQL: POST {project}/_apis/wit/wiql returns ids; fields come from GET wit/workitems?ids=…
 *    (at most 200 ids per call).
 *  - The current sprint: GET {project}/{team}/_apis/work/teamsettings/iterations?$timeframe=current.
 *  - Teams: GET _apis/projects/{project}/teams. Who am I: GET _apis/connectionData.
 *  - Description / acceptance criteria / repro steps are HTML. They are turned into plain text here
 *    and never rendered as HTML.
 *  - Test case steps (Microsoft.VSTS.TCM.Steps) are XML: <step><parameterizedString>action</…>
 *    <parameterizedString>expected</…></step>, whose text is itself escaped HTML.
 *  - The framework links scenarios to test cases with @TestCaseId:419 or @TestCaseId:{419,420}
 *    (CSADOTagExtractor.PATTERNS.TEST_CASE).
 */
import * as fs from 'fs';
import * as path from 'path';
import { AdoClient } from './client';
import { UserError } from '../core/errors';
import { runGit } from '../git/run';

export interface WorkItemSummary {
    id: number;
    title: string;
    type: string;
    state: string;
    assignedTo?: string;
    iteration?: string;
    area?: string;
    priority?: number;
    tags: string[];
    changed?: string;
    /** Test cases: ADO's own automation status ("Automated", "Not Automated", "Planned"). */
    automationStatus?: string;
    url: string;
}

export interface TestStep { action: string; expected: string; /** The step comes from a shared step (its work item). */ shared?: { id: number; title: string } }
/** A test case's parameters (@name in its steps) and their values (one row per iteration). */
export interface TestParameters { names: string[]; rows: Array<Record<string, string>>; /** The values come from a shared parameter set. */ sharedSet?: { id: number; title?: string } }
export interface WorkItemDetail extends WorkItemSummary {
    description?: string;
    acceptanceCriteria?: string;
    reproSteps?: string;
    steps?: TestStep[];
    parameters?: TestParameters;
    automatedTestName?: string;
    relations: Array<{ kind: string; id?: number; url?: string }>;
    /** The revision read (a save is refused when the item changed since). */
    rev?: number;
    assignedToEmail?: string;
}

export const LIST_FIELDS = ['System.Id', 'System.Title', 'System.WorkItemType', 'System.State', 'System.AssignedTo', 'System.IterationPath', 'System.AreaPath',
    'System.Tags', 'System.ChangedDate', 'Microsoft.VSTS.Common.Priority', 'Microsoft.VSTS.TCM.AutomationStatus'];

/** Quote a value for WIQL ('it''s'). */
export const wiqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•' };
export function decodeEntities(s: string): string {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
        if (e[0] === '#') {
            const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
        }
        return ENTITIES[e.toLowerCase()] ?? m;
    });
}

/** HTML from Azure DevOps → readable plain text (paragraphs, bullets, table rows). Never HTML. */
export function htmlToText(html: string | undefined | null): string | undefined {
    if (!html) return undefined;
    let s = String(html).slice(0, 200_000);
    s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
    s = s.replace(/<br\s*\/?>/gi, '\n');
    s = s.replace(/<li[^>]*>/gi, '\n• ');
    s = s.replace(/<\/t[dh]>\s*(?=<t[dh][\s>])/gi, ' | '); // cells of one row: </td> followed by <td> (not by </tr>)
    s = s.replace(/<\/(p|div|h[1-6]|li|ul|ol|table|tr)>/gi, '\n');
    s = s.replace(/<(p|div|h[1-6]|ul|ol|table|tr)[^>]*>/gi, '\n');
    s = s.replace(/<[^>]+>/g, '');
    s = decodeEntities(s);
    s = s.split('\n').map((l) => l.replace(/[ \t ]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return s || undefined;
}

/** The steps XML in order: steps, and references to shared steps (<compref ref="id">, whose steps live in that work item). */
export function stepsWithShared(xml: string | undefined | null): Array<{ step: TestStep } | { shared: number }> {
    if (!xml) return [];
    const out: Array<{ step: TestStep } | { shared: number }> = [];
    const text = (v: string) => htmlToText(decodeEntities(v)) ?? '';
    for (const m of xml.matchAll(/<compref\b[^>]*\bref="(\d+)"[^>]*\/?>|<step\b[^>]*>([\s\S]*?)<\/step>/gi)) {
        if (out.length >= 500) break;
        if (m[1]) { out.push({ shared: Number(m[1]) }); continue; }
        const parts = [...m[2].matchAll(/<parameterizedString\b[^>]*>([\s\S]*?)<\/parameterizedString>|<parameterizedString\b[^>]*\/>/gi)].map((p) => p[1] ?? '');
        out.push({ step: { action: text(parts[0] ?? ''), expected: text(parts[1] ?? '') } });
    }
    return out;
}

/**
 * A test case's parameters: the names (Microsoft.VSTS.TCM.Parameters, <parameters><param name="user"/>) and their
 * values: the test case's own (Microsoft.VSTS.TCM.LocalDataSource, a dataset: <NewDataSet><Table1><user>…</user>
 * </Table1>…) or a shared parameter set's (LocalDataSource JSON {"parameterMap": […], "sharedParameterDataSetIds": [id]},
 * the set's own Parameters field: <parameterSet><paramData><dataRow><kvp key="user" value="…"/>).
 */
export function parseParameters(paramsXml: string | undefined | null, localDataSource: string | undefined | null): { names: string[]; rows: Array<Record<string, string>>; sharedSetId?: number; map?: Record<string, string> } {
    const names = [...String(paramsXml ?? '').matchAll(/<param\b[^>]*\bname="([^"]+)"/gi)].map((m) => decodeEntities(m[1]));
    const ds = String(localDataSource ?? '').trim();
    if (ds.startsWith('{')) {
        try {
            const j = JSON.parse(ds) as { parameterMap?: Array<{ localParamName: string; sharedParameterName: string }>; sharedParameterDataSetIds?: number[] };
            return { names, rows: [], ...(j.sharedParameterDataSetIds?.[0] ? { sharedSetId: j.sharedParameterDataSetIds[0] } : {}), map: Object.fromEntries((j.parameterMap ?? []).map((p) => [p.localParamName, p.sharedParameterName])) };
        } catch { return { names, rows: [] }; }
    }
    const rows: Array<Record<string, string>> = [];
    for (const t of ds.matchAll(/<Table1>([\s\S]*?)<\/Table1>/gi)) {
        const row: Record<string, string> = {};
        for (const c of t[1].matchAll(/<([A-Za-z_][\w.-]*)>([\s\S]*?)<\/\1>|<([A-Za-z_][\w.-]*)\s*\/>/g)) row[c[1] ?? c[3]] = decodeEntities(c[2] ?? '');
        rows.push(row);
    }
    return { names, rows };
}

/** The rows of a shared parameter set (its Microsoft.VSTS.TCM.Parameters field). */
export function sharedParameterRows(xml: string | undefined | null): Array<Record<string, string>> {
    const rows: Array<Record<string, string>> = [];
    for (const r of String(xml ?? '').matchAll(/<dataRow\b[^>]*>([\s\S]*?)<\/dataRow>/gi)) {
        const row: Record<string, string> = {};
        for (const k of r[1].matchAll(/<kvp\b[^>]*\bkey="([^"]*)"[^>]*\bvalue="([^"]*)"/gi)) row[decodeEntities(k[1])] = decodeEntities(k[2]);
        rows.push(row);
    }
    return rows;
}

/** Test case steps XML → [{ action, expected }]. */
export function parseTestSteps(xml: string | undefined | null): TestStep[] {
    if (!xml) return [];
    const out: TestStep[] = [];
    const stepRe = /<step\b[^>]*>([\s\S]*?)<\/step>/gi;
    let m: RegExpExecArray | null;
    while ((m = stepRe.exec(xml)) !== null && out.length < 500) {
        const parts = [...m[1].matchAll(/<parameterizedString\b[^>]*>([\s\S]*?)<\/parameterizedString>|<parameterizedString\b[^>]*\/>/gi)].map((p) => p[1] ?? '');
        // The XML holds escaped HTML: unescape the XML first, then turn the HTML into text.
        const text = (v: string) => htmlToText(decodeEntities(v)) ?? '';
        out.push({ action: text(parts[0] ?? ''), expected: text(parts[1] ?? '') });
    }
    return out;
}

const person = (v: unknown): string | undefined => (v && typeof v === 'object' ? String((v as { displayName?: unknown }).displayName ?? '') || undefined : typeof v === 'string' ? v : undefined);

export function summary(w: { id: number; fields: Record<string, unknown> }, webBase: string): WorkItemSummary {
    const f = w.fields;
    return {
        id: w.id,
        title: String(f['System.Title'] ?? ''),
        type: String(f['System.WorkItemType'] ?? ''),
        state: String(f['System.State'] ?? ''),
        assignedTo: person(f['System.AssignedTo']),
        iteration: f['System.IterationPath'] ? String(f['System.IterationPath']) : undefined,
        area: f['System.AreaPath'] ? String(f['System.AreaPath']) : undefined,
        priority: typeof f['Microsoft.VSTS.Common.Priority'] === 'number' ? f['Microsoft.VSTS.Common.Priority'] as number : undefined,
        tags: typeof f['System.Tags'] === 'string' ? (f['System.Tags'] as string).split(';').map((t) => t.trim()).filter(Boolean) : [],
        changed: f['System.ChangedDate'] ? String(f['System.ChangedDate']) : undefined,
        automationStatus: f['Microsoft.VSTS.TCM.AutomationStatus'] ? String(f['Microsoft.VSTS.TCM.AutomationStatus']) : undefined,
        url: `${webBase}/_workitems/edit/${w.id}`,
    };
}

export type WorkItemList = 'mine' | 'sprint' | 'search';

export class WorkItems {
    constructor(private readonly ado: AdoClient) {}

    private get webBase(): string { return `${this.ado.orgUrl}/${encodeURIComponent(this.ado.projectName)}`; }

    async teams(): Promise<string[]> {
        const r = await this.ado.get<{ value: Array<{ name: string }> }>(`projects/${encodeURIComponent(this.ado.projectName)}/teams`, 'org', 'Project and Team (Read)');
        return r.value.map((t) => t.name);
    }

    async currentIteration(team: string): Promise<{ name: string; path: string } | null> {
        const r = await this.ado.get<{ value: Array<{ name: string; path: string }> }>('work/teamsettings/iterations?$timeframe=current', { team }, 'Work Items (Read)');
        return r.value[0] ? { name: r.value[0].name, path: r.value[0].path } : null;
    }

    private async byIds(ids: number[]): Promise<WorkItemSummary[]> {
        const out: WorkItemSummary[] = [];
        for (let i = 0; i < ids.length; i += 200) {
            const chunk = ids.slice(i, i + 200);
            const r = await this.ado.get<{ value: Array<{ id: number; fields: Record<string, unknown> }> }>(
                `wit/workitems?ids=${chunk.join(',')}&fields=${LIST_FIELDS.join(',')}&errorPolicy=omit`);
            // errorPolicy=omit returns null for items that cannot be read; keep the WIQL order.
            const byId = new Map(r.value.filter(Boolean).map((w) => [w.id, w]));
            for (const id of chunk) { const w = byId.get(id); if (w) out.push(summary(w, this.webBase)); }
        }
        return out;
    }

    private async wiql(where: string, top = 200): Promise<number[]> {
        const query = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND ${where} ORDER BY [System.ChangedDate] DESC`;
        const r = await this.ado.post<{ workItems: Array<{ id: number }> }>(`wit/wiql?$top=${top}`, { query });
        return r.workItems.map((w) => w.id);
    }

    /** My open items, the team's current sprint, or a search (an id, or words in the title). */
    async list(kind: WorkItemList, opts: { team?: string; text?: string; type?: string; includeClosed?: boolean } = {}): Promise<{ items: WorkItemSummary[]; sprint?: { name: string; path: string } | null; team?: string }> {
        const open = opts.includeClosed ? '' : ` AND [System.State] NOT IN ('Closed', 'Done', 'Removed', 'Resolved')`;
        const type = opts.type ? ` AND [System.WorkItemType] = ${wiqlString(opts.type)}` : '';
        if (kind === 'mine') return { items: await this.byIds(await this.wiql(`[System.AssignedTo] = @Me${open}${type}`)) };
        if (kind === 'sprint') {
            const team = opts.team || (await this.teams())[0];
            if (!team) throw new UserError('This Azure DevOps project has no team.');
            const sprint = await this.currentIteration(team);
            if (!sprint) return { items: [], sprint: null, team };
            return { items: await this.byIds(await this.wiql(`[System.IterationPath] UNDER ${wiqlString(sprint.path)}${type}`)), sprint, team };
        }
        const text = (opts.text ?? '').trim();
        if (!text) return { items: [] };
        const ids = /^#?\d{1,9}$/.test(text) ? [Number(text.replace('#', ''))] : await this.wiql(`[System.Title] CONTAINS ${wiqlString(text.slice(0, 200))}${type}`, 100);
        return { items: await this.byIds(ids) };
    }

    async detail(id: number): Promise<WorkItemDetail> {
        if (!Number.isInteger(id) || id <= 0) throw new UserError('Invalid work item id.');
        const w = await this.ado.get<{ id: number; rev?: number; fields: Record<string, unknown>; relations?: Array<{ rel: string; url: string; attributes?: { name?: string } }> }>(`wit/workitems/${id}?$expand=all`);
        const f = w.fields;
        const who = f['System.AssignedTo'] as { uniqueName?: string } | undefined;
        return {
            ...summary(w, this.webBase),
            ...(w.rev !== undefined ? { rev: w.rev } : {}),
            ...(who && typeof who === 'object' && who.uniqueName ? { assignedToEmail: who.uniqueName } : {}),
            description: htmlToText(f['System.Description'] as string),
            acceptanceCriteria: htmlToText(f['Microsoft.VSTS.Common.AcceptanceCriteria'] as string),
            reproSteps: htmlToText(f['Microsoft.VSTS.TCM.ReproSteps'] as string),
            ...(f['Microsoft.VSTS.TCM.Steps'] ? await this.expandedSteps(f['Microsoft.VSTS.TCM.Steps'] as string) : {}),
            ...(f['Microsoft.VSTS.TCM.Parameters'] ? { parameters: await this.parameters(f['Microsoft.VSTS.TCM.Parameters'] as string, f['Microsoft.VSTS.TCM.LocalDataSource'] as string | undefined) } : {}),
            automatedTestName: f['Microsoft.VSTS.TCM.AutomatedTestName'] ? String(f['Microsoft.VSTS.TCM.AutomatedTestName']) : undefined,
            relations: (w.relations ?? []).filter((r) => /workItems\/\d+$/i.test(r.url)).slice(0, 100).map((r) => ({
                kind: r.attributes?.name || r.rel.replace(/^.*\./, ''),
                id: Number(/workItems\/(\d+)$/i.exec(r.url)![1]),
            })),
        };
    }

    /** A test case's steps with its shared steps expanded (each marked with the shared step it comes from). */
    private async expandedSteps(xml: string): Promise<{ steps: TestStep[] }> {
        const items = stepsWithShared(xml);
        const refs = [...new Set(items.flatMap((x) => ('shared' in x ? [x.shared] : [])))];
        const shared = new Map<number, { title: string; steps: TestStep[] }>();
        if (refs.length) {
            const r = await this.ado.get<{ value: Array<{ id: number; fields: Record<string, unknown> } | null> }>(`wit/workitems?ids=${refs.slice(0, 200).join(',')}&fields=System.Title,Microsoft.VSTS.TCM.Steps&errorPolicy=omit`);
            for (const w of r.value) if (w) shared.set(w.id, { title: String(w.fields['System.Title'] ?? ''), steps: parseTestSteps(w.fields['Microsoft.VSTS.TCM.Steps'] as string) });
        }
        const steps: TestStep[] = [];
        for (const x of items) {
            if ('step' in x) { steps.push(x.step); continue; }
            const s = shared.get(x.shared);
            if (!s) { steps.push({ action: `(shared steps #${x.shared} could not be read)`, expected: '', shared: { id: x.shared, title: '' } }); continue; }
            for (const st of s.steps) steps.push({ ...st, shared: { id: x.shared, title: s.title } });
        }
        return { steps };
    }

    /** A test case's parameters and their values (its own, or a shared parameter set's, renamed as the test case maps them). */
    private async parameters(paramsXml: string, localDataSource?: string): Promise<TestParameters> {
        const p = parseParameters(paramsXml, localDataSource);
        if (!p.sharedSetId) return { names: p.names, rows: p.rows };
        const w = await this.ado.get<{ id: number; fields: Record<string, unknown> }>(`wit/workitems/${p.sharedSetId}?fields=System.Title,Microsoft.VSTS.TCM.Parameters`).catch(() => null);
        const back = Object.fromEntries(Object.entries(p.map ?? {}).map(([local, sh]) => [sh, local]));
        const rows = sharedParameterRows(w?.fields['Microsoft.VSTS.TCM.Parameters'] as string).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [back[k] ?? k, v])));
        return { names: p.names, rows, sharedSet: { id: p.sharedSetId, ...(w ? { title: String(w.fields['System.Title'] ?? '') } : {}) } };
    }

    /** What an item of this type can be set to: its states, the project's iterations and areas, the people of its teams. */
    async editOptions(type: string): Promise<{ states: Array<{ name: string; category: string }>; iterations: string[]; areas: string[]; people: Array<{ name: string; email: string }> }> {
        const p = encodeURIComponent(this.ado.projectName);
        const paths = (n: { name: string; path?: string; children?: unknown[] }, out: string[] = []): string[] => {
            // Classification paths come as \Project\Iteration\Sprint 1; fields take Project\Sprint 1.
            if (n.path) out.push(n.path.replace(/^\\/, '').replace(/^([^\\]+)\\(Iteration|Area)(\\|$)/, '$1$3'));
            for (const c of (n.children ?? []) as Array<{ name: string; path?: string; children?: unknown[] }>) paths(c, out);
            return out;
        };
        const [states, it, ar, teams] = await Promise.all([
            this.ado.get<{ value: Array<{ name: string; category: string }> }>(`wit/workitemtypes/${encodeURIComponent(type)}/states`).then((r) => r.value.filter((s) => s.category !== 'Removed')),
            this.ado.get<{ name: string; path?: string; children?: unknown[] }>('wit/classificationnodes/Iterations?$depth=6').then((n) => paths(n)).catch(() => []),
            this.ado.get<{ name: string; path?: string; children?: unknown[] }>('wit/classificationnodes/Areas?$depth=6').then((n) => paths(n)).catch(() => []),
            this.ado.get<{ value: Array<{ id: string }> }>(`projects/${p}/teams?$top=50`, 'org', 'Project and Team (Read)').then((r) => r.value).catch(() => []),
        ]);
        const people = new Map<string, { name: string; email: string }>();
        for (const t of teams.slice(0, 20)) {
            const m = await this.ado.get<{ value: Array<{ identity: { displayName: string; uniqueName?: string; isContainer?: boolean } }> }>(`projects/${p}/teams/${encodeURIComponent(t.id)}/members?$top=200`, 'org', 'Project and Team (Read)').catch(() => ({ value: [] }));
            for (const x of m.value) if (!x.identity.isContainer && x.identity.uniqueName) people.set(x.identity.uniqueName, { name: x.identity.displayName, email: x.identity.uniqueName });
        }
        return { states, iterations: [this.ado.projectName, ...it.filter((x) => x !== this.ado.projectName)], areas: [this.ado.projectName, ...ar.filter((x) => x !== this.ado.projectName)], people: [...people.values()].sort((a, b) => a.name.localeCompare(b.name)) };
    }

    /**
     * Change an item: state, assignee (email, or '' for nobody), iteration, area, priority, tags (the whole list),
     * and a comment. With `rev`, Azure DevOps refuses the change when the item changed since it was read.
     */
    async update(id: number, c: { state?: string; assignedTo?: string; iteration?: string; area?: string; priority?: number; tags?: string[]; comment?: string }, rev?: number): Promise<{ rev?: number }> {
        const ops: Array<{ op: string; path: string; value?: unknown }> = [];
        if (rev !== undefined) ops.push({ op: 'test', path: '/rev', value: rev });
        const set = (field: string, v: unknown) => ops.push({ op: 'add', path: `/fields/${field}`, value: v });
        if (c.state !== undefined) set('System.State', c.state);
        if (c.assignedTo !== undefined) set('System.AssignedTo', c.assignedTo);
        if (c.iteration !== undefined) set('System.IterationPath', c.iteration);
        if (c.area !== undefined) set('System.AreaPath', c.area);
        if (c.priority !== undefined) set('Microsoft.VSTS.Common.Priority', c.priority);
        if (c.tags !== undefined) set('System.Tags', c.tags.map((t) => t.trim()).filter(Boolean).join('; '));
        let out: { rev?: number } = {};
        if (ops.length > (rev !== undefined ? 1 : 0)) {
            try { const r = await this.ado.jsonPatch<{ rev?: number }>('PATCH', `wit/workitems/${id}`, ops); out = r.rev !== undefined ? { rev: r.rev } : {}; }
            catch (e) { if (/\b412\b|\/rev\b|test operation|changed by someone else|TF26071/i.test((e as Error).message)) throw new UserError('Someone changed this work item after you opened it. Reload it and make your change again.'); throw e; }
        }
        if (c.comment?.trim()) await this.ado.post(`wit/workItems/${id}/comments?api-version=7.1-preview.4`, { text: c.comment.trim().slice(0, 8000) }, 'project', 'Work Items (Read & write)');
        return out;
    }

    /** A batch of items by id (for linked items). */
    async many(ids: number[]): Promise<WorkItemSummary[]> { return this.byIds(ids.filter((n) => Number.isInteger(n) && n > 0).slice(0, 200)); }
}

/** Test case ids tagged (@TestCaseId) in the feature files of a Git ref; null when the ref is not here. */
export async function testCaseIdsAt(repoRoot: string, ref: string): Promise<Set<number> | null> {
    if (!/^refs\/[\w./-]+$/.test(ref) || ref.includes('..')) return null;
    const ok = await runGit(['rev-parse', '--verify', '-q', `${ref}^{commit}`], { cwd: repoRoot, allowFailure: true });
    if (ok.code !== 0) return null;
    // Exit code 1: no match.
    const r = await runGit(['grep', '-h', '-I', '-E', '@TestCaseId:', ref, '--', '*.feature'], { cwd: repoRoot, allowFailure: true });
    const ids = new Set<number>();
    for (const line of r.stdout.split('\n')) {
        if (!line.trim().startsWith('@')) continue;
        for (const m of line.matchAll(/@TestCaseId:(?:\{([^}]+)\}|(\d+))/gi)) for (const x of (m[1] ?? m[2]).split(',')) { const n = parseInt(x.trim(), 10); if (n > 0) ids.add(n); }
    }
    return ids;
}

/** Scenarios in the repository tagged @TestCaseId:<id> (or {a,b,c}), with their location. */
export function automatedScenarios(repoRoot: string): Map<number, Array<{ file: string; line: number; name: string }>> {
    const out = new Map<number, Array<{ file: string; line: number; name: string }>>();
    const SKIP = new Set(['node_modules', '.git', 'reports', 'test-results', 'dist', 'build', 'coverage']);
    const walk = (dir: string, depth: number) => {
        if (depth > 12) return;
        let entries: fs.Dirent[] = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (e.name.startsWith('.')) continue;
            const a = path.join(dir, e.name);
            if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(a, depth + 1); continue; }
            if (!e.isFile() || !e.name.endsWith('.feature')) continue;
            let text = '';
            try { if (fs.statSync(a).size > 2 * 1024 * 1024) continue; text = fs.readFileSync(a, 'utf8'); } catch { continue; }
            const rel = path.relative(repoRoot, a).split(path.sep).join('/');
            const lines = text.split(/\r?\n/);
            let pending: number[] = [];
            for (let i = 0; i < lines.length; i++) {
                const t = lines[i].trim();
                if (t.startsWith('@')) {
                    for (const m of t.matchAll(/@TestCaseId:(?:\{([^}]+)\}|(\d+))/gi)) {
                        const ids = (m[1] ?? m[2]).split(',').map((x) => parseInt(x.trim(), 10)).filter((n) => !Number.isNaN(n));
                        pending.push(...ids);
                    }
                    continue;
                }
                const sc = /^(Scenario Outline|Scenario Template|Scenario|Example):\s*(.*)$/.exec(t);
                if (sc) {
                    for (const id of pending) { if (!out.has(id)) out.set(id, []); out.get(id)!.push({ file: rel, line: i + 1, name: sc[2].trim() }); }
                    pending = [];
                } else if (t && !t.startsWith('#')) pending = []; // tags only apply to the next scenario (feature-level tags are not test case ids)
            }
        }
    };
    walk(repoRoot, 0);
    return out;
}

/** A test case as a scenario for a feature file (steps already in Gherkin are kept as they are). */
export function scenarioFromTestCase(item: WorkItemDetail): string {
    // Parameters (@name in the steps) make it an outline: <name> in the steps, the values as Examples.
    const params = item.parameters?.names.length ? item.parameters : undefined;
    const lines = [`  @TestCaseId:${item.id}`, `  ${params ? 'Scenario Outline' : 'Scenario'}: ${item.automatedTestName || item.title}`];
    const p = (t: string) => (params ? t.replace(/@([A-Za-z_][\w-]*)/g, (m, n: string) => (params.names.includes(n) ? `<${n}>` : m)) : t);
    let first = true;
    let shared: number | undefined;
    for (const st0 of item.steps ?? []) {
        if (st0.shared?.id !== shared) { shared = st0.shared?.id; if (st0.shared) lines.push(`    # Shared steps #${st0.shared.id}${st0.shared.title ? `: ${st0.shared.title}` : ''}`); }
        const st = { ...st0, action: p(st0.action), expected: p(st0.expected) };
        for (const raw of st.action.split('\n').map((l) => l.trim()).filter(Boolean)) {
            const g = /^(Given|When|Then|And|But)\s/.test(raw);
            lines.push(`    ${g ? raw : `${first ? 'Given' : 'And'} ${raw}`}`);
            first = false;
        }
        if (st.expected && !/^The step completes without error/i.test(st.expected)) {
            for (const e of st.expected.split('\n').map((l) => l.trim()).filter(Boolean)) lines.push(`    ${/^(Then|And|But)\s/.test(e) ? e : `Then ${e}`}`);
        }
    }
    if (lines.length === 2) lines.push('    # This test case has no steps in Azure DevOps yet.');
    if (params) {
        const cell = (v: string) => v.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');
        lines.push('', `    Examples:${params.sharedSet ? ` # shared parameters #${params.sharedSet.id}${params.sharedSet.title ? `: ${params.sharedSet.title}` : ''}` : ''}`, `      | ${params.names.map(cell).join(' | ')} |`);
        for (const r of params.rows.length ? params.rows : [{}]) lines.push(`      | ${params.names.map((n) => cell(r[n] ?? '')).join(' | ')} |`);
    }
    return lines.join('\n') + '\n';
}

/** Branch name for an item: feature/1234-short-title (bug/… for bugs). */
export function branchNameFor(item: { id: number; title: string; type: string }): string {
    const slug = item.title.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
    const prefix = /bug/i.test(item.type) ? 'bugfix' : /test/i.test(item.type) ? 'test' : 'feature';
    return `${prefix}/${item.id}${slug ? '-' + slug : ''}`;
}
