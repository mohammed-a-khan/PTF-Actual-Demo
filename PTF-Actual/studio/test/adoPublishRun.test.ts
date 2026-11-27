import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { AdoClient } from '../src/ado/client';
import { entryFor, PublishTarget, runScenarios, testCaseTag, TestPlans } from '../src/ado/testPlans';
import { withScenarioTags } from '../src/quality/quality';

const targets: PublishTarget[] = [
    { file: 'f/login.feature', line: 3, name: 'Valid login', feature: 'Login', testCases: [101], plan: 7, suite: 70, planFrom: 'feature', suiteFrom: 'feature' },
    { file: 'f/login.feature', line: 9, name: 'Locked account', feature: 'Login', testCases: [102, 103] },
    { file: 'f/nav.feature', line: 5, name: 'Visit each module', feature: 'Nav', testCases: [415, 416], plan: 7, suite: 71, planFrom: 'scenario', suiteFrom: 'scenario' },
    { file: 'f/cart.feature', line: 20, name: 'Empty cart', feature: 'Cart', testCases: [] },
];

test('runScenarios: one entry per scenario, iterations collected (worst outcome, durations added), tags carried, unknown ones kept by name', () => {
    const r = runScenarios([
        { name: 'Valid login', feature: 'Login', status: 'passed', duration: 1200 },
        { name: 'Visit each module_Iteration-1', feature: 'Nav', status: 'passed', duration: 100 },
        { name: 'Visit each module_Iteration-2', feature: 'Nav', status: 'failed', duration: 200, error: 'PIM missing' },
        { name: 'Visit each module_Iteration-3', feature: 'Nav', status: 'passed', duration: 300 },
        { name: 'Empty cart', feature: 'Cart', status: 'passed', duration: 10 },
        { name: 'Gone (Example 2)', feature: 'Cart', status: 'skipped', duration: 0 },
    ], targets);
    assert.deepEqual(r.map((s) => [s.key, s.outcome, s.durationMs, s.iterations.length]), [
        ['f/login.feature:3', 'Passed', 1200, 0], ['f/nav.feature:5', 'Failed', 600, 3], ['f/cart.feature:20', 'Passed', 10, 0], ['Cart: Gone', 'NotExecuted', 0, 1]]);
    const nav = r[1];
    assert.deepEqual([nav.testCases, nav.plan, nav.suite, nav.planFrom], [[415, 416], 7, 71, 'scenario']);
    assert.equal(nav.error, '1 of 3 iterations failed. See comment for details.');
    // One scenario gives the result of two test cases.
    const a = entryFor(415, [1], [nav]), b = entryFor(416, [2], [nav]);
    assert.deepEqual([a.outcome, b.outcome, a.durationMs], ['Failed', 'Failed', 600]);
    assert.match(a.comment, /Data-Driven Test Results \(3 iterations\)[\s\S]*Iteration 2: ❌ Failed — PIM missing/);
    assert.match(String(a.error), /Iteration 2: PIM missing/);
    // Two scenarios for one test case: failed if one failed, durations added.
    const two = entryFor(101, [3], [r[0], nav]);
    assert.deepEqual([two.outcome, two.durationMs], ['Failed', 1800]);
    assert.equal(testCaseTag([416, 415, 415]), '@TestCaseId:{415,416}');
    assert.equal(testCaseTag([9]), '@TestCaseId:9');
});

