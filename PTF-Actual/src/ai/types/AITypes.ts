/**
 * Comprehensive AI Type Definitions
 * Used across all AI modules for intelligent test automation
 */

import { Locator, Page, ElementHandle } from 'playwright';
import { PageDiagnosticData } from '../../diagnostics/CSPageDiagnostics';

// ============================================================================
// ELEMENT FEATURES (64 Dimensions)
// ============================================================================

export interface ElementFeatures {
    text: TextFeatures;
    visual: VisualFeatures;
    structural: StructuralFeatures;
    semantic: SemanticFeatures;
    context: ContextFeatures;
    timestamp: number;
}

// Text Features (7 dimensions)
export interface TextFeatures {
    content: string;
    visibleText: string;
    ariaLabel?: string;
    title?: string;
    placeholder?: string;
    value?: string;
    alt?: string;
}

// Visual Features (15 dimensions)
export interface VisualFeatures {
    isVisible: boolean;
    boundingBox: { x: number; y: number; width: number; height: number } | null;
    zIndex: number;
    opacity: number;
    backgroundColor: string;
    color: string;
    fontSize: string;
    fontWeight: string;
    hasHighContrast: boolean;
    hasAnimation: boolean;
    display: string;
    position: string;
    cursor: string;
    inViewport: boolean;
    visualWeight: number;
}

// Structural Features (20 dimensions)
export interface StructuralFeatures {
    tagName: string;
    attributes: Record<string, string>;
    classList: string[];
    id: string;
    isInteractive: boolean;
    hasChildren: boolean;
    childCount: number;
    depth: number;
    path: string[];
    role?: string | null;
    formElement: boolean;
    inputType?: string;
    href?: string;
    src?: string;
    disabled?: boolean;
    readOnly?: boolean;
    checked?: boolean;
    selected?: boolean;
    siblingCount: number;
    siblingIndex: number;
}

// Semantic Features (12 dimensions)
export interface SemanticFeatures {
    role: string;
    ariaLabel?: string | null;
    ariaDescribedBy?: string | null;
    ariaLabelledBy?: string | null;
    isLandmark: boolean;
    headingLevel: number;
    listItem: boolean;
    listContainer: boolean;
    tableCell: boolean;
    tableRow: boolean;
    semanticType: string;
    isRequired?: boolean;
}

// Context Features (10 dimensions)
export interface ContextFeatures {
    parentTag: string;
    parentText: string;
    siblingTexts: string[];
    nearbyHeading: string;
    labelText: string;
    formId: string;
    tableHeaders: string[] | string;
    nearestLandmark: { role: string; id: string } | null;
    precedingText: string;
    followingText: string;
    // New deep context fields
    surroundingText?: string;
    hasLabel?: boolean;
    semanticContext?: string;
    nearbyHeadings?: string;
    testId?: string;
    innerText?: string;
    // Advanced context fields (tables, frameworks, shadow DOM, iframes)
    tableContext?: string;
    tableRowIndex?: number;
    tableCellIndex?: number;
    frameworkHints?: string;
    componentLibrary?: string;
    inShadowDOM?: boolean;
    shadowRootHost?: string;
    inIframe?: boolean;
    hasLoadingIndicator?: boolean;
}

// ============================================================================
// NLP (Natural Language Processing)
// ============================================================================

export type IntentType = 'click' | 'type' | 'select' | 'check' | 'uncheck' |
    'hover' | 'navigate' | 'validate' | 'extract' | 'wait';

export interface NLPResult {
    intent: IntentType;
    elementType?: string;
    keywords: string[];
    visualCues: VisualCues;
    positionCues: PositionCues;
    textContent?: string;
    confidence: number;
    expectedRoles?: string[];
    formContext: boolean;
}

export interface VisualCues {
    colors?: string[];          // ["red", "blue"]
    sizes?: string[];           // ["large", "small"]
    shapes?: string[];          // ["button", "circle"]
}

export interface PositionCues {
    position?: string;          // "top", "bottom", "left", "right"
    relativeTo?: string;        // "email field", "header"
    relation?: string;          // "above", "below", "near"
}

// ============================================================================
// INTELLIGENT HEALING
// ============================================================================

