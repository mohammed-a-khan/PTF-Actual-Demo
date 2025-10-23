/**
 * Template Syntax Processor
 * Converts Java ${} syntax to PTF {{}} syntax
 * Maintains backward compatibility for Java framework migration
 *
 * Supported conversions:
 * - ${variableName} → {{variableName}}
 * - ${config.key} → {{env.key}}
 * - ${response.field} → {{responses.last.body.field}}
 * - ${testData.key} → {{key}} (direct variable access)
 */

import { CSReporter } from '../../reporter/CSReporter';

export interface TemplateSyntaxAnalysis {
    hasJavaSyntax: boolean;
    hasPTFSyntax: boolean;
    javaVariables: string[];
    ptfVariables: string[];
    allVariables: string[];
}

export class CSTemplateProcessor {
    /**
     * Normalize template syntax from Java ${} to PTF {{}}
     * Handles special cases and context mappings
     *
     * @param template - Template string with ${} or {{}} placeholders
     * @returns Normalized template with {{}} syntax
     */
    public static normalizeSyntax(template: string): string {
        if (!template) {
            return template;
        }

        let normalized = template;

        // Pattern 1: ${config.key} → {{env.key}}
        // Maps Java config access to PTF environment variables
        normalized = normalized.replace(/\$\{config\.([^}]+)\}/g, '{{env.$1}}');

