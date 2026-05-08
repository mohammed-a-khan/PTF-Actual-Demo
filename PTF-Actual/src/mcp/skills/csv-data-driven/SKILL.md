---
name: csv-data-driven
description: Use when a feature reads test data from a CSV / TSV / pipe-separated file. Always go through CSCsvUtility — never import csv-parse, papaparse, or csv-parser directly. Pairs with audit rule CSV100.
---

# Pattern: CSV data-driven tests

## When to use

The legacy data file is `.csv`, `.tsv`, or a custom delimiter file
(`|`, `;`). Same shape as Excel data-driven, just a different format.
`CSCsvUtility` handles delimiter sniffing, quoted fields, embedded
newlines, and BOMs.

## Working example

```typescript
import {
    CSBasePage, CSElement, CSGetElement, CSPage, CSReporter,
} from '@mdakhan.mak/cs-playwright-test-framework';
import { CSCsvUtility } from '@mdakhan.mak/cs-playwright-test-framework/utilities';

@CSPage('orders')
export class OrdersPage extends CSBasePage {
    @CSGetElement({ xpath: "//input[@id='orderRef']", description: 'Order reference input' })
    private orderRefField!: CSElement;

    /** Read every row, parse into typed objects. */
    public loadOrders(csvPath: string): Array<{ orderRef: string; amount: string; }> {
        return CSCsvUtility.readAsJSON(csvPath);
    }

    /** Pipe-separated file? Pass the delimiter. */
    public loadPipeSeparated(filePath: string): Array<Record<string, string>> {
        return CSCsvUtility.readAsJSON(filePath, { delimiter: '|' });
    }

    /** Filter rows server-side (memory-safe for large files). */
    public loadActiveOnly(csvPath: string): Array<Record<string, string>> {
        return CSCsvUtility.findRows(csvPath, (r) => r.runFlag?.toLowerCase() === 'yes');
    }
}
```

## CSCsvUtility cheat sheet

| Need | Call |
|---|---|
| All rows as JSON | `CSCsvUtility.readAsJSON(path, options?)` |
| All rows as 2D array | `CSCsvUtility.readAsArray(path, options?)` |
| Single column | `CSCsvUtility.readColumnByName(path, 'orderRef')` |
| Single row by index | `CSCsvUtility.readRowByIndex(path, 0)` |
| Headers only | `CSCsvUtility.getHeaders(path)` |
| Filter rows by predicate | `CSCsvUtility.findRows(path, r => r.x === 'y')` |
| Distinct values | `CSCsvUtility.getDistinctValues(path, 'department')` |
| Custom delimiter (TSV / pipe / etc.) | `CSCsvUtility.readWithDelimiter(path, '\t')` |
| Validate header structure | `CSCsvUtility.validateStructure(path, ['col1', 'col2'])` |
| Convert CSV → JSON file | `CSCsvUtility.csvToJSON(srcPath, jsonPath)` |
| Convert JSON → CSV file | `CSCsvUtility.jsonToCSV(srcPath, csvPath)` |
| Compare two CSVs | `CSCsvUtility.compareCSVFiles(file1, file2)` |

Common `options` object:

```typescript
{
    delimiter: ',',         // default
    columns: true,          // first row is headers (default true for readAsJSON)
    skipEmptyLines: true,
    trim: true,
    encoding: 'utf-8',
    fromLine: 1,            // skip leading rows
    toLine: 100,             // read up to this row
}
```

## Forbidden patterns (audit rule CSV100 fails the file)

```typescript
// ❌ NEVER
import { parse } from 'csv-parse';
import * as Papa from 'papaparse';
import csvParser from 'csv-parser';
const parser = require('csv-parse');
```

The framework wraps these libraries internally with consistent error
handling, encoding detection, and BOM stripping. Direct import fails
audit `CSV100` and skips the wrapper guarantees.

## Common gotchas

1. **BOM characters** (`﻿` at start of UTF-8 files) silently
   break header matching. `CSCsvUtility` strips them; raw `csv-parse`
   doesn't.
2. **Quoted fields with embedded commas** — handled correctly by
   `CSCsvUtility`. Don't try to split on `,` manually.
3. **Empty trailing line** — `skipEmptyLines: true` (default) handles
   it. Toggle off only if your data legitimately has empty rows.
4. **Numeric fields come back as strings.** All CSV parsers do this.
   Coerce explicitly: `Number(row.amount)` after reading.
