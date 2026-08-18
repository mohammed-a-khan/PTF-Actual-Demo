/**
 * cs_qa_inspect_dom — fetch a live URL, extract every actionable element,
 * rank locators by stability, emit ready-to-paste @CSGetElement blocks
 * grouped by container region.
 *
 * Design notes
 *  - HTTP goes through dom_fetcher (SSO detection, redirect chain, cap,
 *    per-attempt timeout) — NOT AdoHttpClient, which is ADO-only.
 *  - Parsing goes through dom_parser (jsdom preferred, regex fallback,
 *    stability scoring as documented in Phase D1 spec).
 *  - No creds are read from AdoHttpClient — this is fully offline of ADO.
 *  - Logs flow through createLogger (invocation-scoped audit) so every
 *    live-URL fetch is captured in .cs-qa/audit/ado-audit.jsonl even
 *    though it's not an ADO call.
 */

import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import { createLogger } from './_helpers/structured_logger';
import { fetchDom, type DomFetchResult } from './_helpers/dom_fetcher';
import { parseInteractiveDom, buildDecoratorBlock, toCamelPropertyName } from './_helpers/dom_parser';

const InputSchema = z.object({
    url: z.string().url().describe('The URL to fetch. Must be reachable from this machine (no MCP-side proxy).'),
    authHeaders: z.record(z.string(), z.string()).optional().describe('Extra HTTP headers to send. Typically {"Authorization": "Basic ..."} or {"Authorization": "Bearer ..."}.'),
    userAgent: z.string().optional(),
    followRedirects: z.boolean().default(true),
    maxRedirects: z.number().int().min(0).max(10).default(3),
    timeoutMs: z.number().int().positive().default(15_000),
    elementFilters: z.object({
        includeSelectors: z.array(z.string()).optional().describe('Not currently honored beyond the default interactive-element set — reserved for a future CSS pre-filter.'),
        excludeSelectors: z.array(z.string()).optional().describe('CSS-like exclusion hints — logged only; the regex fallback cannot honor arbitrary CSS selectors.'),
        includeHidden: z.boolean().default(false).describe('When true, include display:none and aria-hidden elements too.'),
    }).optional(),
    outputFormat: z.enum(['json', 'cs-decorators']).default('cs-decorators'),
    /** Cap on distinct elements returned; default 100. */
    maxElements: z.number().int().positive().default(100),
});

const CandidateSchema = z.object({
    kind: z.string(),
    value: z.string(),
    xpath: z.string(),
    css: z.string(),
    score: z.number(),
});

const ElementSchema = z.object({
    tag: z.string(),
    inputType: z.string().optional(),
    containerRegion: z.string(),
    description: z.string(),
    propertyName: z.string(),
    primaryLocator: CandidateSchema,
    alternativeLocators: z.array(CandidateSchema),
    stabilityScore: z.number(),
    decoratorBlock: z.string(),
});

