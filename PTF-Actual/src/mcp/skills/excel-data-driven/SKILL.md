---
name: excel-data-driven
description: Use when a feature reads test data from an .xlsx file. Always go through CSExcelUtility — never import xlsx or exceljs directly. Pairs with audit rule EX100.
---

# Pattern: Excel data-driven tests

## When to use

Legacy tests often consume `.xlsx` files via `@QAFDataProvider` / `@DataProvider`.
The migrated test should keep XLS as the authoring format if the team
prefers spreadsheets, or convert to JSON via CSExcelUtility's
`excelToJSON` for more flexibility. Either way, all XLSX I/O goes
through `CSExcelUtility`.

## Working example — read XLSX and use as data source

```typescript
import {
    CSBasePage, CSElement, CSGetElement, CSPage, CSReporter,
} from '@mdakhan.mak/cs-playwright-test-framework';
// Heavy utility — import via the deep path (kept out of the main + /utilities
// barrel to avoid pulling in xlsx on every framework bootstrap).
import { CSExcelUtility } from '@mdakhan.mak/cs-playwright-test-framework/dist/utils/CSExcelUtility';
import * as path from 'path';

@CSPage('user-search')
export class UserSearchPage extends CSBasePage {
    @CSGetElement({ xpath: "//input[@id='userId']", description: 'User ID search input' })
    private userIdField!: CSElement;

    @CSGetElement({ xpath: "//button[normalize-space()='Search']", description: 'Search button' })
    private searchButton!: CSElement;

    /**
     * Read all rows from a sheet, return as typed objects keyed by header.
     */
    public loadUsers(xlsxPath: string, sheetName?: string): Array<{ userId: string; firstName: string; lastName: string; }> {
        return CSExcelUtility.readSheetAsJSON(xlsxPath, sheetName);
    }

    /**
     * Read a single cell — useful for one-off config values stored in
     * a spreadsheet cell rather than a full row.
     */
    public getCellValue(xlsxPath: string, address: string, sheet?: string): string {
        return String(CSExcelUtility.readCellValue(xlsxPath, address, sheet));
    }

    public async searchByUserId(userId: string): Promise<void> {
        await this.userIdField.fillWithTimeout(userId, 5000);
        await this.searchButton.clickWithTimeout(30000);
        CSReporter.info(`Searched for userId=${userId}`);
    }
}
```

## Step definition example — XLSX-backed scenario outline

```typescript
import { CSBDDStepDef, CSReporter, StepDefinitions, Page } from '@mdakhan.mak/cs-playwright-test-framework';
import { CSExcelUtility } from '@mdakhan.mak/cs-playwright-test-framework/dist/utils/CSExcelUtility';

@StepDefinitions
export class UserSearchSteps {
    constructor(@Page('user-search') private searchPage: UserSearchPage) {}

    @CSBDDStepDef('I search for every user in {string} sheet {string}')
    async searchAllUsers(xlsxPath: string, sheetName: string): Promise<void> {
        const users = CSExcelUtility.readSheetAsJSON<{ userId: string; runFlag: string }>(xlsxPath, sheetName);
        const active = users.filter(u => u.runFlag?.toLowerCase() === 'yes');
        for (const u of active) {
            await this.searchPage.searchByUserId(u.userId);
            CSReporter.info(`Searched for ${u.userId}`);
        }
    }
}
```

## Convert XLSX to JSON during migration (recommended path)

The framework prefers JSON for runtime — JSON parses faster, diffs better
in PR reviews, and round-trips through `CSDataProvider` natively.
Migrate XLSX → JSON once during the migration, ship the JSON in the
data file:

```typescript
// In a one-time migration script, NOT in test runtime:
CSExcelUtility.excelToJSON(
    'legacy-data/UserData.xlsx',
    'test/myproject/data/user-data.json',
    'Users',  // optional sheet name; first sheet if omitted
);
```

The `legacy_test_code` mode handler does this automatically via
`CSTestDataMigrator` — your generated `*-data.json` is already
populated with the real XLS rows.

## CSExcelUtility cheat sheet

| Need | Call |
|---|---|
| All sheets to JSON | `CSExcelUtility.readSheetAsJSON(path, sheetName?)` |
| Single cell | `CSExcelUtility.readCellValue(path, 'A1', sheet?)` |
| Range as 2D array | `CSExcelUtility.readCellRange(path, 'A1:D10', sheet?)` |
| Row count / col count | `CSExcelUtility.getRowCount(path, sheet?)` / `getColumnCount` |
| Find rows by predicate | `CSExcelUtility.findRows(path, r => r.runFlag === 'Yes', sheet?)` |
| Distinct values in column | `CSExcelUtility.getDistinctValues(path, 'department', sheet?)` |
| Write JSON → XLSX | `CSExcelUtility.writeJSONToExcel(rows, path, sheet?)` |
| Update single cell | `CSExcelUtility.updateCellValue(path, 'A1', 'newValue', sheet?)` |
| Diff two files | `CSExcelUtility.compareExcelFiles(file1, file2)` |
| Sheet metadata | `CSExcelUtility.getSheetNames(path)`, `.getFileMetadata(path)` |

## Forbidden patterns (audit rule EX100 fails the file)

```typescript
// ❌ NEVER — direct library imports
import * as XLSX from 'xlsx';
import { read, utils } from 'xlsx';
import ExcelJS from 'exceljs';
const xlsx = require('xlsx');
```

These bypass the framework's logging, error wrapping, and per-run
caching, and fail the pre-gate audit (`EX100: Direct xlsx/exceljs
import`). Always import `CSExcelUtility` from the framework.

## Common gotchas

1. **Empty cells return `undefined`, not `''`.** Use `?? ''` when
   coercing to string for assertions.
2. **Header row is row 1.** `readSheetAsJSON` treats the first row as
   keys. If your sheet has a title in row 1, skip it via
   `readWorkbookWithOptions` with `range: 1`.
3. **Date cells.** Excel stores dates as serial numbers. Use
   `CSDateTimeUtility.parse(cell)` to convert; don't trust the raw
   value.
4. **Sheet name must match exactly.** Case-sensitive, whitespace
   sensitive. Use `getSheetNames(path)` to confirm.
