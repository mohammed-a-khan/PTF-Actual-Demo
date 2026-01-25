/**
 * DOM Discovery Engine
 * Discovers all interactive elements on a page using real Playwright APIs
 *
 * @module DOMDiscoveryEngine
 */

import { Page, ElementHandle, Locator } from 'playwright';
import * as crypto from 'crypto';
import {
    InteractiveElement,
    FormDescriptor,
    TableDescriptor,
    ModalDescriptor,
    ElementType,
    ElementPurpose,
    FieldType,
    LocatorStrategy,
    BoundingBox,
} from './types';

export interface DiscoveryOptions {
    includeHidden?: boolean;
    includeDisabled?: boolean;
    maxElements?: number;
    timeout?: number;
    /** Use accessibility tree instead of DOM scraping (recommended for AI-driven testing) */
    useAccessibility?: boolean;
}

export interface AccessibilityNode {
    role: string;
    name?: string;
    value?: string;
    description?: string;
    keyshortcuts?: string;
    roledescription?: string;
    valuetext?: string;
    disabled?: boolean;
    expanded?: boolean;
    focused?: boolean;
    modal?: boolean;
    multiline?: boolean;
    multiselectable?: boolean;
    readonly?: boolean;
    required?: boolean;
    selected?: boolean;
    checked?: boolean | 'mixed';
    pressed?: boolean | 'mixed';
    level?: number;
    valuemin?: number;
    valuemax?: number;
    autocomplete?: string;
    haspopup?: string;
    invalid?: string;
    orientation?: string;
    children?: AccessibilityNode[];
}

export class DOMDiscoveryEngine {
    private page: Page | null = null;

    /**
     * Set the page to analyze
     */
    setPage(page: Page): void {
        this.page = page;
    }

    /**
     * Discover all interactive elements on the page
     * Uses accessibility tree by default (recommended), falls back to DOM scraping
     */
    async discoverElements(options: DiscoveryOptions = {}): Promise<InteractiveElement[]> {
        if (!this.page) {
            throw new Error('Page not set. Call setPage() first.');
        }

        const {
            includeHidden = false,
            includeDisabled = false,
            maxElements = 500,
            timeout = 30000,
            useAccessibility = true, // Default to accessibility-based discovery
        } = options;

        // Use accessibility tree if requested (recommended for AI-driven testing)
        if (useAccessibility) {
            try {
                return await this.discoverElementsFromAccessibility(options);
            } catch (error) {
                console.warn('Accessibility discovery failed, falling back to DOM scraping:', error);
                // Fall through to DOM-based discovery
            }
        }

        const elements: InteractiveElement[] = [];

        // Define selectors for interactive elements
        const interactiveSelectors = [
            'button',
            'a[href]',
            'input:not([type="hidden"])',
            'textarea',
            'select',
            '[role="button"]',
            '[role="link"]',
            '[role="checkbox"]',
            '[role="radio"]',
            '[role="switch"]',
            '[role="tab"]',
            '[role="menuitem"]',
            '[role="option"]',
            '[onclick]',
            '[ng-click]',
            '[@click]',
            '[data-action]',
            '[data-testid]',
            '[data-cy]',
            '[data-test]',
        ];

        const selector = interactiveSelectors.join(', ');

        try {
            // Wait for page to be stable
            await this.page.waitForLoadState('domcontentloaded', { timeout });

            // Get all interactive elements
            const handles = await this.page.$$(selector);

            for (let i = 0; i < Math.min(handles.length, maxElements); i++) {
                const handle = handles[i];

                try {
                    const element = await this.analyzeElement(handle, includeHidden, includeDisabled);
                    if (element) {
                        elements.push(element);
                    }
                } catch (e) {
                    // Element may have been removed from DOM, skip it
                    continue;
                }
            }

            return elements;
        } catch (error) {
            console.error('Error discovering elements:', error);
            return elements;
        }
    }

