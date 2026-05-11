/**
 * JSON schemas the LLM must satisfy when fulfilling a delegation envelope.
 *
 * Each phase that delegates to the LLM (analyze, translate) ships its
 * schema in the envelope. The companion record tool validates the LLM's
 * output against the schema before persisting. If validation fails, the
 * record tool returns the validation errors so the agent can retry.
 *
 * @module agent-platform/CSDelegationSchemas
 */

export interface JsonSchema {
    type?: string | string[];
    properties?: Record<string, JsonSchema>;
    items?: JsonSchema | JsonSchema[];
    required?: string[];
    enum?: unknown[];
    minLength?: number;
    minItems?: number;
    pattern?: string;
    additionalProperties?: boolean | JsonSchema;
    description?: string;
    oneOf?: JsonSchema[];
    anyOf?: JsonSchema[];
}

// Forbidden placeholder substrings — if ANY string in the LLM's output
// contains any of these, the content is rejected. Forces the LLM to
// produce real content or escalate, not paper over gaps with stubs.
export const FORBIDDEN_PLACEHOLDER_PATTERNS: readonly string[] = [
    'analyzer found no leaf calls',
    'no leaf calls found',
    'TODO: scenario body',
    'TODO: implement',
    'TODO:',
    '// TODO',
    '# TODO',
    'not yet migrated',
    'not yet implemented',
    'not implemented',
    'placeholder',
    'PLACEHOLDER',
    '<placeholder>',
    'lorem ipsum',
    '<insert',
    '<replace',
    '...stub...',
    'the operation should complete without errors',
] as const;

/**
 * Skills the LLM MUST read before producing a translation. Names map to
 * folders under `.github/skills/<name>/SKILL.md` on the consumer side.
 * The agent's `read` tool fetches each one.
 */
export const MANDATORY_TRANSLATE_SKILLS: readonly string[] = [
    'ff-scenario-outline',
    'scenarios-json-row',
    'ff-smoke-scenario',
    'po-self-healing-element',
    'po-click-action-method',
    'po-fill-action-method',
    'po-wait-and-verify-method',
    'po-simple-element',
    'po-dynamic-element',
    'sd-simple-step',
    'sd-step-with-params',
    'sd-step-with-context',
    'sd-step-with-config',
    'csv-data-driven',
    'xlsx-sheet-to-scenarios',
    'reporter-pass-on-success',
    'reporter-fail-and-throw',
    'audit-rules',
    'americas-timezone',
] as const;

/** Skills the analyzer should consult — heavier on legacy parsing patterns. */
export const MANDATORY_ANALYZE_SKILLS: readonly string[] = [
    'legacy-example-java-testng',
    'legacy-example-csharp-nunit',
    'legacy-example-jdbc-inline-sql',
    'audit-rules',
    'scenarios-json-row',
    'xlsx-sheet-to-scenarios',
    'csv-data-driven',
] as const;

