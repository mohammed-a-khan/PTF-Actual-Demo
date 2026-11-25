import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { AdoClient, AdoRequest, AdoResponse } from '../src/ado/client';
import { latestStatuses, PullRequests, remoteForRepository } from '../src/ado/pullRequests';
import { checkoutPr, existingCheckout, prFileDiff, removeCheckout } from '../src/git/prWorktree';
import { changeKind, prImpact, prStatusOf, recentFailures, selectionCheck } from '../src/run/prImpact';
import { testCaseIdsAt } from '../src/ado/workItems';
import { resultsComment } from '../src/run/prComment';
import type { RunInfo } from '../src/run/runner';

const ME = '5991d1db-0000-0000-0000-000000000001';
// Shapes recorded from a real organization (lab repository studio-lab-tests, pull request 1).
const RAW_PR = {
    repository: { id: 'r1', name: 'studio-lab-tests' }, pullRequestId: 1, status: 'active', title: 'Login: check the dashboard',
    description: 'Adds a scenario', createdBy: { id: ME, displayName: 'Tester' }, creationDate: '2026-11-20T10:36:29Z',
    sourceRefName: 'refs/heads/feature/login-dashboard-check', targetRefName: 'refs/heads/main', mergeStatus: 'succeeded', isDraft: false,
    reviewers: [{ id: ME, displayName: 'Tester', vote: 0 }, { id: 'other', displayName: 'Lead', vote: 10, isRequired: true }],
    lastMergeSourceCommit: { commitId: 'b'.repeat(40) }, lastMergeTargetCommit: { commitId: 'a'.repeat(40) }, lastMergeCommit: { commitId: 'c'.repeat(40) },
};

function fake(): { client: AdoClient; sent: AdoRequest[] } {
    const sent: AdoRequest[] = [];
    const transport = async (req: AdoRequest): Promise<AdoResponse> => {
        sent.push(req);
        const u = new URL(req.url);
        const p = u.pathname;
        const ok = (b: unknown) => ({ status: 200, body: JSON.stringify(b) });
        if (p.endsWith('/_apis/git/pullrequests')) return ok({ value: [RAW_PR] });
        if (p.endsWith('/pullrequests/1') && req.method === 'GET') return ok(RAW_PR);
        if (p.endsWith('/pullrequests/1/iterations')) return ok({ value: [{ id: 1 }, { id: 2 }] });
        if (p.endsWith('/iterations/2/changes')) return ok({ changeEntries: [
            { changeType: 'edit', item: { path: '/test/akhan/features/login.feature' } },
            { changeType: 'edit', item: { path: '/test/orangehrm/steps/login.steps.ts' } },
            { changeType: 'add', item: { path: '/test', isFolder: true } },
            // Recorded from a real PR (studio-lab-tests 6): a deleted file has no path, a rename has both.
            { changeType: 'delete', item: { path: null, originalObjectId: 'B8' }, originalPath: '/test/akhan/features/data-driven copy.feature' },
            { changeType: 'rename', item: { path: '/test/akhan/features/failure-capture.feature' }, originalPath: '/test/akhan/features/test-failure.feature' }] });
        if (p.endsWith('/pullrequests/1/workitems')) return ok({ value: [{ id: '1252' }] });
        if (p.endsWith('/pullrequests/1/threads') && req.method === 'GET') return ok({ value: [
            { id: 1, status: 'active', threadContext: { filePath: '/test/akhan/features/login.feature', rightFileStart: { line: 62 } }, comments: [{ author: { displayName: 'Lead' }, content: 'Cover a wrong password', commentType: 'text' }] },
            { id: 2, comments: [{ author: { displayName: 'Microsoft.VisualStudio.Services.TFS' }, content: 'The reference was updated.', commentType: 'system' }] },
            { id: 3, isDeleted: true, comments: [{ content: 'gone' }] }] });
        if (p.endsWith('/pullrequests/1/statuses')) return ok({ value: [{ context: { genre: 'continuous-integration', name: 'build' }, state: 'succeeded' }] });
        if (p.endsWith('/_apis/policy/evaluations')) return ok({ value: [{ status: 'queued', configuration: { isBlocking: true, type: { displayName: 'Minimum number of reviewers' } } }] });
        if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') return ok({ id: 9 });
        return { status: 404, body: '' };
    };
    return { client: new AdoClient({ orgUrl: 'https://dev.azure.com/acme', project: 'Shop', pat: 'x', transport }), sent };
}

