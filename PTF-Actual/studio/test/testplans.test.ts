import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { AdoClient, AdoRequest } from '../src/ado/client';
import { nameGuid, outcomeOf, publishTargets, scenarioTestSteps, stepsXml, tagsToPublishTo, TestPlans } from '../src/ado/testPlans';
import { withScenarioTags } from '../src/quality/quality';
import { parseTestSteps } from '../src/ado/workItems';

const FEATURE = `@shop
Feature: Orders

  Background:
    Given I am signed in as "clerk"

  @TestCaseId:419
  Scenario: Find an order
    When I search for order "SO-1001"
    And I open the first result
    Then the order status is "Open"
    And the total is shown
    When I export it
      | format | csv |
    Then a file "orders.csv" is saved

  Scenario: Only checks
    Then the page title is "Orders"
    And nothing else
`;

test('scenarioTestSteps: actions, expected results, Background first, tables kept', () => {
    const s = scenarioTestSteps(FEATURE, 8)!;
    assert.equal(s.name, 'Find an order');
    assert.deepEqual(s.steps, [
        { action: 'Given I am signed in as "clerk"', expected: '' },
        { action: 'When I search for order "SO-1001"', expected: '' },
        { action: 'And I open the first result', expected: 'Then the order status is "Open"\nAnd the total is shown' },
        { action: 'When I export it\n| format | csv |', expected: 'Then a file "orders.csv" is saved' },
    ]);
    // Checks with no action before them (Background still first)
    assert.deepEqual(scenarioTestSteps(FEATURE, 17)!.steps, [{ action: 'Given I am signed in as "clerk"', expected: 'Then the page title is "Orders"\nAnd nothing else' }]);
    assert.equal(scenarioTestSteps(FEATURE, 9), null);
});

test('stepsXml: Azure DevOps steps that read back the same (special characters escaped)', () => {
    const steps = [{ action: 'When I type <b> & "x"', expected: '' }, { action: 'And two\nlines', expected: 'Then it is > 5' }];
    const xml = stepsXml(steps);
    assert.match(xml, /^<steps id="0" last="3">/);
    assert.match(xml, /type="ActionStep"/);
    assert.match(xml, /type="ValidateStep"/);
    assert.doesNotMatch(xml, /<b>/);
    assert.deepEqual(parseTestSteps(xml), steps);
});

