/**
 * Framework Knowledge Graph for CS Codegen
 * Layer 4: Complete knowledge of ALL CS Framework capabilities
 *
 * This is the "brain" that knows every method, when to use it, and why
 */

import { CSCapability, CSCapabilityMatch, Action, TestIntent } from '../types';

export class FrameworkKnowledgeGraph {
    private capabilities: Map<string, CSCapability> = new Map();

    constructor() {
        this.buildKnowledgeBase();
    }

    /**
     * Build complete knowledge base of CS Framework capabilities
     */
    private buildKnowledgeBase(): void {
        // CSWebElement Click Methods (20+ variants)
        this.addCapability({
            id: 'click',
            name: 'click',
            type: 'action',
            className: 'CSWebElement',
            description: 'Standard click with retry logic and automatic reporting',
            signature: 'async click(options?: ClickOptions): Promise<void>',
            whenToUse: 'Default choice for clicking interactive elements',
            alternatives: ['clickWithForce', 'clickWithTimeout', 'rightClick', 'middleClick'],
            useCases: ['Button clicks', 'Link clicks', 'Any clickable element'],
            examples: ['await element.click();'],
            benefits: ['Auto-retry on failure', 'Automatic logging', 'Self-healing support']
        });

        this.addCapability({
            id: 'clickWithForce',
            name: 'clickWithForce',
            type: 'action',
            className: 'CSWebElement',
            description: 'Force click bypassing actionability checks',
            signature: 'async clickWithForce(): Promise<void>',
            whenToUse: 'When element is covered, hidden, or not fully visible',
            alternatives: ['click', 'clickWithTimeout'],
            useCases: ['Overlapping elements', 'Partially hidden buttons', 'Non-standard UI'],
            examples: ['await element.clickWithForce();'],
            benefits: ['Bypasses visibility checks', 'Works with covered elements', 'Self-documenting intent']
        });

        this.addCapability({
            id: 'clickWithControlKey',
            name: 'clickWithControlKey',
            type: 'action',
            className: 'CSWebElement',
            description: 'Click while holding Control key',
            signature: 'async clickWithControlKey(): Promise<void>',
            whenToUse: 'Opening links in new tab, multi-selection',
            alternatives: ['clickWithModifiers', 'click'],
            useCases: ['Open link in new tab', 'Multi-select items'],
            examples: ['await link.clickWithControlKey();'],
            benefits: ['Semantic method name', 'Clear intent', 'Platform-aware']
        });

        this.addCapability({
            id: 'rightClick',
            name: 'rightClick',
            type: 'action',
            className: 'CSWebElement',
            description: 'Right-click (context menu)',
            signature: 'async rightClick(options?: Omit<ClickOptions, "button">): Promise<void>',
            whenToUse: 'Opening context menus',
            alternatives: ['click'],
            useCases: ['Context menu interaction', 'Right-click actions'],
            examples: ['await element.rightClick();'],
            benefits: ['Semantic method name', 'Auto-logging']
        });

        // Fill Methods (8+ variants)
        this.addCapability({
            id: 'fill',
            name: 'fill',
            type: 'action',
            className: 'CSWebElement',
            description: 'Fill input with value (auto-clears first)',
            signature: 'async fill(value: string, options?: FillOptions): Promise<void>',
            whenToUse: 'Standard form input filling',
            alternatives: ['fillWithForce', 'fillWithTimeout', 'type'],
            useCases: ['Text inputs', 'Textareas', 'Form fields'],
            examples: ['await input.fill("test@example.com");'],
            benefits: ['Auto-clear before fill', 'Retry logic', 'Wait for element']
        });

        this.addCapability({
            id: 'fillWithForce',
            name: 'fillWithForce',
            type: 'action',
            className: 'CSWebElement',
            description: 'Force fill bypassing actionability checks',
            signature: 'async fillWithForce(value: string): Promise<void>',
            whenToUse: 'When input is readonly or disabled in DOM but needs filling',
            alternatives: ['fill'],
            useCases: ['Readonly inputs', 'Custom input components'],
            examples: ['await input.fillWithForce("value");'],
            benefits: ['Bypasses checks', 'Works with readonly fields']
        });

        // Select Methods (7+ variants)
        this.addCapability({
            id: 'selectOptionByLabel',
            name: 'selectOptionByLabel',
            type: 'action',
            className: 'CSWebElement',
            description: 'Select dropdown option by visible label text',
            signature: 'async selectOptionByLabel(label: string | string[]): Promise<string[]>',
            whenToUse: 'Selecting by user-visible text (most user-friendly)',
            alternatives: ['selectOptionByValue', 'selectOptionByIndex'],
            useCases: ['Country dropdowns', 'Category selection', 'Any user-facing dropdown'],
            examples: ['await dropdown.selectOptionByLabel("United States");'],
            benefits: ['User-centric', 'Readable tests', 'Matches user behavior']
        });

        this.addCapability({
            id: 'selectOptionByValue',
            name: 'selectOptionByValue',
            type: 'action',
            className: 'CSWebElement',
            description: 'Select dropdown option by value attribute',
            signature: 'async selectOptionByValue(value: string | string[]): Promise<string[]>',
            whenToUse: 'When you know the option value',
            alternatives: ['selectOptionByLabel', 'selectOptionByIndex'],
            useCases: ['Programmatic selection', 'Known option values'],
            examples: ['await dropdown.selectOptionByValue("us");'],
            benefits: ['Precise selection', 'Works when labels change']
        });

        this.addCapability({
            id: 'selectOptionByIndex',
            name: 'selectOptionByIndex',
            type: 'action',
            className: 'CSWebElement',
            description: 'Select dropdown option by index position',
            signature: 'async selectOptionByIndex(index: number | number[]): Promise<string[]>',
            whenToUse: 'When position is known (less recommended)',
            alternatives: ['selectOptionByLabel', 'selectOptionByValue'],
            useCases: ['Position-based selection', 'Testing all options'],
            examples: ['await dropdown.selectOptionByIndex(2);'],
            benefits: ['Simple for testing', 'Index-based access']
        });

        // File Upload Methods (8+ variants)
        this.addCapability({
            id: 'uploadFile',
            name: 'uploadFile',
            type: 'action',
            className: 'CSWebElement',
            description: 'Upload a single file',
            signature: 'async uploadFile(filePath: string): Promise<void>',
            whenToUse: 'Single file upload scenarios',
            alternatives: ['uploadFiles', 'setInputFiles'],
            useCases: ['Profile picture upload', 'Document upload', 'Single attachment'],
            examples: ['await fileInput.uploadFile("./documents/report.pdf");'],
            benefits: ['Semantic name', 'Validates file exists', 'Clear intent']
        });

        this.addCapability({
            id: 'uploadFiles',
            name: 'uploadFiles',
            type: 'action',
            className: 'CSWebElement',
            description: 'Upload multiple files',
            signature: 'async uploadFiles(filePaths: string[]): Promise<void>',
            whenToUse: 'Multiple file upload scenarios',
            alternatives: ['uploadFile', 'setInputFiles'],
            useCases: ['Batch upload', 'Multiple attachments'],
            examples: ['await fileInput.uploadFiles(["file1.pdf", "file2.pdf"]);'],
            benefits: ['Multi-file support', 'Array handling', 'Clear intent']
        });

        this.addCapability({
            id: 'clearFiles',
            name: 'clearFiles',
            type: 'action',
            className: 'CSWebElement',
            description: 'Clear uploaded files',
            signature: 'async clearFiles(): Promise<void>',
            whenToUse: 'Removing uploaded files',
            alternatives: ['setInputFiles'],
            useCases: ['Reset file upload', 'Clear attachments'],
            examples: ['await fileInput.clearFiles();'],
            benefits: ['Semantic name', 'Clear intent']
        });

        // CSElementFactory Methods
        this.addCapability({
            id: 'createByCSS',
            name: 'createByCSS',
            type: 'factory',
            className: 'CSElementFactory',
            description: 'Create element dynamically with CSS selector',
            signature: 'static createByCSS(selector: string, description?: string): CSWebElement',
            whenToUse: 'Dynamic element creation with CSS',
            alternatives: ['createByXPath', 'createById'],
            useCases: ['Dynamic locators', 'Conditional elements'],
            examples: ['CSElementFactory.createByCSS(".submit-btn", "Submit button")'],
            benefits: ['Dynamic creation', 'Runtime flexibility']
        });

        this.addCapability({
            id: 'createWithFilter',
            name: 'createWithFilter',
            type: 'factory',
            className: 'CSElementFactory',
            description: 'Create element with filter conditions',
            signature: 'static createWithFilter(baseSelector: string, filters: FilterOptions): CSWebElement',
            whenToUse: 'Complex filtering with hasText, visible, enabled',
            alternatives: ['createByCSS', 'createWithTemplate'],
            useCases: ['Elements with specific text', 'Filtered lists', 'Conditional elements'],
            examples: ['CSElementFactory.createWithFilter("form", { hasText: "Add User" })'],
            benefits: ['Complex filtering', 'Readable code', 'Framework handles complexity']
        });

        this.addCapability({
            id: 'createTableCell',
            name: 'createTableCell',
            type: 'factory',
            className: 'CSElementFactory',
            description: 'Create element for specific table cell',
            signature: 'static createTableCell(tableSelector: string, row: number, column: number): CSWebElement',
            whenToUse: 'Accessing table data by position',
            alternatives: ['createNth', 'createByCSS'],
            useCases: ['Data grids', 'Reports', 'Tabular data verification'],
            examples: ['CSElementFactory.createTableCell("table#results", 2, 3)'],
            benefits: ['Semantic table access', 'Row/column notation', 'Clear intent']
        });

        this.addCapability({
            id: 'createNth',
            name: 'createNth',
            type: 'factory',
            className: 'CSElementFactory',
            description: 'Create nth element matching selector',
            signature: 'static createNth(selector: string, index: number): CSWebElement',
            whenToUse: 'Accessing specific element by index',
            alternatives: ['createByCSS', 'createMultiple'],
            useCases: ['nth item in list', 'Specific element by position'],
            examples: ['CSElementFactory.createNth("button.submit", 1)'],
            benefits: ['Index-based access', 'Proper nth() handling']
        });

        this.addCapability({
            id: 'clickAll',
            name: 'clickAll',
            type: 'collection',
            className: 'CSElementFactory',
            description: 'Click all elements matching selector',
            signature: 'async clickAll(): Promise<void>',
            whenToUse: 'Batch clicking multiple elements',
            alternatives: ['getAll', 'createMultiple'],
            useCases: ['Select all checkboxes', 'Click multiple items', 'Batch operations'],
            examples: ['await factory.clickAll();'],
            benefits: ['Batch operations', 'No manual loop', 'Framework handles iteration']
        });

        this.addCapability({
            id: 'getTexts',
            name: 'getTexts',
            type: 'collection',
            className: 'CSElementFactory',
            description: 'Get text from all matching elements',
            signature: 'async getTexts(): Promise<string[]>',
            whenToUse: 'Extracting text from multiple elements',
            alternatives: ['getAll', 'getValues'],
            useCases: ['List of names', 'Multiple labels', 'Data extraction'],
            examples: ['const names = await factory.getTexts();'],
            benefits: ['Batch text extraction', 'Array result', 'Convenient']
        });
    }

