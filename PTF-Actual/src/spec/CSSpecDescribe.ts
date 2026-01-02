/**
 * CS Playwright Test Framework - Spec Format Describe/It Registration
 * Provides describe/it syntax with dataSource, tags, modes, and Playwright-style annotations
 */

import {
    SpecTestOptions,
    SpecDescribeOptions,
    SpecTestFunction,
    SpecHookFunction,
    RegisteredDescribe,
    RegisteredTest,
    DescribeConfigureOptions,
    SpecTestInfo,
    SpecRuntimeTestState,
    SpecAttachment,
    SpecNamedHookFunction
} from './CSSpecTypes';
import { CSReporter } from '../reporter/CSReporter';
import { getCurrentStepTracker } from './CSSpecStepTracker';

/**
 * Current test runtime state - used for runtime annotations
 */
let currentTestState: SpecRuntimeTestState | null = null;
let currentTestInfo: SpecTestInfo | null = null;

/**
 * Get current test state (for runtime annotations)
 */
export function getCurrentTestState(): SpecRuntimeTestState | null {
    return currentTestState;
}

/**
 * Set current test state (called by runner before test execution)
 */
export function setCurrentTestState(state: SpecRuntimeTestState | null): void {
    currentTestState = state;
}

/**
 * Get current test info (for test.info())
 */
export function getCurrentTestInfo(): SpecTestInfo | null {
    return currentTestInfo;
}

/**
 * Set current test info (called by runner before test execution)
 */
export function setCurrentTestInfo(info: SpecTestInfo | null): void {
    currentTestInfo = info;
}

/**
 * Registry for describe blocks and tests
 */
export class CSSpecDescribe {
    private static instance: CSSpecDescribe;
    private rootDescribes: RegisteredDescribe[] = [];
    private currentDescribe: RegisteredDescribe | null = null;
    private describeStack: RegisteredDescribe[] = [];

    private constructor() {}

    public static getInstance(): CSSpecDescribe {
        if (!CSSpecDescribe.instance) {
            CSSpecDescribe.instance = new CSSpecDescribe();
        }
        return CSSpecDescribe.instance;
    }

    /**
     * Clear all registrations
     */
    public clear(): void {
        this.rootDescribes = [];
        this.currentDescribe = null;
        this.describeStack = [];
    }

    /**
     * Get all registered describe blocks
     */
    public getRegisteredDescribes(): RegisteredDescribe[] {
        return this.rootDescribes;
    }

    /**
     * Get current describe block (for configure)
     */
    public getCurrentDescribe(): RegisteredDescribe | null {
        return this.currentDescribe;
    }

    /**
     * Register a describe block
     */
    public registerDescribe(
        name: string,
        options: SpecDescribeOptions | undefined,
        fn: () => void
    ): void {
        const describe: RegisteredDescribe = {
            name,
            options: options || {},
            tests: [],
            describes: [],
            beforeAll: [],
            afterAll: [],
            beforeEach: [],
            afterEach: [],
            parent: this.currentDescribe || undefined
        };

        // Add to parent or root
        if (this.currentDescribe) {
            this.currentDescribe.describes.push(describe);
        } else {
            this.rootDescribes.push(describe);
        }

        // Push current describe onto stack
        this.describeStack.push(describe);
        this.currentDescribe = describe;

        // Execute the describe function to register tests
        try {
            fn();
        } finally {
            // Pop describe from stack
            this.describeStack.pop();
            this.currentDescribe = this.describeStack[this.describeStack.length - 1] || null;
        }
    }

    /**
     * Configure current describe block
     */
    public configureCurrentDescribe(options: DescribeConfigureOptions): void {
        if (!this.currentDescribe) {
            throw new Error('describe.configure() must be called inside a describe block');
        }

        // Merge configuration into current describe options
        if (options.mode !== undefined) {
            this.currentDescribe.options.mode = options.mode;
        }
        if (options.timeout !== undefined) {
            this.currentDescribe.options.timeout = options.timeout;
        }
        if (options.retries !== undefined) {
            this.currentDescribe.options.retries = options.retries;
        }
    }

    /**
     * Register a test
     */
    public registerTest(
        name: string,
        options: SpecTestOptions | undefined,
        fn: SpecTestFunction
    ): void {
        if (!this.currentDescribe) {
            throw new Error(`test("${name}") must be inside a describe block`);
        }

        const test: RegisteredTest = {
            name,
            fn,
            options: options || {},
            describePath: this.describeStack.map(d => d.name)
        };

        this.currentDescribe.tests.push(test);
    }

