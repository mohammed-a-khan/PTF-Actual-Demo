---
name: sd-step-with-context
description: Use when a step needs to pass data to another step in the same scenario — e.g., capturing an id from a "Given …" to consume in a "Then …".
---

# Pattern: passing data between steps via CSBDDContext

## When to use

A scenario where step 1 discovers or creates a value (a generated id, a resolved entity key, a timestamp) that step 3 needs to reference. Use `CSBDDContext` — scenario-scoped, automatically cleared at end of scenario.

## Example

```gherkin
Given I resolve an active deal from the database
When I open the asset search for the resolved deal
Then the deal key is shown in the header
```

```typescript
import {
    CSBDDStepDef,
    Page,
    StepDefinitions,
    CSBDDContext,
} from '@mdakhan.mak/cs-playwright-test-framework/bdd';
import { CSReporter } from '@mdakhan.mak/cs-playwright-test-framework/reporter';
import { AssetSearchPage } from '../../pages/assets/AssetSearchPage';
import { DealDatabaseHelper } from '../../helpers/DealDatabaseHelper';

@StepDefinitions
export class AssetSearchSteps {

    @Page('asset-search')
    private searchPage!: AssetSearchPage;

    private context = CSBDDContext.getInstance();

    @CSBDDStepDef('I resolve an active deal from the database')
    async resolveActiveDeal(): Promise<void> {
        const deal = await DealDatabaseHelper.findFirstActiveDeal();
        if (!deal) {
            const msg = 'No active deal found in the test database';
            CSReporter.fail(msg);
            throw new Error(msg);
        }
        this.context.setVariable('resolvedDealKey', deal.dealKey);
        CSReporter.pass(`Resolved active deal: ${deal.dealKey}`);
    }

    @CSBDDStepDef('I open the asset search for the resolved deal')
    async openAssetSearchForResolvedDeal(): Promise<void> {
        const dealKey = this.context.getVariable('resolvedDealKey') as string;
        if (!dealKey) {
            const msg = 'resolvedDealKey not set on scenario context';
            CSReporter.fail(msg);
            throw new Error(msg);
        }
        await this.searchPage.searchByDealKey(dealKey);
        CSReporter.pass(`Asset search executed for ${dealKey}`);
    }

    @CSBDDStepDef('the deal key is shown in the header')
    async verifyDealKeyInHeader(): Promise<void> {
        const dealKey = this.context.getVariable('resolvedDealKey') as string;
        await this.searchPage.verifyHeaderContainsDealKey(dealKey);
    }
}
```

## Rules

- `CSBDDContext.getInstance()` is singleton-per-scenario — use the single `this.context` on the class
- `setVariable(key, value)` — write
- `getVariable(key) as T` — read, always cast to the expected type
- Missing values must be checked and fail loudly — never pass `undefined` downstream silently
- Do NOT store data in private class fields — the class is shared across scenarios, state will leak
- Preferred keys are camelCase, descriptive (`resolvedDealKey`, not `d`)
