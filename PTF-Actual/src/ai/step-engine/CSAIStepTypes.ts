/**
 * CSAIStepTypes - Type definitions for the AI Step Engine
 *
 * Provides all type definitions for grammar-based NLP parsing,
 * accessibility tree element matching, and action execution.
 *
 * @module ai/step-engine
 */

import { Locator, Page } from 'playwright';

// ============================================================================
// STEP CATEGORIES & INTENTS
// ============================================================================

/** High-level category of a parsed step */
export type StepCategory = 'action' | 'assertion' | 'query';

/** Action intents - user wants to interact with an element */
export type ActionIntent =
    | 'click'
    | 'double-click'
    | 'right-click'
    | 'type'
    | 'fill'
    | 'clear'
    | 'select'
    | 'check'
    | 'uncheck'
    | 'toggle'
    | 'hover'
    | 'scroll'
    | 'scroll-to'
    | 'press-key'
    | 'navigate'
    | 'upload'
    | 'drag'
    | 'focus'
    | 'wait-for'
    | 'wait-seconds'
    | 'wait-url-change'
    | 'wait-text-change'
    | 'wait-page-load'
    | 'switch-tab'
    | 'open-new-tab'
    | 'close-tab'
    | 'switch-browser'
    | 'clear-session'
    | 'switch-frame'
    | 'switch-main-frame'
    | 'set-variable'
    | 'take-screenshot'
    | 'clear-cookies'
    | 'set-cookie'
    | 'clear-storage'
    | 'set-storage-item'
    | 'api-call'
    | 'execute-js'
    // Database operations (Phase 2)
    | 'db-query'
    | 'db-query-file'
    | 'db-update'
    | 'db-resolve-or-use'
    // File operations (Phase 3)
    | 'parse-csv'
    | 'parse-xlsx'
    | 'parse-file'
    // Context operations (Phase 4)
    | 'set-context-field'
    | 'copy-context-var'
    | 'clear-context-var'
    // Mapping operations (Phase 6)
    | 'load-mapping'
    | 'transform-data'
    | 'prepare-test-data'
    // Helper/Orchestration (Phase 7)
    | 'call-helper'
    // Table extensions (Phase 8)
    | 'expand-row'
    | 'collapse-row'
    | 'sort-column'
    // Form capture (Phase 9)
    | 'capture-form-data'
    // API extensions (Phase 11)
    | 'api-call-file'
    | 'api-upload'
    | 'api-download'
    | 'api-set-context'
    | 'api-set-header'
    | 'api-set-auth'
    | 'api-clear-context'
    | 'api-poll'
    | 'api-save-response'
    | 'api-save-request'
    | 'api-print'
    | 'api-chain'
    | 'api-execute-chain'
    | 'api-soap';

/** Assertion intents - user wants to verify something */
export type AssertionIntent =
    | 'verify-visible'
    | 'verify-hidden'
    | 'verify-text'
    | 'verify-value'
    | 'verify-enabled'
    | 'verify-disabled'
    | 'verify-checked'
    | 'verify-unchecked'
    | 'verify-count'
    | 'verify-contains'
    | 'verify-not-contains'
    | 'verify-not-present'
    | 'verify-url'
    | 'verify-title'
    | 'verify-attribute'
    | 'verify-css'
    | 'verify-matches'
    | 'verify-selected-option'
    | 'verify-dropdown-options'
    | 'verify-url-param'
    | 'verify-table-cell'
    | 'verify-download'
    | 'verify-download-content'
    | 'verify-api-response'
    // Database assertions (Phase 2)
    | 'verify-db-exists'
    | 'verify-db-not-exists'
    | 'verify-db-field'
    | 'verify-db-count'
    // File assertions (Phase 3)
    | 'verify-file-name-pattern'
    | 'verify-file-row-count'
    | 'verify-data-match'
    // Comparison assertions (Phase 5)
    | 'verify-tolerance'
    | 'verify-context-field'
    | 'verify-context-match'
    | 'verify-count-match'
    | 'verify-accumulated'
    // Table extensions (Phase 8)
    | 'verify-column-sorted'
    | 'verify-column-exists'
    // API extensions (Phase 11)
    | 'verify-api-schema';

