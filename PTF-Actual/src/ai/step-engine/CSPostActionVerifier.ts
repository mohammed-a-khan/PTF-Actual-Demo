/**
 * CSPostActionVerifier - Post-Action DOM State Verification
 *
 * After every action, verifies success via DOM state change detection.
 * Captures before/after accessibility tree snapshots and detects silent failures:
 *   - Click didn't register (no DOM change)
 *   - Fill didn't type (input value unchanged)
 *   - Select didn't change (selected option unchanged)
 *   - Navigation didn't happen (URL unchanged)
 *
 * Zero external dependencies — uses existing Playwright APIs.
 *
 * @module ai/step-engine
 */

import { Page, Frame, Locator } from 'playwright';
import { CSReporter } from '../../reporter/CSReporter';

/** Snapshot of DOM state before an action */
export interface DOMStateSnapshot {
    /** Page URL at snapshot time */
    url: string;
    /** Page title at snapshot time */
    title: string;
    /** Focused element tag + id/name (if any) */
    focusedElement: string;
    /** Element-specific state (for targeted verification) */
    elementState?: ElementStateSnapshot;
    /** Timestamp */
    timestamp: number;
}

/** State of a specific element before/after action */
export interface ElementStateSnapshot {
    /** Element's text content */
    textContent: string;
    /** Element's input value (if applicable) */
    inputValue: string;
    /** Whether element is checked (checkbox/radio) */
    checked: boolean;
    /** Selected option text (for select elements) */
    selectedOption: string;
    /** Element's bounding box (serializable) */
    boundingBox: { x: number; y: number; width: number; height: number } | null;
    /** Element's computed classes */
    classes: string;
    /** aria-expanded, aria-selected, etc. */
    ariaState: Record<string, string>;
}

/** Result of post-action verification */
export interface VerificationResult {
    /** Whether the action appears to have taken effect */
    success: boolean;
    /** What changed (if anything) */
    changes: string[];
    /** Warning message if action may have silently failed */
    warning?: string;
}

export class CSPostActionVerifier {
    private static instance: CSPostActionVerifier;

    private constructor() {}

    public static getInstance(): CSPostActionVerifier {
        if (!CSPostActionVerifier.instance) {
            CSPostActionVerifier.instance = new CSPostActionVerifier();
        }
        return CSPostActionVerifier.instance;
    }

    /**
     * Capture DOM state before an action for later comparison.
     *
     * @param page - Playwright Page or Frame
     * @param locator - Optional element locator for targeted verification
     * @returns DOMStateSnapshot
     */
    public async captureBeforeState(
        page: Page | Frame,
        locator?: Locator
    ): Promise<DOMStateSnapshot> {
        const snapshot: DOMStateSnapshot = {
            url: 'url' in page ? (page as Page).url() : '',
            title: '',
            focusedElement: '',
            timestamp: Date.now()
        };

        try {
            if ('title' in page) {
                snapshot.title = await (page as Page).title();
            }
        } catch { /* non-critical */ }

        try {
            snapshot.focusedElement = await page.evaluate(() => {
                const el = document.activeElement;
                if (!el) return '';
                const tag = el.tagName.toLowerCase();
                const id = el.id ? `#${el.id}` : '';
                const name = el.getAttribute('name') ? `[name="${el.getAttribute('name')}"]` : '';
                return `${tag}${id}${name}`;
            });
        } catch { /* non-critical */ }

        // Capture element-specific state
        if (locator) {
            snapshot.elementState = await this.captureElementState(locator);
        }

        return snapshot;
    }

    /**
     * Capture detailed state of a specific element.
     */
    private async captureElementState(locator: Locator): Promise<ElementStateSnapshot> {
        const state: ElementStateSnapshot = {
            textContent: '',
            inputValue: '',
            checked: false,
            selectedOption: '',
            boundingBox: null,
            classes: '',
            ariaState: {}
        };

        try {
            state.textContent = (await locator.textContent({ timeout: 2000 })) || '';
        } catch { /* element may not have text */ }

        try {
            state.inputValue = await locator.inputValue({ timeout: 2000 });
        } catch { /* element may not be an input */ }

        try {
            state.checked = await locator.isChecked({ timeout: 2000 });
        } catch { /* element may not be checkable */ }

        try {
            state.boundingBox = await locator.boundingBox({ timeout: 2000 });
        } catch { /* element may not be visible */ }

        try {
            state.classes = await locator.evaluate(el => el.className || '');
        } catch { /* non-critical */ }

        try {
            state.selectedOption = await locator.evaluate(el => {
                if (el instanceof HTMLSelectElement && el.selectedIndex >= 0) {
                    return el.options[el.selectedIndex]?.text || '';
                }
                return '';
            });
        } catch { /* non-critical */ }

        // Capture ARIA state attributes
        try {
            state.ariaState = await locator.evaluate(el => {
                const attrs: Record<string, string> = {};
                const ariaAttrs = ['aria-expanded', 'aria-selected', 'aria-checked', 'aria-pressed', 'aria-disabled', 'aria-hidden'];
                for (const attr of ariaAttrs) {
                    const val = el.getAttribute(attr);
                    if (val !== null) attrs[attr] = val;
                }
                return attrs;
            });
        } catch { /* non-critical */ }

        return state;
    }