    /**
     * Register beforeAll hook
     */
    public registerBeforeAll(fn: SpecHookFunction): void {
        if (!this.currentDescribe) {
            throw new Error('beforeAll must be inside a describe block');
        }
        this.currentDescribe.beforeAll.push(fn);
    }

    /**
     * Register afterAll hook
     */
    public registerAfterAll(fn: SpecHookFunction): void {
        if (!this.currentDescribe) {
            throw new Error('afterAll must be inside a describe block');
        }
        this.currentDescribe.afterAll.push(fn);
    }

    /**
     * Register beforeEach hook
     */
    public registerBeforeEach(fn: SpecHookFunction): void {
        if (!this.currentDescribe) {
            throw new Error('beforeEach must be inside a describe block');
        }
        this.currentDescribe.beforeEach.push(fn);
    }

    /**
     * Register afterEach hook
     */
    public registerAfterEach(fn: SpecHookFunction): void {
        if (!this.currentDescribe) {
            throw new Error('afterEach must be inside a describe block');
        }
        this.currentDescribe.afterEach.push(fn);
    }
}

// Get singleton instance
const registry = CSSpecDescribe.getInstance();

// ============================================================================
// DESCRIBE FUNCTIONS
// ============================================================================

/**
 * describe() function with options support
 *
 * @example
 * // Basic describe
 * describe('Login Tests', () => {
 *   test('should login', async ({ loginPage }) => {
 *     // test code
 *   });
 * });
 *
 * @example
 * // Describe with options
 * describe('Login Tests', {
 *   tags: ['@smoke', '@login'],
 *   dataSource: { source: 'users.xlsx', sheet: 'ValidUsers' }
 * }, () => {
 *   test('should login', async ({ loginPage, data }) => {
 *     // test code using data.username, data.password
 *   });
 * });
 */
export function describe(
    name: string,
    optionsOrFn: SpecDescribeOptions | (() => void),
    fn?: () => void
): void {
    let options: SpecDescribeOptions | undefined;
    let describeFn: () => void;

    if (typeof optionsOrFn === 'function') {
        // describe(name, fn)
        options = undefined;
        describeFn = optionsOrFn;
    } else {
        // describe(name, options, fn)
        options = optionsOrFn;
        describeFn = fn!;
    }

    registry.registerDescribe(name, options, describeFn);
}

/**
 * describe.configure() - Configure execution mode for current describe block
 * Must be called at the top of the describe block.
 *
 * @example
 * describe('Serial Tests', () => {
 *     describe.configure({ mode: 'serial' });
 *     test('first', async () => { });
 *     test('second', async () => { }); // Skipped if first fails
 * });
 *
 * @example
 * describe('Custom Timeout', () => {
 *     describe.configure({ mode: 'default', timeout: 60000, retries: 2 });
 *     test('test', async () => { });
 * });
 */
describe.configure = function(options: DescribeConfigureOptions): void {
    registry.configureCurrentDescribe(options);
};

/**
 * describe.skip() - Skip all tests in describe
 */
describe.skip = function(
    name: string,
    optionsOrFn: SpecDescribeOptions | (() => void),
    fn?: () => void
): void {
    let options: SpecDescribeOptions;
    let describeFn: () => void;

    if (typeof optionsOrFn === 'function') {
        options = { skip: true };
        describeFn = optionsOrFn;
    } else {
        options = { ...optionsOrFn, skip: true };
        describeFn = fn!;
    }

    registry.registerDescribe(name, options, describeFn);
};

/**
 * describe.only() - Only run tests in this describe
 */
describe.only = function(
    name: string,
    optionsOrFn: SpecDescribeOptions | (() => void),
    fn?: () => void
): void {
    let options: SpecDescribeOptions;
    let describeFn: () => void;

    if (typeof optionsOrFn === 'function') {
        options = { tags: ['@only'] };
        describeFn = optionsOrFn;
    } else {
        const existingTags = Array.isArray(optionsOrFn.tags)
            ? optionsOrFn.tags
            : optionsOrFn.tags ? [optionsOrFn.tags] : [];
        options = { ...optionsOrFn, tags: [...existingTags, '@only'] };
        describeFn = fn!;
    }

    registry.registerDescribe(name, options, describeFn);
};

