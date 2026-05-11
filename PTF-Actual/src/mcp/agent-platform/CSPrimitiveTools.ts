/**
 * Agentic Test Platform — Primitive MCP Tools (Rebuild M11 wiring)
 *
 * Exposes the 9 phase primitives as MCP tools so the `cs-ai-auto-assist`
 * Copilot agent prompt can compose them in sequence:
 *
 *   csaa_discover → csaa_analyze → csaa_plan → csaa_translate
 *   → csaa_audit → csaa_write → csaa_execute → csaa_verify → csaa_publish
 *
 * Each tool:
 *   - resolves a `CSRunContext` via runId (created by `cs_ai_auto_assist`)
 *   - calls the underlying TS primitive class (CSDiscovery, CSLegacyAnalyzer, …)
 *   - persists artefacts to `Agent-Processing/<ts>_<runId>/<phase>/`
 *   - calls `CSStatusWriter.write(ctx)` so the user's open `STATUS.md`
 *     refreshes after every transition
 *   - returns a structured payload with `nextSuggestedTool` so the agent
 *     keeps composing without freelancing
 *
 * Privacy-by-design: this module contains zero customer / project /
 * company identifiers. Generic placeholders only.
 *
 * @module agent-platform/CSPrimitiveTools
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    MCPToolContext,
    MCPToolDefinition,
    MCPToolResult,
} from '../types/CSMCPTypes';
import { defineTool, MCPToolBuilder } from '../CSMCPToolRegistry';
import { CSRunContext, RunPhase } from './CSRunContext';
import { CSStatusWriter } from './CSStatusWriter';
import { CSDiscovery, LegacyInventory } from './CSDiscovery';
import { CSLegacyDataReader } from './CSLegacyDataReader';
import {
    CSLegacySignatureExtractor,
    type FullSignature,
    type TestSignature,
    type PageSignature,
    type HelperSignature,
} from './CSLegacySignatureExtractor';
import { CSSemanticReuse } from './CSSemanticReuse';
import { CSWriteWithAudit, AuditViolation } from './CSWriteWithAudit';
import { CSRepoInventory } from './CSRepoInventory';
import { CSAdoCreateBackFlow } from './CSAdoCreateBackFlow';
import {
    ANALYSIS_SCHEMA,
    TRANSLATION_SCHEMA,
    MANDATORY_ANALYZE_SKILLS,
    MANDATORY_TRANSLATE_SKILLS,
} from './CSDelegationSchemas';
import type { DelegationEnvelope } from './CSDelegationEnvelope';
import { CSSchemaValidator } from './CSSchemaValidator';
import { CSContentValidator, ContentViolation } from './CSContentValidator';
import { auditTools } from '../tools/audit/CSMCPAuditTools';
import { bddTools } from '../tools/bdd/CSMCPBDDTools';
import { generationTools } from '../tools/generation/CSMCPGenerationTools';
import {
    GeneratedFeatureSummary,
    GeneratedScenarioSummary,
    PipelineOutput,
} from './types';

// ============================================================================
// Helpers
// ============================================================================

function jsonResult(data: unknown, summary: string): MCPToolResult {
    const json = JSON.stringify(data, null, 2);
    return {
        content: [{ type: 'text', text: `${summary}\n\n${json}` }],
        structuredContent: data as Record<string, unknown>,
    };
}

function errorResult(reason: string, runId?: string): MCPToolResult {
    return jsonResult(
        { state: 'BLOCKED_NEED_INPUT', runId, blockedReason: reason, nextStepNeeded: false },
        reason,
    );
}

function getCtx(runId: string): CSRunContext | null {
    return CSRunContext.get(runId);
}

function getStr(p: Record<string, unknown>, k: string): string | undefined {
    const v = p[k];
    return typeof v === 'string' ? v : undefined;
}

// ============================================================================
// csaa_discover — Phase 2: walk legacy project tree
// ============================================================================

const csaa_discover: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('csaa_discover')
    .title('CS-AI-Auto-Assist — Discover (Phase 2)')
    .description(
        'Walk the legacy project tree (or BDD .feature, ADO TC#, doc, source, URL) ' +
            'and produce a structured inventory: tests, pages, helpers, base classes, data ' +
            'files, properties files, runner configs. Persists `inventory.json` to ' +
            '`Agent-Processing/<run>/02-discover/` and updates STATUS.md.',
    )
    .category('multiagent')
    .stringParam('runId', 'Run ID from cs_ai_auto_assist', { required: true })
    .stringParam('rootPath', 'Project root path or entry file path', { required: true })
    .stringParam('entryFile', 'Optional explicit entry file when rootPath is a directory')
    .handler(async (params: Record<string, unknown>) => {
        const runId = String(params.runId ?? '');
        const ctx = getCtx(runId);
        if (!ctx) return errorResult(`unknown runId '${runId}' — invoke cs_ai_auto_assist first`, runId);

        const rootPath = getStr(params, 'rootPath');
        if (!rootPath || !fs.existsSync(rootPath)) {
            return errorResult(`provide a valid rootPath — '${rootPath}' does not exist`, runId);
        }
        ctx.startPhase('discover');
        try {
            const inventory = CSDiscovery.discover(rootPath, {
                entryFile: getStr(params, 'entryFile'),
            });
            ctx.writePhaseArtifact(
                'discover',
                'inventory.json',
                JSON.stringify(inventory, null, 2),
            );

            // Build the deterministic legacy signature: per-@Test action
            // count, per-page-class @FindBy field count, per-helper-method
            // leaf-action count. This is the floor every downstream gate
            // compares the LLM output against. Java-only for now — Selenium
            // is the dominant legacy stack we migrate from.
            let signature: FullSignature | null = null;
            const entryForSignature = inventory.entryFile ?? inventory.tests[0];
            if (entryForSignature && /\.java$/i.test(entryForSignature) && fs.existsSync(entryForSignature)) {
                try {
                    signature = CSLegacySignatureExtractor.extract(entryForSignature, {
                        pages: (inventory.pages ?? []).map((p) => {
                            const className = path.basename(p as string, '.java');
                            return { className, path: p as string };
                        }),
                        helpers: (inventory.helpers ?? []).map((h) => {
                            const className = path.basename(h as string, '.java');
                            return { className, path: h as string };
                        }),
                        workspaceRoot: rootPath,
                    });
                    ctx.writePhaseArtifact(
                        'discover',
                        'signature.json',
                        JSON.stringify(signature, null, 2),
                    );
                } catch (sigErr) {
                    // Signature extraction is best-effort. Don't fail the
                    // discover phase if a malformed source file blocks the
                    // parse — record the error and let downstream gates
                    // skip when signature.json is absent.
                    ctx.writePhaseArtifact(
                        'discover',
                        'signature-error.txt',
                        sigErr instanceof Error ? (sigErr.stack ?? sigErr.message) : String(sigErr),
                    );
                }
            }

            const md = renderInventoryMarkdown(inventory, signature);
            const reportPath = CSStatusWriter.writePhaseReport(
                ctx, 'discover', 'Legacy Project Inventory', md,
            );
            ctx.finishPhase('discover', 'done', { reportPath });
            CSStatusWriter.write(ctx);
            return jsonResult(
                {
                    state: 'RUNNING',
                    runId,
                    phase: 'discover',
                    counts: inventory.counts,
                    rootStyle: inventory.rootStyle,
                    language: inventory.language,
                    runFolder: ctx.runFolder,
                    reportPath,
                    signatureExtracted: signature !== null,
                    signatureSummary: signature ? {
                        tests: signature.tests.length,
                        pages: Object.keys(signature.pages).length,
                        helpers: Object.keys(signature.helpers).length,
                        unresolvedReferences: signature.unresolvedReferences.length,
                    } : undefined,
                    nextStepNeeded: true,
                    nextSuggestedTool: 'csaa_analyze',
                    nextSuggestedArgs: {
                        runId,
                        entryFile: inventory.entryFile ?? inventory.tests[0],
                    },
                },
                `Discover complete: ${inventory.counts.tests} tests / ${inventory.counts.pages} pages / ${inventory.counts.helpers} helpers / ${inventory.counts.dataFiles} data files. ${signature ? `Signature: ${signature.tests.length} @Test methods, ${Object.keys(signature.pages).length} page classes, ${Object.keys(signature.helpers).length} helper methods extracted.` : ''} Call csaa_analyze next.`,
            );
        } catch (err) {
            ctx.finishPhase('discover', 'blocked_user', {
                reason: err instanceof Error ? err.message : String(err),
            });
            CSStatusWriter.write(ctx);
            return errorResult(
                `csaa_discover failed: ${err instanceof Error ? err.message : String(err)}`,
                runId,
            );
        }
    })
    .build();

function renderInventoryMarkdown(inv: LegacyInventory, sig?: FullSignature | null): string {
    const sigSection = sig ? [
        ``,
        `## Legacy Signature (deterministic floor for verification gates)`,
        ``,
        `| @Test method | testCaseId | actions | helper invocations |`,
        `|---|---|---|---|`,
        ...sig.tests.map((t) => `| \`${t.methodName}\` | ${t.testCaseId ?? '—'} | ${t.actions.length} | ${t.helperInvocations.length} |`),
        ``,
        `### Page-class fields (legacy floor for generated @CSGetElement count)`,
        ``,
        `| Class | @FindBy fields | Methods |`,
        `|---|---|---|`,
        ...Object.values(sig.pages).map((p) => `| \`${p.className}\` | ${p.fields.length} | ${p.methods.length} |`),
        ``,
        ...(Object.keys(sig.helpers).length > 0 ? [
            `### Helper methods (each invocation in @Test must expand to ≥ N steps)`,
            ``,
            `| Helper | Actions |`,
            `|---|---|`,
            ...Object.entries(sig.helpers).map(([k, h]) => `| \`${k}\` | ${h.actions.length} |`),
            ``,
        ] : []),
        ...(sig.unresolvedReferences.length > 0 ? [
            `### Unresolved references (file/class not found in inventory)`,
            ``,
            ...sig.unresolvedReferences.slice(0, 20).map((r) => `- \`${r}\``),
            ``,
        ] : []),
    ].join('\n') : '';
    return originalRenderInventoryMarkdown(inv) + sigSection;
}

function originalRenderInventoryMarkdown(inv: LegacyInventory): string {
    return [
        `# Legacy Project Inventory`,
        ``,
        `**Root:** \`${inv.rootPath}\`  `,
        `**Style:** ${inv.rootStyle}  `,
        `**Language:** ${inv.language}`,
        ``,
        `## Counts`,
        ``,
        `| Kind | Count |`,
        `|---|---|`,
        `| Tests | ${inv.counts.tests} |`,
        `| Pages | ${inv.counts.pages} |`,
        `| Helpers | ${inv.counts.helpers} |`,
        `| Base classes | ${inv.counts.baseClasses} |`,
        `| Data files | ${inv.counts.dataFiles} |`,
        `| Properties files | ${inv.propertiesFiles.length} |`,
        `| Runner configs | ${inv.counts.runnerConfigs} |`,
        `| Feature files | ${inv.counts.features} |`,
        '',
    ].join('\n');
}

// ============================================================================
// csaa_analyze — Phase 3: delegate analysis to the host LLM
// ============================================================================
//
// Returns a delegation envelope. The host LLM (Copilot in agent mode,
// Claude Code, etc.) reads the envelope, runs the model with the
// instruction + grounding, produces JSON matching ANALYSIS_SCHEMA, then
// calls csaa_record_analysis with the produced payload.
//
// Why not parse the source ourselves: legacy test files use arbitrary
// helper-method delegation patterns. A regex/AST walker fails silently
// into placeholder content for any structure it doesn't recognise. The
// LLM can navigate any structure and is required to cite line numbers
// for every leaf call — anything it can't ground gets escalated as a
// gap, never as a stub.
// ============================================================================

const csaa_analyze: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('csaa_analyze')
    .title('CS-AI-Auto-Assist — Analyze (Phase 3)')
    .description(
        'Returns a delegation envelope instructing the host LLM to analyze a legacy ' +
            'test file. The LLM produces a structured analysis (scenarios + steps + pages + ' +
            'login contract + gaps) citing line numbers for every leaf call. Companion tool: ' +
            'csaa_record_analysis.',
    )
    .category('multiagent')
    .stringParam('runId', 'Run ID from cs_ai_auto_assist', { required: true })
    .stringParam('entryFile', 'Absolute path to entry test/feature file', { required: true })
    .stringParam('project', 'Target CS Playwright project name')
    .stringParam('module', 'Optional module sub-folder name')
    .stringParam('workspaceRoot', 'Workspace root for existing-pages lookup')
    .handler(async (params: Record<string, unknown>) => {
        const runId = String(params.runId ?? '');
        const ctx = getCtx(runId);
        if (!ctx) return errorResult(`unknown runId '${runId}'`, runId);

        const entryFile = getStr(params, 'entryFile');
        if (!entryFile || !fs.existsSync(entryFile)) {
            return errorResult(`provide a valid entryFile — '${entryFile}' does not exist`, runId);
        }
        const inventoryRaw = ctx.readPhaseArtifact('discover', 'inventory.json');
        if (!inventoryRaw) {
            return errorResult(
                `no inventory found — call csaa_discover before csaa_analyze`,
                runId,
            );
        }
        const inventory = JSON.parse(inventoryRaw) as LegacyInventory;

        // Project-name consistency gate.
        // csaa_classify extracts projectName from the user's intake prompt and
        // writes it to intake/classified.json. That is the source of truth.
        // If the caller (Copilot) drops the param or passes a different value
        // we must reject — silent fallback to "default" was the cause of the
        // config/<wrong>/ scaffold defect observed in production.
        const classifiedRaw = ctx.readPhaseArtifact('intake', 'classified.json');
        let classifiedProject: string | undefined;
        if (classifiedRaw) {
            try {
                const c = JSON.parse(classifiedRaw) as {
                    extractedFields?: { projectName?: string };
                };
                classifiedProject = c.extractedFields?.projectName;
            } catch { /* ignore */ }
        }
        const explicitProject = getStr(params, 'project');
        if (
            explicitProject &&
            explicitProject !== 'default' &&
            classifiedProject &&
            explicitProject.toLowerCase() !== classifiedProject.toLowerCase()
        ) {
            return errorResult(
                `project param mismatch — csaa_classify recorded projectName='${classifiedProject}' (in 01-intake/classified.json) but csaa_analyze was called with project='${explicitProject}'. Use a single project name across phase tools. Re-run csaa_classify with the desired project name, or call csaa_analyze with project='${classifiedProject}'.`,
                runId,
            );
        }
        const project = (
            explicitProject && explicitProject !== 'default'
                ? explicitProject
                : classifiedProject
        );
        if (!project || project === 'default') {
            return errorResult(
                `csaa_analyze requires a project name. classified.json does not contain extractedFields.projectName and the project param was ${explicitProject ? `'${explicitProject}' (rejected — 'default' is not a real project name)` : 'not supplied'}. Either re-run csaa_classify so it extracts projectName from the user intake, or call csaa_analyze with an explicit project='<name>'.`,
                runId,
            );
        }
        const module = getStr(params, 'module');
        const workspaceRoot = getStr(params, 'workspaceRoot');

        // Light validation only — don't read bytes into the envelope.
        // The host LLM reads via its built-in `read` tool to keep the tool
        // response small (VS Code Copilot truncates oversized responses to a
        // scratch file the agent can't fetch back).
        const stat = fs.statSync(entryFile);
        const MAX_BYTES = 512 * 1024;
        if (stat.size > MAX_BYTES) {
            return errorResult(
                `entryFile is ${stat.size} bytes (limit ${MAX_BYTES}); split into per-test runs`,
                runId,
            );
        }

        // Build a compact existing-pages index (paths + class names only).
        let existingPagesIndex: Array<{ className: string; relativePath: string }> = [];
        if (workspaceRoot && fs.existsSync(workspaceRoot)) {
            try {
                const inv = CSRepoInventory.inventory(project, { workspaceRoot });
                existingPagesIndex = inv.pages.slice(0, 100).map((p) => ({
                    className: p.className,
                    relativePath: p.relativePath,
                }));
            } catch { /* non-fatal */ }
        }

        ctx.startPhase('analyze');

        // Compact list of legacy-file paths the LLM may want to read.
        const helperFiles = inventory.helpers.slice(0, 30);
        const dataFiles = inventory.dataFiles.slice(0, 30);
        const inventoryPath = path.join(
            ctx.runFolder,
            CSRunContext.phaseFolder('discover'),
            'inventory.json',
        );

        const envelope: DelegationEnvelope = {
            task: 'analyze-legacy-test-file',
            instruction: [
                'You are analyzing a legacy Selenium/TestNG (or NUnit/MSTest) test file. Your output drives downstream translation. Shallow analysis = garbage translation.',
                '',
                'STEP 0 — READ the framework SKILL files first. Use your `read` tool on `<workspaceRoot>/.github/skills/<name>/SKILL.md` for EVERY entry in `grounding.mandatorySkills`. These document the conventions the audit will enforce. Skipping this step is the #1 source of regenerations.',
                '',
                'STEP 0.5 — READ the legacy signature at `<runFolder>/02-discover/signature.json`. This is the deterministic floor: per-@Test action counts (including helper expansion), per-page-class @FindBy field counts. Your analysis MUST cover at least 70% of legacy actions per scenario AND 80% of legacy fields per create-new page object. Below those floors, csaa_record_analysis rejects with specific shortfall details — you cannot pass with thin output. Two deterministic tools are wired specifically for this:',
                '  • `csaa_expand_helper(runId, helperClass, helperMethod)` — returns the ordered leaf-action list for any helper method. CALL IT FOR EVERY helper invocation in the @Test body. Then emit one Gherkin step per returned action.',
                '  • `csaa_extract_page_fields(runId, pageClass)` — returns every @FindBy field on a legacy page class. CALL IT FOR EVERY page class referenced by the @Test methods. Your generated page-object analysis entry must list at least 80% of those fields.',
                'These two tools mean you do NOT have to manually count or guess — the framework gives you the authoritative legacy data and asserts you matched it.',
                '',
                'STEP 1 — recursive dependency closure. Use `read` on:',
                '  (a) `grounding.entryFile` — the test class itself',
                '  (b) the `extends X` base class file — find it under the discovered source tree (look in inventory.pages and inventory.helpers for path resolution); READ its full body, find @BeforeMethod / @BeforeClass / setUp logic',
                '  (c) EVERY same-project Java/C# import in the entry file → READ each one. Then recursively, EVERY import in those files (depth ≤ 3) — pages, helpers, support methods.',
                '  Record EVERY file you read in `dependencyGraph[]` with `path` + `kind` (base-class / page-object / helper / login-page).',
                '',
                'STEP 2 — locate the login flow. From the base class:',
                '  - Find the login helper invocation (e.g. `signIn`, `login`, `*LoginPage.*`).',
                '  - READ the login page class file fully — extract URL, credential locators, post-login validation locator.',
                '  - Fill `loginContract.loginPageFile` + `loginContract.url` + `loginContract.credentialFields[]` + `loginContract.gherkinStep`.',
                '',
                'STEP 3 — ingest config / properties. The legacy project usually has:',
                '  - `<root>/resources/application.properties` (global)',
                '  - `<root>/resources/<env>/env.properties` (env-specific URL + credentials)',
                '  - `<root>/resources/<env>/SQLQueries.properties` (DB queries)',
                '  READ each one. For EVERY file you read, push `{path, env, keysExtracted: [...], values: {key:value, ...}}` into `configFiles[]`. **The `values` object is critical** — it feeds straight into the generated `config/<project>/environments/<env>.env`.',
                '  **BASE_URL MUST BE THE WEB-APP URL, NEVER A DATABASE STRING.** Legacy env.properties files usually have BOTH:',
                '    - `env.baseurl=https://app.example.com` (web URL — this is what BASE_URL needs)',
                '    - `db.connection.url=jdbc:oracle:thin:@//host:1521/svc` (JDBC — this is for DB queries, NOT for the browser)',
                '  Extract BOTH into `values`, but the scaffold prefers keys matching `*baseurl|appurl|webappurl|portalurl|uiurl|siteurl` over any `db.*` / `database.*` / `jdbc.*` / `datasource.*` / `connection.*` keys. The scaffold rejects values whose scheme is `jdbc:`, `mongodb:`, `redis:`, `amqp:`, `kafka:`, `ldap:`, `file:`, `ftp:` — those will NEVER land in BASE_URL. Use the original key spelling from the properties file (e.g. `env.baseurl`).',
                '  Credentials: extract `username` / `user` / `defaultUsername` and `password` / `pwd` / `defaultPassword`. Without these, environments/<env>.env has blank creds and the run is unrunnable.',
                '  At minimum env.properties must be read; if you cannot find it, add a high-severity gap.',
                '',
                'STEP 4 — read the legacy test-data file. If the inventory contains an .xls / .xlsx / .csv / .xml / .properties data file (see `grounding.dataFiles`), use `csaa_read_legacy_data` to fetch its rows. For EVERY scenario in your analysis, look up the data row by scenarioId and put the ACTUAL row columns (e.g. userName, userId, expectedError) into `scenarios[].dataRow`. Empty dataRows when a data file exists = run rejected.',
                '  **COLUMN-SHIFT GUARD.** If the returned row has values that equal their own keys (e.g. `{loginKey: "loginKey", aDENTId: "aDENTId"}` — the value IS the column header string), the xls reader picked up the HEADER row as data. This happens with merged cells, frozen panes, or shifted headers. Detect this: if ≥40% of values equal their keys, the row is corrupt. Options: (a) re-read with `csaa_read_legacy_data` using a different row offset / sheet, OR (b) set `dataRow: {}` for that scenario AND add a high-severity gap: `"Data row for scenarioId X is header-shifted in the legacy xls — manual extraction needed"`. Submitting header-shift rows as-is is automatically rejected.',
                '',
                'STEP 5 — for each legacy page-object Java class referenced by tests:',
                '  - READ the full *.java file from the inventory.pages list.',
                '  - Extract EVERY `@FindBy(...)` and `By.xpath(...)` / `By.id(...)` declaration. Use those exact strings.',
                '  - Set each `pages[].elements[].primaryLocator.source` to `legacy-file:<path>:<line>` (NEVER `inferred` unless you also add a high-severity gap explaining why).',
                '  - **OCR typo / fuzzy-match resolution.** If a referenced class name (e.g. `extends X`, `import com.example.X`, `xPage.method()` call site) is NOT present in inventory.pages or inventory.helpers, do a Levenshtein-distance check against the inventory before flagging as a gap. If the closest match has edit distance ≤ 2 OR character-set similarity ≥ 0.9, include the suggestion on the gap entry: `gaps.push({ severity: "high", detail: "<X> not found in inventory", suggestedFuzzyMatch: { from: "<X>", to: "<closestMatch>", editDistance: <n>, confidence: <0..1>, matchedInventoryPath: "<full path>" } })`. Common OCR typos: `SQL↔OQL`, `0↔O`, `1↔I`, `l↔I`, `rn↔m`. This lets the user approve the suggestion in a single round-trip instead of needing a full re-analyze.',
                '',
                'STEP 6 — for EVERY @Test method:',
                '  - Extract scenario id, title, runFlag from @MetaData / @Test annotations.',
                '  - For every Selenium action line (click, sendKeys, getText, waitFor, assert), produce ONE Gherkin step with `legacyCite` { lineNumber, snippet }.',
                '  - **HELPER-METHOD EXPANSION IS MANDATORY.** When the @Test body contains a helper call like `CTSGSupportMethod.TS_4958(dataBean)` or `xHelper.populateForm(...)` or `xUtil.runFlow(...)`, you MUST:',
                '      (a) read the helper class file fully (find it in inventory.helpers), add it to dependencyGraph[],',
                '      (b) for EACH leaf action inside the helper method (`field.sendKeys(...)`, `button.click()`, `assert*`), emit ONE Gherkin step in this scenario\'s steps[] with `legacyCite` pointing at the helper file + the specific line,',
                '      (c) DO NOT emit a single step like `"Execute shared support flow TS_4958"`, `"Run helper"`, `"Invoke method"`, `"Perform support routine"`, `"Call helper"`, `"Process via helper"`, etc. — every "delegate to helper" verb is rejected by the content gate. The helper has to be EXPANDED. If the helper does 12 actions, your scenario has 12 more steps in addition to the test\'s own actions.',
                '      (d) Test ids (TS_4958) NEVER appear in user-facing step text — only as `@TS_xxxx` tags or inside the data row.',
                '  - Disambiguate scenario titles: when two @Test methods have the same `testName` in @MetaData (common when one is SQL-flavor and another is Oracle-flavor), append a disambiguator to the title (e.g. `"New_On_Save_Rules (SQL)"` and `"New_On_Save_Rules (Oracle)"`). Two scenarios in the same feature with identical titles are rejected.',
                '  - Group locators by page; XPath primary, CSS alternatives.',
                '  - Reuse pages from `grounding.existingPagesIndex` when class name matches; set role=reuse-existing.',
                '',
                'STRICT RULES:',
                ' - NEVER invent a step / locator / URL / credential. Every claim must be grounded in a specific legacy file + line. If you can\'t ground it, add a `gaps[]` entry with severity=high.',
                ' - NEVER emit placeholder text like "TODO", "not implemented", "analyzer found no leaf calls", or "the operation should complete without errors".',
                ' - Self-assess readinessScore honestly. Below 0.7 the run halts.',
                '',
                'STEP 7 — submit the analysis. Two protocols, choose by scenario count:',
                '  (A) **≤3 scenarios with short step lists** → call `csaa_record_analysis(runId, payload)` ONCE with the full analysis JSON.',
                '  (B) **≥4 scenarios OR deep step lists** → STREAM to avoid blowing Copilot output-token caps. Loop: for EACH legacy @Test method call `csaa_append_analysis_scenario(runId, scenario)` with just that one scenario object (matches ANALYSIS_SCHEMA.scenarios[] — id/title/runFlag/steps/dataRow). Each call is small (~1–3 KB) so the message budget is never exceeded. When every scenario is appended, call `csaa_finalize_analysis(runId, payload)` with the REMAINING fields ONLY: source, feature, pages, dependencyGraph, configFiles, loginContract, gaps, readinessScore — DO NOT include scenarios in the finalize payload (they come from the scratch file). Finalize runs every gate from csaa_record_analysis and persists analysis-report.json. The scratch file survives conversation compaction — if Copilot summarizes, just continue appending or call finalize.',
                '',
                'RECOVERY — if your conversation got compacted between steps, re-read `<runFolder>/03-analyze/delegation-envelope.json` from disk to recover this full instruction + responseSchema. Then check `<runFolder>/03-analyze/scratch-scenarios.json` (if present) to see which scenarios were already submitted, and continue from there.',
            ].join('\n'),
            responseSchema: ANALYSIS_SCHEMA,
            grounding: {
                runId,
                project,
                module,
                entryFile,
                entryFileBytes: stat.size,
                inventoryPath,
                helperFiles,
                dataFiles,
                existingPagesIndex,
                skillsPath: '.github/skills/',
                mandatorySkills: [...MANDATORY_ANALYZE_SKILLS],
                frameworkConventions: [
                    '- BDD under test/<project>/features/<module>/*.feature',
                    '- Pages under test/<project>/pages/<module>/*.ts',
                    '- Steps under test/<project>/steps/<module>/*.steps.ts',
                    '- Data under test/<project>/data/<module>/*.json',
                    '- Locators: XPath primary, CSS alternatives via alternativeLocators[]',
                    '- All element interactions go through framework CSWebElement wrappers',
                ].join('\n'),
            },
            recordWith: 'csaa_record_analysis',
            recordArgs: { runId },
        };

        ctx.writePhaseArtifact(
            'analyze',
            'delegation-envelope.json',
            JSON.stringify(envelope, null, 2),
        );
        // Persist the user-supplied run params (project, module) at the
        // intake level so downstream phases — especially the config
        // scaffold in csaa_write — can route files to the right directory
        // without depending on whether the LLM happened to include them
        // in the recorded analysis JSON.
        ctx.writePhaseArtifact(
            'intake',
            'run-params.json',
            JSON.stringify({ project, module, entryFile }, null, 2),
        );
        CSStatusWriter.write(ctx);

        return jsonResult(
            {
                state: 'AWAITING_LLM_FULFILMENT',
                runId,
                phase: 'analyze',
                delegation: envelope,
                runFolder: ctx.runFolder,
                nextStepNeeded: true,
                nextSuggestedTool: 'csaa_record_analysis',
                nextSuggestedArgs: { runId },
            },
            `Analyze delegation ready. Read entryFileContents, produce JSON matching responseSchema, then call csaa_record_analysis(runId, payload).`,
        );
    })
    .build();