export interface IntelligentHealingResult {
    success: boolean;
    strategy: string;
    confidence: number;
    healedLocator?: string;
    originalLocator?: string;
    attempts: number;
    duration: number;
    diagnosticContext?: PageDiagnosticData;
    learnedFrom?: string;
    alternativeLocators?: Array<{
        locator: string;
        confidence: number;
    }>;
}

export interface HealingStrategy {
    name: string;
    priority: number;
    apply(context: HealingContext): Promise<HealingAttemptResult>;
}

export interface HealingContext {
    element: any;  // CSWebElement
    page: Page;
    originalLocator: string;
    features?: ElementFeatures;
    diagnostics?: PageDiagnosticData;
    failureReason: string;
    attemptedStrategies: Set<string>;
}

export interface HealingAttemptResult {
    success: boolean;
    locator?: string;
    confidence: number;
    duration: number;
}

// ============================================================================
// FAILURE ANALYSIS
// ============================================================================

export interface FailureAnalysis {
    failureType: FailureType;
    healable: boolean;
    confidence: number;
    suggestedStrategies: string[];
    rootCause: string;
    context: FailureContext;
    diagnosticInsights: string[];
}

export type FailureType =
    | 'ElementNotFound'
    | 'ElementNotVisible'
    | 'ElementNotInteractive'
    | 'Timeout'
    | 'NetworkError'
    | 'JavaScriptError'
    | 'ModalBlocking'
    | 'UnexpectedState'
    | 'Unknown';

export interface FailureContext {
    error: Error;
    step: string;
    url: string;
    timestamp: Date;
    screenshots?: string[];
    diagnostics?: PageDiagnosticData;
}

// ============================================================================
// SIMILARITY & SCORING
// ============================================================================

export interface SimilarityScore {
    overall: number;
    breakdown: {
        text: number;
        visual: number;
        structural: number;
        semantic: number;
        context: number;
    };
}

export interface SimilarityWeights {
    text: number;
    visual: number;
    structural: number;
    semantic: number;
    context: number;
}

// Default weights
export const DEFAULT_SIMILARITY_WEIGHTS: SimilarityWeights = {
    text: 0.30,
    visual: 0.20,
    structural: 0.25,
    semantic: 0.15,
    context: 0.10
};

// ============================================================================
// PATTERNS
// ============================================================================

export interface UIPattern {
    name: string;
    description: string;
    selectors: string[];
    attributes: Record<string, string>;
    tags: string[];
    structure?: {
        parent?: string;
        children?: string[];
        siblings?: string[];
    };
    confidence: number;
    weight: number;
}

export interface PatternMatch {
    pattern: UIPattern;
    confidence: number;
    element: ElementHandle;
    matchedAttributes: string[];
}

// ============================================================================
// LEARNING & HISTORY
// ============================================================================

export interface AIHistoryEntry {
    id: string;
    timestamp: Date;
    operation: AIOperationType;
    elementDescription: string;
    originalLocator?: string;
    healedLocator?: string;
    strategy: string;
    success: boolean;
    confidence: number;
    duration: number;
    context: {
        url: string;
        testName: string;
        stepText: string;
        featureName: string;
    };
}

export type AIOperationType = 'identification' | 'healing' | 'analysis' | 'prediction' | 'learning';

export interface AIOperation {
    id: string;
    type: AIOperationType;
    timestamp: Date;
    duration: number;
    success: boolean;
    confidence?: number;
    details: any;
    stepId?: string;
    scenarioId?: string;
}

export interface FragileElement {
    description: string;
    locator: string;
    healCount: number;
    lastHealed: Date;
    successRate: number;
    commonFailures: string[];
    suggestedFix?: string;
}

export interface StrategyEffectiveness {
    strategy: string;
    attempts: number;
    successes: number;
    failures: number;
    successRate: number;
    averageConfidence: number;
    averageDuration: number;
    elementTypes: Record<string, number>;
}

// ============================================================================
// PREDICTION
// ============================================================================

export interface PredictionResult {
    willFail: boolean;
    confidence: number;
    reason?: string;
    suggestedLocator?: string;
    fragilityScore: number;
}

export interface FragilityScore {
    score: number;              // 0-1 (0 = stable, 1 = very fragile)
    healCount: number;
    lastHealDate?: Date;
    failureRate: number;
    locatorStability: number;   // How often locator changes
    factors: string[];          // Why it's fragile
}

// ============================================================================
// DOM ANALYSIS
// ============================================================================

