/**
 * Public surface of the locator-lint module.
 *
 * @module locator-lint
 */

export { CSLocatorLinter } from './CSLocatorLinter';
export type { LintOptions } from './CSLocatorLinter';
export { scoreLocator } from './CSLocatorScorer';
export type { ScoreResult } from './CSLocatorScorer';
export { parseFile } from './CSLocatorParser';
export type { RawLocatorCall, ParseResult } from './CSLocatorParser';
export type {
    LocatorStrategy,
    LocatorSeverity,
    LocatorFinding,
    LocatorLintReport,
    DecoratorBlock,
} from './CSLocatorTypes';