test('pull requests: lists for review, mine, all; detail with changes, threads, policies, work items', async () => {
    const { client, sent } = fake();
    const pr = new PullRequests(client, ME);
    const [p] = await pr.list({ scope: 'review' });
    assert.equal(new URL(sent[0].url).searchParams.get('searchCriteria.reviewerId'), ME);
    assert.deepEqual([p.id, p.source, p.target, p.myVote, p.url], [1, 'feature/login-dashboard-check', 'main', 0, 'https://dev.azure.com/acme/Shop/_git/studio-lab-tests/pullrequest/1']);
    await pr.list({ scope: 'mine' });
    assert.equal(new URL(sent[1].url).searchParams.get('searchCriteria.creatorId'), ME);
    const d = await pr.detail('studio-lab-tests', 1, 'proj-1');
    assert.deepEqual(d.changes.map((c) => [c.changeType, c.path, c.originalPath]), [
        ['edit', 'test/akhan/features/login.feature', undefined], ['edit', 'test/orangehrm/steps/login.steps.ts', undefined],
        ['delete', 'test/akhan/features/data-driven copy.feature', undefined],
        ['rename', 'test/akhan/features/failure-capture.feature', 'test/akhan/features/test-failure.feature']]);
    assert.deepEqual(d.workItems, [1252]);
    assert.equal(d.iterations, 2);
    assert.deepEqual(d.threads.map((t) => [t.id, t.file, t.line, t.comments[0].system]), [[1, 'test/akhan/features/login.feature', 62, false], [2, undefined, undefined, true]]);
    assert.deepEqual(d.policies, [{ name: 'Minimum number of reviewers', status: 'queued', blocking: true }]);
    assert.deepEqual(d.statuses.map((s) => [s.name, s.state]), [['continuous-integration/build', 'succeeded']]);
    assert.deepEqual(d.commits, { source: 'b'.repeat(40), target: 'a'.repeat(40), merge: 'c'.repeat(40) });
    assert.equal(d.reviewers.find((r) => r.name === 'Lead')!.required, true);
});

test('pull requests: vote and comment send exactly what Azure DevOps expects', async () => {
    const { client, sent } = fake();
    const pr = new PullRequests(client, ME);
    await pr.vote('studio-lab-tests', 1, 10);
    const v = sent.pop()!;
    assert.equal(v.method, 'PUT');
    assert.match(v.url, new RegExp(`/git/repositories/studio-lab-tests/pullrequests/1/reviewers/${ME}\\?api-version=7\\.1$`));
    assert.deepEqual(JSON.parse(v.body!), { vote: 10 });
    // A required reviewer stays required when voting (Azure DevOps replaces the whole entry).
    RAW_PR.reviewers[0] = { ...RAW_PR.reviewers[0], isRequired: true } as typeof RAW_PR.reviewers[0];
    await pr.vote('studio-lab-tests', 1, -5);
    assert.deepEqual(JSON.parse(sent.pop()!.body!), { vote: -5, isRequired: true });
    delete (RAW_PR.reviewers[0] as { isRequired?: boolean }).isRequired;
    await assert.rejects(pr.vote('studio-lab-tests', 1, 7), /Invalid vote/);
    await pr.comment('studio-lab-tests', 1, 'Tests passed', { file: 'test/a.feature', line: 3 });
    const c = sent.pop()!;
    assert.equal(c.method, 'POST');
    assert.deepEqual(JSON.parse(c.body!).threadContext, { filePath: '/test/a.feature', rightFileStart: { line: 3, offset: 1 }, rightFileEnd: { line: 3, offset: 1 } });
    assert.equal(JSON.parse(c.body!).status, 1, 'a review comment is open');
    await pr.comment('studio-lab-tests', 1, '### Test results', undefined, true);
    assert.equal(JSON.parse(sent.pop()!.body!).status, 4, 'test results are posted closed: they never block completion');
    await pr.setThread('studio-lab-tests', 1, 4, 'fixed');
    assert.deepEqual([sent.at(-1)!.method, JSON.parse(sent.at(-1)!.body!)], ['PATCH', { status: 2 }]);
    await assert.rejects(pr.detail('a/b', 1), /Invalid repository/);
});

