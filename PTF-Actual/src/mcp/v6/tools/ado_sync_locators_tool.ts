/**
 * cs_qa_sync_locators — parse an existing Page Object, fetch the live DOM,
 * classify every declared locator into 3 buckets, and (optionally) rewrite
 * the file with promotion suggestions.
 *
 *   WORKING   primary locator resolves in the live DOM
 *   DRIFTED   primary fails but an entry in alternativeLocators works
 *             → promote that alternative to primary; demote the old
 *   BROKEN    no locator resolves; heuristic-search the live DOM by
 *             description text + tag for a replacement candidate
 *   NEW       elements found in the DOM that have no @CSGetElement
 *             property yet → suggest an addition
 *
 * Options
 *   `dryRun` — never touch the file; report only.
 *   `autoApply` — write updated PO for DRIFTED bucket only (unambiguous
 *   swaps). BROKEN is never auto-applied, since the DOM-search suggestion
 *   is a guess.
 *
 * The rewrite path uses page_object_parser.rewritePrimaryXpath which does
 * a surgical text-level edit — the rest of the file (comments, imports,
 * body, other elements) is unchanged.
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import { createLogger } from './_helpers/structured_logger';
import { fetchDom } from './_helpers/dom_fetcher';
import { parseInteractiveDom, tryResolveLocator, tryResolveAny, buildDecoratorBlock, toCamelPropertyName } from './_helpers/dom_parser';
import { parsePageObjectFile, rewritePrimaryXpath, type CSGetElementRecord } from './_helpers/page_object_parser';

// ------------------------------------------------------------------------
// Schema.
// ------------------------------------------------------------------------

const InputSchema = z.object({
    pageObjectPath: z.string().min(1).describe('Absolute path or workspace-relative path to a Page Object .ts file.'),
    liveUrl: z.string().url().optional().describe('The URL to diff against. Auto-detected from the PO when omitted (super.navigate("…") or `protected url = "…"`).'),
    authHeaders: z.record(z.string(), z.string()).optional(),
    dryRun: z.boolean().default(false),
    autoApply: z.boolean().default(false),
    timeoutMs: z.number().int().positive().default(15_000),
    /** Cap on how many NEW elements to suggest. */
    maxNewSuggestions: z.number().int().nonnegative().default(20),
});

const LocatorCandidateSchema = z.object({
    kind: z.string(), value: z.string(), xpath: z.string(), css: z.string(), score: z.number(),
});

const WorkingSchema = z.object({
    propertyName: z.string(),
    primaryLocator: z.string(),
    matchCount: z.number(),
});
const DriftedSchema = z.object({
    propertyName: z.string(),
    brokenLocator: z.string(),
    suggestedAlternative: z.string(),
    workingAlternativeFromPO: z.boolean(),
});
const BrokenSchema = z.object({
    propertyName: z.string(),
    description: z.string(),
    suggestedNewLocator: z.string().optional(),
    similarElementsInDom: z.array(z.object({ description: z.string(), xpath: z.string(), score: z.number() })),
});
const NewSchema = z.object({
    elementDescription: z.string(),
    suggestedPropertyName: z.string(),
    suggestedDecorator: z.string(),
    stabilityScore: z.number(),
});