test('publishTo: a run on exactly the ticked points, each point its own result, run completed', async () => {
    const calls: Array<{ m: string; p: string; b?: unknown }> = [];
    const fake = {
        orgUrl: 'https://dev.azure.com/org', projectName: 'Proj',
        async get(p: string) {
            calls.push({ m: 'GET', p });
            if (p.startsWith('test/runs/55/results')) return { value: [{ id: 100000, testCase: { id: '101' }, testPoint: { id: '1' } }, { id: 100001, testCase: { id: '102' }, testPoint: { id: '4' } }] };
            throw new Error(`unexpected GET ${p}`);
        },
        async page(p: string) { return { data: await this.get(p) }; },
        async post(p: string, b: unknown) { calls.push({ m: 'POST', p, b }); if (p === 'test/runs') return { id: 55, webAccessUrl: 'https://dev.azure.com/org/Proj/_TestManagement/Runs?runId=55' }; throw new Error(p); },
        async patch(p: string, b: unknown) { calls.push({ m: 'PATCH', p, b }); return {}; },
    };
    const tp = new TestPlans(fake as unknown as AdoClient);
    const r = await tp.publishTo(7, 'shop qa – Studio run 1', [
        { testCase: 101, pointIds: [1], outcome: 'Passed', durationMs: 1000, comment: 'Scenario: a', scenario: 'Login: a' },
        { testCase: 102, pointIds: [4], outcome: 'Failed', durationMs: 500, error: 'expected X', comment: 'Scenario: b', scenario: 'Login: b' },
    ], 'by T');
    assert.deepEqual(r, { runId: 55, url: 'https://dev.azure.com/org/Proj/_TestManagement/Runs?runId=55', published: 2, results: [{ testCase: 101, resultId: 100000 }, { testCase: 102, resultId: 100001 }] });
    const create = calls.find((c) => c.p === 'test/runs')!.b as Record<string, unknown>;
    assert.deepEqual(create.pointIds, [1, 4], 'only the ticked points (point 2, the Edge one, was left out)');
    const results = calls.find((c) => c.p === 'test/runs/55/results' && c.m === 'PATCH')!.b as Array<Record<string, unknown>>;
    assert.deepEqual(results.map((x) => [x.id, x.outcome, x.durationInMs, x.state, x.comment]), [[100000, 'Passed', 1000, 'Completed', 'Scenario: a'], [100001, 'Failed', 500, 'Completed', 'Scenario: b']]);
    assert.deepEqual(calls.at(-1), { m: 'PATCH', p: 'test/runs/55', b: { state: 'Completed' } });
    await assert.rejects(tp.publishTo(7, 'n', []), /at least one test point/);
});

test('writing the mapping back: @TestCaseId merged with the ids the scenario had', () => {
    const text = 'Feature: Nav\n\n  @smoke @TestCaseId:415\n  Scenario: Visit each module\n    Given x\n';
    const out = withScenarioTags(text, 4, 'Visit each module', [testCaseTag([415, 420])]);
    assert.equal(out, 'Feature: Nav\n\n  @smoke @TestCaseId:{415,420}\n  Scenario: Visit each module\n    Given x\n');
});

test('runScenarios: a feature copied into another folder: the run\'s own file wins', () => {
    const copies: PublishTarget[] = [
        { file: 'test/a/features/login.feature', line: 4, name: 'Sign in', feature: 'Login', testCases: [1], plan: 1, suite: 2 },
        { file: 'test/b/features/login.feature', line: 4, name: 'Sign in', feature: 'Login', testCases: [9], plan: 7, suite: 8 },
    ];
    const r = runScenarios([{ name: 'Sign in', feature: 'Login', status: 'passed', duration: 1 }], copies, (f) => (f.startsWith('test/b/') ? 2 : 0));
    assert.deepEqual([r[0].key, r[0].testCases], ['test/b/features/login.feature:4', [9]]);
});