test('which local remote is the pull request repository', () => {
    const r = (url: string) => remoteForRepository([{ name: 'origin', url }], 'studio-lab-tests');
    assert.equal(r('https://dev.azure.com/acme/Shop/_git/studio-lab-tests'), 'origin');
    assert.equal(r('https://acme@dev.azure.com/acme/Shop/_git/Studio-Lab-Tests.git'), 'origin');
    assert.equal(r('https://acme.visualstudio.com/Shop/_git/studio-lab-tests/'), 'origin');
    assert.equal(r('git@ssh.dev.azure.com:v3/acme/Shop/studio-lab-tests'), 'origin');
    assert.equal(r('https://dev.azure.com/acme/Shop/_git/studio-lab-tests-old'), null);
    assert.equal(r('https://github.com/acme/studio-lab-tests'), null);
});

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } });

test('a pull request is tested in its own local copy; the working copy is never touched', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pr-'));
    // A "server" repository whose path ends in /_git/<name>, with a pull request merge ref.
    const server = path.join(tmp, '_git', 'labrepo');
    fs.mkdirSync(server, { recursive: true });
    sh(server, 'init', '-q', '-b', 'main');
    fs.mkdirSync(path.join(server, 'test/shop/features'), { recursive: true });
    fs.writeFileSync(path.join(server, 'test/shop/features/a.feature'), 'Feature: A\n  Scenario: one\n    Given x\n');
    sh(server, 'add', '-A'); sh(server, 'commit', '-qm', 'base');
    const target = sh(server, 'rev-parse', 'HEAD').trim();
    sh(server, 'checkout', '-q', '-b', 'feature/x');
    fs.writeFileSync(path.join(server, 'test/shop/features/a.feature'), 'Feature: A\n  Scenario: one changed\n    Given x\n');
    sh(server, 'commit', '-qam', 'change');
    sh(server, 'checkout', '-q', 'main');
    sh(server, 'update-ref', 'refs/pull/7/merge', 'feature/x');
    const local = path.join(tmp, 'local');
    sh(tmp, 'clone', '-q', server, local);
    fs.mkdirSync(path.join(local, 'node_modules/pkg'), { recursive: true });
    fs.writeFileSync(path.join(local, 'node_modules/pkg/index.js'), 'module.exports = 1;');
    fs.writeFileSync(path.join(local, '.gitignore'), 'node_modules/\nconfig/local.env\n');
    fs.mkdirSync(path.join(local, 'config'), { recursive: true });
    fs.writeFileSync(path.join(local, 'config/local.env'), 'MY=1\n');
    fs.writeFileSync(path.join(local, 'test/shop/features/a.feature'), 'my unsaved work\n');
    const gitDir = path.join(local, '.git');

    const co = await checkoutPr(local, gitDir, { id: 7, repository: 'labrepo', sourceBranch: 'feature/x' });
    assert.equal(co.based, 'merge');
    assert.equal(co.rel, '.git/cs-studio/pr/7');
    assert.match(fs.readFileSync(path.join(co.dir, 'test/shop/features/a.feature'), 'utf8'), /one changed/);
    assert.equal(fs.readFileSync(path.join(local, 'test/shop/features/a.feature'), 'utf8'), 'my unsaved work\n', 'working copy untouched');
    assert.equal(fs.readFileSync(path.join(co.dir, 'node_modules/pkg/index.js'), 'utf8'), 'module.exports = 1;', 'packages linked');
    assert.deepEqual(co.copiedConfig, ['config/local.env']);
    assert.equal((await existingCheckout(local, gitDir, 7))!.commit, co.commit);
    assert.match(await prFileDiff(local, target, co.commit, 'test/shop/features/a.feature'), /\+  Scenario: one changed/);
    // A rename (both names): shown as a rename with only the real change.
    sh(server, 'checkout', '-q', '-b', 'feature/mv', 'main');
    sh(server, 'mv', 'test/shop/features/a.feature', 'test/shop/features/b.feature');
    sh(server, 'commit', '-qm', 'rename');
    sh(server, 'update-ref', 'refs/pull/8/merge', 'feature/mv');
    sh(server, 'checkout', '-q', 'main');
    const co8 = await checkoutPr(local, gitDir, { id: 8, repository: 'labrepo', sourceBranch: 'feature/mv' });
    const mv = await prFileDiff(local, target, co8.commit, 'test/shop/features/b.feature', 'test/shop/features/a.feature');
    assert.match(mv, /rename from test\/shop\/features\/a\.feature\nrename to test\/shop\/features\/b\.feature/);
    await removeCheckout(local, gitDir, 8);
    // Again: the same copy is reused.
    assert.equal((await checkoutPr(local, gitDir, { id: 7, repository: 'labrepo', sourceBranch: 'feature/x' })).reused, true);
    // Not this repository: refused with an explanation.
    await assert.rejects(checkoutPr(local, gitDir, { id: 7, repository: 'other', sourceBranch: 'feature/x' }), /not the pull request's repository \(other\)/);
    // Merge conflicts (no merge ref): the source branch is tested, and the user is told.
    sh(server, 'update-ref', '-d', 'refs/pull/7/merge');
    await removeCheckout(local, gitDir, 7);
    const co2 = await checkoutPr(local, gitDir, { id: 7, repository: 'labrepo', sourceBranch: 'feature/x' });
    assert.equal(co2.based, 'source');
    assert.match(co2.notes.join(' '), /merge conflicts/);
    await removeCheckout(local, gitDir, 7);
    assert.equal(fs.existsSync(co.dir), false);
    assert.equal(fs.existsSync(path.join(local, 'node_modules/pkg/index.js')), true, 'removing the copy keeps the project packages');
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('which tests a pull request calls for', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-impact-'));
    const w = (f: string, t: string) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), t); };
    w('test/shop/features/changed.feature', 'Feature: Changed\n  Scenario: a\n    Given I log in\n');
    w('test/shop/features/uses-step.feature', 'Feature: Uses\n  Scenario: b\n    When I click "Buy"\n');
    w('test/shop/features/renamed.feature', 'Feature: Renamed\n  Scenario: r\n    Given nothing related\n');
    w('test/shop/features/unrelated.feature', 'Feature: Other\n  Scenario: c\n    Given nothing related\n');
    w('test/shop/features/tc.feature', 'Feature: TC\n  @TestCaseId:77\n  Scenario: covered\n    Given nothing related\n  Scenario: not covered\n    Given nothing related\n');
    w('test/admin/features/admin.feature', 'Feature: Admin\n  Scenario: d\n    When I click "Save"\n');
    const before = `class S {\n  @CSBDDStepDef('I click {string}')\n  a() { old(); }\n\n  @CSBDDStepDef('I log in')\n  b() {}\n}\n`;
    w('test/shop/steps/ui.steps.ts', before.replace('old()', 'changed()'));
    const r = prImpact({
        root, testCaseIds: [77], projects: ['shop', 'admin'],
        changes: [{ path: 'test/shop/features/changed.feature', changeType: 'edit' }, { path: 'test/shop/features/renamed.feature', changeType: 'rename', originalPath: 'test/shop/features/old.feature' }, { path: 'test/shop/steps/ui.steps.ts', changeType: 'edit' }, { path: 'test/shop/pages/Cart.ts', changeType: 'edit' }, { path: 'test/shop/features/gone.feature', changeType: 'delete' }],
        oldText: (f) => (f === 'test/shop/steps/ui.steps.ts' ? before : null),
        // admin does not load test/shop/steps
        loadsStepFile: (project) => project === 'shop',
    });
    assert.deepEqual(r.features.map((f) => [f.path, f.level, f.scenarios]), [
        ['test/shop/features/changed.feature', 'direct', []],
        ['test/shop/features/renamed.feature', 'direct', []],
        ['test/shop/features/tc.feature', 'direct', ['covered']],
        ['test/shop/features/uses-step.feature', 'steps', []],
    ]);
    assert.equal(r.features[1].reasons[0], 'Renamed from test/shop/features/old.feature');
    assert.match(r.features[3].reasons[0], /Uses the step "I click \{string\}" changed in test\/shop\/steps\/ui\.steps\.ts/);
    assert.deepEqual(r.other, ['test/shop/pages/Cart.ts']);
    assert.deepEqual(r.deletedFeatures, ['test/shop/features/gone.feature']);
    assert.deepEqual(r.testCases, [{ id: 77, scenarios: [{ file: 'test/shop/features/tc.feature', name: 'covered' }] }]);
    fs.rmSync(root, { recursive: true, force: true });
});