/**
 * describe.serial() - Run tests in serial mode (if one fails, rest are skipped)
 *
 * @example
 * describe.serial('Login Flow', () => {
 *     test('navigate', async () => { });
 *     test('login', async () => { }); // Skipped if navigate fails
 *     test('verify', async () => { }); // Skipped if any above fails
 * });
 */
describe.serial = function(
    name: string,
    optionsOrFn: SpecDescribeOptions | (() => void),
    fn?: () => void
): void {
    let options: SpecDescribeOptions;
    let describeFn: () => void;

    if (typeof optionsOrFn === 'function') {
        options = { mode: 'serial' };
        describeFn = optionsOrFn;
    } else {
        options = { ...optionsOrFn, mode: 'serial' };
        describeFn = fn!;
    }

    registry.registerDescribe(name, options, describeFn);
};

/**
 * describe.parallel() - Run tests in parallel mode (can run on different workers)
 * This is the default behavior, but can be used explicitly.
 *
 * @example
 * describe.parallel('Independent Tests', () => {
 *     test('test A', async () => { }); // Can run on worker 1
 *     test('test B', async () => { }); // Can run on worker 2
 * });
 */
describe.parallel = function(
    name: string,
    optionsOrFn: SpecDescribeOptions | (() => void),
    fn?: () => void
): void {
    let options: SpecDescribeOptions;
    let describeFn: () => void;

    if (typeof optionsOrFn === 'function') {
        options = { mode: 'parallel' };
        describeFn = optionsOrFn;
    } else {
        options = { ...optionsOrFn, mode: 'parallel' };
        describeFn = fn!;
    }

    registry.registerDescribe(name, options, describeFn);
};

/**
 * Workflow context for tracking steps within describe.workflow
 */
let workflowContext: {
    isActive: boolean;
    previousStepTag: string | null;
    stepIndex: number;
    workflowName: string;
    cleanupSteps: Array<{ name: string; fn: SpecTestFunction; options?: SpecTestOptions }>;
} = {
    isActive: false,
    previousStepTag: null,
    stepIndex: 0,
    workflowName: '',
    cleanupSteps: []
};

/**
 * describe.workflow() - Create a workflow with dependent steps
 * Steps run in order, and if one fails, subsequent steps are skipped (except cleanup).
 * Cleanup steps always run regardless of previous failures.
 *
 * @example
 * describe.workflow('User CRUD Workflow', () => {
 *     test('Create user', async ({ ctx }) => {
 *         const userId = await createUser();
 *         ctx.set('userId', userId);
 *     });
 *
 *     test('Update user', async ({ ctx }) => {
 *         // Auto-skipped if 'Create user' failed
 *         const userId = ctx.get('userId');
 *         await updateUser(userId);
 *     });
 *
 *     test.cleanup('Delete test data', async ({ ctx }) => {
 *         // Always runs, even if previous steps failed
 *         const userId = ctx.get('userId');
 *         if (userId) await deleteUser(userId);
 *     });
 * });
 *
 * @example
 * // With options
 * describe.workflow('API Flow', {
 *     tags: ['@api', '@workflow'],
 *     timeout: 120000
 * }, () => {
 *     test('Step 1', async () => { });
 *     test('Step 2', async () => { }); // Depends on Step 1
 * });
 */
describe.workflow = function(
    name: string,
    optionsOrFn: SpecDescribeOptions | (() => void),
    fn?: () => void
): void {
    let options: SpecDescribeOptions;
    let describeFn: () => void;

    if (typeof optionsOrFn === 'function') {
        options = { mode: 'serial' };
        describeFn = optionsOrFn;
    } else {
        options = { ...optionsOrFn, mode: 'serial' };
        describeFn = fn!;
    }

    // Add workflow marker tag
    const existingTags = Array.isArray(options.tags)
        ? options.tags
        : options.tags ? [options.tags] : [];
    options.tags = [...existingTags, '@workflow'];

    // Wrap the describe function to enable workflow context
    const wrappedFn = () => {
        // Initialize workflow context
        workflowContext = {
            isActive: true,
            previousStepTag: null,
            stepIndex: 0,
            workflowName: name,
            cleanupSteps: []
        };

        try {
            // Execute the original describe function
            describeFn();

            // Register cleanup steps at the end (they run regardless of failures)
            for (const cleanup of workflowContext.cleanupSteps) {
                const cleanupOptions: SpecTestOptions = {
                    ...cleanup.options,
                    tags: [...(Array.isArray(cleanup.options?.tags) ? cleanup.options.tags : cleanup.options?.tags ? [cleanup.options.tags] : []), '@cleanup'],
                    // Cleanup steps don't have dependencies - they always run
                    // The runner will handle this specially
                };
                // Mark as cleanup step for special handling
                (cleanupOptions as any).__isCleanupStep = true;
                registry.registerTest(cleanup.name, cleanupOptions, cleanup.fn);
            }
        } finally {
            // Reset workflow context
            workflowContext = {
                isActive: false,
                previousStepTag: null,
                stepIndex: 0,
                workflowName: '',
                cleanupSteps: []
            };
        }
    };

    registry.registerDescribe(name, options, wrappedFn);
};

