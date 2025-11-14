/**
 * Project Pattern Analyzer
 *
 * Learns from existing project code to apply consistent patterns and conventions.
 * Makes codegen context-aware and adaptive to project style.
 */

import * as fs from 'fs';
import * as path from 'path';
import { CSReporter } from '../../reporter/CSReporter';
import { ProjectPatterns } from './SuperIntelligentEngine';

export interface AnalyzedProject {
    patterns: ProjectPatterns;
    pageObjectExamples: string[];
    stepDefinitionExamples: string[];
    featureExamples: string[];
    statistics: ProjectStatistics;
}

export interface ProjectStatistics {
    totalPages: number;
    totalSteps: number;
    totalFeatures: number;
    commonImports: string[];
    commonDecorators: string[];
    averageMethodsPerPage: number;
}

export class ProjectPatternAnalyzer {
    private projectRoot: string;

    constructor(projectRoot: string = process.cwd()) {
        this.projectRoot = projectRoot;
    }

    /**
     * Analyze entire project to learn patterns
     */
    public async analyzeProject(): Promise<AnalyzedProject> {
        CSReporter.info('🔍 Analyzing existing project patterns...');

        const patterns: ProjectPatterns = {
            namingConventions: {
                methodStyle: 'camelCase',
                usesLogging: false,
                usesAssertions: false,
                errorHandlingStyle: 'none'
            },
            commonPatterns: [],
            exampleMethods: []
        };

        const statistics: ProjectStatistics = {
            totalPages: 0,
            totalSteps: 0,
            totalFeatures: 0,
            commonImports: [],
            commonDecorators: [],
            averageMethodsPerPage: 0
        };

        const examples: {
            pages: string[];
            steps: string[];
            features: string[];
        } = {
            pages: [],
            steps: [],
            features: []
        };

        try {
            // Find test directories
            const testDir = this.findTestDirectory();

            if (!testDir) {
                CSReporter.warn('⚠️ No test directory found - using defaults');
                return {
                    patterns,
                    pageObjectExamples: [],
                    stepDefinitionExamples: [],
                    featureExamples: [],
                    statistics
                };
            }

            // Analyze page objects
            const pageFiles = await this.findFiles(testDir, /pages?\/.*\.(ts|js)$/);
            if (pageFiles.length > 0) {
                patterns.namingConventions = await this.analyzeNamingConventions(pageFiles);
                examples.pages = await this.extractMethodExamples(pageFiles, 5);
                statistics.totalPages = pageFiles.length;

                CSReporter.debug(`✅ Analyzed ${pageFiles.length} page objects`);
            }

            // Analyze step definitions
            const stepFiles = await this.findFiles(testDir, /steps?\/.*\.(ts|js)$/);
            if (stepFiles.length > 0) {
                examples.steps = await this.extractStepExamples(stepFiles, 3);
                statistics.totalSteps = stepFiles.length;

                CSReporter.debug(`✅ Analyzed ${stepFiles.length} step definitions`);
            }

            // Analyze feature files
            const featureFiles = await this.findFiles(testDir, /.*\.feature$/);
            if (featureFiles.length > 0) {
                examples.features = await this.extractFeatureExamples(featureFiles, 2);
                statistics.totalFeatures = featureFiles.length;

                CSReporter.debug(`✅ Analyzed ${featureFiles.length} feature files`);
            }

            // Extract common patterns
            patterns.commonPatterns = this.extractCommonPatterns(examples.pages);
            patterns.exampleMethods = examples.pages.slice(0, 3);

            // Analyze imports and decorators
            statistics.commonImports = this.extractCommonImports(pageFiles);
            statistics.commonDecorators = this.extractCommonDecorators(pageFiles);

            CSReporter.pass(`✅ Project analysis complete - learned from ${statistics.totalPages} pages`);

            return {
                patterns,
                pageObjectExamples: examples.pages,
                stepDefinitionExamples: examples.steps,
                featureExamples: examples.features,
                statistics
            };
        } catch (error: any) {
            CSReporter.error(`❌ Project analysis failed: ${error.message}`);

            // Return defaults
            return {
                patterns,
                pageObjectExamples: [],
                stepDefinitionExamples: [],
                featureExamples: [],
                statistics
            };
        }
    }