test('results as a pull request comment', () => {
    const run = {
        id: 'r', state: 'failed', startedAt: '2026-11-20T10:00:00Z', endedAt: '2026-11-20T10:00:31Z', secretNames: [], command: [],
        request: { project: 'akhan', env: 'dev', browser: 'chromium', workers: 1 },
        pr: { id: 1, repository: 'lab', title: 't', commit: 'a78bf33b8ee1adf580cad2bc9116945082ee63a3', based: 'merge' },
        summary: { total: 2, passed: 1, failed: 1, skipped: 0, duration: 31000, hasHtml: true, reportDir: '/x', scenarios: [
            { name: 'Login | works', feature: 'Login', status: 'passed', duration: 1200 },
            { name: 'Dashboard', feature: 'Login', status: 'failed', duration: 9300, error: 'Dashboard not visible\n  at step' }] },
    } as unknown as RunInfo;
    const md = resultsComment(run, (t) => t.replace('Dashboard', 'Dash••'));
    assert.match(md, /^### ❌ Test results \(CS Test Studio\)/);
    assert.match(md, /\*\*merge result\*\* \(what will land\) at `a78bf33b`/);
    assert.match(md, /\*\*2 scenarios: 1 passed, 1 failed\*\* \(31\.0 s\)/);
    assert.match(md, /\| ❌ \| Dash•• \| Login \| 9\.3 s \|\n\| ✅ \| Login \\\| works \|/);
    assert.match(md, /- \*\*Dash••\*\*: Dash•• not visible$/m);
});

test('status checks: only the latest update of each check (as Azure DevOps keeps them all)', () => {
    // Recorded from a real build-validation run (studio-lab-tests PR 7).
    const ctx = { name: 'codecoverage', genre: 'studio-lab-tests-ci' };
    assert.deepEqual(latestStatuses([
        { id: 1, context: ctx, description: 'queued' },
        { id: 2, context: ctx, state: 'pending' },
        { id: 3, context: ctx, state: 'notApplicable', description: 'not applicable' },
        { id: 4, context: { name: 'lint', genre: 'ci' } },
    ]), [{ name: 'studio-lab-tests-ci/codecoverage', state: 'notApplicable', description: 'not applicable', url: undefined }]);
});

test('failures are explained: read-only token, unknown pull request, network down, server unreachable', async () => {
    const client = (status: number, body = '') => new AdoClient({ orgUrl: 'https://dev.azure.com/acme', project: 'Shop', pat: 'x', transport: async (req) => req.method === 'GET' && /pullrequests\/1$/.test(new URL(req.url).pathname) ? { status: 200, body: JSON.stringify(RAW_PR) } : { status, body } });
    await assert.rejects(new PullRequests(client(403), ME).vote('studio-lab-tests', 1, 10), /needs the "Code \(Read & write\)" scope/);
    await assert.rejects(new PullRequests(client(403), ME).comment('studio-lab-tests', 1, 'hi'), /needs the "Code \(Read & write\)" scope/);
    await assert.rejects(new PullRequests(client(404), ME).detail('studio-lab-tests', 99), /Not found in Azure DevOps/);
    const down = new AdoClient({ orgUrl: 'https://dev.azure.com/acme', project: 'Shop', pat: 'x', transport: async () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); } });
    await assert.rejects(new PullRequests(down, ME).list({ scope: 'review' }), /Could not reach Azure DevOps \(ECONNRESET\)/);
    await assert.rejects(new PullRequests(client(200), undefined).list({ scope: 'review' }), /Could not tell who you are/);
    // The repository's server is unreachable: getting the pull request says so.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pr-down-'));
    sh(tmp, 'init', '-q', '-b', 'main');
    sh(tmp, 'remote', 'add', 'origin', path.join(tmp, '_git', 'gone'));
    await assert.rejects(checkoutPr(tmp, path.join(tmp, '.git'), { id: 3, repository: 'gone', sourceBranch: 'x' }), /Could not get the pull request from origin/);
    await assert.rejects(checkoutPr(tmp, path.join(tmp, '.git'), { id: 3, repository: 'gone', sourceBranch: '../../etc' }), /Invalid source branch/);
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('changeKind sorts changed files for the pull request summary', () => {
    assert.equal(changeKind('test/akhan/features/login.feature'), 'feature');
    assert.equal(changeKind('test/akhan/steps/login.steps.ts'), 'steps');
    assert.equal(changeKind('test/akhan/pages/LoginPage.ts'), 'code');
    assert.equal(changeKind('config/akhan/environments/dev.env'), 'config');
    assert.equal(changeKind('package.json'), 'config');
    assert.equal(changeKind('azure-pipelines.yml'), 'config');
    assert.equal(changeKind('test/akhan/data/users.csv'), 'data');
    assert.equal(changeKind('README.md'), 'other');
});

test('testCaseIdsAt reads @TestCaseId tags from a branch without checking it out', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcids-'));
    const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
    g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@e.st'); g('config', 'user.name', 't');
    fs.mkdirSync(path.join(dir, 'f'));
    fs.writeFileSync(path.join(dir, 'f', 'a.feature'), 'Feature: A\n  @TestCaseId:11\n  Scenario: one\n');
    g('add', '.'); g('commit', '-qm', 'a');
    g('checkout', '-qb', 'target');
    fs.writeFileSync(path.join(dir, 'f', 'b.feature'), 'Feature: B\n  @smoke @TestCaseId:{21, 22}\n  Scenario: two\n');
    g('add', '.'); g('commit', '-qm', 'b'); g('checkout', '-q', 'main');
    assert.deepEqual([...(await testCaseIdsAt(dir, 'refs/heads/target'))!].sort(), [11, 21, 22]);
    assert.deepEqual([...(await testCaseIdsAt(dir, 'refs/heads/main'))!], [11]);
    assert.equal(await testCaseIdsAt(dir, 'refs/heads/nope'), null);
    assert.equal(await testCaseIdsAt(dir, 'refs/heads/../x'), null);
});

