import { Page } from '@playwright/test';
import { CSConfigurationManager } from '../core/CSConfigurationManager';
import { CSReporter } from '../reporter/CSReporter';
import { CSWebElement } from '../element/CSWebElement';

export interface VisualCriteria {
    color?: string;
    text?: string;
    position?: 'top' | 'bottom' | 'left' | 'right' | 'center';
    size?: 'small' | 'medium' | 'large';
    shape?: 'rectangle' | 'square' | 'circle';
    nearText?: string;
    containsImage?: boolean;
}

export interface TestSuggestion {
    type: 'security' | 'validation' | 'performance' | 'accessibility';
    test: string;
    gherkin: string;
    priority: 'high' | 'medium' | 'low';
    reason: string;
}

export class CSAIEngine {
    private static instance: CSAIEngine;
    private config: CSConfigurationManager;
    private healingHistory: Map<string, string[]> = new Map();
    private elementCache: Map<string, any> = new Map();
    private confidenceThreshold: number;
    
    private constructor() {
        this.config = CSConfigurationManager.getInstance();
        this.confidenceThreshold = this.config.getNumber('AI_CONFIDENCE_THRESHOLD', 0.7);
    }
    
    public static getInstance(): CSAIEngine {
        if (!CSAIEngine.instance) {
            CSAIEngine.instance = new CSAIEngine();
        }
        return CSAIEngine.instance;
    }
    
    public async findByVisualDescription(page: Page, description: string): Promise<CSWebElement | null> {
        if (!this.config.getBoolean('AI_ENABLED', false)) {
            return null;
        }
        
        CSReporter.info(`AI: Finding element by description: "${description}"`);
        
        try {
            // Parse natural language description
            const criteria = this.parseVisualDescription(description);
            
            // Take screenshot for analysis
            const screenshot = await page.screenshot({ fullPage: true });
            
            // Analyze page elements
            const elements = await this.analyzePageElements(page);
            
            // Find matching elements
            const matches = await this.findMatchingElements(elements, criteria);
            
            if (matches.length === 0) {
                CSReporter.warn('AI: No matching elements found');
                return null;
            }
            
            // Get best match
            const bestMatch = this.selectBestMatch(matches, criteria);
            
            CSReporter.info(`AI: Found element with ${(bestMatch.confidence * 100).toFixed(1)}% confidence`);
            
            // Create CSWebElement from match
            return new CSWebElement({
                css: bestMatch.selector,
                description: `AI: ${description}`,
                selfHeal: false // Disable self-healing for AI-found elements
            });
            
        } catch (error: any) {
            CSReporter.error(`AI: Failed to find element: ${error.message}`);
            return null;
        }
    }
    
    private parseVisualDescription(description: string): VisualCriteria {
        const criteria: VisualCriteria = {};
        
        // Parse color
        const colorMatch = description.match(/\b(red|blue|green|yellow|black|white|gray|orange|purple|brown)\b/i);
        if (colorMatch) {
            criteria.color = colorMatch[1].toLowerCase();
        }
        
        // Parse position
        const positionMatch = description.match(/\b(top|bottom|left|right|center)\b/i);
        if (positionMatch) {
            criteria.position = positionMatch[1].toLowerCase() as any;
        }
        
        // Parse size
        const sizeMatch = description.match(/\b(small|medium|large|big|tiny)\b/i);
        if (sizeMatch) {
            const size = sizeMatch[1].toLowerCase();
            criteria.size = size === 'big' ? 'large' : size === 'tiny' ? 'small' : size as any;
        }
        
        // Parse shape
        const shapeMatch = description.match(/\b(button|circle|square|rectangle|round)\b/i);
        if (shapeMatch) {
            const shape = shapeMatch[1].toLowerCase();
            criteria.shape = shape === 'button' ? 'rectangle' : 
                           shape === 'round' ? 'circle' : shape as any;
        }
        
        // Parse text content
        const textMatch = description.match(/["']([^"']+)["']/);
        if (textMatch) {
            criteria.text = textMatch[1];
        } else {
            // Look for common button/link text
            const commonTextMatch = description.match(/\b(submit|login|save|cancel|close|next|previous|back|continue)\b/i);
            if (commonTextMatch) {
                criteria.text = commonTextMatch[1];
            }
        }
        
        // Parse proximity
        const nearMatch = description.match(/near\s+["']?([^"']+)["']?/i);
        if (nearMatch) {
            criteria.nearText = nearMatch[1];
        }
        
        return criteria;
    }
    