test('tagsForMapping: test cases added in the same suite; a scenario publishing to another suite is not moved', () => {
    const { tagsForMapping } = require('../src/ado/testPlans') as typeof import('../src/ado/testPlans');
    assert.deepEqual(tagsForMapping({ testCases: [415, 416], plan: 413, suite: 414 }, new Set([420]), new Set(['417/418'])),
        { skip: 'its tags send test cases 415, 416 to plan 413 / suite 414; changing them would stop those results' });
    assert.deepEqual(tagsForMapping({ testCases: [415], plan: 413, suite: 414 }, new Set([416]), new Set(['413/414'])), { tags: ['@TestCaseId:{415,416}'] });
    assert.deepEqual(tagsForMapping({ testCases: [415], plan: 413, suite: 414 }, new Set([415]), new Set(['413/414'])), { tags: [] }, 'already tagged: nothing to write');
    assert.deepEqual(tagsForMapping({ testCases: [], plan: 417, suite: 418 }, new Set([421]), new Set(['417/418'])), { tags: ['@TestCaseId:421'] }, 'the feature already names the suite');
    assert.deepEqual(tagsForMapping({ testCases: [] }, new Set([421]), new Set(['417/418'])), { tags: ['@TestCaseId:421', '@TestPlanId:417', '@TestSuiteId:418'] });
    assert.match((tagsForMapping({ testCases: [] }, new Set([1, 2]), new Set(['1/2', '3/4'])) as { skip: string }).skip, /2 suites/);
});

test('one feature, scenarios in different suites of one plan, and in different plans: each scenario keeps its own target', () => {
    const { publishTargets } = require('../src/ado/testPlans') as typeof import('../src/ado/testPlans');
    const catalog = [{ path: 'test/p/features/mixed.feature', name: 'Mixed', tags: ['@TestPlanId:10', '@TestSuiteId:1'], scenarios: [
        { name: 'Inherits', line: 4, tags: ['@TestCaseId:100'] },
        { name: 'Other suite, same plan', line: 8, tags: ['@TestSuiteId:2', '@TestCaseId:{200,201}'] },
        { name: 'Other plan and suite', line: 12, tags: ['@TestPlanId:20', '@TestSuiteId:3', '@TestCaseId:300'] },
    ] }];
    const targets = publishTargets(catalog, { plan: 99, suite: 98 });
    const r = runScenarios([
        { name: 'Inherits', feature: 'Mixed', status: 'passed', duration: 1 },
        { name: 'Other suite, same plan', feature: 'Mixed', status: 'failed', duration: 1 },
        { name: 'Other plan and suite', feature: 'Mixed', status: 'passed', duration: 1 },
    ], targets);
    assert.deepEqual(r.map((s) => [s.name, s.plan, s.suite, s.testCases, s.planFrom, s.suiteFrom]), [
        ['Inherits', 10, 1, [100], 'feature', 'feature'],
        ['Other suite, same plan', 10, 2, [200, 201], 'feature', 'scenario'],
        ['Other plan and suite', 20, 3, [300], 'scenario', 'scenario'],
    ]);
});