/**
 * Check if we're inside a workflow context
 */
export function isInWorkflow(): boolean {
    return workflowContext.isActive;
}

/**
 * Get the previous step's tag for dependency chaining
 */
export function getWorkflowPreviousStepTag(): string | null {
    return workflowContext.previousStepTag;
}

/**
 * Set the current step's tag as the previous for next step
 */
export function setWorkflowPreviousStepTag(tag: string): void {
    workflowContext.previousStepTag = tag;
}

/**
 * Get next workflow step index
 */
export function getNextWorkflowStepIndex(): number {
    return ++workflowContext.stepIndex;
}

/**
 * Register a cleanup step in the workflow
 */
export function registerWorkflowCleanup(name: string, fn: SpecTestFunction, options?: SpecTestOptions): void {
    workflowContext.cleanupSteps.push({ name, fn, options });
}

/**
 * describe.fixme() - Mark describe as needing fixes (tests won't run)
 *
 * @example
 * describe.fixme('Broken Feature', () => {
 *     test('this wont run', async () => { });
 * });
 *
 * @example
 * describe.fixme('Broken Feature', 'Waiting for API fix', () => {
 *     test('this wont run', async () => { });
 * });
 */
describe.fixme = function(
    name: string,
    optionsOrReasonOrFn: SpecDescribeOptions | string | (() => void),
    reasonOrFn?: string | (() => void),
    fn?: () => void
): void {
    let options: SpecDescribeOptions;
    let describeFn: () => void;

    if (typeof optionsOrReasonOrFn === 'function') {
        // describe.fixme('name', fn)
        options = { fixme: true };
        describeFn = optionsOrReasonOrFn;
    } else if (typeof optionsOrReasonOrFn === 'string') {
        // describe.fixme('name', 'reason', fn)
        options = { fixme: optionsOrReasonOrFn };
        describeFn = reasonOrFn as () => void;
    } else if (typeof reasonOrFn === 'string') {
        // describe.fixme('name', options, 'reason', fn)
        options = { ...optionsOrReasonOrFn, fixme: reasonOrFn };
        describeFn = fn!;
    } else {
        // describe.fixme('name', options, fn)
        options = { ...optionsOrReasonOrFn, fixme: true };
        describeFn = reasonOrFn as () => void;
    }

    registry.registerDescribe(name, options, describeFn);
};

// ============================================================================
// TEST FUNCTIONS
// ============================================================================

/**
 * Interface for test decorator methods (skip, fixme, fail, slow)
 * Provides proper typing for decorator-style usage with SpecTestFunction
 */
interface TestDecoratorMethod {
    // Decorator overloads (with name as first argument)
    (name: string, fn: SpecTestFunction): void;
    (name: string, reason: string, fn: SpecTestFunction): void;
    (name: string, options: SpecTestOptions, fn: SpecTestFunction): void;
    // Runtime overloads (with condition as first argument)
    (condition: boolean, reason?: string): void;
    (): void;
}

/**
 * Interface for step function
 */
interface StepFunction {
    <T>(title: string, body: () => Promise<T>): Promise<T>;
    skip: <T>(title: string, body: () => Promise<T>) => Promise<void>;
}

/**
 * Interface for test.info() return type
 */
interface TestInfoFunction {
    (): SpecTestInfo;
}

/**
 * Interface for test.setTimeout()
 */
interface SetTimeoutFunction {
    (timeout: number): void;
}

/**
 * Interface for test.cleanup()
 */
interface CleanupFunction {
    (name: string, fn: SpecTestFunction): void;
    (name: string, options: SpecTestOptions, fn: SpecTestFunction): void;
}

