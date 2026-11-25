/**
 * Azure DevOps pull requests for the Studio's review flow: what a test engineer needs when a pull
 * request arrives — what it changes, who reviews it, which checks block it, the discussion — and
 * the two write actions of a review: comment and vote. Both are only done when the user asks.
 *
 * Verified against a real organization (REST 7.1; lab repository studio-lab-tests, PR 1):
 *  - List: GET git/pullrequests?searchCriteria.status=&searchCriteria.reviewerId=|creatorId=
 *    → value[] with repository{id,name}, pullRequestId, title, createdBy, creationDate,
 *    sourceRefName, targetRefName, mergeStatus, isDraft, reviewers[{id,displayName,vote,isRequired}].
 *  - Detail: GET git/repositories/{repo}/pullrequests/{id} (+ lastMergeSourceCommit,
 *    lastMergeTargetCommit, lastMergeCommit).
 *  - Iterations: …/iterations → value[{id, sourceRefCommit, targetRefCommit, createdDate}].
 *  - Changes: …/iterations/{n}/changes → changeEntries[{changeType, item{path:"/a/b"}}].
 *  - Work items: …/workitems → value[{id:"1252"}] (ids as strings).
 *  - Threads: …/threads → value[{id, status, threadContext{filePath, rightFileStart{line}},
 *    comments[{author, content, commentType:"text"|"system"}]}]. POST to add (status 1 = active).
 *  - Votes: PUT …/reviewers/{reviewerId} {vote}: 10 approve, 5 approve with suggestions, 0 none,
 *    -5 wait for author, -10 reject.
 *  - Policies: GET policy/evaluations?artifactId=vstfs:///CodeReview/CodeReviewId/{projectId}/{id}
 *    (api 7.1-preview.1) → value[{status, configuration{type{displayName}, isBlocking}}].
 *  - Status checks posted by builds and tools: …/statuses.
 *  - The merge result is fetchable as refs/pull/{id}/merge (what will land when it completes).
 */
import { AdoClient } from './client';
import { UserError } from '../core/errors';

const CODE = 'Code (Read)';
const CODE_WRITE = 'Code (Read & write)';
const CODE_STATUS = 'Code (Status)';

export type PrScope = 'review' | 'mine' | 'all';
export interface PrPerson { id: string; name: string }
export interface PrReviewer extends PrPerson { vote: number; required: boolean; isMe?: boolean }
export interface PrSummary {
    id: number; title: string; repository: { id: string; name: string };
    source: string; target: string; author: PrPerson; created: string; isDraft: boolean;
    status: string; mergeStatus?: string; reviewers: PrReviewer[]; myVote?: number; url: string;
    /** Set to complete by itself once the required checks pass. */
    autoComplete?: boolean;
}
export interface PrChange { path: string; changeType: string; originalPath?: string }
export interface PrComment { author: string; content: string; date?: string; system: boolean }
export interface PrThread { id: number; status: string; file?: string; line?: number; comments: PrComment[] }
export interface PrPolicy { name: string; status: string; blocking: boolean; detail?: string; buildId?: number }
export interface PrStatus { name: string; state: string; description?: string; url?: string }
export interface PrDetail extends PrSummary {
    description: string;
    commits: { source?: string; target?: string; merge?: string };
    iterations: number;
    changes: PrChange[];
    workItems: number[];
    threads: PrThread[];
    policies: PrPolicy[];
    statuses: PrStatus[];
}

export const VOTE_LABEL: Record<string, string> = { '10': 'Approved', '5': 'Approved with suggestions', '0': 'No vote', '-5': 'Waiting for author', '-10': 'Rejected' };
const VOTES = [10, 5, 0, -5, -10];
const THREAD_STATUS: Record<string, string> = { '1': 'active', '2': 'fixed', '3': 'wontFix', '4': 'closed', '5': 'byDesign', '6': 'pending' };

