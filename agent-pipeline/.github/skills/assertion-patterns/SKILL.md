---
name: assertion-patterns
description: >
  Canonical patterns for assertions in the target test framework.
  Covers the CSAssert singleton and its methods (assertTrue,
  assertFalse, assertEqual, assertNotEqual, assertContains,
  assertVisible, assertNotVisible, assertText, assertUrl,
  assertTitle, assertWithScreenshot), soft vs hard mode via
  CSExpect, where assertions belong (page object verification
  methods vs step definitions), await discipline, and forbidden
  patterns. Load when generating, auditing, or healing code that
  makes assertions.
---

# Assertion Patterns

## When this skill applies

Any generated code that verifies expected behaviour — page
object verification methods, step definition `Then` steps, and
helper validation methods. This skill covers which assertion
class to use, which method to call, and how to handle soft vs
hard failure modes.

## The CSAssert singleton

`CSAssert.getInstance()` returns the assertion singleton. All
methods are async and must be awaited.

```
import { CSAssert } from '<framework>/assertions';

const assert = CSAssert.getInstance();
await assert.assertEqual(actual, expected, 'Helpful message');
```

Inside a step definition, either obtain the singleton once as a
private field or call it inline:

```
@Then('the order id should be {string}')
async verifyOrderId(expected: string): Promise<void> {
    const actual = await this.orderPage.getOrderId();
    await CSAssert.getInstance().assertEqual(
        actual,
        expected,
        `Order id should be ${expected}`
    );
}
```

## Core assertion methods

All are async on `CSAssert.getInstance()`:

### assertTrue / assertFalse — boolean

```
await assert.assertTrue(
    condition,
    'Message describing what should be true'
);

await assert.assertFalse(
    condition,
    'Message describing what should be false'
);
```

Use for boolean conditions that don't fit another method.

### assertEqual / assertNotEqual — value equality

```
await assert.assertEqual(
    actual,
    expected,
    'Message describing what should be equal'
);
```

Uses strict equality for primitives and deep equality for
objects. The first argument is the actual, the second is the
expected — order matters for error messages.

Note the method name is singular (`assertEqual`, not
`assertEquals`).

### assertContains — substring / element containment

```
await assert.assertContains(
    haystack,
    needle,
    'Message describing what should contain what'
);
```

Works on strings (substring match) and arrays (element match).

### assertVisible / assertNotVisible — element visibility

```
await assert.assertVisible(
    this.orderPage.headerOrderDetail,
    'Order detail header should be visible'
);

await assert.assertNotVisible(
    this.orderPage.buttonDelete,
    'Delete button should not be visible for read-only users'
);
```

The first argument is a `CSWebElement`. The assertion waits
briefly for the element state before failing.

### assertText — element text content

```
await assert.assertText(
    this.orderPage.labelStatus,
    'Confirmed',
    'Order status label should read Confirmed'
);
```

Compares the element's text content against an expected
string. Trims whitespace by default.

### assertUrl / assertTitle — page-level

```
await assert.assertUrl(
    /\/orders\/\d+/,
    'URL should match the order detail pattern'
);

await assert.assertTitle(
    'Order Details',
    'Page title should be "Order Details"'
);
```

Accepts either a string (exact match) or a regex (pattern
match) for the first argument.

### assertNull / assertNotNull — null / undefined checks

```
await assert.assertNull(
    errorMessage,
    'Error message should not be set'
);

await assert.assertNotNull(
    user,
    'User should be found in the database'
);
```

### assertWithScreenshot — assertion with captured screenshot

```
const finalBalance = await assert.assertWithScreenshot(
    async () => await this.accountPage.getBalance(),
    (balance) => balance > 0,
    'Account balance should be positive'
);
```

Captures a screenshot when the assertion fails. Use for
critical assertions where visual context helps debugging. The
first parameter is a function that produces the value; the
second is a validator.

## Soft vs hard assertion mode

By default, assertions are HARD — the first failure throws and
the test stops. For scenarios where you want to collect all
failures and report them at the end, switch to SOFT mode via
`CSExpect`:

```
import { CSExpect } from '<framework>/assertions';

const expect = CSExpect.getInstance();
expect.enableSoftMode();

await assert.assertEqual(row.status, 'OPEN', 'Status should be OPEN');
await assert.assertEqual(row.amount, 100, 'Amount should be 100');
await assert.assertEqual(row.currency, 'USD', 'Currency should be USD');

// Collect all soft failures and fail the test once
await expect.assertAllSoft();
```

Use soft mode when:
- Verifying multiple properties of the same object (don't want
  the first mismatch to mask later ones)
- Running through a table of expected values where each row is
  independent
- Doing exploratory assertions where you want a full picture

Do NOT use soft mode when:
- The test has dependencies between assertions (if A fails,
  asserting B is meaningless)
- The first assertion result changes what the next action
  should be

Disable soft mode explicitly when returning to hard assertions:

```
expect.disableSoftMode();
```

## Where assertions belong

### Page-level verifications → page object

Assertions about the page's own state live on the page object
as verification methods:

