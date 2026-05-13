/**
 * Agentic Test Platform — Intent Router
 *
 * Deterministic-first classifier that maps raw user input to one of the
 * AgentRunMode values. Phase 1 ships only the deterministic regex/heuristic
 * layer; LLM-based ambiguity resolution is reserved for Phase 2.
 *
 * Privacy-by-design: no domain or organization patterns are baked in. The
 * router only inspects the surface form of the input.
 *
 * @module agent-platform/CSIntentRouter
 */

import * as fs from 'fs';
import * as path from 'path';
import { AgentRunMode, ClassifiedInput } from './types';

// ============================================================================
// Pattern Catalog (deterministic)
// ============================================================================

/**
 * URL pattern. Matches http/https URLs with optional path and query string.
 */
const URL_REGEX = /^https?:\/\/[^\s]+$/i;

/**
 * Pure positive integer (e.g. an Azure DevOps work item / suite / plan id).
 * Cannot disambiguate which entity type it refers to without context.
 */
const PURE_DIGITS_REGEX = /^\d{1,12}$/;

/**
 * Prefixed identifier patterns. The platform supports the following
 * disambiguation tokens at the start of input strings:
 *   TC<digits>  → ado_test_case_id
 *   TS<digits>  → ado_test_suite_id
 *   TP<digits>  → ado_test_plan_id
 */
const PREFIXED_TC_REGEX = /^TC[#\-_]?(\d+)$/i;
const PREFIXED_TS_REGEX = /^TS[#\-_]?(\d+)$/i;
const PREFIXED_TP_REGEX = /^TP[#\-_]?(\d+)$/i;

/**
 * Path-like pattern. Accepts:
 *   - POSIX absolute       /foo/bar
 *   - POSIX relative       ./foo, ../foo
 *   - Windows absolute     C:\foo, C:/foo
 *   - Windows relative     .\foo, ..\foo
 *   - Windows UNC          \\server\share\foo
 */
const PATH_REGEX = /^(?:\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/]|\\\\)/;

/**
 * File extension classification table. Used to differentiate a generic
 * document from source code or legacy test code when the input is a path.
 */
const SOURCE_CODE_EXTS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.java', '.kt', '.scala',
    '.cs', '.fs',
    '.py', '.rb', '.go', '.rs', '.php',
    '.cpp', '.cc', '.c', '.h', '.hpp',
]);

const DOCUMENT_EXTS = new Set([
    '.md', '.txt', '.pdf', '.docx', '.doc', '.rtf',
    '.html', '.htm', '.adoc', '.rst',
]);

