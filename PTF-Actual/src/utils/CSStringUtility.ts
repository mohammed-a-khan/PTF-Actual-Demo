// src/utils/CSStringUtility.ts

/**
 * Comprehensive String Utility Class
 * Provides extensive string manipulation, validation, transformation, and comparison methods
 */
export class CSStringUtility {

    // ===============================
    // CASE CONVERSION
    // ===============================

    /**
     * Convert string to camelCase
     * Example: "hello world" -> "helloWorld"
     */
    static toCamelCase(str: string): string {
        return str.replace(/(?:^\w|[A-Z]|\b\w)/g, (word, index) => {
            return index === 0 ? word.toLowerCase() : word.toUpperCase();
        }).replace(/\s+/g, '');
    }

    /**
     * Convert string to PascalCase
     * Example: "hello world" -> "HelloWorld"
     */
    static toPascalCase(str: string): string {
        return str.replace(/(?:^\w|[A-Z]|\b\w)/g, word => word.toUpperCase()).replace(/\s+/g, '');
    }

    /**
     * Convert string to snake_case
     * Example: "helloWorld" -> "hello_world"
     */
    static toSnakeCase(str: string): string {
        return str.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');
    }

    /**
     * Convert string to kebab-case
     * Example: "helloWorld" -> "hello-world"
     */
    static toKebabCase(str: string): string {
        return str.replace(/([A-Z])/g, '-$1').toLowerCase().replace(/^-/, '');
    }

    /**
     * Convert string to CONSTANT_CASE
     * Example: "helloWorld" -> "HELLO_WORLD"
     */
    static toConstantCase(str: string): string {
        return this.toSnakeCase(str).toUpperCase();
    }

    /**
     * Convert string to Title Case
     * Example: "hello world" -> "Hello World"
     */
    static toTitleCase(str: string): string {
        return str.replace(/\w\S*/g, txt => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase());
    }

    /**
     * Convert string to Sentence case
     * Example: "HELLO WORLD" -> "Hello world"
     */
    static toSentenceCase(str: string): string {
        return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
    }

    // ===============================
    // STRING VALIDATION
    // ===============================

    /**
     * Check if string is empty or null/undefined
     */
    static isEmpty(str: string | null | undefined): boolean {
        return !str || str.trim().length === 0;
    }

    /**
     * Check if string is not empty
     */
    static isNotEmpty(str: string | null | undefined): boolean {
        return !this.isEmpty(str);
    }

    /**
     * Check if string is a valid email
     */
    static isEmail(str: string): boolean {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(str);
    }

