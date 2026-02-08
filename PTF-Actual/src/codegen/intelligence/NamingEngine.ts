/**
 * NamingEngine - Intelligent Naming Convention Handler
 *
 * Generates proper camelCase, PascalCase names without spaces or invalid characters.
 * Provides context-aware naming for elements, methods, and parameters.
 */

import { Action } from '../types';

export interface ElementNaming {
    propertyName: string;      // camelCase: usernameField
    description: string;       // Human readable: Username input field
    methodPrefix: string;      // For methods: Username
    parameterName: string;     // camelCase for params: username
}

export interface MethodNaming {
    methodName: string;        // camelCase: enterUsername
    stepPattern: string;       // Gherkin: user enters username {string}
    parameterNames: string[];  // ['username']
}

export class NamingEngine {
    // Words that indicate element types
    private static readonly ELEMENT_TYPE_SUFFIXES: Record<string, string> = {
        'textbox': 'Field',
        'password': 'Field',
        'text': 'Field',
        'input': 'Field',
        'button': 'Button',
        'link': 'Link',
        'checkbox': 'Checkbox',
        'radio': 'Radio',
        'combobox': 'Dropdown',
        'listbox': 'Listbox',
        'select': 'Dropdown',
        'option': 'Option',
        'menu': 'Menu',
        'menuitem': 'MenuItem',
        'tab': 'Tab',
        'heading': 'Header',
        'img': 'Image',
        'table': 'Table',
        'row': 'Row',
        'cell': 'Cell',
        'dialog': 'Modal',
        'alert': 'Alert',
    };

    // Words to remove from names (noise words)
    private static readonly NOISE_WORDS = [
        'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
        'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
        'would', 'could', 'should', 'may', 'might', 'must', 'shall',
        'can', 'need', 'dare', 'ought', 'used', 'to', 'of', 'in',
        'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into',
        'through', 'during', 'before', 'after', 'above', 'below',
        'between', 'under', 'again', 'further', 'then', 'once',
    ];

    // Common abbreviations to preserve
    private static readonly ABBREVIATIONS = [
        'ID', 'URL', 'API', 'UI', 'CSS', 'HTML', 'XML', 'JSON',
        'HTTP', 'HTTPS', 'FTP', 'SSH', 'SQL', 'DB', 'CPU', 'AD',
        'ENT', 'SSO', 'AAA', 'LDAP', 'DNS', 'IP', 'TCP', 'UDP',
    ];

    /**
     * Generate element naming from action
     */
    public static generateElementNaming(action: Action, pageContext?: string): ElementNaming {
        const rawName = this.extractRawName(action);
        const elementType = this.detectElementType(action);

        // Clean and format the name
        const cleanedName = this.cleanName(rawName);
        const words = this.splitIntoWords(cleanedName);

        // Generate property name (camelCase with type suffix)
        const propertyName = this.generatePropertyName(words, elementType, pageContext);

        // Generate description
        const description = this.generateDescription(words, elementType);

        // Generate method prefix (for action methods)
        const methodPrefix = this.toPascalCase(words);

        // Generate parameter name
        const parameterName = this.toCamelCase(words);

        return {
            propertyName,
            description,
            methodPrefix,
            parameterName,
        };
    }

    /**
     * Generate method naming from action
     */
    public static generateMethodNaming(action: Action, elementNaming: ElementNaming): MethodNaming {
        const actionVerb = this.getActionVerb(action);
        const words = this.splitIntoWords(elementNaming.methodPrefix);

        // Generate method name
        const methodName = this.toCamelCase([actionVerb, ...words]);

        // Generate step pattern
        const stepPattern = this.generateStepPattern(action, elementNaming);

        // Generate parameter names
        const parameterNames = this.generateParameterNames(action, elementNaming);

        return {
            methodName,
            stepPattern,
            parameterNames,
        };
    }

    /**
     * Extract raw name from action
     */
    private static extractRawName(action: Action): string {
        // Priority 1: aria-label or name from options
        if (action.target?.options?.name) {
            return action.target.options.name;
        }

        // Priority 2: Text content for getByText
        if (action.target?.type === 'getByText') {
            return action.target.selector;
        }

        // Priority 3: Placeholder for getByPlaceholder
        if (action.target?.type === 'getByPlaceholder') {
            return action.target.selector;
        }

        // Priority 4: Role for getByRole
        if (action.target?.type === 'getByRole') {
            return action.target.selector;
        }

        // Priority 5: Extract from CSS/XPath selector
        if (action.target?.selector) {
            return this.extractNameFromSelector(action.target.selector);
        }

        return 'element';
    }

