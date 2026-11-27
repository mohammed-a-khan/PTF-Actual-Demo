import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';
import { groupHeals, healedOption, healsInReport, HealEvent, proposeEdit, filesDeclaring } from '../src/quality/healing';

const PAGE = `import { CSBasePage, CSPage, CSGetElement } from '@example.org/cs-playwright-test-framework/core';
import { CSWebElement } from '@example.org/cs-playwright-test-framework/element';

@CSPage('orders')
export class OrdersPage extends CSBasePage {
    @CSGetElement({ css: '#search-input', description: 'Order number field', alternativeLocators: ['testId:order-search', 'xpath://input[@name="orderNo"]'] })
    public orderNumber!: CSWebElement;

    @CSGetElement({
        css: 'button#find',
        xpath: '//button[@id="find"]',
        description: 'Find button',
        selfHeal: true
    })
    public findButton!: CSWebElement;

    @CSGetElement({ description: 'Only text', text: 'Export', alternativeLocators: ['testId:export'] })
    public exportButton!: CSWebElement;

    protected initializeElements(): void {}
}
`;

test('healedOption: alternatives by prefix, selectors from the engine as css', () => {
    assert.deepEqual(healedOption('testId:order-search'), { key: 'testId', value: 'order-search' });
    assert.deepEqual(healedOption('class:btn primary'), { key: 'className', value: 'btn primary' });
    assert.deepEqual(healedOption('xpath://input[@id="q"]'), { key: 'xpath', value: '//input[@id="q"]' });
    assert.deepEqual(healedOption('#find-btn'), { key: 'css', value: '#find-btn' });
    assert.deepEqual(healedOption('button:has-text("Find order")'), { key: 'css', value: 'button:has-text("Find order")' });
    assert.deepEqual(healedOption('//button[1]'), { key: 'xpath', value: '//button[1]' });
});

test('proposeEdit: the healed locator replaces the locator options; the used alternative leaves the list', () => {
    const a = proposeEdit(ts, PAGE, 'OrdersPage', 'orderNumber', 'testId:order-search')!;
    assert.equal(a.line, 6);
    assert.equal(a.after, `@CSGetElement({ testId: 'order-search', description: 'Order number field', alternativeLocators: ['xpath://input[@name="orderNo"]'] })`);
    // Several locator options on several lines: the first becomes the healed one, the others go
    const b = proposeEdit(ts, PAGE, 'OrdersPage', 'findButton', '#find-btn')!;
    assert.equal(b.after, `@CSGetElement({\n        css: '#find-btn',\n        description: 'Find button',\n        selfHeal: true\n    })`);
    // The only alternative used: the list goes; the rest of the file is unchanged
    const c = proposeEdit(ts, PAGE, 'OrdersPage', 'exportButton', 'testId:export')!;
    assert.equal(c.after, `@CSGetElement({ description: 'Only text', testId: 'export' })`);
    assert.equal(c.text.replace(c.after, c.before), PAGE);
    // Quotes in the value
    assert.match(proposeEdit(ts, PAGE, 'OrdersPage', 'findButton', "button:has-text('Find')")!.after, /css: 'button:has-text\(\\'Find\\'\)'/);
    // The new text still parses as the same class
    assert.equal((ts.createSourceFile('x.ts', b.text, ts.ScriptTarget.Latest, true) as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics.length, 0);
    assert.equal(proposeEdit(ts, PAGE, 'OrdersPage', 'nope', '#x'), null);
    assert.equal(proposeEdit(ts, PAGE, 'OtherPage', 'findButton', '#x'), null);
});

const ev = (over: Partial<HealEvent>): HealEvent => ({ run: 'r1', at: '2026-11-01T10:00:00.000Z', scenario: 'Find an order', feature: 'Orders', step: 'When I search', element: 'Find button', pageClass: 'OrdersPage', property: 'findButton', original: 'button#find', healed: '#find-btn', strategy: 'fuzzy-text', confidence: 80, ...over });

test('healsInReport: reads every heal of every step (and the single healing of older reports)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-'));
    const f = path.join(dir, 'report-data.json');
    fs.writeFileSync(f, JSON.stringify({ suite: { scenarios: [{ name: 'Find an order', feature: 'Orders', steps: [
        { name: 'When I search', aiData: { healings: [{ success: true, strategy: 'alternative', confidence: 1, originalLocator: '#search-input', healedLocator: 'testId:order-search', element: 'Order number field', pageClass: 'OrdersPage', property: 'orderNumber' }, { success: true, strategy: 'fuzzy-text', confidence: 0.8, originalLocator: 'button#find', healedLocator: '#find-btn', element: 'Find button', pageClass: 'OrdersPage', property: 'findButton' }] } },
        { name: 'Then old report', aiData: { healing: { success: true, strategy: 'alternative', confidence: 1, originalLocator: '#a', healedLocator: 'css:#b' } } },
        { name: 'Then failed heal', aiData: { healing: { success: false, originalLocator: '#c' } } },
    ] }] } }));
    const h = healsInReport(f, { id: 'r1', at: '2026-11-01T10:00:00.000Z' });
    assert.equal(h.length, 3);
    assert.equal(h[1].confidence, 80);
    assert.equal(h[1].property, 'findButton');
    assert.equal(h[2].pageClass, undefined);
    assert.equal(h[2].element, '#a');
    fs.rmSync(dir, { recursive: true, force: true });
});