```
public async verifyHeader(): Promise<void> {
    await this.headerPageTitle.waitForVisible(15000);
    const actual = await this.headerPageTitle.getTextContent();
    await CSAssert.getInstance().assertEqual(
        (actual ?? '').trim(),
        'Order Details',
        'Header should read "Order Details"'
    );
}

public async verifyFormReadOnly(): Promise<void> {
    const violations: string[] = [];
    if (!(await this.textBoxOrderId.isDisabled())) {
        violations.push('Order ID should be disabled');
    }
    if (!(await this.textBoxCustomer.isDisabled())) {
        violations.push('Customer should be disabled');
    }
    if (await this.buttonSave.isVisible()) {
        violations.push('Save button should not be visible');
    }
    await CSAssert.getInstance().assertTrue(
        violations.length === 0,
        `Form read-only violations: ${violations.join(', ')}`
    );
}
```

### Cross-page or business-outcome verifications → step definition

Assertions that span multiple pages, or that assert on data
retrieved from a database or API, belong in the step
definition:

```
@Then('the order should be persisted in the database')
async verifyOrderPersisted(): Promise<void> {
    const orderId = this.context.get<string>('createdOrderId');
    const dbOrder = await OrderDatabaseHelper.findById(orderId);
    await CSAssert.getInstance().assertNotNull(
        dbOrder,
        `Order ${orderId} should exist in the database`
    );
    await CSAssert.getInstance().assertEqual(
        dbOrder!.status,
        'OPEN',
        'Order status should be OPEN in the database'
    );
}
```

### Helper validations

Helpers may contain validation methods when the validation
logic is reused across many scenarios:

```
export class OrderValidationHelper {
    public static async verifyOrderMatchesSpec(
        actual: OrderRecord,
        expected: Partial<OrderRecord>
    ): Promise<void> {
        const assert = CSAssert.getInstance();
        if (expected.orderId !== undefined) {
            await assert.assertEqual(actual.orderId, expected.orderId,
                'Order ID');
        }
        if (expected.status !== undefined) {
            await assert.assertEqual(actual.status, expected.status,
                'Order status');
        }
        // ... more fields
    }
}
```

## Await discipline

Every `CSAssert` method is async. Forgetting to `await` an
assertion makes it a no-op — the assertion runs in a detached
promise, and if it fails, the failure is swallowed.

```
// WRONG — assertion result is ignored, test passes even on failure
CSAssert.getInstance().assertEqual(actual, expected, 'msg');

// CORRECT
await CSAssert.getInstance().assertEqual(actual, expected, 'msg');
```

The audit rejects any `CSAssert` call without a preceding
`await`.

## Assertion message discipline

Every assertion takes a message as the last parameter. The
message should:

- Describe what was expected in plain English
- Include enough context to diagnose a failure without re-running
- Not repeat the actual and expected values (the assertion
  method does that)

Good messages:
- `'Order status should be OPEN for a newly created order'`
- `'Grid should have at least one row after search'`
- `'Header text should match "Order Details"'`

Bad messages:
- `'assertEqual failed'`
- `'expected X got Y'`
- `''` (empty — audit rejects this)

## Framework element-state assertions vs manual checks

When asserting on element state, prefer the dedicated methods:

```
// Preferred — semantic, reports element description
await CSAssert.getInstance().assertVisible(
    this.orderPage.headerOrderDetail,
    'Order detail header should be visible'
);

// Acceptable but less clean
const visible = await this.orderPage.headerOrderDetail.isVisible();
await CSAssert.getInstance().assertTrue(
    visible,
    'Order detail header should be visible'
);
```

The dedicated methods (`assertVisible`, `assertNotVisible`,
`assertText`) report the element's description in the failure
message, which the manual check does not.

## Negative assertions

For "should not" assertions, use the `Not` variant instead of
negating a positive check:

```
// Preferred
await assert.assertNotVisible(
    this.orderPage.buttonDelete,
    'Delete button should not be visible for read-only users'
);
await assert.assertNotEqual(
    actual,
    forbiddenValue,
    'Value should not match the forbidden value'
);

// Less preferred — harder to read in a failure log
await assert.assertFalse(
    await this.orderPage.buttonDelete.isVisible(),
    'Delete button should not be visible'
);
```

## Forbidden patterns

Never do any of these in assertion code:

- Use `CSAssert.assertTrue(...)` as a static call — always
  `CSAssert.getInstance().assertTrue(...)`
- Forget to `await` an async assertion
- Use `assert` from Node.js built-ins — use `CSAssert`
- Use `expect(...)` from raw Playwright — use `CSAssert` or
  `CSExpect` from the framework
- Use `console.assert(...)` — use `CSAssert`
- Write empty assertion messages
- Mix up actual and expected parameter order
- Check equality with `===` inside `assertTrue(a === b, ...)`
  — use `assertEqual(a, b, ...)` instead
- Wrap an assertion in a try/catch that swallows the error
- Use hard assertion inside a soft block or vice versa (they
  don't mix)
- Assert on element visibility without awaiting the element
  first (can race with DOM updates)

## Self-check before returning assertion code

- [ ] Every assertion uses `CSAssert.getInstance().assert*` or
      `CSExpect.getInstance()`
- [ ] Every async assertion is awaited
- [ ] Method name is correct (`assertEqual` singular, not
      `assertEquals`)
- [ ] Parameter order is `actual, expected, message`
- [ ] Messages are descriptive and non-empty
- [ ] Dedicated element-state methods (`assertVisible`,
      `assertText`) preferred over manual state checks
- [ ] Negative assertions use `Not` variants
- [ ] Soft mode is used only when failures are independent
- [ ] `expect.assertAllSoft()` is called at the end of any soft
      block
- [ ] No raw Playwright `expect()` or Node `assert`
- [ ] No `try/catch` around assertions that swallows failures

If any item fails, fix it before returning. The audit checklist
tool enforces most of these rules.
