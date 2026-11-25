import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { formatGherkin, renamedDefLine, renamedStepText, renameProblem, writtenRegex } from '../src/lang/stepRefactor';
import type { StepDef } from '../src/lang/steps';

const def = (pattern: string, file = 'a.steps.ts', line = 1): StepDef => ({ pattern, file, line, builtIn: false } as unknown as StepDef);

test('step rename: each step keeps its own values; Outline placeholders; refusals', () => {
    assert.ok(writtenRegex('I add {int} of {string}').test('I add <qty> of "pen"'));
    assert.ok(!writtenRegex('I add {int} of {string}').test('I add many of "pen"'));
    assert.equal(renamedStepText('I add {int} of {string}', 'I put {int} items of {string} in the basket', 'I add 3 of "blue pen"'), 'I put 3 items of "blue pen" in the basket');
    assert.equal(renamedStepText('I add {int} of {string}', 'I put {int} items of {string} in the basket', 'I add <qty> of <item>'), 'I put <qty> items of <item> in the basket');
    assert.equal(renamedStepText('I add {int} of {string}', 'x {int} {string}', 'something else'), null);
    assert.equal(renamedDefLine(`    @CSBDDStepDef('I add {int} of {string}')`, 'I add {int} of {string}', 'I put {int} of {string}'), `    @CSBDDStepDef('I put {int} of {string}')`);
    assert.equal(renamedDefLine(`    @CSBDDStepDef("I add {int} of {string}")`, 'I add {int} of {string}', `it's {int} of {string}`), `    @CSBDDStepDef("it's {int} of {string}")`);
    const all = [def('I add {int} of {string}'), def('I see the basket', 'b.steps.ts')];
    assert.match(renameProblem('I add {int} of {string}', 'I add {string} of {int}', all)!, /same values in the same order: \{int\}, \{string\}/);
    assert.match(renameProblem('I add {int} of {string}', 'I add {int}', all)!, /same values/);
    assert.match(renameProblem('I add {int} of {string}', 'I add {int} of {string}', all)!, /did not change/);
    assert.match(renameProblem('I add {int} of {string}', '  ', all)!, /empty/);
    assert.match(renameProblem('I add {int} of {string}', 'I add {int} of {string} now', [...all, def('I add {int} of {string} now', 'c.steps.ts', 9)])!, /A step with this wording exists: c\.steps\.ts:9/);
    assert.equal(renameProblem('I add {int} of {string}', 'I put {int} of {string}', all), null);
});

test('Gherkin formatter: indentation by structure, aligned tables (numbers to the right), doc strings, comments and tags kept', () => {
    const src = [
        '@smoke',
        'Feature: Basket',
        'Some description',
        '  Background:',
        'Given I log in',
        ' Scenario Outline: Add',
        '      When I add <qty> of "<item>"',
        '  # a comment',
        '   Then I see:',
        '"""',
        '  kept as written',
        '"""',
        'Examples:',
        '| qty | item |',
        '|1|pen|',
        '|  12 |  long item name |',
    ].join('\n') + '\n';
    const out = formatGherkin(src);
    assert.equal(out, [
        '@smoke',
        'Feature: Basket',
        '  Some description',
        '  Background:',
        '    Given I log in',
        '  Scenario Outline: Add',
        '    When I add <qty> of "<item>"',
        '    # a comment',
        '    Then I see:',
        '      """',
        '        kept as written',
        '      """',
        '    Examples:',
        '      | qty | item           |',
        '      |   1 | pen            |',
        '      |  12 | long item name |',
    ].join('\n') + '\n');
    assert.equal(formatGherkin(out), out, 'formatting twice changes nothing');
});

