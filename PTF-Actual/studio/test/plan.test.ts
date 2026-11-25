import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { planCoverage, planSummary } from '../src/agents/plan';
import { patternToRegex, StepDef } from '../src/lang/steps';
import { studioTools, isReadOnlyCall } from '../src/agents/tools';

const def = (pattern: string, file: string, builtIn = false, notLoaded = false): StepDef => ({ pattern, file, line: 7, builtIn, regex: patternToRegex(pattern), ...(notLoaded ? { notLoaded } : {}) });
const DEFS = [
    def('user navigates to {string}', 'framework', true),
    def('I add {int} of {string} to the basket', 'test/shop/steps/basket.steps.ts'),
    def('the basket total should be {string}', 'test/shop/steps/basket.steps.ts'),
    def('I apply the voucher {string}', 'test/old/voucher.steps.ts', false, true),
];
const PLAN = `@story-1234
Feature: Basket discounts

  Background:
    Given user navigates to "/shop"

  @smoke
  Scenario: A voucher takes 10% off
    When I add 2 of "mug" to the basket
    And I apply the voucher "SAVE10"
    Then the basket total should be "8.10"

  Scenario Outline: Quantity limits
    When I add <qty> of "mug" to the basket
    Then I see the message "<message>"

    Examples:
      | qty | message          |
      | 0   | Choose a number  |
      | 101 | At most 100      |

  Scenario Outline: Not filled in yet
    When I add <qty> of "pen" to the basket
`;

test('a plan: each step reused (framework or project), new (with the closest existing step), or defined where the framework does not load it', () => {
    const c = planCoverage(PLAN, DEFS);
    assert.equal(c.feature, 'Basket discounts');
    assert.deepEqual(c.background.map((s) => [s.text, s.status, s.def?.builtIn]), [['user navigates to "/shop"', 'reused', true]]);
    assert.deepEqual(c.scenarios.map((s) => [s.name, s.outline, s.examples, s.tags]), [['A voucher takes 10% off', false, 0, ['@smoke']], ['Quantity limits', true, 2, []], ['Not filled in yet', true, 0, []]]);
    const [voucher, limits, empty] = c.scenarios;
    assert.deepEqual(voucher.steps.map((s) => s.status), ['reused', 'not-loaded', 'reused']);
    assert.equal(voucher.steps[1].def?.file, 'test/old/voucher.steps.ts');
    assert.deepEqual(limits.steps.map((s) => s.status), ['reused', 'new'], 'an outline step is reused when every Examples row matches');
    assert.deepEqual(empty.steps.map((s) => s.status), ['no-examples']);
    assert.deepEqual(c.counts, { scenarios: 3, steps: 7, reused: 4, new: 1, notLoaded: 1 }, 'distinct steps: one written once counts once');
    const near = planCoverage('Feature: x\n  Scenario: y\n    Then the basket total must be "1.00"\n', DEFS).scenarios[0].steps[0];
    assert.equal(near.status, 'new');
    assert.match(near.closest ?? '', /the basket total should be \{string\}/, 'worded much like an existing step: that one');
});

test('the plan review text: counts, each step marked, where reused steps come from', () => {
    const t = planSummary('test/shop/features/discounts.feature', planCoverage(PLAN, DEFS));
    assert.match(t, /3 scenarios, 7 distinct steps: 4 reused, 1 new, 1 in a folder not loaded/);
    assert.match(t, /✓ When I add 2 of "mug" to the basket {3}— test\/shop\/steps\/basket\.steps\.ts:7/);
    assert.match(t, /\+ Then I see the message "<message>" {3}— new step/);
    assert.match(t, /! And I apply the voucher "SAVE10" {3}— defined in test\/old\/voucher\.steps\.ts, which the framework does not load/);
    assert.match(t, /✓ Given user navigates to "\/shop" {3}— framework step/);
    assert.match(t, /Scenario Outline: Quantity limits \(2 example rows\)/);
    assert.match(t, /\? When I add <qty> of "pen" to the basket {3}— fill in the Examples/);
});

test('plan_submit: the person approves the plan (always asked), or it is revised; the feature as approved goes back to the agent', async () => {
    const asked: Array<{ title: string; detail: string; kind: string }> = [];
    let answer = false;
    let content = 'Feature: v1';
    const calls: string[] = [];
    const tools = Object.fromEntries(studioTools({
        repoRoot: '/tmp', browser: {} as any, context: () => null, appsDir: '/tmp/apps', changesNeedApproval: () => true,
        call: async (method, url) => {
            calls.push(`${method} ${url}`);
            if (url === '/api/lang/plan') return { status: 200, body: { summary: `review of ${content}`, coverage: { counts: { new: 1 } } } };
            if (url.startsWith('/api/file')) return { status: 200, body: { content } };
            return { status: 404, body: {} };
        },
        approve: async (title, detail, kind) => { asked.push({ title, detail, kind }); return answer; },
    }).map((t) => [t.name, t]));
    const r1 = await tools.plan_submit.handler({ feature: 'test/shop/features/discounts.feature', notes: 'Covers both criteria.' });
    assert.deepEqual([asked[0].title, asked[0].kind], ['Approve the test plan: test/shop/features/discounts.feature', 'plan']);
    assert.match(asked[0].detail, /^Covers both criteria\.\n\nreview of Feature: v1/);
    assert.match(String(r1), /did not approve the plan.*revise.*Do not write step definitions/s);
    answer = true; content = 'Feature: v2 (edited by the person)';
    const r2 = await tools.plan_submit.handler({ feature: 'test/shop/features/discounts.feature' }) as any;
    assert.equal(r2.approved, true);
    assert.equal(r2.feature, 'Feature: v2 (edited by the person)', 'the feature as it is after the review');
    assert.match(r2.next, /only the new steps/);
    assert.ok(isReadOnlyCall('POST', '/api/lang/plan', {}), 'agents may check a plan without asking');
});

