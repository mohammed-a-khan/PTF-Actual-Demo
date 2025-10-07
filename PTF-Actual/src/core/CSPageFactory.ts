import 'reflect-metadata';
// Lazy load Playwright for performance
// import { Page } from '@playwright/test';
type Page = any;
import { CSBasePage } from './CSBasePage';
import { CSWebElement } from '../element/CSWebElement';
import { CSReporter } from '../reporter/CSReporter';

// Decorator for page class
export function CSPage(url?: string) {
    return function(constructor: any) {
        Reflect.defineMetadata('page:url', url, constructor);
        CSPageFactory.registerPage(constructor);
        return constructor;
    };
}

// Decorator for element with ALL options from user guide
export interface CSElementOptions {
    // Basic selectors
    css?: string;
    xpath?: string;
    id?: string;
    text?: string;
    role?: string;
    testId?: string;
    label?: string;
    placeholder?: string;
    title?: string;
    alt?: string;
    name?: string;
    className?: string;
    
    // Element metadata
    description?: string;
    tags?: string[];
    category?: string;
    
    // Wait options
    waitForVisible?: boolean;
    waitForEnabled?: boolean;
    waitForClickable?: boolean;
    waitForStable?: boolean;
    timeout?: number;
    
    // Position and hierarchy
    index?: number;
    parent?: string;
    child?: string;
    nth?: number;
    first?: boolean;
    last?: boolean;
    
    // Self-healing
    selfHeal?: boolean;
    alternativeLocators?: string[];
    healingStrategies?: ('nearby' | 'text' | 'visual' | 'structure' | 'ai')[];
    
    // Frame and shadow DOM
    iframe?: string | number;
    shadowRoot?: string;
    shadowPath?: string[];
    
    // Behavior options
    dynamic?: boolean;
    cache?: boolean;
    retry?: number;
    retryInterval?: number;
    screenshot?: boolean;
    highlight?: boolean;
    scroll?: boolean | 'center' | 'nearest';
    force?: boolean;
    strict?: boolean;
    
    // Validation
    validate?: (element: any) => boolean;
    validator?: string;
    required?: boolean;
    
    // AI-enhanced options
    aiEnabled?: boolean;
    aiDescription?: string;
    aiContext?: string;
    
    // Performance
    lazy?: boolean;
    preload?: boolean;
    
    // Custom attributes
    attributes?: Record<string, string>;
    data?: Record<string, any>;
    
    // Events
    beforeClick?: () => void | Promise<void>;
    afterClick?: () => void | Promise<void>;
    beforeFill?: (value: string) => string | Promise<string>;
    afterFill?: () => void | Promise<void>;
    
    // Visibility conditions
    visibleWhen?: string;
    hiddenWhen?: string;
    enabledWhen?: string;
    disabledWhen?: string;
    
    // Multi-element support
    multiple?: boolean;
    minCount?: number;
    maxCount?: number;
    exactCount?: number;
    
    // Interaction options
    clickPosition?: { x: number; y: number };
    clickDelay?: number;
    doubleClick?: boolean;
    rightClick?: boolean;
    modifiers?: ('Alt' | 'Control' | 'Meta' | 'Shift')[];
    
    // Text options
    trimText?: boolean;
    ignoreCase?: boolean;
    exactText?: boolean;
    containsText?: string;
    matchesRegex?: string;
    
    // State management
    stateKey?: string;
    persistState?: boolean;
    
    // Debugging
    debug?: boolean;
    logLevel?: 'error' | 'warn' | 'info' | 'debug';
    breakpoint?: boolean;
}

