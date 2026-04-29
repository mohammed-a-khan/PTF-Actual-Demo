/**
 * PTF-ADO MCP Equivalence Tools
 *
 *   - verify_semantic_equivalence    Compare Java test assertions against the
 *                                    migrated TS scenario's Then-steps + CSAssert
 *                                    calls + framework reporter fails. Flag
 *                                    assertion drops / adds / mismatches.
 *
 * Pre-heuristic V1: extract subject-predicate pairs from each side via regex,
 * match by subject similarity. V1 reliably catches clear assertion drops
 * (Java has 7 assertEquals, TS has 3); V1 may produce false-positive "missing"
 * when the TS assertion is phrased very differently from the Java one — user
 * confirms those interactively.
 *
 * @module CSMCPEquivalenceTools
 */

import { MCPToolDefinition, MCPToolResult } from '../../types/CSMCPTypes';
import { defineTool, CSMCPToolRegistry } from '../../CSMCPToolRegistry';

// ============================================================================
// Helpers
// ============================================================================

function createJsonResult(data: unknown): MCPToolResult {
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function createErrorResult(message: string): MCPToolResult {
    return { content: [{ type: 'text', text: message }], isError: true };
}

interface Assertion {
    subject: string;         // what is being verified (e.g., "user status", "welcomeHeader")
    predicate: string;       // how (e.g., "equals ACTIVE", "is visible", "not null")
    expected?: string;       // the expected value, if applicable
    form: string;            // raw source line — for debugging
    origin: 'java' | 'ts';
}

// ============================================================================
// Java extractors
// ============================================================================

function normaliseIdentifier(s: string): string {
    return s.replace(/_+/g, '').replace(/([a-z])([A-Z])/g, '$1$2').toLowerCase().trim();
}

function extractJavaAssertions(content: string): Assertion[] {
    const out: Assertion[] = [];
    // Track character ranges already consumed by a top-level assertion so we
    // don't double-count inner expressions (e.g., assertTrue(x.isDisplayed())
    // should NOT also extract the inner isDisplayed() as a separate assertion).
    const consumed: Array<{ start: number; end: number }> = [];
    const isInsideConsumed = (start: number, end: number) =>
        consumed.some(r => start >= r.start && start < r.end + 20);
    // +20 tolerance because outer assertTrue(x.isDisplayed()) regex stops at
    // the inner `)` but isDisplayed() match includes the closing `)` a couple
    // of chars later. Keeps the dedupe honest without missing legitimate
    // outer-assertion neighbours.
    const consume = (start: number, end: number) => consumed.push({ start, end });

    // assertEquals(expected, actual, [message]) — both positional orders seen in wild
    const re1 = /assertEquals\s*\(\s*(?:"([^"]*)"|([\w.$()[\]\s]+))\s*,\s*(?:"([^"]*)"|([\w.$()[\]\s]+))/g;
    let m: RegExpExecArray | null;
    while ((m = re1.exec(content)) !== null) {
        const expectedLit = m[1];
        const expectedExpr = m[2];
        const actualLit = m[3];
        const actualExpr = m[4];
        const subject = actualExpr?.trim() ?? actualLit ?? '';
        const expected = expectedLit ?? expectedExpr?.trim() ?? '';
        out.push({
            subject: extractSubjectFromExpr(subject) || subject,
            predicate: `equals ${expected || '<unknown>'}`,
            expected,
            form: m[0],
            origin: 'java',
        });
        consume(m.index, m.index + m[0].length);
    }

    // assertTrue(cond) / assertFalse(cond)
    const re2 = /assert(True|False)\s*\(\s*([^,)]+)/g;
    while ((m = re2.exec(content)) !== null) {
        const not = m[1] === 'False' ? 'not ' : '';
        const arg = m[2];
        // Recognise common visibility / boolean getter patterns inside assertTrue
        // so we emit clean subject + predicate (rather than a literal "is true ()" string).
        const isXxx = arg.match(/(\w+)\.is(\w+)\s*\(?/);
        if (isXxx) {
            const nice = isXxx[2].replace(/([A-Z])/g, ' $1').trim().toLowerCase();
            out.push({
                subject: isXxx[1],
                predicate: `${not}is ${nice}`,
                form: m[0],
                origin: 'java',
            });
        } else {
            out.push({
                subject: extractSubjectFromExpr(arg) || arg.trim(),
                predicate: `${not}is true`,
                form: m[0],
                origin: 'java',
            });
        }
        consume(m.index, m.index + m[0].length);
    }

    // assertNotNull / assertNull
    const re3 = /assert(NotNull|Null)\s*\(\s*([^,)]+)/g;
    while ((m = re3.exec(content)) !== null) {
        const neg = m[1] === 'NotNull' ? 'is not null' : 'is null';
        out.push({
            subject: extractSubjectFromExpr(m[2]) || m[2].trim(),
            predicate: neg,
            form: m[0],
            origin: 'java',
        });
        consume(m.index, m.index + m[0].length);
    }

    // element.isDisplayed() / isEnabled() visibility assertions — skip if already
    // consumed by an outer assertTrue/False / assertEquals call.
    const re4 = /([\w.()[\]]+)\.isDisplayed\s*\(\s*\)/g;
    while ((m = re4.exec(content)) !== null) {
        if (isInsideConsumed(m.index, m.index + m[0].length)) continue;
        const subj = extractSubjectFromExpr(m[1]) || m[1].trim();
        out.push({
            subject: subj,
            predicate: 'is visible',
            form: m[0],
            origin: 'java',
        });
        consume(m.index, m.index + m[0].length);
    }

    // getText().equals("X") / .contains("X")
    const re5 = /(\w+)\.getText\s*\(\s*\)\s*\.\s*(equals|contains)\s*\(\s*"([^"]+)"/g;
    while ((m = re5.exec(content)) !== null) {
        if (isInsideConsumed(m.index, m.index + m[0].length)) continue;
        out.push({
            subject: m[1],
            predicate: `${m[2]} "${m[3]}"`,
            expected: m[3],
            form: m[0],
            origin: 'java',
        });
        consume(m.index, m.index + m[0].length);
    }

    // AssertJ: assertThat(x).isEqualTo / isNotNull / isTrue / contains
    const re6 = /assertThat\s*\(\s*([^)]+)\s*\)\s*\.\s*(isEqualTo|isNotNull|isNotEmpty|isTrue|isFalse|contains|isVisible)\s*\(?\s*(?:"([^"]*)")?/g;
    while ((m = re6.exec(content)) !== null) {
        if (isInsideConsumed(m.index, m.index + m[0].length)) continue;
        const subj = extractSubjectFromExpr(m[1]) || m[1].trim();
        const pred = m[2];
        const val = m[3];
        out.push({
            subject: subj,
            predicate: `${pred}${val ? ' "' + val + '"' : ''}`,
            expected: val,
            form: m[0],
            origin: 'java',
        });
        consume(m.index, m.index + m[0].length);
    }

    return out;
}

function extractSubjectFromExpr(expr: string): string {
    // Heuristic: turn user.getStatus() / user.getUserStatus() into "user status".
    // Tolerant of missing / partial parens (regex consumers may have stopped
    // extraction at an inner `)`).
    const mGet = expr.match(/(\w+)\.get(\w+)/);
    if (mGet) return `${mGet[1]} ${mGet[2].replace(/([A-Z])/g, ' $1').trim()}`.toLowerCase().replace(/\s+/g, ' ').trim();
    const mIs = expr.match(/(\w+)\.is(\w+)/);
    if (mIs) return mIs[1];   // subject alone — predicate handled by caller
    const m2 = expr.match(/(\w+)\.(\w+)/);
    if (m2) return `${m2[1]} ${m2[2]}`.trim();
    return expr.replace(/[(){}]/g, '').trim();
}

// ============================================================================
// TypeScript + Gherkin extractors
// ============================================================================

function extractTsAssertions(featureFile: string, stepFiles: string, pageFiles: string): Assertion[] {
    const out: Assertion[] = [];
    const combined = [featureFile, stepFiles, pageFiles].join('\n');

    // Gherkin Then/And steps — capture the whole step text
    const reThen = /^\s*(?:Then|And)\s+(.*)$/gm;
    let m: RegExpExecArray | null;
    while ((m = reThen.exec(featureFile)) !== null) {
        const text = m[1].trim();
        // "the user status should be ACTIVE" → subject=user status, predicate=should be ACTIVE
        const sub = extractSubjectFromStep(text);
        const pred = extractPredicateFromStep(text);
        out.push({
            subject: sub,
            predicate: pred,
            form: text,
            origin: 'ts',
        });
    }

    // CSAssert.assertEqual/assertText/assertVisible
    const re1 = /CSAssert\.getInstance\(\)\s*\.\s*(assertEqual|assertText|assertNotEqual|assertContains)\s*\(\s*([^,]+)\s*,\s*(?:"([^"]+)"|([\w$.[\]]+))/g;
    while ((m = re1.exec(combined)) !== null) {
        const method = m[1];
        const subjExpr = m[2];
        const expectedLit = m[3];
        const expectedExpr = m[4];
        const subject = extractSubjectFromExpr(subjExpr) || subjExpr.trim();
        const expected = expectedLit ?? expectedExpr?.trim() ?? '';
        out.push({
            subject,
            predicate: `${method} ${expected}`,
            expected,
            form: m[0],
            origin: 'ts',
        });
    }

    // assertVisible / assertNotVisible
    const re2 = /CSAssert\.getInstance\(\)\s*\.\s*(assertVisible|assertNotVisible)\s*\(\s*([\w.$[\]]+)/g;
    while ((m = re2.exec(combined)) !== null) {
        out.push({
            subject: extractSubjectFromExpr(m[2]) || m[2].trim(),
            predicate: m[1] === 'assertVisible' ? 'is visible' : 'is not visible',
            form: m[0],
            origin: 'ts',
        });
    }

    // CSReporter.fail(msg) followed by throw — indicates an assertion point
    const re3 = /CSReporter\.fail\s*\(\s*["'`]([^"'`]+)["'`]\s*\)[^;]*;\s*throw\s+new\s+Error/g;
    while ((m = re3.exec(combined)) !== null) {
        out.push({
            subject: m[1],
            predicate: 'failure-reported',
            form: m[0],
            origin: 'ts',
        });
    }

    return out;
}

function extractSubjectFromStep(text: string): string {
    // "the user status should be ACTIVE" → "user status"
    // "the welcome header should be visible" → "welcome header"
    const cleaned = text.replace(/^(the|a|an)\s+/i, '');
    const m = cleaned.match(/^([\w\s]+?)\s+(should|is|shows|displays|contains|equals|has|matches)/i);
    if (m) return m[1].trim();
    return cleaned.split(/\s+should|\s+is\b|\s+shows|\s+displays/i)[0].trim();
}

function extractPredicateFromStep(text: string): string {
    // Allow "should not be", "is not", "should show", etc.
    const m = text.match(/(should\s+(?:not\s+)?be\s+(.*)|is\s+(?:not\s+)?(.*)|shows?\s+(.*)|displays?\s+(.*)|equals?\s+(.*)|contains?\s+(.*))/i);
    if (m) return m[0];
    return text;
}

// ============================================================================
// Matching + scoring
// ============================================================================

function tokenise(s: string): string[] {
    return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}

function jaccardSimilarity(a: string[], b: string[]): number {
    const sa = new Set(a);
    const sb = new Set(b);
    const intersection = new Set([...sa].filter(x => sb.has(x)));
    const union = new Set([...sa, ...sb]);
    return union.size === 0 ? 0 : intersection.size / union.size;
}

interface MatchPair {
    java: Assertion;
    ts?: Assertion;
    score: number;
    verdict: 'matched' | 'weak-match' | 'unmatched';
}

function matchAssertions(javaAsserts: Assertion[], tsAsserts: Assertion[]): {
    pairs: MatchPair[];
    unmatchedTs: Assertion[];
} {
    const pairs: MatchPair[] = [];
    const usedTs = new Set<number>();

    for (const j of javaAsserts) {
        const jSubj = tokenise(normaliseIdentifier(j.subject));
        const jPred = tokenise(j.predicate);

        let best: { idx: number; score: number } | null = null;
        for (let i = 0; i < tsAsserts.length; i++) {
            if (usedTs.has(i)) continue;
            const t = tsAsserts[i];
            const tSubj = tokenise(normaliseIdentifier(t.subject));
            const tPred = tokenise(t.predicate);

            const subScore = jaccardSimilarity(jSubj, tSubj);
            const predScore = jaccardSimilarity(jPred, tPred);
            const expectedBoost = (j.expected && t.expected && j.expected.toLowerCase() === t.expected.toLowerCase()) ? 0.2 : 0;
            const score = subScore * 0.6 + predScore * 0.3 + expectedBoost;

            if (!best || score > best.score) best = { idx: i, score };
        }

        if (best && best.score >= 0.6) {
            pairs.push({ java: j, ts: tsAsserts[best.idx], score: best.score, verdict: 'matched' });
            usedTs.add(best.idx);
        } else if (best && best.score >= 0.35) {
            pairs.push({ java: j, ts: tsAsserts[best.idx], score: best.score, verdict: 'weak-match' });
            usedTs.add(best.idx);
        } else {
            pairs.push({ java: j, score: 0, verdict: 'unmatched' });
        }
    }

    const unmatchedTs = tsAsserts.filter((_, i) => !usedTs.has(i));
    return { pairs, unmatchedTs };
}

// ============================================================================
// Tool
// ============================================================================

const verifySemanticEquivalenceTool = defineTool()
    .name('verify_semantic_equivalence')
    .title('Verify Semantic Equivalence')
    .description(
        'Compare Java test assertions (assertEquals, assertTrue, assertNotNull, ' +
        'AssertJ, getText/isDisplayed) to the migrated TS scenario (Then steps, ' +
        'CSAssert calls, CSReporter.fail+throw). Returns matched pairs, weak matches, ' +
        'unmatched Java assertions (= potentially dropped coverage), and unmatched TS ' +
        'assertions (= added checks). Threshold-based verdict (<85% matched = warning).'
    )
    .outputSchema({
        type: 'object',
        properties: {
            javaAssertionCount: { type: 'number' },
            tsAssertionCount: { type: 'number' },
            matched: { type: 'array', items: { type: 'object' } },
            weakMatches: { type: 'array', items: { type: 'object' } },
            missingInTs: { type: 'array', items: { type: 'object' } },
            addedInTs: { type: 'array', items: { type: 'object' } },
            coverageRatio: { type: 'number' },
            verdict: { type: 'string' },
            summary: { type: 'string' },
        },
    })
    .category('audit')
    .stringParam('javaSource', 'Legacy Java test source', { required: true })
    .stringParam('tsFeature', 'Generated .feature file content', { required: true })
    .stringParam('tsStepDefs', 'Generated .steps.ts content', { required: true })
    .stringParam('tsPages', 'Generated page object TS content (may be empty)')
    .handler(async (params) => {
        const javaSource = params.javaSource as string;
        const tsFeature = params.tsFeature as string;
        const tsStepDefs = params.tsStepDefs as string;
        const tsPages = (params.tsPages as string | undefined) ?? '';

        const javaAsserts = extractJavaAssertions(javaSource);
        const tsAsserts = extractTsAssertions(tsFeature, tsStepDefs, tsPages);

        const { pairs, unmatchedTs } = matchAssertions(javaAsserts, tsAsserts);

        const matched = pairs.filter(p => p.verdict === 'matched');
        const weak = pairs.filter(p => p.verdict === 'weak-match');
        const missing = pairs.filter(p => p.verdict === 'unmatched');

        const coverageRatio = javaAsserts.length === 0 ? 1 : (matched.length + weak.length * 0.5) / javaAsserts.length;
        const verdict = coverageRatio >= 0.85 ? 'pass'
            : coverageRatio >= 0.5 ? 'warn'
            : 'fail';

        const summary = `Java has ${javaAsserts.length} assertion(s); TS has ${tsAsserts.length}. ` +
            `${matched.length} matched, ${weak.length} weak, ${missing.length} missing in TS, ${unmatchedTs.length} added. ` +
            `Coverage ${(coverageRatio * 100).toFixed(0)}% — verdict: ${verdict.toUpperCase()}.`;

        return createJsonResult({
            javaAssertionCount: javaAsserts.length,
            tsAssertionCount: tsAsserts.length,
            matched: matched.map(p => ({ java: p.java.form, ts: p.ts?.form, score: p.score })),
            weakMatches: weak.map(p => ({ java: p.java.form, ts: p.ts?.form, score: p.score, note: 'phrasing differs — user should confirm' })),
            missingInTs: missing.map(p => ({ java: p.java.form, subject: p.java.subject, predicate: p.java.predicate })),
            addedInTs: unmatchedTs.map(a => ({ ts: a.form, subject: a.subject, predicate: a.predicate })),
            coverageRatio,
            verdict,
            summary,
        });
    })
    .readOnly()
    .build();

// ============================================================================
// Export + registration
// ============================================================================

export const equivalenceTools: MCPToolDefinition[] = [verifySemanticEquivalenceTool];

export function registerEquivalenceTools(registry: CSMCPToolRegistry): void {
    registry.registerTools(equivalenceTools);
}
