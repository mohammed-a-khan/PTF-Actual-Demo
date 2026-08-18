/**
 * cs_qa_gov_code_mutation_audit — Inspect a proposed code diff (beforeContent
 * → afterContent for a given filePath) and flag governance-relevant changes:
 *
 *   - Raw Playwright API introduced (page.goto/locator/evaluate/on('dialog'))
 *   - Credentials added (any secret pattern hit in the added-lines set)
 *   - App-source references added (../*-src, /mnt/ paths, absolute local
 *     source-tree paths) — these should never leak into shipped tests
 *   - JSDoc / block comments introduced in generated code (per project
 *     convention: no comments in pages/steps/features)
 *   - Tautological assertions — assertion literal that already appears in the
 *     element locator xpath / alternatives (matches CoverageAuditor rule)
 *   - Tests deleted without replacement — Scenario:/it(/test( count drops
 *     without being replaced elsewhere in the diff
 *   - Framework barrel imports added (should use module-specific import)
 *
 * Returns findings[] with severity 'block' | 'warn' | 'info'. Read-only.
 */

import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import { createLogger } from './_helpers/structured_logger';
import { scanTextForSecrets } from './_helpers/secret_patterns';

const InputSchema = z.object({
    filePath: z.string().min(1).describe('Workspace-relative or absolute path of the file being changed. Used to select file-type-aware rules.'),
    beforeContent: z.string().describe('File contents before the mutation. Pass empty string for a new file.'),
    afterContent: z.string().describe('File contents after the mutation. Pass empty string for a deletion.'),
});

const FindingSchema = z.object({
    kind: z.string(),
    severity: z.enum(['block', 'warn', 'info']),
    line: z.number().optional(),
    detail: z.string(),
    hint: z.string(),
});

const OutputSchema = z.object({
    ok: z.boolean(),
    verdict: z.enum(['proceed', 'block', 'proceed-with-warnings']),
    filePath: z.string(),
    fileKind: z.enum(['page', 'steps', 'feature', 'data', 'test', 'config', 'other']),
    beforeLineCount: z.number(),
    afterLineCount: z.number(),
    addedLines: z.number(),
    removedLines: z.number(),
    findings: z.array(FindingSchema),
    note: z.string().optional(),
});