/** Query intents - user wants to extract data */
export type QueryIntent =
    | 'get-text'
    | 'get-value'
    | 'get-attribute'
    | 'get-count'
    | 'get-list'
    | 'get-url'
    | 'get-title'
    | 'check-exists'
    | 'get-url-param'
    | 'get-table-data'
    | 'get-table-cell'
    | 'get-table-column'
    | 'get-table-row-count'
    | 'generate-data'
    | 'get-cookie'
    | 'get-storage-item'
    | 'get-download-path'
    | 'get-api-response'
    | 'evaluate-js'
    // Database queries (Phase 2)
    | 'get-db-value'
    | 'get-db-row'
    | 'get-db-rows'
    | 'get-db-count'
    // File queries (Phase 3)
    | 'get-file-row-count'
    | 'get-file-headers'
    // Context queries (Phase 4)
    | 'get-context-field'
    | 'get-context-count'
    | 'get-context-keys'
    // Mapping queries (Phase 6)
    | 'get-mapped-value'
    // Helper queries (Phase 7)
    | 'get-helper-value';

/** Union of all intent types */
export type StepIntent = ActionIntent | AssertionIntent | QueryIntent;

// ============================================================================
// PARSED STEP STRUCTURE
// ============================================================================

/** Result of parsing a natural language instruction */
export interface ParsedStep {
    /** High-level category */
    category: StepCategory;
    /** Specific intent */
    intent: StepIntent;
    /** Target element description */
    target: ElementTarget;
    /** Parameters for the action/assertion/query */
    parameters: StepParameters;
    /** Original instruction text */
    rawText: string;
    /** Parsing confidence (0-1) */
    confidence: number;
    /** Optional modifiers */
    modifiers: StepModifiers;
    /** Which grammar rule matched (null if NLP fallback) */
    matchedRuleId: string | null;
}

/** Description of the target element */
export interface ElementTarget {
    /** Element type hint (button, input, link, etc.) */
    elementType?: string;
    /** Text descriptors to identify the element */
    descriptors: string[];
    /** Ordinal reference (1st, 2nd, 3rd, etc.) */
    ordinal?: number;
    /** Position context (top, bottom, left, right) */
    position?: string;
    /** Relative to another element */
    relativeTo?: string;
    /** Relationship type (near, inside, after, before) */
    relation?: string;
    /** Raw target text before parsing */
    rawText: string;
}

