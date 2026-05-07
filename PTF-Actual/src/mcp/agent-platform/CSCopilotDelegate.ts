/**
 * Agentic Test Platform — Copilot Delegate
 *
 * Single primitive wrapping `context.sampling.createMessage()`. Encodes the
 * platform's "orchestrator + safety harness around Copilot" architecture:
 * we do not re-implement semantic source-code understanding. Instead we
 * bundle the legacy/document/source input + framework conventions, hand
 * the lot to the host LLM (Copilot in VS Code, Claude in terminal, etc.
 * via MCP sampling), and parse the file map it returns.
 *
 * Three task modes share the same primitive:
 *   - `legacy_migration`  Java/C# Selenium / QAF / TestNG → CS Playwright TS
 *   - `document_to_tests` Requirements doc → tests covering its rules
 *   - `source_to_tests`   Application source → tests for that surface
 *
 * The delegate is bounded:
 *   - PII / secrets are redacted out of every outbound payload
 *   - Cost is tracked via the supplied `CSCostTelemetry`
 *   - A single round-trip per file (heal loop runs downstream on the output)
 *   - Falls back to a structured "no usable result" return when sampling is
 *     unavailable so callers can surface a clean blocked reason.
 *
 * Privacy-by-design: no domain or consumer-specific patterns. The framework
 * conventions block embedded below is intentionally generic — `<project>` /
 * `<feature>` placeholders, no real business names.
 *
 * @module agent-platform/CSCopilotDelegate
 */

import * as fs from 'fs';
import * as path from 'path';
import { MCPToolContext } from '../types/CSMCPTypes';
import { CSPiiSanitizer } from './CSPiiSanitizer';
import { CSCostTelemetry } from './CSCostTelemetry';

// ============================================================================
// Public Types
// ============================================================================

export type DelegateTask =
    | 'legacy_migration'
    | 'document_to_tests'
    | 'source_to_tests'
    | 'natural_language_chat';

export interface DelegateInputFile {
    /** Display path used in the prompt. Sanitised before sending. */
    path: string;
    /** Raw content. Will be PII-redacted in `redact` mode before going out. */
    content: string;
    /** Optional one-line role hint (e.g. "test class", "page object"). */
    role?: string;
}

export interface DelegateRequest {
    task: DelegateTask;
    /** Project slug used for output paths. */
    projectName: string;
    /** Feature slug used for output filenames. */
    featureName: string;
    /** Files the LLM must read to do the job. */
    sourceFiles: DelegateInputFile[];
    /** Optional draft files (from a deterministic seed) the LLM should refine. */
    draftFiles?: Array<{ path: string; content: string }>;
    /**
     * Optional structural-IR JSON. Helps the LLM match test method names,
     * `@MetaData` testCaseIds, etc. without re-extracting them.
     */
    grounding?: string;
    /** Cost / wall-clock guardrails enforced by the caller. */
    telemetry?: CSCostTelemetry;
    /** Hard cap on response length. Default 8 K tokens. */
    maxTokens?: number;
}

export interface DelegateResult {
    /** Map of output path → content. Empty when the LLM gave up or failed. */
    files: Record<string, string>;
    /** LLM-surfaced caveats: assumptions, missing info, partial migrations. */
    notes: string[];
    /** Filled when the call could not produce a usable result. */
    blockedReason?: string;
    /** Token count if the host surfaced one; informational only. */
    tokensUsed?: number;
}

// ============================================================================
// CSCopilotDelegate
// ============================================================================

/**
 * Static delegate. Single public entry point: `delegate`.
 */
export class CSCopilotDelegate {
    /** Hard cap on a single source-file payload sent to the LLM. */
    private static readonly MAX_FILE_BYTES = 24 * 1024;
    /** Hard cap on aggregate input. Stops a 56-file QAF dump from blowing context. */
    private static readonly MAX_TOTAL_BYTES = 80 * 1024;
    /** Default response cap. */
    private static readonly DEFAULT_MAX_TOKENS = 8192;