    /**
     * Discover elements using the accessibility tree (recommended approach)
     * This is how the official Playwright MCP "sees" pages - much better for AI-driven testing
     */
    async discoverElementsFromAccessibility(options: DiscoveryOptions = {}): Promise<InteractiveElement[]> {
        if (!this.page) {
            throw new Error('Page not set. Call setPage() first.');
        }

        const {
            includeDisabled = false,
            maxElements = 500,
        } = options;

        // Get accessibility snapshot (using page as any to access accessibility API)
        const snapshot = await (this.page as any).accessibility.snapshot({
            interestingOnly: true, // Only interactive/informative elements
        }) as AccessibilityNode | null;

        if (!snapshot) {
            return [];
        }

        const elements: InteractiveElement[] = [];
        let elementIndex = 0;

        // Flatten the accessibility tree and convert to InteractiveElements
        const processNode = async (node: AccessibilityNode, depth: number = 0): Promise<void> => {
            if (elementIndex >= maxElements) return;

            // Skip disabled elements if not requested
            if (node.disabled && !includeDisabled) {
                // Still process children
                if (node.children) {
                    for (const child of node.children) {
                        await processNode(child, depth + 1);
                    }
                }
                return;
            }

            // Only process interactive roles
            const interactiveRoles = [
                'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'listbox',
                'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'switch',
                'slider', 'spinbutton', 'searchbox', 'grid', 'row', 'cell', 'columnheader',
                'rowheader', 'treeitem', 'progressbar', 'scrollbar'
            ];

            const informativeRoles = [
                'heading', 'img', 'alert', 'status', 'dialog', 'alertdialog', 'tooltip',
                'table', 'list', 'listitem', 'navigation', 'main', 'article', 'region'
            ];

            const isInteractive = interactiveRoles.includes(node.role);
            const isInformative = informativeRoles.includes(node.role);

            if (isInteractive || (isInformative && node.name)) {
                const element = this.convertAccessibilityNodeToElement(node, elementIndex);
                if (element) {
                    elements.push(element);
                    elementIndex++;
                }
            }

            // Process children
            if (node.children) {
                for (const child of node.children) {
                    await processNode(child, depth + 1);
                }
            }
        };

        await processNode(snapshot);

        return elements;
    }

    /**
     * Convert an accessibility node to an InteractiveElement
     */
    private convertAccessibilityNodeToElement(node: AccessibilityNode, index: number): InteractiveElement | null {
        // Map accessibility role to element type
        const roleToType: Record<string, ElementType> = {
            'button': 'button',
            'link': 'link',
            'textbox': 'input',
            'searchbox': 'search',
            'checkbox': 'checkbox',
            'radio': 'radio',
            'combobox': 'select',
            'listbox': 'select',
            'option': 'select',
            'slider': 'range',
            'spinbutton': 'input',
            'switch': 'checkbox',
            'tab': 'tab',
            'menuitem': 'menu',
            'menuitemcheckbox': 'checkbox',
            'menuitemradio': 'radio',
            'heading': 'custom', // Informational element
            'img': 'image',
            'table': 'table',
            'grid': 'table',
            'dialog': 'modal',
            'alertdialog': 'modal',
        };

        const type = roleToType[node.role] || 'unknown';

        // Generate locator based on role and name (this is the Playwright MCP approach)
        const locators: LocatorStrategy[] = [];

        // Primary locator: getByRole with name
        if (node.name) {
            locators.push({
                type: 'role',
                value: `getByRole('${node.role}', { name: '${this.escapeString(node.name)}' })`,
                confidence: 95,
                isUnique: true,
            });
        } else {
            locators.push({
                type: 'role',
                value: `getByRole('${node.role}')`,
                confidence: 70,
                isUnique: false,
            });
        }

        // Secondary locator: getByLabel for form fields
        if (node.name && ['textbox', 'combobox', 'searchbox', 'spinbutton'].includes(node.role)) {
            locators.push({
                type: 'label',
                value: `getByLabel('${this.escapeString(node.name)}')`,
                confidence: 90,
                isUnique: false,
            });
        }

        // Text-based locator for buttons/links
        if (node.name && ['button', 'link'].includes(node.role)) {
            locators.push({
                type: 'text',
                value: `getByText('${this.escapeString(node.name)}')`,
                confidence: 85,
                isUnique: false,
            });
        }

        // Infer purpose from name
        const purpose = this.inferPurposeFromName(node.name || '', node.role);

        // Infer field type for inputs
        const fieldType = this.inferFieldTypeFromAccessibility(node);

        // Generate unique ID
        const id = `a11y_${node.role}_${index}_${(node.name || '').substring(0, 20).replace(/[^a-zA-Z0-9]/g, '_')}`;

        return {
            id,
            tagName: node.role, // Use role as pseudo-tagName
            locators,
            type,
            purpose,
            fieldType,
            text: node.name,
            value: node.value,
            ariaLabel: node.name,
            isVisible: true, // Accessibility tree only includes visible elements
            isEnabled: !node.disabled,
            isRequired: node.required || false,
            attributes: {
                role: node.role,
                'aria-checked': node.checked?.toString() || '',
                'aria-expanded': node.expanded?.toString() || '',
                'aria-selected': node.selected?.toString() || '',
                'aria-pressed': node.pressed?.toString() || '',
            },
            classes: [],
            relatedElements: [],
        };
    }

