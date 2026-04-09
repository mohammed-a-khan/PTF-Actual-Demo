/**
 * CS Playwright Test Framework - Accessibility Testing Types
 *
 * Type definitions for aria snapshot testing and accessibility validation.
 */

export interface AriaSnapshotOptions {
    name?: string;
    selector?: string;  // scope to specific element
    ignoreRoles?: string[];  // roles to exclude
    maxDepth?: number;  // tree depth limit
    timeout?: number;
}

export interface AccessibilityViolation {
    id: string;
    impact: 'critical' | 'serious' | 'moderate' | 'minor';
    description: string;
    element?: string;  // selector or aria description
    help: string;
    helpUrl?: string;
}

export interface AccessibilityReport {
    url: string;
    timestamp: Date;
    violations: AccessibilityViolation[];
    passes: number;
    incomplete: number;
    summary: string;
}

export interface AriaSnapshotComparison {
    passed: boolean;
    baselineSnapshot: string;
    actualSnapshot: string;
    differences?: string[];
    message: string;
}
