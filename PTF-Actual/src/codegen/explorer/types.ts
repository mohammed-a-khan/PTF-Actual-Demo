/**
 * Type definitions for Exploratory Testing System
 */

import { Page, ElementHandle, BrowserContext } from 'playwright';

// ============================================================================
// Element Types
// ============================================================================

export type ElementType =
    | 'button' | 'link' | 'input' | 'textarea' | 'select'
    | 'checkbox' | 'radio' | 'file' | 'date' | 'time'
    | 'range' | 'color' | 'search' | 'table' | 'form'
    | 'modal' | 'dropdown' | 'tab' | 'accordion' | 'menu'
    | 'card' | 'list-item' | 'image' | 'video' | 'iframe'
    | 'custom' | 'unknown';

export type ElementPurpose =
    | 'submit' | 'cancel' | 'close' | 'delete' | 'edit' | 'add' | 'save'
    | 'search' | 'filter' | 'sort' | 'navigate' | 'toggle' | 'expand'
    | 'collapse' | 'upload' | 'download' | 'login' | 'logout' | 'register'
    | 'next' | 'previous' | 'refresh' | 'reset' | 'confirm' | 'unknown';

export type FieldType =
    | 'email' | 'phone' | 'date' | 'datetime' | 'time' | 'password'
    | 'username' | 'name' | 'firstName' | 'lastName' | 'fullName'
    | 'address' | 'city' | 'state' | 'country' | 'zipCode' | 'postalCode'
    | 'creditCard' | 'cvv' | 'ssn' | 'number' | 'integer' | 'decimal'
    | 'currency' | 'percentage' | 'url' | 'text' | 'textarea' | 'search'
    | 'file' | 'image' | 'color' | 'range' | 'unknown';

export type PageType =
    | 'login' | 'register' | 'dashboard' | 'list' | 'detail' | 'form'
    | 'search' | 'settings' | 'profile' | 'checkout' | 'cart' | 'error'
    | 'landing' | 'home' | 'about' | 'contact' | 'help' | 'unknown';

export type ActionType =
    | 'click' | 'fill' | 'select' | 'check' | 'uncheck' | 'upload'
    | 'hover' | 'focus' | 'blur' | 'scroll' | 'drag' | 'drop'
    | 'keyboard' | 'wait' | 'navigate' | 'screenshot';

// ============================================================================
// Locator Types
// ============================================================================

export interface LocatorStrategy {
    type: 'role' | 'text' | 'label' | 'placeholder' | 'testid' | 'css' | 'xpath' | 'id' | 'name';
    value: string;
    confidence: number;  // 0-100
    isUnique: boolean;
}

export interface BoundingBox {
    x: number;
    y: number;
    width: number;
    height: number;
}

// ============================================================================
// Element Descriptors
// ============================================================================

export interface InteractiveElement {
    // Identification
    id: string;
    tagName: string;
    locators: LocatorStrategy[];

    // Classification
    type: ElementType;
    purpose: ElementPurpose;
    fieldType?: FieldType;

    // Content
    text?: string;
    value?: string;
    placeholder?: string;
    label?: string;
    ariaLabel?: string;
    title?: string;

    // Attributes
    attributes: Record<string, string>;
    classes: string[];

    // Visual
    boundingBox?: BoundingBox;
    isVisible: boolean;
    isEnabled: boolean;
    isRequired: boolean;

    // Relationships
    parentForm?: string;
    relatedElements: string[];

    // Validation
    validationPattern?: string;
    minLength?: number;
    maxLength?: number;
    min?: number;
    max?: number;
}

export interface FormDescriptor {
    id: string;
    name?: string;
    action?: string;
    method?: string;
    fields: InteractiveElement[];
    submitButton?: InteractiveElement;
    cancelButton?: InteractiveElement;
    formType: 'login' | 'register' | 'search' | 'filter' | 'crud' | 'contact' | 'checkout' | 'unknown';
}

export interface TableDescriptor {
    id: string;
    headers: string[];
    rowCount: number;
    columnCount: number;
    hasActions: boolean;
    hasPagination: boolean;
    hasSearch: boolean;
    hasSort: boolean;
    entityType?: string;
}

export interface ModalDescriptor {
    id: string;
    title?: string;
    type: 'dialog' | 'alert' | 'confirm' | 'form' | 'unknown';
    hasCloseButton: boolean;
    primaryAction?: InteractiveElement;
    secondaryAction?: InteractiveElement;
}

// ============================================================================
// State Types
// ============================================================================

export interface ApplicationState {
    id: string;
    url: string;
    urlPattern: string;
    title: string;

    // Fingerprints
    domHash: string;
    contentHash: string;

    // Page analysis
    pageType: PageType;
    businessEntity?: string;

    // Discovered elements
    interactiveElements: InteractiveElement[];
    forms: FormDescriptor[];
    tables: TableDescriptor[];
    modals: ModalDescriptor[];

    // Authentication state
    isAuthenticated: boolean;

    // Timestamps
    discoveredAt: Date;
    lastVisited: Date;

    // Transitions
    incomingTransitions: string[];
    outgoingTransitions: string[];
}

export interface StateTransition {
    id: string;
    fromStateId: string;
    toStateId: string;

    // Action that caused transition
    action: {
        type: ActionType;
        elementId: string;
        locator: string;
        value?: string;
    };

    // Network activity
    apiCalls: CapturedAPI[];