export const ANALYSIS_SCHEMA: JsonSchema = {
    type: 'object',
    required: ['source', 'feature', 'scenarios', 'pages', 'loginContract', 'dependencyGraph', 'configFiles'],
    additionalProperties: true,
    properties: {
        source: {
            type: 'object',
            required: ['absolutePath', 'relativePath', 'sha256'],
            properties: {
                absolutePath: { type: 'string', minLength: 1 },
                relativePath: { type: 'string', minLength: 1 },
                sha256: { type: 'string', pattern: '^[a-f0-9]{16,64}$' },
            },
        },
        // Proof the LLM actually walked the legacy dependency tree. Every
        // file it `read` must appear here. Empty array = rejected.
        dependencyGraph: {
            type: 'array',
            minItems: 1,
            items: {
                type: 'object',
                required: ['path', 'kind'],
                properties: {
                    path: { type: 'string', minLength: 1 },
                    kind: {
                        type: 'string',
                        enum: ['entry', 'base-class', 'page-object', 'helper', 'data-file', 'config', 'login-page'],
                    },
                    referencedBy: { type: 'string' },
                },
            },
        },
        // Every config/properties file consumed during analysis. Must include
        // at least the env-specific properties file.
        configFiles: {
            type: 'array',
            minItems: 1,
            items: {
                type: 'object',
                required: ['path', 'keysExtracted'],
                properties: {
                    path: { type: 'string', minLength: 1 },
                    env: { type: 'string' },
                    keysExtracted: {
                        type: 'array',
                        items: { type: 'string' },
                    },
                    values: {
                        type: 'object',
                        additionalProperties: { type: 'string' },
                    },
                },
            },
        },
        feature: {
            type: 'object',
            required: ['name', 'slug', 'tags'],
            properties: {
                name: { type: 'string', minLength: 1 },
                slug: { type: 'string', pattern: '^[a-z0-9_-]+$' },
                tags: { type: 'array', items: { type: 'string' } },
            },
        },
        scenarios: {
            type: 'array',
            minItems: 1,
            items: {
                type: 'object',
                required: ['id', 'title', 'steps'],
                properties: {
                    id: { type: 'string', minLength: 1 },
                    title: { type: 'string', minLength: 1 },
                    legacyMethodName: { type: 'string' },
                    legacyLineNumber: { type: 'number' },
                    runFlag: { type: 'string', enum: ['Yes', 'No'] },
                    tags: { type: 'array', items: { type: 'string' } },
                    steps: {
                        type: 'array',
                        minItems: 1,
                        items: {
                            type: 'object',
                            required: ['keyword', 'text', 'legacyCite'],
                            properties: {
                                keyword: {
                                    type: 'string',
                                    enum: ['Given', 'When', 'Then', 'And', 'But'],
                                },
                                text: { type: 'string', minLength: 1 },
                                pageName: { type: 'string' },
                                actionName: { type: 'string' },
                                legacyCite: {
                                    type: 'object',
                                    required: ['lineNumber', 'snippet'],
                                    properties: {
                                        lineNumber: { type: 'number' },
                                        snippet: { type: 'string', minLength: 1 },
                                    },
                                },
                            },
                        },
                    },
                    examples: {
                        type: 'array',
                        items: {
                            type: 'object',
                            additionalProperties: { type: 'string' },
                        },
                    },
                    // The real test data row for this scenario from the
                    // legacy data file (xls/csv/xml/properties). Object
                    // keyed by column name. If the source has a data file
                    // and this is empty, the run is rejected.
                    dataRow: {
                        type: 'object',
                        additionalProperties: true,
                    },
                },
            },
        },
        pages: {
            type: 'array',
            items: {
                type: 'object',
                required: ['className', 'role', 'elements'],
                properties: {
                    className: { type: 'string', minLength: 1 },
                    role: {
                        type: 'string',
                        enum: ['reuse-existing', 'create-new', 'extend-existing'],
                    },
                    existingFilePath: { type: 'string' },
                    elements: {
                        type: 'array',
                        items: {
                            type: 'object',
                            required: ['name', 'primaryLocator'],
                            properties: {
                                name: { type: 'string', minLength: 1 },
                                primaryLocator: {
                                    type: 'object',
                                    required: ['strategy', 'value', 'source'],
                                    properties: {
                                        strategy: {
                                            type: 'string',
                                            enum: ['xpath', 'css', 'role', 'text', 'label'],
                                        },
                                        value: { type: 'string', minLength: 1 },
                                        // Grounding proof. Must point at a
                                        // legacy file with line number, OR
                                        // be `inferred` AND have a matching
                                        // high-severity `gaps[]` entry.
                                        source: {
                                            type: 'string',
                                            pattern: '^(legacy-file:.+:\\d+|inferred)$',
                                        },
                                    },
                                },
                                alternativeLocators: {
                                    type: 'array',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            strategy: { type: 'string' },
                                            value: { type: 'string' },
                                        },
                                    },
                                },
                                legacyCite: {
                                    type: 'object',
                                    properties: {
                                        lineNumber: { type: 'number' },
                                        snippet: { type: 'string' },
                                    },
                                },
                            },
                        },
                    },
                    methods: {
                        type: 'array',
                        items: {
                            type: 'object',
                            required: ['name', 'signature'],
                            properties: {
                                name: { type: 'string', minLength: 1 },
                                signature: { type: 'string', minLength: 1 },
                                bodyOutline: { type: 'string' },
                            },
                        },
                    },
                },
            },
        },
        loginContract: {
            type: 'object',
            required: ['detected', 'pattern'],
            properties: {
                detected: { type: 'string', enum: ['yes', 'no', 'unclear'] },
                pattern: { type: 'string' },
                gherkinStep: { type: 'string' },
                perRowUser: { type: 'string', enum: ['yes', 'no'] },
            },
        },
        gaps: {
            type: 'array',
            items: {
                type: 'object',
                required: ['severity', 'detail'],
                properties: {
                    severity: { type: 'string', enum: ['low', 'medium', 'high'] },
                    detail: { type: 'string', minLength: 1 },
                    proposedResolution: { type: 'string' },
                    // When a gap is "referenced class/file X not found in inventory",
                    // the LLM should also include the closest inventory match (if any
                    // within edit-distance ≤ 2 or similarity ≥ 0.9). The user can
                    // approve the suggestion in one round-trip without re-analyze.
                    // Typical OCR typo classes: SQL↔OQL, 0↔O, 1↔I, l↔I.
                    suggestedFuzzyMatch: {
                        type: 'object',
                        required: ['from', 'to', 'confidence'],
                        properties: {
                            from: { type: 'string', minLength: 1 },
                            to: { type: 'string', minLength: 1 },
                            editDistance: { type: 'number' },
                            confidence: { type: 'number' },
                            matchedInventoryPath: { type: 'string' },
                        },
                    },
                },
            },
        },
        readinessScore: {
            type: 'number',
            description: 'LLM-self-assessed readiness 0..1; gate threshold is 0.7.',
        },
    },
};

export const TRANSLATION_SCHEMA: JsonSchema = {
    type: 'object',
    required: ['files'],
    properties: {
        files: {
            type: 'array',
            minItems: 1,
            items: {
                type: 'object',
                required: ['relativePath', 'kind', 'content'],
                properties: {
                    relativePath: {
                        type: 'string',
                        pattern: '^test/[^/]+/(features|pages|steps|data)/.+\\.(feature|ts|json)$',
                    },
                    kind: {
                        type: 'string',
                        enum: ['feature', 'page', 'steps', 'data'],
                    },
                    content: {
                        type: 'string',
                        minLength: 1,
                    },
                    reuseDecision: {
                        type: 'string',
                        enum: ['create-new', 'reuse-existing', 'extend-existing', 'skip'],
                    },
                },
            },
        },
        notes: {
            type: 'array',
            items: { type: 'string' },
        },
    },
};
