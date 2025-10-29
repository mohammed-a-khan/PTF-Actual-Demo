/**
 * Core types for CS Codegen Intelligent Transformer
 */

import * as ts from 'typescript';

// ============================================
// AST Analysis Types
// ============================================

export interface DeepCodeAnalysis {
    syntaxTree: ts.SourceFile;
    actions: Action[];
    controlFlow: ControlFlowGraph;
    dataFlow: DataFlowGraph;
    typeInfo: TypeInformation;
    executionPaths: ExecutionPath[];
}

export interface Action {
    id: string;
    type: string; // 'click', 'fill', 'goto', 'expect', etc.
    method: string;
    target?: LocatorInfo;
    args: any[];
    options: Record<string, any>;
    lineNumber: number;
    expression: string;
    astNode: ts.Node;
}

export interface LocatorInfo {
    type: string; // 'getByRole', 'getByPlaceholder', 'locator', etc.
    selector: string;
    options?: Record<string, any>;
    chain?: LocatorChainStep[];
}

export interface LocatorChainStep {
    method: string; // 'filter', 'nth', 'locator', 'getByRole', etc.
    args: any[];
}

export interface ControlFlowGraph {
    nodes: CFGNode[];
    edges: CFGEdge[];
    entryNode: string;
    exitNodes: string[];
}

export interface CFGNode {
    id: string;
    type: 'statement' | 'branch' | 'loop' | 'return';
    statement: ts.Node;
    lineNumber: number;
}

export interface CFGEdge {
    from: string;
    to: string;
    condition?: string;
}

export interface DataFlowGraph {
    variables: Map<string, VariableFlow>;
    dependencies: DataDependency[];
}

export interface VariableFlow {
    name: string;
    definitions: number[]; // line numbers
    uses: number[];
    type: string;
}

export interface DataDependency {
    from: string;
    to: string;
    type: 'data' | 'control';
}

export interface TypeInformation {
    variables: Map<string, TypeInfo>;
    parameters: Map<string, TypeInfo>;
    returnTypes: Map<string, string>;
}

export interface TypeInfo {
    type: string;
    isLocator: boolean;
    isPromise: boolean;
    elementType?: string;
}

export interface ExecutionPath {
    id: string;
    actions: Action[];
    conditions: string[];
}

// ============================================
// Intent Analysis Types
// ============================================

export interface TestIntent {
    type: 'authentication' | 'form-interaction' | 'navigation' | 'crud' | 'verification' | 'generic';
    subtype: string;
    confidence: number;
    description: string;
    businessGoal?: string;
    entities?: string[];
}

export interface IntentAnalysis {
    primary: TestIntent;
    secondary: TestIntent[];
    testType: 'positive' | 'negative' | 'edge-case' | 'smoke' | 'integration';
    businessLogic: BusinessLogic;
    criticalActions: Action[];
    validations: Validation[];
    confidence: number;
}

export interface BusinessLogic {
    entities: BusinessEntity[];
    workflows: Workflow[];
    businessRules: string[];
    dataFlow: string[];
}

export interface BusinessEntity {
    name: string;
    type: 'user' | 'product' | 'order' | 'form' | 'page' | 'generic';
    properties: string[];
}

export interface Workflow {
    name: string;
    steps: string[];
    type: 'linear' | 'branching' | 'looping';
}

export interface Validation {
    type: 'assertion' | 'check' | 'verification';
    target: string;
    expected: any;
    lineNumber: number;
}

// ============================================
// Pattern Recognition Types
// ============================================

export interface DetectedPattern {
    type: string;
    name: string;
    confidence: number;
    actions: Action[];
    suggestion: PatternSuggestion;
}

export interface PatternSuggestion {
    gherkinStep: string;
    stepDefinition?: StepDefinitionSuggestion;
    pageObject?: PageObjectSuggestion;
    testData?: Record<string, any>;
}

export interface StepDefinitionSuggestion {
    pattern: string;
    implementation: string;
    reusable: boolean;
    existingMatch?: ExistingStep;
}

export interface ExistingStep {
    pattern: string;
    filePath: string;
    similarity: number;
}

export interface PageObjectSuggestion {
    className: string;
    method: string;
    implementation: string;
}

// ============================================
// Framework Knowledge Types
// ============================================

export interface CSCapability {
    id: string;
    name: string;
    type: 'action' | 'factory' | 'collection' | 'query' | 'wait' | 'assertion';
    className: string; // 'CSWebElement', 'CSElementFactory', etc.
    description: string;
    signature: string;
    whenToUse: string;
    alternatives: string[];
    useCases: string[];
    examples: string[];
    benefits: string[];
}

export interface CSCapabilityMatch {
    capability: CSCapability;
    confidence: number;
    alternatives: CSCapability[];
    reasoning: string;
}

export interface FrameworkMethodSelection {
    method: string;
    args?: any[];
    example: string;
    benefits: string[];
    warnings?: string[];
}

// ============================================
// Code Generation Types
// ============================================

export interface GeneratedCSCode {
    feature: GeneratedFeature;
    pageObjects: GeneratedPageObject[];
    stepDefinitions: GeneratedStepDefinition[];
    testData?: GeneratedTestData;
    metadata: GenerationMetadata;
}