// ============================================================================
// csaa_record_analysis — Phase 3 fulfilment partner
// ============================================================================

const csaa_record_analysis: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('csaa_record_analysis')
    .title('CS-AI-Auto-Assist — Record Analysis (Phase 3 fulfilment)')
    .description(
        'Companion to csaa_analyze. Accepts the LLM-produced analysis JSON, validates it ' +
            'against ANALYSIS_SCHEMA, persists analysis-report.json, and gates progression on ' +
            'readinessScore >= 0.7. Below threshold returns gap details for the user.',
    )
    .category('multiagent')
    .stringParam('runId', 'Run ID', { required: true })
    .objectParam(
        'payload',
        'REQUIRED. The LLM-produced analysis JSON object matching ANALYSIS_SCHEMA. Pass as `payload: { source: {...}, feature: {...}, scenarios: [...], pages: [...], loginContract: {...}, dependencyGraph: [...], configFiles: [...], readinessScore: <num>, gaps: [...] }`. This is the analysis you produced after reading the csaa_analyze envelope grounding.',
        undefined,
        { required: true },
    )
    .handler(async (params: Record<string, unknown>) => {
        const runId = String(params.runId ?? '');
        const ctx = getCtx(runId);
        if (!ctx) return errorResult(`unknown runId '${runId}'`, runId);

        const payload = params.payload;
        if (typeof payload !== 'object' || payload === null) {
            return errorResult(`payload must be an object`, runId);
        }

        const errors = CSSchemaValidator.validate(payload, ANALYSIS_SCHEMA);
        if (errors.length > 0) {
            const summary = errors.slice(0, 10).map((e) => `${e.path}: ${e.message}`).join('\n');
            ctx.writePhaseArtifact(
                'analyze',
                'validation-errors.json',
                JSON.stringify(errors, null, 2),
            );
            return jsonResult(
                {
                    state: 'AWAITING_LLM_RETRY',
                    runId,
                    phase: 'analyze',
                    validationErrors: errors,
                    nextStepNeeded: true,
                    nextSuggestedTool: 'csaa_record_analysis',
                    feedback: `Payload failed schema validation. Fix the errors below and re-call csaa_record_analysis with corrected JSON.\n\n${summary}`,
                },
                `Analysis payload failed schema validation (${errors.length} errors). Retry with corrected JSON.`,
            );
        }

        const analysis = payload as Record<string, unknown> & {
            scenarios: Array<{ id: string; dataRow?: Record<string, unknown> }>;
            pages: Array<{ elements?: Array<{ primaryLocator?: { source?: string } }>}>;
            dependencyGraph?: Array<{ path: string; kind: string }>;
            configFiles?: Array<{ path: string }>;
            readinessScore?: number;
            gaps?: Array<{ severity: string; detail: string }>;
        };

        // Cross-field semantic checks beyond the JSON schema:
        const semanticErrors: string[] = [];

        // 1. dependencyGraph must have ≥3 entries for a real migration
        //    (entry + base class + at least one page object).
        if (!Array.isArray(analysis.dependencyGraph) || analysis.dependencyGraph.length < 3) {
            semanticErrors.push(
                `dependencyGraph has ${analysis.dependencyGraph?.length ?? 0} entries (need ≥3). Did you actually walk the legacy import tree? READ the base class, every imported page, and every helper before re-submitting.`,
            );
        }

        // 2. configFiles must include at least one env-specific properties file.
        const hasEnvConfig = (analysis.configFiles ?? []).some((c) =>
            /env\.properties|envconfig|environment\.properties/i.test(c.path),
        );
        if (!hasEnvConfig) {
            semanticErrors.push(
                `configFiles[] is missing an env-specific properties file (e.g. resources/<env>/env.properties). READ it for URL + credentials before re-submitting.`,
            );
        }

        // 3. Locator source grounding — `inferred` only allowed if paired
        //    with a high-severity gap, never as the default.
        for (let pi = 0; pi < analysis.pages.length; pi++) {
            const page = analysis.pages[pi];
            const els = page.elements ?? [];
            for (let ei = 0; ei < els.length; ei++) {
                const src = els[ei].primaryLocator?.source;
                if (src === 'inferred') {
                    const hasGap = (analysis.gaps ?? []).some(
                        (g) => g.severity === 'high' && /locator|element|xpath/i.test(g.detail),
                    );
                    if (!hasGap) {
                        semanticErrors.push(
                            `pages[${pi}].elements[${ei}].primaryLocator.source is 'inferred' but no high-severity locator gap exists. Either ground it in a legacy file (source: 'legacy-file:<path>:<line>') or add a gaps[] entry explaining why grounding failed.`,
                        );
                    }
                }
            }
        }

        // 4. scenarios[].dataRow must be non-empty IF data files were
        //    discovered in step 4 (look at inventory).
        const inventoryRawForCheck = ctx.readPhaseArtifact('discover', 'inventory.json');
        const inventoryHasDataFiles = inventoryRawForCheck
            ? ((JSON.parse(inventoryRawForCheck) as { dataFiles?: string[] }).dataFiles?.length ?? 0) > 0
            : false;
        if (inventoryHasDataFiles) {
            const scenariosMissingData = analysis.scenarios.filter(
                (s) => !s.dataRow || Object.keys(s.dataRow).length === 0,
            );
            if (scenariosMissingData.length > 0) {
                semanticErrors.push(
                    `${scenariosMissingData.length} of ${analysis.scenarios.length} scenarios have empty dataRow{}, but the legacy project has data files. Use \`csaa_read_legacy_data\` on each data file and populate dataRow per scenarioId before re-submitting.`,
                );
            }
        }

        // 5. Reject "I admit I made this up" dataRow shapes. LLMs sometimes
        //    wrap fabricated rows in {originalKeyFound: false, sampleRow:
        //    {...}} or {synthesized: true, ...} to satisfy the schema while
        //    avoiding the work of reading the real xls. Treat these as
        //    high-severity gaps, not as valid data.
        const suspiciousMarkers = ['originalKeyFound', 'sampleRow', 'synthesized', 'hallucinated', 'placeholder', 'fabricated', 'guessed'];
        const suspiciousScenarios: Array<{ id: string; markers: string[] }> = [];
        for (const s of analysis.scenarios) {
            if (!s.dataRow) continue;
            const dr = s.dataRow as Record<string, unknown>;
            const hits = suspiciousMarkers.filter((m) => m in dr);
            // Also catch the case where the entire dataRow is a wrapper with
            // ONLY meta keys (originalKeyFound + sampleRow) instead of real columns.
            const realColumnCount = Object.keys(dr).filter(
                (k) => !suspiciousMarkers.includes(k),
            ).length;
            const hasFalseFlag = dr.originalKeyFound === false ||
                                 (dr as { synthesized?: boolean }).synthesized === true ||
                                 (dr as { hallucinated?: boolean }).hallucinated === true;
            if (hits.length > 0 && (hasFalseFlag || realColumnCount === 0)) {
                suspiciousScenarios.push({ id: s.id, markers: hits });
            }
        }
        if (suspiciousScenarios.length > 0) {
            const list = suspiciousScenarios.slice(0, 5).map(
                (s) => `  - scenario "${s.id}" dataRow contains [${s.markers.join(', ')}]`,
            ).join('\n');
            semanticErrors.push(
                `${suspiciousScenarios.length} scenario(s) have fabricated dataRow shapes (meta-fields like 'originalKeyFound:false' or 'sampleRow'):\n${list}\n\nThis pattern signals the LLM couldn't find the real row in the data file and invented one. Either:\n  a) Re-read the data file with csaa_read_legacy_data and use the ACTUAL row, OR\n  b) Add a high-severity gap describing the missing data row and leave dataRow as empty {}\n\nDo NOT wrap fake data in a 'sampleRow' envelope.`,
            );
        }

        // 6. `role: 'reuse-existing'` requires the existingFilePath to
        //    actually exist on disk. Without this check, the LLM marks
        //    pages as reuse-existing to skip emitting page-object files,
        //    even when nothing exists to reuse from.
        const consumerRoot = (() => {
            const rp = ctx.readPhaseArtifact('intake', 'run-params.json');
            if (!rp) return undefined;
            try {
                const r = JSON.parse(rp) as { entryFile?: string };
                if (!r.entryFile) return undefined;
                // Walk up from entryFile until we find a node_modules or .git folder.
                let dir = path.dirname(r.entryFile);
                for (let i = 0; i < 8; i++) {
                    if (fs.existsSync(path.join(dir, 'node_modules')) ||
                        fs.existsSync(path.join(dir, 'package.json'))) {
                        return dir;
                    }
                    const parent = path.dirname(dir);
                    if (parent === dir) break;
                    dir = parent;
                }
            } catch { /* ignore */ }
            return undefined;
        })();
        // Derive the project name for the test/<project>/pages/ check from
        // intake/run-params.json — same source the scaffold + write phases use.
        let projectForReuse: string | undefined;
        const rpForReuse = ctx.readPhaseArtifact('intake', 'run-params.json');
        if (rpForReuse) {
            try {
                const rp = JSON.parse(rpForReuse) as { project?: string };
                projectForReuse = rp.project;
            } catch { /* ignore */ }
        }
        const phantomReuseEntries: Array<{ index: number; className: string; path: string; reason: string }> = [];
        analysis.pages.forEach((p, i) => {
            const role = (p as { role?: string }).role;
            const existingFilePath = (p as { existingFilePath?: string }).existingFilePath;
            const className = (p as { className?: string }).className ?? `pages[${i}]`;
            if (role !== 'reuse-existing' && role !== 'extend-existing') return;
            if (!existingFilePath) {
                phantomReuseEntries.push({ index: i, className, path: '(no existingFilePath set)', reason: 'missing existingFilePath' });
                return;
            }
            // Reject pointers at legacy source folders or .java/.cs files —
            // 'reuse-existing' means an already-translated CS Playwright page
            // exists, NOT that the legacy file exists.
            const pathLower = existingFilePath.toLowerCase().replace(/\\/g, '/');
            if (pathLower.endsWith('.java') || pathLower.endsWith('.cs') || pathLower.endsWith('.cls')) {
                phantomReuseEntries.push({
                    index: i,
                    className,
                    path: existingFilePath,
                    reason: 'points at legacy source file (.java/.cs); reuse-existing requires an already-translated .ts page',
                });
                return;
            }
            if (/(^|\/)legacy[^/]*\//i.test(pathLower) ||
                /(^|\/)src\/(main|test)\/java\//i.test(pathLower)) {
                phantomReuseEntries.push({
                    index: i,
                    className,
                    path: existingFilePath,
                    reason: 'points inside a legacy source folder; reuse-existing requires the translated .ts under test/<project>/pages/',
                });
                return;
            }
            if (!pathLower.endsWith('.ts')) {
                phantomReuseEntries.push({
                    index: i,
                    className,
                    path: existingFilePath,
                    reason: 'must point at a .ts file under test/<project>/pages/',
                });
                return;
            }
            // Path must live under test/<project>/pages/ (or the project tree).
            const expectedFragment = projectForReuse
                ? `test/${projectForReuse.toLowerCase()}/pages/`
                : '/pages/';
            if (!pathLower.includes(expectedFragment) && !pathLower.includes('/pages/')) {
                phantomReuseEntries.push({
                    index: i,
                    className,
                    path: existingFilePath,
                    reason: `must live under ${expectedFragment}, not the path provided`,
                });
                return;
            }
            // Resolve against consumer root if relative.
            const abs = path.isAbsolute(existingFilePath)
                ? existingFilePath
                : (consumerRoot ? path.resolve(consumerRoot, existingFilePath) : existingFilePath);
            if (!fs.existsSync(abs)) {
                phantomReuseEntries.push({ index: i, className, path: existingFilePath, reason: 'file does not exist on disk' });
            }
        });
        if (phantomReuseEntries.length > 0) {
            const list = phantomReuseEntries.slice(0, 10).map(
                (e) => `  - pages[${e.index}] ("${e.className}") role=reuse-existing rejected: ${e.reason}. Path: ${e.path}`,
            ).join('\n');
            semanticErrors.push(
                `${phantomReuseEntries.length} page(s) marked 'reuse-existing' but the existingFilePath is invalid:\n${list}\n\n'reuse-existing' means "an already-translated CS Playwright page lives at this path, do not regenerate it" — the path MUST be an existing .ts file under test/<project>/pages/. Pointing at the legacy .java file (or any source-folder path) is wrong. If nothing translated exists yet, set role='create-new'.`,
            );
        }

        // 7. @Test count cross-check. The recorded scenarios should match
        //    the number of @Test (or [Test], [TestMethod]) annotations in
        //    the entry file. The LLM tends to silently drop scenarios it
        //    couldn't fully analyze.
        const runParamsRawForTestCount = ctx.readPhaseArtifact('intake', 'run-params.json');
        if (runParamsRawForTestCount) {
            try {
                const rp = JSON.parse(runParamsRawForTestCount) as { entryFile?: string };
                if (rp.entryFile && fs.existsSync(rp.entryFile)) {
                    const src = fs.readFileSync(rp.entryFile, 'utf-8');
                    // Match @Test (Java/TestNG/JUnit), [Test], [TestMethod] (C#/NUnit/MSTest).
                    // Strict: must be on its own line or preceded by whitespace, followed by either
                    // newline, opening paren, or the public/protected/private keyword.
                    const testAnnotPattern = /(^|\s)(@Test\b|\[Test\]|\[TestMethod\]|\[Fact\])/g;
                    const matches = src.match(testAnnotPattern) ?? [];
                    const declared = matches.length;
                    const captured = analysis.scenarios.length;
                    if (declared > captured && declared - captured >= 1) {
                        semanticErrors.push(
                            `Entry file declares ${declared} test method(s) (@Test / [Test] / [TestMethod] / [Fact] annotations) but analysis only captured ${captured} scenarios. ${declared - captured} test(s) were silently dropped — every legacy test must be represented as a scenario (or explicitly listed as a high-severity gap if it can't be analyzed).`,
                        );
                    }
                }
            } catch { /* non-fatal */ }
        }

        // 8. Column-shift detection in scenarios[].dataRow.
        //    The legacy xls extractor sometimes returns the HEADER row as
        //    data (e.g. {loginKey: "loginKey", aDENTId: "aDENTId"}). The
        //    LLM faithfully copies these strings instead of flagging them.
        //    Reject when ≥40% of values in a scenario's dataRow equal their
        //    own keys — that's a column-shift artifact, not real data.
        const headerShiftScenarios: Array<{ id: string; matchCount: number; total: number }> = [];
        for (const s of analysis.scenarios) {
            const dr = (s as { dataRow?: Record<string, unknown> }).dataRow;
            if (!dr || typeof dr !== 'object') continue;
            const entries = Object.entries(dr);
            const meta = new Set(['scenarioId', 'scenarioName', 'runFlag']);
            const real = entries.filter(([k]) => !meta.has(k));
            if (real.length < 3) continue;
            const headerMatches = real.filter(([k, v]) => typeof v === 'string' && v === k).length;
            if (headerMatches / real.length >= 0.4) {
                headerShiftScenarios.push({ id: s.id, matchCount: headerMatches, total: real.length });
            }
        }
        if (headerShiftScenarios.length > 0) {
            const list = headerShiftScenarios.slice(0, 5).map(
                (h) => `  - scenario "${h.id}" has ${h.matchCount}/${h.total} dataRow values equal to their own keys`,
            ).join('\n');
            semanticErrors.push(
                `${headerShiftScenarios.length} scenario(s) have column-shifted dataRow — the values are the COLUMN HEADER strings, not real data:\n${list}\n\nThis happens when the legacy xls has merged cells, a frozen pane, or the header row is at a different offset than xlsx assumed. Re-read the data file with csaa_read_legacy_data using a different row offset, OR for each affected scenario set dataRow to {} and add a high-severity gap describing the data extraction problem.`,
            );
        }

        // 9. Helper-method expansion. If a scenario step's legacyCite snippet
        //    invokes a helper class (anything ending in *SupportMethod /
        //    *Helper / *Util / *Service / *Factory) but the scenario has ≤2
        //    steps total (login + the helper invocation, with no expansion),
        //    the helper wasn't expanded. Helpers MUST be opened and their
        //    leaf actions inlined as Gherkin steps.
        const HELPER_CLASS_RE = /\b([A-Z][a-zA-Z0-9]*(?:SupportMethod|Helper|Util|Service|Factory|Manager|Provider))\b\s*\.\s*[A-Z_][a-zA-Z0-9_]+\s*\(/;
        const unexpandedHelpers: Array<{ scenarioId: string; helperRef: string; stepCount: number }> = [];
        for (const s of analysis.scenarios) {
            const steps = (s as { steps?: Array<{ legacyCite?: { snippet?: string } }> }).steps ?? [];
            if (steps.length === 0) continue;
            const helperRefs = new Set<string>();
            for (const st of steps) {
                const snip = st.legacyCite?.snippet;
                if (!snip) continue;
                const m = snip.match(HELPER_CLASS_RE);
                if (m) helperRefs.add(m[1]);
            }
            if (helperRefs.size === 0) continue;
            // Tolerance: if scenario has at least (1 login step + 1 helper-ref + 3 real action steps)
            // we accept that helpers were partially expanded. Otherwise reject.
            const nonLoginSteps = steps.filter((st) => {
                const t = (st as { text?: string }).text ?? '';
                return !/^\s*(I\s+log\s+in|I\s+am\s+(?:logged\s+in|signed\s+in)|sign\s+in)/i.test(t);
            }).length;
            if (nonLoginSteps < 4) {
                unexpandedHelpers.push({
                    scenarioId: s.id,
                    helperRef: Array.from(helperRefs).join(', '),
                    stepCount: steps.length,
                });
            }
        }
        if (unexpandedHelpers.length > 0) {
            const list = unexpandedHelpers.slice(0, 5).map(
                (u) => `  - scenario "${u.scenarioId}" references helper(s) [${u.helperRef}] but has only ${u.stepCount} step(s)`,
            ).join('\n');
            semanticErrors.push(
                `${unexpandedHelpers.length} scenario(s) reference helper classes but the helper body was NOT expanded inline:\n${list}\n\nWhen a legacy test calls e.g. CTSGSupportMethod.TS_4958(dataBean), that helper does N internal actions (fill firstName, fill lastName, select role, click Save, ...). You MUST: (a) read the helper class file, (b) for each leaf action inside the helper method, emit ONE Gherkin step in this scenario's steps[] with legacyCite pointing at the helper file + line, (c) add the helper file to dependencyGraph. Do NOT emit a single "Execute shared support flow" / "Run helper" / "Invoke method" step — those stubs are rejected. If the helper file is genuinely unreadable, add a high-severity gap explaining why.`,
            );
        }

        // 10. Semantic verification against deterministic legacy signature.
        //     This is the gate that breaks the iteration loop. The LLM can
        //     no longer pass with thin output — every scenario's step count
        //     and every page class's presence are compared against the
        //     extracted signature.json. Threshold is 70% (lenient — the
        //     legacy extractor undercounts due to regex limits, and some
        //     legacy actions don't map 1:1 to Gherkin steps).
        const sigRawForCompare = ctx.readPhaseArtifact('discover', 'signature.json');
        if (sigRawForCompare) {
            try {
                const sig = JSON.parse(sigRawForCompare) as FullSignature;
                const COVERAGE_THRESHOLD = 0.70;

                // (a) Per-scenario step count vs legacy action count
                //     (including transitive helper expansion).
                const stepShortfall: Array<{
                    scenarioId: string;
                    legacyMethod: string;
                    legacyActions: number;
                    generatedSteps: number;
                    coverage: number;
                }> = [];
                for (const aScn of analysis.scenarios) {
                    // Match by testCaseId or by legacyMethodName.
                    const t = sig.tests.find((x) =>
                        (x.testCaseId && `TS_${x.testCaseId}` === aScn.id) ||
                        (x.testCaseId && x.testCaseId === aScn.id) ||
                        (x.testCaseId && aScn.id.endsWith(x.testCaseId)) ||
                        (x.methodName && (aScn as { legacyMethodName?: string }).legacyMethodName === x.methodName),
                    );
                    if (!t) continue;
                    const expected = CSLegacySignatureExtractor.expectedActionCount(t, sig.helpers);
                    if (expected < 3) continue; // skip trivially short legacy tests
                    const generated = ((aScn as { steps?: unknown[] }).steps ?? []).length;
                    const coverage = generated / expected;
                    if (coverage < COVERAGE_THRESHOLD) {
                        stepShortfall.push({
                            scenarioId: aScn.id,
                            legacyMethod: t.methodName,
                            legacyActions: expected,
                            generatedSteps: generated,
                            coverage,
                        });
                    }
                }
                if (stepShortfall.length > 0) {
                    const list = stepShortfall.slice(0, 6).map(
                        (s) => `  - scenario "${s.scenarioId}" (${s.legacyMethod}): ${s.generatedSteps}/${s.legacyActions} steps (${Math.round(s.coverage * 100)}% — floor 70%)`,
                    ).join('\n');
                    semanticErrors.push(
                        `${stepShortfall.length} scenario(s) have FAR fewer Gherkin steps than the legacy @Test does leaf actions (after helper expansion). The deterministic signature extractor counted the legacy floor:\n${list}\n\nThis is the #1 cause of "30% works" output. Fix by:\n  1. For each shortfall scenario, call csaa_expand_helper(runId, helperClass, helperMethod) for EVERY helper invocation in the legacy @Test body — it returns the ordered leaf actions inside the helper.\n  2. Emit ONE Gherkin step per returned action (cite the helper file + line in legacyCite).\n  3. Add all element interactions, validations, multi-step error paths the legacy test does.\n  4. Re-record analysis (or re-append affected scenarios via csaa_append_analysis_scenario).`,
                    );
                }

                // (b) Page-class coverage: every page class the entry file
                //     references must appear in analysis.pages[]. Missing
                //     pages = silent omission (e.g. UserSecurityPage skipped).
                const referencedPages = new Set<string>();
                for (const t of sig.tests) {
                    for (const c of t.pageClassesUsed) referencedPages.add(c);
                }
                for (const c of Object.keys(sig.pages)) referencedPages.add(c);
                const analysedPageClassNames = new Set(
                    (analysis.pages ?? []).map((p) => (p as { className: string }).className),
                );
                const missingPages: string[] = [];
                for (const c of referencedPages) {
                    // Tolerate suffix/case variation — the LLM sometimes
                    // renames AdministrationMaintainSQLUsersPage to
                    // MaintainSqlUsersPage. Check by stripping "Page" and
                    // lower-casing.
                    const normalised = (s: string) => s.toLowerCase().replace(/page$/i, '');
                    const target = normalised(c);
                    const hit = Array.from(analysedPageClassNames).some(
                        (a) => normalised(a) === target,
                    );
                    if (!hit) missingPages.push(c);
                }
                if (missingPages.length > 0) {
                    semanticErrors.push(
                        `Analysis omitted ${missingPages.length} page class(es) the legacy entry file references: ${missingPages.slice(0, 10).map((p) => `"${p}"`).join(', ')}${missingPages.length > 10 ? `, …${missingPages.length - 10} more` : ''}.\n\nEvery legacy page class used by the @Test methods must appear in analysis.pages[] — either as role=create-new (with elements pulled from the legacy file) or as role=reuse-existing (pointing at an already-translated .ts under test/<project>/pages/). For each missing class, call csaa_extract_page_fields(runId, pageClass) to get the authoritative field list, then add the page entry.`,
                    );
                }

                // (c) Per-page-object field-count floor for create-new pages.
                //     Each page declared in the analysis with role=create-new
                //     must have ≥80% of the legacy field count. The looser
                //     threshold acknowledges that some Java fields (labels,
                //     headers) translate to assertions not standalone elements.
                const fieldShortfall: Array<{
                    pageClass: string;
                    legacyFields: number;
                    generatedFields: number;
                    coverage: number;
                }> = [];
                for (const p of analysis.pages ?? []) {
                    const role = (p as { role?: string }).role;
                    if (role !== 'create-new') continue;
                    const className = (p as { className: string }).className;
                    // Match against signature.pages by class name (case-insensitive).
                    const sigPage = Object.values(sig.pages).find(
                        (sp) => sp.className.toLowerCase() === className.toLowerCase(),
                    );
                    if (!sigPage || sigPage.fields.length < 5) continue;
                    const elements = ((p as { elements?: unknown[] }).elements ?? []).length;
                    const coverage = elements / sigPage.fields.length;
                    if (coverage < 0.80) {
                        fieldShortfall.push({
                            pageClass: className,
                            legacyFields: sigPage.fields.length,
                            generatedFields: elements,
                            coverage,
                        });
                    }
                }
                if (fieldShortfall.length > 0) {
                    const list = fieldShortfall.slice(0, 6).map(
                        (f) => `  - page "${f.pageClass}": ${f.generatedFields}/${f.legacyFields} elements (${Math.round(f.coverage * 100)}% — floor 80%)`,
                    ).join('\n');
                    semanticErrors.push(
                        `${fieldShortfall.length} page object(s) have far fewer elements than the legacy class declares. Floor is 80% of legacy @FindBy count:\n${list}\n\nFor each shortfall page, call csaa_extract_page_fields(runId, pageClass) to get the authoritative @FindBy field list and emit a matching @CSGetElement for each one.`,
                    );
                }
            } catch { /* malformed signature — ignore, downstream still functional */ }
        }

        if (semanticErrors.length > 0) {
            ctx.writePhaseArtifact(
                'analyze',
                'semantic-errors.json',
                JSON.stringify(semanticErrors, null, 2),
            );
            return jsonResult(
                {
                    state: 'AWAITING_LLM_RETRY',
                    runId,
                    phase: 'analyze',
                    semanticErrors,
                    nextStepNeeded: true,
                    nextSuggestedTool: 'csaa_record_analysis',
                    feedback: `Analysis is shallow. Specifically:\n${semanticErrors.map((e) => `  - ${e}`).join('\n')}\n\nRedo the missing reads, fill the fields, re-call csaa_record_analysis.`,
                },
                `Analysis rejected (${semanticErrors.length} semantic error(s)). Retry.`,
            );
        }

        ctx.writePhaseArtifact(
            'analyze',
            'analysis-report.json',
            JSON.stringify(analysis, null, 2),
        );

        const readinessScore = typeof analysis.readinessScore === 'number'
            ? analysis.readinessScore
            : 1.0;
        const highSeverityGaps = (analysis.gaps ?? []).filter((g) => g.severity === 'high').length;

        const md = renderAnalyzeMarkdown(analysis, readinessScore);
        const reportPath = CSStatusWriter.writePhaseReport(
            ctx, 'analyze', 'Analysis Report', md,
        );

        // Gate: readinessScore < 0.7 OR ≥3 high-severity gaps → halt for user.
        if (readinessScore < 0.7 || highSeverityGaps >= 3) {
            ctx.finishPhase('analyze', 'blocked_user', {
                reason: `low readiness (${readinessScore.toFixed(2)}) or ${highSeverityGaps} high-severity gaps`,
                reportPath,
            });
            CSStatusWriter.write(ctx);

            // Surface fuzzy-match suggestions prominently so the user can
            // approve them in a single round-trip without a full re-analyze.
            const gapsWithSuggestions = (analysis.gaps ?? []).filter(
                (g) => typeof (g as { suggestedFuzzyMatch?: unknown }).suggestedFuzzyMatch === 'object',
            ) as Array<{
                detail: string;
                suggestedFuzzyMatch?: { from: string; to: string; confidence?: number; editDistance?: number };
            }>;
            const fuzzyLines = gapsWithSuggestions.map((g) =>
                `  • ${g.detail}\n    → Suggested: ${g.suggestedFuzzyMatch?.from} → ${g.suggestedFuzzyMatch?.to}` +
                (typeof g.suggestedFuzzyMatch?.confidence === 'number'
                    ? ` (confidence ${g.suggestedFuzzyMatch.confidence.toFixed(2)})`
                    : '') +
                (typeof g.suggestedFuzzyMatch?.editDistance === 'number'
                    ? `, edit distance ${g.suggestedFuzzyMatch.editDistance}`
                    : ''),
            );
            const fuzzyHint = fuzzyLines.length > 0
                ? `\n\nFuzzy-match suggestions (likely OCR typos — confirm or reject each):\n${fuzzyLines.join('\n')}\n\nTo accept all suggestions in one round-trip, reply: "Accept all fuzzy matches and re-record analysis." The LLM will rewrite the analysis with each from→to applied globally and clear the corresponding gaps[] entries.`
                : '';

            return jsonResult(
                {
                    state: 'BLOCKED_NEED_HUMAN',
                    runId,
                    phase: 'analyze',
                    readinessScore,
                    highSeverityGaps,
                    gaps: analysis.gaps ?? [],
                    fuzzyMatchSuggestions: gapsWithSuggestions.map((g) => g.suggestedFuzzyMatch),
                    runFolder: ctx.runFolder,
                    reportPath,
                    nextStepNeeded: true,
                    blockedReason: `Readiness ${readinessScore.toFixed(2)} below 0.7 threshold or ${highSeverityGaps} high-severity gaps. Resolve in source / provide missing files, then re-run csaa_analyze.${fuzzyHint}`,
                },
                `Analysis blocked: readiness ${readinessScore.toFixed(2)}, ${highSeverityGaps} high gaps${fuzzyLines.length ? ` (${fuzzyLines.length} with fuzzy suggestions)` : ''}.`,
            );
        }

        ctx.finishPhase('analyze', 'done', { reportPath });
        CSStatusWriter.write(ctx);
        return jsonResult(
            {
                state: 'RUNNING',
                runId,
                phase: 'analyze',
                scenarioCount: analysis.scenarios.length,
                pageCount: analysis.pages.length,
                readinessScore,
                gapCount: (analysis.gaps ?? []).length,
                runFolder: ctx.runFolder,
                reportPath,
                nextStepNeeded: true,
                nextSuggestedTool: 'csaa_plan',
                nextSuggestedArgs: { runId },
            },
            `Analysis recorded: ${analysis.scenarios.length} scenarios, ${analysis.pages.length} pages, readiness ${readinessScore.toFixed(2)}. Call csaa_plan next.`,
        );
    })
    .build();

// ============================================================================
// csaa_append_analysis_scenario — chunked recording (one scenario at a time)
// ============================================================================
// VS Code Copilot's per-message output cap forces large analyses (>3 scenarios
// with deep step lists) to be streamed in chunks. Each append call carries
// one scenario payload (~1–3 KB) so individual tool turns never blow the
// output budget. Once all scenarios are staged, the caller invokes
// csaa_finalize_analysis with the rest of the analysis JSON; that tool
// reads the staged scenarios from the scratch file and re-dispatches into
// csaa_record_analysis so gate logic stays single-sourced.

const csaa_append_analysis_scenario: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('csaa_append_analysis_scenario')
    .title('CS-AI-Auto-Assist — Append one analysis scenario (chunked)')
    .description(
        'Streams ONE scenario into the analyze scratch file. Use this whenever the full ' +
            'analysis JSON would exceed Copilot per-message output limits (4+ scenarios with full ' +
            'step detail is a safe threshold). Validate the scenario subset against ' +
            'ANALYSIS_SCHEMA.scenarios[]. When every legacy @Test has been appended, call ' +
            'csaa_finalize_analysis with the remaining fields (source/feature/pages/dependencyGraph/' +
            'configFiles/loginContract/gaps/readinessScore — NO scenarios). The scratch file ' +
            'survives conversation compaction.',
    )
    .category('multiagent')
    .stringParam('runId', 'Run ID', { required: true })
    .objectParam(
        'scenario',
        'REQUIRED. One scenario object matching ANALYSIS_SCHEMA.scenarios[]. Required keys: id, title, runFlag, steps[]. Each step needs keyword/text/legacyCite. Include dataRow when a legacy data file exists.',
        undefined,
        { required: true },
    )
    .handler(async (params: Record<string, unknown>) => {
        const runId = String(params.runId ?? '');
        const ctx = getCtx(runId);
        if (!ctx) return errorResult(`unknown runId '${runId}'`, runId);

        const scenario = params.scenario;
        if (typeof scenario !== 'object' || scenario === null) {
            return errorResult(`scenario must be an object`, runId);
        }

        // Schema-validate the scenario subset.
        const scenarioSchema = (
            ANALYSIS_SCHEMA as {
                properties?: { scenarios?: { items?: Record<string, unknown> } };
            }
        ).properties?.scenarios?.items;
        if (scenarioSchema) {
            const errors = CSSchemaValidator.validate(scenario, scenarioSchema);
            if (errors.length > 0) {
                return jsonResult(
                    {
                        state: 'AWAITING_LLM_RETRY',
                        runId,
                        phase: 'analyze',
                        validationErrors: errors,
                        nextStepNeeded: true,
                        nextSuggestedTool: 'csaa_append_analysis_scenario',
                        feedback: `Scenario failed schema validation. Fix and re-call csaa_append_analysis_scenario:\n${errors.slice(0, 8).map((e) => `  ${e.path}: ${e.message}`).join('\n')}`,
                    },
                    `Scenario validation failed (${errors.length} error(s)).`,
                );
            }
        }

        const scratchRaw = ctx.readPhaseArtifact('analyze', 'scratch-scenarios.json');
        const list: unknown[] = scratchRaw ? JSON.parse(scratchRaw) : [];
        const id = (scenario as { id?: string }).id ?? `[${list.length}]`;

        // Reject duplicate id within the same staging session.
        if (list.some((s) => (s as { id?: string }).id === id)) {
            return jsonResult(
                {
                    state: 'AWAITING_LLM_RETRY',
                    runId,
                    phase: 'analyze',
                    nextStepNeeded: true,
                    nextSuggestedTool: 'csaa_append_analysis_scenario',
                    feedback: `Scenario id "${id}" was already appended in this run. Either re-emit with a unique id, or proceed to csaa_finalize_analysis if you've recorded every legacy @Test.`,
                },
                `Duplicate scenario id "${id}".`,
            );
        }

        list.push(scenario);
        ctx.writePhaseArtifact(
            'analyze',
            'scratch-scenarios.json',
            JSON.stringify(list, null, 2),
        );

        return jsonResult(
            {
                state: 'RUNNING',
                runId,
                phase: 'analyze',
                scenariosCollected: list.length,
                lastAppended: id,
                nextStepNeeded: true,
                nextSuggestedTool: 'csaa_append_analysis_scenario',
                recoveryHint: 'If the conversation was compacted, your scenarios so far live at analyze/scratch-scenarios.json under the run folder. Continue with the next legacy @Test method, or call csaa_finalize_analysis when done.',
            },
            `Scenario "${id}" appended (${list.length} staged).`,
        );
    })
    .build();

// ============================================================================
// csaa_finalize_analysis — close-out of streamed analysis recording
// ============================================================================

const csaa_finalize_analysis: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('csaa_finalize_analysis')
    .title('CS-AI-Auto-Assist — Finalize streamed analysis (Phase 3 completion)')
    .description(
        'Companion to csaa_append_analysis_scenario. Pass the non-scenario portion of ' +
            'the analysis ({ source, feature, pages, dependencyGraph, configFiles, loginContract, ' +
            'gaps, readinessScore }) — scenarios come from the scratch file built up by ' +
            'csaa_append_analysis_scenario. Internally dispatches into csaa_record_analysis ' +
            'so every gate (semantic + readiness + locator-source + reuse-existing + count match + ' +
            'fabricated-row + fuzzy-match) fires exactly as if you had submitted one big payload.',
    )
    .category('multiagent')
    .stringParam('runId', 'Run ID', { required: true })
    .objectParam(
        'payload',
        'REQUIRED. The non-scenario portion of the analysis: { source, feature, pages, dependencyGraph, configFiles, loginContract, gaps, readinessScore }. Do NOT include `scenarios` — they are loaded from the scratch file.',
        undefined,
        { required: true },
    )
    .handler(async (params: Record<string, unknown>, toolCtx: MCPToolContext) => {
        const runId = String(params.runId ?? '');
        const ctx = getCtx(runId);
        if (!ctx) return errorResult(`unknown runId '${runId}'`, runId);

        const meta = params.payload;
        if (typeof meta !== 'object' || meta === null) {
            return errorResult(`payload must be an object`, runId);
        }

        const scratchRaw = ctx.readPhaseArtifact('analyze', 'scratch-scenarios.json');
        if (!scratchRaw) {
            return errorResult(
                `No scenarios staged. Call csaa_append_analysis_scenario at least once before csaa_finalize_analysis, OR use csaa_record_analysis with a single full-payload call.`,
                runId,
            );
        }
        let scenarios: unknown[];
        try {
            scenarios = JSON.parse(scratchRaw);
        } catch {
            return errorResult(
                `Scratch scenario file is corrupt at analyze/scratch-scenarios.json. Delete it and re-append, or call csaa_record_analysis directly with a full payload.`,
                runId,
            );
        }
        if (!Array.isArray(scenarios) || scenarios.length === 0) {
            return errorResult(
                `Scratch scenario file is empty. Call csaa_append_analysis_scenario at least once first.`,
                runId,
            );
        }

        // If the caller redundantly passed scenarios, refuse — they would
        // shadow the scratch file and likely truncate the real list.
        if (Array.isArray((meta as { scenarios?: unknown[] }).scenarios)) {
            return errorResult(
                `csaa_finalize_analysis payload must NOT include 'scenarios' — they come from the scratch file. Remove the scenarios key and re-call. (Got ${(meta as { scenarios: unknown[] }).scenarios.length} scenarios in the payload alongside ${scenarios.length} in the scratch file.)`,
                runId,
            );
        }

        const fullPayload = { ...(meta as Record<string, unknown>), scenarios };

        // Re-dispatch through csaa_record_analysis so gate logic stays
        // single-sourced. On success it writes analysis-report.json and the
        // scratch file becomes obsolete — clean it up so a re-run doesn't
        // accidentally re-use it.
        const res = await csaa_record_analysis.handler(
            { runId, payload: fullPayload },
            toolCtx,
        );
        const sc = res.structuredContent as { state?: string } | undefined;
        if (sc?.state === 'RUNNING' || sc?.state === 'BLOCKED_NEED_HUMAN') {
            // Validation passed (RUNNING) or the analysis was persisted but
            // halted on readiness (BLOCKED). Either way the scratch file is
            // no longer needed for retries.
            try {
                const scratchPath = path.join(
                    ctx.runFolder,
                    CSRunContext.phaseFolder('analyze'),
                    'scratch-scenarios.json',
                );
                if (fs.existsSync(scratchPath)) fs.unlinkSync(scratchPath);
            } catch { /* non-fatal */ }
        }
        return res;
    })
    .build();

function renderAnalyzeMarkdown(
    analysis: Record<string, unknown> & {
        scenarios: unknown[];
        pages: unknown[];
        readinessScore?: number;
        gaps?: Array<{ severity: string; detail: string }>;
    },
    readinessScore: number,
): string {
    const lines: string[] = [];
    lines.push('# Analysis Report');
    lines.push('');
    lines.push(`**Readiness:** ${readinessScore.toFixed(2)}  ·  **Scenarios:** ${analysis.scenarios.length}  ·  **Pages:** ${analysis.pages.length}`);
    lines.push('');
    if (analysis.gaps && analysis.gaps.length > 0) {
        lines.push('## Gaps');
        for (const g of analysis.gaps) {
            lines.push(`- **[${g.severity.toUpperCase()}]** ${g.detail}`);
        }
    }
    return lines.join('\n');
}

// ============================================================================
// csaa_plan — Phase 4: render plan + gaps for human review
// ============================================================================

const csaa_plan: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('csaa_plan')
    .title('CS-AI-Auto-Assist — Plan (Phase 4)')
    .description(
        'Render the analysis report\'s output plan + auto-resolved gaps as a human-readable ' +
            'PLAN.md at the run root. Non-blocking — the pipeline proceeds. The user reads ' +
            'the plan asynchronously while phase 5 runs.',
    )
    .category('multiagent')
    .stringParam('runId', 'Run ID', { required: true })
    .handler(async (params: Record<string, unknown>) => {
        const runId = String(params.runId ?? '');
        const ctx = getCtx(runId);
        if (!ctx) return errorResult(`unknown runId '${runId}'`, runId);

        const reportRaw = ctx.readPhaseArtifact('analyze', 'analysis-report.json');
        if (!reportRaw) {
            return errorResult(`no analysis report — call csaa_analyze + csaa_record_analysis before csaa_plan`, runId);
        }
        const analysis = JSON.parse(reportRaw) as {
            source?: { relativePath?: string };
            feature?: { name?: string; slug?: string };
            scenarios: Array<{ id: string; title: string }>;
            pages: Array<{ className: string; role: string; existingFilePath?: string }>;
            loginContract?: { detected?: string; pattern?: string; gherkinStep?: string };
            gaps?: Array<{ severity: string; detail: string }>;
            readinessScore?: number;
        };

        ctx.startPhase('plan');
        const featureSlug = analysis.feature?.slug ?? 'feature';
        const lines: string[] = [];
        lines.push(`# Migration Plan — \`${runId}\``);
        lines.push('');
        lines.push(`**Feature:** \`${analysis.feature?.name ?? featureSlug}\`  `);
        lines.push(`**Source:** \`${analysis.source?.relativePath ?? '(unknown)'}\`  `);
        if (typeof analysis.readinessScore === 'number') {
            lines.push(`**Readiness:** ${analysis.readinessScore.toFixed(2)}`);
        }
        lines.push('');
        lines.push('## Scenarios');
        lines.push('');
        lines.push('| # | id | title |');
        lines.push('|---|---|---|');
        analysis.scenarios.forEach((s, i) => {
            lines.push(`| ${i + 1} | \`${s.id}\` | ${s.title} |`);
        });
        lines.push('');
        lines.push('## Pages');
        lines.push('');
        lines.push('| Role | Class | Existing file |');
        lines.push('|---|---|---|');
        for (const p of analysis.pages) {
            lines.push(`| ${p.role} | \`${p.className}\` | ${p.existingFilePath ? `\`${p.existingFilePath}\`` : '—'} |`);
        }
        lines.push('');
        if (analysis.loginContract && analysis.loginContract.detected !== 'no') {
            lines.push('## Login pattern');
            lines.push('');
            lines.push(`- **Detected:** ${analysis.loginContract.detected}`);
            lines.push(`- **Pattern:** ${analysis.loginContract.pattern ?? '(none)'}`);
            lines.push(`- **Step:** \`${analysis.loginContract.gherkinStep ?? '(none)'}\``);
            lines.push('');
        }
        if (analysis.gaps && analysis.gaps.length > 0) {
            lines.push('## Gaps');
            for (const g of analysis.gaps) {
                lines.push(`- **[${g.severity.toUpperCase()}]** ${g.detail}`);
            }
            lines.push('');
        }
        const planMd = lines.join('\n') + '\n';

        ctx.writePhaseArtifact('plan', 'plan.md', planMd);
        try {
            fs.writeFileSync(path.join(ctx.runFolder, 'PLAN.md'), planMd, 'utf-8');
        } catch { /* ignore */ }
        const reportPath = CSStatusWriter.writePhaseReport(
            ctx, 'plan', 'Migration Plan', planMd,
        );
        ctx.finishPhase('plan', 'done', { reportPath });
        CSStatusWriter.write(ctx);

        return jsonResult(
            {
                state: 'RUNNING',
                runId,
                phase: 'plan',
                scenarioCount: analysis.scenarios.length,
                pageCount: analysis.pages.length,
                runFolder: ctx.runFolder,
                planPath: path.join(ctx.runFolder, 'PLAN.md'),
                nextStepNeeded: true,
                nextSuggestedTool: 'csaa_translate',
                nextSuggestedArgs: { runId },
            },
            `Plan ready: ${analysis.scenarios.length} scenarios, ${analysis.pages.length} pages. PLAN.md at runFolder. Call csaa_translate next.`,
        );
    })
    .build();

