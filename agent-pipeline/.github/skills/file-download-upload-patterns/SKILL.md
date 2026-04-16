---
name: file-download-upload-patterns
description: >
  Canonical patterns for file download and upload handling in the
  target test framework. Covers download event subscription, saved
  path resolution, filename pattern verification, content verification
  via CSCsvUtility/CSExcelUtility, upload via setInputFiles (single,
  multi, drag-drop), post-upload verification, cleanup in hooks, and
  forbidden patterns. Load when generating, auditing, or healing any
  page object method or step definition that handles file download
  or upload.
---

# File Download and Upload Patterns

## When this skill applies

Any generated code that triggers a file download from the
application under test, uploads a file to the application, or
verifies file content after download. Typically page object
methods for export actions, upload buttons, or drag-drop zones.

## Download handling

### The capture-download pattern

Use `CSBrowserManager.captureDownload` to subscribe to the
download event BEFORE clicking the download trigger. This is
the only reliable way to catch the event — registering after
the click misses fast downloads.

```
public async exportAsExcel(): Promise<string> {
    const download = await this.browserManager.captureDownload(async () => {
        await this.buttonExport.click();
    });
    const savedPath = download.savedPath;
    CSReporter.info(`Downloaded file saved to: ${savedPath}`);
    return savedPath;
}
```

The callback form ensures the handler is registered, then the
action is performed inside the callback, then the framework
resolves when the download completes. The returned object
exposes `savedPath` (absolute path where the file landed) and
metadata (size, timestamp, suggested filename).

### Download destination

The framework writes downloads to the directory configured via
`BROWSER_DOWNLOADS_DIR` in the environment env file. Default is
a `downloads/` folder at the project root. The method returns
the absolute path; callers should not assume a specific
directory structure.

### Filename pattern verification

Downloaded filenames often contain timestamps, run IDs, or
user context, making exact equality checks brittle. Verify the
filename with a regex that matches the stable parts:

```
public async exportAndVerifyFilename(expectedPrefix: string): Promise<string> {
    const savedPath = await this.exportAsExcel();
    const filename = path.basename(savedPath);
    const pattern = new RegExp(`^${expectedPrefix}_\\d{8}_\\d{6}\\.xlsx$`);
    await CSAssert.getInstance().assertTrue(
        pattern.test(filename),
        `Downloaded filename "${filename}" should match pattern "${pattern}"`
    );
    return savedPath;
}
```

Patterns commonly include:
- Date portion: `\d{8}` for `YYYYMMDD`
- Time portion: `\d{6}` for `HHMMSS`
- Run id: `\d{1,6}` or a UUID shape
- Extension: `\.(xlsx|csv|pdf|json)$`

### Content verification after download

Use framework utilities to read and inspect the downloaded file,
never a raw `fs.readFile` call when a utility exists:

- CSV → `CSCsvUtility.read(path)` or `parseFile(path)`
- Excel → `CSExcelUtility.read(path)` or `getSheet(path, sheetName)`
- JSON → standard `JSON.parse(fs.readFileSync(path, 'utf-8'))`
- PDF → framework PDF utility if exposed, otherwise declare the
  helper missing in the generation manifest

Content verification lives in the page object or a helper, not
in the step definition. The step definition calls the page
method, the page method reads and returns structured data, the
step definition asserts on the returned data.

```
public async exportAndReadRows(): Promise<Record<string, any>[]> {
    const savedPath = await this.exportAsExcel();
    const rows = await CSExcelUtility.getSheet(savedPath, 'Results');
    CSReporter.info(`Read ${rows.length} rows from downloaded file`);
    return rows;
}
```

### Multi-file downloads

For actions that trigger multiple downloads (a zip archive that
extracts to several files, or a batch export), use
`captureDownloads(async () => { ... }, count)` if available, or
register listeners manually before the action and await all
resolved downloads.

Prefer a single-archive download over multi-file when possible
— it's more reliable across browsers and testable as one unit.

### Cleanup

Downloaded files are cleaned up in the test's `@CSAfter` hook,
not inside the page object method. The page object method
returns the path; the test records it; the after hook removes
it.

