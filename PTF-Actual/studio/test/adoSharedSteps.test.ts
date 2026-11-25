/**
 * Test cases with shared steps and parameters, both ways:
 *  - read: shared steps (<compref ref>) expanded from their work items and marked; parameters (@name) with their
 *    values, the test case's own or a shared parameter set's; the drafted scenario is an outline with Examples;
 *  - publish: an outline's <placeholders> become @parameters and its Examples the test case's values.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseParameters, scenarioFromTestCase, sharedParameterRows, stepsWithShared } from '../src/ado/workItems';
import { localDataSourceXml, parametersXml, scenarioTestSteps, stepsXml } from '../src/ado/testPlans';
import { runGit } from '../src/git/run';
import { SecretStore } from '../src/secrets/store';
import { KeyFileProtector } from '../src/secrets/protector';

const step = (a: string, e = '') => `<step id="2" type="${e ? 'ValidateStep' : 'ActionStep'}"><parameterizedString isformatted="true">&lt;DIV&gt;&lt;P&gt;${a}&lt;/P&gt;&lt;/DIV&gt;</parameterizedString><parameterizedString isformatted="true">${e ? `&lt;P&gt;${e}&lt;/P&gt;` : ''}</parameterizedString><description/></step>`;
const TC_STEPS = `<steps id="0" last="5">${step('Open the shop')}<compref id="3" ref="701"/>${step('Search for @product', 'Results show @product')}</steps>`;
const SHARED_STEPS = `<steps id="0" last="3">${step('Enter user @user')}${step('Sign in', 'The dashboard opens')}</steps>`;
const DATASET = `<NewDataSet><xs:schema id='NewDataSet'/><Table1><user>ann</user><product>books</product></Table1><Table1><user>bob</user><product>pens &amp; ink</product></Table1></NewDataSet>`;

test('the XML: steps and shared-step references in order; parameters, own values or a shared set\'s', () => {
    const items = stepsWithShared(TC_STEPS);
    assert.deepEqual(items.map((x) => ('shared' in x ? `shared ${x.shared}` : x.step.action)), ['Open the shop', 'shared 701', 'Search for @product']);
    const own = parseParameters('<parameters><param name="user" bind="default"/><param name="product" bind="default"/></parameters>', DATASET);
    assert.deepEqual(own, { names: ['user', 'product'], rows: [{ user: 'ann', product: 'books' }, { user: 'bob', product: 'pens & ink' }] });
    const sh = parseParameters('<parameters><param name="u" bind="default"/></parameters>', JSON.stringify({ parameterMap: [{ localParamName: 'u', sharedParameterName: 'user', sharedParameterDataSetId: 900 }], sharedParameterDataSetIds: [900], rowMappingType: 1 }));
    assert.deepEqual([sh.sharedSetId, sh.map], [900, { u: 'user' }]);
    assert.deepEqual(sharedParameterRows('<parameterSet><paramNames><param>user</param></paramNames><paramData lastId="2"><dataRow id="1"><kvp key="user" value="carol"/></dataRow><dataRow id="2"><kvp key="user" value="dan &amp; co"/></dataRow></paramData></parameterSet>'), [{ user: 'carol' }, { user: 'dan & co' }]);
    // Written back: the same values come out again.
    assert.deepEqual(parseParameters(parametersXml(['user', 'product']), localDataSourceXml(['user', 'product'], own.rows)), own);
});

test('publish an outline: <placeholders> → @parameters, Examples → the values', () => {
    const feature = ['Feature: Shop', '', '  @TestCaseId:42', '  Scenario Outline: Search as a user', '    Given I sign in as <user>', '    When I search for <product>', '    Then I see results for <product>', '', '    Examples:', '      | user | product |', '      | ann  | books   |', '      | bob  | pens \\| ink |', ''].join('\n');
    const sc = scenarioTestSteps(feature, 4)!;
    assert.deepEqual(sc.steps.map((s) => [s.action, s.expected]), [['Given I sign in as @user', ''], ['When I search for @product', 'Then I see results for @product']]);
    assert.deepEqual(sc.parameters, { names: ['user', 'product'], rows: [{ user: 'ann', product: 'books' }, { user: 'bob', product: 'pens | ink' }] });
    assert.match(stepsXml(sc.steps), /I sign in as @user/);
    assert.equal(scenarioTestSteps(feature.replace('Scenario Outline', 'Scenario'), 4)!.parameters, undefined);
});

test('a test case read from Azure DevOps: shared steps expanded, shared parameters resolved, an outline drafted', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-'));
    const dir = path.join(tmp, 'repo');
    await runGit(['init', '-q', '-b', 'main', dir], { cwd: tmp });
    fs.mkdirSync(path.join(dir, 'config/shop/environments'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config/global.env'), 'BASE_URL=http://localhost\nADO_ORGANIZATION=acme\nADO_PROJECT=qa\n');
    fs.writeFileSync(path.join(dir, 'config/shop/environments/qa.env'), 'ENVIRONMENT=qa\n');
    const store = new SecretStore(path.join(tmp, 'home'), new KeyFileProtector(path.join(tmp, 'home', 'keys', 'secrets.key')));
    store.set({ name: 'ADO_PAT' }, 'pat-1');
    const transport = async (req: { url: string }) => {
        const u = new URL(req.url);
        const json = (b: unknown) => ({ status: 200, body: JSON.stringify(b) });
        if (/wit\/workitems\/42$/.test(u.pathname)) return json({ id: 42, fields: { 'System.Title': 'Search as a user', 'System.WorkItemType': 'Test Case', 'System.State': 'Ready', 'Microsoft.VSTS.TCM.Steps': TC_STEPS,
            'Microsoft.VSTS.TCM.Parameters': '<parameters><param name="user" bind="default"/><param name="product" bind="default"/></parameters>',
            'Microsoft.VSTS.TCM.LocalDataSource': JSON.stringify({ parameterMap: [{ localParamName: 'user', sharedParameterName: 'login' }, { localParamName: 'product', sharedParameterName: 'item' }], sharedParameterDataSetIds: [900] }) }, relations: [] });
        if (/wit\/workitems$/.test(u.pathname) && u.searchParams.get('ids') === '701') return json({ value: [{ id: 701, fields: { 'System.Title': 'Sign in', 'Microsoft.VSTS.TCM.Steps': SHARED_STEPS } }] });
        if (/wit\/workitems\/900$/.test(u.pathname)) return json({ id: 900, fields: { 'System.Title': 'Shop users', 'Microsoft.VSTS.TCM.Parameters': '<parameterSet><paramData><dataRow id="1"><kvp key="login" value="ann"/><kvp key="item" value="books"/></dataRow><dataRow id="2"><kvp key="login" value="bob"/><kvp key="item" value="pens"/></dataRow></paramData></parameterSet>' } });
        return { status: 404, body: '' };
    };
    const { createServer } = await import('../src/server/server');
    const s = createServer({ repoRoot: dir, store, userName: 'T', adoTransport: transport, token: 'tk' });
    try {
        const r = await s.app.inject({ method: 'GET', url: '/api/ado/workitems/42?project=shop&env=qa', headers: { authorization: 'Bearer tk' } });
        assert.equal(r.statusCode, 200, r.body);
        const d = r.json();
        assert.deepEqual(d.steps.map((x: { action: string; shared?: { id: number } }) => [x.action, x.shared?.id ?? null]), [['Open the shop', null], ['Enter user @user', 701], ['Sign in', 701], ['Search for @product', null]]);
        assert.deepEqual(d.parameters, { names: ['user', 'product'], rows: [{ user: 'ann', product: 'books' }, { user: 'bob', product: 'pens' }], sharedSet: { id: 900, title: 'Shop users' } });
        assert.equal(d.scenario, [
            '  @TestCaseId:42', '  Scenario Outline: Search as a user', '    Given Open the shop', '    # Shared steps #701: Sign in', '    And Enter user <user>', '    And Sign in', '    Then The dashboard opens',
            '    And Search for <product>', '    Then Results show <product>', '', '    Examples: # shared parameters #900: Shop users', '      | user | product |', '      | ann | books |', '      | bob | pens |', '',
        ].join('\n'));
        assert.equal(scenarioFromTestCase({ ...d, parameters: undefined, steps: [{ action: 'Do @x', expected: '' }] }), '  @TestCaseId:42\n  Scenario: Search as a user\n    Given Do @x\n');
    } finally { await s.app.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
});
