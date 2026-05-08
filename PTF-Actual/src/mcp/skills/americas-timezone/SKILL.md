---
name: americas-timezone
description: Use whenever generated test code computes a date or time. Use CSDateTimeUtility — the framework default is America/New_York. Never use raw new Date() / Date.now(). Pairs with audit rule DT100.
---

# Pattern: date/time in Americas timezone

## When to use

Any scenario that generates a unique ID with timestamp, asserts on a
displayed date / time, computes a future date for a payment, validates
a "created at" backend record, or formats a date for an input field.
The framework's `CSDateTimeUtility` defaults to `America/New_York` —
the canonical timezone for Americas-only deployments. Tests that emit
UTC or system-local timestamps produce false negatives when comparing
against backend records that are stored in Americas time.

## Working example

```typescript
import {
    CSBasePage, CSElement, CSGetElement, CSPage, CSReporter,
} from '@mdakhan.mak/cs-playwright-test-framework';
import { CSDateTimeUtility } from '@mdakhan.mak/cs-playwright-test-framework/utilities';

@CSPage('user-create')
export class UserCreatePage extends CSBasePage {
    @CSGetElement({ xpath: "//input[@id='userId']", description: 'User ID input' })
    private userIdField!: CSElement;

    @CSGetElement({ xpath: "//input[@id='effectiveDate']", description: 'Effective date input (MM/DD/YYYY)' })
    private effectiveDateField!: CSElement;

    /**
     * Generate a unique user id with a timestamp suffix. Default tz is
     * America/New_York — no need to pass it explicitly. The timestamp
     * is in the same zone every test run, so audit comparisons stay
     * stable across DST boundaries when you query the backend.
     */
    public async fillUniqueUserId(prefix: string): Promise<string> {
        const ts = CSDateTimeUtility.timestamp();             // ms since epoch (zone-agnostic)
        const userId = `${prefix}-${ts}`;
        await this.userIdField.fillWithTimeout(userId, 5000);
        CSReporter.info(`Filled unique userId: ${userId}`);
        return userId;
    }

    /**
     * Format today's date in MM/DD/YYYY (US format) — the format every
     * Americas-region UI expects. CSDateTimeUtility uses the default
     * en-US locale + America/New_York timezone.
     */
    public async fillTodayAsEffectiveDate(): Promise<string> {
        const today = CSDateTimeUtility.toUSDateString(CSDateTimeUtility.now());  // "MM/DD/YYYY"
        await this.effectiveDateField.fillWithTimeout(today, 5000);
        CSReporter.info(`Filled effective date: ${today}`);
        return today;
    }

    /**
     * Future-date a field by N business days, respecting the Americas
     * business calendar (skips weekends; doesn't yet skip US federal
     * holidays — caller's responsibility if needed).
     */
    public async fillFutureBusinessDate(daysAhead: number): Promise<string> {
        const future = CSDateTimeUtility.addBusinessDays(CSDateTimeUtility.now(), daysAhead);
        const formatted = CSDateTimeUtility.toUSDateString(future);
        await this.effectiveDateField.fillWithTimeout(formatted, 5000);
        return formatted;
    }
}
```

## Step definition with backend timestamp comparison

```typescript
import { CSBDDStepDef, CSReporter, StepDefinitions, Page } from '@mdakhan.mak/cs-playwright-test-framework';
import { CSDateTimeUtility } from '@mdakhan.mak/cs-playwright-test-framework/utilities';
import { CSDBUtils } from '@mdakhan.mak/cs-playwright-test-framework/database-utils';

@StepDefinitions
export class UserSteps {
    @CSBDDStepDef('the user record is timestamped within the last {int} seconds')
    async verifyRecentRecord(seconds: number): Promise<void> {
        const row = await CSDBUtils.executeSingleRow('APP_DB',
            'SELECT created_at FROM users WHERE userid = :id', { id: 'TEST-1234' });
        if (!row?.created_at) {
            CSReporter.fail('No user record found');
            throw new Error('User record missing');
        }
        const createdAt = CSDateTimeUtility.parse(row.created_at as string);
        if (!createdAt) {
            CSReporter.fail(`Invalid timestamp from DB: ${row.created_at}`);
            throw new Error('Invalid DB timestamp');
        }
        const diffSec = CSDateTimeUtility.diffInSeconds(CSDateTimeUtility.now(), createdAt);
        if (Math.abs(diffSec) > seconds) {
            CSReporter.fail(`Record timestamp ${createdAt.toISOString()} is ${diffSec}s away (allowed ${seconds}s)`);
            throw new Error(`Timestamp drift exceeded`);
        }
        CSReporter.pass(`Record created ${diffSec}s ago — within ${seconds}s tolerance`);
    }
}
```

## CSDateTimeUtility cheat sheet

| Need | Call |
|---|---|
| Current time | `CSDateTimeUtility.now()` (Date in default tz) |
| Unix ms now | `CSDateTimeUtility.timestamp()` |
| Today as `YYYY-MM-DD` | `CSDateTimeUtility.toDateString(CSDateTimeUtility.now())` |
| Today as `MM/DD/YYYY` | `CSDateTimeUtility.toUSDateString(CSDateTimeUtility.now())` |
| Today as ISO 8601 | `CSDateTimeUtility.toISO(CSDateTimeUtility.now())` |
| Specific timezone format | `CSDateTimeUtility.toUSDateStringInTimezone(d, 'America/Chicago')` |
| Add days / months / years | `CSDateTimeUtility.addDays(d, 7)` etc. |
| Add N business days | `CSDateTimeUtility.addBusinessDays(d, 3)` |
| Parse loose date string | `CSDateTimeUtility.parse('2026-05-08')` |
| Diff in seconds / minutes / days | `CSDateTimeUtility.diffInSeconds(d1, d2)` (also `diffInMinutes`, `diffInHours`, `diffInDays`) |
| Is weekend / weekday | `CSDateTimeUtility.isWeekend(d)`, `.isWeekday(d)` |
| US-style human label | `CSDateTimeUtility.toHumanString(d)` → "May 8, 2026" |

## Forbidden patterns (audit rule DT100 fails the file)

```typescript
// ❌ NEVER
const now = new Date();           // local timezone — non-deterministic across machines
const ts = Date.now();            // OK as raw number, but don't wrap in Date below
const today = new Date().toISOString();  // UTC, not Americas
const formatted = new Date().toLocaleDateString();  // depends on machine locale
```

The audit `DT100` rule blocks any `new Date()` or `Date.now()` call.
The replacement is `CSDateTimeUtility.now()` /
`CSDateTimeUtility.timestamp()` which always honours the framework's
default timezone.

## When you genuinely need a different timezone

For cross-zone tests (e.g., compare America/New_York display with
America/Los_Angeles backend), pass the IANA zone explicitly:

```typescript
const lax = CSDateTimeUtility.toUSDateStringInTimezone(
    CSDateTimeUtility.now(),
    'America/Los_Angeles',
);
```

Or change the global default at the start of the run:

```typescript
CSDateTimeUtility.setDefaultTimezone('America/Chicago');  // one-time, persists for the run
```

Never hardcode `Z` / UTC suffixes — those are Americas-incorrect.