/** Parameters extracted from the instruction */
export interface StepParameters {
    /** Value to type, select, or fill */
    value?: string;
    /** Expected value for assertions */
    expectedValue?: string;
    /** Attribute name for get-attribute */
    attribute?: string;
    /** Keyboard key for press-key */
    key?: string;
    /** URL for navigation */
    url?: string;
    /** Expected count for verify-count */
    count?: number;
    /** Timeout override in ms */
    timeout?: number;
    /** File path for upload */
    filePath?: string;
    /** Drag target element description */
    dragTarget?: string;
    /** Tab index for switch-tab (0-based) */
    tabIndex?: number;
    /** Browser type for switch-browser (chrome, firefox, edge, webkit) */
    browserType?: string;
    /** URL to navigate after context clear */
    loginUrl?: string;
    /** CSS property name for verify-css */
    cssProperty?: string;
    /** Regex pattern string for verify-matches */
    regexPattern?: string;
    /** URL parameter name for get-url-param / verify-url-param */
    urlParam?: string;
    /** 1-based row index for table operations */
    rowIndex?: number;
    /** Column header name or 1-based index for table operations */
    columnRef?: string;
    /** Table description for row-scoped actions (e.g., "Tranche Balances") */
    tableRef?: string;
    /** Data type for generate-data (uuid, timestamp, random-string, etc.) */
    dataType?: string;
    /** Variable name for set-variable */
    variableName?: string;
    /** Screenshot file name */
    screenshotName?: string;
    /** Frame CSS selector, name, or index for switch-frame */
    frameSelector?: string;
    /** Cookie name for get-cookie */
    cookieName?: string;
    /** Storage type: 'local' or 'session' */
    storageType?: 'local' | 'session';
    /** Storage key for get/set storage item */
    storageKey?: string;
    /** Expected file name for download verification */
    fileName?: string;
    /** Expected content substring for download content verification */
    fileContent?: string;
    /** HTTP method for API calls (GET, POST, PUT, DELETE, PATCH) */
    httpMethod?: string;
    /** API endpoint URL */
    apiUrl?: string;
    /** Request body (JSON string) */
    requestBody?: string;
    /** JSONPath for response extraction */
    jsonPath?: string;
    /** JavaScript code to execute */
    script?: string;
    /** Random data generation length */
    length?: number;
    /** Random number range minimum */
    rangeMin?: number;
    /** Random number range maximum */
    rangeMax?: number;
    /** Page load state for wait-page-load (domcontentloaded, load, networkidle) */
    loadState?: string;

    // ========================================================================
    // Database operations (Phase 2)
    // ========================================================================
    /** Database connection alias (e.g., 'PRIMARY_DB', 'STAGING_DB') */
    dbAlias?: string;
    /** Named query key or direct SQL */
    dbQuery?: string;
    /** JSON array of query parameters */
    dbParams?: string;
    /** Column/field name to extract or verify */
    dbField?: string;
    /** Path to .sql file */
    dbFile?: string;

    // ========================================================================
    // Comparison (Phase 5)
    // ========================================================================
    /** Numeric tolerance for comparison (e.g., 0.0001) */
    tolerance?: number;
    /** Comparison operator: 'equals'|'contains'|'not-equals'|'greater-than'|'less-than'|'matches' */
    comparisonOp?: string;

    // ========================================================================
    // Context operations (Phase 4)
    // ========================================================================
    /** Source context variable name */
    sourceContextVar?: string;
    /** Target context variable name */
    targetContextVar?: string;
    /** Field name within a context variable */
    contextField?: string;
    /** Row index within an array context variable */
    contextRowIndex?: number;
    /** Fields to exclude from comparison (comma-separated) */
    exceptFields?: string;
    /** Fields to compare order-independently (comma-separated) */
    orderIndependentFields?: string;
    /** Key fields for row matching in array comparison (comma-separated) */
    keyFields?: string;

    // ========================================================================
    // Mapping operations (Phase 6)
    // ========================================================================
    /** Path to mapping file (YAML/JSON/Excel/CSV) */
    mappingFile?: string;
    /** Sheet name in Excel mapping file */
    mappingSheet?: string;

    // ========================================================================
    // Data generation extensions (Phase 4)
    // ========================================================================
    /** Number of decimal places for random decimal */
    decimalPlaces?: number;
    /** Number format pattern (e.g., 'x.0yy') */
    numberFormat?: string;
    /** TOTP secret for MFA code generation */
    totpSecret?: string;
    /** Date format pattern (e.g., 'MM/DD/YYYY') */
    dateFormat?: string;
    /** Offset in business days (positive = future, negative = past) */
    businessDaysOffset?: number;
    /** Separator for concatenation operations */
    separator?: string;

    // ========================================================================
    // Helper/Orchestration (Phase 7)
    // ========================================================================
    /** Helper class name */
    helperClass?: string;
    /** Helper method name */
    helperMethod?: string;
    /** JSON arguments for helper call */
    helperArgs?: string;

    // ========================================================================
    // Table extensions (Phase 8)
    // ========================================================================
    /** Expand or collapse action for table rows */
    expandAction?: 'expand' | 'collapse';
    /** Element type within a table cell: link, checkbox, dropdown, radio */
    cellElementType?: 'link' | 'checkbox' | 'dropdown' | 'radio';

