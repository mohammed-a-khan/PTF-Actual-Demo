/**
 * ProjectScanner - Existing Code Integration
 *
 * Scans project for existing step definitions, page objects, and naming conventions.
 * Enables reuse of existing code instead of generating duplicates.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface ProjectScanResult {
    existingSteps: ExistingStep[];
    existingPages: ExistingPage[];
    existingElements: ExistingElement[];
    namingConventions: DetectedNamingConventions;
    importPaths: ImportPaths;
}

export interface ExistingStep {
    pattern: string;           // The step pattern (Cucumber expression)
    regex?: RegExp;            // Compiled regex for matching
    filePath: string;
    className: string;
    methodName: string;
    parameters: string[];
}

export interface ExistingPage {
    className: string;
    filePath: string;
    pageIdentifier: string;    // From @CSPage decorator
    elements: string[];        // Element property names
    methods: string[];         // Method names
}

export interface ExistingElement {
    name: string;
    pageClass: string;
    locator: string;
    locatorType: string;
}

export interface DetectedNamingConventions {
    pageClassSuffix: string;       // 'Page', 'PO', etc.
    stepClassSuffix: string;       // 'Steps', 'StepDefs', etc.
    elementNaming: 'camelCase' | 'PascalCase';
    methodNaming: 'camelCase' | 'PascalCase';
    fileNaming: 'PascalCase' | 'kebab-case' | 'camelCase';
}

export interface ImportPaths {
    framework: string;             // Framework import path
    pages: string;                 // Pages directory relative path
    steps: string;                 // Steps directory relative path
}

export class ProjectScanner {
    private projectRoot: string;
    private scanResult: ProjectScanResult | null = null;

    constructor(projectRoot: string) {
        this.projectRoot = projectRoot;
    }

    /**
     * Scan the project for existing code
     */
    public async scan(): Promise<ProjectScanResult> {
        if (this.scanResult) {
            return this.scanResult;
        }

        const existingSteps: ExistingStep[] = [];
        const existingPages: ExistingPage[] = [];
        const existingElements: ExistingElement[] = [];

        // Find test directories
        const testDirs = this.findTestDirectories();

        // Scan for step definitions
        for (const dir of testDirs) {
            const stepsDir = path.join(dir, 'steps');
            if (fs.existsSync(stepsDir)) {
                const steps = await this.scanStepsDirectory(stepsDir);
                existingSteps.push(...steps);
            }
        }

        // Scan for page objects
        for (const dir of testDirs) {
            const pagesDir = path.join(dir, 'pages');
            if (fs.existsSync(pagesDir)) {
                const pages = await this.scanPagesDirectory(pagesDir);
                existingPages.push(...pages);

                // Extract elements from pages
                for (const page of pages) {
                    for (const elementName of page.elements) {
                        existingElements.push({
                            name: elementName,
                            pageClass: page.className,
                            locator: '', // Would need deeper parsing
                            locatorType: 'unknown',
                        });
                    }
                }
            }
        }

        // Detect naming conventions
        const namingConventions = this.detectNamingConventions(existingPages, existingSteps);

        // Detect import paths
        const importPaths = this.detectImportPaths(testDirs);

        this.scanResult = {
            existingSteps,
            existingPages,
            existingElements,
            namingConventions,
            importPaths,
        };

        return this.scanResult;
    }

    /**
     * Find matching existing step for a pattern
     */
    public findMatchingStep(stepText: string): ExistingStep | null {
        if (!this.scanResult) return null;

        for (const step of this.scanResult.existingSteps) {
            if (this.stepMatches(step, stepText)) {
                return step;
            }
        }

        return null;
    }

    /**
     * Find existing page by name
     */
    public findExistingPage(pageName: string): ExistingPage | null {
        if (!this.scanResult) return null;

        const normalizedName = pageName.toLowerCase().replace(/page$/i, '');

        for (const page of this.scanResult.existingPages) {
            const pageNormalized = page.className.toLowerCase().replace(/page$/i, '');
            if (pageNormalized === normalizedName) {
                return page;
            }
        }

        return null;
    }

    /**
     * Check if element exists in a page
     */
    public elementExistsInPage(pageName: string, elementName: string): boolean {
        const page = this.findExistingPage(pageName);
        if (!page) return false;

        return page.elements.some(e =>
            e.toLowerCase() === elementName.toLowerCase()
        );
    }

    /**
     * Find test directories
     */
    private findTestDirectories(): string[] {
        const testDirs: string[] = [];
        const commonTestPaths = [
            'test',
            'tests',
            'src/test',
            'e2e',
            'integration',
        ];

        for (const testPath of commonTestPaths) {
            const fullPath = path.join(this.projectRoot, testPath);
            if (fs.existsSync(fullPath)) {
                // Check for subdirectories (project folders)
                const entries = fs.readdirSync(fullPath, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.isDirectory()) {
                        testDirs.push(path.join(fullPath, entry.name));
                    }
                }
                testDirs.push(fullPath);
            }
        }

        return testDirs;
    }

    /**
     * Scan steps directory for step definitions
     */
    private async scanStepsDirectory(stepsDir: string): Promise<ExistingStep[]> {
        const steps: ExistingStep[] = [];

        try {
            const files = this.getTypeScriptFiles(stepsDir);

            for (const file of files) {
                const content = fs.readFileSync(file, 'utf-8');
                const fileSteps = this.extractStepsFromContent(content, file);
                steps.push(...fileSteps);
            }
        } catch (error) {
            // Directory might not exist or be readable
        }

        return steps;
    }

    /**
     * Scan pages directory for page objects
     */
    private async scanPagesDirectory(pagesDir: string): Promise<ExistingPage[]> {
        const pages: ExistingPage[] = [];

        try {
            const files = this.getTypeScriptFiles(pagesDir);

            for (const file of files) {
                const content = fs.readFileSync(file, 'utf-8');
                const page = this.extractPageFromContent(content, file);
                if (page) {
                    pages.push(page);
                }
            }
        } catch (error) {
            // Directory might not exist or be readable
        }

        return pages;
    }

    /**
     * Get TypeScript files from directory
     */
    private getTypeScriptFiles(dir: string): string[] {
        const files: string[] = [];

        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
                    files.push(fullPath);
                } else if (entry.isDirectory()) {
                    files.push(...this.getTypeScriptFiles(fullPath));
                }
            }
        } catch (error) {
            // Directory not readable
        }

        return files;
    }

    /**
     * Extract step definitions from file content
     */
    private extractStepsFromContent(content: string, filePath: string): ExistingStep[] {
        const steps: ExistingStep[] = [];

        // Match @CSBDDStepDef('pattern') or @Given/@When/@Then decorators
        const stepRegex = /@(?:CSBDDStepDef|Given|When|Then|And|But)\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
        const classRegex = /(?:export\s+)?class\s+(\w+)/;

        const classMatch = classRegex.exec(content);
        const className = classMatch ? classMatch[1] : 'Unknown';

        let match;
        while ((match = stepRegex.exec(content)) !== null) {
            const pattern = match[1];

            // Extract method name (next function after decorator)
            const afterDecorator = content.substring(match.index + match[0].length);
            const methodMatch = afterDecorator.match(/async\s+(\w+)\s*\(/);
            const methodName = methodMatch ? methodMatch[1] : 'unknown';

            // Extract parameters from pattern
            const parameters: string[] = [];
            const paramMatches = pattern.matchAll(/\{(\w+)\}/g);
            for (const pm of paramMatches) {
                parameters.push(pm[1]);
            }

            steps.push({
                pattern,
                filePath,
                className,
                methodName,
                parameters,
            });
        }

        return steps;
    }

    /**
     * Extract page object from file content
     */
    private extractPageFromContent(content: string, filePath: string): ExistingPage | null {
        // Match class definition with extends CSBasePage
        const classRegex = /(?:export\s+)?class\s+(\w+)\s+extends\s+CSBasePage/;
        const classMatch = classRegex.exec(content);
        if (!classMatch) return null;

        const className = classMatch[1];

        // Extract @CSPage identifier
        const pageIdRegex = /@CSPage\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/;
        const pageIdMatch = pageIdRegex.exec(content);
        const pageIdentifier = pageIdMatch ? pageIdMatch[1] : className.toLowerCase();

        // Extract element properties (marked with @CSGetElement)
        const elements: string[] = [];
        const elementRegex = /@CSGetElement\s*\([^)]+\)\s*(?:public\s+)?(\w+)\s*[!:]/g;
        let elementMatch;
        while ((elementMatch = elementRegex.exec(content)) !== null) {
            elements.push(elementMatch[1]);
        }

        // Extract public methods
        const methods: string[] = [];
        const methodRegex = /public\s+async\s+(\w+)\s*\(/g;
        let methodMatch;
        while ((methodMatch = methodRegex.exec(content)) !== null) {
            if (!methodMatch[1].startsWith('initialize')) {
                methods.push(methodMatch[1]);
            }
        }

        return {
            className,
            filePath,
            pageIdentifier,
            elements,
            methods,
        };
    }

    /**
     * Detect naming conventions from existing code
     */
    private detectNamingConventions(
        pages: ExistingPage[],
        steps: ExistingStep[]
    ): DetectedNamingConventions {
        // Default conventions
        const conventions: DetectedNamingConventions = {
            pageClassSuffix: 'Page',
            stepClassSuffix: 'Steps',
            elementNaming: 'camelCase',
            methodNaming: 'camelCase',
            fileNaming: 'PascalCase',
        };

        // Detect page class suffix
        if (pages.length > 0) {
            const suffixes = pages.map(p => {
                const match = p.className.match(/(Page|PO|PageObject)$/);
                return match ? match[1] : 'Page';
            });
            const mostCommon = this.mostCommonValue(suffixes);
            if (mostCommon) conventions.pageClassSuffix = mostCommon;
        }

        // Detect step class suffix
        if (steps.length > 0) {
            const suffixes = steps.map(s => {
                const match = s.className.match(/(Steps|StepDefs|StepDefinitions)$/);
                return match ? match[1] : 'Steps';
            });
            const mostCommon = this.mostCommonValue(suffixes);
            if (mostCommon) conventions.stepClassSuffix = mostCommon;
        }

        return conventions;
    }

    /**
     * Detect import paths from project structure
     */
    private detectImportPaths(testDirs: string[]): ImportPaths {
        // Default paths
        const paths: ImportPaths = {
            framework: '@mdakhan.mak/cs-playwright-test-framework',
            pages: '../pages',
            steps: '../steps',
        };

        // Try to detect from existing files
        for (const dir of testDirs) {
            const stepsDir = path.join(dir, 'steps');
            if (fs.existsSync(stepsDir)) {
                const files = this.getTypeScriptFiles(stepsDir);
                if (files.length > 0) {
                    const content = fs.readFileSync(files[0], 'utf-8');

                    // Extract framework import
                    const frameworkMatch = content.match(/from\s+['"](@[\w\-./]+cs-playwright[^'"]+)['"]/);
                    if (frameworkMatch) {
                        paths.framework = frameworkMatch[1].replace(/\/\w+$/, ''); // Remove submodule
                    }

                    // Extract pages import
                    const pagesMatch = content.match(/from\s+['"]([^'"]*pages[^'"]*)['"]/);
                    if (pagesMatch) {
                        paths.pages = pagesMatch[1].replace(/\/\w+Page['"]*$/, '');
                    }
                }
            }
        }

        return paths;
    }

    /**
     * Check if step matches pattern
     */
    private stepMatches(step: ExistingStep, text: string): boolean {
        // Convert Cucumber expression to regex
        const regexPattern = step.pattern
            .replace(/\{string\}/g, '"([^"]*)"')
            .replace(/\{int\}/g, '(\\d+)')
            .replace(/\{float\}/g, '([\\d.]+)')
            .replace(/\{word\}/g, '(\\w+)');

        try {
            const regex = new RegExp(`^${regexPattern}$`, 'i');
            return regex.test(text);
        } catch {
            return step.pattern.toLowerCase() === text.toLowerCase();
        }
    }

    /**
     * Get most common value from array
     */
    private mostCommonValue(arr: string[]): string | null {
        if (arr.length === 0) return null;

        const counts = new Map<string, number>();
        for (const val of arr) {
            counts.set(val, (counts.get(val) || 0) + 1);
        }

        let maxCount = 0;
        let maxVal: string | null = null;
        for (const [val, count] of counts) {
            if (count > maxCount) {
                maxCount = count;
                maxVal = val;
            }
        }

        return maxVal;
    }
}

export default ProjectScanner;