test('evidence: what the ADO_UPLOAD_* settings allow, under the size limit, matched to the scenario (iterations too)', () => {
    const { evidenceFor, uploadSettings, attachmentTypeOf } = require('../src/ado/testPlans') as typeof import('../src/ado/testPlans');
    const up = uploadSettings((k) => ({ ADO_UPLOAD_TRACES: 'true', ADO_ATTACHMENT_MAX_MB: '1' } as Record<string, string>)[k] ?? '');
    assert.deepEqual(up, { attachments: true, screenshot: true, video: true, console: true, har: false, trace: true, maxMb: 1 });
    const scen = runScenarios([
        { name: 'Visit each module_Iteration-1', feature: 'Nav', status: 'passed', duration: 1 },
        { name: 'Visit each module_Iteration-2', feature: 'Nav', status: 'failed', duration: 1 },
        { name: 'Valid login', feature: 'Login', status: 'passed', duration: 1 },
    ], targets);
    const f = (kind: string, name: string, size = 10) => ({ kind, file: `shots/${name}`, name, size });
    const ev = evidenceFor(scen, [
        { name: 'Visit each module_Iteration-1', feature: 'Nav', files: [f('screenshot', 'a.png'), f('har', 'x.har')] },
        { name: 'Visit each module_Iteration-2', feature: 'Nav', files: [f('screenshot', 'b.png'), f('video', 'big.webm', 5 * 1024 * 1024), f('trace', 't.zip')] },
        { name: 'Valid login', feature: 'Login', location: { file: 'f/login.feature', line: 3 }, files: [f('console', 'log.txt'), f('trace', 'shared.zip')], matchedByTime: true, failedStep: { screenshot: f('screenshot', 'fail.png') }, steps: [{ screenshot: f('screenshot', 'fail.png') }, { screenshot: f('screenshot', 'step2.png') }] },
        { name: 'Other', feature: 'Login', files: [f('trace', 'shared.zip')], matchedByTime: true },
    ], up);
    assert.deepEqual(ev.get('f/nav.feature:5')!.map((x) => x.name), ['a.png', 'b.png', 't.zip'], 'HAR is off by default; the 5 MB video is over the 1 MB limit');
    assert.deepEqual(ev.get('f/login.feature:3')!.map((x) => x.name), ['log.txt', 'fail.png', 'step2.png'], 'a trace matched by time to two scenarios is not attached to either');
    assert.equal(evidenceFor(scen, [{ name: 'Valid login', feature: 'Login', files: [f('console', 'log.txt')] }], { ...up, attachments: false }).size, 0, 'ADO_UPLOAD_ATTACHMENTS=false: nothing');
    // Failure screenshots listed for the whole run: to the one scenario that failed on that step.
    const run = [f('screenshot', 'step-failure-When-I-click-on--Leave--menu-item-2026-11-27T13-03-04-776Z.png'), f('screenshot', 'step-failure-Then-it-fails-2026-11-27T13-03-05-000Z.png')];
    const byStep = evidenceFor(scen, [
        { name: 'Visit each module_Iteration-2', feature: 'Nav', files: [], steps: [{ text: 'When I click on "Leave" menu item', status: 'failed' }] },
        { name: 'Valid login', feature: 'Login', files: [], steps: [{ text: 'Then it fails', status: 'failed' }] },
        { name: 'Visit each module_Iteration-1', feature: 'Nav', files: [], steps: [{ text: 'Then it fails', status: 'failed' }] },
    ], up, run);
    assert.deepEqual(byStep.get('f/nav.feature:5')!.map((x) => x.name), ['step-failure-When-I-click-on--Leave--menu-item-2026-11-27T13-03-04-776Z.png']);
    assert.deepEqual(byStep.get('f/login.feature:3')!.map((x) => x.name), [], 'two scenarios failed on "Then it fails": its screenshot goes to neither');
    assert.deepEqual(['screenshot', 'video', 'console', 'trace', 'har'].map(attachmentTypeOf), ['GeneralAttachment', 'GeneralAttachment', 'ConsoleLog', 'GeneralAttachment', 'GeneralAttachment']);
});

test('publishTo: attachments go on before the run is completed', async () => {
    const calls: string[] = [];
    const fake = {
        orgUrl: 'https://dev.azure.com/org', projectName: 'Proj',
        async get(p: string) { calls.push(`GET ${p}`); return { value: [{ id: 9, testCase: { id: '101' }, testPoint: { id: '1' } }] }; },
        async post(p: string) { calls.push(`POST ${p}`); return { id: 55 }; },
        async patch(p: string, b: unknown) { calls.push(`PATCH ${p} ${JSON.stringify(b).slice(0, 25)}`); return {}; },
    };
    const tp = new TestPlans(fake as unknown as AdoClient);
    await tp.publishTo(7, 'n', [{ testCase: 101, pointIds: [1], outcome: 'Failed', durationMs: 1, comment: 'c', scenario: 's' }], undefined, async (runId, results) => {
        assert.deepEqual(results, [{ testCase: 101, resultId: 9 }]);
        await tp.attachToResult(runId, 9, 'a.png', Buffer.from('x'), 'GeneralAttachment');
        await tp.attachToRun(runId, 'results.zip', Buffer.from('z'));
    });
    assert.deepEqual(calls.slice(-3), ['POST test/Runs/55/Results/9/attachments?api-version=7.1-preview.1', 'POST test/Runs/55/attachments?api-version=7.1-preview.1', 'PATCH test/runs/55 {"state":"Completed"}']);
});