    // Assertions
    suggestedAssertions: SuggestedAssertion[];

    // Metadata
    timestamp: Date;
    duration: number;
}

// ============================================================================
// API Types
// ============================================================================

export interface CapturedAPI {
    id: string;
    method: string;
    url: string;
    urlPattern: string;

    // Request
    requestHeaders: Record<string, string>;
    requestBody?: unknown;

    // Response
    status: number;
    statusText: string;
    responseHeaders: Record<string, string>;
    responseBody?: unknown;

    // Classification
    resourceType?: string;
    operation?: 'create' | 'read' | 'update' | 'delete' | 'list' | 'search' | 'auth' | 'unknown';

    // Context
    triggeredByElement?: string;
    triggeredByAction?: string;

    // Metadata
    timestamp: Date;
    duration: number;
}

// ============================================================================
// Action Types
// ============================================================================

export interface CandidateAction {
    id: string;
    element: InteractiveElement;
    actionType: ActionType;
    value?: string;

    // Scoring
    priority: number;  // 0-100
    riskLevel: 'safe' | 'moderate' | 'destructive';

    // Expectations
    expectedOutcome: string;
    expectedStateChange: boolean;
}

export interface ExecutedAction {
    candidateAction: CandidateAction;
    success: boolean;
    error?: string;

    // Results
    newStateId?: string;
    apiCalls: CapturedAPI[];
    screenshotPath?: string;

    // Timing
    startTime: Date;
    endTime: Date;
    duration: number;
}

// ============================================================================
// Assertion Types
// ============================================================================

export interface SuggestedAssertion {
    type: 'visibility' | 'text' | 'value' | 'count' | 'url' | 'title' | 'enabled' | 'checked' | 'selected' | 'attribute';
    target: string;  // Locator or description
    expected: string | number | boolean;
    confidence: number;
    gherkinStep?: string;
    playwrightCode?: string;
}

// ============================================================================
// Exploration Types
// ============================================================================

export interface ExplorationConfig {
    // Target
    url: string;
    credentials?: {
        username: string;
        password: string;
        loginUrl?: string;
        usernameSelector?: string;
        passwordSelector?: string;
        submitSelector?: string;
    };

    // Limits
    maxStates: number;
    maxDepth: number;
    maxDuration: number;  // milliseconds
    maxActionsPerState: number;

    // Strategy
    strategy: 'bfs' | 'dfs' | 'priority' | 'random';

    // Filtering
    includeUrlPatterns?: RegExp[];
    excludeUrlPatterns?: RegExp[];
    excludeSelectors?: string[];
    prioritySelectors?: string[];

    // Features
    captureScreenshots: boolean;
    captureAPIs: boolean;
    captureConsole: boolean;
    generateAssertions: boolean;

    // Output
    outputDir: string;
}

export interface ExplorationProgress {
    status: 'idle' | 'running' | 'paused' | 'completed' | 'failed';

    // Counts
    statesDiscovered: number;
    statesExplored: number;
    actionsExecuted: number;
    apisDiscovered: number;

    // Coverage
    coveragePercentage: number;

    // Timing
    startTime?: Date;
    currentDuration: number;
    estimatedRemaining?: number;

    // Current
    currentState?: string;
    currentAction?: string;

    // Errors
    errors: string[];
}

export interface ExplorationResult {
    // Session info
    sessionId: string;
    config: ExplorationConfig;

    // Discovery
    states: ApplicationState[];
    transitions: StateTransition[];
    apis: CapturedAPI[];

    // Coverage
    coverage: {
        statesDiscovered: number;
        statesFullyExplored: number;
        elementsDiscovered: number;
        elementsInteracted: number;
        apisDiscovered: number;
        coveragePercentage: number;
    };

    // Generated artifacts
    generatedFiles: {
        features: string[];
        pageObjects: string[];
        stepDefinitions: string[];
        specFiles: string[];
    };

    // Issues
    issues: {
        errors: Array<{ message: string; state: string; action?: string }>;
        warnings: string[];
        brokenLinks: string[];
        consoleErrors: string[];
    };

    // Timing
    startTime: Date;
    endTime: Date;
    duration: number;
}

// ============================================================================
// Generation Types
// ============================================================================

export interface GeneratedWorkflow {
    id: string;
    name: string;
    description: string;
    type: 'login' | 'crud' | 'search' | 'navigation' | 'form' | 'custom' | 'exploration';

    // Steps
    steps: WorkflowStep[];

    // Data
    testData: Record<string, unknown>;

    // Generated code
    featureFile?: string;
    pageObjectFile?: string;
    stepDefinitionFile?: string;
    specFile?: string;
}

export interface WorkflowStep {
    order: number;
    action: ActionType;
    target: string;
    value?: string;
    assertion?: SuggestedAssertion;
    gherkinStep: string;
}

// ============================================================================
// Self-Healing Types
// ============================================================================

export interface HealingAttempt {
    originalLocator: LocatorStrategy;
    attemptedStrategies: LocatorStrategy[];
    healedLocator?: LocatorStrategy;
    success: boolean;
    method?: 'attribute-similarity' | 'visual-similarity' | 'text-similarity' | 'position-relative';
    confidence: number;
    timestamp: Date;
}

export interface LocatorHealth {
    locator: LocatorStrategy;
    successCount: number;
    failureCount: number;
    healingCount: number;
    lastSuccess?: Date;
    lastFailure?: Date;
    healthScore: number;  // 0-100
}