/**
 * Extended test function interface with all decorator methods
 */
interface TestFunction {
    (name: string, fn: SpecTestFunction): void;
    (name: string, options: SpecTestOptions, fn: SpecTestFunction): void;
    skip: TestDecoratorMethod;
    only: (name: string, optionsOrFn: SpecTestOptions | SpecTestFunction, fn?: SpecTestFunction) => void;
    fixme: TestDecoratorMethod;
    fail: TestDecoratorMethod;
    slow: TestDecoratorMethod;
    info: TestInfoFunction;
    step: StepFunction;
    setTimeout: SetTimeoutFunction;
    cleanup: CleanupFunction;
}

/**
 * test() function with options support
 *
 * @example
 * // Basic test
 * test('should login successfully', async ({ loginPage }) => {
 *   await loginPage.navigate();
 *   await loginPage.login('admin', 'admin123');
 * });
 *
 * @example
 * // Test with options
 * test('should login with data', {
 *   tags: ['@smoke', '@TestCaseId:415'],
 *   timeout: 60000
 * }, async ({ loginPage, data }) => {
 *   await loginPage.login(data.username, data.password);
 * });
 */
export function test(
    name: string,
    optionsOrFn: SpecTestOptions | SpecTestFunction,
    fn?: SpecTestFunction
): void {
    let options: SpecTestOptions | undefined;
    let testFn: SpecTestFunction;

    if (typeof optionsOrFn === 'function') {
        // test(name, fn)
        options = undefined;
        testFn = optionsOrFn;
    } else {
        // test(name, options, fn)
        options = optionsOrFn;
        testFn = fn!;
    }

    // Handle workflow context - auto-chain dependencies
    if (isInWorkflow()) {
        const stepIndex = getNextWorkflowStepIndex();
        const stepTag = `@workflow-step-${stepIndex}`;

        // Initialize options if undefined
        options = options || {};

        // Add step tag
        const existingTags = Array.isArray(options.tags)
            ? options.tags
            : options.tags ? [options.tags] : [];
        options.tags = [...existingTags, stepTag];

        // If there's a previous step and no explicit dependsOn, add dependency
        const previousStepTag = getWorkflowPreviousStepTag();
        if (previousStepTag && !options.dependsOn) {
            options.dependsOn = previousStepTag;
        }

        // Set this step as the previous for the next step
        setWorkflowPreviousStepTag(stepTag);
    }

    registry.registerTest(name, options, testFn);
}

/**
 * test.skip() - Skip this test
 * Can be used as decorator or called at runtime inside test body.
 *
 * @example
 * // As decorator
 * test.skip('incomplete test', async () => { });
 * test.skip('with reason', 'Not implemented yet', async () => { });
 *
 * @example
 * // At runtime (inside test body)
 * test('conditional skip', async () => {
 *     test.skip(browserName !== 'webkit', 'Safari-only feature');
 *     // Test code...
 * });
 */
test.skip = function(
    nameOrCondition: string | boolean,
    optionsOrReasonOrFn?: SpecTestOptions | SpecTestFunction | string,
    fn?: SpecTestFunction
): void {
    // Runtime skip (called inside test body)
    if (typeof nameOrCondition === 'boolean') {
        const condition = nameOrCondition;
        const reason = typeof optionsOrReasonOrFn === 'string' ? optionsOrReasonOrFn : undefined;

        if (currentTestState && (condition === true || arguments.length === 0)) {
            currentTestState.shouldSkip = true;
            currentTestState.skipReason = reason;
            // Throw error to immediately stop test execution (like Playwright)
            // The runner will catch this and mark test as skipped
            const skipError = new Error(`SKIP: ${reason || 'Test skipped at runtime'}`);
            (skipError as any).isSkipError = true;
            throw skipError;
        }
        return;
    }

    // Decorator usage
    const name = nameOrCondition;
    let options: SpecTestOptions;
    let testFn: SpecTestFunction;

    if (typeof optionsOrReasonOrFn === 'string') {
        // test.skip('name', 'reason', fn)
        options = { skip: optionsOrReasonOrFn };
        testFn = fn!;
    } else if (typeof optionsOrReasonOrFn === 'function') {
        // test.skip('name', fn)
        options = { skip: true };
        testFn = optionsOrReasonOrFn;
    } else {
        // test.skip('name', options, fn)
        options = { ...optionsOrReasonOrFn, skip: true };
        testFn = fn!;
    }

    registry.registerTest(name, options, testFn);
} as TestDecoratorMethod;

