import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { AdoClient } from '../src/ado/client';
import { PullRequests } from '../src/ado/pullRequests';

function fakeAdo(pr: Record<string, unknown>) {
    const calls: Array<{ m: string; p: string; b?: unknown }> = [];
    const ado = {
        orgUrl: 'https://dev.azure.com/org', projectName: 'Proj',
        async get(p: string) { calls.push({ m: 'GET', p }); return pr; },
        async patch(p: string, b: Record<string, unknown>) { calls.push({ m: 'PATCH', p, b }); return { ...pr, ...b, ...(b.autoCompleteSetBy && /^[0-]+$/.test(String((b.autoCompleteSetBy as { id: string }).id)) ? { autoCompleteSetBy: undefined } : {}) }; },
    };
    return { calls, prs: new PullRequests(ado as unknown as AdoClient, 'me-1') };
}

test('finish: complete merges only the reviewed commit, with the chosen options; drafts and closed ones refused', async () => {
    const { calls, prs } = fakeAdo({ pullRequestId: 7, status: 'active', lastMergeSourceCommit: { commitId: 'abc' } });
    const r = await prs.finish('shop', 7, 'complete', { strategy: 'rebase', deleteSourceBranch: false, message: 'Merged PR 7', expectedCommit: 'abc' });
    assert.equal(r.status, 'completed');
    const p = calls.find((c) => c.m === 'PATCH')!;
    assert.match(p.p, /git\/repositories\/shop\/pullrequests\/7$/);
    assert.deepEqual(p.b, { status: 'completed', lastMergeSourceCommit: { commitId: 'abc' }, completionOptions: { mergeStrategy: 'rebase', deleteSourceBranch: false, transitionWorkItems: true, mergeCommitMessage: 'Merged PR 7' } });
    await assert.rejects(prs.finish('shop', 7, 'complete', { expectedCommit: 'old' }), /New commits were pushed/);
    await assert.rejects(fakeAdo({ status: 'active', isDraft: true }).prs.finish('shop', 7, 'complete'), /draft/);
    await assert.rejects(fakeAdo({ status: 'abandoned' }).prs.finish('shop', 7, 'complete'), /is abandoned/);
});

test('finish: auto-complete set by me and cancelled; abandon and reactivate', async () => {
    const { calls, prs } = fakeAdo({ status: 'active', lastMergeSourceCommit: { commitId: 'abc' } });
    assert.deepEqual(await prs.finish('shop', 7, 'auto-complete'), { status: 'active', autoComplete: true });
    assert.deepEqual((calls.at(-1)!.b as Record<string, unknown>).autoCompleteSetBy, { id: 'me-1' });
    assert.deepEqual(await prs.finish('shop', 7, 'cancel-auto-complete'), { status: 'active', autoComplete: false });
    assert.equal((await prs.finish('shop', 7, 'abandon')).status, 'abandoned');
    assert.deepEqual(calls.at(-1)!.b, { status: 'abandoned' });
    assert.equal((await prs.finish('shop', 7, 'reactivate')).status, 'active');
    await assert.rejects(prs.finish('shop', 7, 'merge' as never), /Unknown action/);
    await assert.rejects(new PullRequests({ get: async () => ({ status: 'active' }) } as unknown as AdoClient).finish('shop', 7, 'auto-complete'), /who you are/);
});
