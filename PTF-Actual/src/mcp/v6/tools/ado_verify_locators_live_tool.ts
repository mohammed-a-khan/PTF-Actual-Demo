/**
 * cs_qa_verify_locators_live — verifies suggested locators against the LIVE
 * DOM at a target URL. This is the "never guess" hard gate: no locator can
 * be emitted into a generated page object unless it was verified here.
 *
 * Two verification modes, chosen per invocation:
 *   1. `live-browser` — full Playwright chromium session (default when
 *      `useBrowser:true`). Handles login flow + auth cookies + dynamic
 *      content. Uses the shared session cache in `browser/session.ts` so a
 *      subsequent locator batch reuses the same page.
 *   2. `static-fetch` — fetchDom() + jsdom parsing. No JS execution, no
 *      login flow — fast enough for smoke tests and useful for static
 *      pages. Uses `tryResolveLocator` / `tryResolveCss` from dom_parser.
 *
 * Per locator:
 *   - primaryXpath resolves to exactly 1 node → verdict:'verified' (high)
 *   - primaryXpath resolves to > 1 node → verdict:'ambiguous' (medium),
 *     tries each alternativeLocators[] to find one that scopes to 1
 *   - primaryXpath resolves to 0 nodes → tries each alternativeLocators[]
 *     - one resolves → verdict:'verified' (medium) with finalXpath swapped
 *     - none resolve → falls back to dom_parser to PROPOSE a locator from
 *       the actual page (stability-ranked: data-testid > id > name > …)
 *     - no proposal possible → verdict:'not-found' + emitAsManualReview:true
 *
 * The output's `verifiedLocatorSet[]` is what codegen consumes. Every entry
 * has a finalXpath that WAS actually observed in the DOM at the time of
 * verification.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import { createLogger } from './_helpers/structured_logger';
import { fetchDom } from './_helpers/dom_fetcher';
import {
    tryResolveLocator, tryResolveAny, parseInteractiveDom,
    type ExtractedElement,
} from './_helpers/dom_parser';

// ---------------------------------------------------------------------------
// Schema.
// ---------------------------------------------------------------------------

const SuggestedLocatorSchema = z.object({
    fieldName: z.string().min(1),
    primaryXpath: z.string().min(1),
    alternativeLocators: z.array(z.string().min(1)).default([]),
    description: z.string().optional(),
    screenId: z.string().optional(),
});

const AuthCookieSchema = z.object({
    name: z.string().min(1),
    value: z.string(),
    domain: z.string().optional(),
    path: z.string().default('/'),
});

const LoginFlowSchema = z.object({
    loginUrl: z.string().url().optional(),
    usernameSelector: z.string().optional(),
    passwordSelector: z.string().optional(),
    submitSelector: z.string().optional(),
    usernameEnvVar: z.string().optional(),
    passwordEnvVar: z.string().optional(),
    postLoginWaitSelector: z.string().optional(),
});

const InputSchema = z.object({
    suggestedLocators: z.array(SuggestedLocatorSchema).min(1),
    targetUrl: z.string().url(),
    authCookies: z.array(AuthCookieSchema).optional(),
    authHeaders: z.record(z.string(), z.string()).optional(),
    loginFlow: LoginFlowSchema.optional(),
    waitForSelector: z.string().optional(),
    timeoutMs: z.number().int().positive().max(120_000).default(30_000),
    headless: z.boolean().default(true),
    useBrowser: z.boolean().default(true).describe('When true, use Playwright chromium session (handles JS + login). When false, use static HTML fetch (fast, no JS).'),
    sessionId: z.string().min(3).optional().describe('Reuse an existing browser session by id. When omitted, a per-invocation session is spun up + torn down.'),
    takeScreenshot: z.boolean().default(true),
    maxDomProposals: z.number().int().positive().default(3).describe('Cap on how many DOM-derived proposals to consider per not-found locator before flagging manual-review.'),
});

const PerLocatorSchema = z.object({
    fieldName: z.string(),
    verdict: z.enum(['verified', 'ambiguous', 'not-found', 'proposed']),
    finalXpath: z.string(),
    matchCount: z.number(),
    alternativesTried: z.array(z.object({ locator: z.string(), matched: z.boolean(), matchCount: z.number() })),
    proposedFromDom: z.object({
        xpath: z.string(),
        source: z.string(),
        stabilityScore: z.number(),
    }).optional(),
    confidence: z.enum(['high', 'medium', 'low']),
    emitAsManualReview: z.boolean(),
    note: z.string().optional(),
});

const VerifiedLocatorSchema = z.object({
    fieldName: z.string(),
    xpath: z.string(),
    verified: z.boolean(),
    confidence: z.enum(['high', 'medium', 'low']),
    source: z.enum(['primary', 'alternative', 'proposed-from-dom']),
});

const OutputSchema = z.object({
    ok: z.boolean(),
    mode: z.enum(['live-browser', 'static-fetch']),
    targetUrl: z.string(),
    finalUrl: z.string().optional(),
    verifiedCount: z.number(),
    ambiguousCount: z.number(),
    notFoundCount: z.number(),
    proposedCount: z.number(),
    perLocator: z.array(PerLocatorSchema),
    verifiedLocatorSet: z.array(VerifiedLocatorSchema),
    screenSnapshotPath: z.string().optional(),
    warnings: z.array(z.string()),
    note: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

// ---------------------------------------------------------------------------
// Playwright browser mode.
// ---------------------------------------------------------------------------

interface PageLike {
    goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
    locator(sel: string): { count(): Promise<number>; first(): unknown };
    waitForSelector(sel: string, opts?: { timeout?: number; state?: string }): Promise<unknown>;
    content(): Promise<string>;
    screenshot(opts?: { path?: string; fullPage?: boolean }): Promise<unknown>;
    url(): string;
    fill(sel: string, value: string): Promise<unknown>;
    click(sel: string, opts?: { timeout?: number }): Promise<unknown>;
    context?(): { addCookies(cookies: unknown[]): Promise<unknown> };
}

// Xpath needs the "xpath=" prefix for Playwright's locator.
function normalizeForPlaywright(xpath: string): string {
    const s = (xpath || '').trim();
    if (s.startsWith('xpath=')) return s;
    if (s.startsWith('//') || s.startsWith('(//')) return 'xpath=' + s;
    return s;
}

async function withBrowser<T>(sessionId: string | undefined, headless: boolean, fn: (page: PageLike) => Promise<T>): Promise<T> {
    // Lazy-require session helper. When Playwright isn't installed the caller
    // must fall back to `static-fetch` mode explicitly.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const session = require('../browser/session') as {
        getOrStart(id: string, headless: boolean): Promise<{ page: PageLike; context: { addCookies(cookies: unknown[]): Promise<unknown> } }>;
        stop(id: string): Promise<boolean>;
    };
    const id = sessionId || `verify-locators-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const owned = !sessionId;
    const s = await session.getOrStart(id, headless);
    try {
        return await fn(s.page);
    } finally {
        if (owned) await session.stop(id);
    }
}

async function performLogin(page: PageLike, flow: z.infer<typeof LoginFlowSchema>, timeoutMs: number, warnings: string[]): Promise<void> {
    if (!flow.loginUrl || !flow.usernameSelector || !flow.passwordSelector || !flow.submitSelector) {
        warnings.push('login flow supplied but missing required fields (loginUrl/usernameSelector/passwordSelector/submitSelector) — skipped');
        return;
    }
    const username = flow.usernameEnvVar ? (process.env[flow.usernameEnvVar] || '') : '';
    const password = flow.passwordEnvVar ? (process.env[flow.passwordEnvVar] || '') : '';
    if (!username || !password) {
        warnings.push(`login flow: env var(s) missing — ${flow.usernameEnvVar}=${username ? 'set' : 'unset'} ${flow.passwordEnvVar}=${password ? 'set' : 'unset'}`);
        return;
    }
    await page.goto(flow.loginUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.fill(normalizeForPlaywright(flow.usernameSelector), username);
    await page.fill(normalizeForPlaywright(flow.passwordSelector), password);
    await page.click(normalizeForPlaywright(flow.submitSelector), { timeout: timeoutMs });
    if (flow.postLoginWaitSelector) {
        await page.waitForSelector(normalizeForPlaywright(flow.postLoginWaitSelector), { timeout: timeoutMs });
    }
}

async function extractDomHtml(page: PageLike): Promise<string> {
    try { return await page.content(); }
    catch { return ''; }
}

// ---------------------------------------------------------------------------
// Per-locator verdict logic (shared between browser + static modes).
// ---------------------------------------------------------------------------

interface ResolveFn {
    (locator: string): Promise<{ resolves: boolean; matchCount: number }>;
}

interface VerifyResult {
    verdict: 'verified' | 'ambiguous' | 'not-found' | 'proposed';
    finalXpath: string;
    matchCount: number;
    source: 'primary' | 'alternative' | 'proposed-from-dom';
    alternativesTried: Array<{ locator: string; matched: boolean; matchCount: number }>;
    proposedFromDom?: { xpath: string; source: string; stabilityScore: number };
    confidence: 'high' | 'medium' | 'low';
}

async function verifyOne(
    suggestion: z.infer<typeof SuggestedLocatorSchema>,
    resolve: ResolveFn,
    domElements: ExtractedElement[],
    maxProposals: number,
): Promise<VerifyResult> {
    const alternativesTried: Array<{ locator: string; matched: boolean; matchCount: number }> = [];

    // 1. Primary.
    const primary = await resolve(suggestion.primaryXpath);
    if (primary.resolves && primary.matchCount === 1) {
        return {
            verdict: 'verified',
            finalXpath: suggestion.primaryXpath,
            matchCount: 1,
            source: 'primary',
            alternativesTried,
            confidence: 'high',
        };
    }
    if (primary.resolves && primary.matchCount > 1) {
        // Ambiguous — try alternatives that might scope.
        for (const alt of suggestion.alternativeLocators) {
            const r = await resolve(alt);
            alternativesTried.push({ locator: alt, matched: r.resolves && r.matchCount === 1, matchCount: r.matchCount });
            if (r.resolves && r.matchCount === 1) {
                return {
                    verdict: 'verified',
                    finalXpath: alt,
                    matchCount: 1,
                    source: 'alternative',
                    alternativesTried,
                    confidence: 'medium',
                };
            }
        }
        return {
            verdict: 'ambiguous',
            finalXpath: suggestion.primaryXpath,
            matchCount: primary.matchCount,
            source: 'primary',
            alternativesTried,
            confidence: 'low',
        };
    }
    // 2. Primary not found — try alternatives.
    for (const alt of suggestion.alternativeLocators) {
        const r = await resolve(alt);
        alternativesTried.push({ locator: alt, matched: r.resolves && r.matchCount === 1, matchCount: r.matchCount });
        if (r.resolves && r.matchCount === 1) {
            return {
                verdict: 'verified',
                finalXpath: alt,
                matchCount: 1,
                source: 'alternative',
                alternativesTried,
                confidence: 'medium',
            };
        }
    }
    // 3. Propose from DOM based on field-name / description similarity.
    const proposed = proposeFromDom(suggestion, domElements, maxProposals);
    if (proposed) {
        const verify = await resolve(proposed.xpath);
        if (verify.resolves && verify.matchCount === 1) {
            return {
                verdict: 'proposed',
                finalXpath: proposed.xpath,
                matchCount: 1,
                source: 'proposed-from-dom',
                alternativesTried,
                proposedFromDom: { xpath: proposed.xpath, source: proposed.source, stabilityScore: proposed.stabilityScore },
                confidence: 'medium',
            };
        }
    }
    return {
        verdict: 'not-found',
        finalXpath: suggestion.primaryXpath,
        matchCount: 0,
        source: 'primary',
        alternativesTried,
        confidence: 'low',
    };
}

function tokenizeField(s: string): string[] {
    return s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
}

function similarityScore(a: string, b: string): number {
    const A = new Set(tokenizeField(a));
    const B = new Set(tokenizeField(b));
    if (A.size === 0 || B.size === 0) return 0;
    let hits = 0;
    for (const t of A) if (B.has(t)) hits++;
    return hits / Math.max(A.size, B.size);
}

// Regex-based xpath/CSS resolver — used only when jsdom is unavailable. Handles
// the shapes our codegen emits (id + attribute equality). Counts by scanning
// the raw HTML for the corresponding attribute pattern. Never a substitute
// for jsdom for arbitrary xpaths, but covers the common cases so smoke tests
// can run without a jsdom install.
function regexResolveXpath(html: string, locator: string): { resolves: boolean; matchCount: number } {
    const raw = (locator || '').trim();
    if (!raw) return { resolves: false, matchCount: 0 };
    // //*[@id='X'] or //*[@id="X"]
    let m = /^\/\/\*\[@id=['"]([^'"]+)['"]\]$/.exec(raw);
    if (m) return countAttrOccurrences(html, 'id', m[1]);
    // //tag[@attr='X'] or //tag[@attr="X"]
    m = /^\/\/(\w+)\[@([\w-]+)=['"]([^'"]+)['"]\]$/.exec(raw);
    if (m) return countTagAttrOccurrences(html, m[1], m[2], m[3]);
    // //*[@attr='X']
    m = /^\/\/\*\[@([\w-]+)=['"]([^'"]+)['"]\]$/.exec(raw);
    if (m) return countAttrOccurrences(html, m[1], m[2]);
    // CSS: #id
    m = /^#([\w-]+)$/.exec(raw);
    if (m) return countAttrOccurrences(html, 'id', m[1]);
    // CSS: [attr="X"] or [attr='X'] or [attr=X]
    m = /^\[([\w-]+)=['"]?([^'"\]]+)['"]?\]$/.exec(raw);
    if (m) return countAttrOccurrences(html, m[1], m[2]);
    // CSS: tag[attr="X"]
    m = /^(\w+)\[([\w-]+)=['"]?([^'"\]]+)['"]?\]$/.exec(raw);
    if (m) return countTagAttrOccurrences(html, m[1], m[2], m[3]);
    return { resolves: false, matchCount: 0 };
}

function countAttrOccurrences(html: string, attr: string, value: string): { resolves: boolean; matchCount: number } {
    // Match attr="value" or attr='value' allowing whitespace around =.
    const escAttr = attr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escVal = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escAttr}\\s*=\\s*['"]${escVal}['"]`, 'gi');
    const matches = html.match(re) || [];
    return { resolves: matches.length > 0, matchCount: matches.length };
}

function countTagAttrOccurrences(html: string, tag: string, attr: string, value: string): { resolves: boolean; matchCount: number } {
    const escTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escAttr = attr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escVal = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Match <tag ... attr="value" ...> — accept any preceding attributes.
    const re = new RegExp(`<${escTag}\\b[^>]*?\\b${escAttr}\\s*=\\s*['"]${escVal}['"]`, 'gi');
    const matches = html.match(re) || [];
    return { resolves: matches.length > 0, matchCount: matches.length };
}

function proposeFromDom(
    suggestion: z.infer<typeof SuggestedLocatorSchema>,
    domElements: ExtractedElement[],
    maxProposals: number,
): { xpath: string; source: string; stabilityScore: number } | null {
    const searchText = `${suggestion.fieldName} ${suggestion.description || ''}`;
    // Rank all DOM elements by name similarity + stability.
    const ranked = domElements.map((el) => {
        const sim = similarityScore(searchText, el.description);
        return { el, combined: sim * 0.6 + (el.stabilityScore / 10) * 0.4, sim };
    })
        .filter((r) => r.sim >= 0.2 || (r.el.stabilityScore >= 6 && r.sim > 0))
        .sort((a, b) => b.combined - a.combined)
        .slice(0, maxProposals);
    if (ranked.length === 0) return null;
    const best = ranked[0];
    return {
        xpath: best.el.primary.xpath,
        source: `dom:${best.el.primary.kind}=${best.el.primary.value}`,
        stabilityScore: best.el.stabilityScore,
    };
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

registerPrimitive<Input, Output>({
    name: 'cs_qa_verify_locators_live',
    description: 'The "never guess" hard gate. Verifies suggested locators against the LIVE DOM at targetUrl. Modes: live-browser (Playwright chromium; handles JS + login flow + auth cookies) OR static-fetch (fetchDom + jsdom; fast, no JS). Per locator: primary resolves to 1 node → verified (high); >1 → ambiguous, try alternatives; 0 → try alternatives, then propose from live DOM via stability-ranked search (data-testid > id > name > aria-label > placeholder > label > text > css); no proposal → emitAsManualReview:true. Codegen consumes verifiedLocatorSet[] — every finalXpath was actually observed in the DOM at verification time.',
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    run: async (ctx, input) => {
        const log = createLogger(ctx.invocationId, 'cs_qa_verify_locators_live', { workspaceRoot: ctx.workspaceRoot });
        const warnings: string[] = [];
        log.info('verify-locators-start', {
            targetUrl: input.targetUrl,
            useBrowser: input.useBrowser,
            suggestedCount: input.suggestedLocators.length,
            headless: input.headless,
        });

        let mode: 'live-browser' | 'static-fetch' = input.useBrowser ? 'live-browser' : 'static-fetch';
        let html = '';
        let finalUrl = input.targetUrl;
        let screenshotPath: string | undefined;

        // Try browser mode first if requested.
        let browserFailed = false;
        let resolveFn: ResolveFn | null = null;
        let browserPage: PageLike | null = null;
        let browserSessionCleanup: (() => Promise<void>) | null = null;

        if (mode === 'live-browser') {
            try {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const session = require('../browser/session') as {
                    getOrStart(id: string, headless: boolean): Promise<{ page: PageLike; context: { addCookies(cookies: unknown[]): Promise<unknown> } }>;
                    stop(id: string): Promise<boolean>;
                };
                const id = input.sessionId || `verify-locators-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
                const owned = !input.sessionId;
                const s = await session.getOrStart(id, input.headless);
                browserPage = s.page;
                browserSessionCleanup = owned ? (async () => { await session.stop(id); }) : null;

                if (input.authCookies && input.authCookies.length > 0 && s.context) {
                    try {
                        await s.context.addCookies(input.authCookies.map((c) => ({
                            name: c.name, value: c.value,
                            domain: c.domain, path: c.path,
                        })));
                    } catch (e) {
                        warnings.push(`addCookies failed: ${(e as Error).message}`);
                    }
                }
                if (input.loginFlow) {
                    await performLogin(browserPage, input.loginFlow, input.timeoutMs, warnings);
                }
                await browserPage.goto(input.targetUrl, { waitUntil: 'domcontentloaded', timeout: input.timeoutMs });
                if (input.waitForSelector) {
                    try { await browserPage.waitForSelector(normalizeForPlaywright(input.waitForSelector), { timeout: input.timeoutMs }); }
                    catch (e) { warnings.push(`waitForSelector failed: ${(e as Error).message}`); }
                }
                finalUrl = browserPage.url();
                html = await extractDomHtml(browserPage);
                if (input.takeScreenshot) {
                    const snapRoot = process.env.CS_QA_V6_HOME
                        ? path.join(process.env.CS_QA_V6_HOME, 'snapshots')
                        : path.join(os.homedir(), '.cs-qa', 'v6', 'snapshots');
                    fs.mkdirSync(snapRoot, { recursive: true });
                    screenshotPath = path.join(snapRoot, `verify-${Date.now()}.png`);
                    try { await browserPage.screenshot({ path: screenshotPath, fullPage: false }); }
                    catch (e) { warnings.push(`screenshot failed: ${(e as Error).message}`); screenshotPath = undefined; }
                }
                // Resolve via Playwright locator counts — most authoritative.
                const capturedPage = browserPage;
                resolveFn = async (locator: string): Promise<{ resolves: boolean; matchCount: number }> => {
                    try {
                        const count = await capturedPage.locator(normalizeForPlaywright(locator)).count();
                        return { resolves: count > 0, matchCount: count };
                    } catch {
                        return { resolves: false, matchCount: 0 };
                    }
                };
            } catch (e) {
                browserFailed = true;
                warnings.push(`live-browser mode failed: ${(e as Error).message} — falling back to static-fetch mode.`);
                mode = 'static-fetch';
                if (browserSessionCleanup) {
                    try { await browserSessionCleanup(); } catch { /* noop */ }
                    browserSessionCleanup = null;
                }
            }
        }

        // Static-fetch fallback / primary.
        if (mode === 'static-fetch' || !resolveFn) {
            const fr = await fetchDom({
                url: input.targetUrl,
                headers: input.authHeaders,
                followRedirects: true,
                maxRedirects: 3,
                timeoutMs: input.timeoutMs,
            });
            if (fr.authRequired) {
                warnings.push(`static-fetch: auth gate detected (${fr.authReason || 'unknown'}). Locator verification against a login page is meaningless.`);
                return {
                    ok: false, mode: 'static-fetch', targetUrl: input.targetUrl, finalUrl: fr.finalUrl,
                    verifiedCount: 0, ambiguousCount: 0, notFoundCount: input.suggestedLocators.length, proposedCount: 0,
                    perLocator: input.suggestedLocators.map((s) => ({
                        fieldName: s.fieldName, verdict: 'not-found' as const, finalXpath: s.primaryXpath, matchCount: 0,
                        alternativesTried: [], confidence: 'low' as const, emitAsManualReview: true,
                        note: 'static-fetch hit auth gate; unable to verify',
                    })),
                    verifiedLocatorSet: [],
                    warnings,
                    note: `Cannot verify locators — ${fr.finalUrl} is behind ${fr.authReason || 'an auth gate'}. Use live-browser mode with a loginFlow or authCookies.`,
                };
            }
            if (!fr.ok) {
                warnings.push(`static-fetch failed: ${fr.fetchError || `HTTP ${fr.status}`}`);
                return {
                    ok: false, mode: 'static-fetch', targetUrl: input.targetUrl, finalUrl: fr.finalUrl,
                    verifiedCount: 0, ambiguousCount: 0, notFoundCount: input.suggestedLocators.length, proposedCount: 0,
                    perLocator: input.suggestedLocators.map((s) => ({
                        fieldName: s.fieldName, verdict: 'not-found' as const, finalXpath: s.primaryXpath, matchCount: 0,
                        alternativesTried: [], confidence: 'low' as const, emitAsManualReview: true,
                        note: `static-fetch failed: ${fr.fetchError || `HTTP ${fr.status}`}`,
                    })),
                    verifiedLocatorSet: [],
                    warnings,
                    note: `Fetch failed for ${input.targetUrl}: ${fr.fetchError || `HTTP ${fr.status}`}`,
                };
            }
            html = fr.html;
            finalUrl = fr.finalUrl;
            resolveFn = async (locator: string): Promise<{ resolves: boolean; matchCount: number }> => {
                // Primary: jsdom-backed (tryResolveAny). When jsdom is missing
                // the resolver returns resolves:false + resolverConfidence:'low'
                // — fall through to a regex-based HTML scan that handles the
                // xpath shapes emitted by our codegen (//*[@id='X'], //tag[@attr='X']).
                const j = tryResolveAny(html, locator);
                if (j.resolves) return { resolves: true, matchCount: j.matchCount };
                if (j.resolverConfidence === 'low' && j.warning && j.warning.includes('jsdom-missing')) {
                    return regexResolveXpath(html, locator);
                }
                return { resolves: false, matchCount: j.matchCount };
            };
        }

        // Parse DOM once for proposal fallback.
        const parsed = parseInteractiveDom(html);
        if (parsed.warnings.length > 0) {
            for (const w of parsed.warnings) warnings.push(`dom-parser: ${w}`);
        }

        // Verify each locator.
        const perLocator: z.infer<typeof PerLocatorSchema>[] = [];
        const verifiedLocatorSet: z.infer<typeof VerifiedLocatorSchema>[] = [];
        for (const suggestion of input.suggestedLocators) {
            const r = await verifyOne(suggestion, resolveFn, parsed.elements, input.maxDomProposals);
            const emitAsManualReview = r.verdict === 'not-found' || r.verdict === 'ambiguous';
            const note = r.verdict === 'not-found'
                ? 'no locator resolved and no DOM proposal — needs @needs-manual-review on emitted scenario'
                : r.verdict === 'ambiguous'
                    ? `primary matched ${r.matchCount} elements — narrow the xpath OR add a scoping parent`
                    : r.verdict === 'proposed'
                        ? `no supplied locator resolved; proposed from live DOM via ${r.proposedFromDom?.source}`
                        : r.source === 'alternative'
                            ? 'primary broke; alternative locator resolved — promote the alternative to primary'
                            : undefined;
            perLocator.push({
                fieldName: suggestion.fieldName,
                verdict: r.verdict,
                finalXpath: r.finalXpath,
                matchCount: r.matchCount,
                alternativesTried: r.alternativesTried,
                proposedFromDom: r.proposedFromDom,
                confidence: r.confidence,
                emitAsManualReview,
                note,
            });
            if (r.verdict === 'verified' || r.verdict === 'proposed') {
                verifiedLocatorSet.push({
                    fieldName: suggestion.fieldName,
                    xpath: r.finalXpath,
                    verified: true,
                    confidence: r.confidence,
                    source: r.source,
                });
            }
        }

        if (browserSessionCleanup) {
            try { await browserSessionCleanup(); } catch { /* noop */ }
        }

        const verifiedCount = perLocator.filter((p) => p.verdict === 'verified').length;
        const proposedCount = perLocator.filter((p) => p.verdict === 'proposed').length;
        const ambiguousCount = perLocator.filter((p) => p.verdict === 'ambiguous').length;
        const notFoundCount = perLocator.filter((p) => p.verdict === 'not-found').length;

        log.info('verify-locators-done', {
            mode, verifiedCount, proposedCount, ambiguousCount, notFoundCount,
            browserFailed,
        });

        const note = `${mode}: ${verifiedCount}/${input.suggestedLocators.length} verified, ${proposedCount} proposed from DOM, ${ambiguousCount} ambiguous, ${notFoundCount} not found. ${notFoundCount + ambiguousCount > 0 ? `${notFoundCount + ambiguousCount} locator(s) flagged emitAsManualReview:true.` : 'All locators safe for codegen.'}`;

        return {
            ok: true, mode, targetUrl: input.targetUrl, finalUrl,
            verifiedCount, ambiguousCount, notFoundCount, proposedCount,
            perLocator, verifiedLocatorSet, screenSnapshotPath: screenshotPath,
            warnings, note,
        };
    },
});