    /**
     * Delegate the semantic translation work to the host LLM. The handler
     * builds a prompt from the framework conventions + sanitised inputs,
     * calls `context.sampling.createMessage`, and parses the file-map JSON
     * the LLM returns.
     */
    public static async delegate(
        request: DelegateRequest,
        context: MCPToolContext,
    ): Promise<DelegateResult> {
        if (!context.sampling) {
            return {
                files: {},
                notes: [],
                blockedReason:
                    'CSCopilotDelegate: sampling client not available — host LLM (Copilot/Claude) is required for this task',
            };
        }

        if (request.telemetry) {
            const budget = request.telemetry.checkBudget();
            if (!budget.withinBudget) {
                return {
                    files: {},
                    notes: [],
                    blockedReason: `CSCopilotDelegate: budget exhausted — ${budget.reason ?? 'limit reached'}`,
                };
            }
        }

        // -- Bundle + sanitise input ---------------------------------------
        const bundled = CSCopilotDelegate.bundleInput(request);
        if (bundled.bytes > CSCopilotDelegate.MAX_TOTAL_BYTES) {
            return {
                files: {},
                notes: [],
                blockedReason: `CSCopilotDelegate: input payload (${bundled.bytes} bytes) exceeds aggregate cap (${CSCopilotDelegate.MAX_TOTAL_BYTES})`,
            };
        }

        const prompt = CSCopilotDelegate.buildPrompt(request, bundled.text);

        try {
            const response = await context.sampling.createMessage({
                messages: [{ role: 'user', content: { type: 'text', text: prompt } }],
                maxTokens: request.maxTokens ?? CSCopilotDelegate.DEFAULT_MAX_TOKENS,
                temperature: 0.2,
                systemPrompt: CSCopilotDelegate.SYSTEM_PROMPT,
            });
            const raw = CSCopilotDelegate.firstTextBlock(response);
            const parsed = CSCopilotDelegate.parseResponse(raw);
            return {
                ...parsed,
                tokensUsed: CSCopilotDelegate.tokensFromResponse(response),
            };
        } catch (err) {
            context.log('warning', 'CSCopilotDelegate: sampling failed', {
                error: err instanceof Error ? err.message : String(err),
            });
            return {
                files: {},
                notes: [],
                blockedReason: `CSCopilotDelegate: sampling error — ${err instanceof Error ? err.message : String(err)}`,
            };
        }
    }

    // ========================================================================
    // Prompt construction
    // ========================================================================

    private static readonly SYSTEM_PROMPT = [
        'You are a senior test-automation engineer migrating tests to the CS',
        'Playwright TypeScript framework. You are bounded by the framework',
        'conventions provided. You ALWAYS reply with a single JSON object',
        'matching the requested schema, with no Markdown fences and no prose',
        'outside the JSON. When information is missing, surface it via `notes`',
        'rather than fabricating.',
    ].join(' ');

    private static buildPrompt(
        request: DelegateRequest,
        inputBlock: string,
    ): string {
        const taskInstruction = CSCopilotDelegate.TASK_INSTRUCTIONS[request.task];
        const lines: string[] = [];
        lines.push('# Task');
        lines.push(taskInstruction);
        lines.push('');
        lines.push('# Project / feature naming');
        lines.push(`- projectName: ${request.projectName}`);
        lines.push(`- featureName: ${request.featureName}`);
        lines.push('');
        lines.push('# Framework conventions (must be matched exactly)');
        lines.push(CSCopilotDelegate.FRAMEWORK_CONVENTIONS);
        lines.push('');
        if (request.grounding && request.grounding.length > 0) {
            lines.push('# Grounding (structural facts already extracted — match these names verbatim)');
            lines.push(request.grounding.slice(0, 4 * 1024));
            lines.push('');
        }
        lines.push('# Input');
        lines.push(inputBlock);
        lines.push('');
        if (request.draftFiles && request.draftFiles.length > 0) {
            lines.push('# Existing draft (refine, do not rewrite from scratch)');
            for (const d of request.draftFiles) {
                lines.push(`## ${d.path}`);
                lines.push('```');
                lines.push(d.content.slice(0, 8 * 1024));
                lines.push('```');
            }
            lines.push('');
        }
        lines.push('# Output format');
        lines.push('Return ONE JSON object — no Markdown fence, no commentary outside the JSON:');
        lines.push('{');
        lines.push('  "files": {');
        lines.push('    "test/<project>/features/<feature>.feature": "...",');
        lines.push('    "test/<project>/pages/<NamePage>.ts": "...",');
        lines.push('    "test/<project>/steps/<feature>.steps.ts": "...",');
        lines.push('    "test/<project>/data/<feature>-data.json": "..."');
        lines.push('  },');
        lines.push('  "notes": ["<assumption or warning>", ...]');
        lines.push('}');
        return lines.join('\n');
    }