        // Pattern 2: ${response.field} → {{responses.last.body.field}}
        // Maps Java implicit response access to PTF response context
        // Handle nested paths: ${response.data.user.id} → {{responses.last.body.data.user.id}}
        normalized = normalized.replace(/\$\{response\.([^}]+)\}/g, (match, path) => {
            return `{{responses.last.body.${path}}}`;
        });

        // Pattern 3: ${testData.key} → {{key}}
        // Maps Java TestContextManager.getTestData("key") to PTF direct variable access
        normalized = normalized.replace(/\$\{testData\.([^}]+)\}/g, '{{$1}}');

        // Pattern 4: ${variableName} → {{variableName}}
        // This catches all remaining ${} patterns
        // Must be last to avoid double-conversion
        normalized = normalized.replace(/\$\{([^}]+)\}/g, '{{$1}}');

        return normalized;
    }

    /**
     * Check if template contains Java ${} syntax
     */
    public static hasJavaSyntax(template: string): boolean {
        if (!template) {
            return false;
        }
        return /\$\{[^}]+\}/.test(template);
    }

    /**
     * Check if template contains PTF {{}} syntax
     */
    public static hasPTFSyntax(template: string): boolean {
        if (!template) {
            return false;
        }
        return /\{\{[^}]+\}\}/.test(template);
    }

    /**
     * Extract all variable names from template (both syntaxes)
     *
     * @param template - Template string
     * @returns Array of unique variable names
     */
    public static extractVariables(template: string): string[] {
        if (!template) {
            return [];
        }

        const variables: string[] = [];

        // Extract Java syntax variables: ${variableName}
        const javaMatches = template.matchAll(/\$\{([^}]+)\}/g);
        for (const match of javaMatches) {
            variables.push(match[1]);
        }

        // Extract PTF syntax variables: {{variableName}}
        const ptfMatches = template.matchAll(/\{\{([^}]+)\}\}/g);
        for (const match of ptfMatches) {
            // Remove pipe transformations if present
            const varName = match[1].split('|')[0].trim();
            variables.push(varName);
        }

        // Remove duplicates
        return [...new Set(variables)];
    }

    /**
     * Analyze template syntax
     * Returns detailed information about placeholders in template
     */
    public static analyzeSyntax(template: string): TemplateSyntaxAnalysis {
        const hasJavaSyntax = this.hasJavaSyntax(template);
        const hasPTFSyntax = this.hasPTFSyntax(template);

        const javaVariables: string[] = [];
        const ptfVariables: string[] = [];

        if (template) {
            // Extract Java variables
            const javaMatches = template.matchAll(/\$\{([^}]+)\}/g);
            for (const match of javaMatches) {
                javaVariables.push(match[1]);
            }

            // Extract PTF variables
            const ptfMatches = template.matchAll(/\{\{([^}]+)\}\}/g);
            for (const match of ptfMatches) {
                const varName = match[1].split('|')[0].trim();
                ptfVariables.push(varName);
            }
        }

        return {
            hasJavaSyntax,
            hasPTFSyntax,
            javaVariables,
            ptfVariables,
            allVariables: [...new Set([...javaVariables, ...ptfVariables])]
        };
    }

    /**
     * Convert PTF {{}} syntax back to Java ${} syntax
     * Useful for reverse migration or compatibility
     */
    public static convertToJavaSyntax(template: string): string {
        if (!template) {
            return template;
        }

        let converted = template;

        // Reverse Pattern 1: {{env.key}} → ${config.key}
        converted = converted.replace(/\{\{env\.([^}]+)\}\}/g, '${config.$1}');

        // Reverse Pattern 2: {{responses.last.body.field}} → ${response.field}
        converted = converted.replace(/\{\{responses\.last\.body\.([^}]+)\}\}/g, '${response.$1}');

        // Reverse Pattern 3: Simple variables {{variableName}} → ${variableName}
        // Must exclude pipe transformations and functions
        converted = converted.replace(/\{\{([^}|]+)\}\}/g, (match, varName) => {
            const trimmed = varName.trim();
            // Don't convert if it contains function calls or transformations
            if (trimmed.includes('(') || trimmed.includes('.')) {
                return match; // Keep as-is
            }
            return `\${${trimmed}}`;
        });

        return converted;
    }

    /**
     * Validate template syntax
     * Checks for common syntax errors
     */
    public static validateSyntax(template: string): { valid: boolean; errors: string[] } {
        const errors: string[] = [];

        if (!template) {
            return { valid: true, errors: [] };
        }

        // Check for mismatched Java placeholders
        const openJava = (template.match(/\$\{/g) || []).length;
        const closeJava = (template.match(/\$\{[^}]*\}/g) || []).length;

        if (openJava !== closeJava) {
            errors.push(`Mismatched Java placeholder braces: ${openJava} opening, ${closeJava} closing`);
        }

        // Check for mismatched PTF placeholders
        const openPTF = (template.match(/\{\{/g) || []).length;
        const closePTF = (template.match(/\{\{[^}]*\}\}/g) || []).length;

        if (openPTF !== closePTF) {
            errors.push(`Mismatched PTF placeholder braces: ${openPTF} opening, ${closePTF} closing`);
        }

        // Check for nested placeholders (not supported)
        if (/\$\{[^}]*\$\{/.test(template) || /\{\{[^}]*\{\{/.test(template)) {
            errors.push('Nested placeholders are not supported');
        }

        return {
            valid: errors.length === 0,
            errors
        };
    }

    /**
     * Replace array indexing syntax
     * Supports: ${variableName[0]} → {{variableName[0]}}
     * Also supports nested: ${response.users[0].name} → {{responses.last.body.users[0].name}}
     */
    public static normalizeArrayIndexing(template: string): string {
        if (!template) {
            return template;
        }

        let normalized = template;

        // Pattern: ${response.field[index].nested} → {{responses.last.body.field[index].nested}}
        normalized = normalized.replace(
            /\$\{response\.([^}]+)\}/g,
            (match, path) => {
                return `{{responses.last.body.${path}}}`;
            }
        );

        // Pattern: ${variableName[index]} → {{variableName[index]}}
        normalized = normalized.replace(/\$\{([^}]+)\[(\d+)\]([^}]*)\}/g, '{{$1[$2]$3}}');

        return normalized;
    }

    /**
     * Log template syntax analysis for debugging
     */
    public static logSyntaxAnalysis(template: string, label?: string): void {
        const analysis = this.analyzeSyntax(template);

        CSReporter.debug(`Template Syntax Analysis${label ? ` (${label})` : ''}:`);
        CSReporter.debug(`  Java Syntax: ${analysis.hasJavaSyntax}`);
        CSReporter.debug(`  PTF Syntax: ${analysis.hasPTFSyntax}`);

        if (analysis.javaVariables.length > 0) {
            CSReporter.debug(`  Java Variables: ${analysis.javaVariables.join(', ')}`);
        }

        if (analysis.ptfVariables.length > 0) {
            CSReporter.debug(`  PTF Variables: ${analysis.ptfVariables.join(', ')}`);
        }

        const validation = this.validateSyntax(template);
        if (!validation.valid) {
            CSReporter.warn(`  Syntax Errors: ${validation.errors.join('; ')}`);
        }
    }

    /**
     * Batch process multiple templates
     * Useful for processing entire payload objects
     */
    public static normalizeObject(obj: any): any {
        if (obj === null || obj === undefined) {
            return obj;
        }

        if (typeof obj === 'string') {
            return this.normalizeSyntax(obj);
        }

        if (Array.isArray(obj)) {
            return obj.map(item => this.normalizeObject(item));
        }

        if (typeof obj === 'object') {
            const normalized: any = {};
            for (const [key, value] of Object.entries(obj)) {
                normalized[key] = this.normalizeObject(value);
            }
            return normalized;
        }

        return obj;
    }

    /**
     * Convert Java method call syntax to PTF function syntax
     * Example: ${uuid()} → {{uuid()}}
     * Example: ${now()} → {{now()}}
     */
    public static normalizeFunctionCalls(template: string): string {
        if (!template) {
            return template;
        }

        // Pattern: ${functionName()} → {{functionName()}}
        // Pattern: ${functionName(arg1, arg2)} → {{functionName(arg1, arg2)}}
        return template.replace(/\$\{([a-zA-Z_][a-zA-Z0-9_]*\([^)]*\))\}/g, '{{$1}}');
    }
}
