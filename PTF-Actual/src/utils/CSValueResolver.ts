import { CSEncryptionUtil } from './CSEncryptionUtil';
import { CSReporter } from '../reporter/CSReporter';
import { CSConfigurationManager } from '../core/CSConfigurationManager';
import { CSSecretMasker } from './CSSecretMasker';

/**
 * Utility class for resolving values with support for:
 * - Variable substitution ({{variable}} and $variable formats)
 * - Automatic decryption of encrypted values
 * - Context variable resolution
 */
export class CSValueResolver {
    private static encryptionUtil = CSEncryptionUtil.getInstance();

    /**
     * Resolves a value by performing:
     * 1. Decryption if the value is encrypted
     * 2. Variable substitution from context
     *
     * @param value The value to resolve
     * @param context Optional context containing variables for substitution
     * @returns The resolved value
     */
    public static resolve(value: string, context?: { getVariable: (key: string) => any }): string {
        if (!value || typeof value !== 'string') {
            return value;
        }

        // Step 1: Decrypt if value is encrypted
        let resolvedValue = value;
        if (this.encryptionUtil.isEncrypted(value)) {
            const decrypted = this.encryptionUtil.decrypt(value);
            if (decrypted) {
                CSReporter.debug(`Value decrypted successfully`);
                resolvedValue = decrypted;
                // Register decrypted value for masking in reports
                CSSecretMasker.getInstance().registerDecryptedValue(decrypted);
            } else {
                CSReporter.warn(`Failed to decrypt value, using original`);
            }
        }

        // Step 2: Perform variable substitution if context is provided
        if (context) {
            resolvedValue = this.substituteVariables(resolvedValue, context);
        }

        return resolvedValue;
    }

    /**
     * Performs variable substitution in the value
     * Supports multiple formats:
     * - {{variableName}} - Context variables (test data)
     * - {scenario:variableName} - Scenario context variables (single curly brace format)
     * - {config:CONFIG_KEY} - Configuration values (single curly brace format)
     * - $variableName - Context variables (alternative syntax)
     * - {{config:CONFIG_KEY}} - Configuration values
     * - {{env:ENV_VAR}} - Environment variables
     */
    private static substituteVariables(value: string, context: { getVariable: (key: string) => any }): string {
        if (!value || !context) return value;

        // Handle $variableName format (context variables only)
        if (value.startsWith('$')) {
            const varName = value.substring(1);
            let varValue = context.getVariable(varName);

            // Check if the variable value itself is encrypted
            if (varValue && typeof varValue === 'string' && this.encryptionUtil.isEncrypted(varValue)) {
                const decrypted = this.encryptionUtil.decrypt(varValue);
                if (decrypted) {
                    varValue = decrypted;
                    // Register decrypted value for masking in reports
                    CSSecretMasker.getInstance().registerDecryptedValue(decrypted);
                }
            }

            return varValue !== undefined ? String(varValue) : value;
        }

        // Handle {scenario:variableName}, {config:KEY}, {env:KEY}, {context:var.field} format (single curly braces)
        // This format is commonly used in Gherkin feature files
        let resolvedValue = value.replace(/\{(scenario|config|env|context):([^}]+)\}/g, (match, prefix, varName) => {
            let varValue: any;

            if (prefix === 'context') {
                // {context:varName.fieldName} - Nested property access with normalized column lookup
                // {context:varName} (no dot) - Same as {scenario:varName}
                const dotIndex = varName.indexOf('.');
                if (dotIndex === -1) {
                    // No dot → same as scenario variable
                    varValue = context.getVariable(varName.trim());
                } else {
                    // Dot notation → nested property access
                    const contextVarName = varName.substring(0, dotIndex).trim();
                    const fieldPath = varName.substring(dotIndex + 1).trim();
                    const contextObj = context.getVariable(contextVarName);

                    if (contextObj && typeof contextObj === 'object') {
                        // Lazy-require to avoid circular dependencies at module load time
                        const { CSAIColumnNormalizer } = require('../ai/step-engine/CSAIColumnNormalizer');

                        if (Array.isArray(contextObj)) {
                            // Array of rows → get field from first row
                            varValue = contextObj.length > 0
                                ? CSAIColumnNormalizer.getField(contextObj[0], fieldPath)
                                : undefined;
                        } else if (contextObj.rows && Array.isArray(contextObj.rows)) {
                            // ResultSet-like object → get field from first row
                            varValue = contextObj.rows.length > 0
                                ? CSAIColumnNormalizer.getField(contextObj.rows[0], fieldPath)
                                : undefined;
                        } else {
                            // Plain object → direct field lookup with normalized matching
                            varValue = CSAIColumnNormalizer.getField(contextObj, fieldPath);
                        }
                    }
                }
            } else if (prefix === 'scenario') {
                // {scenario:KEY} - Get from scenario context (same as regular variable)
                varValue = context.getVariable(varName.trim());
            } else if (prefix === 'config') {
                // {config:KEY} - Get from configuration
                varValue = context.getVariable(`__config_${varName.trim()}`);
            } else if (prefix === 'env') {
                // {env:KEY} - Get from environment variables
                varValue = context.getVariable(`__env_${varName.trim()}`);
            }

            // Check if the variable value itself is encrypted
            if (varValue && typeof varValue === 'string' && this.encryptionUtil.isEncrypted(varValue)) {
                const decrypted = this.encryptionUtil.decrypt(varValue);
                if (decrypted) {
                    varValue = decrypted;
                    // Register decrypted value for masking in reports
                    CSSecretMasker.getInstance().registerDecryptedValue(decrypted);
                }
            }

            // Handle unresolved scenario variables
            if (varValue !== undefined) {
                return String(varValue);
            }

            // Variable not found - check strict mode (only for scenario variables)
            if (prefix === 'scenario') {
                const config = CSConfigurationManager.getInstance();
                const strictMode = config.getBoolean('STRICT_SCENARIO_VARIABLES', false);
                if (strictMode) {
                    throw new Error(`[STRICT MODE] Scenario variable "${varName.trim()}" not found in context. Ensure it is set before use.`);
                }
                CSReporter.warn(`[VARIABLE WARNING] Scenario variable "${varName.trim()}" not found in context - returning empty string instead of "${match}"`);
                return '';  // Return empty instead of the unresolved pattern
            }

            return match;  // For config/env, return original match (backward compatible)
        });

