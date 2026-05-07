/**
 * Agentic Test Platform — Clarification Agent
 *
 * Computes the set of tiered clarification questions that must be answered
 * before the platform can produce shippable tests. Mode-aware: each
 * AgentRunMode has its own question set.
 *
 * Tiers:
 *   1 — blocking, hard required to start
 *   2 — important, default-able but quality suffers without it
 *   3 — optional, advanced policy choices
 *
 * Privacy-by-design: every example value uses generic placeholders such as
 * <APP_URL>, <USER>, <TEST_PLAN_ID>.
 *
 * @module agent-platform/CSClarificationAgent
 */

import { ClarificationQuestion, ClassifiedInput, AgentRunMode } from './types';
import { CSConfigurationManager } from '../../core/CSConfigurationManager';

// ============================================================================
// Config-resolvable fields
// ============================================================================

/**
 * Map of clarification field → CSConfigurationManager key. When a field is
 * present here AND the config has the value, we treat the field as already
 * answered and the question is dropped. This lets the framework's existing
 * `.env` hierarchy (incl. `ENCRYPTED:` decryption) satisfy clarification
 * automatically — the user does not have to paste credentials into chat.
 */
const FIELD_TO_CONFIG_KEY: Record<string, string> = {
    adoOrganization: 'ADO_ORGANIZATION',
    adoProject: 'ADO_PROJECT',
    adoPat: 'ADO_PAT',
};

/**
 * Read a field's value from CSConfigurationManager, returning undefined when
 * the manager is uninitialized, the key is unmapped, or the value is empty.
 * Decryption of `ENCRYPTED:` payloads happens inside the manager.
 */
function readFieldFromConfig(field: string): string | undefined {
    const key = FIELD_TO_CONFIG_KEY[field];
    if (!key) return undefined;
    try {
        const v = CSConfigurationManager.getInstance().get(key, '');
        if (v && v.length > 0) return v;
    } catch {
        // Manager not initialized — caller falls back to clarification.
    }
    return undefined;
}

// ============================================================================
// Question Catalog
// ============================================================================

/**
 * Universal questions — asked regardless of mode when the field is not
 * already present in the classified input's extracted fields.
 */
const UNIVERSAL_QUESTIONS: ClarificationQuestion[] = [
    {
        tier: 1,
        field: 'appUrl',
        question:
            'What is the application URL the tests should run against? ' +
            '(e.g. <APP_URL>)',
        required: true,
    },
    {
        tier: 1,
        field: 'expectedOutcome',
        question:
            'What is the expected high-level outcome the tests must verify?',
        required: true,
    },
    {
        tier: 2,
        field: 'credentialsSource',
        question:
            'Where should test credentials come from? Options: env-var, ' +
            'secret-store, prompt-each-run.',
        required: false,
        suggestedDefault: 'env-var',
    },
    {
        tier: 2,
        field: 'testDataSource',
        question:
            'How should test data be sourced? Options: static-fixture, ' +
            'dynamic-generated, mutating-shared.',
        required: false,
        suggestedDefault: 'dynamic-generated',
    },
    {
        tier: 3,
        field: 'mutationPolicy',
        question:
            'When tests must mutate shared records, what policy applies? ' +
            'Options: forbid, isolate-per-run, cleanup-after.',
        required: false,
        suggestedDefault: 'cleanup-after',
    },
    {
        tier: 3,
        field: 'cleanupStrategy',
        question:
            'What cleanup strategy should run at the end of each test? ' +
            'Options: none, soft-delete, hard-delete, restore-snapshot.',
        required: false,
        suggestedDefault: 'soft-delete',
    },
];

/**
 * Mode-specific questions. These are appended to the universal set when
 * the user has selected the corresponding mode.
 */