export function CSGetElement(options: CSElementOptions) {
    return function(target: any, propertyKey: string | symbol | any, descriptor?: PropertyDescriptor): any {
        // Handle both old and new decorator API
        const actualPropertyKey = typeof propertyKey === 'string' ? propertyKey : propertyKey.name;
        
        // Store element metadata
        if (!target.csElements) {
            target.csElements = {};
        }
        target.csElements[actualPropertyKey] = options;
        
        // Return a new descriptor with getter/setter
        return {
            get: function() {
                if (!this._elements) {
                    this._elements = {};
                }
                if (!this._elements[actualPropertyKey]) {
                    // Process the options to build the element
                    const elementOptions: any = {
                        description: options.description || actualPropertyKey
                    };
                    
                    // Map the decorator options to CSWebElement options
                    if (options.css) elementOptions.css = options.css;
                    if (options.xpath) elementOptions.xpath = options.xpath;
                    if (options.id) elementOptions.id = options.id;
                    if (options.text) elementOptions.text = options.text;
                    if (options.role) elementOptions.role = options.role;
                    if (options.testId) elementOptions.testId = options.testId;
                    if (options.label) elementOptions.label = options.label;
                    if (options.placeholder) elementOptions.placeholder = options.placeholder;
                    if (options.title) elementOptions.title = options.title;
                    if (options.alt) elementOptions.alt = options.alt;
                    if (options.name) elementOptions.name = options.name;
                    if (options.className) elementOptions.className = options.className;
                    
                    // Advanced options
                    if (options.waitForVisible !== undefined) elementOptions.waitForVisible = options.waitForVisible;
                    if (options.waitForEnabled !== undefined) elementOptions.waitForEnabled = options.waitForEnabled;
                    if (options.timeout !== undefined) elementOptions.timeout = options.timeout;
                    if (options.index !== undefined) elementOptions.index = options.index;
                    if (options.parent) elementOptions.parent = options.parent;
                    if (options.child) elementOptions.child = options.child;
                    if (options.selfHeal !== undefined) elementOptions.selfHeal = options.selfHeal;
                    if (options.alternativeLocators) elementOptions.alternativeLocators = options.alternativeLocators;
                    if (options.iframe !== undefined) elementOptions.iframe = options.iframe;
                    if (options.shadowRoot) elementOptions.shadowRoot = options.shadowRoot;
                    if (options.dynamic !== undefined) elementOptions.dynamic = options.dynamic;
                    if (options.cache !== undefined) elementOptions.cache = options.cache;
                    if (options.retry !== undefined) elementOptions.retry = options.retry;
                    if (options.screenshot !== undefined) elementOptions.screenshot = options.screenshot;
                    if (options.highlight !== undefined) elementOptions.highlight = options.highlight;
                    if (options.scroll !== undefined) elementOptions.scroll = options.scroll;
                    if (options.force !== undefined) elementOptions.force = options.force;
                    
                    // Get page from the current instance (this should be a CSBasePage instance)
                    const currentPage = this.page || (this.browserManager && this.browserManager.getPage());
                    this._elements[actualPropertyKey] = new CSWebElement(elementOptions, currentPage);
                }
                return this._elements[actualPropertyKey];
            },
            set: function(value: any) {
                // Allow setting the element directly if needed
                if (!this._elements) {
                    this._elements = {};
                }
                this._elements[actualPropertyKey] = value;
            },
            enumerable: true,
            configurable: true
        };
    };
}

// Decorator for multiple elements
export function CSGetElements(options: CSElementOptions) {
    return function(target: any, propertyKey: string | symbol | any, descriptor?: PropertyDescriptor): any {
        // Handle both old and new decorator API
        const actualPropertyKey = typeof propertyKey === 'string' ? propertyKey : propertyKey.name;
        
        // Store element metadata
        if (!target.csElements) {
            target.csElements = {};
        }
        target.csElements[actualPropertyKey] = { ...options, multiple: true };
        
        // Return descriptor with getter/setter
        return {
            get: function() {
                if (!this._elements) {
                    this._elements = {};
                }
                if (!this._elements[actualPropertyKey]) {
                    const { CSElements } = require('../element/CSWebElement');
                    
                    // Process the options to build the elements
                    const elementOptions: any = {
                        description: options.description || actualPropertyKey
                    };
                    
                    // Map all decorator options
                    Object.keys(options).forEach(key => {
                        if (options[key as keyof CSElementOptions] !== undefined) {
                            elementOptions[key] = options[key as keyof CSElementOptions];
                        }
                    });
                    
                    // Get page from the current instance
                    const currentPage = this.page || (this.browserManager && this.browserManager.getPage());
                    this._elements[actualPropertyKey] = new CSElements(elementOptions, currentPage);
                }
                return this._elements[actualPropertyKey];
            },
            set: function(value: any) {
                // Allow setting the elements directly if needed
                if (!this._elements) {
                    this._elements = {};
                }
                this._elements[actualPropertyKey] = value;
            },
            enumerable: true,
            configurable: true
        };
    };
}