    // ========================================================================
    // Form capture (Phase 9)
    // ========================================================================
    /** Comma-separated list of field names to capture */
    captureFields?: string;
    /** Scope for form capture (section name, dialog name) */
    captureScope?: string;

    // ========================================================================
    // Sort verification (Phase 8)
    // ========================================================================
    /** Sort direction: ascending or descending */
    sortDirection?: 'ascending' | 'descending';
    /** Data type for sort comparison: string, number, or date */
    sortDataType?: 'string' | 'number' | 'date';

    // ========================================================================
    // API extensions (Phase 11)
    // ========================================================================
    /** Named API context */
    apiContext?: string;
    /** Auth type identifier */
    apiAuthType?: string;
    /** JSON auth parameters */
    apiAuthParams?: string;
    /** Path to request body file */
    apiPayloadFile?: string;
    /** Path to save response */
    apiResponseSavePath?: string;
    /** Print target: 'request'|'response'|'headers'|'body' */
    apiPrintTarget?: string;
    /** JSONPath field to poll */
    apiPollField?: string;
    /** Expected value for polling */
    apiPollExpected?: string;
    /** Polling interval in ms */
    apiPollInterval?: number;
    /** Max polling time in ms */
    apiPollMaxTime?: number;
    /** JSON schema file path */
    apiSchemaFile?: string;
    /** SOAP operation name */
    soapOperation?: string;
    /** JSON SOAP parameters */
    soapParams?: string;
    /** XPath expression for XML responses */
    xpathExpression?: string;
    /** API chain definition file */
    apiChainFile?: string;
    /** Query parameters string (key=value&key=value) */
    apiQueryParams?: string;
    /** Form data string (key=value&key=value) */
    apiFormData?: string;
}

/** Modifiers that affect execution behavior */
export interface StepModifiers {
    /** Force the action (bypass actionability checks) */
    force?: boolean;
    /** Use exact text matching */
    exact?: boolean;
    /** Negate the assertion (e.g., "NOT visible") */
    negated?: boolean;
    /** Case-insensitive matching */
    caseInsensitive?: boolean;
}

// ============================================================================
// ELEMENT MATCHING
// ============================================================================

/** Result of matching a target to a page element */
export interface MatchedElement {
    /** Playwright locator for the matched element (may be narrowed to .first()/.nth()) */
    locator: Locator;
    /** Broad locator before narrowing (for verify-count). Falls back to locator if not set. */
    broadLocator?: Locator;
    /** Match confidence (0-1) */
    confidence: number;
    /** Which matching strategy succeeded */
    method: MatchMethod;
    /** Human-readable description */
    description: string;
    /** Alternative matches with lower confidence */
    alternatives: AlternativeMatch[];
}

/** Alternative element match */
export interface AlternativeMatch {
    locator: Locator;
    confidence: number;
    method: MatchMethod;
    description: string;
}

/** How the element was matched */
export type MatchMethod =
    | 'accessibility-tree'
    | 'intelligent-ai'
    | 'semantic-locator'
    | 'pattern-matcher'
    | 'text-search'
    | 'role-search'
    | 'table-row-resolution';

// ============================================================================
// ACTION EXECUTION
// ============================================================================

/** Result of executing an action/assertion/query */
export interface ActionResult {
    /** Whether execution succeeded */
    success: boolean;
    /** Return value for queries (primitives, arrays, or complex objects for DB/file/context operations) */
    returnValue?: string | number | boolean | string[] | Record<string, any> | Record<string, any>[] | any;
    /** Error details if failed */
    error?: string;
    /** Execution duration in ms */
    duration: number;
    /** Which method was used */
    method: string;
    /** Screenshot path on failure */
    screenshotPath?: string;
}

// ============================================================================
// GRAMMAR RULES
// ============================================================================

