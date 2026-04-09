import { CSBDDStepDef } from '../../bdd/CSStepRegistry';
import { CSReporter } from '../../reporter/CSReporter';
import { CSBrowserManager } from '../../browser/CSBrowserManager';
import { CSVisualAITesting } from '../../visual/CSVisualAITesting';
import { SmartVisualResult } from '../../visual/CSVisualAITypes';

/**
 * CSVisualAISteps - BDD Step Definitions for Visual AI Testing
 *
 * Enhancement #11: Provides Gherkin step definitions for smart visual comparison,
 * structural matching, perceptual matching, region-based comparison, and
 * baseline management.
 */
export class CSVisualAISteps {
    private static visualAI: CSVisualAITesting = CSVisualAITesting.getInstance();

    // =========================================================================
    // THEN STEPS - Assertions
    // =========================================================================

    /**
     * Runs combined smart visual comparison (pixel + perceptual + structural)
     * and asserts the page matches the baseline.
     *
     * Example: Then the page should visually match smart snapshot "homepage"
     */
    @CSBDDStepDef('the page should visually match smart snapshot {string}')
    static async smartVisualMatch(snapshotName: string): Promise<void> {
        const page = CSBrowserManager.getInstance().getPage();
        if (!page) {
            throw new Error('No active page available for visual AI comparison');
        }

        const result: SmartVisualResult = await CSVisualAISteps.visualAI.compareSmartVisual(page, snapshotName);

        if (!result.passed) {
            const details = [
                `Verdict: ${result.verdict}`,
                `Pixel: ${result.pixelResult.passed ? 'passed' : 'failed'} (${result.pixelResult.diffPercentage.toFixed(2)}% diff)`,
                `Perceptual: ${result.perceptualResult.passed ? 'passed' : 'failed'} (distance ${result.perceptualResult.hammingDistance}/${result.perceptualResult.maxDistance})`,
                `Structural: ${result.structuralResult.passed ? 'passed' : 'failed'} (${result.structuralResult.ariaChanges.length} aria, ${result.structuralResult.layoutChanges.length} layout changes)`
            ];
            throw new Error(`Smart visual comparison failed for '${snapshotName}': ${result.message}\n${details.join('\n')}`);
        }

        CSReporter.pass(`Smart visual match passed for '${snapshotName}': ${result.verdict}`);
    }

    /**
     * Compares only the structural (aria tree + layout) aspects of the page.
     *
     * Example: Then the page should structurally match snapshot "dashboard"
     */
    @CSBDDStepDef('the page should structurally match snapshot {string}')
    static async structuralMatch(snapshotName: string): Promise<void> {
        const page = CSBrowserManager.getInstance().getPage();
        if (!page) {
            throw new Error('No active page available for structural comparison');
        }

        const result = await CSVisualAISteps.visualAI.compareStructural(page, snapshotName);

        if (!result.passed) {
            const details: string[] = [];
            if (result.ariaChanges.length > 0) {
                details.push(`Aria changes: ${result.ariaChanges.slice(0, 5).join('; ')}`);
            }
            if (result.layoutChanges.length > 0) {
                const layoutDescs = result.layoutChanges.slice(0, 5).map(c =>
                    `${c.element} ${c.type}`
                );
                details.push(`Layout changes: ${layoutDescs.join('; ')}`);
            }
            throw new Error(`Structural comparison failed for '${snapshotName}': ${result.message}\n${details.join('\n')}`);
        }

        CSReporter.pass(`Structural match passed for '${snapshotName}'`);
    }

    /**
     * Compares only the perceptual hash of the page screenshot.
     *
     * Example: Then the page should perceptually match snapshot "login-page"
     */
    @CSBDDStepDef('the page should perceptually match snapshot {string}')
    static async perceptualMatch(snapshotName: string): Promise<void> {
        const page = CSBrowserManager.getInstance().getPage();
        if (!page) {
            throw new Error('No active page available for perceptual comparison');
        }

        const result = await CSVisualAISteps.visualAI.comparePerceptual(page, snapshotName);

        if (!result.passed) {
            throw new Error(
                `Perceptual comparison failed for '${snapshotName}': Hamming distance ${result.hammingDistance}/${result.maxDistance} exceeds threshold`
            );
        }

        CSReporter.pass(`Perceptual match passed for '${snapshotName}' (distance: ${result.hammingDistance}/${result.maxDistance})`);
    }

    /**
     * Compares a specific region of the page identified by a CSS selector.
     *
     * Example: Then the "#header" region should visually match snapshot "header-baseline"
     */
    @CSBDDStepDef('the {string} region should visually match snapshot {string}')
    static async regionVisualMatch(regionSelector: string, snapshotName: string): Promise<void> {
        const page = CSBrowserManager.getInstance().getPage();
        if (!page) {
            throw new Error('No active page available for region comparison');
        }

        const result: SmartVisualResult = await CSVisualAISteps.visualAI.compareRegion(
            page,
            snapshotName,
            regionSelector
        );

        if (!result.passed) {
            throw new Error(
                `Region visual comparison failed for '${regionSelector}' in '${snapshotName}': ${result.message}`
            );
        }

        CSReporter.pass(`Region '${regionSelector}' visual match passed for '${snapshotName}': ${result.verdict}`);
    }

    // =========================================================================
    // WHEN STEPS - Actions
    // =========================================================================

    /**
     * Updates all smart visual baselines (pixel, perceptual, structural) for
     * the current page state.
     *
     * Example: When I update smart visual baseline "homepage"
     */
    @CSBDDStepDef('I update smart visual baseline {string}')
    static async updateBaseline(snapshotName: string): Promise<void> {
        const page = CSBrowserManager.getInstance().getPage();
        if (!page) {
            throw new Error('No active page available for baseline update');
        }

        await CSVisualAISteps.visualAI.updateSmartBaseline(page, snapshotName);
        CSReporter.pass(`Smart visual baselines updated for '${snapshotName}'`);
    }

    // =========================================================================
    // THEN STEPS - Cosmetic-Only Assertion
    // =========================================================================

    /**
     * Asserts that any visual changes detected are cosmetic only (no structural
     * changes). Useful for verifying that CSS-only changes have not altered
     * page structure.
     *
     * Example: Then any visual changes should be cosmetic only for "settings-page"
     */
    @CSBDDStepDef('any visual changes should be cosmetic only for {string}')
    static async assertCosmeticOnly(snapshotName: string): Promise<void> {
        const page = CSBrowserManager.getInstance().getPage();
        if (!page) {
            throw new Error('No active page available for cosmetic-only assertion');
        }

        const result = await CSVisualAISteps.visualAI.assertCosmeticOnly(page, snapshotName);
        CSReporter.pass(`Cosmetic-only assertion passed for '${snapshotName}': ${result.verdict}`);
    }
}