const OutputSchema = z.object({
    ok: z.boolean(),
    url: z.string(),
    finalUrl: z.string(),
    status: z.number(),
    redirectedTo: z.string().optional(),
    redirectChain: z.array(z.object({ from: z.string(), to: z.string(), status: z.number() })),
    authRequired: z.boolean().optional(),
    authReason: z.string().optional(),
    parseMethod: z.enum(['jsdom', 'regex']).optional(),
    contentType: z.string().optional(),
    elementCount: z.number(),
    containerCount: z.number(),
    containers: z.array(z.string()),
    elements: z.array(ElementSchema),
    /** cs-decorators view: containerRegion header + concatenated decorator blocks. Populated only when outputFormat === 'cs-decorators'. */
    csDecoratorsView: z.string().optional(),
    warnings: z.array(z.string()),
    note: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

registerPrimitive<Input, Output>({
    name: 'cs_qa_inspect_dom',
    description: 'Fetch a live URL and extract every actionable element with a stability-ranked locator set. jsdom is preferred (real DOM traversal, label[for] resolution, container detection); regex fallback with a warning when jsdom is not installed. Detects SSO gates (Okta / AAD / ADFS / microsoftonline / PingIdentity / Auth0) and returns authRequired without an attempt to authenticate. Elements are grouped by container region (form, nav, main, dialog, header, footer, body). Locator ranking: data-testid > id (kebab-case, non-auto-generated) > name > aria-label > label[for] > placeholder > role+text > text > css-class. Output is grouped @CSGetElement blocks ready to paste into a page object OR a JSON breakdown.',
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    run: async (ctx, input) => {
        const logger = createLogger(ctx.invocationId, 'cs_qa_inspect_dom', { workspaceRoot: ctx.workspaceRoot });
        logger.info('inspect-dom-start', { url: input.url, followRedirects: input.followRedirects });

        const fetchRes: DomFetchResult = await fetchDom({
            url: input.url,
            headers: input.authHeaders,
            userAgent: input.userAgent,
            followRedirects: input.followRedirects,
            maxRedirects: input.maxRedirects,
            timeoutMs: input.timeoutMs,
        });

        const baseWarn = [...fetchRes.warnings];

        if (fetchRes.fetchError) {
            logger.error('inspect-dom-fetch-error', { fetchError: fetchRes.fetchError, finalUrl: fetchRes.finalUrl });
            return {
                ok: false, url: input.url, finalUrl: fetchRes.finalUrl, status: 0,
                redirectChain: fetchRes.redirectChain, elementCount: 0, containerCount: 0,
                containers: [], elements: [],
                warnings: baseWarn.concat([`fetch failed: ${fetchRes.fetchError}`]),
                note: `Could not fetch ${input.url}: ${fetchRes.fetchError}`,
            };
        }

        if (fetchRes.authRequired) {
            logger.warn('inspect-dom-auth-required', { finalUrl: fetchRes.finalUrl, reason: fetchRes.authReason });
            return {
                ok: false,
                url: input.url,
                finalUrl: fetchRes.finalUrl,
                status: fetchRes.status,
                redirectedTo: fetchRes.finalUrl !== input.url ? fetchRes.finalUrl : undefined,
                redirectChain: fetchRes.redirectChain,
                authRequired: true,
                authReason: fetchRes.authReason,
                contentType: fetchRes.contentType,
                elementCount: 0, containerCount: 0, containers: [], elements: [],
                warnings: baseWarn,
                note: `Auth gate detected (${fetchRes.authReason || 'unspecified'}). This tool does not authenticate; supply an authHeaders map with a valid Authorization header, or point at a post-login URL.`,
            };
        }

        if (!fetchRes.ok || fetchRes.status < 200 || fetchRes.status >= 300) {
            logger.warn('inspect-dom-http-non-2xx', { status: fetchRes.status, finalUrl: fetchRes.finalUrl });
            return {
                ok: false, url: input.url, finalUrl: fetchRes.finalUrl, status: fetchRes.status,
                redirectChain: fetchRes.redirectChain, contentType: fetchRes.contentType,
                elementCount: 0, containerCount: 0, containers: [], elements: [],
                warnings: baseWarn,
                note: `HTTP ${fetchRes.status} from ${fetchRes.finalUrl}. Body snippet: ${(fetchRes.html || '').slice(0, 300)}`,
            };
        }

        const parsed = parseInteractiveDom(fetchRes.html);
        const includeHidden = input.elementFilters?.includeHidden === true;

        // Deduplicate property names across the result set so callers can paste blocks directly.
        const usedNames = new Set<string>();
        const rankedForOutput = parsed.elements.slice(0, input.maxElements).map((el) => {
            void includeHidden;
            let name = toCamelPropertyName(el.description || `${el.tag} element`, el.tag);
            let disambig = 2;
            const base = name;
            while (usedNames.has(name)) { name = base + disambig; disambig++; }
            usedNames.add(name);
            return {
                tag: el.tag,
                inputType: el.inputType,
                containerRegion: el.containerRegion,
                description: el.description,
                propertyName: name,
                primaryLocator: el.primary,
                alternativeLocators: el.alternatives,
                stabilityScore: el.stabilityScore,
                decoratorBlock: buildDecoratorBlock(el, name, { selfHeal: true }),
            };
        });

        // cs-decorators view: group by container.
        let csDecoratorsView: string | undefined;
        if (input.outputFormat === 'cs-decorators') {
            const grouped = new Map<string, typeof rankedForOutput>();
            for (const el of rankedForOutput) {
                const key = el.containerRegion;
                const arr = grouped.get(key) ?? [];
                arr.push(el);
                grouped.set(key, arr);
            }
            const chunks: string[] = [];
            for (const container of Array.from(grouped.keys()).sort()) {
                chunks.push(`// --- container: ${container} (${grouped.get(container)!.length} element(s)) ---`);
                for (const el of grouped.get(container)!) chunks.push(el.decoratorBlock);
                chunks.push('');
            }
            csDecoratorsView = chunks.join('\n\n');
        }

        const warnings = baseWarn.concat(parsed.warnings);

        logger.info('inspect-dom-done', {
            elementCount: rankedForOutput.length,
            parseMethod: parsed.parseMethod,
            containerCount: parsed.containers.length,
            authRequired: false,
        });

        return {
            ok: true,
            url: input.url,
            finalUrl: fetchRes.finalUrl,
            status: fetchRes.status,
            redirectedTo: fetchRes.finalUrl !== input.url ? fetchRes.finalUrl : undefined,
            redirectChain: fetchRes.redirectChain,
            contentType: fetchRes.contentType,
            parseMethod: parsed.parseMethod,
            elementCount: rankedForOutput.length,
            containerCount: parsed.containers.length,
            containers: parsed.containers,
            elements: rankedForOutput,
            csDecoratorsView,
            warnings,
            note: `Parsed ${rankedForOutput.length} interactive element(s) across ${parsed.containers.length} container(s) using ${parsed.parseMethod}.`,
        };
    },
});