    private async analyzePageElements(page: Page): Promise<any[]> {
        return await page.evaluate(() => {
            const elements: any[] = [];
            
            // Get all interactive elements
            const selectors = ['button', 'a', 'input', 'select', 'textarea', '[role="button"]', '[onclick]'];
            
            selectors.forEach(selector => {
                const nodes = document.querySelectorAll(selector);
                nodes.forEach((node: any) => {
                    const rect = node.getBoundingClientRect();
                    const computedStyle = window.getComputedStyle(node);
                    
                    elements.push({
                        tagName: node.tagName.toLowerCase(),
                        text: node.textContent?.trim() || node.value || node.placeholder || '',
                        selector: generateSelector(node),
                        position: {
                            x: rect.x,
                            y: rect.y,
                            width: rect.width,
                            height: rect.height
                        },
                        style: {
                            color: computedStyle.color,
                            backgroundColor: computedStyle.backgroundColor,
                            borderRadius: computedStyle.borderRadius
                        },
                        attributes: {
                            id: node.id,
                            className: node.className,
                            type: node.type,
                            role: node.getAttribute('role')
                        },
                        visible: rect.width > 0 && rect.height > 0 && computedStyle.display !== 'none'
                    });
                });
            });
            
            // Helper function to generate selector
            function generateSelector(this: any, element: Element): string {
                if (element.id) {
                    return `#${element.id}`;
                }
                
                const classes = Array.from(element.classList).filter(c => !c.startsWith('ng-'));
                if (classes.length > 0) {
                    return `${element.tagName.toLowerCase()}.${classes.join('.')}`;
                }
                
                // Generate xpath as fallback
                let path = '';
                let current = element;
                while (current && current.nodeType === Node.ELEMENT_NODE) {
                    let index = 0;
                    let sibling = current.previousSibling;
                    while (sibling) {
                        if (sibling.nodeType === Node.ELEMENT_NODE && 
                            sibling.nodeName === current.nodeName) {
                            index++;
                        }
                        sibling = sibling.previousSibling;
                    }
                    const tagName = current.nodeName.toLowerCase();
                    const xpathIndex = index > 0 ? `[${index + 1}]` : '';
                    path = `/${tagName}${xpathIndex}${path}`;
                    current = current.parentElement as Element;
                }
                
                return path;
            }
            
            return elements;
        });
    }
    
    private async findMatchingElements(elements: any[], criteria: VisualCriteria): Promise<any[]> {
        const matches: any[] = [];
        
        for (const element of elements) {
            if (!element.visible) continue;
            
            let confidence = 0;
            let matchCount = 0;
            let totalCriteria = Object.keys(criteria).length;
            
            // Match text
            if (criteria.text) {
                if (element.text.toLowerCase().includes(criteria.text.toLowerCase())) {
                    confidence += 0.4;
                    matchCount++;
                }
            }
            
            // Match color
            if (criteria.color) {
                if (this.matchesColor(element.style, criteria.color)) {
                    confidence += 0.2;
                    matchCount++;
                }
            }
            
            // Match position
            if (criteria.position) {
                if (this.matchesPosition(element.position, criteria.position)) {
                    confidence += 0.2;
                    matchCount++;
                }
            }
            
            // Match size
            if (criteria.size) {
                if (this.matchesSize(element.position, criteria.size)) {
                    confidence += 0.1;
                    matchCount++;
                }
            }
            
            // Match shape
            if (criteria.shape) {
                if (this.matchesShape(element, criteria.shape)) {
                    confidence += 0.1;
                    matchCount++;
                }
            }
            
            // Adjust confidence based on match ratio
            if (totalCriteria > 0) {
                confidence = confidence * (matchCount / totalCriteria);
            }
            
            if (confidence >= this.confidenceThreshold) {
                matches.push({
                    ...element,
                    confidence
                });
            }
        }
        
        return matches.sort((a, b) => b.confidence - a.confidence);
    }
    
    private matchesColor(style: any, color: string): boolean {
        const colorMap: any = {
            'red': ['rgb(255, 0, 0)', '#ff0000', '#f00'],
            'blue': ['rgb(0, 0, 255)', '#0000ff', '#00f'],
            'green': ['rgb(0, 128, 0)', '#008000'],
            'black': ['rgb(0, 0, 0)', '#000000', '#000'],
            'white': ['rgb(255, 255, 255)', '#ffffff', '#fff']
        };
        
        const variants = colorMap[color] || [];
        const elementColor = style.backgroundColor || style.color;
        
        return variants.some((v: string) => elementColor?.includes(v)) ||
               elementColor?.toLowerCase().includes(color);
    }
    