export interface GeneratedFeature {
    fileName: string;
    path: string;
    content: string;
    scenarios: GherkinScenario[];
}

export interface GherkinScenario {
    name: string;
    tags: string[];
    background?: GherkinStep[];
    steps: GherkinStep[];
}

export interface GherkinStep {
    keyword: 'Given' | 'When' | 'Then' | 'And' | 'But';
    text: string;
    dataTable?: string[][];
    docString?: string;
}

export interface GeneratedPageObject {
    className: string;
    fileName: string;
    path: string;
    content: string;
    baseClass: string;
    decorator: string;
    elements: GeneratedElement[];
    methods: GeneratedMethod[];
}

export interface GeneratedElement {
    name: string;
    type: string; // 'CSWebElement'
    decorator: string; // '@CSGetElement'
    locator: string;
    description?: string;
    comment?: string;
}

export interface GeneratedMethod {
    name: string;
    returnType: string;
    parameters: MethodParameter[];
    implementation: string;
    comment?: string;
    isAsync: boolean;
}

export interface MethodParameter {
    name: string;
    type: string;
    optional?: boolean;
    defaultValue?: any;
}

export interface GeneratedStepDefinition {
    className: string;
    fileName: string;
    path: string;
    content: string;
    steps: GeneratedStep[];
}

export interface GeneratedStep {
    pattern: string;
    decorator: string; // '@CSBDDStepDef'
    methodName: string;
    implementation: string;
    comment?: string;
}

export interface GeneratedTestData {
    fileName: string;
    path: string;
    content: string;
    format: 'json' | 'yaml' | 'csv';
    data: Record<string, any>;
}

export interface GenerationMetadata {
    timestamp: number;
    version: string;
    sourceFile: string;
    analysisConfidence: number;
    transformationAccuracy: number;
    warnings: string[];
    suggestions: string[];
}

// ============================================
// Transformation Context
// ============================================

export interface TransformContext {
    projectRoot: string;
    outputDir: string;
    projectName?: string;
    featureName?: string;
    tags?: string[];
    interactive: boolean;
    existingCode?: ExistingCodeContext;
}

export interface ExistingCodeContext {
    features: string[];
    pages: string[];
    steps: ExistingStep[];
    namingConventions: NamingConventions;
}

export interface NamingConventions {
    pageObjectSuffix: string; // 'Page', 'PO', etc.
    stepClassSuffix: string; // 'Steps', 'StepDefs', etc.
    elementNamingStyle: 'camelCase' | 'PascalCase';
    methodNamingStyle: 'camelCase' | 'snake_case';
}

// ============================================
// Validation Types
// ============================================

export interface ValidationResult {
    valid: boolean;
    errors: ValidationError[];
    warnings: ValidationWarning[];
    suggestions: string[];
}

export interface ValidationError {
    code: string;
    message: string;
    location?: {
        file: string;
        line: number;
        column: number;
    };
    severity: 'error' | 'warning';
}

export interface ValidationWarning {
    code: string;
    message: string;
    suggestion?: string;
}

// ============================================
// Runtime Prediction Types
// ============================================

export interface RuntimePrediction {
    estimatedDuration: number;
    failurePoints: FailurePrediction[];
    flakinessRisk: number; // 0-1
    resourceUsage: ResourcePrediction;
    optimizations: Optimization[];
    maintenanceRisks: MaintenanceRisk[];
}

export interface FailurePrediction {
    location: {
        file: string;
        line: number;
    };
    type: 'timing' | 'locator' | 'error-handling' | 'resource';
    risk: 'low' | 'medium' | 'high';
    reason: string;
    mitigation: string;
    autoFix?: AutoFix;
}

export interface AutoFix {
    description: string;
    diff: string;
    confidence: number;
    canAutoApply: boolean;
}

export interface ResourcePrediction {
    memory: number;
    cpu: number;
    network: number;
}

export interface Optimization {
    type: 'performance' | 'reliability' | 'maintainability';
    description: string;
    impact: 'low' | 'medium' | 'high';
    effort: 'low' | 'medium' | 'high';
    diff?: string;
}

export interface MaintenanceRisk {
    type: 'brittleness' | 'duplication' | 'complexity' | 'coupling';
    description: string;
    severity: 'low' | 'medium' | 'high';
    mitigation: string;
}

// ============================================
// LLM Intelligence Types
// ============================================

export interface SemanticUnderstanding {
    what: string;  // What is being tested
    why: string;   // Why this test exists
    how: string;   // How the test works
    context: string; // Context/domain
}

export interface BusinessContext {
    domain: string;
    stakeholders: string[];
    businessValue: string;
}

export interface UserJourney {
    steps: string[];
    persona: string;
    goal: string;
}

export interface TestPurpose {
    validates: string[];
    prevents: string[];
    ensures: string[];
}

// ============================================
// CLI Types
// ============================================

export interface CodegenOptions {
    url?: string;
    output?: string;
    featureName?: string;
    project?: string;
    interactive?: boolean;
    dryRun?: boolean;
    verbose?: boolean;
}

export interface TransformationProgress {
    phase: string;
    percentage: number;
    message: string;
}