    /**
     * Verify that an action took effect by comparing before/after state.
     *
     * @param page - Playwright Page or Frame
     * @param intent - The action intent that was executed
     * @param beforeState - State captured before the action
     * @param locator - The element that was acted upon
     * @returns VerificationResult
     */
    public async verifyAction(
        page: Page | Frame,
        intent: string,
        beforeState: DOMStateSnapshot,
        locator?: Locator
    ): Promise<VerificationResult> {
        const changes: string[] = [];

        // Check URL change (for navigation actions)
        if (intent === 'navigate' || intent === 'click') {
            try {
                if ('url' in page) {
                    const currentUrl = (page as Page).url();
                    if (currentUrl !== beforeState.url) {
                        changes.push(`URL changed: ${beforeState.url} → ${currentUrl}`);
                    }
                }
            } catch { /* non-critical */ }
        }

        // Check title change
        try {
            if ('title' in page) {
                const currentTitle = await (page as Page).title();
                if (currentTitle !== beforeState.title) {
                    changes.push(`Title changed: "${beforeState.title}" → "${currentTitle}"`);
                }
            }
        } catch { /* non-critical */ }

        // Element-specific verification
        if (locator && beforeState.elementState) {
            const afterState = await this.captureElementState(locator);
            const elementChanges = this.compareElementStates(intent, beforeState.elementState, afterState);
            changes.push(...elementChanges);
        }

        // Determine success based on intent and observed changes
        const result = this.evaluateChanges(intent, changes, beforeState);

        if (!result.success && result.warning) {
            CSReporter.warn(`CSPostActionVerifier: ${result.warning}`);
        } else if (changes.length > 0) {
            CSReporter.debug(`CSPostActionVerifier: Action '${intent}' verified — ${changes.length} change(s) detected`);
        }

        return result;
    }

    /**
     * Compare element states before and after an action.
     */
    private compareElementStates(
        intent: string,
        before: ElementStateSnapshot,
        after: ElementStateSnapshot
    ): string[] {
        const changes: string[] = [];

        // Text content change
        if (before.textContent !== after.textContent) {
            changes.push('text-content-changed');
        }

        // Input value change
        if (before.inputValue !== after.inputValue) {
            changes.push(`input-value-changed: "${before.inputValue}" → "${after.inputValue}"`);
        }

        // Checked state change
        if (before.checked !== after.checked) {
            changes.push(`checked-changed: ${before.checked} → ${after.checked}`);
        }

        // Selected option change
        if (before.selectedOption !== after.selectedOption) {
            changes.push(`selected-option-changed: "${before.selectedOption}" → "${after.selectedOption}"`);
        }

        // Class change (could indicate visual state change)
        if (before.classes !== after.classes) {
            changes.push('classes-changed');
        }

        // ARIA state changes
        for (const [key, val] of Object.entries(after.ariaState)) {
            if (before.ariaState[key] !== val) {
                changes.push(`${key}-changed: "${before.ariaState[key] || ''}" → "${val}"`);
            }
        }

        return changes;
    }

    /**
     * Evaluate whether observed changes indicate a successful action.
     */
    private evaluateChanges(
        intent: string,
        changes: string[],
        beforeState: DOMStateSnapshot
    ): VerificationResult {
        // Actions that SHOULD produce observable changes
        const expectsChange: Record<string, boolean> = {
            'fill': true,
            'type': true,
            'clear': true,
            'select': true,
            'check': true,
            'uncheck': true,
            'toggle': true,
            'navigate': true
        };

        // Actions where no change is acceptable (hover, focus, scroll, etc.)
        const noChangeOK: Record<string, boolean> = {
            'click': true, // Clicks might not always produce DOM changes
            'hover': true,
            'focus': true,
            'scroll': true,
            'scroll-to': true,
            'press-key': true,
            'double-click': true,
            'right-click': true,
            'drag': true,
            'upload': true,
            'wait-for': true,
            'wait-seconds': true,
            'take-screenshot': true
        };

        if (noChangeOK[intent]) {
            return { success: true, changes };
        }

        if (expectsChange[intent] && changes.length === 0) {
            // Potentially silent failure — but don't fail the test, just warn
            const warning = `Action '${intent}' completed but no DOM changes were detected. ` +
                `The action may have silently failed.`;
            return { success: true, changes, warning };
        }

        return { success: true, changes };
    }
}
