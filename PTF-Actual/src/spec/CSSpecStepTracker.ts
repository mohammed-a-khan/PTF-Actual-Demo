/**
 * CS Playwright Test Framework - Spec Step Tracker
 * Tracks steps and actions during spec test execution
 */

import { SpecStepResult, SpecActionLog, SpecStepTracker } from './CSSpecTypes';
import { CSReporter } from '../reporter/CSReporter';

/**
 * Implementation of step tracker for spec tests
 * Automatically hooks into page object actions to track steps
 * Supports nested steps for hierarchical display
 */
export class CSSpecStepTrackerImpl implements SpecStepTracker {
    private steps: SpecStepResult[] = [];
    private currentStep: SpecStepResult | null = null;
    private currentActions: SpecActionLog[] = [];
    private stepStartTime: Date | null = null;
    private actionStartTime: Date | null = null;
    /** Stack for nested steps - enables parent-child relationships */
    private stepStack: SpecStepResult[] = [];
    /** Track if this is a hook step tracker */
    private hookType?: 'beforeAll' | 'afterAll' | 'beforeEach' | 'afterEach';
    /** Track if test has ended (via failStep) - prevents new implicit steps */
    private testEnded: boolean = false;

    /**
     * Set the hook type for this tracker (for hook step tracking)
     */
    setHookType(type: 'beforeAll' | 'afterAll' | 'beforeEach' | 'afterEach'): void {
        this.hookType = type;
    }

    /**
     * Start a new step (supports nesting)
     * If called while another step is active, creates a nested child step
     */
    async step(name: string): Promise<void> {
        const now = new Date();
        const newStep: SpecStepResult = {
            name,
            status: 'passed',
            duration: 0,
            startTime: now,
            endTime: now,
            actions: [],
            logs: [],
            children: [],
            depth: this.stepStack.length,
            isHook: !!this.hookType,
            hookType: this.hookType
        };

        if (this.currentStep) {
            // Nested step - push current to stack, set new as child
            // First, save current actions to parent step
            this.currentStep.actions = [...this.currentActions];
            this.currentActions = [];

            // Push parent to stack
            this.stepStack.push(this.currentStep);

            // Initialize children array if needed
            if (!this.currentStep.children) {
                this.currentStep.children = [];
            }

            // Add new step as child of current
            this.currentStep.children.push(newStep);
            this.currentStep = newStep;
            CSReporter.debug(`[StepTracker] Started nested step (depth ${newStep.depth}): ${name}`);
        } else {
            // Root level step
            this.currentStep = newStep;
            this.currentActions = [];
            CSReporter.debug(`[StepTracker] Started step: ${name}`);
        }

        this.stepStartTime = now;
    }

    /**
     * End current step with success
     * Handles nested steps by popping from stack
     */
    endStep(): void {
        if (this.currentStep) {
            const endTime = new Date();
            this.currentStep.endTime = endTime;
            this.currentStep.duration = endTime.getTime() - this.currentStep.startTime.getTime();
            this.currentStep.actions = [...this.currentActions];

            const stepName = this.currentStep.name;
            const stepDepth = this.currentStep.depth || 0;

            // If this was a nested step, pop parent from stack
            if (this.stepStack.length > 0) {
                // Current step is already added as child of parent
                this.currentStep = this.stepStack.pop() || null;
                // Restore parent's actions (they were saved when we went nested)
                this.currentActions = this.currentStep?.actions ? [...this.currentStep.actions] : [];
                CSReporter.debug(`[StepTracker] Ended nested step (depth ${stepDepth}): ${stepName}`);
            } else {
                // Root level step - add to steps array
                this.steps.push(this.currentStep);
                this.currentStep = null;
                this.currentActions = [];
                CSReporter.debug(`[StepTracker] Ended step: ${stepName}`);
            }
        }
    }