/**
 * test.only() - Only run this test
 */
test.only = function(
    name: string,
    optionsOrFn: SpecTestOptions | SpecTestFunction,
    fn?: SpecTestFunction
): void {
    let options: SpecTestOptions;
    let testFn: SpecTestFunction;

    if (typeof optionsOrFn === 'function') {
        options = { tags: ['@only'] };
        testFn = optionsOrFn;
    } else {
        const existingTags = Array.isArray(optionsOrFn.tags)
            ? optionsOrFn.tags
            : optionsOrFn.tags ? [optionsOrFn.tags] : [];
        options = { ...optionsOrFn, tags: [...existingTags, '@only'] };
        testFn = fn!;
    }

    registry.registerTest(name, options, testFn);
};

/**
 * test.fixme() - Mark test as needing fixes (won't run)
 * Can be used as decorator or called at runtime inside test body.
 *
 * @example
 * // As decorator
 * test.fixme('broken test', async () => { });
 * test.fixme('broken test', 'Needs investigation', async () => { });
 *
 * @example
 * // At runtime
 * test('conditional fixme', async () => {
 *     test.fixme(isMobile, 'Mobile not supported yet');
 * });
 */
test.fixme = function(
    nameOrCondition: string | boolean,
    optionsOrReasonOrFn?: SpecTestOptions | SpecTestFunction | string,
    fn?: SpecTestFunction
): void {
    // Runtime fixme
    if (typeof nameOrCondition === 'boolean' || arguments.length === 0) {
        const condition = typeof nameOrCondition === 'boolean' ? nameOrCondition : true;
        const reason = typeof optionsOrReasonOrFn === 'string' ? optionsOrReasonOrFn : undefined;

        if (currentTestState && condition) {
            currentTestState.isFixme = true;
            currentTestState.fixmeReason = reason;
        }
        return;
    }

    // Decorator usage
    const name = nameOrCondition;
    let options: SpecTestOptions;
    let testFn: SpecTestFunction;

    if (typeof optionsOrReasonOrFn === 'string') {
        options = { fixme: optionsOrReasonOrFn };
        testFn = fn!;
    } else if (typeof optionsOrReasonOrFn === 'function') {
        options = { fixme: true };
        testFn = optionsOrReasonOrFn;
    } else {
        options = { ...optionsOrReasonOrFn, fixme: true };
        testFn = fn!;
    }

    registry.registerTest(name, options, testFn);
} as TestDecoratorMethod;

/**
 * test.fail() - Mark test as expected to fail
 * If the test passes, it will be reported as an error.
 *
 * @example
 * // As decorator
 * test.fail('known bug', async () => { });
 * test.fail('known bug', 'Bug #123', async () => { });
 *
 * @example
 * // At runtime
 * test('conditional fail', async () => {
 *     test.fail(browserName === 'firefox', 'Known Firefox issue');
 * });
 */
test.fail = function(
    nameOrCondition: string | boolean,
    optionsOrReasonOrFn?: SpecTestOptions | SpecTestFunction | string,
    fn?: SpecTestFunction
): void {
    // Runtime fail
    if (typeof nameOrCondition === 'boolean' || arguments.length === 0) {
        const condition = typeof nameOrCondition === 'boolean' ? nameOrCondition : true;
        const reason = typeof optionsOrReasonOrFn === 'string' ? optionsOrReasonOrFn : undefined;

        if (currentTestState && condition) {
            currentTestState.expectedToFail = true;
            currentTestState.expectedFailReason = reason;
        }
        return;
    }

    // Decorator usage
    const name = nameOrCondition;
    let options: SpecTestOptions;
    let testFn: SpecTestFunction;

    if (typeof optionsOrReasonOrFn === 'string') {
        options = { expectedToFail: optionsOrReasonOrFn };
        testFn = fn!;
    } else if (typeof optionsOrReasonOrFn === 'function') {
        options = { expectedToFail: true };
        testFn = optionsOrReasonOrFn;
    } else {
        options = { ...optionsOrReasonOrFn, expectedToFail: true };
        testFn = fn!;
    }

    registry.registerTest(name, options, testFn);
} as TestDecoratorMethod;

