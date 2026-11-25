import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { classNameFor, ensureImports, generateStep, insertStep, StepGenError } from '../src/lang/stepGen';
import { extractStepDefs, checkFeature } from '../src/lang/steps';

test('patterns and parameters follow the framework (CSBDDDecorators.patternToRegex)', () => {
    const a = generateStep('I enter "admin" in the "Username" field');
    assert.equal(a.pattern, 'I enter {string} in the {string} field');
    assert.deepEqual(a.params.map((p) => `${p.name}:${p.type}`), ['text:string', 'username:string']);
    assert.equal(a.methodName, 'enterField');
    const b = generateStep('I add 3 items costing 19.99 to order ORD-42');
    // Like Cucumber's snippets, a number at the end of an id becomes a parameter.
    assert.equal(b.pattern, 'I add {int} items costing {float} to order ORD-{int}');
    assert.deepEqual(b.params.map((p) => p.type), ['number', 'number', 'number']);
    assert.deepEqual(b.params.map((p) => p.name), ['items', 'costing', 'ord']);
    // Apostrophes are not quotes; digits inside words stay literal.
    const c = generateStep("the user doesn't see page2 for 'Gold' members");
    assert.equal(c.pattern, "the user doesn't see page2 for {string} members");
    // Outline: quoted and bare placeholders, typed from the Examples values.
    const d = generateStep('I order <qty> of "<product>" as <tier>', { variants: ['I order 2 of "Pen" as gold', 'I order 10 of "Ink pot" as silver'] });
    assert.equal(d.pattern, 'I order {int} of {string} as {word}');
    assert.deepEqual(d.params.map((p) => `${p.name}:${p.type}`), ['qty:number', 'product:string', 'tier:string']);
    assert.throws(() => generateStep('I log in as <user>', { variants: ['I log in as John Smith'] }), StepGenError);
    // Tables and doc strings add the trailing argument.
    assert.deepEqual(generateStep('these orders exist', { dataTable: true }).params, [{ name: 'dataTable', type: 'DataTable' }]);
    assert.deepEqual(generateStep('the request body is', { docString: true }).params, [{ name: 'docString', type: 'string' }]);
    assert.equal(classNameFor('order-search.feature'), 'OrderSearchSteps');
});

test('inserting into an existing step class keeps the file and is picked up as a definition', () => {
    const file = [
        "import { CSBDDStepDef, StepDefinitions } from '@mdakhan.mak/cs-playwright-test-framework/bdd';",
        "import { OrdersPage } from '../pages/OrdersPage';",
        '',
        '@StepDefinitions',
        'export class OrdersSteps {',
        "    private readonly brace = '}'; // a brace in a string",
        '    /* } in a comment */',
        "    @CSBDDStepDef('I open order {string}')",
        '    async openOrder(id: string): Promise<void> {',
        '        if (id) { return; }',
        '    }',
        '}',
        '',
        'export function helper() { return 1; }',
        '',
    ].join('\r\n');
    const g = generateStep('these orders exist', { dataTable: true });
    const r = insertStep(file, g, 'these orders exist', 'X');
    assert.ok(r.content.includes('\r\n') && !/[^\r]\n/.test(r.content), 'keeps CRLF');
    assert.match(r.content, /import \{ CSBDDStepDef, StepDefinitions, DataTable \} from '@mdakhan\.mak\/cs-playwright-test-framework\/bdd';/);
    const lines = r.content.split('\r\n');
    assert.equal(lines[r.line - 1].trim(), "@CSBDDStepDef('these orders exist')");
    // Inside the class: before its closing brace, and helper() untouched after it.
    const close = lines.findIndex((l, i) => i > r.line && l === '}');
    assert.ok(close > r.line && lines.slice(close + 1).join('\n').includes('export function helper()'));
    const defs = extractStepDefs(r.content, 's.ts', false);
    assert.deepEqual(defs.map((d) => d.pattern), ['I open order {string}', 'these orders exist']);
    assert.deepEqual(checkFeature('Feature: f\nScenario: s\nGiven these orders exist\n| a |', defs), []);
    // Same method name twice gets a suffix.
    const r2 = insertStep(r.content, generateStep('these orders exist now'), 'these orders exist now', 'X');
    assert.ok(/async theseOrdersExistNow\(/.test(r2.content) || /async ordersExistNow\(/.test(r2.content));
});

test('a new step file and a file without the import', () => {
    const r = insertStep(null, generateStep('I open the "Orders" page'), 'I open the "Orders" page', 'OrdersSteps');
    assert.match(r.content, /^import \{ CSBDDStepDef, StepDefinitions \} from '@mdakhan\.mak\/cs-playwright-test-framework\/bdd';\n\n@StepDefinitions\nexport class OrdersSteps \{/);
    assert.equal(r.content.split('\n')[r.line - 1].trim(), "@CSBDDStepDef('I open the {string} page')");
    const t = ensureImports("import { x } from './x';\n\nconst a = 1;\n", ['CSBDDStepDef'], '\n');
    assert.equal(t, "import { x } from './x';\nimport { CSBDDStepDef } from '@mdakhan.mak/cs-playwright-test-framework/bdd';\n\nconst a = 1;\n");
});

test('parameter names read naturally', () => {
    const names = (t: string) => generateStep(t).params.map((p) => p.name);
    assert.deepEqual(names('I search orders for "ACME"'), ['text']);
    assert.deepEqual(names('the customer "ACME" has 3 open orders'), ['customer', 'orders']);
    assert.deepEqual(names('I click the "Place order" button'), ['placeOrder']);
});