// ============================================================================
// csaa_translate — Phase 5: delegate translation to the host LLM
// ============================================================================

const csaa_translate: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('csaa_translate')
    .title('CS-AI-Auto-Assist — Translate (Phase 5)')
    .description(
        'Returns a delegation envelope instructing the host LLM to produce a translation ' +
            '(feature + steps + page objects + data) from the recorded analysis. The LLM emits ' +
            'a TRANSLATION_SCHEMA-conforming JSON and calls csaa_record_translation, which runs ' +
            'content gates (placeholder detection, dup imports, wrong subpaths, empty bodies) ' +
            'before persisting. Garbage NEVER lands on disk.',
    )
    .category('multiagent')
    .stringParam('runId', 'Run ID', { required: true })
    .stringParam('project', 'Target project name', { required: true })
    .stringParam('module', 'Optional module name')
    .stringParam('frameworkPkg', 'Framework npm package (e.g. @your-scope/cs-playwright-test-framework). Defaults to whatever is in consumer package.json.')
    .handler(async (params: Record<string, unknown>) => {
        const runId = String(params.runId ?? '');
        const ctx = getCtx(runId);
        if (!ctx) return errorResult(`unknown runId '${runId}'`, runId);

        const analysisReportPath = path.join(
            ctx.runFolder,
            CSRunContext.phaseFolder('analyze'),
            'analysis-report.json',
        );
        if (!fs.existsSync(analysisReportPath)) {
            return errorResult(`no analysis report — call csaa_analyze + csaa_record_analysis first`, runId);
        }
        const project = getStr(params, 'project') ?? 'default';
        const module = getStr(params, 'module');
        const frameworkPkg =
            getStr(params, 'frameworkPkg') ?? '@mdakhan.mak/cs-playwright-test-framework';

        ctx.startPhase('translate');

        const envelope: DelegationEnvelope = {
            task: 'translate-analysis-to-bdd',
            instruction: [
                'You are translating a recorded analysis into CS Playwright BDD files. Half-effort output gets rejected by content gates — bake the skills in from the start.',
                '',
                'STEP 0 — READ the skill files first. For EVERY entry in `grounding.mandatorySkills`, use `read` on `<workspaceRoot>/.github/skills/<name>/SKILL.md`. These are the framework conventions the audit enforces. Examples block format, page-object pattern, step-def signature variants, data-driven shape — all documented there.',
                '',
                'STEP 1 — read the analysis. Use `read` on `grounding.analysisReportPath`.',
                '',
                'STEP 2 — produce ALL of the following artefacts. Emitting fewer kinds is rejected by the file-kind coverage gate (see csaa_record_translation). A partial translation (e.g. only steps.ts) is never accepted.',
                '  - REQUIRED: 1 .feature file → `test/<project>/features/<module>/<slug>.feature` covering EVERY scenario from analysis.scenarios[]',
                '  - REQUIRED: 1 .steps.ts file → `test/<project>/steps/<module>/<slug>.steps.ts` with a @CSBDDStepDef whose pattern EXACTLY matches every Given/When/Then text in the feature (no extra words, no rephrasing)',
                '  - REQUIRED: 1 data JSON file → `test/<project>/data/<module>/<slug>-scenarios.json` — include EVERY column from `analysis.scenarios[i].dataRow`, not just metadata',
                '  - REQUIRED: 1 page object .ts file under `test/<project>/pages/<module>/` for EVERY analysis page with role=create-new (one file per page, named after the page class)',
                '  - Pages with role=reuse-existing → DO NOT emit (the consumer already has them).',
                '',
                'STRICT FEATURE-FILE RULES (per ff-scenario-outline skill):',
                ' - Use `Scenario Outline:` ONLY when the body references at least one `<placeholder>` from Examples. If no placeholders, use plain `Scenario:`.',
                ' - If you use Scenario Outline, the `Examples:` block MUST be the JSON envelope:',
                '     Examples: {"type":"json","source":"test/<project>/data/<module>/<slug>-scenarios.json","path":"$","filter":"scenarioId=<id> AND runFlag=Yes"}',
                '   NOT a Gherkin table. Plain `| scenarioId |` tables are rejected.',
                ' - Step text in features must NEVER contain code references like `ClassName.methodName`. Translate `CTSSupportMethod.TS_4963` to a human-readable step like `Given I am signed in as <user>`.',
                '',
                'STRICT IMPORT CONVENTIONS (rejected if violated):',
                `  - Framework package is "${frameworkPkg}" — use this exact prefix.`,
                '  - CSBDDStepDef, StepDefinitions, Page, CSBDDContext, CSScenarioContext → /bdd',
                '  - CSReporter → /reporting',
                '  - CSBasePage, CSPage, CSGetElement, CSConfigurationManager → /core',
                '  - CSWebElement, CSElementFactory → /element',
                '  - CSValueResolver → /utilities',
                '  - CSDBUtils → /database-utils',
                '',
                'STRICT STEP-DEFINITION RULES (rejected if violated):',
                ' - EVERY @CSBDDStepDef body MUST do at least one element interaction — call a method on `this.somePage` (click, fill, verify, etc.) OR use CSDBUtils/CSConfigurationManager. Bodies that only call `CSReporter.pass(...)` are stub-step-body violations.',
                ' - Locators on @CSGetElement MUST come from `analysis.pages[].elements[].primaryLocator.value` (the legacy file value). Do not invent XPaths.',
                ' - Class properties decorated with @Page or @CSGetElement MUST use the `!` non-null assertion (e.g. `myPage!: MyPage;`) to satisfy strict TypeScript.',
                ' - Decorator `@StepDefinitions` is used WITHOUT parens. `@CSBDDStepDef(...)` takes parens.',
                ' - Step-def method signatures: `(message: string)` for {string}, `(value: number)` for {int}. NEVER use `(ctx, ...)` — there is no ctx parameter.',
                '',
                'STRICT PAGE-OBJECT RULES:',
                ' - Use `@CSGetElement({...})` and access elements as PROPERTIES (no parens): `this.myButton.click()` NOT `this.getMyButton().click()`.',
                ' - Do not invent chained APIs like `.getRowByCellValue(...)` or `.getButton(...)` on CSWebElement — they do not exist. Use the framework methods documented in the skill files only.',
                '',
                'STRICT CONTENT RULES:',
                ' - Every scenario MUST have ≥1 When + ≥1 Then (not just Given).',
                ' - NEVER emit "TODO", "not implemented", "placeholder", or "the operation should complete without errors".',
                ' - No duplicate `import { X }` lines.',
                ' - No duplicate `@Page("key")` decorators.',
                '',
                'STEP 3 — submit the translation. Two protocols, choose by file count:',
                '  (A) **≤2 files total** → call `csaa_record_translation(runId, payload: { files: [...], notes?: [...] })` ONCE with the full file list.',
                '  (B) **3+ files OR ≥4 analysis scenarios** → STREAM to avoid blowing LLM-host per-message output caps. Loop: for EACH generated file call `csaa_append_translation_file(runId, file: { relativePath, kind, content })` — one feature, one steps.ts, N pages (one per analysis page with role=create-new), one data.json. Each call is small (~1–5 KB). When every file is staged, call `csaa_finalize_translation(runId)` which re-dispatches through csaa_record_translation so EVERY gate fires identically (schema validation + content gates + file-kind coverage + scenario-data column coverage + page-coverage signature gate + compile_check). The scratch file survives conversation compaction — if the LLM-host summarises mid-flow, just continue appending or call finalize.',
                '',
                '**CRITICAL — do NOT narrate file contents in chat.** Emitting "Now writing page object..." / "Adding element locators..." / "Defining the page class..." in your reply burns output tokens. Compose tool calls SILENTLY. The user reads STATUS.md for progress, not your narration. Inlining feature/steps/page content as visible markdown is the #1 cause of "response hit the length limit" on this phase.',
                '',
                'The record tool runs schema validation, content gates (placeholder / dup imports / wrong subpath / empty body / step-def coverage / stub bodies / Scenario Outline misuse / Examples envelope shape / helper-class leak / duplicate scenario title / orphan step def / duplicate step-def bodies / generic-placeholder step text / Java identifier leak), the page-coverage signature gate (generated @CSGetElement count vs legacy @FindBy count ≥ 80%), the step-coverage signature gate (Gherkin steps per scenario vs legacy actions ≥ 70%), and `tsc --noEmit` against the consumer\'s tsconfig. If ANY gate fails you receive the specific violations — fix and re-call up to 3 times.',
            ].join('\n'),
            responseSchema: TRANSLATION_SCHEMA,
            grounding: {
                runId,
                project,
                module,
                frameworkPkg,
                analysisReportPath,
                skillsPath: '.github/skills/',
                mandatorySkills: [...MANDATORY_TRANSLATE_SKILLS],
            },
            recordWith: 'csaa_record_translation',
            recordArgs: { runId },
        };

        ctx.writePhaseArtifact(
            'translate',
            'delegation-envelope.json',
            JSON.stringify(envelope, null, 2),
        );
        CSStatusWriter.write(ctx);

        return jsonResult(
            {
                state: 'AWAITING_LLM_FULFILMENT',
                runId,
                phase: 'translate',
                delegation: envelope,
                runFolder: ctx.runFolder,
                nextStepNeeded: true,
                nextSuggestedTool: 'csaa_record_translation',
                nextSuggestedArgs: { runId },
            },
            `Translate delegation ready. Produce file map matching TRANSLATION_SCHEMA, then call csaa_record_translation(runId, payload).`,
        );
    })
    .build();