const branch = (ref?: string) => (ref ?? '').replace(/^refs\/heads\//, '');
const repoSeg = (r: string) => {
    if (!r || r.length > 200 || /[\\/?#%]/.test(r)) throw new UserError('Invalid repository.');
    return encodeURIComponent(r);
};
const prId = (n: number) => { if (!Number.isInteger(n) || n <= 0) throw new UserError('Invalid pull request id.'); return n; };

interface RawPerson { id?: string; displayName?: string }
interface RawReviewer extends RawPerson { vote?: number; isRequired?: boolean }
interface RawPr {
    pullRequestId: number; title?: string; description?: string; status?: string; mergeStatus?: string; isDraft?: boolean;
    repository?: { id?: string; name?: string }; createdBy?: RawPerson; creationDate?: string;
    sourceRefName?: string; targetRefName?: string; reviewers?: RawReviewer[];
    lastMergeSourceCommit?: { commitId?: string }; lastMergeTargetCommit?: { commitId?: string }; lastMergeCommit?: { commitId?: string };
    autoCompleteSetBy?: { id?: string };
}

export type PrFinish = 'complete' | 'auto-complete' | 'cancel-auto-complete' | 'abandon' | 'reactivate';
export type MergeStrategy = 'squash' | 'noFastForward' | 'rebase' | 'rebaseMerge';

export class PullRequests {
    constructor(private readonly ado: AdoClient, private readonly me?: string) {}

    private webUrl(repo: string, id: number) {
        return `${this.ado.orgUrl}/${encodeURIComponent(this.ado.projectName)}/_git/${encodeURIComponent(repo)}/pullrequest/${id}`;
    }

    summary(p: RawPr): PrSummary {
        const reviewers = (p.reviewers ?? []).map((r) => ({ id: r.id ?? '', name: r.displayName ?? '', vote: r.vote ?? 0, required: !!r.isRequired, ...(r.id && r.id === this.me ? { isMe: true } : {}) }));
        const mine = reviewers.find((r) => r.isMe);
        const repo = p.repository?.name ?? '';
        return {
            id: p.pullRequestId, title: p.title ?? '', repository: { id: p.repository?.id ?? '', name: repo },
            source: branch(p.sourceRefName), target: branch(p.targetRefName),
            author: { id: p.createdBy?.id ?? '', name: p.createdBy?.displayName ?? '' }, created: p.creationDate ?? '',
            isDraft: !!p.isDraft, status: p.status ?? '', mergeStatus: p.mergeStatus, reviewers,
            ...(p.autoCompleteSetBy?.id && !/^[0-]+$/.test(p.autoCompleteSetBy.id) ? { autoComplete: true } : {}),
            ...(mine ? { myVote: mine.vote } : {}), url: this.webUrl(repo, p.pullRequestId),
        };
    }

    /** Active (or completed/abandoned) pull requests of the project: to review, mine, or all. */
    async list(o: { scope: PrScope; status?: 'active' | 'completed' | 'abandoned'; repository?: string; target?: string; top?: number; skip?: number }): Promise<PrSummary[]> {
        const q = new URLSearchParams({ 'searchCriteria.status': o.status ?? 'active', $top: String(Math.min(Math.max(o.top ?? 100, 1), 500)) });
        if (o.skip) q.set('$skip', String(Math.max(0, Math.floor(o.skip))));
        if (o.target) q.set('searchCriteria.targetRefName', o.target.startsWith('refs/') ? o.target : `refs/heads/${o.target}`);
        if (o.scope !== 'all' && !this.me) throw new UserError('Could not tell who you are in Azure DevOps.');
        if (o.scope === 'review') q.set('searchCriteria.reviewerId', this.me!);
        if (o.scope === 'mine') q.set('searchCriteria.creatorId', this.me!);
        // One repository: its own endpoint (searchCriteria.repositoryId wants the id, not the name).
        const url = o.repository ? `git/repositories/${repoSeg(o.repository)}/pullrequests?${q.toString()}` : `git/pullrequests?${q.toString()}`;
        const r = await this.ado.get<{ value: RawPr[] }>(url, 'project', CODE);
        return r.value.map((p) => this.summary(p));
    }

    /** The project's Git repositories (not disabled). */
    async repositories(): Promise<Array<{ id: string; name: string; defaultBranch?: string }>> {
        const r = await this.ado.get<{ value: Array<{ id: string; name: string; defaultBranch?: string; isDisabled?: boolean }> }>('git/repositories', 'project', CODE);
        return r.value.filter((x) => !x.isDisabled).map((x) => ({ id: x.id, name: x.name, ...(x.defaultBranch ? { defaultBranch: branch(x.defaultBranch) } : {}) })).sort((a, b) => a.name.localeCompare(b.name));
    }

    /** The project's repositories with their clone addresses. */
    async cloneable(): Promise<Array<{ name: string; url: string; defaultBranch?: string; size?: number }>> {
        const r = await this.ado.get<{ value: Array<{ name: string; remoteUrl: string; defaultBranch?: string; size?: number; isDisabled?: boolean }> }>('git/repositories', 'project', CODE);
        return r.value.filter((x) => !x.isDisabled && x.remoteUrl).map((x) => ({ name: x.name, url: x.remoteUrl.replace(/^https:\/\/[^@/]+@/, 'https://'), ...(x.defaultBranch ? { defaultBranch: branch(x.defaultBranch) } : {}), ...(x.size !== undefined ? { size: x.size } : {}) })).sort((a, b) => a.name.localeCompare(b.name));
    }

    /** What a pull request changes (latest iteration) and which work items it links — cheap, for lists. */
    async glance(repo: string, id: number): Promise<{ changes: PrChange[]; workItems: number[]; commit?: string }> {
        const base = `git/repositories/${repoSeg(repo)}/pullrequests/${prId(id)}`;
        const [iterations, workItems] = await Promise.all([
            this.ado.get<{ value: Array<{ id: number; sourceRefCommit?: { commitId?: string } }> }>(`${base}/iterations`, 'project', CODE).then((r) => r.value),
            this.ado.get<{ value: Array<{ id: string | number }> }>(`${base}/workitems`, 'project', CODE).then((r) => r.value.map((w) => Number(w.id)).filter((n) => n > 0)).catch(() => []),
        ]);
        const last = iterations.length ? iterations.reduce((a, b) => (b.id > a.id ? b : a)) : undefined;
        const changes = last ? await this.changes(repo, id, last.id).catch(() => []) : [];
        return { changes, workItems, ...(last?.sourceRefCommit?.commitId ? { commit: last.sourceRefCommit.commitId } : {}) };
    }

    /** Everything about one pull request a reviewer looks at. */
    async detail(repo: string, id: number, projectId?: string): Promise<PrDetail> {
        const base = `git/repositories/${repoSeg(repo)}/pullrequests/${prId(id)}`;
        const p = await this.ado.get<RawPr>(base, 'project', CODE);
        const [iterations, workItems, threads, statuses, policies] = await Promise.all([
            this.ado.get<{ value: Array<{ id: number }> }>(`${base}/iterations`, 'project', CODE).then((r) => r.value).catch(() => []),
            this.ado.get<{ value: Array<{ id: string | number }> }>(`${base}/workitems`, 'project', CODE).then((r) => r.value.map((w) => Number(w.id)).filter((n) => n > 0)).catch(() => []),
            this.threads(repo, id).catch(() => []),
            this.ado.get<{ value: Array<{ id?: number; context?: { name?: string; genre?: string }; state?: string; description?: string; targetUrl?: string }> }>(`${base}/statuses`, 'project', CODE)
                .then((r) => latestStatuses(r.value)).catch(() => []),
            projectId ? this.policies(projectId, id).catch(() => []) : Promise.resolve([]),
        ]);
        const last = iterations.length ? Math.max(...iterations.map((i) => i.id)) : 0;
        const changes = last ? await this.changes(repo, id, last).catch(() => []) : [];
        return {
            ...this.summary(p), description: p.description ?? '',
            commits: { source: p.lastMergeSourceCommit?.commitId, target: p.lastMergeTargetCommit?.commitId, merge: p.lastMergeCommit?.commitId },
            iterations: iterations.length, changes, workItems, threads, statuses, policies,
        };
    }

    /** Files changed by the pull request (latest iteration, compared with the target). */
    async changes(repo: string, id: number, iteration: number): Promise<PrChange[]> {
        const out: PrChange[] = [];
        for (let skip = 0; skip < 5000; skip += 1000) {
            const r = await this.ado.get<{ changeEntries?: Array<{ changeType?: string; item?: { path?: string | null; isFolder?: boolean }; originalPath?: string; sourceServerItem?: string }> }>(
                `git/repositories/${repoSeg(repo)}/pullrequests/${prId(id)}/iterations/${iteration}/changes?$top=1000&$skip=${skip}&$compareTo=0`, 'project', CODE);
            const entries = r.changeEntries ?? [];
            for (const c of entries) {
                if (c.item?.isFolder) continue;
                // A deleted file has no path any more (item.path null): its name is in originalPath.
                const from = c.originalPath ?? c.sourceServerItem;
                const at = c.item?.path ?? (/delete/i.test(c.changeType ?? '') ? from : undefined);
                if (!at) continue;
                out.push({ path: at.replace(/^\//, ''), changeType: c.changeType ?? 'edit', ...(from && from !== at ? { originalPath: from.replace(/^\//, '') } : {}) });
            }
            if (entries.length < 1000) break;
        }
        return out;
    }

    async threads(repo: string, id: number): Promise<PrThread[]> {
        const r = await this.ado.get<{ value: Array<{ id: number; status?: string | number; isDeleted?: boolean; threadContext?: { filePath?: string; rightFileStart?: { line?: number } } | null; comments?: Array<{ author?: RawPerson; content?: string; publishedDate?: string; commentType?: string; isDeleted?: boolean }> }> }>(
            `git/repositories/${repoSeg(repo)}/pullrequests/${prId(id)}/threads`, 'project', CODE);
        return r.value.filter((t) => !t.isDeleted).map((t) => ({
            id: t.id, status: typeof t.status === 'number' ? THREAD_STATUS[String(t.status)] ?? String(t.status) : t.status ?? '',
            ...(t.threadContext?.filePath ? { file: t.threadContext.filePath.replace(/^\//, ''), line: t.threadContext.rightFileStart?.line } : {}),
            comments: (t.comments ?? []).filter((c) => !c.isDeleted && c.content).map((c) => ({ author: c.author?.displayName ?? '', content: c.content ?? '', date: c.publishedDate, system: c.commentType === 'system' })),
        })).filter((t) => t.comments.length);
    }

    async policies(projectId: string, id: number): Promise<PrPolicy[]> {
        const r = await this.ado.get<{ value: Array<{ status?: string; configuration?: { isBlocking?: boolean; type?: { displayName?: string }; settings?: { displayName?: string } }; context?: { buildDefinitionName?: string; buildId?: number } }> }>(
            `policy/evaluations?artifactId=${encodeURIComponent(`vstfs:///CodeReview/CodeReviewId/${projectId}/${prId(id)}`)}&api-version=7.1-preview.1`, 'project', CODE);
        return r.value.map((e) => ({
            name: e.configuration?.settings?.displayName || e.context?.buildDefinitionName || e.configuration?.type?.displayName || 'Policy',
            status: e.status ?? '', blocking: !!e.configuration?.isBlocking,
            ...(e.context?.buildDefinitionName ? { detail: `Build: ${e.context.buildDefinitionName}` } : {}),
            ...(typeof e.context?.buildId === 'number' ? { buildId: e.context.buildId } : {}),
        }));
    }

    /** WRITE: a new comment (optionally on a line of a file). */
    /** `closed`: information that needs no answer (test results), so it never blocks completion. */
    async comment(repo: string, id: number, text: string, at?: { file: string; line: number }, closed = false): Promise<number> {
        if (!text.trim() || text.length > 150_000) throw new UserError('The comment is empty or too long.');
        const body: Record<string, unknown> = { comments: [{ parentCommentId: 0, content: text, commentType: 1 }], status: closed ? 4 : 1 };
        if (at) body.threadContext = { filePath: '/' + at.file.replace(/^\//, ''), rightFileStart: { line: at.line, offset: 1 }, rightFileEnd: { line: at.line, offset: 1 } };
        const r = await this.ado.post<{ id: number }>(`git/repositories/${repoSeg(repo)}/pullrequests/${prId(id)}/threads`, body, 'project', CODE_WRITE);
        return r.id;
    }

    /** WRITE: a reply in a thread. */
    async reply(repo: string, id: number, thread: number, text: string): Promise<void> {
        if (!text.trim() || text.length > 150_000) throw new UserError('The reply is empty or too long.');
        if (!Number.isInteger(thread) || thread <= 0) throw new UserError('Invalid thread.');
        await this.ado.post(`git/repositories/${repoSeg(repo)}/pullrequests/${prId(id)}/threads/${thread}/comments`, { parentCommentId: 1, content: text, commentType: 1 }, 'project', CODE_WRITE);
    }

    /** WRITE: resolve or reopen a thread. */
    async setThread(repo: string, id: number, thread: number, status: 'active' | 'fixed' | 'closed'): Promise<void> {
        const code = { active: 1, fixed: 2, closed: 4 }[status];
        if (!code || !Number.isInteger(thread) || thread <= 0) throw new UserError('Invalid thread.');
        await this.ado.patch(`git/repositories/${repoSeg(repo)}/pullrequests/${prId(id)}/threads/${thread}`, { status: code }, 'project', CODE_WRITE);
    }

    /** WRITE: my vote (adds me as a reviewer if I am not one yet). */
    /**
     * A status check on the pull request (shown with the builds' checks; a branch policy can require it).
     * Its name is genre/name: cs-test-studio/tests unless told otherwise. A later status of the same name replaces it.
     */
    async postStatus(repo: string, id: number, s: { state: 'succeeded' | 'failed' | 'error' | 'pending'; description: string; name?: string; targetUrl?: string }): Promise<{ id?: number }> {
        const body = {
            state: s.state, description: s.description.slice(0, 400),
            context: { genre: 'cs-test-studio', name: s.name ?? 'tests' },
            ...(s.targetUrl && /^https:\/\//i.test(s.targetUrl) ? { targetUrl: s.targetUrl } : {}),
        };
        return this.ado.post<{ id?: number }>(`git/repositories/${repoSeg(repo)}/pullrequests/${prId(id)}/statuses`, body, 'project', CODE_STATUS);
    }

    /** Open a pull request (the source branch must be pushed). */
    async create(repo: string, o: { source: string; target: string; title: string; description: string; draft?: boolean; reviewers?: Array<{ id: string; required?: boolean }>; workItems?: number[] }): Promise<{ id: number; url: string }> {
        const ref = (b: string) => (b.startsWith('refs/') ? b : `refs/heads/${b}`);
        const r = await this.ado.post<{ pullRequestId: number; repository?: { webUrl?: string } }>(`git/repositories/${repoSeg(repo)}/pullrequests?supportsIterations=true`, {
            sourceRefName: ref(o.source), targetRefName: ref(o.target), title: o.title.slice(0, 400), description: o.description.slice(0, 4000), isDraft: !!o.draft,
            reviewers: (o.reviewers ?? []).slice(0, 50).map((x) => ({ id: x.id, ...(x.required ? { isRequired: true } : {}) })),
            workItemRefs: (o.workItems ?? []).filter((n) => Number.isInteger(n) && n > 0).slice(0, 50).map((id) => ({ id: String(id) })),
        }, 'project', CODE_WRITE);
        return { id: r.pullRequestId, url: `${r.repository?.webUrl ?? `${this.ado.orgUrl}/${encodeURIComponent(this.ado.projectName)}/_git/${encodeURIComponent(repo)}`}/pullrequest/${r.pullRequestId}` };
    }

    /** People to ask for a review: the members of the project's teams (name, id, team). */
    async reviewerCandidates(): Promise<Array<{ id: string; name: string; email?: string; team: string }>> {
        const p = encodeURIComponent(this.ado.projectName);
        const teams = (await this.ado.get<{ value: Array<{ id: string; name: string }> }>(`projects/${p}/teams?$top=50`, 'org', 'Project and Team (Read)')).value;
        const out = new Map<string, { id: string; name: string; email?: string; team: string }>();
        for (const t of teams.slice(0, 20)) {
            const m = await this.ado.get<{ value: Array<{ identity: { id: string; displayName: string; uniqueName?: string; isContainer?: boolean } }> }>(`projects/${p}/teams/${encodeURIComponent(t.id)}/members?$top=200`, 'org', 'Project and Team (Read)').catch(() => ({ value: [] }));
            for (const x of m.value) if (!x.identity.isContainer && !out.has(x.identity.id)) out.set(x.identity.id, { id: x.identity.id, name: x.identity.displayName, ...(x.identity.uniqueName ? { email: x.identity.uniqueName } : {}), team: t.name });
        }
        return [...out.values()].filter((x) => x.id !== this.me).sort((a, b) => a.name.localeCompare(b.name));
    }

    /**
     * Complete (merge), set to complete automatically when the policies pass, cancel that, abandon, or reactivate.
     * Completing names the source commit last seen, so a push made in between is not merged unseen.
     */
    async finish(repo: string, id: number, action: PrFinish, o: { strategy?: MergeStrategy; deleteSourceBranch?: boolean; transitionWorkItems?: boolean; message?: string; expectedCommit?: string } = {}): Promise<{ status: string; autoComplete: boolean }> {
        const base = `git/repositories/${repoSeg(repo)}/pullrequests/${prId(id)}`;
        const now = await this.ado.get<RawPr & { autoCompleteSetBy?: { id?: string } }>(base, 'project', CODE);
        const head = now.lastMergeSourceCommit?.commitId;
        if (o.expectedCommit && head && o.expectedCommit !== head) throw new UserError('New commits were pushed to the pull request since you opened it: look at them first.');
        const completion = { mergeStrategy: o.strategy ?? 'squash', deleteSourceBranch: o.deleteSourceBranch !== false, transitionWorkItems: o.transitionWorkItems !== false,
            ...(o.message ? { mergeCommitMessage: o.message.slice(0, 4000) } : {}) };
        let patch: Record<string, unknown>;
        if (action === 'complete') {
            if (now.status !== 'active') throw new UserError(`The pull request is ${now.status}.`);
            if (now.isDraft) throw new UserError('A draft cannot be completed: publish it first.');
            patch = { status: 'completed', lastMergeSourceCommit: { commitId: head }, completionOptions: completion };
        } else if (action === 'auto-complete') {
            if (!this.me) throw new UserError('Could not tell who you are in Azure DevOps.');
            patch = { autoCompleteSetBy: { id: this.me }, completionOptions: completion };
        } else if (action === 'cancel-auto-complete') patch = { autoCompleteSetBy: { id: '00000000-0000-0000-0000-000000000000' } };
        else if (action === 'abandon') patch = { status: 'abandoned' };
        else if (action === 'reactivate') patch = { status: 'active' };
        else throw new UserError('Unknown action.');
        const r = await this.ado.patch<RawPr & { autoCompleteSetBy?: { id?: string } }>(base, patch, 'project', CODE_WRITE);
        return { status: String(r?.status ?? patch.status ?? now.status), autoComplete: !!r?.autoCompleteSetBy?.id && r.autoCompleteSetBy.id !== '00000000-0000-0000-0000-000000000000' };
    }

    async vote(repo: string, id: number, vote: number): Promise<void> {
        if (!VOTES.includes(vote)) throw new UserError('Invalid vote.');
        if (!this.me) throw new UserError('Could not tell who you are in Azure DevOps.');
        // Azure DevOps replaces the whole reviewer entry: send "required" as it is now, or a
        // required reviewer would silently become optional by voting (verified on a real PR).
        const base = `git/repositories/${repoSeg(repo)}/pullrequests/${prId(id)}`;
        const now = await this.ado.get<RawPr>(base, 'project', CODE);
        const mine = (now.reviewers ?? []).find((r) => r.id === this.me);
        await this.ado.put(`${base}/reviewers/${encodeURIComponent(this.me)}`, { vote, ...(mine?.isRequired ? { isRequired: true } : {}) }, 'project', CODE_WRITE);
    }
}

/**
 * A pull request keeps every update of a status check (queued, pending, then the result): only the
 * latest of each check counts; a check without a state yet is not shown.
 */
export function latestStatuses(all: Array<{ id?: number; context?: { name?: string; genre?: string }; state?: string; description?: string; targetUrl?: string }>): PrStatus[] {
    const latest = new Map<string, (typeof all)[number]>();
    for (const s of all) {
        const key = [s.context?.genre, s.context?.name].filter(Boolean).join('/');
        const cur = latest.get(key);
        if (!cur || (s.id ?? 0) >= (cur.id ?? 0)) latest.set(key, s);
    }
    return [...latest].filter(([, s]) => s.state).map(([name, s]) => ({ name, state: s.state!, description: s.description, url: s.targetUrl }));
}

/**
 * Whether a local clone (its remote URLs) is the pull request's repository. Matches
 * https://dev.azure.com/{org}/{project}/_git/{repo}, {org}.visualstudio.com/…/_git/{repo},
 * on-premises …/_git/{repo} and SSH v3/{org}/{project}/{repo}, ignoring case and a trailing .git.
 */
export function remoteForRepository(remotes: Array<{ name: string; url: string }>, repoName: string): string | null {
    const want = repoName.toLowerCase();
    for (const r of remotes) {
        const u = r.url.trim().replace(/\.git$/i, '').replace(/\/+$/, '');
        let name = '';
        const git = /\/_git\/([^/?#]+)$/i.exec(u);
        const ssh = /(?:^|[:/])v3\/[^/]+\/[^/]+\/([^/?#]+)$/i.exec(u);
        if (git) name = decodeURIComponent(git[1]);
        else if (ssh) name = decodeURIComponent(ssh[1]);
        if (name.toLowerCase() === want) return r.name;
    }
    return null;
}

/** Work item ids a branch name and commit messages mention: feature/1234-…, #1234, AB#1234. */
export function workItemIdsFrom(branchName: string, messages: string[]): number[] {
    const ids = new Set<number>();
    const b = /^(?:[\w-]+\/)?(\d{1,8})(?:[-_]|$)/.exec(branchName);
    if (b) ids.add(Number(b[1]));
    for (const m of messages) for (const x of m.matchAll(/(?:^|[\s(\[])(?:AB)?#(\d{1,8})\b/g)) ids.add(Number(x[1]));
    return [...ids].filter((n) => n > 0).slice(0, 50);
}

/** A pull request drafted from a branch and its commits (not in the target): title, description, work items. */
export function prDraft(branchName: string, commits: Array<{ subject: string; body?: string }>): { title: string; description: string; workItems: number[] } {
    const words = branchName.replace(/^[\w-]+\//, '').replace(/^\d+[-_]?/, '').replace(/[-_]+/g, ' ').trim();
    const title = commits.length === 1 ? commits[0].subject : words ? words.charAt(0).toUpperCase() + words.slice(1) : commits[0]?.subject ?? branchName;
    const workItems = workItemIdsFrom(branchName, commits.flatMap((c) => [c.subject, c.body ?? '']));
    const description = [
        commits.length ? `## Changes\n${commits.slice(0, 30).map((c) => `- ${c.subject}`).join('\n')}${commits.length > 30 ? `\n- … and ${commits.length - 30} more` : ''}` : '',
        workItems.length ? `## Work items\n${workItems.map((id) => `- #${id}`).join('\n')}` : '',
    ].filter(Boolean).join('\n\n');
    return { title: title.slice(0, 200), description, workItems };
}