    private static readonly TASK_INSTRUCTIONS: Record<DelegateTask, string> = {
        legacy_migration: [
            'Migrate the supplied legacy test source (Selenium / QAF / TestNG / NUnit /',
            'xUnit / MSTest) to CS Playwright TypeScript. Produce one .feature file,',
            'one or more page-object .ts files, one .steps.ts file, and a',
            '<feature>-data.json fixture. Preserve every test case and its semantic',
            'intent. Use the @MetaData testCaseId for `@TC_<id>` scenario tags when',
            'present.',
        ].join(' '),
        document_to_tests: [
            'Read the supplied requirements document and produce CS Playwright tests',
            'covering each enumerated rule. One scenario per rule. The .feature file',
            'must reference the rule id in the scenario title.',
        ].join(' '),
        source_to_tests: [
            'Read the supplied application source code and produce CS Playwright tests',
            'covering its observable behaviour. Prefer one scenario per public entry',
            'point or business rule.',
        ].join(' '),
        natural_language_chat: [
            'The user described a feature or flow in free-form text. There is no',
            'source code or document to ground against — your job is to draft a',
            "best-effort first cut. Use the grounding block (appUrl, expectedOutcome,",
            "roles) to anchor the scenarios. Surface every assumption you made via",
            "`notes` so the user can correct them. When element locators are not",
            "knowable, use sensible placeholders and flag them in `notes` for the",
            "heal loop / human review to refine on first run.",
        ].join(' '),
    };

    /**
     * Generic, project-agnostic conventions. Examples use `<project>`,
     * `<feature>`, `<Page>` placeholders so no consumer-specific data leaks
     * into the prompt. Tightened over time as patterns shake out.
     */
    private static readonly FRAMEWORK_CONVENTIONS = `
- File layout — emit WORKSPACE-RELATIVE paths in the files map. The
  caller writes them under the workspace root, producing the framework's
  canonical layout:
    test/<project>/features/<feature>.feature        Gherkin
    test/<project>/pages/<Page>.ts                    Page object class
    test/<project>/steps/<feature>.steps.ts           Step definitions
    test/<project>/data/<feature>-data.json           Scenario fixtures
  The config/<project>/ scaffold (global.env, common/common.env,
  environments/<env>.env) is generated separately by the orchestrator
  via generate_config_scaffold — DO NOT emit config files in your
  output. Stick to the test/ tree only.

- Page objects:
    @CSPage({url: '...'})
    export class <Name>Page extends CSBasePage {
        @CSGetElement({xpath: "//...", alternativeLocators: ['css=...']})
        public element: CSWebElement;
    }
  - xpath is the primary locator; CSS goes in alternativeLocators[]
  - never id/css as primary
  - never use the Playwright API directly (no this.page.locator(...))

- Step definitions:
    @StepDefinitions
    export class <Project><Feature>Steps {
        @CSBDDStepDef('I do something with {string}')
        async iDoSomething(value: string) { /* uses framework wrappers */ }
    }
  - element interactions go through framework wrappers
    (clickWithTimeout, fillText, selectOptionByLabel, verifyText, etc.)
  - never raw Playwright calls

- Feature file:
    @<project> @<feature>
    Feature: <Feature>

      @TC_<id> @priority-N
      Scenario Outline: TS_<id> - <title>
        Given ...
        When ...
        Then ...
        Examples: {"type":"json","source":"test/<project>/data/<feature>-data.json","filter":"runFlag=Yes AND scenarioId=TS_<id>"}
          | scenarioId | scenarioName | runFlag | ... |

- Scenario JSON shape (array of rows):
    [
      {"scenarioId":"TS_<id>","scenarioName":"<title>","runFlag":"Yes", /* extra columns */}
    ]
  - When the grounding payload contains a migratedTestData.rows array,
    REUSE those values verbatim in the new <feature>-data.json. Do not
    invent placeholders for columns that exist in the rows. The
    migratedTestData block is the authoritative source for the data
    fixture's column set and values.

- Numeric literals: write 5000 not 5_000.
- Long-running navigation clicks: use clickWithTimeout(30000-60000), not the default 5s timeout.
- For dynamic elements inside frames, declare frame chain on @CSGetElement.
- DO NOT cite legacy file paths or consumer-specific identifiers in generated test code.
`.trim();

    // ========================================================================
    // Input bundling
    // ========================================================================