    private matchesPosition(position: any, criteria: string): boolean {
        const viewport = {
            width: window.innerWidth || 1920,
            height: window.innerHeight || 1080
        };
        
        switch (criteria) {
            case 'top':
                return position.y < viewport.height * 0.3;
            case 'bottom':
                return position.y > viewport.height * 0.7;
            case 'left':
                return position.x < viewport.width * 0.3;
            case 'right':
                return position.x > viewport.width * 0.7;
            case 'center':
                return position.x > viewport.width * 0.3 && 
                       position.x < viewport.width * 0.7 &&
                       position.y > viewport.height * 0.3 && 
                       position.y < viewport.height * 0.7;
            default:
                return false;
        }
    }
    
    private matchesSize(position: any, size: string): boolean {
        const area = position.width * position.height;
        
        switch (size) {
            case 'small':
                return area < 5000;
            case 'medium':
                return area >= 5000 && area < 20000;
            case 'large':
                return area >= 20000;
            default:
                return false;
        }
    }
    
    private matchesShape(element: any, shape: string): boolean {
        const aspectRatio = element.position.width / element.position.height;
        const borderRadius = parseFloat(element.style.borderRadius) || 0;
        
        switch (shape) {
            case 'square':
                return Math.abs(aspectRatio - 1) < 0.2;
            case 'rectangle':
                return aspectRatio > 1.2 || aspectRatio < 0.8;
            case 'circle':
                return borderRadius >= Math.min(element.position.width, element.position.height) / 2;
            default:
                return false;
        }
    }
    
    private selectBestMatch(matches: any[], criteria: VisualCriteria): any {
        // Already sorted by confidence
        return matches[0];
    }
    
    public async generateTestSuggestions(page: Page): Promise<TestSuggestion[]> {
        if (!this.config.getBoolean('AI_ENABLED', false)) {
            return [];
        }
        
        CSReporter.info('AI: Generating test suggestions');
        
        const suggestions: TestSuggestion[] = [];
        
        try {
            // Analyze page for potential issues
            const analysis = await this.analyzePage(page);
            
            // Security suggestions
            suggestions.push(...this.generateSecuritySuggestions(analysis));
            
            // Validation suggestions
            suggestions.push(...this.generateValidationSuggestions(analysis));
            
            // Accessibility suggestions
            suggestions.push(...this.generateAccessibilitySuggestions(analysis));
            
            // Performance suggestions
            suggestions.push(...this.generatePerformanceSuggestions(analysis));
            
            CSReporter.info(`AI: Generated ${suggestions.length} test suggestions`);
            
        } catch (error: any) {
            CSReporter.error(`AI: Failed to generate suggestions: ${error.message}`);
        }
        
        return suggestions;
    }
    
    private async analyzePage(page: Page): Promise<any> {
        return await page.evaluate(() => {
            const analysis: any = {
                forms: [],
                inputs: [],
                images: [],
                links: [],
                scripts: []
            };
            
            // Analyze forms
            document.querySelectorAll('form').forEach(form => {
                analysis.forms.push({
                    action: form.action,
                    method: form.method,
                    inputs: form.querySelectorAll('input').length
                });
            });
            
            // Analyze inputs
            document.querySelectorAll('input, textarea').forEach((input: any) => {
                analysis.inputs.push({
                    type: input.type,
                    name: input.name,
                    id: input.id,
                    required: input.required,
                    maxLength: input.maxLength,
                    pattern: input.pattern,
                    validation: input.getAttribute('data-validation')
                });
            });
            
            // Analyze images
            document.querySelectorAll('img').forEach((img: any) => {
                analysis.images.push({
                    src: img.src,
                    alt: img.alt,
                    loading: img.loading
                });
            });
            
            // Analyze links
            document.querySelectorAll('a').forEach((link: any) => {
                analysis.links.push({
                    href: link.href,
                    target: link.target,
                    rel: link.rel
                });
            });
            
            return analysis;
        });
    }
    
    private generateSecuritySuggestions(analysis: any): TestSuggestion[] {
        const suggestions: TestSuggestion[] = [];
        
        // SQL Injection tests for inputs
        const textInputs = analysis.inputs.filter((i: any) => 
            i.type === 'text' || i.type === 'email' || !i.type
        );
        
        if (textInputs.length > 0) {
            suggestions.push({
                type: 'security',
                test: 'SQL Injection in input fields',
                gherkin: `When I enter "' OR '1'='1" in the username field\nThen the application should handle it safely`,
                priority: 'high',
                reason: 'Text inputs found without apparent validation'
            });
        }
        
        // XSS tests
        suggestions.push({
            type: 'security',
            test: 'Cross-Site Scripting (XSS) prevention',
            gherkin: `When I enter "<script>alert('XSS')</script>" in text fields\nThen the script should not execute`,
            priority: 'high',
            reason: 'All user inputs should be sanitized'
        });
        
        return suggestions;
    }
    
