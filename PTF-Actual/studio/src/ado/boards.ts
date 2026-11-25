/**
 * Azure Boards for an organization of any size: the filters people use on their boards (team,
 * sprint, area, type, state, assigned to, tags, text, recently changed), run as one WIQL query in
 * Azure DevOps, with only the page on screen fetched.
 *
 * Verified against a real organization (REST 7.1):
 *  - Teams: GET _apis/projects/{p}/teams?$top&$skip.
 *  - A team's sprints: GET {p}/{team}/_apis/work/teamsettings/iterations — name, path
 *    ("proj\Sprint 5", the form System.IterationPath uses), startDate/finishDate, timeFrame
 *    past/current/future.
 *  - A team's areas: GET {p}/{team}/_apis/work/teamsettings/teamfieldvalues — values with
 *    includeChildren (what the team's board shows).
 *  - All areas: GET {p}/_apis/wit/classificationnodes/areas?$depth — paths like "\proj\Area\X",
 *    which System.AreaPath writes as "proj\X".
 *  - Types: GET {p}/_apis/wit/workitemtypes — states with their category (Proposed, InProgress,
 *    Resolved, Completed, Removed); hidden types from workitemtypecategories (Microsoft.HiddenCategory).
 *  - WIQL: POST {p}/_apis/wit/wiql?$top=N returns ids only (at most 20000); fields for at most 200
 *    ids per GET wit/workitems.
 */
import { AdoClient } from './client';
import { UserError } from '../core/errors';
import { LIST_FIELDS, summary, wiqlString, WorkItemSummary } from './workItems';

export interface Sprint { name: string; path: string; start?: string; finish?: string; timeFrame?: 'past' | 'current' | 'future' }
export interface ItemType { name: string; states: Array<{ name: string; category: string; color?: string }> }
export interface BoardsMeta { teams: string[]; types: ItemType[]; defaultTeam?: string }
export interface TeamMeta { team: string; sprints: Sprint[]; current?: Sprint; areas: Array<{ path: string; children: boolean }> }

export interface ItemFilter {
    team?: string;
    /** 'current' (the team's), 'any', or a sprint path. Default: any. */
    sprint?: string;
    /** Area paths ("proj\X", with sub-areas). Empty: the team's areas when a team is chosen, else all. */
    areas?: string[];
    types?: string[];
    /** Exact states; empty: by `open`. */
    states?: string[];
    /** Only items not done (state category other than Completed / Removed). Default true. */
    open?: boolean;
    /** 'me', 'unassigned', 'any' (default) or a display name. */
    assigned?: string;
    tags?: string[];
    /** An id, or words in the title. */
    text?: string;
    /** Changed in the last N days. */
    changedDays?: number;
    order?: 'changed' | 'priority' | 'id';
}

/** Most ids a query looks at (the WIQL limit is 20000). */
export const QUERY_CAP = 5000;
const DONE = new Set(['Completed', 'Removed']);

/** "\proj\Area\X\Y" (classification node) → "proj\X\Y" (System.AreaPath). */
export function nodeToPath(nodePath: string): string {
    const parts = nodePath.split('\\').filter(Boolean);
    return [parts[0], ...parts.slice(2)].join('\\');
}