const OutputSchema = z.object({
    ok: z.boolean(),
    pageObjectPath: z.string(),
    url: z.string().optional(),
    elementsInPO: z.number(),
    elementsInDom: z.number(),
    parseMethod: z.enum(['jsdom', 'regex']).optional(),
    buckets: z.object({
        working: z.array(WorkingSchema),
        drifted: z.array(DriftedSchema),
        broken: z.array(BrokenSchema),
        new: z.array(NewSchema),
    }),
    autoApplied: z.number().optional(),
    autoAppliedProperties: z.array(z.string()).optional(),
    dryRun: z.boolean(),
    warnings: z.array(z.string()),
    note: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

// ------------------------------------------------------------------------
// Similarity — tiny heuristic: token overlap between description strings.
// ------------------------------------------------------------------------

function tokenize(s: string): string[] {
    return s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
}

function similarityScore(a: string, b: string): number {
    const A = new Set(tokenize(a));
    const B = new Set(tokenize(b));
    if (A.size === 0 || B.size === 0) return 0;
    let overlap = 0;
    for (const t of A) if (B.has(t)) overlap++;
    return overlap / Math.max(A.size, B.size);
}

// ------------------------------------------------------------------------
// Bucket classifier per element.
// ------------------------------------------------------------------------

interface Classified {
    working: Array<{ propertyName: string; primaryLocator: string; matchCount: number }>;
    drifted: Array<{ propertyName: string; brokenLocator: string; suggestedAlternative: string; workingAlternativeFromPO: boolean; el: CSGetElementRecord }>;
    broken: Array<{ propertyName: string; description: string; suggestedNewLocator?: string; similarElementsInDom: Array<{ description: string; xpath: string; score: number }>; el: CSGetElementRecord }>;
}

function classifyElement(el: CSGetElementRecord, html: string, domElements: ReturnType<typeof parseInteractiveDom>['elements']): Classified {
    const primary = el.xpath || el.css || '';
    const primaryResolves = primary ? tryResolveLocator(html, el.xpath || '') : { resolves: false, matchCount: 0, method: 'unknown' as const };
    if (primaryResolves.resolves) {
        return { working: [{ propertyName: el.propertyName, primaryLocator: primary, matchCount: primaryResolves.matchCount }], drifted: [], broken: [] };
    }
    // Try each alternative in order. Alternatives can be xpath OR CSS —
    // dispatch on the leading character (xpath starts with '/'; anything else
    // — '#id', '.class', '[data-testid=x]', a bare tag — is CSS).
    for (const alt of el.alternativeLocators) {
        const res = tryResolveAny(html, alt);
        if (res.resolves) {
            return {
                working: [],
                drifted: [{ propertyName: el.propertyName, brokenLocator: primary, suggestedAlternative: alt, workingAlternativeFromPO: true, el }],
                broken: [],
            };
        }
    }
    // BROKEN — try to find a heuristic replacement.
    const desc = el.description || el.propertyName;
    const similar = domElements
        .map((d) => ({ description: d.description, xpath: d.primary.xpath, score: similarityScore(desc, d.description) }))
        .filter((s) => s.score >= 0.4)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);
    const suggestion = similar.length > 0 ? similar[0].xpath : undefined;
    return {
        working: [],
        drifted: [],
        broken: [{ propertyName: el.propertyName, description: desc, suggestedNewLocator: suggestion, similarElementsInDom: similar, el }],
    };
}

// ------------------------------------------------------------------------
// Main.
// ------------------------------------------------------------------------

registerPrimitive<Input, Output>({
    name: 'cs_qa_sync_locators',
    description: 'Diff a Page Object against the live DOM. For each @CSGetElement property: WORKING when the primary xpath still resolves; DRIFTED when a listed alternativeLocator does; BROKEN when none does (with a similarity-based DOM-search suggestion). NEW = DOM elements that have no property yet. Optional autoApply rewrites only the DRIFTED bucket (unambiguous fixes) via surgical text-level edits — BROKEN is never auto-applied since the DOM-search is a guess. Never touches non-locator content in the source file.',
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    run: async (ctx, input) => {
        const logger = createLogger(ctx.invocationId, 'cs_qa_sync_locators', { workspaceRoot: ctx.workspaceRoot });
        const abs = path.isAbsolute(input.pageObjectPath) ? input.pageObjectPath : path.resolve(ctx.workspaceRoot, input.pageObjectPath);
        if (!fs.existsSync(abs)) {
            return {
                ok: false, pageObjectPath: input.pageObjectPath, elementsInPO: 0, elementsInDom: 0,
                buckets: { working: [], drifted: [], broken: [], new: [] },
                dryRun: input.dryRun, warnings: [], note: `Page object file not found: ${abs}`,
            };
        }

        const po = parsePageObjectFile(abs);
        logger.info('sync-locators-parsed-po', { propertyCount: po.elements.length });

        const url = input.liveUrl || po.inferredUrl;
        if (!url || url.startsWith('${')) {
            return {
                ok: false, pageObjectPath: input.pageObjectPath, elementsInPO: po.elements.length, elementsInDom: 0,
                buckets: { working: [], drifted: [], broken: [], new: [] },
                dryRun: input.dryRun,
                warnings: po.warnings,
                note: `No live URL to diff against. Pass liveUrl explicitly, or hard-code a URL in the page object's super.navigate('...') call.`,
            };
        }

        const fr = await fetchDom({
            url,
            headers: input.authHeaders,
            followRedirects: true,
            maxRedirects: 3,
            timeoutMs: input.timeoutMs,
        });
        if (fr.authRequired) {
            return {
                ok: false, pageObjectPath: input.pageObjectPath, url,
                elementsInPO: po.elements.length, elementsInDom: 0,
                buckets: { working: [], drifted: [], broken: [], new: [] },
                dryRun: input.dryRun,
                warnings: fr.warnings,
                note: `Live URL ${url} is behind an auth gate (${fr.authReason || 'unknown'}). Supply an authHeaders map or point at a post-login URL.`,
            };
        }
        if (!fr.ok) {
            return {
                ok: false, pageObjectPath: input.pageObjectPath, url,
                elementsInPO: po.elements.length, elementsInDom: 0,
                buckets: { working: [], drifted: [], broken: [], new: [] },
                dryRun: input.dryRun,
                warnings: fr.warnings,
                note: `Fetch failed for ${url}: ${fr.fetchError || `HTTP ${fr.status}`}.`,
            };
        }
        const parsed = parseInteractiveDom(fr.html);

        // Classify.
        const workingAll: Output['buckets']['working'] = [];
        const driftedAll: Output['buckets']['drifted'] = [];
        const brokenAll: Output['buckets']['broken'] = [];
        const driftedElRecords: Array<{ el: CSGetElementRecord; suggestedAlternative: string }> = [];
        for (const el of po.elements) {
            const cls = classifyElement(el, fr.html, parsed.elements);
            for (const w of cls.working) workingAll.push(w);
            for (const d of cls.drifted) {
                driftedAll.push({ propertyName: d.propertyName, brokenLocator: d.brokenLocator, suggestedAlternative: d.suggestedAlternative, workingAlternativeFromPO: d.workingAlternativeFromPO });
                driftedElRecords.push({ el: d.el, suggestedAlternative: d.suggestedAlternative });
            }
            for (const b of cls.broken) brokenAll.push({ propertyName: b.propertyName, description: b.description, suggestedNewLocator: b.suggestedNewLocator, similarElementsInDom: b.similarElementsInDom });
        }

        // NEW: elements in the DOM whose primary xpath does not correspond to any PO property.
        const poPrimaries = new Set(po.elements.map((e) => e.xpath).filter(Boolean) as string[]);
        const poDescriptions = new Set(po.elements.map((e) => (e.description || '').toLowerCase()));
        const seenNewNames = new Set<string>();
        const newSuggestions: Output['buckets']['new'] = [];
        for (const dEl of parsed.elements) {
            if (newSuggestions.length >= input.maxNewSuggestions) break;
            if (poPrimaries.has(dEl.primary.xpath)) continue;
            if (poDescriptions.has(dEl.description.toLowerCase())) continue;
            let name = toCamelPropertyName(dEl.description || `${dEl.tag} element`, dEl.tag);
            let n = 2; const base = name;
            while (seenNewNames.has(name)) { name = base + n; n++; }
            seenNewNames.add(name);
            newSuggestions.push({
                elementDescription: dEl.description,
                suggestedPropertyName: name,
                suggestedDecorator: buildDecoratorBlock(dEl, name, { selfHeal: true }),
                stabilityScore: dEl.stabilityScore,
            });
        }

        // Auto-apply DRIFTED, if requested and not dry-run.
        let autoApplied = 0;
        const autoAppliedProperties: string[] = [];
        if (!input.dryRun && input.autoApply && driftedElRecords.length > 0) {
            // Apply in reverse offset order so early edits don't shift later offsets.
            const sorted = driftedElRecords.slice().sort((a, b) => b.el.optionsStart - a.el.optionsStart);
            let mutSource = po.source;
            for (const { el, suggestedAlternative } of sorted) {
                // Re-parse to get fresh offsets after each edit? — cheaper: since we walk in
                // reverse order and each edit is confined to a single element's options block,
                // offsets of unedited elements are unaffected. Verified: rewritePrimaryXpath
                // only mutates [optionsStart, optionsEnd) and returns the full string.
                mutSource = rewritePrimaryXpath(mutSource, el, suggestedAlternative, true);
                autoApplied++;
                autoAppliedProperties.push(el.propertyName);
            }
            fs.writeFileSync(abs, mutSource, 'utf-8');
        }

        logger.info('sync-locators-done', {
            working: workingAll.length, drifted: driftedAll.length, broken: brokenAll.length,
            new: newSuggestions.length, autoApplied,
        });

        return {
            ok: true, pageObjectPath: input.pageObjectPath, url,
            elementsInPO: po.elements.length, elementsInDom: parsed.elements.length,
            parseMethod: parsed.parseMethod,
            buckets: { working: workingAll, drifted: driftedAll, broken: brokenAll, new: newSuggestions },
            autoApplied,
            autoAppliedProperties,
            dryRun: input.dryRun,
            warnings: po.warnings.concat(parsed.warnings).concat(fr.warnings),
            note: `PO has ${po.elements.length} property/ies; DOM has ${parsed.elements.length} interactive element(s). Working:${workingAll.length}, Drifted:${driftedAll.length}, Broken:${brokenAll.length}, New:${newSuggestions.length}${autoApplied > 0 ? `. Auto-applied ${autoApplied} drift fix(es).` : ''}`,
        };
    },
});