/** A single grammar rule for parsing instructions */
export interface GrammarRule {
    /** Unique rule identifier */
    id: string;
    /** Regex pattern to match (applied after quoted string extraction + synonym normalization) */
    pattern: RegExp;
    /** Step category this rule handles */
    category: StepCategory;
    /** Intent this rule maps to */
    intent: StepIntent;
    /** Extract structured data from regex match groups */
    extract: (match: RegExpMatchArray, quotedStrings: string[]) => GrammarExtraction;
    /** Priority (lower = higher priority, matched first) */
    priority: number;
    /** Example instructions this rule handles (for documentation/testing) */
    examples: string[];
}

/** Data extracted from a grammar rule match */
export interface GrammarExtraction {
    /** Target element description */
    targetText: string;
    /** Element type hint */
    elementType?: string;
    /** Value parameter */
    value?: string;
    /** Expected value for assertions */
    expectedValue?: string;
    /** Additional parameters */
    params?: Partial<StepParameters>;
    /** Modifiers */
    modifiers?: Partial<StepModifiers>;
}

// ============================================================================
// ACCESSIBILITY TREE
// ============================================================================

/** Parsed node from accessibility tree snapshot */
export interface AccessibilityNode {
    /** ARIA role */
    role: string;
    /** Accessible name */
    name: string;
    /** Node level/depth */
    level?: number;
    /** Additional properties (checked, disabled, expanded, etc.) */
    properties: Record<string, string>;
    /** Child nodes */
    children: AccessibilityNode[];
    /** Raw line from snapshot */
    rawLine: string;
    /** Line index in snapshot */
    lineIndex: number;
}

/** Score for an accessibility tree node match */
export interface AccessibilityMatchScore {
    /** The matched node */
    node: AccessibilityNode;
    /** Total score (0-1) */
    total: number;
    /** Score breakdown */
    breakdown: {
        /** Role match score (30% weight) */
        roleMatch: number;
        /** Name match score (40% weight) */
        nameMatch: number;
        /** Label match score (20% weight) */
        labelMatch: number;
        /** Position/ordinal score (10% weight) */
        positionMatch: number;
    };
}

// ============================================================================
// CONFIGURATION
// ============================================================================

/** Configuration for the AI Step Engine */
export interface CSAIStepConfig {
    /** Master enable/disable */
    enabled: boolean;
    /** Minimum confidence for element matching (0-1) */
    confidenceThreshold: number;
    /** Default timeout for actions in ms */
    timeout: number;
    /** Number of retries on failure */
    retries: number;
    /** Take screenshot on failure */
    screenshotOnFailure: boolean;
    /** Enable verbose debug logging */
    debug: boolean;
    /** Accessibility tree cache TTL in ms */
    accessibilityTreeCacheTTL: number;
    /** Parse cache TTL in ms */
    parseCacheTTL: number;
}

/** Default configuration values */
export const DEFAULT_AI_STEP_CONFIG: CSAIStepConfig = {
    enabled: true,
    confidenceThreshold: 0.6,
    timeout: 10000,
    retries: 1,
    screenshotOnFailure: true,
    debug: false,
    // Reduced from 2000ms to 500ms — SPA pages can update content without URL change,
    // and a 2s cache causes stale element matching after select/click actions
    accessibilityTreeCacheTTL: 500,
    parseCacheTTL: 300000
};

// ============================================================================
// csAI() FUNCTION OPTIONS
// ============================================================================

/** Options for the csAI() function */
export interface CSAIOptions {
    /** Playwright page instance */
    page: Page;
    /** Scenario context for variable storage (optional) */
    context?: { getVariable: (key: string) => any; setVariable: (key: string, value: any) => void };
    /** Override default timeout */
    timeout?: number;
    /** Force specific category detection */
    forceCategory?: StepCategory;
    /** Configuration overrides */
    config?: Partial<CSAIStepConfig>;
}

