/**
 * Bug lifecycle from the test results: file a bug for a product-bug failure with none, comment on an open bug when
 * the failure goes on, reopen a closed bug when the failure is back, propose resolving one whose scenarios now pass;
 * the process's state names (Agile, Scrum, Basic); applied only as chosen, through Azure DevOps.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { planBugActions, stateCategories } from '../src/quality/bugLifecycle';
import { signatureTag } from '../src/quality/triage';
import type { FailureGroup, QualityScenario } from '../src/quality/quality';
import { runGit } from '../src/git/run';
import { SecretStore } from '../src/secrets/store';
import { KeyFileProtector } from '../src/secrets/protector';

const agile = stateCategories([{ name: 'New', category: 'Proposed' }, { name: 'Active', category: 'InProgress' }, { name: 'Resolved', category: 'Resolved' }, { name: 'Closed', category: 'Completed' }]);
const scrum = stateCategories([{ name: 'New', category: 'Proposed' }, { name: 'Approved', category: 'Proposed' }, { name: 'Committed', category: 'InProgress' }, { name: 'Done', category: 'Completed' }, { name: 'Removed', category: 'Removed' }]);

const group = (sig: string, o: Partial<FailureGroup> = {}): FailureGroup => ({ signature: sig, category: 'assertion' as FailureGroup['category'], sample: `${sig}: expected 200, got 500\n at step`, failures: 3, runs: 3, inLatest: true, firstSeen: '2026-11-20T10:00:00Z', lastSeen: '2026-11-22T10:00:00Z', scenarios: [{ key: `k-${sig}`, name: `Scenario ${sig}`, feature: 'shop.feature' }], ...o });
const scenario = (key: string, statuses: Array<[string, 'passed' | 'failed']>, failingFor = 0): QualityScenario => ({ key, name: key, feature: 'shop.feature', quarantined: false, cls: 'stable' as QualityScenario['cls'], results: statuses.map(([at, status]) => ({ run: at, at, status, retries: 0, duration: 1 })), passRate: 0, failingFor } as QualityScenario);

test('the process\'s states: reopen to the first in-progress state, resolve to Resolved (or Done)', () => {
    assert.deepEqual([agile.reopen, agile.resolve, [...agile.done]], ['Active', 'Resolved', ['Resolved', 'Closed']]);
    assert.deepEqual([scrum.reopen, scrum.resolve, [...scrum.done]], ['Committed', 'Done', ['Done', 'Removed']]);
});

test('file, comment, reopen, resolve — each only when it applies', () => {
    const groups = [
        group('newbug'),                                                          // product bug, no bug yet → file
        group('noverdict'),                                                       // no verdict → nothing
        group('ongoing', { lastSeen: '2026-11-22T10:00:00Z' }),                   // open bug changed before → comment
        group('quiet', { lastSeen: '2026-11-21T10:00:00Z' }),                      // open bug changed after the last failure → nothing
        group('back'),                                                            // closed bug, failing again → reopen
        group('fixed', { inLatest: false, lastSeen: '2026-11-20T10:00:00Z' }),     // passed 3 times since → resolve
        group('notyet', { inLatest: false, lastSeen: '2026-11-21T10:00:00Z' }),    // passed only once since → nothing
    ];
    const scenarios = [
        scenario('k-newbug', [['2026-11-22T10:00:00Z', 'failed']], 1), scenario('k-noverdict', [['2026-11-22T10:00:00Z', 'failed']], 1),
        scenario('k-ongoing', [['2026-11-22T10:00:00Z', 'failed']], 1), scenario('k-quiet', [['2026-11-21T10:00:00Z', 'failed']], 1), scenario('k-back', [['2026-11-22T10:00:00Z', 'failed']], 1),
        scenario('k-fixed', [['2026-11-20T10:00:00Z', 'failed'], ['2026-11-21T10:00:00Z', 'passed'], ['2026-11-22T09:00:00Z', 'passed'], ['2026-11-22T10:00:00Z', 'passed']]),
        scenario('k-notyet', [['2026-11-21T10:00:00Z', 'failed'], ['2026-11-22T10:00:00Z', 'passed']]),
    ];
    const t = (s: string) => signatureTag(s);
    const triage = { [t('newbug')]: { signature: 'newbug', verdict: 'product-bug' as const, by: 'x', at: '' }, [t('back')]: { signature: 'back', bug: 503, by: 'x', at: '' } };
    const bugs = [
        { id: 501, title: 'Ongoing', state: 'Active', tags: [t('ongoing')], changed: '2026-11-21T00:00:00Z' },
        { id: 502, title: 'Quiet', state: 'New', tags: [t('quiet')], changed: '2026-11-21T12:00:00Z' },
        { id: 503, title: 'Back', state: 'Closed', tags: [], changed: '2026-11-21T00:00:00Z' },
        { id: 504, title: 'Fixed', state: 'Active', tags: [t('fixed')], changed: '2026-11-20T12:00:00Z' },
        { id: 505, title: 'Not yet', state: 'Active', tags: [t('notyet')], changed: '2026-11-21T12:00:00Z' },
    ];
    const plan = planBugActions({ groups, scenarios, triage, bugs, states: agile });
    assert.deepEqual(plan.map((a) => [a.kind, 'bug' in a ? a.bug : a.tag === t('newbug')]), [['file', true], ['update', 501], ['reopen', 503], ['resolve', 504]]);
    const reopen = plan.find((a) => a.kind === 'reopen') as Extract<(typeof plan)[number], { kind: 'reopen' }>;
    assert.deepEqual([reopen.from, reopen.to], ['Closed', 'Active']);
    assert.match(reopen.comment, /<b>Failing again<\/b>.*3 failures in 3 runs/);
    const resolve = plan.find((a) => a.kind === 'resolve') as Extract<(typeof plan)[number], { kind: 'resolve' }>;
    assert.deepEqual([resolve.to], ['Resolved']);
    assert.match(resolve.why, /passed in the last 3\+ runs/);
    assert.match((plan[0] as { title: string }).title, /^\[Automation\] newbug: expected 200, got 500$/);
    // With Scrum, the same reopen goes to Committed and a fix proposes Done.
    const scrumPlan = planBugActions({ groups, scenarios, triage, bugs: bugs.map((b) => (b.id === 503 ? { ...b, state: 'Done' } : b)), states: scrum });
    assert.deepEqual(scrumPlan.filter((a) => a.kind === 'reopen' || a.kind === 'resolve').map((a) => [a.kind, (a as { to: string }).to]), [['reopen', 'Committed'], ['resolve', 'Done']]);
});

test('applied through Azure DevOps: state changes and comments, only what was chosen and confirmed', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bugs-'));
    const dir = path.join(tmp, 'repo');
    await runGit(['init', '-q', '-b', 'main', dir], { cwd: tmp });
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config/global.env'), 'BASE_URL=http://localhost\nADO_ORGANIZATION=acme\nADO_PROJECT=qa\n');
    fs.mkdirSync(path.join(dir, 'config/shop/environments'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config/shop/environments/qa.env'), 'ENVIRONMENT=qa\n');
    const store = new SecretStore(path.join(tmp, 'home'), new KeyFileProtector(path.join(tmp, 'home', 'keys', 'secrets.key')));
    store.set({ name: 'ADO_PAT' }, 'pat-1');
    const calls: string[] = [];
    const transport = async (req: { url: string; method: string; body?: string }) => {
        const u = new URL(req.url);
        calls.push(`${req.method} ${u.pathname.replace(/^.*_apis\//, '')} ${req.body ?? ''}`);
        if (req.method === 'PATCH' && /wit\/workitems\/9/.test(u.pathname)) return { status: 400, body: JSON.stringify({ message: 'The field State contains value Gone that is not in the list of supported values' }) };
        return { status: 200, body: JSON.stringify({ id: 1 }) };
    };
    const { createServer } = await import('../src/server/server');
    const s = createServer({ repoRoot: dir, store, userName: 'T', adoTransport: transport, token: 'tk' });
    const apply = async (payload: object) => { const r = await s.app.inject({ method: 'POST', url: '/api/triage/bugs/apply', headers: { authorization: 'Bearer tk' }, payload }); return { status: r.statusCode, json: JSON.parse(r.body) }; };
    try {
        assert.match((await apply({ actions: [{ kind: 'update', bug: 1 }] })).json.error, /Confirm/);
        const r = await apply({ confirm: true, actions: [
            { kind: 'reopen', bug: 503, to: 'Active', comment: '<p>Failing again</p>' },
            { kind: 'resolve', bug: 504, to: 'Resolved', comment: '<p>Passing</p>' },
            { kind: 'update', bug: 501, comment: '<p>Still failing</p>' },
            { kind: 'resolve', bug: 9, to: 'Gone', comment: 'x' },
        ] });
        assert.equal(r.status, 200, JSON.stringify(r.json));
        assert.deepEqual(r.json.results.map((x: { kind: string; ok: boolean }) => [x.kind, x.ok]), [['reopen', true], ['resolve', true], ['update', true], ['resolve', false]]);
        assert.match(r.json.results[3].error, /not in the list of supported values/);
        assert.ok(calls.some((c) => /^PATCH wit\/workitems\/503 .*\/fields\/System\.State","value":"Active"/.test(c)), calls.join('\n'));
        assert.ok(calls.some((c) => /^POST wit\/workItems\/504\/comments .*Passing/.test(c)));
        assert.ok(!calls.some((c) => /^PATCH wit\/workitems\/501/.test(c)), 'an update only comments');
    } finally { await s.app.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
});