const LEGACY_TEST_HINTS = [
    /@Test\b/,
    /\[Test\]/,
    /\bTestNG\b/i,
    /\bJUnit\b/i,
    /\bNUnit\b/i,
    /\bxUnit\b/i,
    /\bdescribe\(.+,.+function/,
    /\bit\(.+,.+function/,
];

// ============================================================================
// CSIntentRouter
// ============================================================================

/**
 * Static utility class that classifies free-form user input into one of the
 * supported AgentRunMode values. Intentionally side-effect free (apart from
 * filesystem stat for path inputs) so it can be invoked from any handler.
 */
export class CSIntentRouter {
    /**
     * Classify the given raw input. Always returns a result; ambiguous
     * inputs surface as `mode='unknown'` with low confidence so the caller
     * can ask a clarifying question.
     */
    public static classify(rawInput: string): ClassifiedInput {
        const trimmed = (rawInput ?? '').trim();
        if (trimmed.length === 0) {
            return CSIntentRouter.makeResult('unknown', 0, {}, rawInput);
        }

        // 0. Structured-prompt extraction. Users write multi-line prompts
        //    like "Migrate this:\nSource: path/to/X.java\nProject: foo".
        //    Pull out every `<label>: <value>` line we recognise BEFORE
        //    falling through to single-line classification. This avoids
        //    misclassifying a multi-line prompt with a Source: path as
        //    natural_language_chat just because the whole blob isn't a path.
        const structured = CSIntentRouter.parseStructuredFields(trimmed);
        const structuredPath = structured.path || structured.source || structured.file;
        if (structuredPath && (PATH_REGEX.test(structuredPath) || CSIntentRouter.looksLikePath(structuredPath))) {
            const classified = CSIntentRouter.classifyPath(structuredPath, rawInput);
            // Merge other structured fields (projectName, moduleName,
            // featureName, environments, etc.) so clarification doesn't
            // re-ask for what the user already supplied.
            classified.extractedFields = {
                ...classified.extractedFields,
                ...structured,
            };
            return classified;
        }
        // Relaxed structured-prompt fallback. When the path on the `Source:`
        // line failed strict validation (e.g. UNC with unusual escaping,
        // path with spaces and no leading `./`, or a bare filename) BUT the
        // surrounding prompt clearly signals a legacy migration intake
        // (project + module fields, or migration keywords), route to
        // legacy_test_code instead of falling all the way through to
        // natural_language_chat. NL-chat would force the user to re-supply
        // a `feature:` Tier-1 field even though they already gave us a
        // structured legacy-migration brief. Downstream tools surface a
        // clear "could not read path" error if the path is genuinely bad.
        if (structuredPath && CSIntentRouter.hasMigrationSignals(structured, trimmed)) {
            const ext = path.extname(structuredPath).toLowerCase();
            const mode: AgentRunMode = SOURCE_CODE_EXTS.has(ext)
                ? 'legacy_test_code'
                : 'source_code_path';
            return CSIntentRouter.makeResult(
                mode,
                0.6,
                { ...structured, path: structuredPath, ext },
                rawInput,
            );
        }
        const structuredUrl = structured.url || structured.appUrl;
        if (structuredUrl && URL_REGEX.test(structuredUrl)) {
            return CSIntentRouter.makeResult(
                'app_url',
                0.95,
                { ...structured, url: structuredUrl, appUrl: structuredUrl },
                rawInput,
            );
        }
        const structuredTc = structured.tc || structured.testCase || structured.testCaseId;
        if (structuredTc && /^\d+$/.test(structuredTc)) {
            return CSIntentRouter.makeResult(
                'ado_test_case_id',
                0.99,
                { ...structured, id: structuredTc },
                rawInput,
            );
        }
        const structuredTs = structured.ts || structured.testSuite || structured.testSuiteId;
        if (structuredTs && /^\d+$/.test(structuredTs)) {
            return CSIntentRouter.makeResult(
                'ado_test_suite_id',
                0.99,
                { ...structured, id: structuredTs },
                rawInput,
            );
        }
        const structuredTp = structured.tp || structured.testPlan || structured.testPlanId;
        if (structuredTp && /^\d+$/.test(structuredTp)) {
            return CSIntentRouter.makeResult(
                'ado_test_plan_id',
                0.99,
                { ...structured, id: structuredTp },
                rawInput,
            );
        }

        // 1. Explicit prefixes — high confidence.
        const tcMatch = trimmed.match(PREFIXED_TC_REGEX);
        if (tcMatch) {
            return CSIntentRouter.makeResult(
                'ado_test_case_id',
                0.99,
                { id: tcMatch[1] },
                rawInput,
            );
        }
        const tsMatch = trimmed.match(PREFIXED_TS_REGEX);
        if (tsMatch) {
            return CSIntentRouter.makeResult(
                'ado_test_suite_id',
                0.99,
                { id: tsMatch[1] },
                rawInput,
            );
        }
        const tpMatch = trimmed.match(PREFIXED_TP_REGEX);
        if (tpMatch) {
            return CSIntentRouter.makeResult(
                'ado_test_plan_id',
                0.99,
                { id: tpMatch[1] },
                rawInput,
            );
        }

        // 2. URL — high confidence.
        if (URL_REGEX.test(trimmed)) {
            return CSIntentRouter.makeResult(
                'app_url',
                0.95,
                // Mirror the URL into the universal `appUrl` clarification
                // field so CSClarificationAgent doesn't re-ask for it.
                { url: trimmed, appUrl: trimmed },
                rawInput,
            );
        }

        // 3. Pure digits — ambiguous between TC / TS / TP. Default to
        //    test case but mark low confidence so the clarification agent
        //    asks "is this a case, suite, or plan id?" Phase 2: use LLM
        //    intent classification with prior conversation context.
        if (PURE_DIGITS_REGEX.test(trimmed)) {
            return CSIntentRouter.makeResult(
                'ado_test_case_id',
                0.4,
                { id: trimmed, ambiguous: 'true' },
                rawInput,
            );
        }

        // 4. Path-like — peek at the file to refine.
        if (PATH_REGEX.test(trimmed) || CSIntentRouter.looksLikePath(trimmed)) {
            return CSIntentRouter.classifyPath(trimmed, rawInput);
        }

        // 5. Otherwise — natural language chat.
        return CSIntentRouter.makeResult(
            'natural_language_chat',
            0.7,
            { text: trimmed },
            rawInput,
        );
    }

    // ========================================================================
    // Path-aware classification
    // ========================================================================

    /**
     * Differentiate document_path / source_code_path / legacy_test_code by
     * extension and a quick content sniff. If the file does not exist on
     * disk, fall back to extension-only classification at reduced
     * confidence.
     */
    private static classifyPath(p: string, rawInput: string): ClassifiedInput {
        const ext = path.extname(p).toLowerCase();
        const exists = CSIntentRouter.safeExists(p);

        if (DOCUMENT_EXTS.has(ext)) {
            return CSIntentRouter.makeResult(
                'document_path',
                exists ? 0.9 : 0.7,
                { path: p, ext },
                rawInput,
            );
        }

        if (SOURCE_CODE_EXTS.has(ext)) {
            // Sniff the file for legacy test hints. If found → legacy_test_code.
            if (exists) {
                const sample = CSIntentRouter.safeReadHead(p, 8 * 1024);
                if (sample !== null && CSIntentRouter.looksLikeLegacyTest(sample)) {
                    return CSIntentRouter.makeResult(
                        'legacy_test_code',
                        0.9,
                        { path: p, ext },
                        rawInput,
                    );
                }
            }
            return CSIntentRouter.makeResult(
                'source_code_path',
                exists ? 0.85 : 0.6,
                { path: p, ext },
                rawInput,
            );
        }

        // Path-shaped but no matching extension — low confidence document.
        return CSIntentRouter.makeResult(
            'document_path',
            exists ? 0.5 : 0.3,
            { path: p, ext },
            rawInput,
        );
    }

    /**
     * Heuristic for path-likeness when neither absolute nor explicit
     * relative prefix is present (e.g. "src/foo/bar.ts"). True iff the
     * string contains a path separator and a known file extension.
     */
    private static looksLikePath(s: string): boolean {
        if (!/[\\/]/.test(s)) return false;
        const ext = path.extname(s).toLowerCase();
        return SOURCE_CODE_EXTS.has(ext) || DOCUMENT_EXTS.has(ext);
    }

    /**
     * Parse a multi-line user prompt for `<label>: <value>` and `<label>=<value>`
     * lines. Returns a flat record of normalised field names → values.
     *
     * Recognised labels (case-insensitive, trimmed):
     *   path / source / file                  → path
     *   url / appurl / app_url                → appUrl, url
     *   project / projectname / project_name  → projectName
     *   module / modulename / module_name     → moduleName
     *   feature / featurename / feature_name  → featureName
     *   environments / environment / envs / env → environments
     *   workspaceroot / workspace             → workspaceRoot
     *   projectroot                           → projectRoot
     *   tc / testcase / testcaseid            → tc (digits only)
     *   ts / testsuite / testsuiteid          → ts (digits only)
     *   tp / testplan / testplanid            → tp (digits only)
     *   targetsurface                         → targetSurface
     *   sectionfocus                          → sectionFocus
     *   entryflow                             → entryFlow
     *   username                              → username
     *   passwordconfigkey / password_key      → passwordConfigKey
     *   navigationsteps / navsteps            → navigationSteps
     *   adopat / pat                          → adoPat
     *   adoorganization / organization / org  → adoOrganization
     *   adoproject                            → adoProject
     *
     * Values are taken verbatim from the rest of the line (after the colon).
     * Surrounding whitespace and quotes are stripped. Markdown bullets
     * (`- key: value`, `* key: value`) and bold markers (`**key**: value`)
     * are tolerated.
     */
    private static parseStructuredFields(text: string): Record<string, string> {
        const out: Record<string, string> = {};
        if (!text) return out;
        const labelMap: Record<string, string[]> = {
            path: ['path', 'source', 'file', 'sourcefile'],
            appUrl: ['url', 'appurl', 'app_url', 'application_url', 'applicationurl'],
            projectName: ['project', 'projectname', 'project_name'],
            moduleName: ['module', 'modulename', 'module_name'],
            featureName: ['feature', 'featurename', 'feature_name'],
            environments: ['environments', 'environment', 'envs', 'env'],
            workspaceRoot: ['workspaceroot', 'workspace_root', 'workspace'],
            projectRoot: ['projectroot', 'project_root'],
            tc: ['tc', 'testcase', 'testcaseid', 'test_case_id'],
            ts: ['ts', 'testsuite', 'testsuiteid', 'test_suite_id'],
            tp: ['tp', 'testplan', 'testplanid', 'test_plan_id'],
            targetSurface: ['targetsurface', 'target_surface'],
            sectionFocus: ['sectionfocus', 'section_focus', 'section'],
            entryFlow: ['entryflow', 'entry_flow', 'flow'],
            username: ['username', 'user'],
            passwordConfigKey: ['passwordconfigkey', 'password_config_key', 'password_key'],
            navigationSteps: ['navigationsteps', 'navigation_steps', 'navsteps', 'nav_steps'],
            adoPat: ['adopat', 'ado_pat', 'pat'],
            adoOrganization: ['adoorganization', 'ado_organization', 'organization', 'org'],
            adoProject: ['adoproject', 'ado_project'],
            requireLiveApp: ['requireliveapp', 'require_live_app'],
            overwriteExisting: ['overwriteexisting', 'overwrite_existing', 'overwrite'],
            skipDependencyCheck: ['skipdependencycheck', 'skip_dependency_check', 'skipdeps'],
        };
        // Reverse lookup: alias → canonical
        const aliasToCanonical: Record<string, string> = {};
        for (const [canon, aliases] of Object.entries(labelMap)) {
            for (const a of aliases) aliasToCanonical[a] = canon;
        }
        // Strip leading: blockquote `> `, bullet `- ` / `* `, optional **bold**
        // wrapping the label. Then capture `<label>: <value>` or `<label>=<value>`.
        const lineRe = /^\s*(?:>\s*)*(?:[-*]\s+)?(?:\*\*)?([A-Za-z][A-Za-z0-9_ ]*?)(?:\*\*)?\s*[:=]\s*(.+?)\s*$/;
        for (const rawLine of text.split(/\r?\n/)) {
            const m = rawLine.match(lineRe);
            if (!m) continue;
            const labelKey = m[1].toLowerCase().replace(/\s+/g, '');
            const canonical = aliasToCanonical[labelKey];
            if (!canonical) continue;
            let value = m[2].trim();
            // Strip leading `**` if the label was wrapped like `**Label:**`
            // — the closing `**` ends up at the start of the value.
            value = value.replace(/^\*\*\s*/, '').replace(/\s*\*\*$/, '').trim();
            // Strip surrounding quotes
            if (
                (value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'"))
            ) {
                value = value.slice(1, -1).trim();
            }
            if (!value) continue;
            // First-wins for repeated keys
            if (out[canonical] === undefined) out[canonical] = value;
        }
        return out;
    }

    /**
     * Return true iff the structured prompt has enough surrounding context
     * to be confidently treated as a legacy-migration intake even when the
     * `Source:`/`path:` value itself failed strict path validation.
     *
     * Two ways to qualify:
     *   1. At least one structured field naming the migration target
     *      (projectName or moduleName) was supplied.
     *   2. The raw input contains explicit migration vocabulary
     *      (migrate / migration / legacy / selenium / testng / junit / cucumber).
     */
    private static hasMigrationSignals(
        structured: Record<string, string>,
        raw: string,
    ): boolean {
        if (structured.projectName || structured.moduleName) return true;
        return /\b(migrate|migration|legacy|selenium|testng|junit|cucumber)\b/i.test(raw);
    }

    /**
     * Return true iff the head of a source file shows hallmarks of a
     * legacy unit/integration test (annotations, framework imports, etc).
     */
    private static looksLikeLegacyTest(sample: string): boolean {
        for (const hint of LEGACY_TEST_HINTS) {
            if (hint.test(sample)) return true;
        }
        return false;
    }

    // ========================================================================
    // Helpers
    // ========================================================================

    /**
     * Construct a ClassifiedInput record with the given fields.
     */
    private static makeResult(
        mode: AgentRunMode,
        confidence: number,
        extractedFields: Record<string, string>,
        rawInput: string,
    ): ClassifiedInput {
        return { mode, confidence, extractedFields, rawInput };
    }

    /**
     * fs.existsSync that swallows errors (e.g. permission denied).
     */
    private static safeExists(p: string): boolean {
        try {
            return fs.existsSync(p) && fs.statSync(p).isFile();
        } catch {
            return false;
        }
    }

    /**
     * Read up to `maxBytes` from the head of a file. Returns null on any
     * error (missing, unreadable, binary).
     */
    private static safeReadHead(p: string, maxBytes: number): string | null {
        try {
            const fd = fs.openSync(p, 'r');
            try {
                const buf = Buffer.alloc(maxBytes);
                const bytesRead = fs.readSync(fd, buf, 0, maxBytes, 0);
                return buf.slice(0, bytesRead).toString('utf-8');
            } finally {
                fs.closeSync(fd);
            }
        } catch {
            return null;
        }
    }
}
