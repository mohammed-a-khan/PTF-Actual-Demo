import { Page, Locator, expect } from '@playwright/test';
import { CSReporter } from '../reporter/CSReporter';
import { CSConfigurationManager } from '../core/CSConfigurationManager';
import * as fs from 'fs';
import * as path from 'path';
import {
    AriaSnapshotOptions,
    AccessibilityViolation,
    AccessibilityReport,
    AriaSnapshotComparison
} from './CSAccessibilityTypes';

/**
 * CS Playwright Test Framework - Aria Snapshot Testing
 *
 * Provides aria snapshot capture, baseline comparison, and structural
 * accessibility validation using Playwright's built-in aria tree APIs.
 *
 * Uses `page.locator('body').ariaSnapshot()` (Playwright 1.58.2 compatible).
 * The `page.ariaSnapshot()` shorthand is NOT available until v1.59.
 */
export class CSAriaSnapshotTesting {
    private static instance: CSAriaSnapshotTesting;
    private config: CSConfigurationManager;
    private snapshotDir!: string;
    private autoUpdate: boolean;

    private constructor() {
        this.config = CSConfigurationManager.getInstance();
        this.snapshotDir = this.config.get('ARIA_SNAPSHOT_DIR', '') || path.join(process.cwd(), 'test', 'accessibility', 'snapshots');
        this.autoUpdate = this.config.getBoolean('ARIA_SNAPSHOT_UPDATE', false);
        this.initializeDirectories();
    }

    public static getInstance(): CSAriaSnapshotTesting {
        if (!CSAriaSnapshotTesting.instance) {
            CSAriaSnapshotTesting.instance = new CSAriaSnapshotTesting();
        }
        return CSAriaSnapshotTesting.instance;
    }

    private initializeDirectories(): void {
        if (!fs.existsSync(this.snapshotDir)) {
            fs.mkdirSync(this.snapshotDir, { recursive: true });
        }
    }

    /**
     * Captures the aria snapshot of the full page or a specific element.
     * Returns the YAML string representation of the aria tree.
     */
    public async captureAriaSnapshot(page: Page, options: AriaSnapshotOptions = {}): Promise<string> {
        CSReporter.startStep('Capturing aria snapshot');

        try {
            let locator: Locator;

            if (options.selector) {
                locator = page.locator(options.selector);
            } else {
                locator = page.locator('body');
            }

            if (options.timeout) {
                await locator.waitFor({ state: 'attached', timeout: options.timeout });
            }

            const snapshot = await locator.ariaSnapshot();

            CSReporter.endStep('pass');
            CSReporter.info(`Aria snapshot captured (${snapshot.length} chars)`);

            return snapshot;
        } catch (error: any) {
            CSReporter.endStep('fail');
            CSReporter.error(`Failed to capture aria snapshot: ${error.message}`);
            throw error;
        }
    }

    /**
     * Captures an aria snapshot from a specific Locator.
     */
    public async captureElementAriaSnapshot(locator: Locator, options: AriaSnapshotOptions = {}): Promise<string> {
        CSReporter.startStep('Capturing element aria snapshot');

        try {
            if (options.timeout) {
                await locator.waitFor({ state: 'attached', timeout: options.timeout });
            }

            const snapshot = await locator.ariaSnapshot();

            CSReporter.endStep('pass');
            CSReporter.info(`Element aria snapshot captured (${snapshot.length} chars)`);

            return snapshot;
        } catch (error: any) {
            CSReporter.endStep('fail');
            CSReporter.error(`Failed to capture element aria snapshot: ${error.message}`);
            throw error;
        }
    }