// ============================================================================
// ELEMENT TYPE TO ARIA ROLE MAPPING
// ============================================================================

/** Maps element type keywords to expected ARIA roles */
export const ELEMENT_TYPE_TO_ROLES: Record<string, string[]> = {
    'button': ['button'],
    'link': ['link'],
    'input': ['textbox', 'searchbox'],
    'textbox': ['textbox'],
    'field': ['textbox', 'searchbox', 'combobox'],
    'text field': ['textbox'],
    'text input': ['textbox'],
    'search': ['searchbox', 'search'],
    'searchbox': ['searchbox'],
    'checkbox': ['checkbox'],
    'radio': ['radio'],
    'radio button': ['radio'],
    'select': ['combobox', 'listbox'],
    'dropdown': ['combobox', 'listbox'],
    'combobox': ['combobox'],
    'listbox': ['listbox'],
    'tab': ['tab'],
    'menu': ['menu'],
    'menu item': ['menuitem'],
    'menuitem': ['menuitem'],
    'heading': ['heading', 'columnheader', 'rowheader', 'banner'],
    'dialog': ['dialog', 'alertdialog'],
    'modal': ['dialog'],
    'switch': ['switch'],
    'slider': ['slider'],
    'progressbar': ['progressbar'],
    'tree': ['tree'],
    'treeitem': ['treeitem'],
    'grid': ['grid'],
    'row': ['row'],
    'cell': ['cell', 'gridcell'],
    'table': ['table'],
    'alert': ['alert'],
    'tooltip': ['tooltip'],
    'img': ['img'],
    'image': ['img'],
    'navigation': ['navigation'],
    'region': ['region'],
    'banner': ['banner'],
    'form': ['form'],
    'option': ['option'],
    'list': ['list'],
    'listitem': ['listitem'],
    'list item': ['listitem'],
    'header': ['heading', 'columnheader', 'rowheader', 'banner'],
    'popup': ['dialog'],
    'toggle button': ['button'],
    'submit': ['button'],
    'submit button': ['button'],
    'section': ['region'],
    'article': ['article'],
    'main': ['main']
};

