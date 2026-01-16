/**
 * CS Playwright Test Framework - Secret Masker Utility
 *
 * Masks sensitive values in logs, reports, and output to prevent
 * accidental exposure of passwords, tokens, API keys, and other secrets.
 *
 * Features:
 * - Tracks decrypted values and masks them in output
 * - Pattern-based detection for sensitive field names
 * - Configurable masking character and visibility
 * - Thread-safe singleton pattern
 */

import { CSConfigurationManager } from '../core/CSConfigurationManager';

/**
 * Patterns that indicate a field contains sensitive data
 */
const SENSITIVE_FIELD_PATTERNS = [
    /password/i,
    /passwd/i,
    /secret/i,
    /token/i,
    /api[_-]?key/i,
    /apikey/i,
    /auth[_-]?key/i,
    /access[_-]?key/i,
    /private[_-]?key/i,
    /credentials?/i,
    /bearer/i,
    /authorization/i,
    /pat$/i,                    // Personal Access Token
    /ssh[_-]?key/i,
    /client[_-]?secret/i,
    /encryption[_-]?key/i,
    /signing[_-]?key/i,
    /connection[_-]?string/i,
    /db[_-]?password/i,
    /database[_-]?password/i
];

/**
 * Values that should always be masked regardless of field name
 */
const SENSITIVE_VALUE_PATTERNS = [
    /^ENCRYPTED:/,              // Encrypted values (shouldn't be decrypted and shown)
    /^Bearer\s+[A-Za-z0-9\-._~+\/]+=*/i,  // Bearer tokens
    /^Basic\s+[A-Za-z0-9+\/]+=*/i,         // Basic auth
    /^[A-Fa-f0-9]{32,}$/,       // Long hex strings (API keys, tokens)
    /^eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]*$/  // JWT tokens
];

export interface MaskingOptions {
    /** Masking character to use (default: '*') */
    maskChar?: string;
    /** Number of visible characters at start (default: 0) */
    visibleStart?: number;
    /** Number of visible characters at end (default: 0) */
    visibleEnd?: number;
    /** Minimum value length to mask (default: 1) */
    minLength?: number;
    /** Mask pattern: 'full' | 'partial' | 'fixed' (default: 'full') */
    pattern?: 'full' | 'partial' | 'fixed';
    /** Fixed mask length for 'fixed' pattern (default: 8) */
    fixedLength?: number;
}

export class CSSecretMasker {
    private static instance: CSSecretMasker;

    /** Set of known decrypted values to mask */
    private decryptedValues: Set<string> = new Set();

    /** Map of field names to their decrypted values for targeted masking */
    private sensitiveFields: Map<string, string> = new Map();

    /** Custom patterns registered at runtime */
    private customPatterns: RegExp[] = [];

    /** Default masking options */
    private defaultOptions: MaskingOptions = {
        maskChar: '*',
        visibleStart: 0,
        visibleEnd: 0,
        minLength: 1,
        pattern: 'full',
        fixedLength: 8
    };

    /** Whether masking is enabled */
    private enabled: boolean = true;

    private constructor() {
        // Load configuration
        try {
            const config = CSConfigurationManager.getInstance();
            this.enabled = config.getBoolean('SECRET_MASKING_ENABLED', true);

            const maskChar = config.get('SECRET_MASK_CHAR', '*');
            if (maskChar && maskChar.length === 1) {
                this.defaultOptions.maskChar = maskChar;
            }

            this.defaultOptions.visibleStart = config.getNumber('SECRET_VISIBLE_START', 0);
            this.defaultOptions.visibleEnd = config.getNumber('SECRET_VISIBLE_END', 0);
        } catch {
            // Config not available, use defaults
        }
    }

    public static getInstance(): CSSecretMasker {
        if (!CSSecretMasker.instance) {
            CSSecretMasker.instance = new CSSecretMasker();
        }
        return CSSecretMasker.instance;
    }

    /**
     * Register a decrypted value to be masked in all output
     * Called automatically by CSValueResolver when decrypting
     */
    public registerDecryptedValue(value: string): void {
        if (value && value.length >= (this.defaultOptions.minLength || 1)) {
            this.decryptedValues.add(value);
        }
    }

    /**
     * Register a sensitive field with its value
     * @param fieldName The field name (e.g., 'password', 'apiKey')
     * @param value The sensitive value
     */
    public registerSensitiveField(fieldName: string, value: string): void {
        if (fieldName && value) {
            this.sensitiveFields.set(fieldName.toLowerCase(), value);
            this.decryptedValues.add(value);
        }
    }

    /**
     * Register a custom pattern for sensitive field detection
     */
    public registerCustomPattern(pattern: RegExp): void {
        this.customPatterns.push(pattern);
    }