    /**
     * Compares the current page aria tree against a saved baseline snapshot.
     * If auto-update is enabled or no baseline exists, saves the current snapshot.
     */
    public async compareAriaSnapshot(page: Page, snapshotName: string, options: AriaSnapshotOptions = {}): Promise<AriaSnapshotComparison> {
        CSReporter.startStep(`Comparing aria snapshot: ${snapshotName}`);

        try {
            const baselinePath = this.getBaselinePath(snapshotName);
            const currentSnapshot = await this.captureAriaSnapshot(page, options);

            // If no baseline exists or auto-update is on, save and pass
            if (!fs.existsSync(baselinePath) || this.autoUpdate) {
                fs.writeFileSync(baselinePath, currentSnapshot, 'utf8');
                const message = !fs.existsSync(baselinePath)
                    ? `Baseline created: ${snapshotName}`
                    : `Baseline updated: ${snapshotName}`;

                CSReporter.info(message);
                CSReporter.endStep('pass');

                return {
                    passed: true,
                    baselineSnapshot: currentSnapshot,
                    actualSnapshot: currentSnapshot,
                    message
                };
            }

            const baselineSnapshot = fs.readFileSync(baselinePath, 'utf8');
            const differences = this.diffSnapshots(baselineSnapshot, currentSnapshot);
            const passed = differences.length === 0;

            const result: AriaSnapshotComparison = {
                passed,
                baselineSnapshot,
                actualSnapshot: currentSnapshot,
                differences: passed ? undefined : differences,
                message: passed
                    ? `Aria snapshot matches baseline: ${snapshotName}`
                    : `Aria snapshot differs from baseline: ${snapshotName} (${differences.length} difference(s))`
            };

            if (passed) {
                CSReporter.info(result.message);
                CSReporter.endStep('pass');
            } else {
                // Save the actual snapshot for debugging
                const actualPath = baselinePath.replace('.yaml', '.actual.yaml');
                fs.writeFileSync(actualPath, currentSnapshot, 'utf8');
                CSReporter.warn(result.message);
                CSReporter.endStep('fail');
            }

            return result;
        } catch (error: any) {
            CSReporter.endStep('fail');
            CSReporter.error(`Failed to compare aria snapshot: ${error.message}`);
            throw error;
        }
    }

    /**
     * Saves the current page aria tree as a new baseline.
     */
    public async updateBaseline(page: Page, snapshotName: string, options: AriaSnapshotOptions = {}): Promise<void> {
        CSReporter.startStep(`Updating aria baseline: ${snapshotName}`);

        try {
            const snapshot = await this.captureAriaSnapshot(page, options);
            const baselinePath = this.getBaselinePath(snapshotName);

            fs.writeFileSync(baselinePath, snapshot, 'utf8');

            CSReporter.info(`Aria baseline updated: ${baselinePath}`);
            CSReporter.endStep('pass');
        } catch (error: any) {
            CSReporter.endStep('fail');
            CSReporter.error(`Failed to update aria baseline: ${error.message}`);
            throw error;
        }
    }

    /**
     * Runs structural accessibility checks by analysing the aria tree.
     * Checks: missing labels, missing alt text, heading hierarchy, landmark roles.
     */
    public async validateAccessibility(page: Page, options: AriaSnapshotOptions = {}): Promise<AccessibilityReport> {
        CSReporter.startStep('Validating accessibility via aria tree');

        try {
            const snapshot = await this.captureAriaSnapshot(page, options);
            const lines = snapshot.split('\n');
            const violations: AccessibilityViolation[] = [];
            let passes = 0;
            let incomplete = 0;

            // Check for missing labels on interactive elements
            this.checkMissingLabels(lines, violations);

            // Check for missing alt text on images
            this.checkMissingAltText(lines, violations);

            // Check heading hierarchy
            this.checkHeadingHierarchy(lines, violations);

            // Check for landmark roles
            this.checkLandmarkRoles(lines, violations);

            // Count passes (lines with proper roles that passed all checks)
            passes = this.countPasses(lines, violations);

            const url = page.url();
            const report: AccessibilityReport = {
                url,
                timestamp: new Date(),
                violations,
                passes,
                incomplete,
                summary: this.buildSummary(violations, passes)
            };

            if (violations.length === 0) {
                CSReporter.info(`Accessibility validation passed: ${passes} checks passed`);
                CSReporter.endStep('pass');
            } else {
                const criticalCount = violations.filter(v => v.impact === 'critical').length;
                const seriousCount = violations.filter(v => v.impact === 'serious').length;
                CSReporter.warn(`Accessibility validation found ${violations.length} violation(s) (${criticalCount} critical, ${seriousCount} serious)`);
                CSReporter.endStep('fail');
            }

            return report;
        } catch (error: any) {
            CSReporter.endStep('fail');
            CSReporter.error(`Failed to validate accessibility: ${error.message}`);
            throw error;
        }
    }