/**
 * test.slow() - Mark test as slow (triples the timeout)
 *
 * @example
 * // As decorator
 * test.slow('heavy computation', async () => { });
 *
 * @example
 * // At runtime
 * test('conditional slow', async () => {
 *     test.slow(process.env.CI === 'true', 'CI is slower');
 * });
 */
test.slow = function(
    nameOrCondition: string | boolean,
    optionsOrReasonOrFn?: SpecTestOptions | SpecTestFunction | string,
    fn?: SpecTestFunction
): void {
    // Runtime slow
    if (typeof nameOrCondition === 'boolean' || arguments.length === 0) {
        const condition = typeof nameOrCondition === 'boolean' ? nameOrCondition : true;
        const reason = typeof optionsOrReasonOrFn === 'string' ? optionsOrReasonOrFn : undefined;

        if (currentTestState && condition) {
            currentTestState.isSlow = true;
            currentTestState.slowReason = reason;
        }
        return;
    }

    // Decorator usage
    const name = nameOrCondition;
    let options: SpecTestOptions;
    let testFn: SpecTestFunction;

    if (typeof optionsOrReasonOrFn === 'string') {
        options = { slow: optionsOrReasonOrFn };
        testFn = fn!;
    } else if (typeof optionsOrReasonOrFn === 'function') {
        options = { slow: true };
        testFn = optionsOrReasonOrFn;
    } else {
        options = { ...optionsOrReasonOrFn, slow: true };
        testFn = fn!;
    }

    registry.registerTest(name, options, testFn);
} as TestDecoratorMethod;

/**
 * test.setTimeout() - Set custom timeout for current test (runtime only)
 *
 * @example
 * test('custom timeout', async () => {
 *     test.setTimeout(120000); // 2 minutes
 *     // Long running test...
 * });
 */
test.setTimeout = function(timeout: number): void {
    if (currentTestState) {
        currentTestState.customTimeout = timeout;
    }
};

/**
 * test.info() - Get current test info during execution
 *
 * @example
 * test('example', async () => {
 *     const info = test.info();
 *     console.log(info.title);
 *     info.annotations.push({ type: 'issue', description: 'BUG-123' });
 *     await info.attach('screenshot', { path: 'screenshot.png' });
 * });
 */
test.info = function(): SpecTestInfo {
    if (!currentTestInfo) {
        throw new Error('test.info() can only be called during test execution');
    }
    return currentTestInfo;
};
/**
 * test.step() - Create a named step in the test report
 *
 * @example
 * test('checkout flow', async ({ page }) => {
 *     await test.step('Add to cart', async () => {
 *         await page.click('.add-btn');
 *     });
 *
 *     await test.step('Complete checkout', async () => {
 *         await test.step('Enter payment', async () => {
 *             await page.fill('#card', '4111...');
 *         });
 *     });
 * });
 */
const stepFunction: StepFunction = Object.assign(
    async function<T>(title: string, body: () => Promise<T>): Promise<T> {
        const startTime = Date.now();
        const stepTracker = getCurrentStepTracker();

        // Start step in tracker (supports nesting)
        await stepTracker.step(title);
        CSReporter.info(`[Step] ${title}`);

        try {
            const result = await body();
            const duration = Date.now() - startTime;

            // End step successfully in tracker
            stepTracker.endStep();
            CSReporter.info(`[Step] ✓ ${title} (${duration}ms)`);
            return result;
        } catch (error: any) {
            const duration = Date.now() - startTime;

            // End step with failure in tracker
            stepTracker.failStep(error?.message || String(error));
            CSReporter.error(`[Step] ✗ ${title} (${duration}ms)`);
            throw error;
        }
    },
    {
        /**
         * test.step.skip() - Create a skipped step (visible in report)
         */
        skip: async function<T>(title: string, _body: () => Promise<T>): Promise<void> {
            const stepTracker = getCurrentStepTracker();
            // Create a skipped step in tracker
            await stepTracker.step(title);
            stepTracker.endStep();
            // Mark the step as skipped using the proper method
            stepTracker.markLastStepSkipped();
            CSReporter.info(`[Step] ⊘ ${title} (skipped)`);
        }
    }
);

test.step = stepFunction;