    /**
     * Extract meaningful name from CSS/XPath selector
     */
    private static extractNameFromSelector(selector: string): string {
        // Try ID
        const idMatch = selector.match(/#([a-zA-Z][\w-]*)/);
        if (idMatch) return idMatch[1];

        // Try aria-label
        const ariaMatch = selector.match(/\[aria-label=["']([^"']+)["']\]/);
        if (ariaMatch) return ariaMatch[1];

        // Try data-testid
        const testIdMatch = selector.match(/\[data-testid=["']([^"']+)["']\]/);
        if (testIdMatch) return testIdMatch[1];

        // Try name attribute
        const nameMatch = selector.match(/\[name=["']([^"']+)["']\]/);
        if (nameMatch) return nameMatch[1];

        // Try placeholder
        const placeholderMatch = selector.match(/\[placeholder=["']([^"']+)["']\]/);
        if (placeholderMatch) return placeholderMatch[1];

        // Analyze selector structure for context clues
        const contextName = this.extractContextFromComplexSelector(selector);
        if (contextName) return contextName;

        // Try class name (last meaningful one)
        const classMatches = selector.match(/\.([a-zA-Z][\w-]*)/g);
        if (classMatches && classMatches.length > 0) {
            // Filter out utility classes but extract semantic meaning
            const meaningfulClass = classMatches
                .map(c => c.substring(1))
                .find(c => !c.match(/^(btn|col|row|flex|grid|container|wrapper|css-)/));
            if (meaningfulClass) {
                // For prefixed classes like framework-select-text, extract the semantic part
                return this.extractSemanticFromClassName(meaningfulClass);
            }
        }

        return 'element';
    }

    /**
     * Extract context clues from complex CSS selectors
     * Analyzes selector patterns to determine what kind of element it is
     */
    private static extractContextFromComplexSelector(selector: string): string | null {
        const lowerSelector = selector.toLowerCase();

        // Dropdown/Select patterns
        if (lowerSelector.includes('select') || lowerSelector.includes('dropdown') || lowerSelector.includes('listbox')) {
            if (lowerSelector.includes('icon')) return 'dropdownIcon';
            if (lowerSelector.includes('text')) return 'dropdownText';
            if (lowerSelector.includes('wrapper')) return 'dropdown';
            return 'dropdownSelector';
        }

        // Checkbox patterns
        if (lowerSelector.includes('checkbox')) {
            if (lowerSelector.includes('icon')) return 'checkboxIcon';
            return 'checkbox';
        }

        // Table patterns
        if (lowerSelector.includes('table') || lowerSelector.includes('grid')) {
            if (lowerSelector.includes('row')) return 'tableRow';
            if (lowerSelector.includes('cell')) return 'tableCell';
            if (lowerSelector.includes('icon')) return 'tableIcon';
            return 'tableElement';
        }

        // Form patterns
        if (lowerSelector.includes('input-group') || lowerSelector.includes('form-group')) {
            return 'formField';
        }

        // Icon patterns (standalone)
        if (lowerSelector.includes('icon')) {
            return 'actionIcon';
        }

        // Search patterns
        if (lowerSelector.includes('search')) {
            return 'searchElement';
        }

        // Filter patterns
        if (lowerSelector.includes('filter')) {
            return 'filterElement';
        }

        return null;
    }

    /**
     * Extract semantic meaning from class name
     * Handles prefixed classes like framework-select-text -> selectText
     */
    private static extractSemanticFromClassName(className: string): string {
        // Remove common prefixes
        let cleaned = className.replace(/^(btn-|form-|input-|css-|ng-|v-|el-)/, '');

        // If cleaned is still the same (no prefix removed), return as-is
        if (cleaned === className && cleaned.length > 3) {
            return cleaned;
        }

        // Convert remaining parts to camelCase
        return cleaned
            .split('-')
            .map((word, i) => i === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1))
            .join('');
    }

    /**
     * Detect element type from action
     */
    private static detectElementType(action: Action): string {
        // From role
        if (action.target?.type === 'getByRole') {
            const role = action.target.selector.toLowerCase();
            return this.ELEMENT_TYPE_SUFFIXES[role] || 'Element';
        }

        // From action type
        if (action.type === 'fill' || action.method === 'fill') {
            return 'Field';
        }
        if (action.type === 'click' || action.method === 'click') {
            // Check selector for hints
            const selector = action.target?.selector?.toLowerCase() || '';
            if (selector.includes('button')) return 'Button';
            if (selector.includes('link')) return 'Link';
            if (selector.includes('checkbox')) return 'Checkbox';
            if (selector.includes('radio')) return 'Radio';
            return 'Element';
        }

        return 'Element';
    }

    /**
     * Clean name - remove special characters but preserve word boundaries
     */
    private static cleanName(name: string): string {
        return name
            // Replace special chars with spaces (preserve word boundaries)
            .replace(/[^a-zA-Z0-9\s]/g, ' ')
            // Collapse multiple spaces
            .replace(/\s+/g, ' ')
            .trim();
    }

    /**
     * Split into words, handling camelCase and various separators
     */
    private static splitIntoWords(name: string): string[] {
        return name
            // Insert space before capitals in camelCase
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            // Replace separators with spaces
            .replace(/[-_]+/g, ' ')
            // Split by spaces
            .split(/\s+/)
            // Filter empty and noise words
            .filter(word => word.length > 0 && !this.NOISE_WORDS.includes(word.toLowerCase()))
            // Limit to reasonable length
            .slice(0, 6);
    }

