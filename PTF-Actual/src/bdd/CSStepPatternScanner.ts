/**
 * CS Step Pattern Scanner - Lazy Step Loading for Fast Startup
 *
 * Scans step files and extracts step patterns WITHOUT executing the files.
 * This avoids the slow import chain when step files import page classes.
 *
 * Patterns are extracted using regex parsing of source files, then files
 * are only loaded when a matching step pattern is actually needed during execution.
 *
 * PERFORMANCE IMPACT:
 * - Without this: 60+ seconds (all step files + their imports loaded at startup)
 * - With this: < 2 seconds (only regex scanning, no module loading)
 */

import * as fs from 'fs';
import * as path from 'path';
import { CSReporter } from '../reporter/CSReporter';
import { CSConfigurationManager } from '../core/CSConfigurationManager';

interface ScannedStep {
    pattern: string;           // The step pattern (regex or cucumber expression)
    patternRegex: RegExp;      // Compiled regex for matching
    filePath: string;          // Path to the step file
    methodName: string;        // Method name in the file
    type: 'Given' | 'When' | 'Then' | 'And' | 'But';
    loaded: boolean;           // Whether the file has been loaded
}

interface ScannedFile {
    filePath: string;
    steps: ScannedStep[];
    loaded: boolean;
}

export class CSStepPatternScanner {
    private static instance: CSStepPatternScanner;
    private scannedFiles: Map<string, ScannedFile> = new Map();
    private stepsByPattern: Map<string, ScannedStep> = new Map();
    private scanned: boolean = false;

    private constructor() {}

    public static getInstance(): CSStepPatternScanner {
        if (!CSStepPatternScanner.instance) {
            CSStepPatternScanner.instance = new CSStepPatternScanner();
        }
        return CSStepPatternScanner.instance;
    }

    /**
     * Scan step files and extract patterns WITHOUT loading them
     * This is the key to fast startup - no require() calls, just file reading
     */
    public async scanStepFiles(stepPaths: string[]): Promise<void> {
        if (this.scanned) return;

        const startTime = Date.now();
        let totalFiles = 0;
        let totalSteps = 0;

        for (const stepPath of stepPaths) {
            if (!fs.existsSync(stepPath)) continue;

            const stat = fs.statSync(stepPath);
            if (stat.isDirectory()) {
                const files = this.findStepFiles(stepPath);
                for (const file of files) {
                    const steps = await this.scanFile(file);
                    totalSteps += steps;
                    totalFiles++;
                }
            } else if (this.isStepFile(stepPath)) {
                const steps = await this.scanFile(stepPath);
                totalSteps += steps;
                totalFiles++;
            }
        }

        this.scanned = true;
        const duration = Date.now() - startTime;
        CSReporter.info(`[StepScanner] ✅ Scanned ${totalFiles} files, found ${totalSteps} step patterns in ${duration}ms`);
    }