        // Handle {{variableName}} and special prefixed formats (double curly braces)
        return resolvedValue.replace(/\{\{([^}]+)\}\}/g, (match, expression) => {
            let varValue: any;

            // Check for special prefixes
            if (expression.startsWith('config:')) {
                // {{config:KEY}} - Get from configuration
                const configKey = expression.substring(7);
                varValue = context.getVariable(`__config_${configKey}`);
            } else if (expression.startsWith('env:')) {
                // {{env:KEY}} - Get from environment variables
                const envKey = expression.substring(4);
                varValue = context.getVariable(`__env_${envKey}`);
            } else {
                // Regular context variable
                varValue = context.getVariable(expression);
            }

            // Check if the variable value itself is encrypted
            if (varValue && typeof varValue === 'string' && this.encryptionUtil.isEncrypted(varValue)) {
                const decrypted = this.encryptionUtil.decrypt(varValue);
                if (decrypted) {
                    varValue = decrypted;
                    // Register decrypted value for masking in reports
                    CSSecretMasker.getInstance().registerDecryptedValue(decrypted);
                }
            }

            return varValue !== undefined ? String(varValue) : match;
        });
    }

    /**
     * Resolves an object by decrypting all string values
     */
    public static resolveObject<T extends Record<string, any>>(obj: T, context?: { getVariable: (key: string) => any }): T {
        if (!obj || typeof obj !== 'object') {
            return obj;
        }

        const resolved: any = Array.isArray(obj) ? [] : {};

        for (const [key, value] of Object.entries(obj)) {
            if (typeof value === 'string') {
                resolved[key] = this.resolve(value, context);
            } else if (typeof value === 'object' && value !== null) {
                resolved[key] = this.resolveObject(value, context);
            } else {
                resolved[key] = value;
            }
        }

        return resolved as T;
    }

    /**
     * Batch resolve multiple values
     */
    public static resolveMultiple(values: string[], context?: { getVariable: (key: string) => any }): string[] {
        return values.map(value => this.resolve(value, context));
    }

    /**
     * Check if a value needs resolution (contains variables or is encrypted)
     */
    public static needsResolution(value: string): boolean {
        if (!value || typeof value !== 'string') {
            return false;
        }

        // Check for encryption
        if (this.encryptionUtil.isEncrypted(value)) {
            return true;
        }

        // Check for variables (all supported formats)
        if (value.startsWith('$') || value.includes('{{')) {
            return true;
        }

        // Check for {scenario:...}, {config:...}, {env:...}, {context:...} formats
        if (/\{(scenario|config|env|context):[^}]+\}/.test(value)) {
            return true;
        }

        return false;
    }
}