test('pull request checkouts outside .git: only .cs-studio/pr/ is ignored (team settings in .cs-studio stay committable)', async () => {
    const { checkoutBase } = await import('../src/git/prWorktree');
    const fsm = await import('fs'), osm = await import('os'), pathm = await import('path');
    const root = fsm.mkdtempSync(pathm.join(osm.tmpdir(), 'prx-'));
    const gitDir = fsm.mkdtempSync(pathm.join(osm.tmpdir(), 'prx-git-'));
    fsm.mkdirSync(pathm.join(gitDir, 'info'));
    fsm.writeFileSync(pathm.join(gitDir, 'info', 'exclude'), '# local\n/.cs-studio/\n');
    assert.equal(checkoutBase(root, gitDir), pathm.join(root, '.cs-studio', 'pr'));
    const ex = fsm.readFileSync(pathm.join(gitDir, 'info', 'exclude'), 'utf8');
    assert.match(ex, /^\/\.cs-studio\/pr\/$/m);
    assert.doesNotMatch(ex, /^\/\.cs-studio\/$/m, 'the old whole-folder line is narrowed');
    checkoutBase(root, gitDir);
    assert.equal(fsm.readFileSync(pathm.join(gitDir, 'info', 'exclude'), 'utf8').match(/cs-studio/g)!.length, 1, 'added once');
    // Every old line, Windows line ends too.
    fsm.writeFileSync(pathm.join(gitDir, 'info', 'exclude'), '# local\r\n/.cs-studio/\r\nx\r\n/.cs-studio/\r\n');
    checkoutBase(root, gitDir);
    const ex2 = fsm.readFileSync(pathm.join(gitDir, 'info', 'exclude'), 'utf8');
    assert.doesNotMatch(ex2, /^\/\.cs-studio\/\r?$/m, 'no whole-folder line left');
    assert.equal(ex2.match(/\/\.cs-studio\/pr\/\r\n/g)!.length, 2, 'both narrowed, their line ends kept; nothing appended');
    fsm.rmSync(root, { recursive: true, force: true }); fsm.rmSync(gitDir, { recursive: true, force: true });
});