    /**
     * Find test directory in project
     */
    private findTestDirectory(): string | null {
        const possibleDirs = [
            path.join(this.projectRoot, 'test'),
            path.join(this.projectRoot, 'tests'),
            path.join(this.projectRoot, 'e2e'),
            path.join(this.projectRoot, 'spec'),
            path.join(this.projectRoot, 'src', 'test'),
            path.join(this.projectRoot, 'src', 'tests')
        ];

        for (const dir of possibleDirs) {
            if (fs.existsSync(dir)) {
                return dir;
            }
        }

        return null;
    }

    /**
     * Find files matching pattern recursively
     */
    private async findFiles(dir: string, pattern: RegExp): Promise<string[]> {
        const results: string[] = [];

        if (!fs.existsSync(dir)) {
            return results;
        }

        const walk = (currentDir: string) => {
            try {
                const files = fs.readdirSync(currentDir);

                for (const file of files) {
                    const filePath = path.join(currentDir, file);

                    try {
                        const stat = fs.statSync(filePath);

                        if (stat.isDirectory()) {
                            // Skip node_modules, dist, etc.
                            if (!file.match(/node_modules|dist|build|coverage|\.git/)) {
                                walk(filePath);
                            }
                        } else if (stat.isFile() && pattern.test(filePath)) {
                            results.push(filePath);
                        }
                    } catch (err) {
                        // Skip files we can't read
                    }
                }
            } catch (err) {
                // Skip directories we can't read
            }
        };

        walk(dir);

        return results;
    }

    /**
     * Analyze naming conventions from existing code
     */
    private async analyzeNamingConventions(files: string[]): Promise<ProjectPatterns['namingConventions']> {
        const conventions: ProjectPatterns['namingConventions'] = {
            methodStyle: 'camelCase',
            usesLogging: false,
            usesAssertions: false,
            errorHandlingStyle: 'none'
        };

        let camelCaseCount = 0;
        let pascalCaseCount = 0;
        let loggingCount = 0;
        let assertionCount = 0;
        let tryCatchCount = 0;

        for (const file of files.slice(0, 10)) { // Sample first 10 files
            try {
                const content = fs.readFileSync(file, 'utf-8');

                // Check method naming style
                const methodMatches = content.match(/async\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g);
                if (methodMatches) {
                    for (const match of methodMatches) {
                        const methodName = match.match(/async\s+([a-zA-Z_][a-zA-Z0-9_]*)/)?.[1];
                        if (methodName) {
                            if (methodName[0] === methodName[0].toLowerCase()) {
                                camelCaseCount++;
                            } else {
                                pascalCaseCount++;
                            }
                        }
                    }
                }

                // Check for logging
                if (content.includes('CSReporter.') || content.includes('logger.') || content.includes('console.log')) {
                    loggingCount++;
                }

                // Check for assertions
                if (content.includes('csAssert.') || content.includes('expect(') || content.includes('assert.')) {
                    assertionCount++;
                }

                // Check for try-catch
                if (content.includes('try {') && content.includes('catch')) {
                    tryCatchCount++;
                }
            } catch (err) {
                // Skip files we can't read
            }
        }

        conventions.methodStyle = camelCaseCount >= pascalCaseCount ? 'camelCase' : 'PascalCase';
        conventions.usesLogging = loggingCount > files.length * 0.5;
        conventions.usesAssertions = assertionCount > files.length * 0.5;
        conventions.errorHandlingStyle = tryCatchCount > files.length * 0.3 ? 'try-catch' : 'none';

        return conventions;
    }

    /**
     * Extract example methods from page objects
     */
    private async extractMethodExamples(files: string[], maxExamples: number): Promise<string[]> {
        const examples: string[] = [];

        for (const file of files) {
            if (examples.length >= maxExamples) break;

            try {
                const content = fs.readFileSync(file, 'utf-8');

                // Extract complete method definitions
                const methodRegex = /(?:\/\*\*[\s\S]*?\*\/\s*)?(?:public\s+|private\s+)?async\s+[a-zA-Z_][a-zA-Z0-9_]*\s*\([^)]*\)[^{]*\{[\s\S]*?\n\s*\}/g;
                const methods = content.match(methodRegex);

                if (methods) {
                    examples.push(...methods.slice(0, maxExamples - examples.length));
                }
            } catch (err) {
                // Skip files we can't read
            }
        }

        return examples;
    }

