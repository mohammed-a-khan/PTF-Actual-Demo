/**
 * CodeQualityAnalyzer - Code Quality Scoring and Improvement Suggestions
 *
 * Analyzes generated code quality, identifies issues, and suggests improvements.
 */

import { Action, GeneratedCSCode } from '../types';

export interface QualityReport {
    overallScore: number;          // 0-100
    categories: CategoryScore[];
    issues: QualityIssue[];
    improvements: Improvement[];
    summary: string;
}

export interface CategoryScore {
    category: QualityCategory;
    score: number;
    maxScore: number;
    details: string;
}

export interface QualityIssue {
    severity: 'critical' | 'warning' | 'info';
    category: QualityCategory;
    message: string;
    location?: string;
    autoFixable: boolean;
    fix?: string;
}

export interface Improvement {
    category: QualityCategory;
    suggestion: string;
    impact: 'high' | 'medium' | 'low';
    effort: 'easy' | 'medium' | 'hard';
}

export type QualityCategory =
    | 'locator-stability'
    | 'code-structure'
    | 'naming-conventions'
    | 'framework-compliance'
    | 'maintainability'
    | 'reusability'
    | 'error-handling'
    | 'documentation';

export class CodeQualityAnalyzer {
    // Scoring weights for each category
    private static readonly CATEGORY_WEIGHTS: Record<QualityCategory, number> = {
        'locator-stability': 25,
        'framework-compliance': 20,
        'naming-conventions': 15,
        'code-structure': 15,
        'maintainability': 10,
        'reusability': 10,
        'error-handling': 5,
        'documentation': 0, // Optional
    };

    /**
     * Analyze generated code quality
     */
    public static analyze(code: GeneratedCSCode, actions: Action[]): QualityReport {
        const issues: QualityIssue[] = [];
        const improvements: Improvement[] = [];
        const categoryScores: CategoryScore[] = [];

        // Analyze each category
        categoryScores.push(this.analyzeLocatorStability(code, actions, issues, improvements));
        categoryScores.push(this.analyzeFrameworkCompliance(code, issues, improvements));
        categoryScores.push(this.analyzeNamingConventions(code, issues, improvements));
        categoryScores.push(this.analyzeCodeStructure(code, issues, improvements));
        categoryScores.push(this.analyzeMaintainability(code, actions, issues, improvements));
        categoryScores.push(this.analyzeReusability(code, issues, improvements));
        categoryScores.push(this.analyzeErrorHandling(code, issues, improvements));

        // Calculate overall score
        const overallScore = this.calculateOverallScore(categoryScores);

        // Generate summary
        const summary = this.generateSummary(overallScore, issues, improvements);

        return {
            overallScore,
            categories: categoryScores,
            issues,
            improvements,
            summary,
        };
    }

    /**
     * Analyze locator stability
     */
    private static analyzeLocatorStability(
        code: GeneratedCSCode,
        actions: Action[],
        issues: QualityIssue[],
        improvements: Improvement[]
    ): CategoryScore {
        let score = 100;
        let details: string[] = [];

        for (const pageObj of code.pageObjects) {
            const content = pageObj.content;

            // Check for fragile locators
            const indexMatches = content.match(/\[\d+\]/g) || [];
            if (indexMatches.length > 0) {
                score -= indexMatches.length * 10;
                issues.push({
                    severity: 'warning',
                    category: 'locator-stability',
                    message: `Found ${indexMatches.length} index-based locators which are fragile`,
                    location: pageObj.fileName,
                    autoFixable: false,
                });
            }

            // Check for nth-child
            const nthMatches = content.match(/:nth-child|:nth-of-type/g) || [];
            if (nthMatches.length > 0) {
                score -= nthMatches.length * 8;
                issues.push({
                    severity: 'warning',
                    category: 'locator-stability',
                    message: `Found ${nthMatches.length} nth-child selectors which may break with layout changes`,
                    location: pageObj.fileName,
                    autoFixable: false,
                });
            }

            // Check for alternative locators
            const altLocatorMatches = content.match(/alternativeLocators/g) || [];
            if (altLocatorMatches.length === 0) {
                score -= 15;
                issues.push({
                    severity: 'info',
                    category: 'locator-stability',
                    message: 'No alternative locators defined for self-healing',
                    location: pageObj.fileName,
                    autoFixable: true,
                    fix: 'Add alternativeLocators array to @CSGetElement decorators',
                });
            }

            // Check for selfHeal enabled
            const selfHealMatches = content.match(/selfHeal:\s*true/g) || [];
            const elementCount = (content.match(/@CSGetElement/g) || []).length;
            if (selfHealMatches.length < elementCount) {
                score -= 10;
                improvements.push({
                    category: 'locator-stability',
                    suggestion: 'Enable selfHeal: true for all elements',
                    impact: 'high',
                    effort: 'easy',
                });
            }
        }

        score = Math.max(0, score);
        return {
            category: 'locator-stability',
            score,
            maxScore: 100,
            details: `Locator stability: ${score}%`,
        };
    }