test('which tests: changed code through imports and page names, data files, recorded runs, recent failures; the full suite when needed', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-impact2-'));
    const w = (f: string, t: string) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), t); };
    try {
        w('test/common/helpers/money.ts', 'export const money = (n: number) => `$${n}`;\n');
        w('test/common/helpers/unused.ts', 'export const x = 1;\n');
        w('test/shop/pages/CartPage.ts', "import { money } from '../../common/helpers/money';\nexport class CartPage { total() { return money(1); } }\n");
        w('test/shop/pages/LoginPage.ts', "@CSPage('shop-login')\nexport class LoginPage {}\n");
        w('test/shop/steps/cart.steps.ts', "import { CartPage } from '../pages/CartPage';\nclass C {\n  @CSBDDStepDef('the cart total is {string}')\n  t() {}\n}\n");
        w('test/shop/steps/login.steps.ts', "class L {\n  @Page('shop-login') page!: any;\n  @CSBDDStepDef('I sign in')\n  s() {}\n}\n");
        w('test/shop/features/cart.feature', 'Feature: Cart\n  Scenario: Total\n    Then the cart total is "$1"\n');
        w('test/shop/features/login.feature', 'Feature: Login\n  Scenario: Sign in\n    Given I sign in\n');
        w('test/shop/features/users.feature', 'Feature: Users\n  Scenario: From a file\n    Given I sign in\n    # data: test/shop/data/users.csv\n');
        w('test/shop/features/search.feature', 'Feature: Search\n  Scenario: Find\n    Given I sign in\n  Scenario: Filter\n    Given I sign in\n');
        w('test/shop/data/users.csv', 'name\nann\n');
        const run = (changes: string[], extra: Partial<Parameters<typeof prImpact>[0]> = {}) => prImpact({ root, testCaseIds: [], projects: ['shop'], changes: changes.map((p) => ({ path: p, changeType: 'edit' })), oldText: () => null, ...extra });
        let r = run(['test/common/helpers/money.ts']);
        assert.deepEqual(r.features.map((f) => [f.path, f.level]), [['test/shop/features/cart.feature', 'code']]);
        assert.equal(r.features[0].reasons[0], 'Uses steps in test/shop/steps/cart.steps.ts, which imports test/shop/pages/CartPage.ts, which imports test/common/helpers/money.ts');
        assert.deepEqual([r.fullSuite, r.other], [[], []]);
        r = run(['test/shop/pages/LoginPage.ts']);
        assert.deepEqual(r.features.map((f) => f.path), ['test/shop/features/login.feature', 'test/shop/features/search.feature', 'test/shop/features/users.feature'], 'a page found by name: every feature using its steps');
        assert.match(r.features[0].reasons[0], /uses the page 'shop-login' of test\/shop\/pages\/LoginPage\.ts$/);
        r = run(['test/shop/data/users.csv']);
        assert.deepEqual(r.features.map((f) => [f.path, f.level, f.reasons[0]]), [['test/shop/features/users.feature', 'data', 'Names users.csv, which changed']]);
        r = run(['package.json', 'test/common/helpers/unused.ts']);
        assert.deepEqual(r.fullSuite, ['package.json changed: configuration or packages every test uses', "test/common/helpers/unused.ts changed and no feature's steps reach it in the code"]);
        assert.deepEqual(r.other, ['test/common/helpers/unused.ts']);
        // A recorded run saw the scenario load the file: that scenario only, and no full suite for it.
        r = run(['test/common/helpers/unused.ts'], { coverage: { tests: { Filter: { testId: 'Filter', testName: 'Filter', featureFile: 'test/shop/features/search.feature', files: ['test/common/helpers/unused.ts'] } } } });
        assert.deepEqual([r.features.map((f) => [f.path, f.level, f.scenarios]), r.fullSuite], [[['test/shop/features/search.feature', 'coverage', ['Filter']]], []]);
        // Failing recently: offered after the rest.
        r = run(['test/shop/data/users.csv'], { recentFailures: [{ feature: 'Search', scenario: 'Find', at: '2026-11-21T10:00:00Z' }, { feature: 'Nope', scenario: 'x', at: '2026-11-21T10:00:00Z' }] });
        assert.deepEqual(r.features.map((f) => [f.path, f.level, f.scenarios]), [['test/shop/features/users.feature', 'data', []], ['test/shop/features/search.feature', 'recent', ['Find']]]);
        assert.equal(r.features[1].reasons[0], 'Failed in a recent run (2026-11-21)');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('recent failures, the observed choice, the status of a run', () => {
    const run = (endedAt: string, scenarios: Array<[string, string, string]>) => ({ endedAt, summary: { scenarios: scenarios.map(([feature, name, status]) => ({ feature, name, status, duration: 1 })) } }) as unknown as RunInfo;
    const now = Date.parse('2026-11-22T12:00:00Z');
    // The latest result counts: Find failed then passed (not failing); Filter failed last; an old run is ignored.
    assert.deepEqual(recentFailures([
        run('2026-11-22T10:00:00Z', [['Search', 'Find', 'passed'], ['Search', 'Filter_Iteration-2', 'failed']]),
        run('2026-11-21T10:00:00Z', [['Search', 'Find', 'failed'], ['Cart', 'Total', 'failed']]),
        run('2026-10-01T10:00:00Z', [['Old', 'Gone', 'failed']]),
    ], now), [{ feature: 'Search', scenario: 'Filter', at: '2026-11-22T10:00:00Z' }, { feature: 'Cart', scenario: 'Total', at: '2026-11-21T10:00:00Z' }]);
    const summary = { total: 3, passed: 1, failed: 2, skipped: 0, duration: 1, reportDir: '', hasHtml: false, scenarios: [
        { feature: 'Cart', name: 'Total', status: 'failed', duration: 1 }, { feature: 'Search', name: 'Find', status: 'failed', duration: 1 }, { feature: 'Login', name: 'Sign in', status: 'passed', duration: 1 }] };
    const selection = { observe: true, features: [{ path: 'test/shop/features/cart.feature', name: 'Cart', scenarios: [] }, { path: 'test/shop/features/login.feature', name: 'Login', scenarios: [] }] };
    assert.deepEqual(selectionCheck({ summary, pr: { selection } }), { selected: 2, failed: 2, missed: [{ scenario: 'Find', feature: 'Search' }] });
    assert.equal(selectionCheck({ summary, pr: { selection: { ...selection, observe: false } } }), null, 'only an observed run is checked');
    const req = { project: 'shop', env: 'qa' } as RunInfo['request'];
    const commit = 'a78bf33b8ee1adf580cad2bc9116945082ee63a3';
    assert.deepEqual(prStatusOf({ state: 'failed', summary, request: req, pr: { commit, selection: { ...selection, observe: false } } }), { state: 'failed', description: '1 passed, 2 failed (2 selected features, shop/qa) at a78bf33b' });
    assert.deepEqual(prStatusOf({ state: 'passed', summary: { ...summary, failed: 0, passed: 3 }, request: req, pr: { commit } }), { state: 'succeeded', description: '3 passed, 0 failed (all tests, shop/qa) at a78bf33b' });
    assert.equal(prStatusOf({ state: 'running', request: req, pr: { commit } }).state, 'pending');
    assert.equal(prStatusOf({ state: 'error', request: req }).state, 'error');
    // The comment says what the observation found.
    const r = { id: 'r', state: 'failed', startedAt: '2026-11-20T10:00:00Z', endedAt: '2026-11-20T10:00:31Z', secretNames: [], command: [], request: req, summary, pr: { id: 1, repository: 'lab', title: 't', commit, based: 'merge', selection } } as unknown as RunInfo;
    assert.match(resultsComment(r), /\*\*Selection check:\*\* every test ran; the 2 chosen features would have missed 1 failure: Find\./);
});

test('pull requests: the status check sent as Azure DevOps expects', async () => {
    const { client, sent } = fake();
    const pr = new PullRequests(client, ME);
    await pr.postStatus('studio-lab-tests', 1, { state: 'failed', description: '1 passed, 2 failed', targetUrl: 'http://127.0.0.1:4000/x' });
    const s = sent.pop()!;
    assert.equal(s.method, 'POST');
    assert.match(s.url, /\/git\/repositories\/studio-lab-tests\/pullrequests\/1\/statuses\?api-version=7\.1$/);
    assert.deepEqual(JSON.parse(s.body!), { state: 'failed', description: '1 passed, 2 failed', context: { genre: 'cs-test-studio', name: 'tests' } }, 'a local address is not sent as the link');
});
