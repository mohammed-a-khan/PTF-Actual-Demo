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
 * Path-like pattern. Accepts both POSIX (/...) and Windows (C:\...) absolute
 * paths plus relative paths starting with ./ or ../.
 */
const PATH_REGEX = /^(?:\.{1,2}\/|\/|[A-Za-z]:[\\/])/;

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