/** Maps action intents to likely target element roles (used when no element type specified) */
export const INTENT_TO_LIKELY_ROLES: Record<string, string[]> = {
    'click': ['button', 'link', 'menuitem', 'tab', 'checkbox', 'radio'],
    'double-click': ['button', 'link', 'cell', 'gridcell'],
    'right-click': ['button', 'link', 'cell', 'gridcell'],
    'type': ['textbox', 'searchbox', 'combobox'],
    'fill': ['textbox', 'searchbox', 'combobox'],
    'clear': ['textbox', 'searchbox', 'combobox'],
    'select': ['combobox', 'listbox', 'option'],
    'check': ['checkbox', 'switch'],
    'uncheck': ['checkbox', 'switch'],
    'toggle': ['checkbox', 'switch'],
    'hover': ['button', 'link', 'menuitem', 'tooltip'],
    'press-key': [],
    'navigate': [],
    'upload': ['button'],
    'drag': [],
    'focus': ['textbox', 'button', 'link'],
    'scroll': [],
    'scroll-to': [],
    'wait-seconds': [],
    'wait-url-change': [],
    'wait-text-change': [],
    'wait-page-load': [],
    'switch-tab': [],
    'open-new-tab': [],
    'close-tab': [],
    'switch-browser': [],
    'clear-session': [],
    'switch-frame': [],
    'switch-main-frame': [],
    'set-variable': [],
    'take-screenshot': [],
    // Assertion intents
    'verify-visible': [],
    'verify-hidden': [],
    'verify-not-present': [],
    'verify-text': [],
    'verify-contains': [],
    'verify-not-contains': [],
    'verify-value': ['textbox', 'combobox', 'searchbox'],
    'verify-enabled': ['button', 'link', 'textbox', 'combobox', 'checkbox', 'radio'],
    'verify-disabled': ['button', 'link', 'textbox', 'combobox', 'checkbox', 'radio'],
    'verify-checked': ['checkbox', 'radio', 'switch'],
    'verify-unchecked': ['checkbox', 'radio', 'switch'],
    'verify-count': [],
    'verify-attribute': [],
    'verify-url': [],
    'verify-title': [],
    'verify-css': [],
    'verify-matches': [],
    'verify-selected-option': ['combobox', 'listbox'],
    'verify-dropdown-options': ['combobox', 'listbox'],
    'verify-url-param': [],
    'verify-table-cell': ['cell', 'gridcell'],
    'verify-download': [],
    'verify-download-content': [],
    'verify-api-response': [],
    // Query intents
    'get-text': [],
    'get-value': ['textbox', 'combobox', 'searchbox'],
    'get-attribute': [],
    'get-count': [],
    'get-list': ['list', 'listbox'],
    'get-url': [],
    'get-title': [],
    'check-exists': [],
    'wait-for': [],
    'get-url-param': [],
    'get-table-data': ['table', 'grid'],
    'get-table-cell': ['cell', 'gridcell'],
    'get-table-column': [],
    'get-table-row-count': ['table', 'grid'],
    'generate-data': [],
    'get-cookie': [],
    'get-storage-item': [],
    'get-download-path': [],
    'get-api-response': [],
    'evaluate-js': [],
    // Remaining action intents
    'clear-cookies': [],
    'set-cookie': [],
    'clear-storage': [],
    'set-storage-item': [],
    'api-call': [],
    'execute-js': [],
    // Database operations (Phase 2)
    'db-query': [],
    'db-query-file': [],
    'db-update': [],
    'db-resolve-or-use': [],
    'verify-db-exists': [],
    'verify-db-not-exists': [],
    'verify-db-field': [],
    'verify-db-count': [],
    'get-db-value': [],
    'get-db-row': [],
    'get-db-rows': [],
    'get-db-count': [],
    // File operations (Phase 3)
    'parse-csv': [],
    'parse-xlsx': [],
    'parse-file': [],
    'verify-file-name-pattern': [],
    'verify-file-row-count': [],
    'get-file-row-count': [],
    'get-file-headers': [],
    'verify-data-match': [],
    // Context operations (Phase 4)
    'set-context-field': [],
    'copy-context-var': [],
    'clear-context-var': [],
    'get-context-field': [],
    'get-context-count': [],
    'get-context-keys': [],
    // Comparison (Phase 5)
    'verify-tolerance': [],
    'verify-context-field': [],
    'verify-context-match': [],
    'verify-count-match': [],
    'verify-accumulated': [],
    // Mapping (Phase 6)
    'load-mapping': [],
    'transform-data': [],
    'prepare-test-data': [],
    'get-mapped-value': [],
    // Helper/Orchestration (Phase 7)
    'call-helper': [],
    'get-helper-value': [],
    // Table extensions (Phase 8)
    'expand-row': ['button'],
    'collapse-row': ['button'],
    'sort-column': ['columnheader'],
    'verify-column-sorted': ['columnheader'],
    'verify-column-exists': ['columnheader'],
    // Form capture (Phase 9)
    'capture-form-data': [],
    // API extensions (Phase 11)
    'api-call-file': [],
    'api-upload': [],
    'api-download': [],
    'api-set-context': [],
    'api-set-header': [],
    'api-set-auth': [],
    'api-clear-context': [],
    'api-poll': [],
    'api-save-response': [],
    'api-save-request': [],
    'api-print': [],
    'api-chain': [],
    'api-execute-chain': [],
    'api-soap': [],
    'verify-api-schema': []
};

// ============================================================================
// SYNONYM MAP
// ============================================================================

