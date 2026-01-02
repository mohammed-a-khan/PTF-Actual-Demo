/**
 * CS Playwright Test Framework - Spec Format Module
 * Exports describe/it test format APIs
 */

// Core functions for test writing
export {
    describe,
    test,
    it,
    beforeAll,
    afterAll,
    beforeEach,
    afterEach,
    CSSpecDescribe,
    getCurrentTestState,
    setCurrentTestState,
    getCurrentTestInfo,
    setCurrentTestInfo
} from './CSSpecDescribe';

// Types
export {
    SpecDataSource,
    SpecTestOptions,
    SpecDescribeOptions,
    SpecDataRow,
    SpecIterationInfo,
    SpecTestResult,
    SpecDescribeResult,
    SpecSuiteResult,
    SpecFixtures,
    SpecRunnerOptions,
    ParsedADOTags,
    // New types for Playwright-aligned features
    DescribeMode,
    DescribeConfigureOptions,
    SpecTestStatus,
    SpecTestInfo,
    SpecAttachment,
    SpecSerialBatch,
    SpecRuntimeTestState
} from './CSSpecTypes';

// Test Info
export { createTestInfo, createRuntimeState } from './CSSpecTestInfo';

// Runner
export { CSSpecRunner } from './CSSpecRunner';

// Supporting classes
export { CSSpecADOResolver } from './CSSpecADOResolver';
export { CSSpecDataIterator } from './CSSpecDataIterator';
export { CSSpecPageInjector } from './CSSpecPageInjector';