    /**
     * Extract example step definitions
     */
    private async extractStepExamples(files: string[], maxExamples: number): Promise<string[]> {
        const examples: string[] = [];

        for (const file of files) {
            if (examples.length >= maxExamples) break;

            try {
                const content = fs.readFileSync(file, 'utf-8');

                // Extract step definitions with decorators
                const stepRegex = /@(?:Given|When|Then|And)\([^)]+\)[\s\S]*?(?:public\s+|private\s+)?async\s+[a-zA-Z_][a-zA-Z0-9_]*\s*\([^)]*\)[^{]*\{[\s\S]*?\n\s*\}/g;
                const steps = content.match(stepRegex);

                if (steps) {
                    examples.push(...steps.slice(0, maxExamples - examples.length));
                }
            } catch (err) {
                // Skip files we can't read
            }
        }

        return examples;
    }

    /**
     * Extract example feature file scenarios
     */
    private async extractFeatureExamples(files: string[], maxExamples: number): Promise<string[]> {
        const examples: string[] = [];

        for (const file of files) {
            if (examples.length >= maxExamples) break;

            try {
                const content = fs.readFileSync(file, 'utf-8');

                // Extract scenarios
                const scenarioRegex = /(?:Scenario|Scenario Outline):[^\n]+\n(?:\s+(?:Given|When|Then|And|But)[^\n]+\n)*/g;
                const scenarios = content.match(scenarioRegex);

                if (scenarios) {
                    examples.push(...scenarios.slice(0, maxExamples - examples.length));
                }
            } catch (err) {
                // Skip files we can't read
            }
        }

        return examples;
    }

    /**
     * Extract common code patterns
     */
    private extractCommonPatterns(examples: string[]): string[] {
        const patterns: string[] = [];

        // Pattern: Uses CSReporter
        if (examples.some(e => e.includes('CSReporter.'))) {
            patterns.push('Uses CSReporter for logging');
        }

        // Pattern: Uses waits before actions
        if (examples.some(e => e.includes('waitFor'))) {
            patterns.push('Uses explicit waits before actions');
        }

        // Pattern: Uses assertions after actions
        if (examples.some(e => e.includes('csAssert.') || e.includes('expect('))) {
            patterns.push('Includes assertions to verify actions');
        }

        // Pattern: Uses try-catch
        if (examples.some(e => e.includes('try {') && e.includes('catch'))) {
            patterns.push('Includes error handling with try-catch');
        }

        // Pattern: Parameterized methods
        if (examples.some(e => e.match(/\([a-zA-Z_][a-zA-Z0-9_]*:\s*string/))) {
            patterns.push('Methods are parameterized for reusability');
        }

        return patterns;
    }

    /**
     * Extract common imports
     */
    private extractCommonImports(files: string[]): string[] {
        const imports: Map<string, number> = new Map();

        for (const file of files.slice(0, 10)) {
            try {
                const content = fs.readFileSync(file, 'utf-8');

                const importRegex = /import\s+.*?from\s+['"]([^'"]+)['"]/g;
                let match;

                while ((match = importRegex.exec(content)) !== null) {
                    const importPath = match[1];
                    imports.set(importPath, (imports.get(importPath) || 0) + 1);
                }
            } catch (err) {
                // Skip
            }
        }

        // Return imports used in >50% of files
        const threshold = files.length * 0.5;
        return Array.from(imports.entries())
            .filter(([, count]) => count >= threshold)
            .map(([path]) => path)
            .slice(0, 10);
    }

    /**
     * Extract common decorators
     */
    private extractCommonDecorators(files: string[]): string[] {
        const decorators: Set<string> = new Set();

        for (const file of files.slice(0, 10)) {
            try {
                const content = fs.readFileSync(file, 'utf-8');

                const decoratorRegex = /@([A-Z][a-zA-Z0-9_]*)/g;
                let match;

                while ((match = decoratorRegex.exec(content)) !== null) {
                    decorators.add(match[1]);
                }
            } catch (err) {
                // Skip
            }
        }

        return Array.from(decorators).slice(0, 10);
    }

    /**
     * Check if project uses specific pattern
     */
    public async usesPattern(patternName: string): Promise<boolean> {
        const testDir = this.findTestDirectory();
        if (!testDir) return false;

        const files = await this.findFiles(testDir, /\.(ts|js)$/);

        for (const file of files.slice(0, 20)) {
            try {
                const content = fs.readFileSync(file, 'utf-8');

                if (content.includes(patternName)) {
                    return true;
                }
            } catch (err) {
                // Skip
            }
        }

        return false;
    }
}