    /**
     * Add capability to knowledge base
     */
    private addCapability(capability: CSCapability): void {
        this.capabilities.set(capability.id, capability);
    }

    /**
     * Find BEST capability for an action using intelligent matching
     */
    public findBestCapability(action: Action, intent?: TestIntent): CSCapabilityMatch {
        const candidates: Array<{ capability: CSCapability; score: number }> = [];

        // Score each capability
        for (const capability of this.capabilities.values()) {
            const score = this.scoreCapability(capability, action, intent);
            if (score > 0) {
                candidates.push({ capability, score });
            }
        }

        // Sort by score
        candidates.sort((a, b) => b.score - a.score);

        if (candidates.length === 0) {
            // Fallback to generic
            return this.getDefaultCapability(action);
        }

        const best = candidates[0];
        const alternatives = candidates.slice(1, 4).map(c => c.capability);

        return {
            capability: best.capability,
            confidence: best.score,
            alternatives,
            reasoning: this.explainSelection(best.capability, action)
        };
    }

    /**
     * Score how well a capability matches an action
     */
    private scoreCapability(capability: CSCapability, action: Action, intent?: TestIntent): number {
        let score = 0;

        // Exact method match
        if (capability.name === action.method) {
            score += 0.5;
        }

        // Action type match
        if (this.actionTypeMatches(capability, action)) {
            score += 0.3;
        }

        // Options match
        if (this.hasMatchingOptions(capability, action)) {
            score += 0.2;
        }

        // Intent alignment
        if (intent && this.alignsWithIntent(capability, intent)) {
            score += 0.1;
        }

        return score;
    }