    /**
     * Check if string is a valid URL
     */
    static isUrl(str: string): boolean {
        try {
            new URL(str);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Check if string is a valid JSON
     */
    static isJSON(str: string): boolean {
        try {
            JSON.parse(str);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Check if string is numeric
     */
    static isNumeric(str: string): boolean {
        return !isNaN(Number(str)) && !isNaN(parseFloat(str));
    }

    /**
     * Check if string is alphanumeric
     */
    static isAlphanumeric(str: string): boolean {
        return /^[a-zA-Z0-9]+$/.test(str);
    }

    /**
     * Check if string contains only alphabetic characters
     */
    static isAlpha(str: string): boolean {
        return /^[a-zA-Z]+$/.test(str);
    }

    /**
     * Check if string is a valid phone number (flexible format)
     */
    static isPhoneNumber(str: string): boolean {
        const phoneRegex = /^[\+]?[(]?[0-9]{1,4}[)]?[-\s\.]?[(]?[0-9]{1,4}[)]?[-\s\.]?[0-9]{1,9}$/;
        return phoneRegex.test(str);
    }

    /**
     * Check if string matches a pattern
     */
    static matches(str: string, pattern: string | RegExp): boolean {
        const regex = typeof pattern === 'string' ? new RegExp(pattern) : pattern;
        return regex.test(str);
    }

    // ===============================
    // STRING MANIPULATION
    // ===============================

    /**
     * Truncate string to specified length with ellipsis
     */
    static truncate(str: string, length: number, suffix: string = '...'): string {
        if (str.length <= length) return str;
        return str.substring(0, length - suffix.length) + suffix;
    }

    /**
     * Pad string to specified length
     */
    static pad(str: string, length: number, char: string = ' ', padLeft: boolean = false): string {
        const padding = char.repeat(Math.max(0, length - str.length));
        return padLeft ? padding + str : str + padding;
    }

    /**
     * Remove all whitespace from string
     */
    static removeWhitespace(str: string): string {
        return str.replace(/\s+/g, '');
    }

    /**
     * Remove extra whitespace (multiple spaces to single)
     */
    static normalizeWhitespace(str: string): string {
        return str.replace(/\s+/g, ' ').trim();
    }

    /**
     * Reverse string
     */
    static reverse(str: string): string {
        return str.split('').reverse().join('');
    }

    /**
     * Repeat string n times
     */
    static repeat(str: string, count: number, separator: string = ''): string {
        return Array(count).fill(str).join(separator);
    }

    /**
     * Replace all occurrences of a substring
     */
    static replaceAll(str: string, search: string | RegExp, replace: string): string {
        const regex = typeof search === 'string' ? new RegExp(search, 'g') : search;
        return str.replace(regex, replace);
    }

    /**
     * Insert substring at specified position
     */
    static insert(str: string, index: number, insert: string): string {
        return str.slice(0, index) + insert + str.slice(index);
    }

    /**
     * Remove substring from string
     */
    static remove(str: string, toRemove: string): string {
        return str.split(toRemove).join('');
    }

    /**
     * Extract substring between two delimiters
     */
    static extractBetween(str: string, start: string, end: string): string | null {
        const startIndex = str.indexOf(start);
        if (startIndex === -1) return null;

        const endIndex = str.indexOf(end, startIndex + start.length);
        if (endIndex === -1) return null;

        return str.substring(startIndex + start.length, endIndex);
    }

    /**
     * Extract all substrings between delimiters
     */
    static extractAllBetween(str: string, start: string, end: string): string[] {
        const results: string[] = [];
        let currentIndex = 0;

        while (true) {
            const startIndex = str.indexOf(start, currentIndex);
            if (startIndex === -1) break;

            const endIndex = str.indexOf(end, startIndex + start.length);
            if (endIndex === -1) break;

            results.push(str.substring(startIndex + start.length, endIndex));
            currentIndex = endIndex + end.length;
        }

        return results;
    }

    // ===============================
    // STRING COMPARISON
    // ===============================

    /**
     * Case-insensitive string comparison
     */
    static equalsIgnoreCase(str1: string, str2: string): boolean {
        return str1.toLowerCase() === str2.toLowerCase();
    }

    /**
     * Check if string contains substring (case-insensitive)
     */
    static containsIgnoreCase(str: string, substring: string): boolean {
        return str.toLowerCase().includes(substring.toLowerCase());
    }

    /**
     * Check if string starts with prefix (case-insensitive)
     */
    static startsWithIgnoreCase(str: string, prefix: string): boolean {
        return str.toLowerCase().startsWith(prefix.toLowerCase());
    }

    /**
     * Check if string ends with suffix (case-insensitive)
     */
    static endsWithIgnoreCase(str: string, suffix: string): boolean {
        return str.toLowerCase().endsWith(suffix.toLowerCase());
    }

    /**
     * Calculate Levenshtein distance (edit distance) between two strings
     */
    static levenshteinDistance(str1: string, str2: string): number {
        const matrix: number[][] = [];

        for (let i = 0; i <= str2.length; i++) {
            matrix[i] = [i];
        }

        for (let j = 0; j <= str1.length; j++) {
            matrix[0][j] = j;
        }

        for (let i = 1; i <= str2.length; i++) {
            for (let j = 1; j <= str1.length; j++) {
                if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
                    matrix[i][j] = matrix[i - 1][j - 1];
                } else {
                    matrix[i][j] = Math.min(
                        matrix[i - 1][j - 1] + 1,
                        matrix[i][j - 1] + 1,
                        matrix[i - 1][j] + 1
                    );
                }
            }
        }

        return matrix[str2.length][str1.length];
    }

    /**
     * Calculate similarity percentage between two strings (0-100)
     */
    static similarity(str1: string, str2: string): number {
        const distance = this.levenshteinDistance(str1, str2);
        const maxLength = Math.max(str1.length, str2.length);
        if (maxLength === 0) return 100;
        return ((maxLength - distance) / maxLength) * 100;
    }

    // ===============================
    // STRING PARSING & EXTRACTION
    // ===============================

    /**
     * Extract numbers from string
     */
    static extractNumbers(str: string): number[] {
        const matches = str.match(/-?\d+\.?\d*/g);
        return matches ? matches.map(Number) : [];
    }

    /**
     * Extract emails from string
     */
    static extractEmails(str: string): string[] {
        const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
        return str.match(emailRegex) || [];
    }

    /**
     * Extract URLs from string
     */
    static extractUrls(str: string): string[] {
        const urlRegex = /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/g;
        return str.match(urlRegex) || [];
    }

    /**
     * Extract words from string
     */
    static extractWords(str: string): string[] {
        return str.match(/\b\w+\b/g) || [];
    }

    /**
     * Count occurrences of substring in string
     */
    static countOccurrences(str: string, substring: string): number {
        return (str.match(new RegExp(substring, 'g')) || []).length;
    }

    /**
     * Get character frequency map
     */
    static charFrequency(str: string): Map<string, number> {
        const freq = new Map<string, number>();
        for (const char of str) {
            freq.set(char, (freq.get(char) || 0) + 1);
        }
        return freq;
    }

    // ===============================
    // STRING ENCODING & HASHING
    // ===============================

    /**
     * Convert string to Base64
     */
    static toBase64(str: string): string {
        return Buffer.from(str, 'utf8').toString('base64');
    }

    /**
     * Decode Base64 string
     */
    static fromBase64(str: string): string {
        return Buffer.from(str, 'base64').toString('utf8');
    }

    /**
     * Convert string to hexadecimal
     */
    static toHex(str: string): string {
        return Buffer.from(str, 'utf8').toString('hex');
    }

    /**
     * Decode hexadecimal string
     */
    static fromHex(str: string): string {
        return Buffer.from(str, 'hex').toString('utf8');
    }

    /**
     * Generate MD5 hash of string
     */
    static md5(str: string): string {
        const crypto = require('crypto');
        return crypto.createHash('md5').update(str).digest('hex');
    }

    /**
     * Generate SHA256 hash of string
     */
    static sha256(str: string): string {
        const crypto = require('crypto');
        return crypto.createHash('sha256').update(str).digest('hex');
    }

    // ===============================
    // STRING FORMATTING
    // ===============================

    /**
     * Format string with template replacement
     * Example: format("Hello {0}, you are {1} years old", "John", 25)
     */
    static format(template: string, ...args: any[]): string {
        return template.replace(/{(\d+)}/g, (match, index) => {
            return typeof args[index] !== 'undefined' ? String(args[index]) : match;
        });
    }

    /**
     * Format string with named placeholders
     * Example: formatNamed("Hello {name}, you are {age} years old", {name: "John", age: 25})
     */
    static formatNamed(template: string, data: Record<string, any>): string {
        return template.replace(/{([^}]+)}/g, (match, key) => {
            return typeof data[key] !== 'undefined' ? String(data[key]) : match;
        });
    }

    /**
     * Pluralize word based on count
     */
    static pluralize(count: number, singular: string, plural?: string): string {
        if (count === 1) return singular;
        return plural || singular + 's';
    }

    /**
     * Mask string (for sensitive data)
     * Example: mask("1234567890", 4, 4, "*") -> "1234**7890"
     */
    static mask(str: string, visibleStart: number = 0, visibleEnd: number = 0, maskChar: string = '*'): string {
        if (str.length <= visibleStart + visibleEnd) return str;

        const start = str.slice(0, visibleStart);
        const end = str.slice(-visibleEnd);
        const masked = maskChar.repeat(str.length - visibleStart - visibleEnd);

        return start + masked + end;
    }

    /**
     * Slugify string (URL-friendly)
     * Example: "Hello World!" -> "hello-world"
     */
    static slugify(str: string): string {
        return str
            .toLowerCase()
            .trim()
            .replace(/[^\w\s-]/g, '')
            .replace(/[\s_-]+/g, '-')
            .replace(/^-+|-+$/g, '');
    }

    /**
     * Escape HTML special characters
     */
    static escapeHtml(str: string): string {
        const htmlEscapes: Record<string, string> = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        };
        return str.replace(/[&<>"']/g, char => htmlEscapes[char]);
    }

    /**
     * Unescape HTML special characters
     */
    static unescapeHtml(str: string): string {
        const htmlUnescapes: Record<string, string> = {
            '&amp;': '&',
            '&lt;': '<',
            '&gt;': '>',
            '&quot;': '"',
            '&#39;': "'"
        };
        return str.replace(/&(?:amp|lt|gt|quot|#39);/g, entity => htmlUnescapes[entity]);
    }

    /**
     * Escape regular expression special characters
     */
    static escapeRegExp(str: string): string {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /**
     * Word wrap text to specified width
     */
    static wordWrap(str: string, width: number = 80): string {
        const regex = new RegExp(`.{1,${width}}(\\s|$)`, 'g');
        return str.match(regex)?.join('\n') || str;
    }

    /**
     * Generate random string
     */
    static random(length: number = 10, charset: string = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'): string {
        let result = '';
        for (let i = 0; i < length; i++) {
            result += charset.charAt(Math.floor(Math.random() * charset.length));
        }
        return result;
    }

    /**
     * Generate UUID v4
     */
    static uuid(): string {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }
}
