import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as ts from 'typescript';
import { convertScript } from '../src/recorder/convert';
import { markedBreaks, plan } from '../src/recorder/generate';
import { checkPlan } from '../src/framework/standards';
import { patternToRegex } from '../src/lang/steps';
import type { ProjectContext } from '../src/framework/model';

const ctx = (over: Partial<ProjectContext> = {}): ProjectContext => ({
    project: 'shop', env: 'dev', featureFolder: 'test/shop/features', pagesFolder: 'test/shop/pages', stepsFolder: 'test/shop/steps', dataFolder: 'test/shop/data',
    pages: [], steps: [], files: {},
    config: { exists: true, common: { path: 'config/shop/common/common.env', text: '' }, envFile: { path: 'config/shop/environments/dev.env', text: 'BASE_URL=https://shop.test\n' }, values: { BASE_URL: 'https://shop.test' }, stepPath: null, stepsLoaded: true },
    ...over,
} as ProjectContext);

const CHECKOUT = `import { test, expect } from '@playwright/test';
test('t', async ({ page }) => {
  await page.goto('https://shop.test/checkout');
  await page.getByLabel('Name').fill('Ada');
  await page.getByLabel('Card number').fill('4111');
  await page.getByRole('button', { name: 'Pay' }).click();
  // cs-page https://shop.test/receipt
  await expect(page.getByTestId('receipt')).toContainText('Paid by Ada');
  await page.getByRole('link', { name: 'Back to shop' }).click();
});`;

/** The feature's step lines (without the keyword) and the step definitions' texts of a plan. */
const linesOf = (p: ReturnType<typeof plan>) => p.files.find((f) => f.kind === 'feature')!.text.split('\n').map((l) => l.trim()).filter((l) => /^(Given|When|Then|And) /.test(l));
const defsOf = (p: ReturnType<typeof plan>) => p.files.filter((f) => f.kind === 'steps').flatMap((f) => [...f.text.matchAll(/@CSBDDStepDef\('((?:[^'\\]|\\.)*)'\)/g)].map((m) => m[1]));

test('a reusable step: the steps of a range as one step, its values as parameters, its definition made of theirs', () => {
    const c = convertScript(ts, CHECKOUT);
    const p = plan(ts, c.actions, ctx(), { name: 'Checkout', breaks: markedBreaks(CHECKOUT, c.actions), blocks: [{ from: 1, to: 3, name: 'the user pays' }] });
    assert.deepEqual(p.warnings.filter((w) => /Reusable/.test(w)), []);
    assert.deepEqual(linesOf(p), [
        'Given the user opens the Checkout page',
        'When the user pays with "<name>" and "<cardNumber>"',
        'Then receipt should contain "<expectedReceipt>" on the Receipt page',
        'When the user clicks Back to shop link on the Receipt page',
    ]);
    // Its steps' own definitions are not written: only the reusable step uses them.
    const defs = defsOf(p);
    assert.ok(defs.includes('the user pays with {string} and {string}'));
    assert.ok(!defs.some((d) => /Card number field|Pay button/.test(d)), JSON.stringify(defs));
    const steps = p.files.find((f) => f.path === 'test/shop/steps/checkout.steps.ts')!.text;
    assert.match(steps, /async theUserPays\(name: string, cardNumber: string\): Promise<void> \{/);
    assert.match(steps, /\/\/ the user enters … in Name field on the Checkout page\n        \{\n            const value = name;\n            await this\.checkoutPage\.nameField\.fill\(value\);\n        \}/);
    assert.match(steps, /const value = cardNumber;\n            await this\.checkoutPage\.cardNumberField\.fill\(value\);/);
    assert.match(steps, /\{\n            await this\.checkoutPage\.payButton\.click\(\);\n        \}/);
    assert.doesNotMatch(p.files.filter((x) => x.kind === 'steps').map((x) => x.text).join('\n'), /const (\w+) = \1;/, 'no binding of a name to itself');
    // Every line has exactly one definition, the framework's check passes.
    const res = [...new Set(defs)].map(patternToRegex);
    for (const l of linesOf(p).map((x) => x.replace(/^\w+ /, '').replace(/"<\w+>"/g, '"x"'))) assert.equal(res.filter((r) => r.test(l)).length, 1, l);
    const f = checkPlan(ts, { title: 'x', warnings: [], files: p.files.map((x) => ({ path: x.path, kind: x.kind, text: x.text })) }, { ...ctx(), allSteps: [], loadedStepFolders: ['test/shop/steps'] } as never);
    assert.deepEqual(f.filter((x) => x.level === 'error').map((x) => x.message), []);
});

test('a reusable step over two pages injects both; its own text; one the project has is reused', () => {
    const c = convertScript(ts, CHECKOUT);
    const p = plan(ts, c.actions, ctx(), { name: 'Checkout', breaks: markedBreaks(CHECKOUT, c.actions), values: { 1: { mode: 'fixed' }, 2: { mode: 'fixed' } },
        blocks: [{ from: 2, to: 5, name: 'pay and go back', text: 'the user pays with card {string} and sees {string}' }] });
    assert.deepEqual(p.warnings.filter((w) => /Reusable/.test(w)), []);
    assert.ok(linesOf(p).includes('And the user pays with card "4111" and sees "Paid by Ada"'), JSON.stringify(linesOf(p)));
    const steps = p.files.find((f) => f.path === 'test/shop/steps/checkout.steps.ts')!.text;
    assert.match(steps, /import \{ ReceiptPage \} from '\.\.\/pages\/ReceiptPage';/);
    assert.match(steps, /@Page\('receipt'\)\n    private receiptPage!: ReceiptPage;/);
    assert.match(steps, /await this\.receiptPage\.backToShopLink\.click\(\);/);
    // The project has it now: the next recording with the same reusable step writes only the feature line.
    const p2 = plan(ts, c.actions, ctx({ steps: [{ pattern: 'the user pays with card {string} and sees {string}', regex: patternToRegex('the user pays with card {string} and sees {string}'), file: 'test/shop/steps/checkout.steps.ts', line: 1 } as never] }),
        { name: 'Checkout', breaks: markedBreaks(CHECKOUT, c.actions), values: { 1: { mode: 'fixed' }, 2: { mode: 'fixed' } }, blocks: [{ from: 2, to: 5, name: 'pay and go back', text: 'the user pays with card {string} and sees {string}' }] });
    assert.ok(!defsOf(p2).includes('the user pays with card {string} and sees {string}'), 'reused, not written again');
    assert.ok(p2.rows.filter((r) => r.block).every((r) => r.stepReused));
});

test('a reusable step cannot take a tab switch (a step of its own file): it is not made, with a reason', () => {
    const script = `import { test } from '@playwright/test';
test('t', async ({ page }) => {
  await page.goto('https://shop.test/');
  await page.getByRole('link', { name: 'Help' }).click();
  await cs.switchTab('new'); // https://shop.test/help
  // cs-page https://shop.test/help
  await page.getByRole('button', { name: 'Close' }).click();
});`;
    const c = convertScript(ts, script);
    const p = plan(ts, c.actions, ctx(), { name: 'Help', breaks: markedBreaks(script, c.actions), blocks: [{ from: 1, to: 3, name: 'the user reads the help' }] });
    assert.ok(p.warnings.some((w) => /Reusable step "the user reads the help": steps 2–4 include a step that cannot be part of it/.test(w)), JSON.stringify(p.warnings));
    assert.ok(linesOf(p).some((l) => /switches to the new tab/.test(l)), 'the steps stay as they were');
});
