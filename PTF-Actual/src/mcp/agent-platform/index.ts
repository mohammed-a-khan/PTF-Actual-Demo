/**
 * Agentic Test Platform — Public API
 *
 * Single import barrel for the agent-platform module. External consumers
 * should import from this file rather than reaching into individual files.
 *
 * **Rebuild milestone M1.** The previous monolithic generation pipeline
 * has been removed (legacy_transform, IR converters, six composers, five
 * mode handlers, the deprecated Copilot delegate). The new architecture
 * is a toolbox of narrow primitives composed by the `cs-ai-auto-assist`
 * agent prompt — the new tool definitions land in M2–M10.
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
    CSAdoCreateBackFlow,
    CreateBackResult,
    AdoCommonParams,
} from './CSAdoCreateBackFlow';
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
    CSHealLoop,
    HealLoopResult,
    HealLoopOptions,
    HealAttempt,
} from './CSHealLoop';
export {
    CSElicitation,
    ElicitOption,
    ElicitOutcome,
} from './CSElicitation';
export {
    CSLiveAppContext,
    LiveAppContext,
    LiveAppContextOutcome,
    LiveAppEntryFlow,
} from './CSLiveAppContext';
export { CSPreGateAudit, PreGateAuditResult } from './CSPreGateAudit';
export { CSRepoInventory } from './CSRepoInventory';

// Rebuild M2-M4 — per-run artefact context, gate engine, status writer.
export {
    CSRunContext,
    RunPhase,
    PhaseStatus,
    PhaseSnapshot,
    RunSnapshot,
    TimelineEvent,
} from './CSRunContext';
export {
    CSGateEngine,
    GateCheckResult,
    GateResolveResult,
    GateRunOptions,
    GateRunOutcome,
    ResolutionAttempt,
    ExhaustedDecision,
    ExhaustedOutcome,
} from './CSGateEngine';
export { CSStatusWriter } from './CSStatusWriter';

// Rebuild M5-M10 — discovery, analyzer, semantic reuse, translator, write-with-audit, heal classifier.
export {
    CSDiscovery,
    LegacyInventory,
    LegacyFile,
    LegacyFileKind,
} from './CSDiscovery';
export {
    CSLegacyDataReader,
    LegacyDataResult,
} from './CSLegacyDataReader';
export {
    CSSemanticReuse,
    ReuseCandidate,
    PageReuseDecision,
    StepReuseDecision,
    PageObjectInfo,
} from './CSSemanticReuse';
export {
    CSWriteWithAudit,
    WriteOptions,
    AuditResult,
    AuditViolation,
    FixManifestEntry,
    WriteResult,
    ContentMap,
} from './CSWriteWithAudit';

// LLM-delegation infrastructure (v1.34.0+).
// csaa_analyze / csaa_translate return envelopes the LLM fulfils, then
// the result is validated + content-gated by csaa_record_* partners.
export {
    ANALYSIS_SCHEMA,
    TRANSLATION_SCHEMA,
    FORBIDDEN_PLACEHOLDER_PATTERNS,
    JsonSchema,
} from './CSDelegationSchemas';
export { DelegationEnvelope } from './CSDelegationEnvelope';
export { CSSchemaValidator, ValidationError } from './CSSchemaValidator';
export { CSContentValidator, ContentViolation } from './CSContentValidator';

export { csAiAutoAssistTools } from './CSAIAutoAssist';
export { csaaPrimitiveTools } from './CSPrimitiveTools';