/** Maps common synonyms to canonical action keywords */
export const ACTION_SYNONYMS: Record<string, string> = {
    // Click synonyms
    'tap': 'click',
    'press': 'click',
    'hit': 'click',
    'push': 'click',
    // Type synonyms
    'enter': 'type',
    'input': 'type',
    'write': 'type',
    'put': 'type',
    // Select synonyms
    'pick': 'select',
    'choose': 'select',
    // Verify synonyms
    'ensure': 'verify',
    'confirm': 'verify',
    'assert': 'verify',
    'validate': 'verify',
    'expect': 'verify',
    'should': 'verify',
    'must': 'verify',
    // Check synonyms (for checkboxes)
    'mark': 'check',
    'tick': 'check',
    // Uncheck synonyms
    'untick': 'uncheck',
    'unmark': 'uncheck',
    'deselect': 'uncheck',
    // Get synonyms
    'read': 'get',
    'extract': 'get',
    'fetch': 'get',
    'retrieve': 'get',
    'capture': 'get',
    'grab': 'get',
    // Navigate synonyms
    'go': 'navigate',
    'open': 'navigate',
    'visit': 'navigate',
    'browse': 'navigate',
    // Hover synonyms
    'mouse over': 'hover',
    'mouseover': 'hover',
    // Clear synonyms
    'empty': 'clear',
    'erase': 'clear',
    'remove': 'clear',
    // Wait synonyms
    'wait': 'wait',
    'pause': 'wait',
    // Double-click synonyms
    'double click': 'double-click',
    'doubleclick': 'double-click',
    'dbl click': 'double-click',
    'dblclick': 'double-click',
    // Right-click synonyms
    'right click': 'right-click',
    'rightclick': 'right-click',
    'context click': 'right-click',
    // Scroll synonyms
    'scroll down': 'scroll',
    'scroll up': 'scroll',
    // Focus synonyms
    'focus on': 'focus',
    'set focus': 'focus'
};

/** Maps element type synonyms to canonical names */
export const ELEMENT_TYPE_SYNONYMS: Record<string, string> = {
    'btn': 'button',
    'buton': 'button',
    'buttn': 'button',
    'lnk': 'link',
    'hyperlink': 'link',
    'anchor': 'link',
    'txt': 'input',
    'textfield': 'input',
    'text box': 'input',
    'text field': 'input',
    'text input': 'input',
    'inputfield': 'input',
    'input field': 'input',
    'combo box': 'dropdown',
    'drop down': 'dropdown',
    'drop-down': 'dropdown',
    'select box': 'dropdown',
    'selectbox': 'dropdown',
    'combo': 'dropdown',
    'chk': 'checkbox',
    'check box': 'checkbox',
    'check-box': 'checkbox',
    'rdo': 'radio',
    'radio btn': 'radio',
    'radio-button': 'radio',
    'dlg': 'dialog',
    'popup': 'dialog',
    'pop-up': 'dialog',
    'modal dialog': 'dialog',
    'hdr': 'heading',
    'header': 'heading',
    'title': 'heading',
    'img': 'image',
    'pic': 'image',
    'picture': 'image',
    'icon': 'image',
    'nav': 'navigation',
    'navbar': 'navigation',
    'nav bar': 'navigation',
    'menu item': 'menuitem',
    'menu-item': 'menuitem',
    'menuentry': 'menuitem',
    'tab item': 'tab',
    'toggle': 'switch',
    'toggleswitch': 'switch',
    'toggle switch': 'switch'
};

// ============================================================================
// ORDINAL MAP
// ============================================================================

/** Maps ordinal words to numbers */
export const ORDINAL_MAP: Record<string, number> = {
    'first': 1, '1st': 1,
    'second': 2, '2nd': 2,
    'third': 3, '3rd': 3,
    'fourth': 4, '4th': 4,
    'fifth': 5, '5th': 5,
    'sixth': 6, '6th': 6,
    'seventh': 7, '7th': 7,
    'eighth': 8, '8th': 8,
    'ninth': 9, '9th': 9,
    'tenth': 10, '10th': 10,
    'last': -1
};