```
@CSAfter({ tags: ['@downloads-file'] })
async cleanupDownloads(): Promise<void> {
    const savedPath = this.context.get<string>('lastDownloadPath');
    if (savedPath && fs.existsSync(savedPath)) {
        fs.unlinkSync(savedPath);
        CSReporter.debug(`Cleaned up download: ${savedPath}`);
    }
}
```

Cleanup that fails should log a warning but not fail the
scenario — the test already passed at this point.

## Upload handling

### The setInputFiles pattern

Use `setInputFiles` on the declared file input element. The
element is declared with `@CSGetElement` like any other
element, typically with `type='file'` in the xpath.

```
@CSGetElement({
    xpath: "//input[@type='file' and @id='documentUpload']",
    description: 'Document upload file input'
})
public fileInputDocument!: CSWebElement;

public async uploadDocument(absolutePath: string): Promise<void> {
    await this.fileInputDocument.setInputFiles(absolutePath);
    await this.browserManager.waitForSpinnersToDisappear(30000);
    CSReporter.info(`Uploaded file: ${absolutePath}`);
}
```

`setInputFiles` accepts:

- A single absolute path (`string`)
- An array of paths (`string[]`) for multi-file upload
- A `File` object (for in-memory uploads)
- `null` or `[]` to clear the input

### Multi-file upload

```
public async uploadDocuments(paths: string[]): Promise<void> {
    await this.fileInputDocument.setInputFiles(paths);
    await this.browserManager.waitForSpinnersToDisappear(30000);
    CSReporter.info(`Uploaded ${paths.length} files`);
}
```

The input must have the `multiple` attribute for this to work.
Without it, only the first file is accepted.

### Upload via hidden input

Some applications hide the real file input behind a styled
button. The upload still targets the real input, not the
styled button:

```
// Hidden input declared with visible=false hint
@CSGetElement({
    xpath: "//input[@type='file']",
    description: 'Hidden file input behind upload button'
})
public fileInputHidden!: CSWebElement;

// Visible button that triggers the upload
@CSGetElement({
    xpath: "//button[contains(text(),'Upload')]",
    description: 'Upload button'
})
public buttonUpload!: CSWebElement;

public async uploadViaHiddenInput(absolutePath: string): Promise<void> {
    // Set files on the real input, not the button
    await this.fileInputHidden.setInputFiles(absolutePath);
    // Some apps still require the visible button click
    // to commit the upload
    await this.buttonUpload.click();
    await this.browserManager.waitForSpinnersToDisappear(30000);
    CSReporter.info(`Uploaded file via hidden input: ${absolutePath}`);
}
```

### Drag-and-drop upload

For drag-and-drop upload zones, use the framework's
drag-drop helper if exposed (check the specific element
methods), or fall back to `setInputFiles` on the underlying
hidden input — most drag-drop zones in practice wrap a hidden
`<input type="file">` and setting files on it triggers the
same event the drop would.

When a real drag-drop is required (no hidden input), use the
page-level `dragFromTo(fromX, fromY, toX, toY)` helper after
setting up a DataTransfer object via `executeScript` — but this
is fragile. Prefer finding the hidden input when possible.

### Post-upload verification

Every upload method should verify the upload actually landed.
Typical verifications:

1. **Spinner disappearance**: `waitForSpinnersToDisappear(30000)`
2. **Filename display**: a row or label appears in the UI
   showing the uploaded filename
3. **Success message**: a toast or banner confirms the upload
4. **Absence of error**: no error banner appeared

```
public async uploadAndVerify(absolutePath: string): Promise<void> {
    const filename = path.basename(absolutePath);

    await this.fileInputDocument.setInputFiles(absolutePath);
    await this.browserManager.waitForSpinnersToDisappear(30000);

    // Verify the filename appears in the uploaded-files list
    const uploadedRow = CSElementFactory.createByXPath(
        `//tr[td[normalize-space(text())='${filename}']]`,
        `Uploaded file row: ${filename}`
    );
    await uploadedRow.waitForVisible(15000);

    // Verify the success message
    await this.verifyUploadSuccess();

    CSReporter.info(`Upload verified for: ${filename}`);
}
```

### Invalid file upload

When testing error paths (wrong file type, too large, missing
required columns), the upload method should NOT fail the step
on the expected error. Instead, return the error state so the
test can assert on it:

```
public interface UploadResult {
    success: boolean;
    errorMessage: string | null;
    uploadedFilename: string | null;
}