const MODE_QUESTIONS: Partial<Record<AgentRunMode, ClarificationQuestion[]>> = {
    ado_test_case_id: [
        {
            tier: 1,
            field: 'adoOrganization',
            question: 'What is the Azure DevOps organization name?',
            required: true,
        },
        {
            tier: 1,
            field: 'adoProject',
            question: 'What is the Azure DevOps project name?',
            required: true,
        },
        {
            tier: 1,
            field: 'adoPat',
            question:
                'Provide a Personal Access Token with Test (read) and Work ' +
                'Items (read) scopes. Set this in your secret store and ' +
                'reference its name here.',
            required: true,
        },
    ],
    ado_test_suite_id: [
        {
            tier: 1,
            field: 'adoOrganization',
            question: 'What is the Azure DevOps organization name?',
            required: true,
        },
        {
            tier: 1,
            field: 'adoProject',
            question: 'What is the Azure DevOps project name?',
            required: true,
        },
        {
            tier: 1,
            field: 'adoPat',
            question:
                'Provide a Personal Access Token. Reference its secret-store name.',
            required: true,
        },
        {
            tier: 1,
            field: 'planId',
            question:
                'Which test plan does this suite belong to? (e.g. <TEST_PLAN_ID>)',
            required: true,
        },
    ],
    ado_test_plan_id: [
        {
            tier: 1,
            field: 'adoOrganization',
            question: 'What is the Azure DevOps organization name?',
            required: true,
        },
        {
            tier: 1,
            field: 'adoProject',
            question: 'What is the Azure DevOps project name?',
            required: true,
        },
        {
            tier: 1,
            field: 'adoPat',
            question:
                'Provide a Personal Access Token. Reference its secret-store name.',
            required: true,
        },
        {
            tier: 2,
            field: 'suiteFilter',
            question:
                'Optional: limit generation to a subset of suites by name ' +
                'prefix. Leave blank to use all suites in the plan.',
            required: false,
        },
    ],
    natural_language_chat: [
        {
            tier: 1,
            field: 'feature',
            question:
                'Describe the feature or behavior to test in one sentence.',
            required: true,
        },
        {
            tier: 2,
            field: 'roles',
            question:
                'Which user roles should be exercised? (e.g. <USER>, <ADMIN>)',
            required: false,
        },
    ],
    document_path: [
        {
            tier: 1,
            field: 'sectionFocus',
            question:
                'Which section of the document drives test generation? ' +
                'Provide a heading or page range, or "all".',
            required: true,
            suggestedDefault: 'all',
        },
    ],
    app_url: [
        {
            tier: 1,
            field: 'entryFlow',
            question:
                'After loading <APP_URL>, what is the entry flow? Options: ' +
                'no-auth, basic-login, sso-redirect, multi-step-login.',
            required: true,
        },
        {
            tier: 2,
            field: 'rolesToExplore',
            question:
                'Which user roles should the explorer impersonate? Provide ' +
                'a comma-separated list or "default".',
            required: false,
            suggestedDefault: 'default',
        },
    ],
    source_code_path: [
        {
            tier: 1,
            field: 'targetSurface',
            question:
                'Which surface should tests target — the UI exposing this ' +
                'code, an HTTP API, or both?',
            required: true,
        },
    ],
    legacy_test_code: [
        {
            tier: 1,
            field: 'translationGoal',
            question:
                'Should the legacy tests be translated 1:1, refactored, or ' +
                'used only as a behavior reference?',
            required: true,
            suggestedDefault: 'translated-1-to-1',
        },
    ],
    unknown: [
        {
            tier: 1,
            field: 'inputType',
            question:
                'The input could not be classified. Is it a test case id, ' +
                'a test suite id, a test plan id, an app URL, a file path, ' +
                'or a free-text description?',
            required: true,
        },
    ],
};

// ============================================================================
// CSClarificationAgent
// ============================================================================

/**
 * Static utility class. Computes the set of clarification questions that
 * remain unanswered for a given classified input, and renders them as a
 * structured user-facing prompt.
 */
export class CSClarificationAgent {
    /**
     * Return the list of questions that still need answers given the
     * classified input. Filters out any question whose `field` is already
     * populated in `input.extractedFields`.
     *
     * Output ordering: Tier 1 first (alphabetical by field), then Tier 2,
     * then Tier 3. This matches the rendering order of formatQuestionsAsText.
     */
    public static computeMissingFields(input: ClassifiedInput): ClarificationQuestion[] {
        const universal = UNIVERSAL_QUESTIONS.slice();
        const modeSpecific = MODE_QUESTIONS[input.mode] ?? [];

        const all = [...modeSpecific, ...universal];

        // Filter out questions whose field is either:
        //   (a) already in extractedFields (router or prior clarification answer)
        //   (b) resolvable from CSConfigurationManager (e.g. ADO_PAT in .env;
        //       ENCRYPTED:<...> values are auto-decrypted by the manager)
        const filtered = all.filter((q) => {
            if (input.extractedFields[q.field] !== undefined) return false;
            if (readFieldFromConfig(q.field) !== undefined) return false;
            return true;
        });

        // Stable sort: tier asc, then field asc.
        filtered.sort((a, b) => {
            if (a.tier !== b.tier) return a.tier - b.tier;
            return a.field.localeCompare(b.field);
        });

        return filtered;
    }

    /**
     * Render the question list as a single user-facing string, grouped
     * by tier. Each group is preceded by a header explaining the tier's
     * meaning. Designed to be readable inside an MCP text response.
     */
    public static formatQuestionsAsText(questions: ClarificationQuestion[]): string {
        if (questions.length === 0) {
            return 'No clarifications needed.';
        }

        const groups: Record<1 | 2 | 3, ClarificationQuestion[]> = {
            1: [],
            2: [],
            3: [],
        };
        for (const q of questions) {
            groups[q.tier].push(q);
        }

        const lines: string[] = [];
        lines.push('Clarification needed before the agent can proceed.');
        lines.push('');

        if (groups[1].length > 0) {
            lines.push('Round 1 — Required (blocking):');
            for (const q of groups[1]) {
                lines.push(`  - [${q.field}] ${q.question}`);
            }
            lines.push('');
        }
        if (groups[2].length > 0) {
            lines.push('Round 2 — Recommended (defaults available):');
            for (const q of groups[2]) {
                const def = q.suggestedDefault
                    ? `  (default: ${q.suggestedDefault})`
                    : '';
                lines.push(`  - [${q.field}] ${q.question}${def}`);
            }
            lines.push('');
        }
        if (groups[3].length > 0) {
            lines.push('Round 3 — Optional (advanced policy):');
            for (const q of groups[3]) {
                const def = q.suggestedDefault
                    ? `  (default: ${q.suggestedDefault})`
                    : '';
                lines.push(`  - [${q.field}] ${q.question}${def}`);
            }
            lines.push('');
        }

        lines.push(
            'Reply with answers in the form { "<field>": "<value>", ... } ' +
                'and re-invoke the tool with `answers` populated.',
        );

        return lines.join('\n');
    }
}