    private generateValidationSuggestions(analysis: any): TestSuggestion[] {
        const suggestions: TestSuggestion[] = [];
        
        // Required field validation
        const requiredInputs = analysis.inputs.filter((i: any) => i.required);
        if (requiredInputs.length > 0) {
            suggestions.push({
                type: 'validation',
                test: 'Required field validation',
                gherkin: `When I submit the form without required fields\nThen I should see validation errors`,
                priority: 'medium',
                reason: `Found ${requiredInputs.length} required fields`
            });
        }
        
        // Max length validation
        const maxLengthInputs = analysis.inputs.filter((i: any) => i.maxLength > 0);
        if (maxLengthInputs.length > 0) {
            suggestions.push({
                type: 'validation',
                test: 'Maximum length validation',
                gherkin: `When I enter text exceeding the maximum length\nThen the input should be restricted`,
                priority: 'low',
                reason: `Found ${maxLengthInputs.length} fields with max length`
            });
        }
        
        return suggestions;
    }
    
    private generateAccessibilitySuggestions(analysis: any): TestSuggestion[] {
        const suggestions: TestSuggestion[] = [];
        
        // Image alt text
        const imagesWithoutAlt = analysis.images.filter((i: any) => !i.alt);
        if (imagesWithoutAlt.length > 0) {
            suggestions.push({
                type: 'accessibility',
                test: 'Images should have alt text',
                gherkin: `Then all images should have descriptive alt text`,
                priority: 'medium',
                reason: `Found ${imagesWithoutAlt.length} images without alt text`
            });
        }
        
        return suggestions;
    }
    
    private generatePerformanceSuggestions(analysis: any): TestSuggestion[] {
        const suggestions: TestSuggestion[] = [];
        
        // Lazy loading
        const imagesWithoutLazyLoad = analysis.images.filter((i: any) => i.loading !== 'lazy');
        if (imagesWithoutLazyLoad.length > 5) {
            suggestions.push({
                type: 'performance',
                test: 'Images should use lazy loading',
                gherkin: `Then images below the fold should load lazily`,
                priority: 'low',
                reason: `Found ${imagesWithoutLazyLoad.length} images without lazy loading`
            });
        }
        
        return suggestions;
    }
    
    public async generateLocator(prompt: string, context: any): Promise<string | null> {
        try {
            // Use AI to generate a locator based on the prompt and context
            const response = await this.query(
                `Generate a Playwright locator for: ${prompt}\nContext: ${JSON.stringify(context)}`,
                { mode: 'locator' }
            );
            
            return response || null;
        } catch (error) {
            CSReporter.debug(`Failed to generate locator: ${error}`);
            return null;
        }
    }
    
    public async generateSelector(element: any, context: any): Promise<string> {
        // Generate a CSS selector for the element
        const tagName = element.tagName?.toLowerCase() || 'div';
        const id = element.id;
        const className = element.className;
        
        if (id) {
            return `#${id}`;
        }
        
        if (className) {
            const classes = className.split(' ').filter((c: string) => c.length > 0);
            if (classes.length > 0) {
                return `.${classes[0]}`;
            }
        }
        
        return tagName;
    }
    
    public recordHealing(originalSelector: string, healedSelector: string): void {
        if (!this.healingHistory.has(originalSelector)) {
            this.healingHistory.set(originalSelector, []);
        }
        
        this.healingHistory.get(originalSelector)!.push(healedSelector);
        
        // Keep only last 10 healing attempts
        const history = this.healingHistory.get(originalSelector)!;
        if (history.length > 10) {
            history.shift();
        }
    }
    
    public getHealingHistory(): Map<string, string[]> {
        return this.healingHistory;
    }
    
    public clearCache(): void {
        this.elementCache.clear();
        this.healingHistory.clear();
    }
    
    private async query(prompt: string, options: any = {}): Promise<string> {
        // Mock AI query implementation - replace with actual AI service integration
        CSReporter.debug(`AI Query: ${prompt}`);
        
        if (options.mode === 'locator') {
            // Generate a basic locator based on the prompt
            if (prompt.includes('button')) {
                return 'button';
            } else if (prompt.includes('input')) {
                return 'input';
            } else if (prompt.includes('link')) {
                return 'a';
            }
            return 'div';
        }
        
        return 'Generated response';
    }
}