    /**
     * Check if a field name indicates sensitive data
     */
    public isSensitiveFieldName(fieldName: string): boolean {
        if (!fieldName) return false;

        const lowerName = fieldName.toLowerCase();

        // Check built-in patterns
        for (const pattern of SENSITIVE_FIELD_PATTERNS) {
            if (pattern.test(lowerName)) {
                return true;
            }
        }

        // Check custom patterns
        for (const pattern of this.customPatterns) {
            if (pattern.test(lowerName)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Check if a value looks like a secret based on its format
     */
    public isSensitiveValue(value: string): boolean {
        if (!value || typeof value !== 'string') return false;

        for (const pattern of SENSITIVE_VALUE_PATTERNS) {
            if (pattern.test(value)) {
                return true;
            }
        }

        // Check if it's a registered decrypted value
        return this.decryptedValues.has(value);
    }

    /**
     * Mask a sensitive value
     */
    public mask(value: string, options?: MaskingOptions): string {
        if (!this.enabled || !value || typeof value !== 'string') {
            return value;
        }

        const opts = { ...this.defaultOptions, ...options };
        const len = value.length;

        if (len < (opts.minLength || 1)) {
            return value;
        }

        switch (opts.pattern) {
            case 'fixed':
                return opts.maskChar!.repeat(opts.fixedLength || 8);

            case 'partial':
                const start = value.substring(0, opts.visibleStart || 0);
                const end = value.substring(len - (opts.visibleEnd || 0));
                const maskLen = Math.max(1, len - (opts.visibleStart || 0) - (opts.visibleEnd || 0));
                return start + opts.maskChar!.repeat(maskLen) + end;

            case 'full':
            default:
                return opts.maskChar!.repeat(len);
        }
    }

    /**
     * Mask a value if it's a registered secret or matches patterns
     */
    public maskIfSecret(value: string, fieldName?: string): string {
        if (!this.enabled || !value || typeof value !== 'string') {
            return value;
        }

        // Check if field name indicates sensitive data
        if (fieldName && this.isSensitiveFieldName(fieldName)) {
            return this.mask(value);
        }

        // Check if value is a registered decrypted value
        if (this.decryptedValues.has(value)) {
            return this.mask(value);
        }

        // Check if value looks like a secret
        if (this.isSensitiveValue(value)) {
            return this.mask(value);
        }

        return value;
    }

    /**
     * Mask all registered secrets in a string
     * Useful for masking secrets in log messages or report text
     */
    public maskSecretsInText(text: string): string {
        if (!this.enabled || !text || typeof text !== 'string') {
            return text;
        }

        let result = text;

        // Sort by length descending to mask longer secrets first
        // This prevents partial masking issues
        const sortedSecrets = Array.from(this.decryptedValues)
            .filter(s => s && s.length > 0)
            .sort((a, b) => b.length - a.length);

        for (const secret of sortedSecrets) {
            if (result.includes(secret)) {
                result = result.split(secret).join(this.mask(secret));
            }
        }

        return result;
    }

    /**
     * Mask secrets in an object (deep)
     * Useful for masking test data before display in reports
     */
    public maskSecretsInObject<T extends Record<string, any>>(obj: T): T {
        if (!this.enabled || !obj || typeof obj !== 'object') {
            return obj;
        }

        const result: any = Array.isArray(obj) ? [] : {};

        for (const [key, value] of Object.entries(obj)) {
            if (typeof value === 'string') {
                result[key] = this.maskIfSecret(value, key);
            } else if (typeof value === 'object' && value !== null) {
                result[key] = this.maskSecretsInObject(value);
            } else {
                result[key] = value;
            }
        }

        return result as T;
    }

    /**
     * Mask values in a data row based on field names and registered secrets
     * Specifically designed for test data table masking in reports
     */
    public maskDataRow(headers: string[], values: string[]): string[] {
        if (!this.enabled) {
            return values;
        }

        return values.map((value, index) => {
            const header = headers[index] || '';
            return this.maskIfSecret(value, header);
        });
    }

    /**
     * Clear all registered secrets
     * Call this between test runs to prevent memory leaks
     */
    public clear(): void {
        this.decryptedValues.clear();
        this.sensitiveFields.clear();
    }

    /**
     * Get count of registered secrets (for debugging)
     */
    public getSecretCount(): number {
        return this.decryptedValues.size;
    }

    /**
     * Enable or disable masking
     */
    public setEnabled(enabled: boolean): void {
        this.enabled = enabled;
    }

    /**
     * Check if masking is enabled
     */
    public isEnabled(): boolean {
        return this.enabled;
    }

    /**
     * Update default masking options
     */
    public setDefaultOptions(options: Partial<MaskingOptions>): void {
        this.defaultOptions = { ...this.defaultOptions, ...options };
    }
}

/**
 * Convenience function to get the singleton instance
 */
export function getSecretMasker(): CSSecretMasker {
    return CSSecretMasker.getInstance();
}

/**
 * Convenience function to mask a value if it's a secret
 */
export function maskSecret(value: string, fieldName?: string): string {
    return CSSecretMasker.getInstance().maskIfSecret(value, fieldName);
}

/**
 * Convenience function to mask all secrets in a string
 */
export function maskSecretsInText(text: string): string {
    return CSSecretMasker.getInstance().maskSecretsInText(text);
}

/**
 * Convenience function to register a decrypted value
 */
export function registerDecryptedSecret(value: string): void {
    CSSecretMasker.getInstance().registerDecryptedValue(value);
}