    /**
     * Generate property name with type suffix
     */
    private static generatePropertyName(words: string[], elementType: string, pageContext?: string): string {
        if (words.length === 0) {
            return 'element';
        }

        // Check if type suffix already in words
        const lastWord = words[words.length - 1].toLowerCase();
        const hasTypeSuffix = Object.values(this.ELEMENT_TYPE_SUFFIXES)
            .some(suffix => lastWord === suffix.toLowerCase());

        let finalWords = [...words];
        if (!hasTypeSuffix && elementType !== 'Element') {
            finalWords.push(elementType);
        }

        return this.toCamelCase(finalWords);
    }

    /**
     * Generate human-readable description
     */
    private static generateDescription(words: string[], elementType: string): string {
        const wordStr = words.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
        const typeStr = elementType.toLowerCase();

        // Avoid redundancy like "Login Button button"
        if (wordStr.toLowerCase().includes(typeStr)) {
            return wordStr;
        }

        return `${wordStr} ${typeStr}`;
    }

    /**
     * Get action verb for method naming
     */
    private static getActionVerb(action: Action): string {
        const verbMap: Record<string, string> = {
            'fill': 'enter',
            'type': 'type',
            'click': 'click',
            'dblclick': 'doubleClick',
            'check': 'check',
            'uncheck': 'uncheck',
            'select': 'select',
            'selectOption': 'select',
            'hover': 'hoverOver',
            'focus': 'focusOn',
            'press': 'press',
            'clear': 'clear',
            'goto': 'navigateTo',
            'toBeVisible': 'verify',
            'toContainText': 'verify',
            'toHaveText': 'verify',
            'toHaveValue': 'verify',
        };

        return verbMap[action.method] || action.method;
    }

    /**
     * Generate Gherkin step pattern
     */
    private static generateStepPattern(action: Action, elementNaming: ElementNaming): string {
        const description = elementNaming.description.toLowerCase();

        switch (action.method) {
            case 'fill':
            case 'type':
                return `user enters {string} in ${description}`;
            case 'click':
                return `user clicks ${description}`;
            case 'check':
                return `user checks ${description}`;
            case 'uncheck':
                return `user unchecks ${description}`;
            case 'selectOption':
                return `user selects {string} from ${description}`;
            case 'hover':
                return `user hovers over ${description}`;
            case 'press':
                const key = action.args?.[0] || 'key';
                return `user presses ${key} on ${description}`;
            case 'goto':
                return `user navigates to {string}`;
            case 'toBeVisible':
                return `${description} should be visible`;
            case 'toContainText':
                return `${description} should contain {string}`;
            default:
                return `user performs ${action.method} on ${description}`;
        }
    }

    /**
     * Generate parameter names for method
     */
    private static generateParameterNames(action: Action, elementNaming: ElementNaming): string[] {
        switch (action.method) {
            case 'fill':
            case 'type':
                return [elementNaming.parameterName || 'value'];
            case 'selectOption':
                return ['option'];
            case 'press':
                return ['key'];
            case 'goto':
                return ['url'];
            case 'toContainText':
            case 'toHaveText':
                return ['expectedText'];
            case 'toHaveValue':
                return ['expectedValue'];
            default:
                return [];
        }
    }

    /**
     * Convert words to camelCase
     */
    public static toCamelCase(words: string[]): string {
        if (words.length === 0) return '';

        return words
            .map((word, index) => {
                // Preserve abbreviations
                const upper = word.toUpperCase();
                if (this.ABBREVIATIONS.includes(upper)) {
                    return index === 0 ? upper.toLowerCase() : upper;
                }

                // Normal case conversion
                if (index === 0) {
                    return word.toLowerCase();
                }
                return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
            })
            .join('');
    }

    /**
     * Convert words to PascalCase
     */
    public static toPascalCase(words: string[]): string {
        if (words.length === 0) return '';

        return words
            .map(word => {
                // Preserve abbreviations
                const upper = word.toUpperCase();
                if (this.ABBREVIATIONS.includes(upper)) {
                    return upper;
                }
                return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
            })
            .join('');
    }

    /**
     * Convert string to kebab-case
     */
    public static toKebabCase(str: string): string {
        return str
            .replace(/([a-z])([A-Z])/g, '$1-$2')
            .replace(/[\s_]+/g, '-')
            .toLowerCase();
    }

    /**
     * Sanitize to valid JavaScript identifier
     */
    public static sanitizeIdentifier(name: string): string {
        if (!name) return 'element';

        // Remove invalid characters
        let sanitized = name.replace(/[^a-zA-Z0-9_$]/g, '');

        // Prefix if starts with number
        if (/^\d/.test(sanitized)) {
            sanitized = '_' + sanitized;
        }

        // Ensure not empty
        return sanitized || 'element';
    }

    /**
     * Generate unique name with counter if needed
     */
    public static makeUnique(baseName: string, existingNames: Set<string>): string {
        if (!existingNames.has(baseName)) {
            return baseName;
        }

        let counter = 2;
        let uniqueName = `${baseName}${counter}`;
        while (existingNames.has(uniqueName)) {
            counter++;
            uniqueName = `${baseName}${counter}`;
        }

        return uniqueName;
    }
}

export default NamingEngine;