export interface DOMAnalysisResult {
    hierarchy: ElementInfo;
    forms: FormInfo[];
    tables: TableInfo[];
    navigation: NavigationInfo[];
    metrics: DOMMetrics;
    semanticMap: SemanticMap;
    timestamp: number;
}

export interface ElementInfo {
    tagName: string;
    id: string;
    className: string;
    text: string;
    visible: boolean;
    interactive: boolean;
    depth: number;
    path: string[];
    children: ElementInfo[];
}

export interface FormInfo {
    id: string;
    name: string;
    action: string;
    method: string;
    fields: Array<{
        name: string;
        type: string;
        required: boolean;
        label?: string;
    }>;
}

export interface TableInfo {
    id: string;
    rows: number;
    columns: number;
    headers: string[];
    hasCaption: boolean;
}

export interface NavigationInfo {
    id: string;
    role: string;
    links: Array<{
        text: string;
        href: string;
        active: boolean;
    }>;
}

export interface DOMMetrics {
    totalElements: number;
    visibleElements: number;
    interactableElements: number;
    forms: number;
    tables: number;
    images: number;
    links: number;
    buttons: number;
    inputs: number;
    maxDepth: number;
    averageDepth: number;
}

export interface SemanticMap {
    landmarks: Array<{
        role: string;
        label: string;
        selector: string;
    }>;
    headings: Array<{
        level: number;
        text: string;
        selector: string;
    }>;
    regions: Array<{
        role: string;
        label: string;
    }>;
}

// ============================================================================
// AI CONTEXT
// ============================================================================

export interface AIContext {
    page: Page;
    url: string;
    testName: string;
    scenarioName: string;
    stepText: string;
    previousSteps?: string[];
    domAnalysis?: DOMAnalysisResult;
    cache?: Map<string, any>;
}

// ============================================================================
// AI CONFIGURATION
// ============================================================================

export interface AIConfig {
    enabled: boolean;
    intelligentHealingEnabled: boolean;
    predictiveHealingEnabled: boolean;
    learningEnabled: boolean;
    patternMatchingEnabled: boolean;
    confidenceThreshold: number;
    maxHealingAttempts: number;
    healingTimeout: number;
    cacheTimeout: number;
    historyMaxEntries: number;
}

export const DEFAULT_AI_CONFIG: AIConfig = {
    enabled: true,
    intelligentHealingEnabled: true,
    predictiveHealingEnabled: false,
    learningEnabled: true,
    patternMatchingEnabled: true,
    confidenceThreshold: 0.75,
    maxHealingAttempts: 3,
    healingTimeout: 5000,
    cacheTimeout: 300000,
    historyMaxEntries: 10000
};

// ============================================================================
// REPORTING
// ============================================================================

export interface AIReportData {
    totalOperations: number;
    successfulOperations: number;
    healingAttempts: number;
    successfulHealings: number;
    averageConfidence: number;
    averageDuration: number;
    strategyEffectiveness: StrategyEffectiveness[];
    fragileElements: FragileElement[];
    timeSaved: number;
    operations: AIOperation[];
}

export interface StepAIData {
    healing?: {
        attempted: boolean;
        success: boolean;
        strategy: string;
        confidence: number;
        duration: number;
        originalLocator?: string;
        healedLocator?: string;
    };
    identification?: {
        method: string;
        confidence: number;
        alternatives: number;
        duration: number;
    };
    prediction?: {
        predicted: boolean;
        prevented: boolean;
        confidence: number;
    };
}

// ============================================================================
// ELEMENT IDENTIFICATION
// ============================================================================

export interface ElementIdentificationResult {
    locator: Locator;
    confidence: number;
    method: 'nlp' | 'visual' | 'pattern' | 'structural' | 'text';
    features: ElementFeatures;
    alternatives: Array<{
        locator: Locator;
        confidence: number;
    }>;
    duration: number;
}

// ============================================================================
// LOCATOR GENERATION
// ============================================================================

export interface GeneratedLocator {
    selector: string;
    strategy: 'css' | 'xpath' | 'text' | 'role' | 'aria' | 'testid';
    confidence: number;
    stability: number;          // How stable is this locator (0-1)
    priority: number;
}

// Note: DEFAULT_SIMILARITY_WEIGHTS and DEFAULT_AI_CONFIG are already exported above