test('groupHeals: per element, suggestion, review / applied / confirmed / dismissed', () => {
    const info = new Map([['r1', { project: 'shop', env: 'dev' }]]);
    const events = [ev({}), ev({ run: 'r2', at: '2026-11-02T10:00:00.000Z' }), ev({ run: 'r3', at: '2026-11-03T10:00:00.000Z', healed: 'button:has-text("Find order")' })];
    let g = groupHeals(events, {}, [], info)[0];
    assert.equal(g.key, 'OrdersPage.findButton');
    assert.equal(g.healed, '#find-btn');
    assert.deepEqual(g.variants.map((v) => v.count), [2, 1]);
    assert.equal(g.runs, 3);
    assert.equal(g.status, 'review');
    assert.deepEqual(g.scenarios[0], { name: 'Find an order', feature: 'Orders' });
    // Applied after the heals: waiting for a run, then confirmed by a run of the scenario without the heal
    const applied = { 'OrdersPage.findButton': { healed: '#find-btn', action: 'applied' as const, at: '2026-11-04T00:00:00.000Z' } };
    assert.equal(groupHeals(events, applied, [], info)[0].status, 'applied');
    assert.equal(groupHeals(events, applied, [{ at: '2026-11-05T00:00:00.000Z', scenarios: new Set(['Find an order']) }], info)[0].status, 'confirmed');
    // Where it was changed: kept with the update (file, line, the line before and after)
    const withWhere = { 'OrdersPage.findButton': { ...applied['OrdersPage.findButton'], file: 'test/shop/pages/OrdersPage.ts', line: 7, before: "@CSGetElement({ css: '#find' })", after: "@CSGetElement({ css: '#find-btn' })" } };
    assert.deepEqual(groupHeals(events, withWhere, [], info)[0].change, { file: 'test/shop/pages/OrdersPage.ts', at: '2026-11-04T00:00:00.000Z', healed: '#find-btn', line: 7, before: "@CSGetElement({ css: '#find' })", after: "@CSGetElement({ css: '#find-btn' })" });
    assert.equal(groupHeals(events, applied, [], info)[0].change, undefined, 'no file recorded: nothing to show');
    // It healed again after the change: up for review
    assert.equal(groupHeals([...events, ev({ run: 'r6', at: '2026-11-06T00:00:00.000Z' })], applied, [], info)[0].status, 'review');
    // Dismissed, until it heals to another locator later
    const dismissed = { 'OrdersPage.findButton': { healed: '#find-btn', action: 'dismissed' as const, at: '2026-11-04T00:00:00.000Z' } };
    assert.equal(groupHeals(events, dismissed, [], info)[0].status, 'dismissed');
    assert.equal(groupHeals([...events, ev({ run: 'r6', at: '2026-11-06T00:00:00.000Z' })], dismissed, [], info)[0].status, 'dismissed');
    assert.equal(groupHeals([...events, ev({ run: 'r6', at: '2026-11-06T00:00:00.000Z', healed: '#other' })], dismissed, [], info)[0].status, 'review');
});

test('filesDeclaring: the page class in TypeScript files of the repository only', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-src-'));
    const put = (f: string, t: string) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), t); };
    put('test/shop/pages/OrdersPage.ts', PAGE);
    put('node_modules/x/OrdersPage.ts', PAGE);
    put('test/shop/pages/OrdersPageExtra.ts', 'export class OrdersPageExtra {}');
    assert.deepEqual(filesDeclaring(root, 'OrdersPage'), ['test/shop/pages/OrdersPage.ts']);
    fs.rmSync(root, { recursive: true, force: true });
});