    /**
     * Returns the aria tree parsed into a structured object.
     */
    public async getAriaTree(page: Page): Promise<AriaTreeNode> {
        CSReporter.startStep('Parsing aria tree');

        try {
            const snapshot = await this.captureAriaSnapshot(page);
            const tree = this.parseAriaSnapshot(snapshot);

            CSReporter.endStep('pass');
            return tree;
        } catch (error: any) {
            CSReporter.endStep('fail');
            CSReporter.error(`Failed to parse aria tree: ${error.message}`);
            throw error;
        }
    }

    // ---------------------------------------------------------------------------
    // Private helpers
    // ---------------------------------------------------------------------------

    private getBaselinePath(snapshotName: string): string {
        const sanitized = snapshotName.replace(/[^a-zA-Z0-9_-]/g, '_');
        return path.join(this.snapshotDir, `${sanitized}.yaml`);
    }

    /**
     * Simple line-based diff between two YAML snapshots.
     */
    private diffSnapshots(baseline: string, actual: string): string[] {
        const baselineLines = baseline.split('\n');
        const actualLines = actual.split('\n');
        const differences: string[] = [];

        const maxLen = Math.max(baselineLines.length, actualLines.length);

        for (let i = 0; i < maxLen; i++) {
            const bLine = baselineLines[i] ?? '';
            const aLine = actualLines[i] ?? '';

            if (bLine !== aLine) {
                differences.push(`Line ${i + 1}: expected "${bLine}" but got "${aLine}"`);
            }
        }

        return differences;
    }