/** The WHERE clause for a filter (exported for tests). */
export function buildWhere(f: ItemFilter, ctx: { teamAreas?: TeamMeta['areas']; currentSprint?: string; types: ItemType[] }): string {
    const and: string[] = [];
    const areaClause = (a: { path: string; children: boolean }) => `[System.AreaPath] ${a.children ? 'UNDER' : '='} ${wiqlString(a.path)}`;
    const areas = f.areas?.length ? f.areas.map((p) => ({ path: p, children: true })) : f.team ? ctx.teamAreas ?? [] : [];
    if (areas.length) and.push(areas.length === 1 ? areaClause(areas[0]) : `(${areas.map(areaClause).join(' OR ')})`);
    if (f.sprint && f.sprint !== 'any') {
        const path = f.sprint === 'current' ? ctx.currentSprint : f.sprint;
        if (!path) throw new UserError(f.team ? `${f.team} has no current sprint.` : 'Choose a team to use its current sprint.');
        and.push(`[System.IterationPath] = ${wiqlString(path)}`);
    }
    const visible = ctx.types.map((t) => t.name);
    const types = f.types?.length ? f.types : visible;
    if (types.length) and.push(`[System.WorkItemType] IN (${types.map(wiqlString).join(', ')})`);
    if (f.states?.length) and.push(`[System.State] IN (${f.states.map(wiqlString).join(', ')})`);
    else if (f.open !== false) {
        // "Open" per type: a state can be done for one type and not another, so state by type.
        const per = ctx.types.filter((t) => types.includes(t.name)).map((t) => ({ t: t.name, open: t.states.filter((s) => !DONE.has(s.category)).map((s) => s.name) })).filter((x) => x.open.length);
        if (per.length) and.push(`(${per.map((x) => `([System.WorkItemType] = ${wiqlString(x.t)} AND [System.State] IN (${x.open.map(wiqlString).join(', ')}))`).join(' OR ')})`);
    }
    const who = (f.assigned ?? 'any').trim();
    if (who === 'me') and.push('[System.AssignedTo] = @Me');
    else if (who === 'unassigned') and.push(`[System.AssignedTo] = ''`);
    else if (who && who !== 'any') and.push(`[System.AssignedTo] = ${wiqlString(who)}`);
    for (const t of f.tags ?? []) if (t.trim()) and.push(`[System.Tags] CONTAINS ${wiqlString(t.trim())}`);
    const text = (f.text ?? '').trim();
    if (/^#?\d{1,9}$/.test(text)) and.push(`[System.Id] = ${Number(text.replace('#', ''))}`);
    else if (text) and.push(`[System.Title] CONTAINS ${wiqlString(text.slice(0, 200))}`);
    if (f.changedDays && f.changedDays > 0) and.push(`[System.ChangedDate] >= @Today - ${Math.min(Math.floor(f.changedDays), 3650)}`);
    return and.join(' AND ');
}

const ORDER: Record<NonNullable<ItemFilter['order']>, string> = {
    changed: '[System.ChangedDate] DESC',
    priority: '[Microsoft.VSTS.Common.Priority] ASC, [System.ChangedDate] DESC',
    id: '[System.Id] DESC',
};

export class Boards {
    private types?: Promise<ItemType[]>;
    constructor(private readonly ado: AdoClient) {}
    private get webBase(): string { return `${this.ado.orgUrl}/${encodeURIComponent(this.ado.projectName)}`; }

    async teams(): Promise<string[]> {
        const out: string[] = [];
        for (let skip = 0; skip < 5000; skip += 500) {
            const r = await this.ado.get<{ value: Array<{ name: string }> }>(`projects/${encodeURIComponent(this.ado.projectName)}/teams?$top=500&$skip=${skip}`, 'org', 'Project and Team (Read)');
            out.push(...r.value.map((t) => t.name));
            if (r.value.length < 500) break;
        }
        return out.sort((a, b) => a.localeCompare(b));
    }

    /** Work item types people use (hidden ones such as Test Plan, Shared Steps left out), with states. */
    itemTypes(): Promise<ItemType[]> {
        this.types ??= (async () => {
            const [types, cats] = await Promise.all([
                this.ado.get<{ value: Array<{ name: string; isDisabled?: boolean; states?: Array<{ name: string; category?: string; color?: string }> }> }>('wit/workitemtypes'),
                this.ado.get<{ value: Array<{ referenceName: string; workItemTypes: Array<{ name: string }> }> }>('wit/workitemtypecategories').catch(() => ({ value: [] })),
            ]);
            const hidden = new Set(cats.value.filter((c) => c.referenceName === 'Microsoft.HiddenCategory').flatMap((c) => c.workItemTypes.map((t) => t.name)));
            return types.value.filter((t) => !t.isDisabled && !hidden.has(t.name))
                .map((t) => ({ name: t.name, states: (t.states ?? []).map((s) => ({ name: s.name, category: s.category ?? '', color: s.color })) }))
                .sort((a, b) => a.name.localeCompare(b.name));
        })();
        this.types.catch(() => { this.types = undefined; });
        return this.types;
    }

    async meta(): Promise<BoardsMeta> {
        const [teams, types] = await Promise.all([this.teams(), this.itemTypes()]);
        const def = teams.find((t) => t === `${this.ado.projectName} Team`);
        return { teams, types, ...(def ? { defaultTeam: def } : {}) };
    }

    async team(team: string): Promise<TeamMeta> {
        if (!team.trim()) throw new UserError('Choose a team.');
        const [its, tfv] = await Promise.all([
            this.ado.get<{ value: Array<{ name: string; path: string; attributes?: { startDate?: string | null; finishDate?: string | null; timeFrame?: string } }> }>('work/teamsettings/iterations', { team }, 'Work Items (Read)'),
            this.ado.get<{ field?: { referenceName?: string }; values?: Array<{ value: string; includeChildren?: boolean }> }>('work/teamsettings/teamfieldvalues', { team }, 'Work Items (Read)').catch(() => ({ values: [] as Array<{ value: string; includeChildren?: boolean }> })),
        ]);
        const sprints: Sprint[] = its.value.map((i) => ({
            name: i.name, path: i.path,
            ...(i.attributes?.startDate ? { start: i.attributes.startDate } : {}), ...(i.attributes?.finishDate ? { finish: i.attributes.finishDate } : {}),
            ...(i.attributes?.timeFrame === 'past' || i.attributes?.timeFrame === 'current' || i.attributes?.timeFrame === 'future' ? { timeFrame: i.attributes.timeFrame } : {}),
        }));
        // Newest first: current, then future, then past (how people look for a sprint).
        const rank = (s: Sprint) => (s.timeFrame === 'current' ? 0 : s.timeFrame === 'future' ? 1 : 2);
        sprints.sort((a, b) => rank(a) - rank(b) || (rank(a) === 1 ? (a.start ?? '').localeCompare(b.start ?? '') : (b.start ?? '').localeCompare(a.start ?? '')) || a.name.localeCompare(b.name));
        return { team, sprints, current: sprints.find((s) => s.timeFrame === 'current'), areas: (tfv.values ?? []).map((v) => ({ path: v.value, children: !!v.includeChildren })) };
    }

    /** Every area path of the project (for choosing areas without a team). */
    async areas(): Promise<string[]> {
        interface Node { path: string; children?: Node[] }
        const root = await this.ado.get<Node>('wit/classificationnodes/areas?$depth=8');
        const out: string[] = [];
        const walk = (n: Node) => { out.push(nodeToPath(n.path)); for (const c of n.children ?? []) walk(c); };
        walk(root);
        return out;
    }

    /** One page of the items matching a filter, and how many match in total. */
    async query(f: ItemFilter, page: { skip?: number; take?: number } = {}): Promise<{ total: number; capped: boolean; items: WorkItemSummary[]; sprint?: Sprint; doneMatches?: number; wiql: string }> {
        const types = await this.itemTypes();
        let tm: TeamMeta | undefined;
        if (f.team) tm = await this.team(f.team);
        const where = buildWhere(f, { teamAreas: tm?.areas, currentSprint: tm?.current?.path, types });
        const wiql = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project${where ? ` AND ${where}` : ''} ORDER BY ${ORDER[f.order ?? 'changed']}`;
        const r = await this.ado.post<{ workItems: Array<{ id: number }> }>(`wit/wiql?$top=${QUERY_CAP}`, { query: wiql });
        const ids = r.workItems.map((w) => w.id);
        const skip = Math.max(0, Math.floor(page.skip ?? 0)), take = Math.min(Math.max(1, Math.floor(page.take ?? 100)), 200);
        const want = ids.slice(skip, skip + take);
        const items: WorkItemSummary[] = [];
        if (want.length) {
            const got = await this.ado.get<{ value: Array<{ id: number; fields: Record<string, unknown> } | null> }>(`wit/workitems?ids=${want.join(',')}&fields=${LIST_FIELDS.join(',')}&errorPolicy=omit`);
            const byId = new Map(got.value.filter((w): w is { id: number; fields: Record<string, unknown> } => !!w).map((w) => [w.id, w]));
            for (const id of want) { const w = byId.get(id); if (w) items.push(summary(w, this.webBase)); }
        }
        // Nothing open matches: say whether done items would (people often look for a closed one).
        let doneMatches: number | undefined;
        if (!ids.length && f.open !== false && !f.states?.length) {
            const all = buildWhere({ ...f, open: false }, { teamAreas: tm?.areas, currentSprint: tm?.current?.path, types });
            const r2 = await this.ado.post<{ workItems: Array<{ id: number }> }>(`wit/wiql?$top=${QUERY_CAP}`, { query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project${all ? ` AND ${all}` : ''}` });
            doneMatches = r2.workItems.length;
        }
        const sprint = f.sprint === 'current' ? tm?.current : f.sprint && f.sprint !== 'any' ? tm?.sprints.find((s) => s.path === f.sprint) : undefined;
        return { total: ids.length, capped: ids.length >= QUERY_CAP, items, ...(sprint ? { sprint } : {}), ...(doneMatches ? { doneMatches } : {}), wiql };
    }
}