    /**
     * End current step with failure
     * Handles nested steps by popping from stack
     */
    failStep(error: string): void {
        if (this.currentStep) {
            const endTime = new Date();
            this.currentStep.endTime = endTime;
            this.currentStep.duration = endTime.getTime() - this.currentStep.startTime.getTime();
            this.currentStep.status = 'failed';
            this.currentStep.error = error;
            this.currentStep.actions = [...this.currentActions];

            const stepName = this.currentStep.name;
            const stepDepth = this.currentStep.depth || 0;

            // If this was a nested step, pop parent from stack
            if (this.stepStack.length > 0) {
                // Current step is already added as child of parent
                // Mark parent as failed too since child failed
                this.currentStep = this.stepStack.pop() || null;
                if (this.currentStep) {
                    this.currentStep.status = 'failed';
                    this.currentStep.error = `Child step failed: ${error}`;
                }
                this.currentActions = this.currentStep?.actions ? [...this.currentStep.actions] : [];
                CSReporter.debug(`[StepTracker] Failed nested step (depth ${stepDepth}): ${stepName} - ${error}`);
            } else {
                // Root level step - add to steps array
                this.steps.push(this.currentStep);
                this.currentStep = null;
                this.currentActions = [];
                this.testEnded = true; // Prevent new implicit steps after failure
                CSReporter.debug(`[StepTracker] Failed step: ${stepName} - ${error}`);
            }
        }
    }

    /**
     * Get current nesting depth
     */
    getCurrentDepth(): number {
        return this.stepStack.length + (this.currentStep ? 1 : 0);
    }

    /**
     * Log an action within current step
     */
    action(name: string, element?: string): void {
        const now = new Date();
        const duration = this.actionStartTime ? now.getTime() - this.actionStartTime.getTime() : 0;

        const action: SpecActionLog = {
            name,
            status: 'passed',
            duration,
            timestamp: now,
            element
        };

        this.currentActions.push(action);
        this.actionStartTime = now;

        // If no current step, create an implicit one (unless test has already ended)
        if (!this.currentStep) {
            if (this.testEnded && this.steps.length > 0) {
                // Test ended - add action to the last step instead of creating new one
                const lastStep = this.steps[this.steps.length - 1];
                if (lastStep.actions) {
                    lastStep.actions.push(action);
                }
                // Remove from currentActions since we added directly to step
                this.currentActions.pop();
            } else if (!this.testEnded) {
                this.currentStep = {
                    name: 'Test Actions',
                    status: 'passed',
                    duration: 0,
                    startTime: now,
                    endTime: now,
                    actions: [],
                    logs: []
                };
                this.stepStartTime = now;
            }
        }
    }

    /**
     * Mark last action as failed
     */
    failAction(error: string): void {
        if (this.currentActions.length > 0) {
            const lastAction = this.currentActions[this.currentActions.length - 1];
            lastAction.status = 'failed';
        }
    }

    /**
     * Add a reporter statement (pass/fail/info) as an action
     * This captures CSReporter.pass(), CSReporter.fail(), etc.
     */
    reporterAction(message: string, status: 'passed' | 'failed' = 'passed'): void {
        const now = new Date();

        const action: SpecActionLog = {
            name: message,
            status,
            duration: 0,
            timestamp: now
        };

        this.currentActions.push(action);

        // If no current step, create an implicit one (unless test has already ended)
        if (!this.currentStep) {
            if (this.testEnded && this.steps.length > 0) {
                // Test ended - add action to the last step instead of creating new one
                const lastStep = this.steps[this.steps.length - 1];
                if (lastStep.actions) {
                    lastStep.actions.push(action);
                }
                // Remove from currentActions since we added directly to step
                this.currentActions.pop();
            } else if (!this.testEnded) {
                this.currentStep = {
                    name: 'Test Actions',
                    status: 'passed',
                    duration: 0,
                    startTime: now,
                    endTime: now,
                    actions: [],
                    logs: []
                };
                this.stepStartTime = now;
            }
        }
    }

    /**
     * Add screenshot to current step
     */
    screenshot(path: string): void {
        if (this.currentStep) {
            this.currentStep.screenshot = path;
        } else if (this.currentActions.length > 0) {
            const lastAction = this.currentActions[this.currentActions.length - 1];
            lastAction.screenshot = path;
        }
    }

    /**
     * Add log entry to current step
     */
    log(message: string): void {
        if (this.currentStep && this.currentStep.logs) {
            this.currentStep.logs.push(message);
        }
    }

    /**
     * Mark the last completed step as skipped
     * Used by test.step.skip() to properly track skipped steps
     */
    markLastStepSkipped(): void {
        if (this.steps.length > 0) {
            this.steps[this.steps.length - 1].status = 'skipped';
        }
    }

