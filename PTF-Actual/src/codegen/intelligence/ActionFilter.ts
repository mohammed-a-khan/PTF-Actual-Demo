/**
 * ActionFilter - Intelligent Action Filtering and Deduplication
 *
 * Filters noise actions, removes duplicates, and merges semantically equivalent actions.
 * Part of the Enhanced Codegen Intelligence Layer.
 */

import { Action } from '../types';

export interface FilteredActions {
    actions: Action[];
    removed: RemovedAction[];
    merged: MergedAction[];
    stats: FilterStats;
}

export interface RemovedAction {
    action: Action;
    reason: string;
    category: 'noise' | 'duplicate' | 'redundant' | 'container-click';
}

export interface MergedAction {
    original: Action[];
    merged: Action;
    reason: string;
}

export interface FilterStats {
    original: number;
    filtered: number;
    removed: number;
    merged: number;
    noiseRemoved: number;
    duplicatesRemoved: number;
    redundantRemoved: number;
}

export class ActionFilter {
    // Noise action patterns - these are typically recording artifacts
    private static readonly NOISE_PATTERNS = {
        // Consecutive arrow key presses (text editing noise)
        consecutiveArrowKeys: /^Arrow(Left|Right|Up|Down)$/,
        // Keys that are often noise when repeated
        repeatedKeys: ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Backspace', 'Delete'],
        // Maximum allowed consecutive same keypresses
        maxConsecutiveKeypress: 2,
    };

    // Container elements that shouldn't be clicked directly
    private static readonly CONTAINER_SELECTORS = [
        '#rightcol',
        '#leftcol',
        '#maincontent',
        '#content',
        '#wrapper',
        '#container',
        '.container',
        '.wrapper',
        '.content',
        '.main',
        'div[class*="view"]',
        'div[class*="container"]',
        'div[class*="wrapper"]',
    ];

    // Actions that are redundant before fill/type
    private static readonly REDUNDANT_BEFORE_FILL = ['click', 'focus'];

    /**
     * Filter actions - main entry point
     */
    public static filter(actions: Action[]): FilteredActions {
        const removed: RemovedAction[] = [];
        const merged: MergedAction[] = [];
        let filteredActions = [...actions];

        // Phase 1: Remove noise actions (consecutive keypresses)
        const { actions: afterNoise, removed: noiseRemoved } = this.removeNoiseActions(filteredActions);
        filteredActions = afterNoise;
        removed.push(...noiseRemoved);

        // Phase 2: Remove container clicks
        const { actions: afterContainer, removed: containerRemoved } = this.removeContainerClicks(filteredActions);
        filteredActions = afterContainer;
        removed.push(...containerRemoved);

        // Phase 3: Remove redundant click before fill
        const { actions: afterRedundant, removed: redundantRemoved } = this.removeRedundantActions(filteredActions);
        filteredActions = afterRedundant;
        removed.push(...redundantRemoved);

        // Phase 4: Merge semantically equivalent actions
        const { actions: afterMerge, merged: mergedActions } = this.mergeActions(filteredActions);
        filteredActions = afterMerge;
        merged.push(...mergedActions);

        // Phase 5: Deduplicate identical consecutive actions
        const { actions: afterDedup, removed: dedupRemoved } = this.deduplicateConsecutive(filteredActions);
        filteredActions = afterDedup;
        removed.push(...dedupRemoved);

        return {
            actions: filteredActions,
            removed,
            merged,
            stats: {
                original: actions.length,
                filtered: filteredActions.length,
                removed: removed.length,
                merged: merged.length,
                noiseRemoved: noiseRemoved.length,
                duplicatesRemoved: dedupRemoved.length,
                redundantRemoved: redundantRemoved.length + containerRemoved.length,
            },
        };
    }

    /**
     * Remove noise actions - consecutive keypresses, text editing artifacts
     */
    private static removeNoiseActions(actions: Action[]): { actions: Action[]; removed: RemovedAction[] } {
        const result: Action[] = [];
        const removed: RemovedAction[] = [];

        let consecutiveKeyCount = 0;
        let lastKey = '';

        for (let i = 0; i < actions.length; i++) {
            const action = actions[i];

            // Check for keypress actions
            if (action.method === 'press' && action.args && action.args.length > 0) {
                const key = action.args[0] as string;

                // Check if it's a noise key
                if (this.NOISE_PATTERNS.repeatedKeys.includes(key)) {
                    if (key === lastKey) {
                        consecutiveKeyCount++;
                    } else {
                        consecutiveKeyCount = 1;
                        lastKey = key;
                    }

                    // Remove if exceeds max consecutive
                    if (consecutiveKeyCount > this.NOISE_PATTERNS.maxConsecutiveKeypress) {
                        removed.push({
                            action,
                            reason: `Consecutive ${key} keypress (${consecutiveKeyCount}th occurrence)`,
                            category: 'noise',
                        });
                        continue;
                    }
                } else {
                    consecutiveKeyCount = 0;
                    lastKey = '';
                }
            } else {
                consecutiveKeyCount = 0;
                lastKey = '';
            }

            result.push(action);
        }

        return { actions: result, removed };
    }

