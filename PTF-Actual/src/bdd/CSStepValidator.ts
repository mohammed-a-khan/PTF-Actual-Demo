import * as fs from 'fs';
import * as path from 'path';
import { CSReporter } from '../reporter/CSReporter';
import { CSStepRegistry, StepDefinition } from './CSStepRegistry';

export interface StepDefinitionInfo {
    pattern: string;
    file: string;
    line: number;
}

export interface MethodInfo {
    name: string;
    file: string;
    line: number;
    className?: string;
}

export interface ValidationResult {
    isValid: boolean;
    duplicateSteps: Map<string, StepDefinitionInfo[]>;
    duplicateMethods: Map<string, MethodInfo[]>;
    errors: string[];
}

export class CSStepValidator {
    private static instance: CSStepValidator;
    private stepDefinitions: Map<string, StepDefinitionInfo[]> = new Map();
    private methods: Map<string, MethodInfo[]> = new Map();

    private constructor() {}

    public static getInstance(): CSStepValidator {
        if (!CSStepValidator.instance) {
            CSStepValidator.instance = new CSStepValidator();
        }
        return CSStepValidator.instance;
    }

    /**
     * Validates all step definition files for duplicates
     */
    public async validateStepFiles(stepFilePaths: string[]): Promise<ValidationResult> {
        CSReporter.info('Validating step definitions for duplicates...');

        // Clear previous data
        this.stepDefinitions.clear();
        this.methods.clear();

        // Scan all step files
        for (const filePath of stepFilePaths) {
            if (fs.existsSync(filePath)) {
                await this.scanFile(filePath);
            }
        }

        // Find duplicates
        const duplicateSteps = this.findDuplicateSteps();
        const duplicateMethods = this.findDuplicateMethods();

        // Generate errors
        const errors: string[] = [];

        // Report duplicate step definitions
        if (duplicateSteps.size > 0) {
            errors.push('\n❌ DUPLICATE STEP DEFINITIONS DETECTED!\n');

            duplicateSteps.forEach((locations, pattern) => {
                errors.push(`\n  Step: "${pattern}"`);
                errors.push('  Found in:');
                locations.forEach(loc => {
                    errors.push(`    - ${loc.file}:${loc.line}`);
                });
            });

            errors.push('\n  Resolution: Each step pattern must be unique across all step files.');
            errors.push('  Please rename or remove duplicate step definitions.\n');
        }

        // Report duplicate method names
        if (duplicateMethods.size > 0) {
            errors.push('\n❌ DUPLICATE METHOD NAMES DETECTED!\n');

            duplicateMethods.forEach((locations, methodName) => {
                errors.push(`\n  Method: "${methodName}"`);
                errors.push('  Found in:');
                locations.forEach(loc => {
                    const className = loc.className ? ` (class: ${loc.className})` : '';
                    errors.push(`    - ${loc.file}:${loc.line}${className}`);
                });
            });

            errors.push('\n  Resolution: Method names must be unique across all step definition files.');
            errors.push('  Please rename duplicate methods to have unique names.\n');
        }

        const isValid = duplicateSteps.size === 0 && duplicateMethods.size === 0;

        // Log validation results
        if (isValid) {
            CSReporter.pass('✅ Step validation passed - no duplicates found');
        } else {
            const errorMessage = errors.join('\n');
            CSReporter.error(errorMessage);

            // Also log individual errors for better visibility
            if (duplicateSteps.size > 0) {
                CSReporter.error(`Found ${duplicateSteps.size} duplicate step definition(s)`);
            }
            if (duplicateMethods.size > 0) {
                CSReporter.error(`Found ${duplicateMethods.size} duplicate method name(s)`);
            }
        }

        return {
            isValid,
            duplicateSteps,
            duplicateMethods,
            errors
        };
    }

    /**
     * Scans a file for step definitions and methods
     */
    private async scanFile(filePath: string): Promise<void> {
        const content = fs.readFileSync(filePath, 'utf8');
        const fileName = path.relative(process.cwd(), filePath);
        const lines = content.split('\n');

        // Scan for step definitions
        this.scanForStepDefinitions(content, fileName, lines);

        // Scan for method names
        this.scanForMethods(content, fileName, lines);
    }

    /**
     * Scans content for step definitions
     */
    private scanForStepDefinitions(content: string, fileName: string, lines: string[]): void {
        // Pattern to match @CSBDDStepDef decorator
        const stepDefRegex = /@CSBDDStepDef\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;

        let match;
        while ((match = stepDefRegex.exec(content)) !== null) {
            const pattern = match[1];
            const position = match.index;
            const lineNumber = this.getLineNumber(content, position);

            // Store step definition info
            if (!this.stepDefinitions.has(pattern)) {
                this.stepDefinitions.set(pattern, []);
            }

            this.stepDefinitions.get(pattern)!.push({
                pattern,
                file: fileName,
                line: lineNumber
            });
        }
    }