    /**
     * Check for interactive elements (button, textbox, link, etc.) without labels.
     */
    private checkMissingLabels(lines: string[], violations: AccessibilityViolation[]): void {
        const interactiveRoles = ['button', 'textbox', 'checkbox', 'radio', 'combobox', 'slider', 'spinbutton', 'switch', 'searchbox', 'menuitem'];
        const labelPattern = /- (\w+)\s+"([^"]*)"/;
        const noLabelPattern = /- (\w+)\s*$/;
        const emptyLabelPattern = /- (\w+)\s+""\s*$/;

        for (const line of lines) {
            const noLabelMatch = line.match(noLabelPattern);
            const emptyLabelMatch = line.match(emptyLabelPattern);

            if (noLabelMatch || emptyLabelMatch) {
                const role = (noLabelMatch || emptyLabelMatch)![1];
                if (interactiveRoles.includes(role)) {
                    violations.push({
                        id: 'missing-label',
                        impact: 'critical',
                        description: `Interactive element with role "${role}" has no accessible label`,
                        element: line.trim(),
                        help: 'All interactive elements must have an accessible label via aria-label, aria-labelledby, or visible text content.',
                        helpUrl: 'https://dequeuniversity.com/rules/axe/4.4/label'
                    });
                }
            }
        }
    }

    /**
     * Check for images missing alt text.
     */
    private checkMissingAltText(lines: string[], violations: AccessibilityViolation[]): void {
        const imgNoAlt = /- img\s*$/;
        const imgEmptyAlt = /- img\s+""\s*$/;

        for (const line of lines) {
            if (imgNoAlt.test(line.trim()) || imgEmptyAlt.test(line.trim())) {
                violations.push({
                    id: 'missing-alt-text',
                    impact: 'serious',
                    description: 'Image element has no alt text',
                    element: line.trim(),
                    help: 'All informative images must have descriptive alt text. Decorative images should use alt="" with role="presentation".',
                    helpUrl: 'https://dequeuniversity.com/rules/axe/4.4/image-alt'
                });
            }
        }
    }

    /**
     * Check that heading levels do not skip (e.g. h1 -> h3 without h2).
     */
    private checkHeadingHierarchy(lines: string[], violations: AccessibilityViolation[]): void {
        const headingPattern = /- heading\s+"[^"]*"\s*\[level=(\d+)\]/;
        const headingLevels: number[] = [];

        for (const line of lines) {
            const match = line.match(headingPattern);
            if (match) {
                headingLevels.push(parseInt(match[1], 10));
            }
        }

        if (headingLevels.length === 0) {
            return;
        }

        // Check for skipped levels
        for (let i = 1; i < headingLevels.length; i++) {
            const prev = headingLevels[i - 1];
            const curr = headingLevels[i];

            // A heading level can go deeper by at most 1 at a time
            if (curr > prev + 1) {
                violations.push({
                    id: 'heading-order',
                    impact: 'moderate',
                    description: `Heading hierarchy skips from h${prev} to h${curr}`,
                    help: 'Heading levels should increase by one without skipping levels (e.g. h1, h2, h3 not h1, h3).',
                    helpUrl: 'https://dequeuniversity.com/rules/axe/4.4/heading-order'
                });
            }
        }
    }

    /**
     * Check that at least one landmark role exists on the page.
     */
    private checkLandmarkRoles(lines: string[], violations: AccessibilityViolation[]): void {
        const landmarkRoles = ['banner', 'navigation', 'main', 'contentinfo', 'complementary', 'search', 'form', 'region'];
        const hasLandmark = lines.some(line => {
            return landmarkRoles.some(role => {
                const pattern = new RegExp(`- ${role}\\b`);
                return pattern.test(line);
            });
        });

        if (!hasLandmark) {
            violations.push({
                id: 'landmark-missing',
                impact: 'moderate',
                description: 'Page has no landmark roles (banner, navigation, main, contentinfo, etc.)',
                help: 'Pages should use ARIA landmark roles or HTML5 sectioning elements to identify regions of the page.',
                helpUrl: 'https://dequeuniversity.com/rules/axe/4.4/landmark-one-main'
            });
        }

        // Specifically check for missing main landmark
        const hasMain = lines.some(line => /- main\b/.test(line));
        if (!hasMain && hasLandmark) {
            violations.push({
                id: 'landmark-main-missing',
                impact: 'serious',
                description: 'Page has landmark roles but no main landmark',
                help: 'Every page should have a single main landmark to identify the primary content area.',
                helpUrl: 'https://dequeuniversity.com/rules/axe/4.4/landmark-one-main'
            });
        }
    }

    /**
     * Count the number of elements that passed accessibility checks.
     */
    private countPasses(lines: string[], violations: AccessibilityViolation[]): number {
        let count = 0;
        const violatedElements = new Set(violations.map(v => v.element));

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('- ') && !violatedElements.has(trimmed)) {
                count++;
            }
        }

        return count;
    }

    private buildSummary(violations: AccessibilityViolation[], passes: number): string {
        if (violations.length === 0) {
            return `All ${passes} accessibility checks passed.`;
        }

        const bySeverity = {
            critical: violations.filter(v => v.impact === 'critical').length,
            serious: violations.filter(v => v.impact === 'serious').length,
            moderate: violations.filter(v => v.impact === 'moderate').length,
            minor: violations.filter(v => v.impact === 'minor').length
        };

        const parts: string[] = [];
        if (bySeverity.critical > 0) parts.push(`${bySeverity.critical} critical`);
        if (bySeverity.serious > 0) parts.push(`${bySeverity.serious} serious`);
        if (bySeverity.moderate > 0) parts.push(`${bySeverity.moderate} moderate`);
        if (bySeverity.minor > 0) parts.push(`${bySeverity.minor} minor`);

        return `${violations.length} violation(s) found (${parts.join(', ')}). ${passes} checks passed.`;
    }

    /**
     * Parses YAML-style aria snapshot into a tree structure.
     * Each line has indentation indicating depth and format: "- role \"name\""
     */
    private parseAriaSnapshot(snapshot: string): AriaTreeNode {
        const lines = snapshot.split('\n').filter(l => l.trim().length > 0);
        const root: AriaTreeNode = { role: 'document', name: '', children: [], depth: -1 };

        if (lines.length === 0) {
            return root;
        }

        const stack: AriaTreeNode[] = [root];

        for (const line of lines) {
            const indentMatch = line.match(/^(\s*)/);
            const indent = indentMatch ? indentMatch[1].length : 0;
            const depth = Math.floor(indent / 2);

            const entryMatch = line.trim().match(/^- (\w+)(?:\s+"([^"]*)")?(.*)$/);
            if (!entryMatch) {
                continue;
            }

            const role = entryMatch[1];
            const name = entryMatch[2] || '';
            const extra = entryMatch[3] || '';

            const node: AriaTreeNode = {
                role,
                name,
                children: [],
                depth,
                attributes: extra.trim() || undefined
            };

            // Pop stack until we find the parent at a lesser depth
            while (stack.length > 1 && stack[stack.length - 1].depth >= depth) {
                stack.pop();
            }

            const parent = stack[stack.length - 1];
            parent.children.push(node);
            stack.push(node);
        }

        return root;
    }
}

/**
 * Represents a node in the parsed aria tree.
 */
export interface AriaTreeNode {
    role: string;
    name: string;
    children: AriaTreeNode[];
    depth: number;
    attributes?: string;
}