test('outcomeOf and nameGuid', () => {
    assert.equal(outcomeOf('Passed'), 'passed');
    assert.equal(outcomeOf('Timeout'), 'failed');
    assert.equal(outcomeOf('unspecified'), 'not run');
    assert.equal(outcomeOf('NotApplicable'), 'not applicable');
    const g = nameGuid('a.feature\u0000Find');
    assert.match(g, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(g, nameGuid('a.feature\u0000Find'));
    assert.notEqual(g, nameGuid('a.feature\u0000Other'));
});

test('TestPlans: pages of plans, test points, creating a test case (JSON Patch) and adding it to a suite', async () => {
    const calls: AdoRequest[] = [];
    const transport = async (req: AdoRequest) => {
        calls.push(req);
        const u = new URL(req.url);
        if (u.pathname.endsWith('/testplan/plans') && !u.searchParams.get('continuationToken')) return { status: 200, headers: { 'x-ms-continuationtoken': 'next1' }, body: JSON.stringify({ value: [{ id: 413, name: 'Release 1', state: 'Active', rootSuite: { id: 414 }, areaPath: 'p', iteration: 'p\\Sprint 1' }] }) };
        if (u.pathname.endsWith('/testplan/plans')) return { status: 200, body: JSON.stringify({ value: [{ id: 500, name: 'Release 2', state: 'Active', rootSuite: { id: 501 } }] }) };
        if (u.pathname.endsWith('/TestPoint')) return { status: 200, body: JSON.stringify({ value: [
            { id: 1, testCaseReference: { id: 419, name: 'Find an order', state: 'Ready' }, configuration: { name: 'Chrome' }, tester: { displayName: 'A Tester' }, isAutomated: true,
                results: { outcome: 'failed', lastTestRunId: 77, lastResultDetails: { dateCompleted: '2026-11-20T10:00:00Z', runBy: { displayName: 'Pipeline' } } } },
            { id: 2, testCaseReference: { id: 420, name: 'Cancel' }, configuration: { name: 'Chrome' }, results: { outcome: 'unspecified', lastResultDetails: { dateCompleted: '0001-01-01T00:00:00' } } },
        ] }) };
        if (u.pathname.includes('/wit/workitems/') && req.method === 'POST') return { status: 200, body: JSON.stringify({ id: 999 }) };
        if (u.pathname.endsWith('/TestCase')) return { status: 200, body: '[]' };
        return { status: 404, body: '' };
    };
    const tp = new TestPlans(new AdoClient({ orgUrl: 'https://dev.azure.com/example', project: 'Shop App', pat: 'x', transport }));
    const plans = await tp.plans();
    assert.deepEqual(plans.map((p) => p.id), [500, 413]);
    assert.equal(plans[1].web, 'https://dev.azure.com/example/Shop%20App/_testPlans/define?planId=413&suiteId=414');
    assert.match(calls[1].url, /continuationToken=next1/);
    const pts = await tp.points(413, 414);
    assert.deepEqual(pts[0], { id: 1, testCase: 419, title: 'Find an order', state: 'Ready', configuration: 'Chrome', tester: 'A Tester', outcome: 'failed', lastRun: '2026-11-20T10:00:00.000Z', lastRunBy: 'Pipeline', runId: 77, isAutomated: true, active: true });
    assert.equal(pts[1].outcome, 'not run');
    assert.equal(pts[1].lastRun, undefined);
    const id = await tp.createTestCase({ title: 'Find an order', steps: [{ action: 'When x', expected: 'Then y' }], areaPath: 'p', iterationPath: 'p\\Sprint 1', automatedTestName: 'Find an order', automatedTestStorage: 'test/shop/features/orders.feature' });
    assert.equal(id, 999);
    const create = calls.find((c) => c.method === 'POST' && c.url.includes('/wit/workitems/'))!;
    assert.match(create.url, /\/wit\/workitems\/\$Test%20Case\?api-version=7\.1$/);
    assert.equal(create.headers['Content-Type'], 'application/json-patch+json');
    const ops = JSON.parse(create.body!) as Array<{ path: string; value: string }>;
    assert.deepEqual(ops.map((o) => o.path.replace('/fields/', '')), ['System.Title', 'Microsoft.VSTS.TCM.Steps', 'System.AreaPath', 'System.IterationPath', 'Microsoft.VSTS.TCM.AutomatedTestName', 'Microsoft.VSTS.TCM.AutomatedTestStorage', 'Microsoft.VSTS.TCM.AutomatedTestType', 'Microsoft.VSTS.TCM.AutomatedTestId']);
    await tp.addToSuite(413, 414, [999]);
    const add = calls[calls.length - 1];
    assert.match(add.url, /\/testplan\/Plans\/413\/Suites\/414\/TestCase/);
    assert.deepEqual(JSON.parse(add.body!), [{ workItem: { id: 999 } }]);
});

test('publishTargets: plan and suite as the framework resolves them (scenario > feature > configuration)', () => {
    const catalog = [
        { path: 'a.feature', name: 'A', tags: ['@TestPlanId:10', '@TestSuiteId:11'], scenarios: [
            { name: 'feature plan', line: 3, tags: ['@TestCaseId:100'] },
            { name: 'scenario overrides the suite', line: 6, tags: ['@TestSuiteId:12', '@TestCaseId:{101,102}'] },
        ] },
        { path: 'b.feature', name: 'B', tags: ['@TestCaseId:200'], scenarios: [
            { name: 'config plan, feature test case', line: 3, tags: [] },
            { name: 'own test case wins', line: 5, tags: ['@TestCaseId:201', '@TestPlanId:30'] },
        ] },
    ];
    const t = publishTargets(catalog, { plan: 20, suite: 21 });
    assert.deepEqual(t.map((x) => [x.name, x.testCases, x.plan, x.suite, x.planFrom, x.suiteFrom]), [
        ['feature plan', [100], 10, 11, 'feature', 'feature'],
        ['scenario overrides the suite', [101, 102], 10, 12, 'feature', 'scenario'],
        ['config plan, feature test case', [200], 20, 21, 'config', 'config'],
        ['own test case wins', [201], 30, 21, 'scenario', 'config'],
    ]);
    // Without configuration: nothing to publish to
    const none = publishTargets([catalog[1]], {})[0];
    assert.equal(none.plan, undefined);
    assert.equal(none.planFrom, undefined);
    assert.deepEqual(tagsToPublishTo(t[0], 10, 11), []);
    assert.deepEqual(tagsToPublishTo(t[0], 10, 99), ['@TestPlanId:10', '@TestSuiteId:99']);
    assert.deepEqual(tagsToPublishTo(none, 7, 8), ['@TestPlanId:7', '@TestSuiteId:8']);
});

test('withScenarioTags: adds tags, replaces tags of the same kind, keeps the rest', () => {
    const f = 'Feature: X\n\n  @smoke @TestPlanId:3 # keep\n  @TestSuiteId:4\n  Scenario: S\n    Given x\n\n  Scenario: T\n    Given y\n';
    assert.equal(withScenarioTags(f, 5, 'S', ['@TestCaseId:9', '@TestPlanId:7', '@TestSuiteId:8']),
        'Feature: X\n\n  @smoke # keep\n  @TestCaseId:9 @TestPlanId:7 @TestSuiteId:8\n  Scenario: S\n    Given x\n\n  Scenario: T\n    Given y\n');
    assert.equal(withScenarioTags(f, 8, 'T', ['@TestCaseId:9']), f.replace('\n  Scenario: T', '\n  @TestCaseId:9\n  Scenario: T'));
    assert.equal(withScenarioTags(f.replace(/\n/g, '\r\n'), 8, 'T', ['@TestCaseId:9']), f.replace('\n  Scenario: T', '\n  @TestCaseId:9\n  Scenario: T').replace(/\n/g, '\r\n'));
    assert.throws(() => withScenarioTags(f, 5, 'T', ['@x']), /no longer on that line/);
    assert.equal(withScenarioTags(f, 5, 'S', []), f);
});