    /**
     * Scan a single step file and extract patterns using regex
     * Does NOT execute the file - just reads and parses the source code
     */
    private async scanFile(filePath: string): Promise<number> {
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const steps: ScannedStep[] = [];

            // Pattern 1a: @CSBDDStepDef decorator with type and pattern (two parameters)
            // @CSBDDStepDef('Given', 'I am on the login page')
            // @CSBDDStepDef("When", "I click on {string}")
            const csStepDefTwoParamsRegex = /@CSBDDStepDef\s*\(\s*['"](\w+)['"]\s*,\s*['"`]([^'"`]+)['"`]/g;
            let match;
            while ((match = csStepDefTwoParamsRegex.exec(content)) !== null) {
                const type = match[1] as 'Given' | 'When' | 'Then' | 'And' | 'But';
                const pattern = match[2];
                steps.push(this.createScannedStep(type, pattern, filePath, 'decorator'));
            }

            // Pattern 1b: @CSBDDStepDef decorator with pattern only (single parameter)
            // @CSBDDStepDef('I am on the login page')
            // @CSBDDStepDef("I click on {string}")
            // Match @CSBDDStepDef followed by a single string parameter (not two params)
            const csStepDefOneParamRegex = /@CSBDDStepDef\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
            while ((match = csStepDefOneParamRegex.exec(content)) !== null) {
                const pattern = match[1];
                // Infer type from pattern or use 'Given' as default
                steps.push(this.createScannedStep('Given', pattern, filePath, 'decorator'));
            }

            // Pattern 2: Legacy decorators @Given, @When, @Then
            // @Given('I am on the login page')
            // @When("I click on {string}")
            const legacyDecoratorRegex = /@(Given|When|Then|And|But)\s*\(\s*['"`]([^'"`]+)['"`]/g;
            while ((match = legacyDecoratorRegex.exec(content)) !== null) {
                const type = match[1] as 'Given' | 'When' | 'Then' | 'And' | 'But';
                const pattern = match[2];
                steps.push(this.createScannedStep(type, pattern, filePath, 'legacy'));
            }

            // Pattern 3: registerStepDefinition function calls
            // registerStepDefinition('I am on the {string} page', async function(...))
            const registerRegex = /registerStepDefinition\s*\(\s*['"`]([^'"`]+)['"`]/g;
            while ((match = registerRegex.exec(content)) !== null) {
                const pattern = match[1];
                steps.push(this.createScannedStep('Given', pattern, filePath, 'register'));
            }

            // Store the scanned file
            this.scannedFiles.set(filePath, {
                filePath,
                steps,
                loaded: false
            });

            // Index steps by their pattern for fast lookup
            for (const step of steps) {
                this.stepsByPattern.set(step.pattern, step);
            }

            if (steps.length > 0) {
                CSReporter.debug(`[StepScanner] Found ${steps.length} patterns in ${path.basename(filePath)}`);
            }

            return steps.length;
        } catch (error: any) {
            CSReporter.debug(`[StepScanner] Error scanning ${filePath}: ${error.message}`);
            return 0;
        }
    }

    /**
     * Create a scanned step entry with compiled regex
     */
    private createScannedStep(
        type: 'Given' | 'When' | 'Then' | 'And' | 'But',
        pattern: string,
        filePath: string,
        methodName: string
    ): ScannedStep {
        return {
            type,
            pattern,
            patternRegex: this.patternToRegex(pattern),
            filePath,
            methodName,
            loaded: false
        };
    }

    /**
     * Convert cucumber expression or string pattern to regex
     */
    private patternToRegex(pattern: string): RegExp {
        // If already a regex pattern (starts with ^ or ends with $), use as-is
        if (pattern.startsWith('^') || pattern.endsWith('$')) {
            return new RegExp(pattern);
        }

        // Escape special regex characters first
        let regexPattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        // Then replace Cucumber placeholders with regex groups
        regexPattern = regexPattern.replace(/\\{string\\}/g, '"([^"]*)"');
        regexPattern = regexPattern.replace(/\\{int\\}/g, '(\\d+)');
        regexPattern = regexPattern.replace(/\\{float\\}/g, '([\\d\\.]+)');
        regexPattern = regexPattern.replace(/\\{word\\}/g, '(\\w+)');

        return new RegExp(`^${regexPattern}$`);
    }

    /**
     * Find the step file that matches a given step text
     * Returns the file path if found, null otherwise
     */
    public findMatchingStepFile(stepText: string): string | null {
        for (const [pattern, step] of this.stepsByPattern) {
            if (step.patternRegex.test(stepText)) {
                return step.filePath;
            }
        }
        return null;
    }

    /**
     * Load a specific step file (only when needed during execution)
     * This is where the actual require() happens
     */
    public async loadStepFile(filePath: string): Promise<void> {
        const scannedFile = this.scannedFiles.get(filePath);
        if (!scannedFile || scannedFile.loaded) return;

        const startTime = Date.now();

        try {
            // Only prefer compiled dist/ files when PREFER_DIST_STEPS=true
            const config = CSConfigurationManager.getInstance();
            const preferDist = config.getBoolean('PREFER_DIST_STEPS', false);

            // Check for compiled JS version only if PREFER_DIST_STEPS=true
            let fileToLoad = filePath;
            if (preferDist && filePath.endsWith('.ts')) {
                const cwd = process.cwd();
                const relativePath = path.relative(cwd, filePath);

                // Consumer project: test/project/steps/file.ts -> dist/test/project/steps/file.js
                if (relativePath.startsWith('test') || relativePath.startsWith(`test${path.sep}`)) {
                    const distPath = path.join(cwd, 'dist', relativePath.replace('.ts', '.js'));
                    if (fs.existsSync(distPath)) {
                        fileToLoad = distPath;
                    }
                }

                // Framework: src/steps/file.ts -> dist/steps/file.js
                if (fileToLoad === filePath && (filePath.includes('/src/') || filePath.includes('\\src\\'))) {
                    const jsPath = filePath
                        .replace('/src/', '/dist/')
                        .replace('\\src\\', '\\dist\\')
                        .replace('.ts', '.js');
                    if (fs.existsSync(jsPath)) {
                        fileToLoad = jsPath;
                    }
                }
            }

            require(fileToLoad);
            scannedFile.loaded = true;

            const duration = Date.now() - startTime;
            CSReporter.debug(`[StepScanner] Loaded ${path.basename(fileToLoad)} in ${duration}ms`);
        } catch (error: any) {
            CSReporter.error(`[StepScanner] Failed to load ${filePath}: ${error.message}`);
            throw error;
        }
    }

    /**
     * Load all step files that match steps in the given features
     * This is more efficient than loading all files upfront
     */
    public async loadStepsForFeatures(features: any[]): Promise<void> {
        const startTime = Date.now();
        const filesToLoad = new Set<string>();

        // Collect all unique step texts from features
        for (const feature of features) {
            for (const scenario of feature.scenarios || []) {
                for (const step of scenario.steps || []) {
                    const stepText = step.text;
                    const matchingFile = this.findMatchingStepFile(stepText);
                    if (matchingFile) {
                        filesToLoad.add(matchingFile);
                    }
                }

                // Also check background steps
                if (feature.background) {
                    for (const step of feature.background.steps || []) {
                        const matchingFile = this.findMatchingStepFile(step.text);
                        if (matchingFile) {
                            filesToLoad.add(matchingFile);
                        }
                    }
                }
            }
        }

        CSReporter.info(`[StepScanner] Loading ${filesToLoad.size} step files needed for execution...`);

        // Load only the files that are actually needed
        for (const file of filesToLoad) {
            await this.loadStepFile(file);
        }

        const duration = Date.now() - startTime;
        CSReporter.info(`[StepScanner] ✅ Loaded ${filesToLoad.size} required step files in ${duration}ms`);
    }

    /**
     * Get all registered patterns (for debugging/validation)
     */
    public getAllPatterns(): string[] {
        return Array.from(this.stepsByPattern.keys());
    }

    /**
     * Check if scanning has been done
     */
    public isScanned(): boolean {
        return this.scanned;
    }

    /**
     * Get statistics about scanned files
     */
    public getStats(): { files: number; patterns: number; loaded: number } {
        let loaded = 0;
        for (const file of this.scannedFiles.values()) {
            if (file.loaded) loaded++;
        }
        return {
            files: this.scannedFiles.size,
            patterns: this.stepsByPattern.size,
            loaded
        };
    }

    /**
     * Find step files in a directory
     */
    private findStepFiles(dirPath: string): string[] {
        const files: string[] = [];

        try {
            const items = fs.readdirSync(dirPath);
            const seenBasenames = new Set<string>();

            for (const item of items) {
                try {
                    const fullPath = path.join(dirPath, item);
                    const stat = fs.statSync(fullPath);

                    if (stat.isDirectory()) {
                        // Recursively scan subdirectories
                        const subFiles = this.findStepFiles(fullPath);
                        files.push(...subFiles);
                    } else if (this.isStepFile(fullPath)) {
                        // Prefer .js files over .ts to avoid duplicates
                        const basename = item.replace(/\.(ts|js)$/, '');
                        if (!seenBasenames.has(basename)) {
                            const jsVersion = path.join(dirPath, basename + '.js');
                            const tsVersion = path.join(dirPath, basename + '.ts');

                            if (fs.existsSync(jsVersion)) {
                                files.push(jsVersion);
                            } else if (fs.existsSync(tsVersion)) {
                                files.push(tsVersion);
                            }
                            seenBasenames.add(basename);
                        }
                    }
                } catch (itemError: any) {
                    // Skip problematic files/directories (permissions, symlinks, etc.)
                    CSReporter.debug(`[StepScanner] Skipping ${item}: ${itemError.message}`);
                }
            }
        } catch (error: any) {
            CSReporter.debug(`[StepScanner] Error reading directory ${dirPath}: ${error.message}`);
        }

        return files;
    }

    /**
     * Check if a file is a step definition file
     */
    private isStepFile(filePath: string): boolean {
        const fileName = path.basename(filePath);
        return (
            fileName.endsWith('.steps.ts') ||
            fileName.endsWith('.steps.js') ||
            fileName.endsWith('.step.ts') ||
            fileName.endsWith('.step.js') ||
            fileName.endsWith('Steps.ts') ||
            fileName.endsWith('Steps.js')
        ) && !fileName.includes('.spec.') && !fileName.includes('.test.');
    }

    /**
     * Clear all scanned data (for testing)
     */
    public clear(): void {
        this.scannedFiles.clear();
        this.stepsByPattern.clear();
        this.scanned = false;
    }
}
