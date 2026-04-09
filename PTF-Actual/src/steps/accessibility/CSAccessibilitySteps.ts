import { CSBDDStepDef } from '../../bdd/CSStepRegistry';
import { Given, When, Then } from '../../bdd/CSCucumberDecorators';
import { CSAriaSnapshotTesting } from '../../accessibility/CSAriaSnapshotTesting';
import { CSBrowserManager } from '../../browser/CSBrowserManager';
import { CSReporter } from '../../reporter/CSReporter';
import { CSScenarioContext } from '../../bdd/CSScenarioContext';
import { AccessibilityReport } from '../../accessibility/CSAccessibilityTypes';

/**
 * Accessibility Testing BDD Steps
 * Provides Gherkin step definitions for aria snapshot testing and accessibility validation.
 */
export class CSAccessibilitySteps {
    private static ariaSnapshotTesting: CSAriaSnapshotTesting = CSAriaSnapshotTesting.getInstance();
    private static context: CSScenarioContext = CSScenarioContext.getInstance();

    // ===============================================================================
    // THEN STEPS - Aria Snapshot Assertions
    // ===============================================================================

    @CSBDDStepDef('the page accessibility tree should match snapshot {string}')
    @Then('the page accessibility tree should match snapshot {string}')
    static async pageAriaTreeShouldMatchSnapshot(snapshotName: string): Promise<void> {
        CSReporter.info(`Comparing page aria tree against baseline: ${snapshotName}`);

        try {
            const page = CSBrowserManager.getInstance().getPage();
            const result = await CSAccessibilitySteps.ariaSnapshotTesting.compareAriaSnapshot(page, snapshotName);

            CSAccessibilitySteps.context.set('lastAriaComparison', result);

            if (!result.passed) {
                throw new Error(result.message + '\nDifferences:\n' + (result.differences || []).join('\n'));
            }
        } catch (error: any) {
            CSReporter.error(`Aria snapshot comparison failed: ${error.message}`);
            throw error;
        }
    }

    @CSBDDStepDef('the {string} accessibility should match snapshot {string}')
    @Then('the {string} accessibility should match snapshot {string}')
    static async elementAriaTreeShouldMatchSnapshot(selector: string, snapshotName: string): Promise<void> {
        CSReporter.info(`Comparing element "${selector}" aria tree against baseline: ${snapshotName}`);

        try {
            const page = CSBrowserManager.getInstance().getPage();
            const result = await CSAccessibilitySteps.ariaSnapshotTesting.compareAriaSnapshot(page, snapshotName, { selector });

            CSAccessibilitySteps.context.set('lastAriaComparison', result);

            if (!result.passed) {
                throw new Error(result.message + '\nDifferences:\n' + (result.differences || []).join('\n'));
            }
        } catch (error: any) {
            CSReporter.error(`Element aria snapshot comparison failed: ${error.message}`);
            throw error;
        }
    }

    // ===============================================================================
    // WHEN STEPS - Capture and Update
    // ===============================================================================

    @CSBDDStepDef('I capture accessibility snapshot {string}')
    @When('I capture accessibility snapshot {string}')
    static async captureAccessibilitySnapshot(snapshotName: string): Promise<void> {
        CSReporter.info(`Capturing accessibility snapshot: ${snapshotName}`);

        try {
            const page = CSBrowserManager.getInstance().getPage();
            const snapshot = await CSAccessibilitySteps.ariaSnapshotTesting.captureAriaSnapshot(page);

            CSAccessibilitySteps.context.set('lastAriaSnapshot', snapshot);
            CSAccessibilitySteps.context.set('lastAriaSnapshotName', snapshotName);

            CSReporter.info(`Accessibility snapshot captured: ${snapshotName}`);
        } catch (error: any) {
            CSReporter.error(`Failed to capture accessibility snapshot: ${error.message}`);
            throw error;
        }
    }

    @CSBDDStepDef('I update accessibility baseline {string}')
    @When('I update accessibility baseline {string}')
    static async updateAccessibilityBaseline(snapshotName: string): Promise<void> {
        CSReporter.info(`Updating accessibility baseline: ${snapshotName}`);

        try {
            const page = CSBrowserManager.getInstance().getPage();
            await CSAccessibilitySteps.ariaSnapshotTesting.updateBaseline(page, snapshotName);

            CSReporter.info(`Accessibility baseline updated: ${snapshotName}`);
        } catch (error: any) {
            CSReporter.error(`Failed to update accessibility baseline: ${error.message}`);
            throw error;
        }
    }

    // ===============================================================================
    // THEN STEPS - Accessibility Validation
    // ===============================================================================

    @CSBDDStepDef('the page should have no critical accessibility violations')
    @Then('the page should have no critical accessibility violations')
    static async pageShouldHaveNoCriticalViolations(): Promise<void> {
        CSReporter.info('Checking page for critical accessibility violations');

        try {
            const page = CSBrowserManager.getInstance().getPage();
            const report = await CSAccessibilitySteps.ariaSnapshotTesting.validateAccessibility(page);

            CSAccessibilitySteps.context.set('lastAccessibilityReport', report);

            const criticalViolations = report.violations.filter(v => v.impact === 'critical');

            if (criticalViolations.length > 0) {
                const details = criticalViolations
                    .map(v => `  - [${v.id}] ${v.description}`)
                    .join('\n');
                throw new Error(`Found ${criticalViolations.length} critical accessibility violation(s):\n${details}`);
            }

            CSReporter.info('No critical accessibility violations found');
        } catch (error: any) {
            CSReporter.error(`Critical accessibility violation check failed: ${error.message}`);
            throw error;
        }
    }