    /**
     * Analyze framework compliance
     */
    private static analyzeFrameworkCompliance(
        code: GeneratedCSCode,
        issues: QualityIssue[],
        improvements: Improvement[]
    ): CategoryScore {
        let score = 100;

        for (const pageObj of code.pageObjects) {
            const content = pageObj.content;

            // Check for direct Playwright usage
            const playwrightPatterns = [
                { pattern: /page\.goto\(/g, message: 'Direct page.goto() - use this.navigate()' },
                { pattern: /page\.click\(/g, message: 'Direct page.click() - use element.click()' },
                { pattern: /page\.fill\(/g, message: 'Direct page.fill() - use element.fillWithTimeout()' },
                { pattern: /page\.locator\(/g, message: 'Direct page.locator() - use CSGetElement decorator' },
                { pattern: /page\.waitForTimeout\(/g, message: 'Direct page.waitForTimeout() - use this.wait()' },
                { pattern: /page\.keyboard\./g, message: 'Direct page.keyboard - use this.pressKey() methods' },
            ];

            for (const { pattern, message } of playwrightPatterns) {
                const matches = content.match(pattern) || [];
                if (matches.length > 0) {
                    score -= matches.length * 5;
                    issues.push({
                        severity: 'warning',
                        category: 'framework-compliance',
                        message: `${message} (${matches.length} occurrences)`,
                        location: pageObj.fileName,
                        autoFixable: true,
                    });
                }
            }

            // Check for proper imports
            if (!content.includes('@mdakhan.mak/cs-playwright-test-framework')) {
                score -= 10;
                issues.push({
                    severity: 'warning',
                    category: 'framework-compliance',
                    message: 'Missing framework import',
                    location: pageObj.fileName,
                    autoFixable: true,
                });
            }

            // Check for CSReporter usage
            if (!content.includes('CSReporter.')) {
                score -= 5;
                improvements.push({
                    category: 'framework-compliance',
                    suggestion: 'Add CSReporter logging for better test reporting',
                    impact: 'medium',
                    effort: 'easy',
                });
            }

            // Check for proper class extension
            if (!content.includes('extends CSBasePage')) {
                score -= 15;
                issues.push({
                    severity: 'critical',
                    category: 'framework-compliance',
                    message: 'Page class does not extend CSBasePage',
                    location: pageObj.fileName,
                    autoFixable: true,
                });
            }
        }

        score = Math.max(0, score);
        return {
            category: 'framework-compliance',
            score,
            maxScore: 100,
            details: `Framework compliance: ${score}%`,
        };
    }

    /**
     * Analyze naming conventions
     */
    private static analyzeNamingConventions(
        code: GeneratedCSCode,
        issues: QualityIssue[],
        improvements: Improvement[]
    ): CategoryScore {
        let score = 100;

        for (const pageObj of code.pageObjects) {
            const content = pageObj.content;

            // Check for spaces in identifiers
            const spaceInName = content.match(/public\s+\w+\s+\w+/g) || [];
            // This is a rough check - would need better parsing

            // Check for proper camelCase elements
            const elementMatches = content.matchAll(/public\s+(\w+)!?:\s*CSWebElement/g);
            for (const match of elementMatches) {
                const name = match[1];
                if (name.charAt(0) === name.charAt(0).toUpperCase()) {
                    score -= 2;
                    issues.push({
                        severity: 'info',
                        category: 'naming-conventions',
                        message: `Element "${name}" should use camelCase`,
                        location: pageObj.fileName,
                        autoFixable: true,
                    });
                }
            }

            // Check for descriptive element names
            const genericNames = content.match(/element\d+|field\d+|button\d+/g) || [];
            if (genericNames.length > 0) {
                score -= genericNames.length * 3;
                issues.push({
                    severity: 'info',
                    category: 'naming-conventions',
                    message: `Found ${genericNames.length} generic element names - use descriptive names`,
                    location: pageObj.fileName,
                    autoFixable: false,
                });
            }

            // Check class name follows convention
            if (!pageObj.className.endsWith('Page')) {
                score -= 5;
                issues.push({
                    severity: 'info',
                    category: 'naming-conventions',
                    message: `Class "${pageObj.className}" should end with "Page"`,
                    location: pageObj.fileName,
                    autoFixable: true,
                });
            }
        }

        score = Math.max(0, score);
        return {
            category: 'naming-conventions',
            score,
            maxScore: 100,
            details: `Naming conventions: ${score}%`,
        };
    }

    /**
     * Analyze code structure
     */
    private static analyzeCodeStructure(
        code: GeneratedCSCode,
        issues: QualityIssue[],
        improvements: Improvement[]
    ): CategoryScore {
        let score = 100;

        // Check page count vs action complexity
        const stepsCount = code.metadata.intelligence?.steps ?? 0;
        if (code.pageObjects.length === 1 && stepsCount > 10) {
            score -= 15;
            issues.push({
                severity: 'warning',
                category: 'code-structure',
                message: 'All actions in single page - consider splitting into multiple pages',
                autoFixable: false,
            });
        }

        // Check for duplicate step patterns
        for (const stepDef of code.stepDefinitions) {
            const content = stepDef.content;
            const patterns = content.match(/@CSBDDStepDef\(['"]([^'"]+)['"]\)/g) || [];
            const uniquePatterns = new Set(patterns);

            if (patterns.length !== uniquePatterns.size) {
                score -= 20;
                issues.push({
                    severity: 'critical',
                    category: 'code-structure',
                    message: 'Duplicate step definition patterns found - will cause runtime errors',
                    location: stepDef.fileName,
                    autoFixable: true,
                });
            }
        }

        // Check method count per page
        for (const pageObj of code.pageObjects) {
            const methodCount = (pageObj.content.match(/public async \w+/g) || []).length;
            if (methodCount > 20) {
                score -= 10;
                improvements.push({
                    category: 'code-structure',
                    suggestion: `${pageObj.className} has ${methodCount} methods - consider splitting`,
                    impact: 'medium',
                    effort: 'medium',
                });
            }
        }

        score = Math.max(0, score);
        return {
            category: 'code-structure',
            score,
            maxScore: 100,
            details: `Code structure: ${score}%`,
        };
    }

    /**
     * Analyze maintainability
     */
    private static analyzeMaintainability(
        code: GeneratedCSCode,
        actions: Action[],
        issues: QualityIssue[],
        improvements: Improvement[]
    ): CategoryScore {
        let score = 100;

        // Check for hardcoded values
        for (const pageObj of code.pageObjects) {
            const content = pageObj.content;

            // Check for hardcoded URLs
            const urlMatches = content.match(/https?:\/\/[^\s'"]+/g) || [];
            if (urlMatches.length > 0) {
                score -= urlMatches.length * 5;
                issues.push({
                    severity: 'warning',
                    category: 'maintainability',
                    message: `Found ${urlMatches.length} hardcoded URLs - use config`,
                    location: pageObj.fileName,
                    autoFixable: true,
                    fix: 'Replace with this.config.get("BASE_URL")',
                });
            }

            // Check for hardcoded timeouts
            const timeoutMatches = content.match(/\d{4,5}/g) || [];
            // This is rough - would need better context

            // Check for magic numbers
            improvements.push({
                category: 'maintainability',
                suggestion: 'Replace hardcoded timeouts with config values',
                impact: 'medium',
                effort: 'easy',
            });
        }

        // Check for long method implementations
        for (const pageObj of code.pageObjects) {
            const methods = pageObj.content.match(/public async \w+[^}]+\}/g) || [];
            for (const method of methods) {
                const lineCount = method.split('\n').length;
                if (lineCount > 30) {
                    score -= 5;
                    improvements.push({
                        category: 'maintainability',
                        suggestion: 'Break down long methods into smaller, focused methods',
                        impact: 'medium',
                        effort: 'medium',
                    });
                    break;
                }
            }
        }

        score = Math.max(0, score);
        return {
            category: 'maintainability',
            score,
            maxScore: 100,
            details: `Maintainability: ${score}%`,
        };
    }

    /**
     * Analyze reusability
     */
    private static analyzeReusability(
        code: GeneratedCSCode,
        issues: QualityIssue[],
        improvements: Improvement[]
    ): CategoryScore {
        let score = 100;

        // Check for parameterized steps
        for (const stepDef of code.stepDefinitions) {
            const content = stepDef.content;
            const parameterizedSteps = (content.match(/\{string\}|\{int\}|\{float\}/g) || []).length;
            const totalSteps = (content.match(/@CSBDDStepDef/g) || []).length;

            if (totalSteps > 0 && parameterizedSteps / totalSteps < 0.3) {
                score -= 10;
                improvements.push({
                    category: 'reusability',
                    suggestion: 'Add more parameterized steps for better reusability',
                    impact: 'high',
                    effort: 'easy',
                });
            }
        }

        // Check for common patterns that could be reused
        for (const pageObj of code.pageObjects) {
            const content = pageObj.content;

            // Check for similar method implementations
            const fillMethods = (content.match(/fillWithTimeout/g) || []).length;
            if (fillMethods > 5) {
                improvements.push({
                    category: 'reusability',
                    suggestion: 'Consider a generic fill method with element parameter',
                    impact: 'medium',
                    effort: 'medium',
                });
            }
        }

        score = Math.max(0, score);
        return {
            category: 'reusability',
            score,
            maxScore: 100,
            details: `Reusability: ${score}%`,
        };
    }

    /**
     * Analyze error handling
     */
    private static analyzeErrorHandling(
        code: GeneratedCSCode,
        issues: QualityIssue[],
        improvements: Improvement[]
    ): CategoryScore {
        let score = 100;

        for (const pageObj of code.pageObjects) {
            const content = pageObj.content;

            // Check for try-catch blocks
            const tryCatchCount = (content.match(/try\s*\{/g) || []).length;
            const methodCount = (content.match(/public async/g) || []).length;

            // Some methods should have error handling
            if (methodCount > 5 && tryCatchCount === 0) {
                score -= 10;
                improvements.push({
                    category: 'error-handling',
                    suggestion: 'Add error handling for critical operations',
                    impact: 'medium',
                    effort: 'medium',
                });
            }

            // Check for proper assertions with error messages
            const throwMatches = (content.match(/throw new Error/g) || []).length;
            if (throwMatches > 0) {
                // Good - has error throwing
                score += 5;
            }
        }

        score = Math.min(100, Math.max(0, score));
        return {
            category: 'error-handling',
            score,
            maxScore: 100,
            details: `Error handling: ${score}%`,
        };
    }

    /**
     * Calculate overall score
     */
    private static calculateOverallScore(categories: CategoryScore[]): number {
        let totalWeight = 0;
        let weightedSum = 0;

        for (const category of categories) {
            const weight = this.CATEGORY_WEIGHTS[category.category];
            totalWeight += weight;
            weightedSum += (category.score / category.maxScore) * weight;
        }

        return Math.round((weightedSum / totalWeight) * 100);
    }

    /**
     * Generate summary
     */
    private static generateSummary(score: number, issues: QualityIssue[], improvements: Improvement[]): string {
        const criticalCount = issues.filter(i => i.severity === 'critical').length;
        const warningCount = issues.filter(i => i.severity === 'warning').length;

        let grade: string;
        if (score >= 90) grade = 'A - Excellent';
        else if (score >= 80) grade = 'B - Good';
        else if (score >= 70) grade = 'C - Acceptable';
        else if (score >= 60) grade = 'D - Needs Improvement';
        else grade = 'F - Poor';

        return [
            `📊 Code Quality Score: ${score}/100 (${grade})`,
            `   Critical Issues: ${criticalCount}`,
            `   Warnings: ${warningCount}`,
            `   Improvement Suggestions: ${improvements.length}`,
        ].join('\n');
    }
}

export default CodeQualityAnalyzer;
