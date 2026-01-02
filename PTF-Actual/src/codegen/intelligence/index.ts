/**
 * Codegen Intelligence Module
 *
 * Provides intelligent utilities for code generation:
 * - ActionFilter: Noise removal, deduplication, action merging
 * - NamingEngine: Proper naming conventions
 * - FlowDetector: Smart flow and page detection
 * - LocatorGenerator: Multi-locator with stability scoring
 * - ProjectScanner: Existing code integration
 * - TestDataExtractor: Data extraction and parameterization
 * - AssertionSuggester: Auto-assertion suggestions
 * - CodeQualityAnalyzer: Quality scoring and improvements
 */

export { ActionFilter } from './ActionFilter';
export type { FilteredActions, RemovedAction, MergedAction, FilterStats } from './ActionFilter';

export { NamingEngine } from './NamingEngine';
export type { ElementNaming, MethodNaming } from './NamingEngine';

export { FlowDetector } from './FlowDetector';
export type { DetectedFlow, PageBoundary, FlowType } from './FlowDetector';

export { LocatorGenerator } from './LocatorGenerator';
export type { GeneratedLocators, LocatorStrategy } from './LocatorGenerator';

export { ProjectScanner } from './ProjectScanner';
export type { ProjectScanResult, ExistingStep, ExistingPage } from './ProjectScanner';

export { TestDataExtractor } from './TestDataExtractor';
export type { ExtractedTestData, TestDataValue, DataVariation } from './TestDataExtractor';

export { AssertionSuggester } from './AssertionSuggester';
export type { SuggestedAssertion, VerificationPoint } from './AssertionSuggester';

export { CodeQualityAnalyzer } from './CodeQualityAnalyzer';
export type { QualityReport, QualityIssue, Improvement } from './CodeQualityAnalyzer';
