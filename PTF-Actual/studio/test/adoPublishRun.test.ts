import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { AdoClient } from '../src/ado/client';
import { PublishTarget, resultsToPublish, TestPlans } from '../src/ado/testPlans';

const targets: PublishTarget[] = [
    { file: 'f/login.feature', line: 3, name: 'Valid login', feature: 'Login', testCases: [101], plan: 7, suite: 70, planFrom: 'feature', suiteFrom: 'feature' },
    { file: 'f/login.feature', line: 9, name: 'Locked account', feature: 'Login', testCases: [102, 103] },
    { file: 'f/cart.feature', line: 3, name: 'Add to cart with <qty> items', feature: 'Cart', testCases: [201], plan: 7, suite: 71, planFrom: 'scenario', suiteFrom: 'scenario' },
    { file: 'f/cart.feature', line: 20, name: 'Empty cart', feature: 'Cart', testCases: [] },
];

test('resultsToPublish: grouped by plan and suite, outcomes mapped, outlines matched by name prefix, unlinked and unplanned listed', () => {
    const r = resultsToPublish([
        { name: 'Valid login', feature: 'Login', status: 'passed', duration: 1200 },
        { name: 'Locked account', feature: 'Login', status: 'failed', duration: 900, error: 'expected locked' },
        { name: 'Add to cart with <qty> items (Example 2)', feature: 'Cart', status: 'failed', duration: 50, error: 'boom' },
        { name: 'Empty cart', feature: 'Cart', status: 'passed', duration: 10 },
        { name: 'Something else', feature: 'Cart', status: 'skipped', duration: 0 },
    ], targets);
    assert.deepEqual(r.groups.map((g) => [g.plan, g.suite, g.results.map((x) => `${x.testCase}:${x.outcome}`)]), [[7, 70, ['101:Passed']], [7, 71, ['201:Failed']]]);
    assert.deepEqual(r.noPlan, ['Login: Locked account']);
    assert.deepEqual(r.notLinked, ['Cart: Empty cart', 'Cart: Something else']);
    const chosen = resultsToPublish([{ name: 'Locked account', feature: 'Login', status: 'failed', duration: 900, error: 'x' }], targets, { plan: 9, suite: 90 });
    assert.deepEqual(chosen.groups.map((g) => [g.plan, g.suite, g.results.map((x) => x.testCase)]), [[9, 90, [102, 103]]], 'the chosen plan and suite win; one result per test case');
});

test('publishRun: a run on the suite\'s points for those test cases, outcomes set, run completed; a test case with two scenarios fails if one did', async () => {
    const calls: Array<{ m: string; p: string; b?: unknown }> = [];
    const fake = {
        orgUrl: 'https://dev.azure.com/org', projectName: 'Proj',
        async get(p: string) {
            calls.push({ m: 'GET', p });
            if (p.startsWith('testplan/Plans/7/Suites/70/TestPoint')) return { value: [
                { id: 1, testCaseReference: { id: 101, name: 'Login' }, configuration: { name: 'Chrome' }, isActive: true },
                { id: 2, testCaseReference: { id: 101, name: 'Login' }, configuration: { name: 'Edge' }, isActive: true },
                { id: 3, testCaseReference: { id: 104, name: 'Other' }, configuration: { name: 'Chrome' }, isActive: true }] };
            if (p.startsWith('test/runs/55/results')) return { value: [{ id: 100000, testCase: { id: '101' }, testPoint: { id: '1' } }, { id: 100001, testCase: { id: '101' }, testPoint: { id: '2' } }] };
            throw new Error(`unexpected GET ${p}`);
        },
        async page(p: string) { return { data: await this.get(p) }; },
        async post(p: string, b: unknown) { calls.push({ m: 'POST', p, b }); if (p === 'test/runs') return { id: 55, webAccessUrl: 'https://dev.azure.com/org/Proj/_TestManagement/Runs?runId=55' }; throw new Error(p); },
        async patch(p: string, b: unknown) { calls.push({ m: 'PATCH', p, b }); return {}; },
    };
    const tp = new TestPlans(fake as unknown as AdoClient);
    const r = await tp.publishRun(7, 70, 'shop qa – Studio run 1', [
        { testCase: 101, outcome: 'Passed', durationMs: 1000, scenario: 'Login: a' },
        { testCase: 101, outcome: 'Failed', durationMs: 500, error: 'expected X', scenario: 'Login: b' },
        { testCase: 999, outcome: 'Passed', durationMs: 1, scenario: 'Login: c' },
    ], 'by T');
    assert.deepEqual(r, { runId: 55, url: 'https://dev.azure.com/org/Proj/_TestManagement/Runs?runId=55', published: 2, missing: [999] });
    const create = calls.find((c) => c.p === 'test/runs')!.b as Record<string, unknown>;
    assert.deepEqual(create.pointIds, [1, 2], 'both configurations of test case 101');
    assert.deepEqual(create.plan, { id: '7' });
    const results = calls.find((c) => c.p === 'test/runs/55/results' && c.m === 'PATCH')!.b as Array<Record<string, unknown>>;
    assert.deepEqual(results.map((x) => [x.id, x.outcome, x.durationInMs, x.state]), [[100000, 'Failed', 1500, 'Completed'], [100001, 'Failed', 1500, 'Completed']]);
    assert.match(String(results[0].errorMessage), /expected X/);
    assert.deepEqual(calls.at(-1), { m: 'PATCH', p: 'test/runs/55', b: { state: 'Completed' } });
    await assert.rejects(tp.publishRun(7, 70, 'n', [{ testCase: 999, outcome: 'Passed', durationMs: 1, scenario: 's' }]), /has a test point in suite 70/);
});