test('plan routes: a plan checked against the project\'s steps; the story read from Azure DevOps; the style example from the configuration (simulated ADO)', async () => {
    const { createServer } = await import('../src/server/server');
    const { runGit } = await import('../src/git/run');
    const { SecretStore } = await import('../src/secrets/store');
    const { KeyFileProtector } = await import('../src/secrets/protector');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-srv-'));
    const dir = path.join(tmp, 'shop-tests');
    await runGit(['init', '-q', '-b', 'main', dir], { cwd: tmp });
    const w = (p: string, t: string) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), t); };
    w('config/global.env', 'ADO_ORGANIZATION=acme\nADO_PROJECT=qa\n');
    w('config/shop/common/common.env', 'PROJECT=shop\nSTEP_DEFINITIONS_PATH=test/shop/steps\nSTUDIO_SEED_FEATURE=test/shop/features/login.feature\n');
    w('config/shop/environments/dev.env', 'BASE_URL=http://localhost\n');
    w('test/shop/steps/basket.steps.ts', "export class S {\n    @CSBDDStepDef('I add {int} of {string} to the basket')\n    add() {}\n}\n");
    w('test/shop/features/login.feature', 'Feature: Login\n  Scenario: Works\n    When I add 1 of "mug" to the basket\n');
    w('test/shop/features/discounts.feature', 'Feature: Discounts\n  Scenario: Voucher\n    When I add 2 of "mug" to the basket\n    Then I see a 10% discount\n');
    const store = new SecretStore(path.join(tmp, 'home'), new KeyFileProtector(path.join(tmp, 'home', 'keys', 'secrets.key')));
    store.set({ name: 'ADO_PAT' }, 'pat-1');
    const transport = async (req: any) => {
        const u = new URL(req.url);
        if (u.pathname.endsWith('/_apis/wit/workitems/1234')) return { status: 200, body: JSON.stringify({ id: 1234, fields: { 'System.Title': 'Vouchers take money off', 'System.WorkItemType': 'User Story', 'System.State': 'Active', 'System.Description': '<p>As a shopper…</p>', 'Microsoft.VSTS.Common.AcceptanceCriteria': '<ul><li>SAVE10 takes 10% off</li><li>An expired voucher is refused</li></ul>' }, relations: [] }) };
        return { status: 404, body: '{"message":"not found"}' };
    };
    const srv = createServer({ repoRoot: dir, store, userName: 'T', adoTransport: transport, token: 'tk' });
    const call = async (method: string, url: string, payload?: unknown) => { const r = await srv.app.inject({ method: method as any, url, headers: { authorization: 'Bearer tk' }, ...(payload ? { payload: payload as any } : {}) }); return { status: r.statusCode, json: r.json() as any }; };

    const plan = await call('POST', '/api/lang/plan', { path: 'test/shop/features/discounts.feature' });
    assert.equal(plan.status, 200, JSON.stringify(plan.json));
    assert.deepEqual(plan.json.coverage.scenarios[0].steps.map((s: any) => s.status), ['reused', 'new']);
    assert.match(plan.json.summary, /1 reused, 1 new/);
    const edited = await call('POST', '/api/lang/plan', { path: 'test/shop/features/discounts.feature', content: 'Feature: D\n  Scenario: V\n    When I add 3 of "pen" to the basket\n' });
    assert.equal(edited.json.coverage.counts.new, 0, 'an unsaved version can be checked');
    assert.equal((await call('POST', '/api/lang/plan', { path: 'test/shop/steps/basket.steps.ts' })).status, 400);

    const ctx = await call('GET', '/api/agents/plan-context?project=shop&story=1234');
    assert.equal(ctx.status, 200, JSON.stringify(ctx.json));
    assert.deepEqual(ctx.json.features, ['test/shop/features/discounts.feature', 'test/shop/features/login.feature']);
    assert.equal(ctx.json.seed, 'test/shop/features/login.feature', 'STUDIO_SEED_FEATURE');
    assert.deepEqual([ctx.json.story.id, ctx.json.story.type, ctx.json.story.title], [1234, 'User Story', 'Vouchers take money off']);
    assert.match(ctx.json.story.acceptanceCriteria, /SAVE10 takes 10% off[\s\S]*expired voucher is refused/);
    assert.ok(!/<li>/.test(ctx.json.story.acceptanceCriteria), 'as text, not HTML');
    const missing = await call('GET', '/api/agents/plan-context?project=shop&story=99');
    assert.equal(missing.status, 200);
    assert.ok(missing.json.storyError && !missing.json.story, 'a work item that cannot be read: said, and the agent reads it itself');
    const text = await call('GET', '/api/agents/plan-context?project=shop&story=As%20a%20shopper');
    assert.equal(text.json.story, undefined, 'a written story: nothing to read');
    await srv.app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});
