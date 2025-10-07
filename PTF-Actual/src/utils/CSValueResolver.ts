import { CSEncryptionUtil } from './CSEncryptionUtil';
import { CSReporter } from '../reporter/CSReporter';

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
                }
            }

            return varValue !== undefined ? String(varValue) : value;
        }

        // Handle {{variableName}} and special prefixed formats
        return value.replace(/\{\{([^}]+)\}\}/g, (match, expression) => {
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

        // Check for variables
        if (value.startsWith('$') || value.includes('{{')) {
            return true;
        }

        return false;
    }
}