    @CSBDDStepDef('the page should have no accessibility violations with impact {string}')
    @Then('the page should have no accessibility violations with impact {string}')
    static async pageShouldHaveNoViolationsWithImpact(impact: string): Promise<void> {
        CSReporter.info(`Checking page for accessibility violations with impact: ${impact}`);

        try {
            const page = CSBrowserManager.getInstance().getPage();
            const report = await CSAccessibilitySteps.ariaSnapshotTesting.validateAccessibility(page);

            CSAccessibilitySteps.context.set('lastAccessibilityReport', report);

            const impactLevels = CSAccessibilitySteps.getImpactLevelsAtOrAbove(impact);
            const matchingViolations = report.violations.filter(v => impactLevels.includes(v.impact));

            if (matchingViolations.length > 0) {
                const details = matchingViolations
                    .map(v => `  - [${v.impact}][${v.id}] ${v.description}`)
                    .join('\n');
                throw new Error(`Found ${matchingViolations.length} accessibility violation(s) at impact "${impact}" or above:\n${details}`);
            }

            CSReporter.info(`No accessibility violations with impact "${impact}" or above found`);
        } catch (error: any) {
            CSReporter.error(`Accessibility violation check failed: ${error.message}`);
            throw error;
        }
    }

    @CSBDDStepDef('the heading hierarchy should be valid')
    @Then('the heading hierarchy should be valid')
    static async headingHierarchyShouldBeValid(): Promise<void> {
        CSReporter.info('Validating heading hierarchy');

        try {
            const page = CSBrowserManager.getInstance().getPage();
            const report = await CSAccessibilitySteps.ariaSnapshotTesting.validateAccessibility(page);

            CSAccessibilitySteps.context.set('lastAccessibilityReport', report);

            const headingViolations = report.violations.filter(v => v.id === 'heading-order');

            if (headingViolations.length > 0) {
                const details = headingViolations
                    .map(v => `  - ${v.description}`)
                    .join('\n');
                throw new Error(`Heading hierarchy is invalid:\n${details}`);
            }

            CSReporter.info('Heading hierarchy is valid');
        } catch (error: any) {
            CSReporter.error(`Heading hierarchy validation failed: ${error.message}`);
            throw error;
        }
    }

    @CSBDDStepDef('all interactive elements should have accessible labels')
    @Then('all interactive elements should have accessible labels')
    static async allInteractiveElementsShouldHaveLabels(): Promise<void> {
        CSReporter.info('Checking that all interactive elements have accessible labels');

        try {
            const page = CSBrowserManager.getInstance().getPage();
            const report = await CSAccessibilitySteps.ariaSnapshotTesting.validateAccessibility(page);

            CSAccessibilitySteps.context.set('lastAccessibilityReport', report);

            const labelViolations = report.violations.filter(v => v.id === 'missing-label');

            if (labelViolations.length > 0) {
                const details = labelViolations
                    .map(v => `  - ${v.description} (${v.element || 'unknown element'})`)
                    .join('\n');
                throw new Error(`Found ${labelViolations.length} interactive element(s) without accessible labels:\n${details}`);
            }

            CSReporter.info('All interactive elements have accessible labels');
        } catch (error: any) {
            CSReporter.error(`Interactive element label check failed: ${error.message}`);
            throw error;
        }
    }

    @CSBDDStepDef('all images should have alt text')
    @Then('all images should have alt text')
    static async allImagesShouldHaveAltText(): Promise<void> {
        CSReporter.info('Checking that all images have alt text');

        try {
            const page = CSBrowserManager.getInstance().getPage();
            const report = await CSAccessibilitySteps.ariaSnapshotTesting.validateAccessibility(page);

            CSAccessibilitySteps.context.set('lastAccessibilityReport', report);

            const altTextViolations = report.violations.filter(v => v.id === 'missing-alt-text');

            if (altTextViolations.length > 0) {
                const details = altTextViolations
                    .map(v => `  - ${v.description} (${v.element || 'unknown element'})`)
                    .join('\n');
                throw new Error(`Found ${altTextViolations.length} image(s) without alt text:\n${details}`);
            }

            CSReporter.info('All images have alt text');
        } catch (error: any) {
            CSReporter.error(`Image alt text check failed: ${error.message}`);
            throw error;
        }
    }

    // ===============================================================================
    // Private Helpers
    // ===============================================================================

    /**
     * Returns the list of impact levels at or above the given level.
     * Severity order: critical > serious > moderate > minor
     */
    private static getImpactLevelsAtOrAbove(impact: string): string[] {
        const all: Array<'critical' | 'serious' | 'moderate' | 'minor'> = ['critical', 'serious', 'moderate', 'minor'];
        const index = all.indexOf(impact as any);

        if (index === -1) {
            // Unknown impact level, default to only matching exact
            return [impact];
        }

        return all.slice(0, index + 1);
    }
}