public async uploadAndCaptureResult(absolutePath: string): Promise<UploadResult> {
    const filename = path.basename(absolutePath);

    await this.fileInputDocument.setInputFiles(absolutePath);
    await this.browserManager.waitForSpinnersToDisappear(30000);

    const errorVisible = await this.labelErrorMessage.isVisible();
    if (errorVisible) {
        const errorText = (await this.labelErrorMessage.getTextContent()) || '';
        return {
            success: false,
            errorMessage: errorText,
            uploadedFilename: null,
        };
    }

    return {
        success: true,
        errorMessage: null,
        uploadedFilename: filename,
    };
}
```

The step definition then asserts on the expected error message
for negative-path scenarios.

## Test-file management

### Where test-input files live

- Under `test/<project>/data/files/` (sibling to scenario data
  JSON)
- Organise by test purpose:
  - `test/<project>/data/files/valid/`
  - `test/<project>/data/files/invalid/`
  - `test/<project>/data/files/large/`
- Reference from step definitions via absolute path resolved at
  runtime:

```
const filePath = path.resolve(
    CSConfigurationManager.getInstance().get('TEST_DATA_DIR'),
    'files/valid/sample.xlsx'
);
```

- Never hardcode absolute paths in test code; resolve from
  config-driven base paths

### Generated test files

For tests that need dynamically generated files (random data,
edge-case content), use a helper to create them:

```
export class TestFileHelper {
    private static readonly GENERATED_DIR = path.join(
        CSConfigurationManager.getInstance().get('TEST_DATA_DIR'),
        'files/generated'
    );

    public static async generateCsv(
        rows: Record<string, any>[],
        filename: string
    ): Promise<string> {
        if (!fs.existsSync(this.GENERATED_DIR)) {
            fs.mkdirSync(this.GENERATED_DIR, { recursive: true });
        }
        const filePath = path.join(this.GENERATED_DIR, filename);
        await CSCsvUtility.write(filePath, rows);
        CSReporter.info(`Generated test CSV: ${filePath}`);
        return filePath;
    }

    public static cleanupGenerated(): void {
        if (fs.existsSync(this.GENERATED_DIR)) {
            fs.rmSync(this.GENERATED_DIR, { recursive: true, force: true });
            CSReporter.debug('Cleaned up generated test files');
        }
    }
}
```

Cleanup runs in a global `@CSAfter` hook or a suite-level
teardown.

## Forbidden patterns

Never do any of these in download or upload code:

- Click a download button without first subscribing to the
  download event via `captureDownload`
- Hardcode a downloads directory path — use
  `BROWSER_DOWNLOADS_DIR` from config
- Assume filename equality in assertions — always use regex
  patterns
- Read downloaded files with raw `fs.readFile` when a framework
  utility exists
- Call `setInputFiles` on the visible wrapper button instead of
  the real file input
- Upload without post-upload verification (at least spinner
  disappearance)
- Leave downloaded files uncleaned after a test — use `@CSAfter`
  hooks
- Hardcode absolute paths to test-input files — resolve from
  config
- Swallow upload errors silently when testing negative paths —
  return them in a structured result for the step to assert on
- Use `page.setInputFiles(...)` via raw Playwright — use the
  decorated element's `setInputFiles` method
- Read a downloaded file before the download event has resolved
  (race condition)

## Self-check before returning download or upload code

- [ ] Downloads use `browserManager.captureDownload(async () => { ... })`
- [ ] Download methods return the saved path, not the raw
      download object
- [ ] Filename verification uses regex patterns for stable parts
- [ ] Content verification uses framework utilities (CSV/Excel/
      JSON)
- [ ] Downloaded files are cleaned up in `@CSAfter` hooks
- [ ] Uploads use `fileInputElement.setInputFiles(...)`, never
      raw Playwright
- [ ] Upload methods wait for spinner disappearance after
      setInputFiles
- [ ] Upload methods verify the filename appears in the UI or a
      success message is shown
- [ ] Negative-path upload methods return structured error
      results, not throw
- [ ] Test input files live under `test/<project>/data/files/`
      and are referenced via config-resolved paths
- [ ] Generated files go into a dedicated `generated/` subdir
      and are cleaned up by a helper

If any item fails, fix it before returning. The audit checklist
tool enforces most of these rules.