    /**
     * Get all tracked steps
     */
    getSteps(): SpecStepResult[] {
        // Include current step if exists
        if (this.currentStep) {
            const endTime = new Date();
            return [
                ...this.steps,
                {
                    ...this.currentStep,
                    endTime,
                    duration: endTime.getTime() - this.currentStep.startTime.getTime(),
                    actions: [...this.currentActions]
                }
            ];
        }
        return [...this.steps];
    }

    /**
     * Clear all steps
     */
    clear(): void {
        this.steps = [];
        this.currentStep = null;
        this.currentActions = [];
        this.stepStartTime = null;
        this.actionStartTime = null;
        this.stepStack = [];
        this.hookType = undefined;
        this.testEnded = false;
    }

    /**
     * Finalize tracking - ensure all steps are closed
     */
    finalize(): SpecStepResult[] {
        if (this.currentStep) {
            this.endStep();
        }
        return this.getSteps();
    }

    /**
     * Get current step count
     */
    get stepCount(): number {
        return this.steps.length + (this.currentStep ? 1 : 0);
    }

    /**
     * Get current action count
     */
    get actionCount(): number {
        let count = this.currentActions.length;
        for (const step of this.steps) {
            count += step.actions?.length || 0;
        }
        return count;
    }

    /**
     * Get current step name (for debugging)
     */
    getCurrentStepName(): string | null {
        return this.currentStep?.name || null;
    }
}

/**
 * Global step tracker instance for current test
 * Reset per test execution
 */
let currentStepTracker: CSSpecStepTrackerImpl | null = null;

/**
 * Flags to prevent double-hooking
 */
let elementActionsHooked = false;
let reporterActionsHooked = false;

/**
 * Get current step tracker instance
 */
export function getCurrentStepTracker(): CSSpecStepTrackerImpl {
    if (!currentStepTracker) {
        currentStepTracker = new CSSpecStepTrackerImpl();
    }
    return currentStepTracker;
}

/**
 * Create new step tracker for a test
 */
export function createStepTracker(): CSSpecStepTrackerImpl {
    currentStepTracker = new CSSpecStepTrackerImpl();
    return currentStepTracker;
}

/**
 * Set the current step tracker
 * Used by test.step() and hook execution to set the active tracker
 */
export function setCurrentStepTracker(tracker: CSSpecStepTrackerImpl | null): void {
    currentStepTracker = tracker;
}

/**
 * Hook into CSWebElement to automatically track actions
 * Call this once during framework initialization
 */
export function hookElementActions(): void {
    // Prevent double-hooking
    if (elementActionsHooked) {
        CSReporter.debug('[StepTracker] Element action hooks already installed, skipping');
        return;
    }

    try {
        const CSWebElement = require('../element/CSWebElement').CSWebElement;

        // Store original methods
        const originalClick = CSWebElement.prototype.click;
        const originalFill = CSWebElement.prototype.fill;
        const originalType = CSWebElement.prototype.type;
        const originalSelectOption = CSWebElement.prototype.selectOption;
        const originalCheck = CSWebElement.prototype.check;
        const originalUncheck = CSWebElement.prototype.uncheck;

        // Wrap click
        CSWebElement.prototype.click = async function(...args: any[]) {
            const tracker = getCurrentStepTracker();
            const elementDesc = this.description || 'element';
            tracker.action(`Click on ${elementDesc}`, elementDesc);
            try {
                const result = await originalClick.apply(this, args);
                return result;
            } catch (error) {
                tracker.failAction(error instanceof Error ? error.message : String(error));
                throw error;
            }
        };

        // Wrap fill
        CSWebElement.prototype.fill = async function(value: string, ...args: any[]) {
            const tracker = getCurrentStepTracker();
            const elementDesc = this.description || 'element';
            const maskedValue = elementDesc.toLowerCase().includes('password') ? '***' : value;
            tracker.action(`Fill "${maskedValue}" in ${elementDesc}`, elementDesc);
            try {
                const result = await originalFill.apply(this, [value, ...args]);
                return result;
            } catch (error) {
                tracker.failAction(error instanceof Error ? error.message : String(error));
                throw error;
            }
        };

        // Wrap type
        CSWebElement.prototype.type = async function(value: string, ...args: any[]) {
            const tracker = getCurrentStepTracker();
            const elementDesc = this.description || 'element';
            const maskedValue = elementDesc.toLowerCase().includes('password') ? '***' : value;
            tracker.action(`Type "${maskedValue}" in ${elementDesc}`, elementDesc);
            try {
                const result = await originalType.apply(this, [value, ...args]);
                return result;
            } catch (error) {
                tracker.failAction(error instanceof Error ? error.message : String(error));
                throw error;
            }
        };

        // Wrap selectOption
        CSWebElement.prototype.selectOption = async function(value: any, ...args: any[]) {
            const tracker = getCurrentStepTracker();
            const elementDesc = this.description || 'element';
            tracker.action(`Select option in ${elementDesc}`, elementDesc);
            try {
                const result = await originalSelectOption.apply(this, [value, ...args]);
                return result;
            } catch (error) {
                tracker.failAction(error instanceof Error ? error.message : String(error));
                throw error;
            }
        };

        // Wrap check
        CSWebElement.prototype.check = async function(...args: any[]) {
            const tracker = getCurrentStepTracker();
            const elementDesc = this.description || 'element';
            tracker.action(`Check ${elementDesc}`, elementDesc);
            try {
                const result = await originalCheck.apply(this, args);
                return result;
            } catch (error) {
                tracker.failAction(error instanceof Error ? error.message : String(error));
                throw error;
            }
        };

        // Wrap uncheck
        CSWebElement.prototype.uncheck = async function(...args: any[]) {
            const tracker = getCurrentStepTracker();
            const elementDesc = this.description || 'element';
            tracker.action(`Uncheck ${elementDesc}`, elementDesc);
            try {
                const result = await originalUncheck.apply(this, args);
                return result;
            } catch (error) {
                tracker.failAction(error instanceof Error ? error.message : String(error));
                throw error;
            }
        };

        elementActionsHooked = true;
        CSReporter.debug('[StepTracker] Element action hooks installed');
    } catch (error) {
        CSReporter.debug('[StepTracker] Could not hook element actions: ' + (error instanceof Error ? error.message : String(error)));
    }
}