    /**
     * Check if action type matches capability
     */
    private actionTypeMatches(capability: CSCapability, action: Action): boolean {
        if (action.type === 'click' && capability.name.includes('click')) return true;
        if (action.type === 'fill' && capability.name.includes('fill')) return true;
        if (action.type === 'select' && capability.name.includes('select')) return true;
        if (action.type === 'file-upload' && capability.name.includes('upload')) return true;
        return false;
    }

    /**
     * Check if capability matches action options
     */
    private hasMatchingOptions(capability: CSCapability, action: Action): boolean {
        // Force option
        if (action.options.force && capability.name.includes('Force')) return true;

        // Timeout option
        if (action.options.timeout && capability.name.includes('Timeout')) return true;

        // Modifiers option
        if (action.options.modifiers?.includes('Control') && capability.name.includes('Control')) return true;

        // Button option
        if (action.options.button === 'right' && capability.name === 'rightClick') return true;

        return false;
    }

    /**
     * Check if capability aligns with test intent
     */
    private alignsWithIntent(capability: CSCapability, intent: TestIntent): boolean {
        // For authentication, prefer semantic methods
        if (intent.type === 'authentication' && capability.benefits.includes('Semantic')) return true;

        // For CRUD, prefer clear intent methods
        if (intent.type === 'crud' && capability.benefits.includes('Clear intent')) return true;

        return false;
    }

    /**
     * Get default fallback capability
     */
    private getDefaultCapability(action: Action): CSCapabilityMatch {
        const defaultCap = this.capabilities.get(action.method) || this.capabilities.get('click')!;

        return {
            capability: defaultCap,
            confidence: 0.5,
            alternatives: [],
            reasoning: `Using default ${action.method} method`
        };
    }

    /**
     * Explain why this capability was selected
     */
    private explainSelection(capability: CSCapability, action: Action): string {
        const reasons: string[] = [];

        if (capability.name === action.method) {
            reasons.push('Exact method match');
        }

        if (action.options.force && capability.name.includes('Force')) {
            reasons.push('Force option detected');
        }

        if (capability.whenToUse) {
            reasons.push(capability.whenToUse);
        }

        return reasons.join('; ');
    }

    /**
     * Get all capabilities
     */
    public getAllCapabilities(): CSCapability[] {
        return Array.from(this.capabilities.values());
    }

    /**
     * Get capability by ID
     */
    public getCapability(id: string): CSCapability | undefined {
        return this.capabilities.get(id);
    }
}