test('step usages and rename through the Studio: only the feature project\'s steps; preview, then apply to saved files', async () => {
    const { createServer } = await import('../src/server/server');
    const { SecretStore } = await import('../src/secrets/store');
    const { KeyFileProtector } = await import('../src/secrets/protector');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-ref-'));
    const dir = path.join(tmp, 'repo');
    const home = path.join(tmp, 'home');
    const w = (p: string, t: string) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), t); };
    const r = (p: string) => fs.readFileSync(path.join(dir, p), 'utf8');
    for (const p of ['shop', 'admin']) {
        w(`config/${p}/common/common.env`, `PROJECT=${p}\nSTEP_DEFINITIONS_PATH=test/${p}/steps\n`);
        w(`config/${p}/environments/dev.env`, 'BASE_URL=http://localhost\n');
    }
    const shopSteps = `export class BasketSteps {\n    @CSBDDStepDef('I add {int} of {string}')\n    async add(n: number, item: string) {}\n\n    @CSBDDStepDef('I see the basket')\n    async see() {}\n}\n`;
    w('test/shop/steps/basket.steps.ts', shopSteps);
    w('test/admin/steps/basket.steps.ts', `export class AdminSteps {\n    @CSBDDStepDef('I add {int} of {string}')\n    async add(n: number, item: string) {}\n}\n`);
    w('test/shop/features/basket.feature', 'Feature: Basket\n  Scenario: One\n    Given I add 2 of "pen"\n    Then I see the basket\n\n  Scenario Outline: Many\n    When I add <qty> of <item>\n    Examples:\n      | qty | item  |\n      | 1   | "cup" |\n');
    w('test/shop/features/other.feature', 'Feature: Other\n  Scenario: x\n    And I add 10 of \'box\'\n');
    w('test/admin/features/admin.feature', 'Feature: Admin\n  Scenario: a\n    Given I add 1 of "chair"\n');
    const store = new SecretStore(home, new KeyFileProtector(path.join(home, 'keys', 'secrets.key')));
    const srv = createServer({ repoRoot: dir, store, userName: 'T', token: 't', home });
    const { url } = await srv.listen(0);
    const base = new URL(url).origin;
    const call = async (p: string, b: unknown) => {
        const x = await fetch(base + p, { method: 'POST', headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
        return { status: x.status, body: await x.json() as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
    };
    const offsetIn = (text: string, s: string) => text.indexOf(s) + 2;
    try {
        // From the definition: usages in the shop project only (the admin project has its own step).
        const u = await call('/api/lang/step-usages', { path: 'test/shop/steps/basket.steps.ts', content: shopSteps, offset: offsetIn(shopSteps, "@CSBDDStepDef('I add") });
        assert.equal(u.status, 200, JSON.stringify(u.body));
        assert.equal(u.body.step.pattern, 'I add {int} of {string}');
        assert.deepEqual(u.body.usages.map((x: { path: string; line: number }) => `${x.path}:${x.line}`), ['test/shop/features/basket.feature:3', 'test/shop/features/basket.feature:7', 'test/shop/features/other.feature:3']);
        // From a feature step: the same.
        const feat = r('test/shop/features/basket.feature');
        const u2 = await call('/api/lang/step-usages', { path: 'test/shop/features/basket.feature', content: feat, offset: offsetIn(feat, 'I add 2') });
        assert.equal(u2.body.usages.length, 3);
        assert.match((await call('/api/lang/step-usages', { path: 'test/shop/features/basket.feature', content: feat, offset: 2 })).body.error, /No step definition/);

        // Rename: refused for unsaved text and a change of values.
        const at = offsetIn(shopSteps, "@CSBDDStepDef('I add");
        assert.match((await call('/api/lang/step-rename', { path: 'test/shop/steps/basket.steps.ts', content: shopSteps + '// edit', offset: at, pattern: 'x {int} {string}' })).body.error, /Save the file first/);
        assert.match((await call('/api/lang/step-rename', { path: 'test/shop/steps/basket.steps.ts', content: shopSteps, offset: at, pattern: 'I add {string}' })).body.error, /same values/);
        // Preview: nothing written.
        const np = 'I put {int} items of {string} in the basket';
        const pv = await call('/api/lang/step-rename', { path: 'test/shop/steps/basket.steps.ts', content: shopSteps, offset: at, pattern: np });
        assert.equal(pv.status, 200, JSON.stringify(pv.body));
        assert.deepEqual(pv.body.changes.map((c: { path: string; after: string }) => `${c.path}: ${c.after.trim()}`), [
            "test/shop/steps/basket.steps.ts: @CSBDDStepDef('I put {int} items of {string} in the basket')",
            'test/shop/features/basket.feature: Given I put 2 items of "pen" in the basket',
            'test/shop/features/basket.feature: When I put <qty> items of <item> in the basket',
            "test/shop/features/other.feature: And I put 10 items of 'box' in the basket",
        ].sort((a, b) => a.localeCompare(b)).sort((a, b) => (a.includes('steps.ts') ? -1 : b.includes('steps.ts') ? 1 : 0)));
        assert.equal(r('test/shop/steps/basket.steps.ts'), shopSteps);
        // Apply.
        const ap = await call('/api/lang/step-rename', { path: 'test/shop/steps/basket.steps.ts', content: shopSteps, offset: at, pattern: np, apply: true });
        assert.equal(ap.status, 200, JSON.stringify(ap.body));
        assert.match(r('test/shop/steps/basket.steps.ts'), /@CSBDDStepDef\('I put \{int\} items of \{string\} in the basket'\)/);
        assert.match(r('test/shop/features/basket.feature'), /Given I put 2 items of "pen" in the basket\n    Then I see the basket/);
        assert.match(r('test/shop/features/basket.feature'), /When I put <qty> items of <item> in the basket/);
        assert.match(r('test/shop/features/other.feature'), /And I put 10 items of 'box' in the basket/);
        assert.match(r('test/admin/features/admin.feature'), /Given I add 1 of "chair"/, 'the other project is untouched');
        assert.match(r('test/admin/steps/basket.steps.ts'), /'I add \{int\} of \{string\}'/);
        // The usages follow the new wording.
        const now = r('test/shop/steps/basket.steps.ts');
        assert.equal((await call('/api/lang/step-usages', { path: 'test/shop/steps/basket.steps.ts', content: now, offset: offsetIn(now, "@CSBDDStepDef('I put") })).body.usages.length, 3);
        // Formatting a feature.
        const f = await call('/api/lang/format', { path: 'test/shop/features/other.feature', content: 'Feature: Other\nScenario: x\nAnd I add 1 of "a"\n' });
        assert.equal(f.body.content, 'Feature: Other\n  Scenario: x\n    And I add 1 of "a"\n');
    } finally {
        await srv.app.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});