    /**
     * Remove clicks on container elements
     */
    private static removeContainerClicks(actions: Action[]): { actions: Action[]; removed: RemovedAction[] } {
        const result: Action[] = [];
        const removed: RemovedAction[] = [];

        for (const action of actions) {
            if (action.type === 'click' && action.target) {
                const selector = action.target.selector || '';

                // Check if clicking on a container
                const isContainerClick = this.CONTAINER_SELECTORS.some(container => {
                    if (container.startsWith('#') || container.startsWith('.')) {
                        return selector.includes(container);
                    }
                    return selector.includes(container);
                });

                if (isContainerClick && !this.hasInteractiveRole(action)) {
                    removed.push({
                        action,
                        reason: `Click on container element: ${selector}`,
                        category: 'container-click',
                    });
                    continue;
                }
            }

            result.push(action);
        }

        return { actions: result, removed };
    }

    /**
     * Check if action has an interactive role
     */
    private static hasInteractiveRole(action: Action): boolean {
        const interactiveRoles = ['button', 'link', 'checkbox', 'radio', 'textbox', 'combobox', 'listbox', 'menuitem', 'tab'];

        if (action.target?.type === 'getByRole') {
            return interactiveRoles.includes(action.target.selector);
        }

        if (action.target?.options?.name) {
            return true; // Has a name, likely interactive
        }

        return false;
    }

    /**
     * Remove redundant actions (click before fill on same element)
     */
    private static removeRedundantActions(actions: Action[]): { actions: Action[]; removed: RemovedAction[] } {
        const result: Action[] = [];
        const removed: RemovedAction[] = [];

        for (let i = 0; i < actions.length; i++) {
            const action = actions[i];
            const nextAction = actions[i + 1];

            // Check if this is a click/focus followed by fill on same element
            if (nextAction &&
                this.REDUNDANT_BEFORE_FILL.includes(action.method) &&
                (nextAction.method === 'fill' || nextAction.method === 'type')) {

                // Check if same element
                if (this.isSameElement(action, nextAction)) {
                    removed.push({
                        action,
                        reason: `Redundant ${action.method} before ${nextAction.method} on same element`,
                        category: 'redundant',
                    });
                    continue;
                }
            }

            result.push(action);
        }

        return { actions: result, removed };
    }

    /**
     * Merge semantically equivalent actions
     */
    private static mergeActions(actions: Action[]): { actions: Action[]; merged: MergedAction[] } {
        const result: Action[] = [];
        const merged: MergedAction[] = [];

        for (let i = 0; i < actions.length; i++) {
            const action = actions[i];
            const nextAction = actions[i + 1];

            // Merge clear + fill into single fill (fill already clears)
            if (action.method === 'clear' && nextAction?.method === 'fill') {
                if (this.isSameElement(action, nextAction)) {
                    merged.push({
                        original: [action, nextAction],
                        merged: nextAction,
                        reason: 'Merged clear + fill (fill already clears the field)',
                    });
                    // Skip the clear, let fill be added in next iteration
                    continue;
                }
            }

            result.push(action);
        }

        return { actions: result, merged };
    }

    /**
     * Deduplicate identical consecutive actions
     */
    private static deduplicateConsecutive(actions: Action[]): { actions: Action[]; removed: RemovedAction[] } {
        const result: Action[] = [];
        const removed: RemovedAction[] = [];

        for (let i = 0; i < actions.length; i++) {
            const action = actions[i];
            const prevAction = result[result.length - 1];

            // Check if identical to previous action
            if (prevAction && this.isIdenticalAction(action, prevAction)) {
                removed.push({
                    action,
                    reason: `Duplicate of previous action: ${action.method}`,
                    category: 'duplicate',
                });
                continue;
            }

            result.push(action);
        }

        return { actions: result, removed };
    }

    /**
     * Check if two actions target the same element
     */
    private static isSameElement(action1: Action, action2: Action): boolean {
        if (!action1.target || !action2.target) return false;

        // Compare selector
        if (action1.target.selector !== action2.target.selector) return false;

        // Compare type
        if (action1.target.type !== action2.target.type) return false;

        // Compare options (name)
        const name1 = action1.target.options?.name;
        const name2 = action2.target.options?.name;
        if (name1 !== name2) return false;

        return true;
    }

    /**
     * Check if two actions are identical
     */
    private static isIdenticalAction(action1: Action, action2: Action): boolean {
        // Must be same method
        if (action1.method !== action2.method) return false;

        // Must be same type
        if (action1.type !== action2.type) return false;

        // Must target same element
        if (!this.isSameElement(action1, action2)) return false;

        // For fill/type, must have same value
        if (action1.method === 'fill' || action1.method === 'type') {
            if (JSON.stringify(action1.args) !== JSON.stringify(action2.args)) return false;
        }

        return true;
    }

    /**
     * Get filter statistics summary
     */
    public static getSummary(result: FilteredActions): string {
        const { stats } = result;
        const lines = [
            `📊 Action Filter Summary:`,
            `   Original actions: ${stats.original}`,
            `   Filtered actions: ${stats.filtered}`,
            `   Removed: ${stats.removed} (${Math.round((stats.removed / stats.original) * 100)}%)`,
            `   - Noise removed: ${stats.noiseRemoved}`,
            `   - Duplicates removed: ${stats.duplicatesRemoved}`,
            `   - Redundant removed: ${stats.redundantRemoved}`,
            `   Merged: ${stats.merged}`,
        ];
        return lines.join('\n');
    }
}

export default ActionFilter;
