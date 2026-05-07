/**
 * Agentic Test Platform — Public API
 *
 * Single import barrel for the agent-platform module. External consumers
 * should import from this file rather than reaching into individual files.
 *
 * @module agent-platform
 */

export * from './types';
export { CSIntentRouter } from './CSIntentRouter';
export { CSClarificationAgent } from './CSClarificationAgent';
export {
    CSExecutionGate,
    ExecutionGateResult,
    ExecutionGateFailure,
} from './CSExecutionGate';
export { CSResultJudge } from './CSResultJudge';
export {
    CSConstitutionalSafety,
    CONSTITUTIONAL_RULES,
    ConstitutionalRule,
} from './CSConstitutionalSafety';
export { CSCostTelemetry, DEFAULT_BUDGET } from './CSCostTelemetry';
export { CSTrustScore } from './CSTrustScore';
export {
    CSPiiSanitizer,
    SanitizationResult,
    SanitizationViolation,
} from './CSPiiSanitizer';
export {
    CSAdoTestCaseParser,
    ParsedTestCase,
    ParsedTestStep,
} from './CSAdoTestCaseParser';
export {
    CSGenerationOrchestrator,
    GenerationResult,
    GenerationOrchestratorInput,
} from './CSGenerationOrchestrator';
export { CSAdoCreateBackFlow, CreateBackResult } from './CSAdoCreateBackFlow';
export {
    CSAdoModeHandler,
    AdoCommonParams,
    AdoModeHandlerOptions,
    AdoModeHandlerResult,
} from './CSAdoModeHandler';
export {
    CSLegacyModeHandler,
    LegacyModeHandlerOptions,
    LegacyModeHandlerResult,
} from './CSLegacyModeHandler';
export {
    CSCopilotDelegate,
    DelegateTask,
    DelegateInputFile,
    DelegateRequest,
    DelegateResult,
} from './CSCopilotDelegate';
export {
    CSDocumentModeHandler,
    DocumentModeHandlerOptions,
    DocumentModeHandlerResult,
} from './CSDocumentModeHandler';
export {
    CSSourceCodeModeHandler,
    SourceCodeModeHandlerOptions,
    SourceCodeModeHandlerResult,
} from './CSSourceCodeModeHandler';
export {
    CSChatModeHandler,
    ChatModeHandlerOptions,
    ChatModeHandlerResult,
} from './CSChatModeHandler';
export {
    CSAppUrlModeHandler,
    AppUrlModeHandlerOptions,
    AppUrlModeHandlerResult,
} from './CSAppUrlModeHandler';
export {
    CSMigrationCache,
    MigrationCacheLookupRequest,
    MigrationCacheLookupResult,
    MigrationCacheStoreRequest,
} from './CSMigrationCache';
export {
    CSRunTrace,
    RunTraceKind,
    RunTraceEntry,
} from './CSRunTrace';
export {
    CSProvenanceSigner,
    ProvenanceMetadata,
    SignedProvenance,
    VerifyResult,
} from './CSProvenanceSigner';
export {
    CSTestDataMigrator,
    DataReference,
    MigratedTestData,
} from './CSTestDataMigrator';
export {
    CSHealLoop,
    HealLoopResult,
    HealLoopOptions,
    HealAttempt,
} from './CSHealLoop';
export {
    agentPlatformTools,
    registerAgentPlatformTools,
} from './CSAIAutoAssist';
