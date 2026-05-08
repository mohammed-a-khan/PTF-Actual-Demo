---
name: file-download-export
description: Use when a feature triggers a file export (PDF, Excel, CSV) and the test needs to capture the downloaded file under the per-run test-results directory. Pairs with audit rule DL100.
---

# Pattern: file download / export capture

## When to use

The legacy test clicks an "Export to Excel", "Download PDF", "Save report"
button and verifies (a) the file arrived, (b) it has expected name /
size / content. The framework's `CSTestResultsManager` owns the
per-run download directory — every captured file lands under
`test-results/<runId>/downloads/` so reports show them inline and CI
artefact upload picks them up automatically.

## Working example

```typescript
import {
    CSBasePage, CSElement, CSGetElement, CSPage, CSReporter,
    CSTestResultsManager,
} from '@mdakhan.mak/cs-playwright-test-framework';
import * as path from 'path';

@CSPage('reports')
export class ReportsPage extends CSBasePage {
    @CSGetElement({
        xpath: "//button[normalize-space()='Export to Excel']",
        description: 'Export to Excel button',
        selfHeal: true,
    })
    private exportButton!: CSElement;

    /**
     * Trigger the export, wait for the download, store under the framework's
     * download directory, and return the absolute path. Use the return value
     * in the next step to verify content.
     */
    public async exportToExcel(): Promise<string> {
        // Arm Playwright's download promise BEFORE the click that triggers it.
        const downloadPromise = this.page.waitForEvent('download', { timeout: 30000 });
        await this.exportButton.clickWithTimeout(30000);
        const download = await downloadPromise;

        // Save under the framework's per-run downloads dir, preserving suggested name.
        const trm = CSTestResultsManager.getInstance();
        const downloadsDir = trm.getDownloadsDirectory();
        const targetPath = path.join(downloadsDir, download.suggestedFilename());
        await download.saveAs(targetPath);

        // Register with the framework so the report shows the file inline.
        trm.addDownloadedFile(targetPath, download.suggestedFilename(), download.suggestedFilename());

        CSReporter.info(`Exported to ${path.basename(targetPath)} (${path.dirname(targetPath)})`);
        return targetPath;
    }

    /**
     * Convenience: get the most recent file the framework captured this run.
     * Useful in Then steps that verify content without threading the path
     * through scenario state.
     */
    public getLatestExport(): { path: string; name: string } | undefined {
        return CSTestResultsManager.getInstance().getLatestDownloadedFile();
    }
}
```

## Step definition example

```typescript
import { CSBDDStepDef, CSReporter, StepDefinitions, Page } from '@mdakhan.mak/cs-playwright-test-framework';
import { CSExcelUtility } from '@mdakhan.mak/cs-playwright-test-framework/dist/utils/CSExcelUtility';

@StepDefinitions
export class ReportsSteps {
    constructor(@Page('reports') private reportsPage: ReportsPage) {}

    @CSBDDStepDef('I export the report to Excel')
    async exportReport(): Promise<void> {
        await this.reportsPage.exportToExcel();
    }

    @CSBDDStepDef('the exported Excel file has {int} rows')
    async verifyExportRowCount(expected: number): Promise<void> {
        const latest = this.reportsPage.getLatestExport();
        if (!latest) {
            CSReporter.fail('No exported file captured for this scenario');
            throw new Error('No exported file captured');
        }
        const rows = CSExcelUtility.readSheetAsJSON(latest.path);
        if (rows.length !== expected) {
            CSReporter.fail(`Expected ${expected} rows in export, got ${rows.length}`);
            throw new Error(`Row count mismatch: expected ${expected}, got ${rows.length}`);
        }
        CSReporter.pass(`Exported file has ${rows.length} rows as expected`);
    }
}
```

## Forbidden patterns (audit rule DL100 fails the file)

```typescript
// ❌ NEVER — hardcoded paths bypass the framework's per-run dir
await download.saveAs('/tmp/export.xlsx');
await download.saveAs('C:\\downloads\\report.csv');
await download.saveAs('~/Downloads/file.pdf');
await download.saveAs('../some-relative-path.xlsx');
```

These leak files outside the test-results dir, miss the report
attachment, and fail audit `DL100`. Always go through
`CSTestResultsManager.getDownloadsDirectory()`.

## Common gotchas

1. **Arm `waitForEvent('download')` before the click.** If you call
   it after, the download event already fired and you'll time out.
2. **`download.suggestedFilename()` can collide.** If the same scenario
   exports twice, suffix the filename with a timestamp from
   `CSDateTimeUtility.timestamp()` to avoid overwrite.
3. **Verify file content, not just existence.** Read the file via
   `CSExcelUtility` / `CSCsvUtility` / Node `fs.readFileSync` for PDFs
   to assert the export is actually correct, not just a 0-byte
   placeholder.
4. **`addDownloadedFile()` is mandatory** for the test report to
   surface the file. Skip it and the file exists on disk but doesn't
   show up in the HTML report.