const RAW_PW_RE = /\bpage\.(goto|locator|\$\$?|evaluate|click|fill|check|uncheck|selectOption|hover|dblclick|type|press|dragAndDrop)\s*\(/;
const RAW_DIALOG_RE = /\bpage\.on\s*\(\s*['"]dialog['"]/;
// Detects a relative import that climbs out of the test project and reaches into an
// application source tree — `../../../../some-service/src/validator.js`.
//
// Deliberately project-agnostic: it matches the SHAPE of an app-source path (a named
// sibling tree containing src/, apps/ or packages/) rather than any one product's
// directory prefix, so the rule needs no per-client tuning. An ordinary intra-project
// import like `../../src/pages/LoginPage` is NOT matched — there is no sibling tree
// between the climb and the src directory.
const APP_SOURCE_RE =
    /(?:['"])(?:\.\.\/){2,}[^'"]*(?:\b(?:-app-code|-app-src|-src)|[\\/](?:src|apps?|packages?)[\\/])/i;
const ABS_LOCAL_SOURCE_RE = /(?:['"])[\/A-Za-z]:?[\\/](?:home|Users|mnt|opt)[\\/][^'"]{5,}\b/;
const BARREL_IMPORT_RE = /from ['"]@[a-z0-9._-]+\/cs-playwright-test-framework['"]/;
const BLOCK_COMMENT_RE = /^\s*\/\*\*/;
const LINE_COMMENT_RE = /^\s*\/\/[^!]/;
// Match any string literal appearing on an assertion/expect line. The first
// arg to assertX() is typically an expression that may contain nested parens
// or method calls — so instead of parsing balanced parens, we operate at the
// line level and pull out every string literal on a line that carries an
// assertion verb.
const ASSERT_LINE_RE = /\b(?:assert(?:True|False|Equal|Equals|Contains|Visible|Match|Matches)?|expect)\s*\(/i;
const STRING_LITERAL_RE = /['"]([^'"\n]{3,120})['"]/g;

function classifyFile(filePath: string): z.infer<typeof OutputSchema>['fileKind'] {
    if (/\.feature$/i.test(filePath)) return 'feature';
    if (/\.steps?\.ts$/i.test(filePath) || /Steps\.ts$/i.test(filePath)) return 'steps';
    if (/[\\/]pages?[\\/].*\.ts$/i.test(filePath) || /Page\.ts$/i.test(filePath)) return 'page';
    if (/[\\/]data[\\/].*\.(json|ya?ml|csv)$/i.test(filePath)) return 'data';
    if (/\.spec\.(ts|js|tsx)$/i.test(filePath) || /\.test\.(ts|js|tsx)$/i.test(filePath)) return 'test';
    if (/\.(env|json|ya?ml|properties)$/i.test(filePath)) return 'config';
    return 'other';
}

export interface AddedLineDiff { lineNumber: number; text: string }
export interface RemovedLineDiff { lineNumber: number; text: string }
export interface ModifiedLineDiff { lineNumber: number; before: string; after: string }
export interface StructuredDiff {
    /** Compat shim — the raw added-line texts, in after-file order. Preserves duplicate lines. */
    added: string[];
    /** Compat shim — the raw removed-line texts, in before-file order. Preserves duplicate lines. */
    removed: string[];
    addedLines: AddedLineDiff[];
    removedLines: RemovedLineDiff[];
    /** Adjacent add/remove pairs collapsed into a modified-line record. */
    modifiedLines: ModifiedLineDiff[];
}

/**
 * Compute a real line-based diff via longest-common-subsequence. Preserves
 * duplicate-line multiplicity (a Set-based `not in` check loses that entirely
 * — a repeated line only counted once).
 *
 * Returns per-line-number added / removed / modified records so callers can
 * report the actual line in the after file, not the first occurrence of a
 * text match anywhere in the file (which was `indexOf`-based and wrong for
 * common lines like blank lines or closing braces).
 */
export function computeDiff(before: string, after: string): StructuredDiff {
    const A = before.split(/\r?\n/);
    const B = after.split(/\r?\n/);
    // Standard LCS DP table over lines. O(n·m) memory is fine for files that
    // fit in the audit tool's inputs (typically <10k lines each).
    const n = A.length, m = B.length;
    // Fast path — one side empty.
    if (n === 0) {
        const addedLines = B.map((text, i) => ({ lineNumber: i + 1, text }));
        return { added: B.slice(), removed: [], addedLines, removedLines: [], modifiedLines: [] };
    }
    if (m === 0) {
        const removedLines = A.map((text, i) => ({ lineNumber: i + 1, text }));
        return { added: [], removed: A.slice(), addedLines: [], removedLines, modifiedLines: [] };
    }
    // dp[i][j] = LCS length for A[i..], B[j..]. Build reversed so the walk is
    // straightforward left-to-right.
    const dp: number[][] = new Array(n + 1);
    for (let i = 0; i <= n; i++) dp[i] = new Array(m + 1).fill(0);
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            if (A[i] === B[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
            else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    // Walk in order — emit removed/added lines with their actual line numbers.
    const addedLines: AddedLineDiff[] = [];
    const removedLines: RemovedLineDiff[] = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
        if (A[i] === B[j]) { i++; j++; continue; }
        if (dp[i + 1][j] >= dp[i][j + 1]) {
            removedLines.push({ lineNumber: i + 1, text: A[i] });
            i++;
        } else {
            addedLines.push({ lineNumber: j + 1, text: B[j] });
            j++;
        }
    }
    while (i < n) { removedLines.push({ lineNumber: i + 1, text: A[i] }); i++; }
    while (j < m) { addedLines.push({ lineNumber: j + 1, text: B[j] }); j++; }
    // Collapse adjacent removed+added at the same before/after line into
    // "modified" records — helps callers report a single hunk per changed line.
    const modifiedLines: ModifiedLineDiff[] = [];
    const remByLine = new Map<number, string>();
    for (const r of removedLines) remByLine.set(r.lineNumber, r.text);
    for (const a of addedLines) {
        if (remByLine.has(a.lineNumber)) {
            modifiedLines.push({ lineNumber: a.lineNumber, before: remByLine.get(a.lineNumber)!, after: a.text });
        }
    }
    return {
        added: addedLines.map((a) => a.text),
        removed: removedLines.map((r) => r.text),
        addedLines,
        removedLines,
        modifiedLines,
    };
}

function findAllTestKeywords(text: string): number {
    let count = 0;
    for (const re of [/^\s*Scenario:/gm, /\bit\s*\(/g, /\btest\s*\(/g, /\bScenario Outline:/gm]) {
        const m = text.match(re);
        if (m) count += m.length;
    }
    return count;
}

registerPrimitive({
    name: 'cs_qa_gov_code_mutation_audit',
    description: 'Governance hook — inspect a proposed code diff (beforeContent + afterContent + filePath) and flag governance-relevant introductions: raw Playwright API, credentials added, app-source references added, JSDoc/comments in generated code, tautological assertions, tests deleted without replacement, framework barrel imports. Read-only. Returns findings with severity + verdict (proceed | proceed-with-warnings | block). Inputs: {filePath, beforeContent, afterContent}. Example: audit a proposed edit to a page-object before writing it back.',
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    run: async (ctx, input) => {
        const log = createLogger(ctx.invocationId, 'cs_qa_gov_code_mutation_audit', { workspaceRoot: ctx.workspaceRoot });
        const fileKind = classifyFile(input.filePath);
        const findings: Array<z.infer<typeof FindingSchema>> = [];
        const diff = computeDiff(input.beforeContent, input.afterContent);
        const added = diff.added;
        const removed = diff.removed;
        const beforeLines = input.beforeContent.split(/\r?\n/);
        const afterLines = input.afterContent.split(/\r?\n/);
        const beforeText = input.beforeContent;
        const afterText = input.afterContent;
        const addedText = added.join('\n');

        // Callers walk `diff.addedLines` directly (record contains both text +
        // real line number). This keeps duplicate-line multiplicity — the old
        // `afterLines.indexOf(needle)` returned the FIRST occurrence for every
        // caller, so identical lines all pointed at the same wrong line.

        // 1. Raw Playwright — treat as block on page/steps/test files. Only surface
        //    lines that were ADDED (not carried over from before) to avoid noise.
        if (['page', 'steps', 'test'].includes(fileKind)) {
            for (const rec of diff.addedLines) {
                const ln = rec.text;
                if (RAW_PW_RE.test(ln) && !RAW_PW_RE.test(beforeText)) {
                    findings.push({
                        kind: 'raw-playwright-added',
                        severity: 'block',
                        line: rec.lineNumber,
                        detail: `Raw Playwright API added: ${ln.trim().slice(0, 120)}`,
                        hint: 'Use framework wrapper (CSBasePage.navigate / @CSGetElement / page-object method). Add missing wrappers to the framework rather than hand-patching the consumer.',
                    });
                }
                if (RAW_DIALOG_RE.test(ln)) {
                    findings.push({
                        kind: 'raw-dialog-handler-added',
                        severity: 'block',
                        line: rec.lineNumber,
                        detail: `Raw page.on("dialog") handler added: ${ln.trim().slice(0, 120)}`,
                        hint: 'Call this.acceptNextDialog() from the page-object; never register page.on() from a step/test.',
                    });
                }
            }
        }

        // 2. Credentials added — run the shared secret scanner over the added text
        //    only. Anything that survives is a governance block.
        const secretHits = scanTextForSecrets(input.filePath, addedText);
        for (const h of secretHits) {
            findings.push({
                kind: `secret-added:${h.kind}`,
                severity: h.severity === 'error' ? 'block' : 'warn',
                detail: `${h.description} — matched "${h.redactedMatch}"`,
                hint: 'Move the secret to ~/.cs-qa/ado-config.json (encrypted PAT) or a per-env config file that is git-ignored. Never commit raw tokens.',
            });
        }

        // 3. App-source refs added.
        for (const rec of diff.addedLines) {
            const ln = rec.text;
            if (APP_SOURCE_RE.test(ln) || ABS_LOCAL_SOURCE_RE.test(ln)) {
                findings.push({
                    kind: 'app-source-ref-added',
                    severity: 'block',
                    line: rec.lineNumber,
                    detail: `App-source reference added: ${ln.trim().slice(0, 120)}`,
                    hint: 'Test artefacts must not link back into local app-source trees. Assert only what the UI/API contract says.',
                });
            }
        }

        // 4. JSDoc/comments introduced in generated code (page/steps/feature/data).
        if (['page', 'steps', 'feature', 'data'].includes(fileKind)) {
            for (const rec of diff.addedLines) {
                const ln = rec.text;
                if (BLOCK_COMMENT_RE.test(ln)) {
                    findings.push({
                        kind: 'block-comment-added',
                        severity: 'warn',
                        line: rec.lineNumber,
                        detail: 'JSDoc / block comment introduced in generated code',
                        hint: 'Names document intent. Remove the comment or move the explanation into the test-plan artefact.',
                    });
                } else if (LINE_COMMENT_RE.test(ln) && fileKind !== 'feature') {
                    findings.push({
                        kind: 'line-comment-added',
                        severity: 'info',
                        line: rec.lineNumber,
                        detail: 'Line comment introduced in generated code',
                        hint: 'Prefer refactoring to make intent clear rather than commenting.',
                    });
                }
            }
        }

        // 5. Tautological assertions — a string literal used on an assertion
        //    line whose value ALSO appears within a locator context (xpath /
        //    css / text= / alternativeLocators list / href / selector) in the
        //    same file's after content. Window-based check (80 chars either
        //    side of a locator keyword) so array syntax and key=value strings
        //    are both caught.
        const seenLiteralsForTaut = new Set<string>();
        for (const rec of diff.addedLines) {
            const ln = rec.text;
            if (!ASSERT_LINE_RE.test(ln)) continue;
            STRING_LITERAL_RE.lastIndex = 0;
            let m2: RegExpExecArray | null;
            while ((m2 = STRING_LITERAL_RE.exec(ln)) !== null) {
                const literal = m2[1];
                if (literal.length < 3) continue;
                if (seenLiteralsForTaut.has(literal)) continue;
                seenLiteralsForTaut.add(literal);
                const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const locatorRe = new RegExp(`(xpath|css|text|alternativeLocators|href|selector|\\/\\/)[\\s\\S]{0,80}${escaped}`, 'i');
                const nearLocatorRe = new RegExp(`${escaped}[\\s\\S]{0,80}(xpath|css|text|alternativeLocators|href|selector)`, 'i');
                if (locatorRe.test(afterText) || nearLocatorRe.test(afterText)) {
                    findings.push({
                        kind: 'tautological-assertion-added',
                        severity: 'warn',
                        detail: `Assertion literal "${literal}" also appears in the element's locator — the assertion is tautological.`,
                        hint: 'Assert something the locator did NOT already guarantee (e.g. persisted value round-trip, a downstream field, a rendered class change).',
                    });
                }
            }
        }

        // 6. Tests deleted without replacement.
        const beforeTests = findAllTestKeywords(beforeText);
        const afterTests = findAllTestKeywords(afterText);
        if (beforeTests > 0 && afterTests < beforeTests) {
            findings.push({
                kind: 'tests-removed',
                severity: 'block',
                detail: `Test-keyword count dropped from ${beforeTests} to ${afterTests} — ${beforeTests - afterTests} test(s) removed without replacement.`,
                hint: 'If a test is being replaced, add the replacement in the same diff. Never silently remove coverage.',
            });
        }

        // 7. Barrel-import added.
        for (const rec of diff.addedLines) {
            const ln = rec.text;
            if (BARREL_IMPORT_RE.test(ln)) {
                findings.push({
                    kind: 'barrel-import-added',
                    severity: 'warn',
                    line: rec.lineNumber,
                    detail: `Barrel import added: ${ln.trim().slice(0, 120)}`,
                    hint: 'Import from the module-specific entry point (/core, /element, /bdd, /reporting, /assertions, /utilities, /database-utils, /api). Barrel imports drag the whole framework into the bundle.',
                });
            }
        }

        const blocks = findings.filter((f) => f.severity === 'block').length;
        const warns = findings.filter((f) => f.severity === 'warn').length;
        const verdict: z.infer<typeof OutputSchema>['verdict'] = blocks > 0 ? 'block' : (warns > 0 ? 'proceed-with-warnings' : 'proceed');
        log.info('code mutation audit complete', { file: input.filePath, verdict, blocks, warns });
        return {
            ok: verdict !== 'block',
            verdict,
            filePath: input.filePath,
            fileKind,
            beforeLineCount: beforeLines.length,
            afterLineCount: afterLines.length,
            addedLines: added.length,
            removedLines: removed.length,
            findings,
            note: verdict === 'block'
                ? `${blocks} block-severity finding(s) — do NOT apply this diff until resolved.`
                : verdict === 'proceed-with-warnings'
                    ? `${warns} warning(s) — proceed only if intentional.`
                    : `Diff clean — no governance findings.`,
        };
    },
});
