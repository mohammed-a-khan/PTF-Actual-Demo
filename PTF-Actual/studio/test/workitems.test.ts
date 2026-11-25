import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AdoClient, AdoRequest } from '../src/ado/client';
import { automatedScenarios, branchNameFor, htmlToText, parseTestSteps, scenarioFromTestCase, WorkItems, wiqlString } from '../src/ado/workItems';

// Shapes copied from a real Azure DevOps organization (REST 7.1).
const STEPS_XML = '<steps id="0" last="3"><step id="2" type="ActionStep"><parameterizedString isformatted="true">Given I log in to OrangeHRM as the configured Admin user</parameterizedString><parameterizedString isformatted="true">The step completes without error and the application reaches the state expected by the following step.</parameterizedString><description /></step><step id="3" type="ActionStep"><parameterizedString isformatted="true">When I inspect custom fields in Personal Details</parameterizedString><parameterizedString isformatted="true">the employee detail heading contains &amp;quot;Personal Details&amp;quot;</parameterizedString><description /></step></steps>';

test('HTML and test steps from Azure DevOps become plain text', () => {
    assert.equal(htmlToText('<h2>Test Objective </h2>\n<p>Custom &amp; fields.</p><ul><li><b>Env:</b> uat </li></ul><table><tr><th>id</th><th>out</th></tr>\n<tr><td>ac9</td><td>x</td></tr></table><script>alert(1)</script><img src=x onerror=alert(1)>'),
        'Test Objective\n\nCustom & fields.\n\n• Env: uat\n\nid | out\n\nac9 | x');
    assert.deepEqual(parseTestSteps(STEPS_XML), [
        { action: 'Given I log in to OrangeHRM as the configured Admin user', expected: 'The step completes without error and the application reaches the state expected by the following step.' },
        { action: 'When I inspect custom fields in Personal Details', expected: 'the employee detail heading contains "Personal Details"' },
    ]);
    assert.equal(wiqlString("it's"), "'it''s'");
});

test('a test case as a scenario, and branch names', () => {
    const tc = { id: 1240, title: 'Add Employee lifecycle — Custom fields', type: 'Test Case', state: 'Design', tags: [], url: '', relations: [],
        automatedTestName: 'Custom fields are visible in Personal Details', steps: parseTestSteps(STEPS_XML) };
    assert.equal(scenarioFromTestCase(tc), [
        '  @TestCaseId:1240', '  Scenario: Custom fields are visible in Personal Details',
        '    Given I log in to OrangeHRM as the configured Admin user', '    When I inspect custom fields in Personal Details',
        '    Then the employee detail heading contains "Personal Details"', ''].join('\n'));
    assert.equal(scenarioFromTestCase({ ...tc, steps: [{ action: 'Open the page', expected: 'Page is shown' }] }).split('\n').slice(2, 4).join('|'), '    Given Open the page|    Then Page is shown');
    assert.equal(branchNameFor({ id: 425, title: 'Add new employee with complete personal, contact & job info', type: 'User Story' }), 'feature/425-add-new-employee-with-complete-personal');
    assert.equal(branchNameFor({ id: 7, title: 'Crash on Ünïcode!', type: 'Bug' }), 'bugfix/7-crash-on-unicode');
});

test('scenarios tagged @TestCaseId (single, list, feature tags ignored)', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-tc-'));
    fs.mkdirSync(path.join(repo, 'test/a/features'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'test/a/features/x.feature'), '@TestPlanId:417 @TestCaseId:999\nFeature: X\n\n  @smoke @TestCaseId:1240\n  Scenario: One\n    Given a\n\n  @TestCaseId:{1241, 1242}\n  Scenario Outline: Two\n    Given b\n');
    const m = automatedScenarios(repo);
    assert.deepEqual(m.get(1240), [{ file: 'test/a/features/x.feature', line: 5, name: 'One' }]);
    assert.equal(m.get(1242)![0].name, 'Two');
    assert.equal(m.get(999), undefined);
    fs.rmSync(repo, { recursive: true, force: true });
});

test('work item lists use WIQL then a field read, and never write', async () => {
    const calls: AdoRequest[] = [];
    const transport = async (req: AdoRequest) => {
        calls.push(req);
        const u = new URL(req.url);
        if (u.pathname.endsWith('/_apis/projects/myproject/teams')) return { status: 200, body: JSON.stringify({ value: [{ name: 'myproject Team' }] }) };
        if (u.pathname.endsWith('/myproject%20Team/_apis/work/teamsettings/iterations')) return { status: 200, body: JSON.stringify({ value: [{ name: 'Sprint 1', path: 'myproject\\Sprint 1' }] }) };
        if (u.pathname.endsWith('/_apis/wit/wiql')) return { status: 200, body: JSON.stringify({ workItems: [{ id: 1240 }, { id: 425 }] }) };
        if (u.pathname.endsWith('/_apis/wit/workitems')) return { status: 200, body: JSON.stringify({ value: [
            { id: 425, fields: { 'System.Title': 'Story', 'System.WorkItemType': 'User Story', 'System.State': 'Active', 'System.AssignedTo': { displayName: 'Mo' } } },
            { id: 1240, fields: { 'System.Title': 'TC', 'System.WorkItemType': 'Test Case', 'System.State': 'Design', 'System.Tags': 'ac9; tab', 'Microsoft.VSTS.TCM.AutomationStatus': 'Automated' } }] }) };
        return { status: 404, body: '' };
    };
    const wi = new WorkItems(new AdoClient({ orgUrl: 'https://dev.azure.com/mdakhan', project: 'myproject', pat: 'x', transport }));
    const r = await wi.list('sprint');
    assert.deepEqual(r.sprint, { name: 'Sprint 1', path: 'myproject\\Sprint 1' });
    assert.deepEqual(r.items.map((i) => [i.id, i.type, i.assignedTo, i.tags, i.url]), [
        [1240, 'Test Case', undefined, ['ac9', 'tab'], 'https://dev.azure.com/mdakhan/myproject/_workitems/edit/1240'],
        [425, 'User Story', 'Mo', [], 'https://dev.azure.com/mdakhan/myproject/_workitems/edit/425']]);
    const wiql = calls.find((c) => c.url.includes('/wit/wiql'))!;
    assert.match(JSON.parse(wiql.body!).query, /\[System.IterationPath\] UNDER 'myproject\\Sprint 1'/);
    // Only reads: GET, and the WIQL query (a POST that only reads).
    assert.ok(calls.every((c) => c.method === 'GET' || c.url.includes('/_apis/wit/wiql')));
    const s = await wi.list('search', { text: "O'Brien's form" });
    assert.ok(JSON.parse(calls.filter((c) => c.url.includes('/wit/wiql')).pop()!.body!).query.includes("CONTAINS 'O''Brien''s form'"));
    assert.equal(s.items.length, 2);
});