/**
 * test.cleanup() - Register a cleanup step in a workflow
 * Cleanup steps always run, even if previous steps failed.
 * Only works inside describe.workflow().
 *
 * @example
 * describe.workflow('User CRUD', () => {
 *     test('Create user', async ({ ctx }) => {
 *         ctx.set('userId', await createUser());
 *     });
 *
 *     test('Update user', async ({ ctx }) => {
 *         await updateUser(ctx.get('userId'));
 *     });
 *
 *     test.cleanup('Delete test data', async ({ ctx }) => {
 *         // Always runs, even if Create or Update failed
 *         const userId = ctx.get('userId');
 *         if (userId) await deleteUser(userId);
 *     });
 * });
 */
test.cleanup = function(
    name: string,
    optionsOrFn: SpecTestOptions | SpecTestFunction,
    fn?: SpecTestFunction
): void {
    let options: SpecTestOptions | undefined;
    let testFn: SpecTestFunction;

    if (typeof optionsOrFn === 'function') {
        options = undefined;
        testFn = optionsOrFn;
    } else {
        options = optionsOrFn;
        testFn = fn!;
    }

    if (!isInWorkflow()) {
        // Outside workflow, just register as a normal test
        CSReporter.warn(`test.cleanup() called outside describe.workflow() - registering as normal test`);
        registry.registerTest(name, options, testFn);
        return;
    }

    // Register as cleanup step (will be added at the end of workflow)
    registerWorkflowCleanup(name, testFn, options);
};

/**
 * it() - Alias for test()
 */
export const it = test;

// ============================================================================
// HOOKS
// ============================================================================

/**
 * beforeAll() hook - runs once before all tests in describe
 *
 * @example
 * beforeAll(async ({ db }) => {
 *     await db.seed();
 * });
 *
 * @example
 * // With title
 * beforeAll('Setup database', async ({ db }) => {
 *     await db.seed();
 * });
 */
export function beforeAll(titleOrFn: string | SpecHookFunction, fn?: SpecHookFunction): void {
    const hookFn = typeof titleOrFn === 'function' ? titleOrFn : fn!;
    const title = typeof titleOrFn === 'string' ? titleOrFn : undefined;

    if (title) {
        // Wrap with title logging and attach title property
        const wrappedFn: SpecHookFunction = async (fixtures) => {
            CSReporter.info(`[beforeAll] ${title}`);
            await hookFn(fixtures);
        };
        (wrappedFn as any).title = title;
        registry.registerBeforeAll(wrappedFn);
    } else {
        registry.registerBeforeAll(hookFn);
    }
}

/**
 * afterAll() hook - runs once after all tests in describe
 */
export function afterAll(titleOrFn: string | SpecHookFunction, fn?: SpecHookFunction): void {
    const hookFn = typeof titleOrFn === 'function' ? titleOrFn : fn!;
    const title = typeof titleOrFn === 'string' ? titleOrFn : undefined;

    if (title) {
        const wrappedFn: SpecHookFunction = async (fixtures) => {
            CSReporter.info(`[afterAll] ${title}`);
            await hookFn(fixtures);
        };
        (wrappedFn as any).title = title;
        registry.registerAfterAll(wrappedFn);
    } else {
        registry.registerAfterAll(hookFn);
    }
}

/**
 * beforeEach() hook - runs before each test
 */
export function beforeEach(titleOrFn: string | SpecHookFunction, fn?: SpecHookFunction): void {
    const hookFn = typeof titleOrFn === 'function' ? titleOrFn : fn!;
    const title = typeof titleOrFn === 'string' ? titleOrFn : undefined;

    if (title) {
        const wrappedFn: SpecHookFunction = async (fixtures) => {
            CSReporter.debug(`[beforeEach] ${title}`);
            await hookFn(fixtures);
        };
        (wrappedFn as any).title = title;
        registry.registerBeforeEach(wrappedFn);
    } else {
        registry.registerBeforeEach(hookFn);
    }
}

/**
 * afterEach() hook - runs after each test
 */
export function afterEach(titleOrFn: string | SpecHookFunction, fn?: SpecHookFunction): void {
    const hookFn = typeof titleOrFn === 'function' ? titleOrFn : fn!;
    const title = typeof titleOrFn === 'string' ? titleOrFn : undefined;

    if (title) {
        const wrappedFn: SpecHookFunction = async (fixtures) => {
            CSReporter.debug(`[afterEach] ${title}`);
            await hookFn(fixtures);
        };
        (wrappedFn as any).title = title;
        registry.registerAfterEach(wrappedFn);
    } else {
        registry.registerAfterEach(hookFn);
    }
}

// Note: CSSpecDescribe class is exported at its declaration (line 58)