    private static bundleInput(request: DelegateRequest): {
        text: string;
        bytes: number;
    } {
        const parts: string[] = [];
        let totalBytes = 0;
        for (const f of request.sourceFiles) {
            const safeContent = CSPiiSanitizer.sanitize(f.content, 'redact').cleaned;
            const truncated = safeContent.length > CSCopilotDelegate.MAX_FILE_BYTES
                ? safeContent.slice(0, CSCopilotDelegate.MAX_FILE_BYTES) +
                  `\n\n/* ... truncated at ${CSCopilotDelegate.MAX_FILE_BYTES} bytes ... */`
                : safeContent;
            parts.push(
                `## ${f.path}${f.role ? ` (${f.role})` : ''}\n` +
                    '```\n' +
                    truncated +
                    '\n```',
            );
            totalBytes += truncated.length;
        }
        return { text: parts.join('\n\n'), bytes: totalBytes };
    }

    // ========================================================================
    // Response parsing
    // ========================================================================

    private static firstTextBlock(response: unknown): string {
        const r = response as Record<string, unknown> | undefined;
        if (!r) return '';
        const content = r.content as { type?: string; text?: string }[] | undefined;
        if (Array.isArray(content)) {
            for (const part of content) {
                if (part?.type === 'text' && typeof part.text === 'string') {
                    return part.text;
                }
            }
        }
        if (typeof r.text === 'string') return r.text;
        return '';
    }

    private static tokensFromResponse(response: unknown): number | undefined {
        const r = response as Record<string, unknown> | undefined;
        if (!r) return undefined;
        const usage = r.usage as Record<string, unknown> | undefined;
        if (!usage) return undefined;
        const input = typeof usage.inputTokens === 'number' ? usage.inputTokens : 0;
        const output = typeof usage.outputTokens === 'number' ? usage.outputTokens : 0;
        const total = input + output;
        return total > 0 ? total : undefined;
    }

    private static parseResponse(raw: string): {
        files: Record<string, string>;
        notes: string[];
        blockedReason?: string;
    } {
        const stripped = raw
            .trim()
            .replace(/^```(?:json)?\s*/i, '')
            .replace(/```$/i, '')
            .trim();
        const firstBrace = stripped.indexOf('{');
        const lastBrace = stripped.lastIndexOf('}');
        if (firstBrace < 0 || lastBrace <= firstBrace) {
            return {
                files: {},
                notes: [],
                blockedReason: 'CSCopilotDelegate: response did not contain a JSON object',
            };
        }
        const slice = stripped.slice(firstBrace, lastBrace + 1);
        try {
            const obj = JSON.parse(slice) as Record<string, unknown>;
            const filesRaw = obj.files;
            const notesRaw = obj.notes;
            const files: Record<string, string> = {};
            if (filesRaw && typeof filesRaw === 'object') {
                for (const [k, v] of Object.entries(
                    filesRaw as Record<string, unknown>,
                )) {
                    if (typeof v === 'string' && k.length > 0) {
                        files[k] = v;
                    }
                }
            }
            const notes: string[] = Array.isArray(notesRaw)
                ? (notesRaw as unknown[]).filter(
                      (n): n is string => typeof n === 'string',
                  )
                : [];
            if (Object.keys(files).length === 0) {
                return {
                    files,
                    notes,
                    blockedReason: 'CSCopilotDelegate: LLM returned no files',
                };
            }
            return { files, notes };
        } catch (err) {
            return {
                files: {},
                notes: [],
                blockedReason: `CSCopilotDelegate: response JSON parse failed — ${err instanceof Error ? err.message : String(err)}`,
            };
        }
    }

    // ========================================================================
    // Convenience for callers
    // ========================================================================

    /**
     * Read a file from disk into a `DelegateInputFile`. Returns null on read
     * failure rather than throwing — callers can decide whether the missing
     * input is a hard error.
     */
    public static readInput(
        absPath: string,
        role?: string,
    ): DelegateInputFile | null {
        try {
            const content = fs.readFileSync(absPath, 'utf-8');
            return { path: absPath, content, role };
        } catch {
            return null;
        }
    }

    /**
     * Resolve a file map to absolute paths under `outputRoot` and write each
     * file. Returns the list of paths actually written.
     */
    public static writeFiles(
        files: Record<string, string>,
        outputRoot: string,
    ): string[] {
        const written: string[] = [];
        for (const [relPath, content] of Object.entries(files)) {
            const safe = relPath.replace(/^[/\\]+/, '');
            const fullPath = path.resolve(outputRoot, safe);
            const dir = path.dirname(fullPath);
            try {
                fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(fullPath, content, 'utf-8');
                written.push(fullPath);
            } catch (err) {
                // eslint-disable-next-line no-console
                console.warn(
                    `CSCopilotDelegate.writeFiles: failed ${fullPath}: ${
                        err instanceof Error ? err.message : String(err)
                    }`,
                );
            }
        }
        return written;
    }
}
