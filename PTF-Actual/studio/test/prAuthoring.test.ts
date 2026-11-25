/**
 * Opening a pull request from the Studio: drafted from the branch and its commits (title, description, work items
 * named in the branch or the messages), the repository matched by its remote, reviewers from the project's teams;
 * refused until the branch is pushed; created in Azure DevOps with the chosen reviewers, work items and draft flag.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { prDraft, workItemIdsFrom } from '../src/ado/pullRequests';
import { runGit } from '../src/git/run';
import { SecretStore } from '../src/secrets/store';
import { KeyFileProtector } from '../src/secrets/protector';

test('the draft: work items from the branch and messages; title; description', () => {
    assert.deepEqual(workItemIdsFrom('feature/1234-checkout-fees', ['Fix rounding (AB#77)', 'Refs #88 and #1234', 'no id here']), [1234, 77, 88]);
    assert.deepEqual(workItemIdsFrom('main', ['v1.2#3']), []);
    const d = prDraft('feature/1234-checkout-fees', [{ subject: 'Add fee tests' }, { subject: 'Fix rounding', body: 'AB#77' }]);
    assert.equal(d.title, 'Checkout fees');
    assert.equal(d.description, '## Changes\n- Add fee tests\n- Fix rounding\n\n## Work items\n- #1234\n- #77');
    assert.equal(prDraft('bugfix/fix-login', [{ subject: 'Login keeps the return URL' }]).title, 'Login keeps the return URL');
});

test('through the server: drafted, refused until pushed, then created with reviewers and work items', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-'));
    const dir = path.join(tmp, 'repo'), remote = path.join(tmp, 'acme', '_git', 'shop');
    const g = (args: string[], cwd = dir) => runGit(args, { cwd });
    await runGit(['init', '-q', '--bare', '-b', 'main', remote], { cwd: tmp });
    await runGit(['init', '-q', '-b', 'main', dir], { cwd: tmp });
    await g(['config', 'user.name', 'T']); await g(['config', 'user.email', 't@x.invalid']);
    fs.mkdirSync(path.join(dir, 'config/shop/environments'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config/global.env'), 'BASE_URL=http://localhost\nADO_ORGANIZATION=acme\nADO_PROJECT=qa\n');
    fs.writeFileSync(path.join(dir, 'config/shop/environments/qa.env'), 'ENVIRONMENT=qa\n');
    await g(['add', '.']); await g(['commit', '-qm', 'Start']);
    await g(['remote', 'add', 'origin', remote]); await g(['push', '-q', 'origin', 'main']);
    await g(['checkout', '-qb', 'feature/321-fee-rules']);
    fs.writeFileSync(path.join(dir, 'fees.txt'), 'x'); await g(['add', '.']); await g(['commit', '-qm', 'Add fee rules (AB#55)']);
    const store = new SecretStore(path.join(tmp, 'home'), new KeyFileProtector(path.join(tmp, 'home', 'keys', 'secrets.key')));
    store.set({ name: 'ADO_PAT' }, 'pat-1');
    const created: unknown[] = [];
    const REVIEWER = '11111111-2222-3333-4444-555555555555';
    const transport = async (req: { url: string; method: string; body?: string }) => {
        const u = new URL(req.url);
        const json = (b: unknown) => ({ status: 200, body: JSON.stringify(b) });
        if (/connectionData$/.test(u.pathname)) return json({ authenticatedUser: { id: '99999999-2222-3333-4444-555555555555' } });
        if (/git\/repositories$/.test(u.pathname)) return json({ value: [{ id: 'r1', name: 'Shop', defaultBranch: 'refs/heads/main' }, { id: 'r2', name: 'Other' }] });
        if (/projects\/qa\/teams$/.test(u.pathname)) return json({ value: [{ id: 't1', name: 'QA team' }] });
        if (/teams\/t1\/members$/.test(u.pathname)) return json({ value: [{ identity: { id: REVIEWER, displayName: 'Ann Reviewer', uniqueName: 'ann@lab.test' } }, { identity: { id: 'g', displayName: '[qa]\\Group', isContainer: true } }] });
        if (req.method === 'POST' && /git\/repositories\/Shop\/pullrequests$/.test(u.pathname)) { created.push(JSON.parse(req.body ?? '{}')); return json({ pullRequestId: 812, repository: { webUrl: 'https://dev.azure.com/acme/qa/_git/Shop' } }); }
        return { status: 404, body: '' };
    };
    const { createServer } = await import('../src/server/server');
    const s = createServer({ repoRoot: dir, store, userName: 'T', adoTransport: transport, token: 'tk' });
    const call = async (method: 'GET' | 'POST', url: string, payload?: object) => { const r = await s.app.inject({ method, url, headers: { authorization: 'Bearer tk' }, ...(payload ? { payload } : {}) }); return { status: r.statusCode, json: JSON.parse(r.body) }; };
    try {
        let d = await call('GET', '/api/ado/prs/new?project=shop&env=qa');
        assert.equal(d.status, 200, JSON.stringify(d.json));
        assert.deepEqual([d.json.branch, d.json.repository, d.json.target, d.json.title, d.json.workItems, d.json.pushed], ['feature/321-fee-rules', 'Shop', 'main', 'Add fee rules (AB#55)', [321, 55], false]);
        assert.match(d.json.problem, /not on the server yet: push it first/);
        assert.deepEqual(d.json.reviewers.map((r: { name: string }) => r.name), ['Ann Reviewer'], 'people only, not groups');
        const body = { project: 'shop', env: 'qa', repository: 'Shop', target: 'main', title: 'Fee rules', description: 'x', draft: true, reviewers: [{ id: REVIEWER, required: true }, { id: 'not-a-guid' }], workItems: [321, 55], confirm: true };
        assert.match((await call('POST', '/api/ado/prs', body)).json.error, /Push the branch first/);
        await g(['push', '-q', '-u', 'origin', 'feature/321-fee-rules']);
        d = await call('GET', '/api/ado/prs/new?project=shop&env=qa');
        assert.deepEqual([d.json.pushed, d.json.problem], [true, undefined]);
        const r = await call('POST', '/api/ado/prs', body);
        assert.equal(r.status, 200, JSON.stringify(r.json));
        assert.deepEqual(r.json, { id: 812, url: 'https://dev.azure.com/acme/qa/_git/Shop/pullrequest/812' });
        assert.deepEqual(created[0], { sourceRefName: 'refs/heads/feature/321-fee-rules', targetRefName: 'refs/heads/main', title: 'Fee rules', description: 'x', isDraft: true,
            reviewers: [{ id: REVIEWER, isRequired: true }], workItemRefs: [{ id: '321' }, { id: '55' }] });
        await g(['checkout', '-q', 'main']);
        assert.match((await call('GET', '/api/ado/prs/new?project=shop&env=qa')).json.problem, /on main itself/);
    } finally { await s.app.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
});