// Decorator for element getter method
export function CSGetElementMethod(selector: string, options?: any) {
    return function(target: any, propertyKey: string, descriptor: PropertyDescriptor) {
        descriptor.value = function() {
            return new CSWebElement({
                css: selector,
                ...options,
                description: propertyKey
            });
        };
        return descriptor;
    };
}

// Dependency injection decorator
export function CSInject(token: string) {
    return function(target: any, propertyKey: string) {
        Object.defineProperty(target, propertyKey, {
            get: function() {
                return CSPageFactory.resolve(token);
            },
            enumerable: true,
            configurable: true
        });
    };
}

// Note: @CSWaitFor, @CSAction, @CSRetry decorators removed
// These are NOT part of the user guide and should not be used
// All actions are handled by CSWebElement methods which already include:
// - Automatic reporting
// - Retry logic
// - Wait conditions
// - Error handling

// Page Factory for managing page objects
export class CSPageFactory {
    private static pages: Map<string, any> = new Map();
    private static instances: Map<string, any> = new Map();
    private static dependencies: Map<string, any> = new Map();
    private page: Page;
    
    constructor(page: Page) {
        this.page = page;
    }
    
    public static registerPage(pageClass: any): void {
        const name = pageClass.name;
        this.pages.set(name, pageClass);
        CSReporter.debug(`Registered page: ${name}`);
    }
    
    public static getPage<T extends CSBasePage>(pageClass: new() => T): T {
        const name = pageClass.name;
        
        // Return existing instance if available
        if (this.instances.has(name)) {
            return this.instances.get(name);
        }
        
        // Create new instance
        const instance = new pageClass();
        this.instances.set(name, instance);
        
        // Initialize elements if decorated
        this.initializeDecoratedElements(instance);
        
        return instance;
    }
    
    public static createPage<T extends CSBasePage>(pageClass: new() => T): T {
        const instance = new pageClass();
        this.initializeDecoratedElements(instance);
        return instance;
    }
    
    private static initializeDecoratedElements(instance: any): void {
        const prototype = Object.getPrototypeOf(instance);
        
        if (prototype.csElements) {
            Object.keys(prototype.csElements).forEach(key => {
                const options = prototype.csElements[key];
                
                if (options.multiple) {
                    const { CSElements } = require('../element/CSWebElement');
                    instance[key] = new CSElements({
                        ...options,
                        description: options.description || key
                    });
                } else {
                    instance[key] = new CSWebElement({
                        ...options,
                        description: options.description || key
                    });
                }
            });
        }
    }
    
    public static register(token: string, instance: any): void {
        this.dependencies.set(token, instance);
    }
    
    public static resolve(token: string): any {
        return this.dependencies.get(token);
    }
    
    public static clearAll(): void {
        this.instances.clear();
    }
    
    public static getAllPages(): Map<string, any> {
        return this.pages;
    }
    
    // Instance method to create page by name
    public create<T>(pageName: string): T {
        const PageClass = CSPageFactory.pages.get(pageName);
        if (!PageClass) {
            throw new Error(`Page ${pageName} not registered`);
        }
        const instance = new PageClass();
        instance.page = this.page;
        CSPageFactory.initializeDecoratedElements(instance);
        return instance as T;
    }
}

// Backward compatibility - keep old names as aliases
export const CSElement = CSGetElement;
export const CSElements = CSGetElements;