    /**
     * Escape string for use in locator
     */
    private escapeString(str: string): string {
        return str.replace(/'/g, "\\'").replace(/\n/g, ' ').trim();
    }

    /**
     * Infer purpose from accessibility name and role
     */
    private inferPurposeFromName(name: string, role: string): ElementPurpose {
        const lowerName = name.toLowerCase();

        // Purpose patterns
        const patterns: Array<{ keywords: string[]; purpose: ElementPurpose }> = [
            { keywords: ['login', 'sign in', 'signin', 'log in'], purpose: 'login' },
            { keywords: ['logout', 'sign out', 'signout', 'log out'], purpose: 'logout' },
            { keywords: ['register', 'sign up', 'signup', 'create account'], purpose: 'register' },
            { keywords: ['submit', 'send', 'post'], purpose: 'submit' },
            { keywords: ['cancel', 'abort', 'back'], purpose: 'cancel' },
            { keywords: ['close', 'dismiss'], purpose: 'close' },
            { keywords: ['delete', 'remove', 'trash'], purpose: 'delete' },
            { keywords: ['edit', 'modify', 'update'], purpose: 'edit' },
            { keywords: ['add', 'create', 'new'], purpose: 'add' },
            { keywords: ['save', 'store', 'apply'], purpose: 'save' },
            { keywords: ['search', 'find', 'query'], purpose: 'search' },
            { keywords: ['filter', 'refine'], purpose: 'filter' },
            { keywords: ['sort', 'order'], purpose: 'sort' },
            { keywords: ['next', 'forward', 'continue'], purpose: 'next' },
            { keywords: ['prev', 'previous', 'back'], purpose: 'previous' },
            { keywords: ['refresh', 'reload'], purpose: 'refresh' },
            { keywords: ['reset', 'clear'], purpose: 'reset' },
            { keywords: ['confirm', 'ok', 'yes', 'accept'], purpose: 'confirm' },
            { keywords: ['toggle', 'switch'], purpose: 'toggle' },
            { keywords: ['expand', 'show more'], purpose: 'expand' },
            { keywords: ['collapse', 'show less'], purpose: 'collapse' },
            { keywords: ['upload'], purpose: 'upload' },
            { keywords: ['download', 'export'], purpose: 'download' },
        ];

        for (const { keywords, purpose } of patterns) {
            if (keywords.some(kw => lowerName.includes(kw))) {
                return purpose;
            }
        }

        // Default based on role
        if (role === 'link') return 'navigate';
        if (role === 'searchbox') return 'search';

        return 'unknown';
    }

    /**
     * Infer field type from accessibility node
     */
    private inferFieldTypeFromAccessibility(node: AccessibilityNode): FieldType | undefined {
        if (!['textbox', 'combobox', 'searchbox', 'spinbutton'].includes(node.role)) {
            return undefined;
        }

        const name = (node.name || '').toLowerCase();

        // Pattern matching for field types
        const patterns: Array<{ keywords: string[]; fieldType: FieldType }> = [
            { keywords: ['email', 'e-mail'], fieldType: 'email' },
            { keywords: ['phone', 'tel', 'mobile'], fieldType: 'phone' },
            { keywords: ['password', 'pwd', 'secret'], fieldType: 'password' },
            { keywords: ['username', 'user name', 'login'], fieldType: 'username' },
            { keywords: ['first name', 'firstname', 'fname'], fieldType: 'firstName' },
            { keywords: ['last name', 'lastname', 'lname', 'surname'], fieldType: 'lastName' },
            { keywords: ['full name', 'name'], fieldType: 'name' },
            { keywords: ['address', 'street'], fieldType: 'address' },
            { keywords: ['city', 'town'], fieldType: 'city' },
            { keywords: ['state', 'province'], fieldType: 'state' },
            { keywords: ['country', 'nation'], fieldType: 'country' },
            { keywords: ['zip', 'postal'], fieldType: 'zipCode' },
            { keywords: ['date', 'dob', 'birthday'], fieldType: 'date' },
            { keywords: ['url', 'website'], fieldType: 'url' },
            { keywords: ['search', 'query'], fieldType: 'search' },
        ];

        for (const { keywords, fieldType } of patterns) {
            if (keywords.some(kw => name.includes(kw))) {
                return fieldType;
            }
        }

        if (node.role === 'searchbox') return 'search';
        if (node.role === 'spinbutton') return 'number';

        return 'text';
    }

    /**
     * Analyze a single element and extract its properties
     */
    private async analyzeElement(
        handle: ElementHandle,
        includeHidden: boolean,
        includeDisabled: boolean
    ): Promise<InteractiveElement | null> {
        // Check visibility
        const isVisible = await handle.isVisible().catch(() => false);
        if (!isVisible && !includeHidden) {
            return null;
        }

        // Check if enabled
        const isEnabled = await handle.isEnabled().catch(() => true);
        if (!isEnabled && !includeDisabled) {
            return null;
        }

        // Extract element info using evaluate
        const elementInfo = await handle.evaluate((el: Element) => {
            const htmlEl = el as HTMLElement;
            const inputEl = el as HTMLInputElement;

            // Get all attributes
            const attributes: Record<string, string> = {};
            for (let i = 0; i < el.attributes.length; i++) {
                const attr = el.attributes[i];
                attributes[attr.name] = attr.value;
            }

            // Get computed styles for visibility
            const styles = window.getComputedStyle(el);

            // Get bounding box
            const rect = el.getBoundingClientRect();

            // Find label
            let label: string | undefined;
            if (inputEl.id) {
                const labelEl = document.querySelector(`label[for="${inputEl.id}"]`);
                label = labelEl?.textContent?.trim();
            }
            if (!label) {
                const parentLabel = el.closest('label');
                label = parentLabel?.textContent?.trim();
            }

            // Get aria-label
            const ariaLabel = htmlEl.getAttribute('aria-label') ||
                htmlEl.getAttribute('aria-labelledby');

            return {
                tagName: el.tagName.toLowerCase(),
                id: htmlEl.id || undefined,
                name: inputEl.name || undefined,
                type: inputEl.type || undefined,
                value: inputEl.value || undefined,
                text: htmlEl.innerText?.trim()?.substring(0, 200) || undefined,
                placeholder: inputEl.placeholder || undefined,
                title: htmlEl.title || undefined,
                href: (el as HTMLAnchorElement).href || undefined,
                classes: Array.from(el.classList),
                attributes,
                label,
                ariaLabel: ariaLabel || undefined,
                isRequired: inputEl.required || false,
                pattern: inputEl.pattern || undefined,
                minLength: inputEl.minLength > 0 ? inputEl.minLength : undefined,
                maxLength: inputEl.maxLength > 0 && inputEl.maxLength < 524288 ? inputEl.maxLength : undefined,
                min: inputEl.min || undefined,
                max: inputEl.max || undefined,
                boundingBox: {
                    x: rect.x,
                    y: rect.y,
                    width: rect.width,
                    height: rect.height,
                },
                role: htmlEl.getAttribute('role') || undefined,
                dataTestId: htmlEl.getAttribute('data-testid') ||
                    htmlEl.getAttribute('data-cy') ||
                    htmlEl.getAttribute('data-test') || undefined,
            };
        });

        // Generate unique ID
        const elementId = this.generateElementId(elementInfo);

        // Classify element type
        const elementType = this.classifyElementType(elementInfo);

        // Determine element purpose
        const purpose = this.inferElementPurpose(elementInfo);

        // Determine field type for inputs
        const fieldType = elementType === 'input' || elementType === 'textarea'
            ? this.inferFieldType(elementInfo)
            : undefined;

        // Generate locator strategies
        const locators = await this.generateLocators(handle, elementInfo);

        return {
            id: elementId,
            tagName: elementInfo.tagName,
            locators,
            type: elementType,
            purpose,
            fieldType,
            text: elementInfo.text,
            value: elementInfo.value,
            placeholder: elementInfo.placeholder,
            label: elementInfo.label,
            ariaLabel: elementInfo.ariaLabel,
            title: elementInfo.title,
            attributes: elementInfo.attributes,
            classes: elementInfo.classes,
            boundingBox: elementInfo.boundingBox,
            isVisible,
            isEnabled,
            isRequired: elementInfo.isRequired,
            validationPattern: elementInfo.pattern,
            minLength: elementInfo.minLength,
            maxLength: elementInfo.maxLength,
            min: elementInfo.min ? Number(elementInfo.min) : undefined,
            max: elementInfo.max ? Number(elementInfo.max) : undefined,
            relatedElements: [],
        };
    }

    /**
     * Generate unique element ID
     */
    private generateElementId(info: any): string {
        const key = `${info.tagName}-${info.id || ''}-${info.name || ''}-${info.text?.substring(0, 50) || ''}-${info.dataTestId || ''}`;
        return crypto.createHash('md5').update(key).digest('hex').substring(0, 12);
    }

    /**
     * Classify element type
     */
    private classifyElementType(info: any): ElementType {
        const { tagName, type, role, attributes } = info;

        // Check role first
        if (role) {
            const roleMap: Record<string, ElementType> = {
                'button': 'button',
                'link': 'link',
                'checkbox': 'checkbox',
                'radio': 'radio',
                'textbox': 'input',
                'searchbox': 'search',
                'combobox': 'select',
                'listbox': 'select',
                'menu': 'menu',
                'menuitem': 'menu',
                'tab': 'tab',
                'dialog': 'modal',
                'alertdialog': 'modal',
            };
            if (roleMap[role]) return roleMap[role];
        }

        // Check tag name
        switch (tagName) {
            case 'button':
                return 'button';
            case 'a':
                return 'link';
            case 'select':
                return 'select';
            case 'textarea':
                return 'textarea';
            case 'input':
                switch (type) {
                    case 'button':
                    case 'submit':
                    case 'reset':
                        return 'button';
                    case 'checkbox':
                        return 'checkbox';
                    case 'radio':
                        return 'radio';
                    case 'file':
                        return 'file';
                    case 'date':
                    case 'datetime-local':
                        return 'date';
                    case 'time':
                        return 'time';
                    case 'range':
                        return 'range';
                    case 'color':
                        return 'color';
                    case 'search':
                        return 'search';
                    default:
                        return 'input';
                }
            case 'table':
                return 'table';
            case 'form':
                return 'form';
            case 'img':
                return 'image';
            case 'video':
                return 'video';
            case 'iframe':
                return 'iframe';
        }

        // Check for custom components
        if (attributes['onclick'] || attributes['ng-click'] || attributes['@click']) {
            return 'button';
        }

        return 'unknown';
    }

    /**
     * Infer element purpose from text and attributes
     */
    private inferElementPurpose(info: any): ElementPurpose {
        const text = (info.text || '').toLowerCase();
        const ariaLabel = (info.ariaLabel || '').toLowerCase();
        const title = (info.title || '').toLowerCase();
        const id = (info.id || '').toLowerCase();
        const name = (info.name || '').toLowerCase();
        const className = info.classes.join(' ').toLowerCase();

        const allText = `${text} ${ariaLabel} ${title} ${id} ${name} ${className}`;

        // Purpose patterns (order matters - more specific first)
        const patterns: Array<{ keywords: string[]; purpose: ElementPurpose }> = [
            { keywords: ['login', 'sign in', 'signin', 'log in'], purpose: 'login' },
            { keywords: ['logout', 'sign out', 'signout', 'log out'], purpose: 'logout' },
            { keywords: ['register', 'sign up', 'signup', 'create account'], purpose: 'register' },
            { keywords: ['submit', 'send', 'post'], purpose: 'submit' },
            { keywords: ['cancel', 'abort', 'back'], purpose: 'cancel' },
            { keywords: ['close', 'dismiss', 'x'], purpose: 'close' },
            { keywords: ['delete', 'remove', 'trash', 'destroy'], purpose: 'delete' },
            { keywords: ['edit', 'modify', 'update', 'change'], purpose: 'edit' },
            { keywords: ['add', 'create', 'new', 'plus', '+'], purpose: 'add' },
            { keywords: ['save', 'store', 'apply'], purpose: 'save' },
            { keywords: ['search', 'find', 'query'], purpose: 'search' },
            { keywords: ['filter', 'refine'], purpose: 'filter' },
            { keywords: ['sort', 'order'], purpose: 'sort' },
            { keywords: ['next', 'forward', 'continue', '>', '>>'], purpose: 'next' },
            { keywords: ['prev', 'previous', 'back', '<', '<<'], purpose: 'previous' },
            { keywords: ['refresh', 'reload', 'sync'], purpose: 'refresh' },
            { keywords: ['reset', 'clear'], purpose: 'reset' },
            { keywords: ['confirm', 'ok', 'yes', 'accept', 'agree'], purpose: 'confirm' },
            { keywords: ['toggle', 'switch'], purpose: 'toggle' },
            { keywords: ['expand', 'show more', 'more'], purpose: 'expand' },
            { keywords: ['collapse', 'show less', 'less'], purpose: 'collapse' },
            { keywords: ['upload'], purpose: 'upload' },
            { keywords: ['download', 'export'], purpose: 'download' },
        ];

        for (const { keywords, purpose } of patterns) {
            if (keywords.some(kw => allText.includes(kw))) {
                return purpose;
            }
        }

        // Default based on element type
        if (info.tagName === 'a' || info.href) {
            return 'navigate';
        }

        return 'unknown';
    }

    /**
     * Infer field type for input elements
     */
    private inferFieldType(info: any): FieldType {
        const { type, name, id, placeholder, label, pattern, attributes } = info;

        const allText = `${name || ''} ${id || ''} ${placeholder || ''} ${label || ''}`.toLowerCase();

        // Check HTML5 type first
        const typeMap: Record<string, FieldType> = {
            'email': 'email',
            'tel': 'phone',
            'url': 'url',
            'date': 'date',
            'datetime-local': 'datetime',
            'time': 'time',
            'number': 'number',
            'password': 'password',
            'search': 'search',
            'file': 'file',
            'color': 'color',
            'range': 'range',
        };

        if (type && typeMap[type]) {
            return typeMap[type];
        }

        // Pattern-based detection
        const patterns: Array<{ keywords: string[]; fieldType: FieldType }> = [
            { keywords: ['email', 'e-mail', 'correo'], fieldType: 'email' },
            { keywords: ['phone', 'tel', 'mobile', 'cell', 'fax'], fieldType: 'phone' },
            { keywords: ['password', 'passwd', 'pwd', 'secret'], fieldType: 'password' },
            { keywords: ['username', 'user name', 'login', 'userid'], fieldType: 'username' },
            { keywords: ['firstname', 'first name', 'fname', 'given'], fieldType: 'firstName' },
            { keywords: ['lastname', 'last name', 'lname', 'surname', 'family'], fieldType: 'lastName' },
            { keywords: ['fullname', 'full name', 'name'], fieldType: 'name' },
            { keywords: ['address', 'street', 'addr'], fieldType: 'address' },
            { keywords: ['city', 'town', 'locality'], fieldType: 'city' },
            { keywords: ['state', 'province', 'region'], fieldType: 'state' },
            { keywords: ['country', 'nation'], fieldType: 'country' },
            { keywords: ['zip', 'postal', 'postcode'], fieldType: 'zipCode' },
            { keywords: ['credit', 'card', 'cc'], fieldType: 'creditCard' },
            { keywords: ['cvv', 'cvc', 'security code'], fieldType: 'cvv' },
            { keywords: ['ssn', 'social security'], fieldType: 'ssn' },
            { keywords: ['price', 'amount', 'cost', 'total', '$', 'currency'], fieldType: 'currency' },
            { keywords: ['percent', '%'], fieldType: 'percentage' },
            { keywords: ['date', 'dob', 'birthday', 'birth'], fieldType: 'date' },
            { keywords: ['url', 'website', 'link', 'http'], fieldType: 'url' },
            { keywords: ['search', 'query', 'find'], fieldType: 'search' },
        ];

        for (const { keywords, fieldType } of patterns) {
            if (keywords.some(kw => allText.includes(kw))) {
                return fieldType;
            }
        }

        // Check for number patterns
        if (pattern?.includes('\\d') || attributes['inputmode'] === 'numeric') {
            return 'number';
        }

        // Default based on tag
        if (info.tagName === 'textarea') {
            return 'textarea';
        }

        return 'text';
    }

    /**
     * Generate multiple locator strategies for an element
     */
    private async generateLocators(handle: ElementHandle, info: any): Promise<LocatorStrategy[]> {
        const locators: LocatorStrategy[] = [];

        // 1. Test ID (highest priority)
        if (info.dataTestId) {
            locators.push({
                type: 'testid',
                value: info.dataTestId,
                confidence: 95,
                isUnique: true,
            });
        }

        // 2. ID attribute
        if (info.id && !info.id.match(/^[0-9]/) && !info.id.match(/[_-]\d{3,}/)) {
            locators.push({
                type: 'id',
                value: `#${info.id}`,
                confidence: 90,
                isUnique: true,
            });
        }

        // 3. Role + name (accessible)
        if (info.role && (info.text || info.ariaLabel)) {
            const name = info.ariaLabel || info.text;
            locators.push({
                type: 'role',
                value: `role=${info.role}[name="${name.substring(0, 50)}"]`,
                confidence: 85,
                isUnique: false, // Need to verify
            });
        }

        // 4. Label (for form fields)
        if (info.label) {
            locators.push({
                type: 'label',
                value: `label=${info.label}`,
                confidence: 85,
                isUnique: false,
            });
        }

        // 5. Placeholder
        if (info.placeholder) {
            locators.push({
                type: 'placeholder',
                value: `placeholder=${info.placeholder}`,
                confidence: 80,
                isUnique: false,
            });
        }

        // 6. Text content
        if (info.text && info.text.length <= 50) {
            locators.push({
                type: 'text',
                value: `text=${info.text}`,
                confidence: 75,
                isUnique: false,
            });
        }

        // 7. Name attribute
        if (info.name) {
            locators.push({
                type: 'name',
                value: `[name="${info.name}"]`,
                confidence: 70,
                isUnique: false,
            });
        }

        // 8. CSS with stable attributes
        const cssLocator = this.generateCSSLocator(info);
        if (cssLocator) {
            locators.push({
                type: 'css',
                value: cssLocator,
                confidence: 65,
                isUnique: false,
            });
        }

        // 9. XPath (fallback)
        const xpathLocator = this.generateXPathLocator(info);
        if (xpathLocator) {
            locators.push({
                type: 'xpath',
                value: xpathLocator,
                confidence: 50,
                isUnique: false,
            });
        }

        // Sort by confidence
        return locators.sort((a, b) => b.confidence - a.confidence);
    }

    /**
     * Generate CSS selector
     */
    private generateCSSLocator(info: any): string | null {
        const parts: string[] = [info.tagName];

        // Add stable classes (exclude dynamic ones)
        const stableClasses = info.classes.filter((cls: string) =>
            !cls.match(/^[a-z]+-\d+$/) && // hash-based classes
            !cls.match(/^\d/) && // starts with number
            !cls.match(/active|selected|hover|focus|disabled|hidden|visible/) && // state classes
            cls.length < 30 // not too long
        );

        if (stableClasses.length > 0 && stableClasses.length <= 3) {
            parts.push(...stableClasses.map((c: string) => `.${c}`));
        }

        // Add type for inputs
        if (info.tagName === 'input' && info.type) {
            parts.push(`[type="${info.type}"]`);
        }

        if (parts.length === 1) {
            return null; // Not specific enough
        }

        return parts.join('');
    }

    /**
     * Generate XPath selector
     */
    private generateXPathLocator(info: any): string | null {
        // Text-based XPath
        if (info.text && info.text.length <= 30) {
            return `//${info.tagName}[contains(text(), "${info.text.substring(0, 30)}")]`;
        }

        // Attribute-based XPath
        if (info.title) {
            return `//${info.tagName}[@title="${info.title}"]`;
        }

        return null;
    }

    /**
     * Discover all forms on the page
     */
    async discoverForms(): Promise<FormDescriptor[]> {
        if (!this.page) {
            throw new Error('Page not set. Call setPage() first.');
        }

        const forms: FormDescriptor[] = [];
        const formHandles = await this.page.$$('form');

        for (const formHandle of formHandles) {
            try {
                const formInfo = await formHandle.evaluate((form: HTMLFormElement) => {
                    return {
                        id: form.id,
                        name: form.name,
                        action: form.action,
                        method: form.method,
                    };
                });

                // Get form fields
                const fieldHandles = await formHandle.$$('input, select, textarea, button');
                const fields: InteractiveElement[] = [];
                let submitButton: InteractiveElement | undefined;
                let cancelButton: InteractiveElement | undefined;

                for (const fieldHandle of fieldHandles) {
                    const element = await this.analyzeElement(fieldHandle, false, false);
                    if (element) {
                        if (element.purpose === 'submit') {
                            submitButton = element;
                        } else if (element.purpose === 'cancel') {
                            cancelButton = element;
                        } else {
                            fields.push(element);
                        }
                    }
                }

                // Classify form type
                const formType = this.classifyFormType(fields);

                forms.push({
                    id: formInfo.id || `form_${forms.length}`,
                    name: formInfo.name,
                    action: formInfo.action,
                    method: formInfo.method,
                    fields,
                    submitButton,
                    cancelButton,
                    formType,
                });
            } catch (e) {
                continue;
            }
        }

        return forms;
    }

    /**
     * Classify form type based on fields
     */
    private classifyFormType(fields: InteractiveElement[]): FormDescriptor['formType'] {
        const fieldTypes = fields.map(f => f.fieldType).filter(Boolean);
        const purposes = fields.map(f => f.purpose);

        // Login form
        if (fieldTypes.includes('password') &&
            (fieldTypes.includes('username') || fieldTypes.includes('email')) &&
            fields.length <= 4) {
            return 'login';
        }

        // Registration form
        if (fieldTypes.includes('password') && fieldTypes.includes('email') && fields.length > 4) {
            return 'register';
        }

        // Search form
        if (fieldTypes.includes('search') || purposes.includes('search')) {
            return 'search';
        }

        // Contact form
        if (fieldTypes.includes('email') && fieldTypes.includes('textarea')) {
            return 'contact';
        }

        // Checkout form
        if (fieldTypes.includes('creditCard') || fieldTypes.includes('cvv')) {
            return 'checkout';
        }

        return 'crud';
    }

    /**
     * Discover all tables on the page
     */
    async discoverTables(): Promise<TableDescriptor[]> {
        if (!this.page) {
            throw new Error('Page not set. Call setPage() first.');
        }

        const tables: TableDescriptor[] = [];
        const tableHandles = await this.page.$$('table, [role="table"], [class*="table"], [class*="grid"]');

        for (let i = 0; i < tableHandles.length; i++) {
            const tableHandle = tableHandles[i];

            try {
                const tableInfo = await tableHandle.evaluate((table: Element) => {
                    const headers: string[] = [];
                    const headerCells = table.querySelectorAll('th, [role="columnheader"]');
                    headerCells.forEach(h => {
                        const text = (h as HTMLElement).innerText?.trim();
                        if (text) headers.push(text);
                    });

                    const rows = table.querySelectorAll('tr, [role="row"]');
                    const columns = Math.max(...Array.from(rows).map(r => r.children.length), 0);

                    // Check for actions column
                    const hasActions = Array.from(table.querySelectorAll('button, a')).length > 0;

                    return {
                        headers,
                        rowCount: rows.length,
                        columnCount: columns,
                        hasActions,
                    };
                });

                // Check for pagination
                const hasPagination = await this.page.$$('nav[aria-label*="pagination"], .pagination, [class*="pager"]')
                    .then(els => els.length > 0);

                // Check for search
                const hasSearch = await tableHandle.evaluate((table: Element) => {
                    const parent = table.parentElement;
                    return parent?.querySelector('input[type="search"], [class*="search"]') !== null;
                });

                // Check for sort
                const hasSort = await tableHandle.evaluate((table: Element) => {
                    return table.querySelector('[class*="sort"], [aria-sort]') !== null;
                });

                tables.push({
                    id: `table_${i}`,
                    headers: tableInfo.headers,
                    rowCount: tableInfo.rowCount,
                    columnCount: tableInfo.columnCount,
                    hasActions: tableInfo.hasActions,
                    hasPagination,
                    hasSearch,
                    hasSort,
                });
            } catch (e) {
                continue;
            }
        }

        return tables;
    }

    /**
     * Discover all modals/dialogs on the page
     */
    async discoverModals(): Promise<ModalDescriptor[]> {
        if (!this.page) {
            throw new Error('Page not set. Call setPage() first.');
        }

        const modals: ModalDescriptor[] = [];
        const modalSelectors = [
            '[role="dialog"]',
            '[role="alertdialog"]',
            '.modal',
            '.dialog',
            '[class*="modal"]',
            '[class*="dialog"]',
            '[class*="popup"]',
            '[aria-modal="true"]',
        ];

        const modalHandles = await this.page.$$(modalSelectors.join(', '));

        for (let i = 0; i < modalHandles.length; i++) {
            const modalHandle = modalHandles[i];

            try {
                const isVisible = await modalHandle.isVisible();
                if (!isVisible) continue;

                const modalInfo = await modalHandle.evaluate((modal: Element) => {
                    const titleEl = modal.querySelector('[class*="title"], h1, h2, h3, [role="heading"]');
                    const closeEl = modal.querySelector('[class*="close"], [aria-label*="close"], button:has(svg)');

                    return {
                        title: (titleEl as HTMLElement)?.innerText?.trim(),
                        hasCloseButton: closeEl !== null,
                        role: modal.getAttribute('role'),
                    };
                });

                // Find primary and secondary actions
                const buttons = await modalHandle.$$('button, [role="button"]');
                let primaryAction: InteractiveElement | undefined;
                let secondaryAction: InteractiveElement | undefined;

                for (const btn of buttons) {
                    const element = await this.analyzeElement(btn, false, false);
                    if (element) {
                        if (element.purpose === 'confirm' || element.purpose === 'submit' || element.purpose === 'save') {
                            primaryAction = element;
                        } else if (element.purpose === 'cancel' || element.purpose === 'close') {
                            secondaryAction = element;
                        }
                    }
                }

                modals.push({
                    id: `modal_${i}`,
                    title: modalInfo.title,
                    type: modalInfo.role === 'alertdialog' ? 'alert' :
                        modalInfo.role === 'dialog' ? 'dialog' : 'unknown',
                    hasCloseButton: modalInfo.hasCloseButton,
                    primaryAction,
                    secondaryAction,
                });
            } catch (e) {
                continue;
            }
        }

        return modals;
    }

    /**
     * Generate DOM hash for state comparison
     */
    async generateDOMHash(): Promise<string> {
        if (!this.page) {
            throw new Error('Page not set. Call setPage() first.');
        }

        const domStructure = await this.page.evaluate(() => {
            const getStructure = (el: Element, depth: number = 0): string => {
                if (depth > 5) return '';

                const tag = el.tagName.toLowerCase();
                const id = el.id ? `#${el.id}` : '';
                const classes = el.className && typeof el.className === 'string'
                    ? '.' + el.className.split(' ').slice(0, 2).join('.')
                    : '';

                const children = Array.from(el.children)
                    .map(c => getStructure(c, depth + 1))
                    .filter(Boolean)
                    .join(',');

                return `${tag}${id}${classes}${children ? `[${children}]` : ''}`;
            };

            return getStructure(document.body);
        });

        return crypto.createHash('md5').update(domStructure).digest('hex');
    }

    /**
     * Generate content hash for comparison
     */
    async generateContentHash(): Promise<string> {
        if (!this.page) {
            throw new Error('Page not set. Call setPage() first.');
        }

        const textContent = await this.page.evaluate(() => {
            // Get main content text, excluding scripts/styles
            const body = document.body.cloneNode(true) as HTMLElement;
            body.querySelectorAll('script, style, noscript').forEach(el => el.remove());
            return body.innerText?.substring(0, 5000) || '';
        });

        return crypto.createHash('md5').update(textContent).digest('hex');
    }
}

export default DOMDiscoveryEngine;