    /**
     * Scans content for method names
     */
    private scanForMethods(content: string, fileName: string, lines: string[]): void {
        // Pattern to match TypeScript methods and functions
        // Matches: async methodName(...), methodName(...), function methodName(...), etc.
        const methodPatterns = [
            // Class methods
            /(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*{/g,
            // Function declarations
            /function\s+(\w+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*{/g,
            // Arrow functions assigned to variables
            /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g,
            // Arrow functions with type annotations
            /(?:const|let|var)\s+(\w+)\s*:\s*[^=]+\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g
        ];

        // Extract class names for context
        const classRegex = /class\s+(\w+)/g;
        const classes: { name: string; startLine: number; endLine: number }[] = [];

        let classMatch;
        while ((classMatch = classRegex.exec(content)) !== null) {
            const className = classMatch[1];
            const startLine = this.getLineNumber(content, classMatch.index);

            // Find the end of the class (simplified - counts braces)
            const classStartIndex = classMatch.index;
            let braceCount = 0;
            let foundFirstBrace = false;
            let endIndex = classStartIndex;

            for (let i = classStartIndex; i < content.length; i++) {
                if (content[i] === '{') {
                    braceCount++;
                    foundFirstBrace = true;
                } else if (content[i] === '}' && foundFirstBrace) {
                    braceCount--;
                    if (braceCount === 0) {
                        endIndex = i;
                        break;
                    }
                }
            }

            classes.push({
                name: className,
                startLine,
                endLine: this.getLineNumber(content, endIndex)
            });
        }

        // Find all methods
        const foundMethods = new Set<string>(); // Track to avoid duplicates in the same file

        methodPatterns.forEach(pattern => {
            let match;
            const regex = new RegExp(pattern.source, pattern.flags);

            while ((match = regex.exec(content)) !== null) {
                const methodName = match[1];

                // Skip constructor, common lifecycle methods, and already found methods
                if (['constructor', 'toString', 'valueOf', 'if', 'for', 'while', 'switch', 'catch']
                    .includes(methodName) || foundMethods.has(methodName)) {
                    continue;
                }

                const lineNumber = this.getLineNumber(content, match.index);

                // Determine which class this method belongs to
                let className: string | undefined;
                for (const cls of classes) {
                    if (lineNumber >= cls.startLine && lineNumber <= cls.endLine) {
                        className = cls.name;
                        break;
                    }
                }

                // Only track methods that are likely step-related
                // Check if the method is in a step definition context
                const methodLine = lines[lineNumber - 1] || '';
                const prevLine = lines[lineNumber - 2] || '';

                // Skip if it's not in a step context (has @CSBDDStepDef nearby or is in a steps file)
                const isStepRelated = fileName.includes('.steps.') ||
                                     fileName.includes('step-definitions') ||
                                     prevLine.includes('@CSBDDStepDef') ||
                                     lines.slice(Math.max(0, lineNumber - 5), lineNumber)
                                          .some(l => l.includes('@CSBDDStepDef'));

                if (isStepRelated) {
                    if (!this.methods.has(methodName)) {
                        this.methods.set(methodName, []);
                    }

                    this.methods.get(methodName)!.push({
                        name: methodName,
                        file: fileName,
                        line: lineNumber,
                        className
                    });

                    foundMethods.add(methodName);
                }
            }
        });
    }

    /**
     * Gets line number from position in content
     */
    private getLineNumber(content: string, position: number): number {
        const lines = content.substring(0, position).split('\n');
        return lines.length;
    }

    /**
     * Finds duplicate step definitions
     */
    private findDuplicateSteps(): Map<string, StepDefinitionInfo[]> {
        const duplicates = new Map<string, StepDefinitionInfo[]>();

        this.stepDefinitions.forEach((locations, pattern) => {
            if (locations.length > 1) {
                duplicates.set(pattern, locations);
            }
        });

        return duplicates;
    }

    /**
     * Finds duplicate method names across files
     */
    private findDuplicateMethods(): Map<string, MethodInfo[]> {
        const duplicates = new Map<string, MethodInfo[]>();

        this.methods.forEach((locations, methodName) => {
            // Check if the method appears in different files
            const uniqueFiles = new Set(locations.map(l => l.file));

            if (uniqueFiles.size > 1) {
                duplicates.set(methodName, locations);
            }
        });

        return duplicates;
    }

    /**
     * Validates runtime step registry for duplicates
     */
    public validateRegistry(): ValidationResult {
        const registry = CSStepRegistry.getInstance();
        const steps = registry.getSteps(); // Using getSteps() instead of getAllSteps()

        const errors: string[] = [];
        const duplicateSteps = new Map<string, StepDefinitionInfo[]>();

        // Check for duplicate patterns in runtime registry
        const patternMap = new Map<string, string[]>();

        // Iterate through the Map<string, StepDefinition[]>
        steps.forEach((stepDefArray, stepKey) => {
            stepDefArray.forEach(stepDef => {
                const pattern = stepDef.pattern.toString();
                if (!patternMap.has(pattern)) {
                    patternMap.set(pattern, []);
                }
                // Use stepKey as the file identifier
                patternMap.get(pattern)!.push(stepKey);
            });
        });

        // Find patterns that appear multiple times
        patternMap.forEach((locations, pattern) => {
            const uniqueLocations = [...new Set(locations)]; // Remove duplicates
            if (uniqueLocations.length > 1) {
                const stepInfos = uniqueLocations.map(location => ({
                    pattern,
                    file: location,
                    line: 0 // Line number not available from runtime
                }));
                duplicateSteps.set(pattern, stepInfos);

                errors.push(`\n❌ Duplicate step pattern registered at runtime: "${pattern}"`);
                errors.push('  Locations:');
                uniqueLocations.forEach(location => {
                    errors.push(`    - ${location}`);
                });
            }
        });

        return {
            isValid: duplicateSteps.size === 0,
            duplicateSteps,
            duplicateMethods: new Map(),
            errors
        };
    }
}