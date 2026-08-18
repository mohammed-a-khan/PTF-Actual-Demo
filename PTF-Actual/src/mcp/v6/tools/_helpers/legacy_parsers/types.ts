/**
 * Shared types for legacy-test parsers.
 *
 * A parser produces a `LegacyTest[]` — one entry per discovered test method
 * or scenario. The migrate tool cross-references each entry against the
 * source-of-truth model (endpoints/screens/validators/messages) and emits a
 * new-framework artifact.
 *
 * All parsers work on raw file content (no jsdom/tree-sitter dependencies).
 * They emit real facts: method names, ordered driver calls with the exact
 * locator string the legacy test used, and assertion expressions with the
 * expected literal value. No heuristics — a step whose assertion cannot be
 * cleanly recovered is emitted as a `raw` bag so the migrator can flag it
 * for manual review instead of silently dropping it.
 */

export type LegacyFramework =
    | 'selenium-junit'
    | 'testng'
    | 'jasmine'
    | 'protractor'
    | 'cucumber-java'
    | 'mocha';

export interface LegacyLocator {
    /** Selector strategy: 'id' | 'css' | 'xpath' | 'name' | 'className' | 'linkText' | 'tagName' | 'partialLinkText' | 'testId'. */
    strategy: string;
    /** Raw selector value as it appeared in the legacy source (e.g. "submit" for By.id("submit")). */
    value: string;
    /** Line the locator was found on (1-based). */
    lineNumber: number;
}

export interface LegacyAction {
    /** The action verb: 'click' | 'sendKeys' | 'select' | 'clear' | 'submit' | 'navigate' | 'other'. */
    kind: string;
    /** The locator this action targets, if any. */
    locator?: LegacyLocator;
    /** Value payload for sendKeys / select / navigate. */
    value?: string;
    /** The raw line of source (for the migration report). */
    rawLine: string;
    lineNumber: number;
}

export interface LegacyAssertion {
    /** 'equals' | 'true' | 'false' | 'contains' | 'notNull' | 'null' | 'matches' | 'other'. */
    kind: string;
    /** The literal value the assertion expects, if extractable (e.g. "Employee saved successfully"). */
    expectedLiteral: string | null;
    /** The actual-side expression as raw text (e.g. `driver.findElement(By.id("msg")).getText()`). */
    actualExpression: string | null;
    /** The raw source line. */
    rawLine: string;
    lineNumber: number;
}

export interface LegacyDataRow {
    /** Column names (from @DataProvider first row, describe-loop key, etc). */
    columns: string[];
    /** Each row is column → value. */
    rows: Array<Record<string, string>>;
}

export interface LegacyTest {
    /** Unique-within-file id. Method name for JUnit/TestNG, scenario name for Cucumber, it-description for Jasmine/Mocha. */
    id: string;
    /** Human-readable name (from @DisplayName, description=..., or scenario text). */
    displayName: string;
    /** Absolute path to the file the test came from. */
    filePath: string;
    /** 1-based line the test starts on. */
    startLine: number;
    /** The parsing framework that produced this entry. */
    framework: LegacyFramework;
    /** Tags/groups: JUnit @Tag, TestNG groups=, Cucumber @tag. */
    tags: string[];
    /** All actions collected inside the test body, in order. */
    actions: LegacyAction[];
    /** All assertions collected inside the test body, in order. */
    assertions: LegacyAssertion[];
    /** Setup fixtures the test depends on (method names). */
    setupHooks: string[];
    /** Teardown fixtures the test depends on. */
    teardownHooks: string[];
    /** Data-provider rows the test iterates over. */
    dataRows: LegacyDataRow | null;
    /** Endpoint URLs the test mentions (from driver.get / browser.get / url= assignments). */
    urlsTouched: string[];
    /** Warnings the parser emitted for this test (unrecoverable assertion body, etc). */
    warnings: string[];
}

export interface ParsedLegacyFile {
    filePath: string;
    framework: LegacyFramework;
    tests: LegacyTest[];
    /** Whole-file parse errors that prevented some tests being emitted. */
    fileErrors: string[];
}

export interface FrameworkDetection {
    framework: LegacyFramework;
    /** 0..1 — fraction of matching signature files vs total files scanned. */
    confidence: number;
    /** Absolute paths of the first 5 files that contained the signature — for debugging. */
    sampleFiles: string[];
    /** Counts of every signature we saw so users can debug ambiguous trees. */
    signatureCounts: Record<string, number>;
}