/**
 * Hook CSReporter to capture pass/fail/info statements in spec step tracker
 * Call this once during framework initialization
 */
export function hookReporterActions(): void {
    // Prevent double-hooking
    if (reporterActionsHooked) {
        CSReporter.debug('[StepTracker] Reporter action hooks already installed, skipping');
        return;
    }

    try {
        // Store original methods
        const originalPass = CSReporter.pass.bind(CSReporter);
        const originalFail = CSReporter.fail.bind(CSReporter);
        const originalInfo = CSReporter.info.bind(CSReporter);

        // Wrap pass to also add to step tracker
        (CSReporter as any).pass = function(message: string): void {
            originalPass(message);
            // Add to spec step tracker if available
            if (currentStepTracker) {
                // Skip framework internal "Passed" message (already tracked by step completion)
                const trimmed = message.trim();
                if (trimmed === '✓ Passed' || trimmed === 'Passed') {
                    return;
                }
                // Don't add ✓ prefix if message already starts with a checkmark
                const displayMessage = trimmed.startsWith('✓') ? trimmed : `✓ ${message}`;
                currentStepTracker.reporterAction(displayMessage, 'passed');
            }
        };

        // Wrap fail to also add to step tracker
        (CSReporter as any).fail = function(message: string): void {
            originalFail(message);
            // Add to spec step tracker if available
            if (currentStepTracker) {
                currentStepTracker.reporterAction(`✗ ${message}`, 'failed');
            }
        };

        // Wrap info to also add to step tracker
        (CSReporter as any).info = function(message: string): void {
            originalInfo(message);
            // Add all user-facing info messages to step tracker
            // Skip framework internal messages (those with special prefixes)
            const passesFilter = !message.startsWith('[') &&
                !message.startsWith('╔') &&
                !message.startsWith('╚') &&
                !message.startsWith('║') &&
                !message.startsWith('▶') &&
                !message.startsWith('Step ');

            if (currentStepTracker && passesFilter) {
                currentStepTracker.reporterAction(`ℹ ${message}`, 'passed');
                CSReporter.debug(`[StepTracker] Added info action: ${message.substring(0, 50)}... (step: ${currentStepTracker.getCurrentStepName() || 'none'})`);
            } else if (passesFilter) {
                CSReporter.debug(`[StepTracker] No step tracker for info: ${message.substring(0, 50)}...`);
            }
        };

        reporterActionsHooked = true;
        CSReporter.debug('[StepTracker] Reporter action hooks installed');
    } catch (error) {
        CSReporter.debug('[StepTracker] Could not hook reporter actions: ' + (error instanceof Error ? error.message : String(error)));
    }
}