// ============================================================================
// csaa_record_translation — Phase 5 fulfilment partner
// ============================================================================

const csaa_record_translation: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('csaa_record_translation')
    .title('CS-AI-Auto-Assist — Record Translation (Phase 5 fulfilment)')
    .description(
        'Companion to csaa_translate. Accepts LLM-produced translation JSON, validates schema, ' +
            'runs content gates (placeholder detection, dup imports, wrong subpaths, empty bodies, ' +
            'step-def coverage), persists ONLY if all gates pass. Returns violations on failure ' +
            'so the agent can fix-and-retry.',
    )
    .category('multiagent')
    .stringParam('runId', 'Run ID', { required: true })
    .stringParam('workspaceRoot', 'Consumer project root for compile_check; if omitted, compile gate is skipped')
    .objectParam(
        'payload',
        'REQUIRED. The LLM-produced translation JSON object matching TRANSLATION_SCHEMA. Pass as `payload: { files: [{ relativePath, kind, content, reuseDecision? }, ...], notes?: [...] }`. Each `files[]` entry is one generated artefact (.feature / .ts page / .ts steps / .json data). The content gates (placeholder detection, dup imports, wrong subpaths, empty bodies, step-def coverage, stub bodies, Scenario Outline misuse, Examples envelope shape) run on this payload before persistence.',
        undefined,
        { required: true },
    )
    .handler(async (params: Record<string, unknown>, _toolCtx: MCPToolContext) => {
        const runId = String(params.runId ?? '');
        const ctx = getCtx(runId);
        if (!ctx) return errorResult(`unknown runId '${runId}'`, runId);

        const payload = params.payload;
        if (typeof payload !== 'object' || payload === null) {
            return errorResult(`payload must be an object`, runId);
        }

        // Gate 1: schema validation
        const schemaErrors = CSSchemaValidator.validate(payload, TRANSLATION_SCHEMA);
        if (schemaErrors.length > 0) {
            const summary = schemaErrors.slice(0, 10).map((e) => `${e.path}: ${e.message}`).join('\n');
            ctx.writePhaseArtifact(
                'translate',
                'validation-errors.json',
                JSON.stringify(schemaErrors, null, 2),
            );
            return jsonResult(
                {
                    state: 'AWAITING_LLM_RETRY',
                    runId,
                    phase: 'translate',
                    schemaErrors,
                    nextStepNeeded: true,
                    nextSuggestedTool: 'csaa_record_translation',
                    feedback: `Translation payload failed schema validation. Fix and re-call.\n\n${summary}`,
                },
                `Schema validation failed (${schemaErrors.length} errors). Retry.`,
            );
        }

        const translation = payload as {
            files: Array<{
                relativePath: string;
                kind: 'feature' | 'page' | 'steps' | 'data';
                content: string;
                reuseDecision?: string;
            }>;
            notes?: string[];
        };

        // Gate 2: content quality
        const contentViolations = CSContentValidator.validateAll(
            translation.files.map((f) => ({
                relativePath: f.relativePath,
                kind: f.kind,
                content: f.content,
            })),
        );
        const errors = contentViolations.filter((v) => v.severity === 'error');
        if (errors.length > 0) {
            ctx.writePhaseArtifact(
                'translate',
                'content-violations.json',
                JSON.stringify(contentViolations, null, 2),
            );
            const grouped: Record<string, ContentViolation[]> = {};
            for (const v of contentViolations) {
                if (!grouped[v.relativePath]) grouped[v.relativePath] = [];
                grouped[v.relativePath].push(v);
            }
            const summaryLines: string[] = [];
            for (const [rel, list] of Object.entries(grouped)) {
                summaryLines.push(`\n${rel}:`);
                for (const v of list) {
                    summaryLines.push(`  [${v.severity}] ${v.ruleId}${v.line ? ` (line ${v.line})` : ''}: ${v.message}`);
                }
            }
            return jsonResult(
                {
                    state: 'AWAITING_LLM_RETRY',
                    runId,
                    phase: 'translate',
                    contentViolations,
                    errorCount: errors.length,
                    nextStepNeeded: true,
                    nextSuggestedTool: 'csaa_record_translation',
                    feedback: `Content gates rejected the translation. Fix each violation and re-call csaa_record_translation:${summaryLines.join('\n')}`,
                },
                `Content gates failed: ${errors.length} error(s) across ${Object.keys(grouped).length} file(s). Retry.`,
            );
        }

        // Gate 2.5: file-kind coverage. A real migration must emit at
        // minimum 1 feature + 1 steps + 1 data file when the analysis
        // recorded any scenarios, plus one page-object file per page
        // entry with role=create-new. Otherwise the LLM can submit only
        // a steps file and pass — exactly what happened in production
        // before this gate existed.
        const analysisForKinds = ctx.readPhaseArtifact('analyze', 'analysis-report.json');
        if (analysisForKinds) {
            try {
                const a = JSON.parse(analysisForKinds) as {
                    scenarios?: unknown[];
                    pages?: Array<{ className: string; role?: string }>;
                };
                const scenarios = Array.isArray(a.scenarios) ? a.scenarios.length : 0;
                const newPages = (a.pages ?? []).filter((p) => p.role === 'create-new').map((p) => p.className);
                if (scenarios > 0) {
                    const kinds = {
                        feature: translation.files.filter((f) => f.kind === 'feature').length,
                        steps: translation.files.filter((f) => f.kind === 'steps').length,
                        data: translation.files.filter((f) => f.kind === 'data').length,
                        page: translation.files.filter((f) => f.kind === 'page').length,
                    };
                    const missing: string[] = [];
                    if (kinds.feature === 0) missing.push('feature');
                    if (kinds.steps === 0) missing.push('steps');
                    if (kinds.data === 0) missing.push('data');
                    if (newPages.length > kinds.page) {
                        missing.push(`page (${newPages.length} create-new pages declared in analysis, ${kinds.page} emitted)`);
                    }
                    if (missing.length > 0) {
                        return jsonResult(
                            {
                                state: 'AWAITING_LLM_RETRY',
                                runId,
                                phase: 'translate',
                                missingKinds: missing,
                                expectedKinds: { feature: 1, steps: 1, data: 1, page: newPages.length },
                                actualKinds: kinds,
                                nextStepNeeded: true,
                                nextSuggestedTool: 'csaa_record_translation',
                                feedback: `Translation is incomplete. Analysis recorded ${scenarios} scenario(s) and ${newPages.length} new page(s), but translation is missing: ${missing.join(', ')}. Every migration MUST emit at minimum:\n  - 1 .feature file under test/<project>/features/<module>/\n  - 1 .steps.ts file under test/<project>/steps/<module>/\n  - 1 scenarios JSON file under test/<project>/data/<module>/\n  - One page-object .ts file per analysis page with role='create-new': ${newPages.join(', ') || '(none)'}\n\nRe-emit the full file set and re-call csaa_record_translation.`,
                            },
                            `File-kind coverage failed: missing ${missing.join(', ')}. Retry.`,
                        );
                    }
                }
            } catch { /* malformed analysis — schema gate caught upstream */ }
        }

        // Gate 2.6: anti-collapse — one Scenario Outline cannot represent N
        // analysis scenarios that have DIFFERENT leaf actions. The LLM tends
        // to wrap N legacy tests in a single Outline with placeholder steps
        // ("I perform the steps for <scenarioId>") to avoid writing real
        // scenarios. Detect: feature contains exactly one Scenario Outline
        // AND analysis recorded ≥2 scenarios AND their step lists differ.
        const analysisForCollapse = ctx.readPhaseArtifact('analyze', 'analysis-report.json');
        if (analysisForCollapse) {
            try {
                const a = JSON.parse(analysisForCollapse) as {
                    scenarios?: Array<{ id: string; steps?: Array<{ keyword?: string; text?: string }> }>;
                };
                const featureFile = translation.files.find((f) => f.kind === 'feature');
                if (featureFile && Array.isArray(a.scenarios) && a.scenarios.length >= 2) {
                    const featureText = featureFile.content;
                    const scenarioCount = (featureText.match(/^\s*Scenario\s*:/gm) ?? []).length;
                    const outlineCount = (featureText.match(/^\s*Scenario\s+Outline\s*:/gm) ?? []).length;
                    if (outlineCount >= 1 && scenarioCount === 0 && a.scenarios.length >= 2) {
                        // Build step-fingerprint per analysis scenario.
                        const fingerprints = new Set<string>();
                        for (const s of a.scenarios) {
                            const fp = (s.steps ?? [])
                                .map((st) => `${(st.keyword ?? '').trim()}|${(st.text ?? '').trim().toLowerCase()}`)
                                .join('||');
                            fingerprints.add(fp);
                        }
                        if (fingerprints.size >= 2) {
                            return jsonResult(
                                {
                                    state: 'AWAITING_LLM_RETRY',
                                    runId,
                                    phase: 'translate',
                                    nextStepNeeded: true,
                                    nextSuggestedTool: 'csaa_record_translation',
                                    feedback: `Anti-collapse gate failed. Your feature file has ${outlineCount} Scenario Outline(s) and 0 plain Scenarios, but the analysis recorded ${a.scenarios.length} distinct scenarios with ${fingerprints.size} different step lists. A Scenario Outline can only parameterize scenarios that share the SAME action sequence (e.g. same clicks, same assertions, varying only by data row values). Your analysis scenarios have different leaf actions — one performs "click Search", another "click New User", another "verify error message", etc. — so they cannot collapse into a single Outline. Emit one plain "Scenario:" block per analysis scenario, each with the actual step text from analysis.scenarios[].steps. If a true subset DOES share identical steps, you may use an Outline for that subset only, but not for all ${a.scenarios.length}.`,
                                },
                                `Anti-collapse failed: 1 Outline cannot represent ${a.scenarios.length} scenarios with ${fingerprints.size} different step lists. Retry.`,
                            );
                        }
                    }
                }
            } catch { /* malformed analysis — schema gate caught upstream */ }
        }

        // Gate 2.8: generated page-object field-count vs legacy signature.
        //            Counts @CSGetElement decorators in each generated page
        //            file and compares to the legacy floor (80%). Catches
        //            "thin page object" — the 4-field page when legacy has
        //            27 — that passes every form-level gate today.
        const sigForTranslate = ctx.readPhaseArtifact('discover', 'signature.json');
        if (sigForTranslate) {
            try {
                const sig = JSON.parse(sigForTranslate) as FullSignature;
                const pageFiles = translation.files.filter((f) => f.kind === 'page');
                const pageShortfall: Array<{
                    file: string;
                    pageClass: string;
                    legacyFields: number;
                    generatedFields: number;
                    coverage: number;
                }> = [];
                for (const pf of pageFiles) {
                    const fileName = path.basename(pf.relativePath, path.extname(pf.relativePath));
                    // Match against legacy page class names (case-insensitive,
                    // suffix-tolerant).
                    const normalised = (s: string) => s.toLowerCase().replace(/page$/i, '');
                    const target = normalised(fileName);
                    const sigPage = Object.values(sig.pages).find(
                        (sp) => normalised(sp.className) === target,
                    );
                    if (!sigPage || sigPage.fields.length < 5) continue;
                    const decorators = (pf.content.match(/@CSGetElement\s*\(/g) ?? []).length;
                    const coverage = decorators / sigPage.fields.length;
                    if (coverage < 0.80) {
                        pageShortfall.push({
                            file: pf.relativePath,
                            pageClass: sigPage.className,
                            legacyFields: sigPage.fields.length,
                            generatedFields: decorators,
                            coverage,
                        });
                    }
                }
                if (pageShortfall.length > 0) {
                    const list = pageShortfall.slice(0, 6).map(
                        (p) => `  - ${p.file} (matches legacy "${p.pageClass}"): ${p.generatedFields}/${p.legacyFields} @CSGetElement decorators (${Math.round(p.coverage * 100)}% — floor 80%)`,
                    ).join('\n');
                    return jsonResult(
                        {
                            state: 'AWAITING_LLM_RETRY',
                            runId,
                            phase: 'translate',
                            pageShortfall,
                            nextStepNeeded: true,
                            nextSuggestedTool: 'csaa_record_translation',
                            feedback: `Page-coverage gate failed. Generated page object(s) have FAR fewer @CSGetElement decorators than the legacy class has @FindBy fields:\n${list}\n\nFor EACH shortfall page, call csaa_extract_page_fields(runId, pageClass) to retrieve the authoritative field list, then emit a matching @CSGetElement for every one (XPath primary, alternativeLocators[] for CSS fallbacks). The legacy field count is the floor — you may add more, never fewer.`,
                        },
                        `Page-coverage gate: ${pageShortfall.length} page(s) below 80% legacy field count. Retry.`,
                    );
                }

                // Also gate per-scenario step coverage at translate time —
                // catches the case where analysis was sufficient but the
                // translator dropped steps when emitting the feature file.
                const featureFile = translation.files.find((f) => f.kind === 'feature');
                if (featureFile) {
                    // Count Gherkin steps per scenario tag.
                    const stepsPerScenario = new Map<string, number>();
                    let currentTag: string | null = null;
                    let currentSteps = 0;
                    for (const ln of featureFile.content.split(/\r?\n/)) {
                        const t = ln.trim();
                        const tagMatch = t.match(/^@(TS_\d+|tc_\d+|case[-_]?\w+)/i);
                        if (tagMatch) {
                            currentTag = tagMatch[1];
                            continue;
                        }
                        if (/^Scenario(\s+Outline)?\s*:/i.test(t)) {
                            if (currentTag) {
                                stepsPerScenario.set(currentTag, currentSteps);
                            }
                            currentSteps = 0;
                            continue;
                        }
                        if (/^(Given|When|Then|And|But)\b/i.test(t)) {
                            currentSteps++;
                        }
                    }
                    if (currentTag) stepsPerScenario.set(currentTag, currentSteps);

                    const scenarioShortfall: Array<{
                        scenarioTag: string;
                        legacyMethod: string;
                        legacyActions: number;
                        gherkinSteps: number;
                    }> = [];
                    for (const t of sig.tests) {
                        const tag = t.testCaseId ? `TS_${t.testCaseId}` : null;
                        if (!tag) continue;
                        const expected = CSLegacySignatureExtractor.expectedActionCount(t, sig.helpers);
                        if (expected < 3) continue;
                        const gherkin = stepsPerScenario.get(tag) ??
                                       stepsPerScenario.get(t.testCaseId ?? '') ?? 0;
                        if (gherkin > 0 && gherkin / expected < 0.70) {
                            scenarioShortfall.push({
                                scenarioTag: tag,
                                legacyMethod: t.methodName,
                                legacyActions: expected,
                                gherkinSteps: gherkin,
                            });
                        }
                    }
                    if (scenarioShortfall.length > 0) {
                        const list = scenarioShortfall.slice(0, 6).map(
                            (s) => `  - @${s.scenarioTag} (legacy ${s.legacyMethod}): ${s.gherkinSteps} Gherkin steps vs ${s.legacyActions} legacy actions (${Math.round(100 * s.gherkinSteps / s.legacyActions)}% — floor 70%)`,
                        ).join('\n');
                        return jsonResult(
                            {
                                state: 'AWAITING_LLM_RETRY',
                                runId,
                                phase: 'translate',
                                scenarioShortfall,
                                nextStepNeeded: true,
                                nextSuggestedTool: 'csaa_record_translation',
                                feedback: `Step-coverage gate failed at translate. Scenarios in the feature file have far fewer Gherkin steps than the legacy @Test has leaf actions (after helper expansion):\n${list}\n\nThe feature file dropped legacy actions during translation. Re-emit the feature file with one step per legacy leaf action — expand every helper invocation via csaa_expand_helper, then include each returned action as its own step.`,
                            },
                            `Step-coverage gate: ${scenarioShortfall.length} scenario(s) below 70% legacy action coverage. Retry.`,
                        );
                    }
                }
            } catch { /* malformed signature — gate skips */ }
        }

        // Gate 3: scenarios.json column coverage.
        // The recorded analysis has scenarios[].dataRow with real columns from
        // the legacy data file. The translation's *_scenarios.json must
        // include those columns — not just {scenarioId, scenarioName, runFlag}.
        const analysisRaw = ctx.readPhaseArtifact('analyze', 'analysis-report.json');
        if (analysisRaw) {
            try {
                const analysis = JSON.parse(analysisRaw) as {
                    scenarios?: Array<{ id: string; dataRow?: Record<string, unknown> }>;
                };
                const dataFile = translation.files.find((f) => f.kind === 'data');
                if (dataFile && analysis.scenarios && analysis.scenarios.length > 0) {
                    let rows: Array<Record<string, unknown>>;
                    try {
                        rows = JSON.parse(dataFile.content);
                    } catch {
                        rows = [];
                    }
                    const missing: string[] = [];
                    for (const aScn of analysis.scenarios) {
                        const expected = Object.keys(aScn.dataRow ?? {}).filter(
                            (k) => !['scenarioId', 'scenarioName', 'runFlag'].includes(k),
                        );
                        if (expected.length === 0) continue;
                        const row = rows.find(
                            (r) => String(r.scenarioId ?? '') === String(aScn.id),
                        );
                        if (!row) {
                            missing.push(`scenarioId="${aScn.id}" row not found in data JSON`);
                            continue;
                        }
                        for (const col of expected) {
                            if (!(col in row)) {
                                missing.push(`scenarioId="${aScn.id}" missing column "${col}" (was in analysis dataRow)`);
                            }
                        }
                    }
                    if (missing.length > 0) {
                        return jsonResult(
                            {
                                state: 'AWAITING_LLM_RETRY',
                                runId,
                                phase: 'translate',
                                dataColumnMisses: missing,
                                nextStepNeeded: true,
                                nextSuggestedTool: 'csaa_record_translation',
                                feedback: `scenarios.json is missing legacy data columns. The analysis recorded real test data per scenario — your JSON must include those columns, not just metadata:\n${missing.slice(0, 10).map((m) => `  - ${m}`).join('\n')}${missing.length > 10 ? `\n  ...and ${missing.length - 10} more` : ''}\n\nRe-emit the data file with every column from analysis.scenarios[].dataRow.`,
                            },
                            `scenarios.json column gate: ${missing.length} miss(es). Retry.`,
                        );
                    }
                }
            } catch { /* malformed analysis JSON — schema gate would have caught upstream */ }
        }

        // Gate 4: compile_check via tsc --noEmit. Workspace can be passed
        // explicitly via the `workspaceRoot` param, or auto-derived from the
        // entry file path persisted in intake/run-params.json (walk up to the
        // nearest dir with package.json + node_modules). This makes the
        // compile gate default-on for real runs while smoke tests still
        // skip cleanly when there's no consumer setup to point at.
        let workspaceRoot = getStr(params, 'workspaceRoot');
        if (!workspaceRoot) {
            const rp = ctx.readPhaseArtifact('intake', 'run-params.json');
            if (rp) {
                try {
                    const parsed = JSON.parse(rp) as { entryFile?: string };
                    if (parsed.entryFile) {
                        let dir = path.dirname(parsed.entryFile);
                        for (let i = 0; i < 8; i++) {
                            if (fs.existsSync(path.join(dir, 'tsconfig.json')) &&
                                fs.existsSync(path.join(dir, 'node_modules'))) {
                                workspaceRoot = dir;
                                break;
                            }
                            const parent = path.dirname(dir);
                            if (parent === dir) break;
                            dir = parent;
                        }
                    }
                } catch { /* ignore */ }
            }
        }
        const sandboxRoot = path.join(ctx.runFolder, CSRunContext.phaseFolder('translate'), 'sandbox');
        if (workspaceRoot && fs.existsSync(path.join(workspaceRoot, 'tsconfig.json')) &&
            fs.existsSync(path.join(workspaceRoot, 'node_modules'))) try {
            // Clean sandbox + write all generated files.
            if (fs.existsSync(sandboxRoot)) fs.rmSync(sandboxRoot, { recursive: true, force: true });
            fs.mkdirSync(sandboxRoot, { recursive: true });
            const consumerRoot = workspaceRoot;
            // Copy tsconfig.json from consumer if it exists; else minimal one.
            const consumerTsconfig = path.join(consumerRoot, 'tsconfig.json');
            const sandboxTsconfig = path.join(sandboxRoot, 'tsconfig.json');
            if (fs.existsSync(consumerTsconfig)) {
                const cfg = JSON.parse(fs.readFileSync(consumerTsconfig, 'utf-8'));
                cfg.include = translation.files.filter((f) => f.relativePath.endsWith('.ts')).map((f) => f.relativePath);
                cfg.compilerOptions = cfg.compilerOptions ?? {};
                cfg.compilerOptions.baseUrl = consumerRoot;
                cfg.compilerOptions.paths = cfg.compilerOptions.paths ?? {};
                cfg.compilerOptions.noEmit = true;
                fs.writeFileSync(sandboxTsconfig, JSON.stringify(cfg, null, 2));
            }
            for (const f of translation.files) {
                if (!f.relativePath.endsWith('.ts')) continue;
                const dest = path.join(sandboxRoot, f.relativePath);
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                fs.writeFileSync(dest, f.content);
            }
            const compileCheck = (auditTools as MCPToolDefinition[]).find((t) => t.tool.name === 'compile_check');
            if (compileCheck && fs.existsSync(sandboxTsconfig)) {
                const res = await compileCheck.handler({ cwd: sandboxRoot }, _toolCtx);
                const sc = res.structuredContent as { clean?: boolean; errors?: Array<{ file: string; line: number; code: string; message: string }> } | undefined;
                if (sc && sc.clean === false && Array.isArray(sc.errors) && sc.errors.length > 0) {
                    ctx.writePhaseArtifact(
                        'translate',
                        'compile-errors.json',
                        JSON.stringify(sc.errors, null, 2),
                    );
                    const summary = sc.errors.slice(0, 12)
                        .map((e) => `  ${e.file}:${e.line} ${e.code}: ${e.message}`)
                        .join('\n');
                    return jsonResult(
                        {
                            state: 'AWAITING_LLM_RETRY',
                            runId,
                            phase: 'translate',
                            compileErrors: sc.errors,
                            nextStepNeeded: true,
                            nextSuggestedTool: 'csaa_record_translation',
                            feedback: `compile_check (tsc --noEmit) reported ${sc.errors.length} error(s) against the consumer's tsconfig. Fix and re-call csaa_record_translation:\n${summary}${sc.errors.length > 12 ? `\n  ...and ${sc.errors.length - 12} more` : ''}`,
                        },
                        `compile_check failed: ${sc.errors.length} TS error(s). Retry.`,
                    );
                }
            }
        } catch (err) {
            // sandbox setup error — non-blocking warning only
            ctx.writePhaseArtifact(
                'translate',
                'compile-check-error.txt',
                err instanceof Error ? (err.stack ?? err.message) : String(err),
            );
        }

        // All gates green — persist content map + per-file artefacts.
        const files: Record<string, string> = {};
        const confidence: Record<string, number> = {};
        for (const f of translation.files) {
            files[f.relativePath] = f.content;
            confidence[f.relativePath] = 1.0; // schema-validated + gate-passed
        }
        ctx.writePhaseArtifact(
            'translate',
            'content-map.json',
            JSON.stringify({ files, confidence, notes: translation.notes ?? [] }, null, 2),
        );
        for (const f of translation.files) {
            const safeName = f.relativePath.replace(/[/\\]/g, '__');
            ctx.writePhaseArtifact('translate', path.join('files', safeName), f.content);
        }
        const md = renderTranslateMarkdown(translation);
        const reportPath = CSStatusWriter.writePhaseReport(
            ctx, 'translate', 'Translator Output', md,
        );
        ctx.finishPhase('translate', 'done', { reportPath });
        CSStatusWriter.write(ctx);

        return jsonResult(
            {
                state: 'RUNNING',
                runId,
                phase: 'translate',
                fileCount: translation.files.length,
                allGatesPassed: true,
                runFolder: ctx.runFolder,
                reportPath,
                nextStepNeeded: true,
                nextSuggestedTool: 'csaa_audit',
                nextSuggestedArgs: { runId },
            },
            `Translation recorded: ${translation.files.length} file(s), all gates passed. Call csaa_audit next.`,
        );
    })
    .build();

function renderTranslateMarkdown(translation: {
    files: Array<{ relativePath: string; kind: string }>;
    notes?: string[];
}): string {
    const lines: string[] = [];
    lines.push('# Translator Output');
    lines.push('');
    lines.push(`Files: ${translation.files.length}`);
    lines.push('');
    lines.push('| Kind | File |');
    lines.push('|---|---|');
    for (const f of translation.files) {
        lines.push(`| ${f.kind} | \`${f.relativePath}\` |`);
    }
    if (translation.notes && translation.notes.length > 0) {
        lines.push('');
        lines.push('## Notes');
        for (const n of translation.notes) lines.push(`- ${n}`);
    }
    lines.push('');
    return lines.join('\n');
}

// ============================================================================
// csaa_append_translation_file — chunked translate recording (one file at a time)
// ============================================================================
// Symmetric to csaa_append_analysis_scenario. Large migrations (3+ page
// objects + feature + steps + data = 5+ files, often 30-50 KB total) blow
// the LLM-host per-message output cap when submitted as a single
// csaa_record_translation payload. This tool accepts ONE TranslationFile
// per call (~1-5 KB each), stages it to `05-translate/scratch-files.json`,
// and lets the LLM stream the full translation in N small turns. After
// every file is appended, csaa_finalize_translation re-dispatches through
// csaa_record_translation so every existing gate (placeholder, dup imports,
// wrong subpath, page-coverage signature, compile_check) still fires.
//
// The scratch file survives conversation compaction.

const csaa_append_translation_file: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('csaa_append_translation_file')
    .title('CS-AI-Auto-Assist — Append one translation file (chunked)')
    .description(
        'Streams ONE generated file (feature / steps / page / data) into the translate scratch. ' +
            'Use this whenever the full translation payload would exceed the LLM-host per-message ' +
            'output cap (3+ files OR ≥4 scenarios is a safe threshold). Each call carries one ' +
            '{ relativePath, kind, content } object — small enough to never blow the message budget. ' +
            'When every file has been appended, call csaa_finalize_translation to run gates and ' +
            'persist the content map. The scratch file survives conversation compaction.',
    )
    .category('multiagent')
    .stringParam('runId', 'Run ID', { required: true })
    .objectParam(
        'file',
        'REQUIRED. One translation file object: { relativePath, kind, content }. relativePath relative to consumer workspace (e.g. test/<project>/features/<module>/x.feature). kind is one of: "feature" | "steps" | "page" | "data". content is the full file body. Optional: reuseDecision for reuse-existing pages.',
        undefined,
        { required: true },
    )
    .handler(async (params: Record<string, unknown>) => {
        const runId = String(params.runId ?? '');
        const ctx = getCtx(runId);
        if (!ctx) return errorResult(`unknown runId '${runId}'`, runId);

        const file = params.file;
        if (typeof file !== 'object' || file === null) {
            return errorResult('file must be an object', runId);
        }
        const f = file as { relativePath?: unknown; kind?: unknown; content?: unknown };
        if (typeof f.relativePath !== 'string' || !f.relativePath) {
            return errorResult('file.relativePath required (string)', runId);
        }
        if (typeof f.kind !== 'string' || !['feature', 'steps', 'page', 'data'].includes(f.kind)) {
            return errorResult(`file.kind required, one of: feature | steps | page | data (got '${String(f.kind)}')`, runId);
        }
        if (typeof f.content !== 'string') {
            return errorResult('file.content required (string)', runId);
        }
        if (f.content.length > 256 * 1024) {
            return errorResult(`file.content is ${f.content.length} bytes — exceeds 256 KB per-file limit. Split the file or escalate as a gap.`, runId);
        }

        const scratchRaw = ctx.readPhaseArtifact('translate', 'scratch-files.json');
        const list: Array<{ relativePath: string; kind: string; content: string; reuseDecision?: string }> =
            scratchRaw ? JSON.parse(scratchRaw) : [];

        // Reject duplicate paths — would shadow the prior file silently.
        if (list.some((x) => x.relativePath === f.relativePath)) {
            return jsonResult(
                {
                    state: 'AWAITING_LLM_RETRY',
                    runId,
                    phase: 'translate',
                    nextStepNeeded: true,
                    nextSuggestedTool: 'csaa_append_translation_file',
                    feedback: `File "${f.relativePath}" was already appended in this run. To replace it, call csaa_finalize_translation first (so the scratch is consumed), then re-start translate. Or proceed to finalize if every file is staged.`,
                },
                `Duplicate file path "${f.relativePath}".`,
            );
        }

        list.push({
            relativePath: f.relativePath,
            kind: f.kind as 'feature' | 'steps' | 'page' | 'data',
            content: f.content,
            ...(typeof (f as { reuseDecision?: unknown }).reuseDecision === 'string' ?
                { reuseDecision: (f as { reuseDecision: string }).reuseDecision } : {}),
        });
        ctx.writePhaseArtifact(
            'translate',
            'scratch-files.json',
            JSON.stringify(list, null, 2),
        );

        const kindCounts = list.reduce<Record<string, number>>((acc, x) => {
            acc[x.kind] = (acc[x.kind] ?? 0) + 1;
            return acc;
        }, {});
        return jsonResult(
            {
                state: 'RUNNING',
                runId,
                phase: 'translate',
                filesCollected: list.length,
                kindCounts,
                lastAppended: f.relativePath,
                nextStepNeeded: true,
                nextSuggestedTool: 'csaa_append_translation_file',
                recoveryHint: 'If the conversation was compacted, your staged files live at translate/scratch-files.json under the run folder. Continue appending the remaining files (one feature + one steps + N pages + one data), then call csaa_finalize_translation.',
            },
            `File "${f.relativePath}" appended (${list.length} staged: ${Object.entries(kindCounts).map(([k, v]) => `${k}=${v}`).join(', ')}).`,
        );
    })
    .build();

// ============================================================================
// csaa_finalize_translation — close-out of streamed translation recording
// ============================================================================

const csaa_finalize_translation: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('csaa_finalize_translation')
    .title('CS-AI-Auto-Assist — Finalize streamed translation (Phase 5 completion)')
    .description(
        'Companion to csaa_append_translation_file. Reads every staged file from the scratch ' +
            'and re-dispatches into csaa_record_translation so the full gate pipeline runs ' +
            '(schema validation + content gates + file-kind coverage + anti-collapse + ' +
            'data column coverage + page-coverage signature gate + compile_check). ' +
            'Optional `notes[]` carries free-form translator notes.',
    )
    .category('multiagent')
    .stringParam('runId', 'Run ID', { required: true })
    .objectParam(
        'notes',
        'Optional translator notes array, e.g. { items: ["note 1", "note 2"] }. Pass undefined to omit.',
        undefined,
    )
    .handler(async (params: Record<string, unknown>, toolCtx: MCPToolContext) => {
        const runId = String(params.runId ?? '');
        const ctx = getCtx(runId);
        if (!ctx) return errorResult(`unknown runId '${runId}'`, runId);

        const scratchRaw = ctx.readPhaseArtifact('translate', 'scratch-files.json');
        if (!scratchRaw) {
            return errorResult(
                `No files staged. Call csaa_append_translation_file at least once before csaa_finalize_translation, OR use csaa_record_translation with a single full-payload call.`,
                runId,
            );
        }
        let files: Array<{ relativePath: string; kind: string; content: string; reuseDecision?: string }>;
        try {
            files = JSON.parse(scratchRaw);
        } catch {
            return errorResult(
                `Scratch translation file is corrupt at translate/scratch-files.json. Delete it and re-append, or call csaa_record_translation directly.`,
                runId,
            );
        }
        if (!Array.isArray(files) || files.length === 0) {
            return errorResult(
                `Scratch translation file is empty. Call csaa_append_translation_file at least once first.`,
                runId,
            );
        }

        const notesParam = params.notes;
        const notesList: string[] = [];
        if (notesParam && typeof notesParam === 'object') {
            const items = (notesParam as { items?: unknown }).items;
            if (Array.isArray(items)) {
                for (const it of items) if (typeof it === 'string') notesList.push(it);
            }
        }

        const fullPayload = {
            files,
            ...(notesList.length > 0 ? { notes: notesList } : {}),
        };

        // Re-dispatch through csaa_record_translation. Single source of truth
        // for every gate.
        const res = await csaa_record_translation.handler(
            { runId, payload: fullPayload },
            toolCtx,
        );

        // Clean the scratch on success so a follow-up append doesn't re-use it.
        const sc = res.structuredContent as { state?: string } | undefined;
        if (sc?.state === 'RUNNING') {
            try {
                const scratchPath = path.join(
                    ctx.runFolder,
                    CSRunContext.phaseFolder('translate'),
                    'scratch-files.json',
                );
                if (fs.existsSync(scratchPath)) fs.unlinkSync(scratchPath);
            } catch { /* non-fatal */ }
        }
        return res;
    })
    .build();

// ============================================================================
// csaa_audit — Phase 6: audit_file across content map
// ============================================================================

const csaa_audit: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('csaa_audit')
    .title('CS-AI-Auto-Assist — Audit (Phase 6)')
    .description(
        'Run audit_file across every translated file. Aggregates violations grouped by file, ' +
            'persists `violations.json`. Non-blocking by default — pipeline advances and the ' +
            'verifier reflects audit issues in the trust score.',
    )
    .category('multiagent')
    .stringParam('runId', 'Run ID', { required: true })
    .handler(async (params: Record<string, unknown>, _toolCtx: MCPToolContext) => {
        const runId = String(params.runId ?? '');
        const ctx = getCtx(runId);
        if (!ctx) return errorResult(`unknown runId '${runId}'`, runId);

        const cmRaw = ctx.readPhaseArtifact('translate', 'content-map.json');
        if (!cmRaw) {
            return errorResult(`no content map — call csaa_translate first`, runId);
        }
        const contentMap = JSON.parse(cmRaw) as {
            files: Record<string, string>;
            confidence: Record<string, number>;
            notes: string[];
        };

        ctx.startPhase('audit');
        const auditFile = (auditTools as MCPToolDefinition[]).find((t) => t.tool.name === 'audit_content');
        const allViolations: Record<string, AuditViolation[]> = {};
        let totalViolations = 0;

        // Pass 1: existing framework-rule audit (audit_content tool)
        if (auditFile) {
            for (const [rel, content] of Object.entries(contentMap.files)) {
                try {
                    const res = await auditFile.handler(
                        { content, filename: rel },
                        _toolCtx,
                    );
                    const sc = res.structuredContent as
                        | { violations?: Array<{ ruleId?: string; severity?: string; line?: number; message?: string }> }
                        | undefined;
                    const list = sc?.violations ?? [];
                    if (list.length > 0) {
                        allViolations[rel] = list.map((v) => ({
                            ruleId: v.ruleId ?? 'unknown',
                            severity: (v.severity ?? 'warning') as AuditViolation['severity'],
                            line: v.line,
                            message: v.message ?? '',
                        }));
                        totalViolations += list.length;
                    }
                } catch {
                    // audit_content failure is non-fatal — recorded as warning only.
                }
            }
        }

        // Pass 2: CSContentValidator — placeholder / dup / wrong-subpath / empty-body / step-def coverage.
        // This pass catches the failure classes that the audit_content rules don't cover.
        const validatorFiles: Array<{ relativePath: string; kind: 'feature' | 'page' | 'steps' | 'data'; content: string }> = [];
        for (const [rel, content] of Object.entries(contentMap.files)) {
            const kind: 'feature' | 'page' | 'steps' | 'data' =
                rel.endsWith('.feature') ? 'feature' :
                rel.includes('/pages/') ? 'page' :
                rel.endsWith('.steps.ts') ? 'steps' :
                rel.endsWith('.json') ? 'data' :
                'page';
            validatorFiles.push({ relativePath: rel, kind, content });
        }
        const contentViolations = CSContentValidator.validateAll(validatorFiles);
        for (const v of contentViolations) {
            if (!allViolations[v.relativePath]) allViolations[v.relativePath] = [];
            allViolations[v.relativePath].push({
                ruleId: v.ruleId,
                severity: v.severity === 'error' ? 'error' : 'warning',
                line: v.line,
                message: v.message,
            });
            totalViolations++;
        }

        const errorCount = Object.values(allViolations)
            .flat()
            .filter((v) => v.severity === 'error').length;
        const clean = totalViolations === 0;
        const hasErrors = errorCount > 0;

        ctx.writePhaseArtifact(
            'audit',
            'violations.json',
            JSON.stringify(allViolations, null, 2),
        );
        const md = renderAuditMarkdown(allViolations, Object.keys(contentMap.files).length);
        const reportPath = CSStatusWriter.writePhaseReport(
            ctx, 'audit', 'Audit Report', md,
        );
        ctx.finishPhase('audit', clean ? 'done' : (hasErrors ? 'blocked_user' : 'auto_resolved'), { reportPath });
        CSStatusWriter.write(ctx);

        if (hasErrors) {
            return jsonResult(
                {
                    state: 'BLOCKED_NEED_HUMAN',
                    runId,
                    phase: 'audit',
                    violationCount: totalViolations,
                    errorCount,
                    filesWithViolations: Object.keys(allViolations).length,
                    clean: false,
                    runFolder: ctx.runFolder,
                    reportPath,
                    nextStepNeeded: true,
                    nextSuggestedTool: 'csaa_translate',
                    nextSuggestedArgs: { runId },
                    blockedReason: `Audit gates blocked ${errorCount} error-level violation(s). Run csaa_translate again with the violation feedback so the LLM can fix them, OR resolve manually and re-run csaa_audit.`,
                },
                `Audit BLOCKED: ${errorCount} error(s) — re-run csaa_translate to fix or escalate.`,
            );
        }

        return jsonResult(
            {
                state: 'RUNNING',
                runId,
                phase: 'audit',
                violationCount: totalViolations,
                filesWithViolations: Object.keys(allViolations).length,
                clean,
                runFolder: ctx.runFolder,
                reportPath,
                nextStepNeeded: true,
                nextSuggestedTool: 'csaa_write',
                nextSuggestedArgs: { runId },
            },
            clean
                ? `Audit clean. Call csaa_write next.`
                : `Audit found ${totalViolations} warning(s). Call csaa_write next; trust score will reflect.`,
        );
    })
    .build();

function renderAuditMarkdown(
    violations: Record<string, AuditViolation[]>,
    totalFiles: number,
): string {
    const lines: string[] = [];
    const fileCount = Object.keys(violations).length;
    lines.push('# Audit Report');
    lines.push('');
    lines.push(`Files audited: ${totalFiles}  ·  Files with violations: ${fileCount}`);
    lines.push('');
    if (fileCount === 0) {
        lines.push('_All files clean._');
        return lines.join('\n');
    }
    for (const [rel, list] of Object.entries(violations)) {
        lines.push(`## \`${rel}\``);
        for (const v of list) {
            lines.push(`- **[${v.severity}] ${v.ruleId}**${v.line ? ` (line ${v.line})` : ''}: ${v.message}`);
        }
        lines.push('');
    }
    return lines.join('\n');
}

// ============================================================================
// csaa_write — Phase 7: atomic per-file writer
// ============================================================================

const csaa_write: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('csaa_write')
    .title('CS-AI-Auto-Assist — Write (Phase 7)')
    .description(
        'Atomically write every file in the translator\'s ContentMap to disk under ' +
            '`workspaceRoot`. Skip-existing protection unless overwriteExisting is true. ' +
            'Persists Fix Manifest with sha256 + bytes per file.',
    )
    .category('multiagent')
    .stringParam('runId', 'Run ID', { required: true })
    .stringParam('workspaceRoot', 'Workspace root for output (default: runContext workspace)')
    .booleanParam('overwriteExisting', 'When true, overwrite files that already exist', { default: false })
    .handler(async (params: Record<string, unknown>, _toolCtx: MCPToolContext) => {
        const runId = String(params.runId ?? '');
        const ctx = getCtx(runId);
        if (!ctx) return errorResult(`unknown runId '${runId}'`, runId);

        const cmRaw = ctx.readPhaseArtifact('translate', 'content-map.json');
        if (!cmRaw) {
            return errorResult(`no content map — call csaa_translate first`, runId);
        }
        const cm = JSON.parse(cmRaw) as {
            files: Record<string, string>;
            confidence: Record<string, number>;
            notes: string[];
        };

        const workspaceRoot = getStr(params, 'workspaceRoot') ?? path.dirname(path.dirname(ctx.runFolder));
        const overwriteExisting = params.overwriteExisting === true;

        ctx.startPhase('write');
        try {
            const result = await CSWriteWithAudit.write(
                { files: cm.files, confidence: cm.confidence, notes: cm.notes },
                { workspaceRoot, overwriteExisting },
            );

            // Framework config scaffold — generate the env files the runner
            // needs to actually start tests. Without these the framework has
            // no URL, no credentials, no DB queries.
            //   config/<project>/global.env
            //   config/<project>/common/common.env
            //   config/<project>/common/<project>-db-queries.env
            //   config/<project>/environments/<env>.env  (one per env)
            const configWritten = await scaffoldFrameworkConfig(
                ctx, workspaceRoot, _toolCtx,
            );

            ctx.writePhaseArtifact(
                'write',
                'written.json',
                JSON.stringify(
                    {
                        written: [...result.written, ...configWritten],
                        skippedExisting: result.skippedExisting,
                        manifest: result.manifest,
                        configScaffolded: configWritten,
                    },
                    null, 2,
                ),
            );
            const md = CSWriteWithAudit.renderManifest(result) +
                (configWritten.length > 0
                    ? `\n\n## Framework config scaffold\n\n${configWritten.map((p) => `- \`${p}\``).join('\n')}\n`
                    : '');
            const reportPath = CSStatusWriter.writePhaseReport(
                ctx, 'write', 'Fix Manifest', md,
            );
            ctx.finishPhase('write', 'done', { reportPath });
            CSStatusWriter.write(ctx);
            return jsonResult(
                {
                    state: 'RUNNING',
                    runId,
                    phase: 'write',
                    written: result.written.length,
                    skippedExisting: result.skippedExisting.length,
                    auditFailed: result.auditFailed.length,
                    runFolder: ctx.runFolder,
                    reportPath,
                    nextStepNeeded: true,
                    nextSuggestedTool: 'csaa_execute',
                    nextSuggestedArgs: { runId },
                    filesWritten: result.written,
                },
                `Wrote ${result.written.length} file(s); skipped ${result.skippedExisting.length} existing. Call csaa_execute next.`,
            );
        } catch (err) {
            ctx.finishPhase('write', 'blocked_user', {
                reason: err instanceof Error ? err.message : String(err),
            });
            CSStatusWriter.write(ctx);
            return errorResult(
                `csaa_write failed: ${err instanceof Error ? err.message : String(err)}`,
                runId,
            );
        }
    })
    .build();

// ============================================================================
// csaa_execute — Phase 8: run scenarios + heal
// ============================================================================

const csaa_execute: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('csaa_execute')
    .title('CS-AI-Auto-Assist — Execute + Heal (Phase 8)')
    .description(
        'Run every generated feature via bdd_run_feature. On failure, classify via ' +
            'CSHealClassifier (4-category baseline + visual-evidence reclassification). ' +
            'Up to 3 heal cycles per failure are reserved; the agent prompt drives the ' +
            'patch + re-run loop using apply_patch + csaa_execute re-invoke.',
    )
    .category('multiagent')
    .stringParam('runId', 'Run ID', { required: true })
    .stringParam('appUrl', 'Live application URL the tests should run against')
    .stringParam('project', 'Project name')
    .stringParam('env', 'Environment (dev / sit / uat)', { default: 'dev' })
    .stringParam('tags', 'Optional Cucumber tag expression to filter scenarios')
    .handler(async (params: Record<string, unknown>, _toolCtx: MCPToolContext) => {
        const runId = String(params.runId ?? '');
        const ctx = getCtx(runId);
        if (!ctx) return errorResult(`unknown runId '${runId}'`, runId);

        const writtenRaw = ctx.readPhaseArtifact('write', 'written.json');
        if (!writtenRaw) {
            return errorResult(`no written artefacts — call csaa_write first`, runId);
        }
        const written = JSON.parse(writtenRaw) as { written: string[] };
        const features = written.written.filter((p) => p.endsWith('.feature'));
        if (features.length === 0) {
            ctx.startPhase('execute');
            ctx.finishPhase('execute', 'auto_resolved', {
                reason: 'no .feature files written; nothing to execute',
            });
            CSStatusWriter.write(ctx);
            return jsonResult(
                {
                    state: 'RUNNING', runId, phase: 'execute',
                    scenariosPassed: 0, scenariosFailed: 0,
                    nextStepNeeded: true, nextSuggestedTool: 'csaa_verify',
                    nextSuggestedArgs: { runId },
                },
                `No feature files to execute. Call csaa_verify.`,
            );
        }

        const project = getStr(params, 'project') ?? 'default';
        const env = getStr(params, 'env') ?? 'dev';
        const tags = getStr(params, 'tags');

        // CSConfigurationManager reads project/env from process.env (see
        // CSConfigurationManager.ts:76-77). Set them here so the runner
        // picks up the right config folder. Restore originals after.
        const prevProject = process.env.PROJECT;
        const prevEnv = process.env.ENVIRONMENT;
        if (project) process.env.PROJECT = project;
        if (env) process.env.ENVIRONMENT = env;

        ctx.startPhase('execute');
        const bddRun = (bddTools as MCPToolDefinition[]).find((t) => t.tool.name === 'bdd_run_feature');
        const perFeature: Array<{
            feature: string;
            passed: boolean;
            output: string;
            failureSnippet?: string;
        }> = [];

        let totalPassed = 0;
        let totalFailed = 0;

        if (!bddRun) {
            ctx.finishPhase('execute', 'auto_resolved', {
                reason: 'bdd_run_feature tool not registered; skipping execution',
            });
            CSStatusWriter.write(ctx);
            return jsonResult(
                {
                    state: 'RUNNING', runId, phase: 'execute',
                    scenariosPassed: 0, scenariosFailed: 0,
                    nextStepNeeded: true, nextSuggestedTool: 'csaa_verify',
                    nextSuggestedArgs: { runId },
                    note: 'bdd_run_feature not available in this environment',
                },
                `Execute skipped (bdd_run_feature not available). Call csaa_verify.`,
            );
        }

        for (const feature of features) {
            const runDir = path.join(
                CSRunContext.phaseFolder('execute'),
                'runs',
                path.basename(feature, '.feature'),
            );
            try {
                // bdd_run_feature parameter is named `path` (see
                // CSMCPBDDTools.ts:222). Don't pass `featureFile` — the
                // tool silently drops it and crashes with "path argument
                // must be of type string. Received undefined".
                const result = await bddRun.handler(
                    {
                        path: feature,
                        ...(tags ? { tags } : {}),
                    },
                    _toolCtx,
                );
                const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? '';
                ctx.writePhaseArtifact('execute', path.join(runDir, 'output.log'), text);
                const passed = !result.isError && /(passed|0 fail|all scenarios passed)/i.test(text);
                if (passed) totalPassed++;
                else totalFailed++;
                const failureSnippet = passed ? undefined : text.slice(-2000);
                perFeature.push({ feature, passed, output: text.slice(0, 800), failureSnippet });
            } catch (err) {
                totalFailed++;
                perFeature.push({
                    feature,
                    passed: false,
                    output: err instanceof Error ? err.message : String(err),
                });
                ctx.writePhaseArtifact(
                    'execute',
                    path.join(runDir, 'output.log'),
                    err instanceof Error ? err.stack ?? err.message : String(err),
                );
            }
        }

        const md = renderExecuteMarkdown(perFeature);
        const reportPath = CSStatusWriter.writePhaseReport(
            ctx, 'execute', 'Execution Report', md,
        );
        ctx.writePhaseArtifact(
            'execute',
            'summary.json',
            JSON.stringify(
                {
                    perFeature: perFeature.map((f) => ({
                        feature: f.feature,
                        passed: f.passed,
                        failureSnippet: f.failureSnippet,
                    })),
                    totalPassed,
                    totalFailed,
                },
                null, 2,
            ),
        );
        ctx.finishPhase(
            'execute',
            totalFailed === 0 ? 'done' : 'auto_resolved',
            { reportPath },
        );
        CSStatusWriter.write(ctx);

        // Restore env so we don't leak the per-run project/env into other tools.
        if (prevProject === undefined) delete process.env.PROJECT;
        else process.env.PROJECT = prevProject;
        if (prevEnv === undefined) delete process.env.ENVIRONMENT;
        else process.env.ENVIRONMENT = prevEnv;

        return jsonResult(
            {
                state: 'RUNNING',
                runId,
                phase: 'execute',
                scenariosPassed: totalPassed,
                scenariosFailed: totalFailed,
                runFolder: ctx.runFolder,
                reportPath,
                nextStepNeeded: true,
                nextSuggestedTool: 'csaa_verify',
                nextSuggestedArgs: { runId },
            },
            `Execute: ${totalPassed} passed / ${totalFailed} failed across ${features.length} feature(s). Call csaa_verify.`,
        );
    })
    .build();

function renderExecuteMarkdown(
    perFeature: Array<{
        feature: string;
        passed: boolean;
        output: string;
        failureSnippet?: string;
    }>,
): string {
    const lines: string[] = [];
    lines.push('# Execution Report');
    lines.push('');
    for (const f of perFeature) {
        lines.push(`## \`${f.feature}\`  ${f.passed ? 'PASS' : 'FAIL'}`);
        if (f.failureSnippet) {
            lines.push('');
            lines.push('```');
            lines.push(f.failureSnippet);
            lines.push('```');
        }
        lines.push('');
    }
    return lines.join('\n');
}

// ============================================================================
// csaa_verify — Phase 9a: trust score + final report
// ============================================================================

const csaa_verify: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('csaa_verify')
    .title('CS-AI-Auto-Assist — Verify (Phase 9)')
    .description(
        'Compute the trust score from the run\'s artefacts (source-grounded, executed, ' +
            'audit-passed, heal-cycles) and write the final-report.md at the run folder root.',
    )
    .category('multiagent')
    .stringParam('runId', 'Run ID', { required: true })
    .handler(async (params: Record<string, unknown>) => {
        const runId = String(params.runId ?? '');
        const ctx = getCtx(runId);
        if (!ctx) return errorResult(`unknown runId '${runId}'`, runId);

        ctx.startPhase('verify');
        const reportRaw = ctx.readPhaseArtifact('analyze', 'analysis-report.json');
        const violationsRaw = ctx.readPhaseArtifact('audit', 'violations.json');
        const writtenRaw = ctx.readPhaseArtifact('write', 'written.json');
        const summaryRaw = ctx.readPhaseArtifact('execute', 'summary.json');

        const analysis = reportRaw ? JSON.parse(reportRaw) as Record<string, unknown> : null;
        const violations = violationsRaw ? JSON.parse(violationsRaw) as Record<string, Array<{ severity?: string }>> : {};
        const written = writtenRaw ? JSON.parse(writtenRaw) as { written: string[] } : { written: [] };
        const summary = summaryRaw
            ? (JSON.parse(summaryRaw) as { totalPassed: number; totalFailed: number })
            : { totalPassed: 0, totalFailed: 0 };

        // Multiplicative trust: ANY factor being zero → trust = 0 → verdict = FAILED.
        // No more PASS_WEAK on garbage output.
        const errorCount = Object.values(violations)
            .flat()
            .filter((v) => v.severity === 'error').length;
        const totalScenarios = summary.totalPassed + summary.totalFailed;

        const factors = {
            sourceGrounded: analysis ? 1.0 : 0.0,
            auditClean: errorCount === 0 ? 1.0 : 0.0,
            executed: totalScenarios > 0 ? 1.0 : 0.5,
            passRate: totalScenarios > 0 ? summary.totalPassed / totalScenarios : 0.5,
            filesWritten: written.written.length > 0 ? 1.0 : 0.0,
        };
        const trust =
            factors.sourceGrounded *
            factors.auditClean *
            factors.executed *
            factors.passRate *
            factors.filesWritten;

        let verdict: 'PASS' | 'PASS_PARTIAL' | 'FAILED';
        if (trust >= 0.85) verdict = 'PASS';
        else if (trust >= 0.5) verdict = 'PASS_PARTIAL';
        else verdict = 'FAILED';

        const blockers: string[] = [];
        if (factors.sourceGrounded === 0) blockers.push('no recorded analysis (csaa_analyze never fulfilled)');
        if (factors.auditClean === 0) blockers.push(`${errorCount} audit error(s)`);
        if (factors.filesWritten === 0) blockers.push('zero files written');
        if (factors.executed === 0.5) blockers.push('execution did not run');
        if (totalScenarios > 0 && summary.totalFailed > 0) {
            blockers.push(`${summary.totalFailed} of ${totalScenarios} scenario(s) failed`);
        }

        ctx.writePhaseArtifact(
            'verify',
            'trust-score.json',
            JSON.stringify({ trust, factors, verdict, blockers, summary, errorCount }, null, 2),
        );
        ctx.complete();
        CSStatusWriter.write(ctx);
        const finalPath = CSStatusWriter.writeFinalReport(ctx, {
            filesWritten: written.written,
            trustScore: trust,
            warnings: blockers,
        });

        return jsonResult(
            {
                state: verdict === 'PASS' ? 'READY' : 'BLOCKED_NEED_HUMAN',
                runId,
                phase: 'verify',
                verdict,
                trustScore: trust,
                factors,
                blockers,
                scenariosPassed: summary.totalPassed,
                scenariosFailed: summary.totalFailed,
                errorCount,
                runFolder: ctx.runFolder,
                finalReportPath: finalPath,
                nextStepNeeded: false,
            },
            `Verify: ${verdict} (trust ${trust.toFixed(2)}). ${summary.totalPassed} pass / ${summary.totalFailed} fail / ${errorCount} audit errors. ${blockers.length ? 'Blockers: ' + blockers.join('; ') : 'No blockers.'}`,
        );
    })
    .build();

// ============================================================================
// csaa_publish — Phase 9b (optional): push run results back to ADO
// ============================================================================

const csaa_publish: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('csaa_publish')
    .title('CS-AI-Auto-Assist — Publish to ADO (optional)')
    .description(
        'Push generated test cases back to an ADO test plan + suite. Walks every generated ' +
            'feature\'s scenarios and creates one ADO Test Case per scenario without an existing ' +
            '@TC_<id> tag, then injects the new TC ids back into the .feature file.',
    )
    .category('multiagent')
    .stringParam('runId', 'Run ID', { required: true })
    .stringParam('planId', 'ADO Test Plan ID', { required: true })
    .stringParam('suiteId', 'ADO Test Suite ID', { required: true })
    .stringParam('organization', 'ADO organization (or ADO_ORGANIZATION env)')
    .stringParam('project', 'ADO project (or ADO_PROJECT env)')
    .stringParam('pat', 'ADO PAT (or ADO_PAT env, supports ENCRYPTED:)')
    .handler(async (params: Record<string, unknown>, _toolCtx: MCPToolContext) => {
        const runId = String(params.runId ?? '');
        const ctx = getCtx(runId);
        if (!ctx) return errorResult(`unknown runId '${runId}'`, runId);

        const writtenRaw = ctx.readPhaseArtifact('write', 'written.json');
        if (!writtenRaw) {
            return errorResult(`no written artefacts — call csaa_write first`, runId);
        }
        const written = JSON.parse(writtenRaw) as { written: string[] };
        const featureFiles: GeneratedFeatureSummary[] = written.written
            .filter((p) => p.endsWith('.feature'))
            .map((p) => parseFeatureForSummary(p));

        const planId = Number(params.planId);
        const suiteId = Number(params.suiteId);
        const adoCommon = {
            organization: getStr(params, 'organization') ?? '',
            project: getStr(params, 'project') ?? '',
            pat: getStr(params, 'pat') ?? '',
        };
        const pipelineOutput: PipelineOutput = {
            runId, pipelineVersion: '1.34.0',
            filesCreated: written.written, featureFiles,
        };
        try {
            const result = await CSAdoCreateBackFlow.maybeCreateBack(
                pipelineOutput, planId, suiteId, adoCommon, _toolCtx,
            );
            return jsonResult(
                {
                    state: 'READY',
                    runId,
                    phase: 'publish',
                    createdTestCaseIds: result.createdTestCaseIds,
                    linked: result.linkedScenarios,
                    skipped: result.skipped,
                    updatedFiles: result.updatedFiles,
                    nextStepNeeded: false,
                },
                `Published ${result.createdTestCaseIds.length} test case(s) to plan ${planId} suite ${suiteId}.`,
            );
        } catch (err) {
            return errorResult(
                `csaa_publish failed: ${err instanceof Error ? err.message : String(err)}`,
                runId,
            );
        }
    })
    .build();

function parseFeatureForSummary(filePath: string): GeneratedFeatureSummary {
    let content = '';
    try { content = fs.readFileSync(filePath, 'utf-8'); } catch { /* ignore */ }
    const scenarios: GeneratedScenarioSummary[] = [];
    const lines = content.split(/\r?\n/);
    let pendingTags: string[] = [];
    for (const raw of lines) {
        const trimmed = raw.trim();
        if (trimmed.startsWith('@')) {
            for (const t of trimmed.split(/\s+/)) {
                if (t.startsWith('@')) pendingTags.push(t);
            }
            continue;
        }
        const m = trimmed.match(/^Scenario(?:\s+Outline)?\s*:\s*(.+?)\s*$/);
        if (m) {
            const title = m[1];
            const idTag = pendingTags.find((t) => /^@(?:TS_|tc_|TC_)/i.test(t)) ?? pendingTags[0] ?? title;
            const id = idTag.replace(/^@/, '');
            const tcMatch = pendingTags.find((t) => /^@TC_\d+$/.test(t));
            scenarios.push({
                id,
                title,
                tags: pendingTags.slice(),
                tcId: tcMatch ? Number(tcMatch.replace(/^@TC_/, '')) : undefined,
            });
            pendingTags = [];
        } else if (trimmed.length > 0 && !trimmed.startsWith('#')) {
            pendingTags = [];
        }
    }
    return { filePath, content, scenarios };
}

// ============================================================================
// Helper tools — query existing pages/steps + correction memory + DOM
// ============================================================================

const csaa_query_existing_pages: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('csaa_query_existing_pages')
    .title('CS-AI-Auto-Assist — Query Existing Pages')
    .description(
        'Scan `test/<project>/pages/` for existing CS Playwright page objects and rank them ' +
            'by semantic similarity to a candidate legacy page name. Used by translator to ' +
            'reuse rather than re-create.',
    )
    .category('multiagent')
    .stringParam('workspaceRoot', 'Workspace root', { required: true })
    .stringParam('project', 'Project name', { required: true })
    .stringParam('module', 'Optional module sub-folder')
    .stringParam('candidateClassName', 'Legacy page class name to match against', { required: true })
    .handler(async (params: Record<string, unknown>) => {
        const workspaceRoot = String(params.workspaceRoot ?? '');
        const project = String(params.project ?? '');
        const candidate = String(params.candidateClassName ?? '');
        if (!workspaceRoot || !project || !candidate) {
            return errorResult('workspaceRoot, project, candidateClassName all required');
        }
        const inv = CSRepoInventory.inventory(project, { workspaceRoot });
        const decision = CSSemanticReuse.decidePage(
            { className: candidate, sourcePath: undefined, elements: [], publicMethods: [] },
            inv.pages,
        );
        return jsonResult(decision,
            `decidePage for ${candidate}: ${decision.decision} (top score ${decision.candidates[0]?.score?.toFixed(2) ?? '0'}).`,
        );
    })
    .build();

const csaa_read_legacy_data: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('csaa_read_legacy_data')
    .title('CS-AI-Auto-Assist — Read Legacy Data File')
    .description(
        'Read a legacy data file (.xlsx, .xls, .csv, .tsv, .json, .properties, .xml) into ' +
            'typed rows. Returns columns + first N rows (cap default 100) for analyzer use.',
    )
    .category('multiagent')
    .stringParam('filePath', 'Absolute path to the data file', { required: true })
    .stringParam('sheet', 'Optional sheet name (xlsx only)')
    .handler(async (params: Record<string, unknown>) => {
        const filePath = String(params.filePath ?? '');
        if (!filePath) return errorResult('filePath required');
        const result = CSLegacyDataReader.read(filePath, {
            sheet: getStr(params, 'sheet'),
        });
        return jsonResult(result,
            result.kind === 'rows'
                ? `Read ${result.rowCount} rows / ${result.columns.length} cols from ${result.format} file.`
                : `Could not read ${filePath}: ${result.reason}`,
        );
    })
    .build();

/**
 * Generate the framework config scaffold for the current run. Pulls
 * project name, environments, and DB aliases from the recorded analysis
 * and invokes the existing `generate_config_scaffold` +
 * `generate_db_queries_config` tools — writing:
 *   config/<project>/global.env
 *   config/<project>/common/common.env
 *   config/<project>/environments/<env>.env  (one per env)
 *   config/<project>/common/<project>-db-queries.env  (stub if no queries)
 *
 * Returns the list of absolute file paths created.
 */
async function scaffoldFrameworkConfig(
    ctx: CSRunContext,
    workspaceRoot: string,
    _toolCtx: MCPToolContext,
): Promise<string[]> {
    const written: string[] = [];
    const analysisRaw = ctx.readPhaseArtifact('analyze', 'analysis-report.json');
    if (!analysisRaw) return written;
    let analysis: Record<string, unknown> & {
        feature?: { slug?: string };
        configFiles?: Array<{ env?: string; values?: Record<string, string> }>;
    };
    try { analysis = JSON.parse(analysisRaw); } catch { return written; }

    // Priority order for project + module resolution:
    //   1. intake/run-params.json — user-supplied at csaa_analyze time (authoritative)
    //   2. plan/migration-plan.json — legacy artefact, may not exist
    //   3. analysis.feature.slug — last resort fallback
    // Without (1) the scaffold previously fell back to feature.slug, which
    // the LLM tends to set to the module name (e.g. the per-module name
    // instead of the project name), landing the config files under
    // config/<module>/ instead of config/<project>/.
    let project: string | undefined;
    let module: string | undefined;
    const runParamsRaw = ctx.readPhaseArtifact('intake', 'run-params.json');
    if (runParamsRaw) {
        try {
            const rp = JSON.parse(runParamsRaw) as { project?: string; module?: string };
            project = rp.project;
            module = rp.module;
        } catch { /* ignore */ }
    }
    if (!project) {
        const planRaw = ctx.readPhaseArtifact('plan', 'migration-plan.json');
        if (planRaw) {
            try {
                const plan = JSON.parse(planRaw) as { project?: string; module?: string };
                project = plan.project ?? project;
                module = module ?? plan.module;
            } catch { /* ignore */ }
        }
    }
    project = project ?? (analysis.feature?.slug ?? '').toLowerCase();
    if (!project || project === 'default') {
        // Defensive — the analyze gate should have caught this, but if
        // scaffold is reached with no real project name we refuse to
        // create config/default/ (a known-bad fallback path).
        ctx.writePhaseArtifact(
            'write',
            'config-scaffold-error.txt',
            `Refusing to scaffold config — project name resolved to '${project || '<empty>'}'. ` +
            'Re-run csaa_classify with the desired project name (e.g. project=<your-project>) ' +
            'so intake/run-params.json carries a real project value before csaa_write.',
        );
        return written;
    }
    module = module ?? project;

    // Derive env list + per-env URLs + per-env credentials from
    // analysis.configFiles[]. The LLM is instructed (STEP 3 of the analyze
    // envelope) to populate values: { url, username, password, ... } when it
    // parses each properties file. If populated, those real values land in
    // the generated environments/<env>.env files. Otherwise the scaffold
    // falls back to placeholder URLs and blank credential lines.
    const envs = new Set<string>();
    const envBaseUrls: Record<string, string> = {};
    const envCredentials: Record<string, { username?: string; password?: string }> = {};
    let fallbackBaseUrl: string | undefined;
    // Match values keys broadly: legacy properties files often use dotted
    // keys (env.baseurl, app.url, db.user) — we accept any key whose
    // lower-cased form matches one of the synonyms below.
    //
    // CRITICAL: BASE_URL must be the WEB APP URL, not a DB connection
    // string. Legacy env.properties files commonly carry both:
    //   env.baseurl = https://app.example.com
    //   db.connection.url = jdbc:oracle:thin:@//host:1521/service
    // The previous matcher accepted the FIRST key whose normalized form
    // ended in "url" — which happened to be the JDBC string for some
    // files, so BASE_URL landed at `jdbc:oracle:thin:@//...`. We now
    // prefer web-URL keys (web/app/ui/portal/base/host with `url`/`host`
    // suffix) AND reject non-http schemes outright.
    const pick = (
        values: Record<string, string>,
        synonyms: string[],
        forbidSchemes: string[] = [],
    ): string | undefined => {
        // Two-pass: first prefer keys whose normalized form is exactly a
        // synonym; fall back to suffix match. Within each pass, reject any
        // value whose scheme is in forbidSchemes.
        const passes: Array<(norm: string, syn: string) => boolean> = [
            (n, s) => n === s,
            (n, s) => n.endsWith(s),
        ];
        for (const test of passes) {
            for (const [k, val] of Object.entries(values)) {
                if (!val) continue;
                const norm = k.toLowerCase().replace(/[._-]/g, '');
                if (!synonyms.some((s) => test(norm, s))) continue;
                if (forbidSchemes.length > 0) {
                    const lower = val.toLowerCase().trim();
                    if (forbidSchemes.some((sch) => lower.startsWith(sch))) continue;
                }
                return val;
            }
        }
        return undefined;
    };
    // Web URL synonyms — DO NOT include bare `url` first because db.url /
    // dbconnectionurl will match it. Web-specific tokens come first.
    const URL_SYNONYMS = [
        'baseurl', 'appurl', 'webappurl', 'webhost', 'apphost',
        'portalurl', 'uiurl', 'siteurl', 'serviceurl',
        // bare 'url' / 'host' only matches if it's not a db.* key (the
        // dotted-key check above strips dots but db. prefix is captured by
        // the synonym not matching dbconnectionurl etc.)
        'url', 'host',
    ];
    const FORBIDDEN_URL_SCHEMES = ['jdbc:', 'mongodb:', 'redis:', 'amqp:', 'kafka:', 'ldap:', 'ldaps:', 'file:', 'ftp:'];
    for (const c of analysis.configFiles ?? []) {
        if (c.env) envs.add(c.env);
        const v = (c as { values?: Record<string, string> }).values;
        if (!v) continue;
        // Filter out db.* / database.* / jdbc.* keys before URL matching —
        // otherwise db.url etc. wins the suffix match.
        const webOnly: Record<string, string> = {};
        for (const [k, val] of Object.entries(v)) {
            if (/^(?:db|database|jdbc|datasource|connection)\b/i.test(k)) continue;
            webOnly[k] = val;
        }
        let url = pick(webOnly, URL_SYNONYMS, FORBIDDEN_URL_SCHEMES);
        // Additional sanity: require http(s) scheme. If the picked value is
        // somehow still non-http (e.g. a hostname without scheme), prepend
        // https://. If it's a known-bad scheme, discard.
        if (url) {
            const lower = url.toLowerCase().trim();
            if (FORBIDDEN_URL_SCHEMES.some((sch) => lower.startsWith(sch))) {
                url = undefined;
            } else if (!/^https?:\/\//i.test(url) && /^[a-z0-9.-]+(:\d+)?(\/|$)/i.test(url)) {
                // Hostname-only value → assume https.
                url = `https://${url.replace(/^\/+/, '')}`;
            } else if (!/^https?:\/\//i.test(url)) {
                url = undefined;
            }
        }
        const user = pick(v, ['username', 'user', 'defaultusername', 'loginusername', 'testusername', 'appuser']);
        const pwd = pick(v, ['password', 'pwd', 'pass', 'defaultpassword', 'loginpassword', 'testpassword', 'apppassword']);
        if (c.env) {
            if (url) envBaseUrls[c.env] = url;
            if (user || pwd) envCredentials[c.env] = { username: user, password: pwd };
        } else if (!fallbackBaseUrl && url) {
            fallbackBaseUrl = url;
        }
    }
    const environments = envs.size > 0 ? [...envs] : ['sit'];
    const baseUrl = fallbackBaseUrl;

    // Preserve + override process.cwd so the generation tools write into the
    // consumer's workspace, not the framework's own dir.
    const prevCwd = process.cwd();
    let scaffoldCwd: string | undefined;
    // Ensure context.log exists — generation tools call it unconditionally.
    const scaffoldCtx: MCPToolContext = {
        ..._toolCtx,
        log: ((_toolCtx as { log?: (...args: unknown[]) => void }).log ?? (() => { /* no-op */ })) as MCPToolContext['log'],
    } as MCPToolContext;
    try {
        if (workspaceRoot && fs.existsSync(workspaceRoot)) {
            try { process.chdir(workspaceRoot); scaffoldCwd = workspaceRoot; } catch { /* ignore */ }
        }

        const genScaffold = (generationTools as MCPToolDefinition[]).find(
            (t) => t.tool.name === 'generate_config_scaffold',
        );
        if (genScaffold) {
            try {
                const res = await genScaffold.handler(
                    {
                        project,
                        ...(module ? { module } : {}),
                        environments,
                        ...(baseUrl ? { baseUrl } : {}),
                        ...(Object.keys(envBaseUrls).length > 0 ? { envBaseUrls } : {}),
                        ...(Object.keys(envCredentials).length > 0 ? { envCredentials } : {}),
                        crossDomainEnabled: true,
                    },
                    scaffoldCtx,
                );
                const sc = res.structuredContent as
                    | { filesGenerated?: string[]; filesUpdated?: string[] }
                    | undefined;
                for (const p of sc?.filesGenerated ?? []) written.push(p);
                for (const p of sc?.filesUpdated ?? []) written.push(p);
            } catch (err) {
                ctx.writePhaseArtifact(
                    'write',
                    'config-scaffold-error.txt',
                    err instanceof Error ? (err.stack ?? err.message) : String(err),
                );
            }
        }

        const genDbQueries = (generationTools as MCPToolDefinition[]).find(
            (t) => t.tool.name === 'generate_db_queries_config',
        );
        if (genDbQueries) {
            try {
                // Empty queries[] → header-only stub the consumer can fill in.
                // If analysis later captures SQL, we'd pass real entries here.
                const res = await genDbQueries.handler(
                    {
                        project,
                        module,
                        queries: [],
                    },
                    scaffoldCtx,
                );
                const sc = res.structuredContent as
                    | { filePath?: string; filesGenerated?: string[]; filesUpdated?: string[] }
                    | undefined;
                if (sc?.filePath) written.push(sc.filePath);
                for (const p of sc?.filesGenerated ?? []) {
                    if (!written.includes(p)) written.push(p);
                }
                for (const p of sc?.filesUpdated ?? []) {
                    if (!written.includes(p)) written.push(p);
                }
            } catch (err) {
                ctx.writePhaseArtifact(
                    'write',
                    'db-queries-scaffold-error.txt',
                    err instanceof Error ? (err.stack ?? err.message) : String(err),
                );
            }
        }
    } finally {
        if (scaffoldCwd) {
            try { process.chdir(prevCwd); } catch { /* ignore */ }
        }
    }
    return written;
}

// ============================================================================
// csaa_expand_helper — Deterministic helper-method body extraction
// ============================================================================
// The LLM calls this during analyze to get the authoritative leaf-action list
// inside a helper method (e.g. CTSGSupportMethods.TS_4958). It MUST then emit
// one Gherkin step per returned action — no more "Execute shared support
// flow TS_4958" stubs.

const csaa_expand_helper: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('csaa_expand_helper')
    .title('CS-AI-Auto-Assist — Expand legacy helper method body')
    .description(
        'Returns the ordered leaf-action list for a single helper method in a legacy Java ' +
            'source file. The LLM MUST call this for every helper invocation it encounters ' +
            'in a @Test body (e.g. CTSGSupportMethods.TS_4958(dataBean)), then emit one Gherkin ' +
            'step per returned action. Resolves the helper file from the discover inventory ' +
            'or by searching the workspace.',
    )
    .category('multiagent')
    .stringParam('runId', 'Run ID', { required: true })
    .stringParam('helperClass', 'Java class name (e.g. CTSGSupportMethods)', { required: true })
    .stringParam('helperMethod', 'Method name (e.g. TS_4958)', { required: true })
    .handler(async (params: Record<string, unknown>) => {
        const runId = String(params.runId ?? '');
        const ctx = getCtx(runId);
        if (!ctx) return errorResult(`unknown runId '${runId}'`, runId);
        const helperClass = getStr(params, 'helperClass');
        const helperMethod = getStr(params, 'helperMethod');
        if (!helperClass || !helperMethod) {
            return errorResult('helperClass + helperMethod required', runId);
        }

        // Try the cached signature first.
        const sigRaw = ctx.readPhaseArtifact('discover', 'signature.json');
        if (sigRaw) {
            try {
                const sig = JSON.parse(sigRaw) as FullSignature;
                const cached = sig.helpers[`${helperClass}.${helperMethod}`];
                if (cached) {
                    return jsonResult(
                        {
                            state: 'RUNNING',
                            runId,
                            helperClass,
                            helperMethod,
                            filePath: cached.filePath,
                            actionCount: cached.actions.length,
                            actions: cached.actions,
                        },
                        `Expanded ${helperClass}.${helperMethod}: ${cached.actions.length} leaf action(s).`,
                    );
                }
            } catch { /* fall through */ }
        }

        // Cache miss → resolve and extract on the fly.
        const inventoryRaw = ctx.readPhaseArtifact('discover', 'inventory.json');
        if (!inventoryRaw) {
            return errorResult('no inventory — run csaa_discover first', runId);
        }
        const inv = JSON.parse(inventoryRaw) as LegacyInventory;
        const helpers = (inv.helpers ?? []).map((h) => ({
            className: path.basename(h as string, path.extname(h as string)),
            path: h as string,
        }));
        const pages = (inv.pages ?? []).map((p) => ({
            className: path.basename(p as string, path.extname(p as string)),
            path: p as string,
        }));
        const all = [...helpers, ...pages];
        const found = all.find((x) => x.className === helperClass);
        if (!found) {
            return jsonResult(
                {
                    state: 'AWAITING_LLM_RETRY',
                    runId,
                    error: `helper class '${helperClass}' not found in inventory (${inv.helpers?.length ?? 0} helpers + ${inv.pages?.length ?? 0} pages scanned)`,
                    suggestion: 'Verify the class name spelling. If OCR / fuzzy-match is needed, check inventory.json under 02-discover for the closest match.',
                },
                `Helper class '${helperClass}' not in inventory.`,
            );
        }
        const hSig = CSLegacySignatureExtractor.extractHelperSignature(
            found.path, helperClass, helperMethod,
        );
        if (!hSig) {
            return jsonResult(
                {
                    state: 'AWAITING_LLM_RETRY',
                    runId,
                    error: `method '${helperMethod}' not found in ${found.path}`,
                    suggestion: 'Open the file and verify the exact method name (case-sensitive).',
                },
                `Method '${helperMethod}' not found in ${helperClass}.`,
            );
        }
        return jsonResult(
            {
                state: 'RUNNING',
                runId,
                helperClass,
                helperMethod,
                filePath: hSig.filePath,
                actionCount: hSig.actions.length,
                actions: hSig.actions,
            },
            `Expanded ${helperClass}.${helperMethod}: ${hSig.actions.length} leaf action(s).`,
        );
    })
    .build();

// ============================================================================
// csaa_extract_page_fields — Deterministic page-object field extraction
// ============================================================================
// The LLM calls this for each page-object class it intends to generate. Returns
// every @FindBy / By.* field declaration. The generated page object MUST have
// AT LEAST that many @CSGetElement fields — the page-coverage gate in
// csaa_record_translation enforces this floor.

const csaa_extract_page_fields: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('csaa_extract_page_fields')
    .title('CS-AI-Auto-Assist — Extract legacy page-object fields')
    .description(
        'Returns every @FindBy / @FindBys / By.* field on a legacy Java page-object class. ' +
            'The LLM MUST call this for every page class referenced by the @Test methods, then ' +
            'emit a generated page object with AT LEAST as many @CSGetElement fields covering ' +
            'the same locators. The page-coverage gate in csaa_record_translation rejects ' +
            'page objects below the legacy floor.',
    )
    .category('multiagent')
    .stringParam('runId', 'Run ID', { required: true })
    .stringParam('pageClass', 'Java page-object class name', { required: true })
    .handler(async (params: Record<string, unknown>) => {
        const runId = String(params.runId ?? '');
        const ctx = getCtx(runId);
        if (!ctx) return errorResult(`unknown runId '${runId}'`, runId);
        const pageClass = getStr(params, 'pageClass');
        if (!pageClass) return errorResult('pageClass required', runId);

        // Try the cached signature first.
        const sigRaw = ctx.readPhaseArtifact('discover', 'signature.json');
        if (sigRaw) {
            try {
                const sig = JSON.parse(sigRaw) as FullSignature;
                const cached = sig.pages[pageClass];
                if (cached) {
                    return jsonResult(
                        {
                            state: 'RUNNING',
                            runId,
                            pageClass,
                            filePath: cached.filePath,
                            fieldCount: cached.fields.length,
                            methodCount: cached.methods.length,
                            fields: cached.fields,
                            methods: cached.methods,
                        },
                        `Extracted ${pageClass}: ${cached.fields.length} field(s), ${cached.methods.length} method(s).`,
                    );
                }
            } catch { /* fall through */ }
        }

        // Cache miss → resolve and extract.
        const inventoryRaw = ctx.readPhaseArtifact('discover', 'inventory.json');
        if (!inventoryRaw) {
            return errorResult('no inventory — run csaa_discover first', runId);
        }
        const inv = JSON.parse(inventoryRaw) as LegacyInventory;
        const candidates = (inv.pages ?? []).map((p) => ({
            className: path.basename(p as string, path.extname(p as string)),
            path: p as string,
        }));
        const found = candidates.find((x) => x.className === pageClass);
        if (!found) {
            return jsonResult(
                {
                    state: 'AWAITING_LLM_RETRY',
                    runId,
                    error: `page class '${pageClass}' not found in inventory (${candidates.length} pages scanned)`,
                    suggestion: 'Verify the class name. If you suspect OCR drift, check inventory.json for the closest match (e.g. SQL vs OQL).',
                },
                `Page class '${pageClass}' not in inventory.`,
            );
        }
        const pSig = CSLegacySignatureExtractor.extractPageSignature(found.path);
        return jsonResult(
            {
                state: 'RUNNING',
                runId,
                pageClass,
                filePath: pSig.filePath,
                fieldCount: pSig.fields.length,
                methodCount: pSig.methods.length,
                fields: pSig.fields,
                methods: pSig.methods,
            },
            `Extracted ${pageClass}: ${pSig.fields.length} field(s), ${pSig.methods.length} method(s).`,
        );
    })
    .build();

// ============================================================================
// Public registry
// ============================================================================

export const csaaPrimitiveTools: MCPToolDefinition[] = [
    csaa_discover,
    csaa_analyze,
    csaa_record_analysis,
    csaa_append_analysis_scenario,
    csaa_finalize_analysis,
    csaa_plan,
    csaa_translate,
    csaa_record_translation,
    csaa_append_translation_file,
    csaa_finalize_translation,
    csaa_audit,
    csaa_write,
    csaa_execute,
    csaa_verify,
    csaa_publish,
    csaa_query_existing_pages,
    csaa_read_legacy_data,
    csaa_expand_helper,
    csaa_extract_page_fields,
];
