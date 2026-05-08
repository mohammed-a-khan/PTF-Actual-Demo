/**
 * Agentic Test Platform — Document → IR converter
 *
 * Converts a markdown / plain-text requirements document into the
 * minimal IR shape that `legacy_transform` consumes. The conversion is
 * deterministic and heuristic — no LLM call. Output drives the same
 * deterministic emission path as legacy migration:
 *
 *   parse doc → synthesize IR → legacy_transform → file map → write
 *
 * Heuristic rules:
 *   - Top-level `#` heading → feature name (the document title)
 *   - `##` heading → one scenario per heading
 *   - `###` heading → grouped under the parent `##` scenario as
 *     additional verification steps
 *   - "shall / must / should / will" sentences → individual scenarios
 *     when they appear under a `##`-scoped section without a deeper
 *     heading; merged as steps when they sit under a `###`
 *   - Bullet lists (`- `, `* `, `1. `) → enumerated steps under the
 *     containing scenario
 *   - "Given / When / Then" sentences are passed through verbatim
 *
 * The converter never invents test data or app URLs — the caller (the
 * mode handler) supplies project + feature names; the doc only drives
 * scenario titles and step text. The output IR has no `entry_point`,
 * which legacy_transform handles by emitting an empty Background.
 *
 * @module agent-platform/CSDocToIrConverter
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// IR Types — match the shape legacy_transform expects.
// (Kept inline rather than imported to avoid a circular dep.)
// ============================================================================

interface IRStep {
    action: string;
    expected?: string;
    rawLine?: string;
}

interface IRTest {
    id: string;
    name: string;
    description?: string;
    tags?: string[];
    steps: IRStep[];
}

interface IRPageObject {
    name: string;
    elements: Array<{
        field: string;
        locator_type: string;
        value: string;
        description?: string;
    }>;
}

interface IRInput {
    source: {
        path: string;
        language?: string;
        test_runner?: string;
        hash?: string;
    };
    tests: IRTest[];
    page_objects: IRPageObject[];
    entry_point?: {
        url_value?: string;
        url_key?: string;
        login_required?: boolean;
    };
    summary?: Record<string, unknown>;
}

export interface DocConversionResult {
    ir: IRInput;
    /** Top-level `#` heading or basename — the feature label. */
    featureName: string;
    /** Number of `##` headings + standalone `shall` sentences. */
    scenarioCount: number;
    /** Sub-section / bullet steps captured. */
    stepCount: number;
    /** Notes about anything skipped or heuristically inferred. */
    notes: string[];
}

// ============================================================================
// CSDocToIrConverter
// ============================================================================

export class CSDocToIrConverter {
    /**
     * Convert a markdown / plain-text document into IR. Section focus,
     * if supplied, narrows the conversion to a single `##` heading
     * (matched substring, case-insensitive).
     */
    public static convert(
        docPath: string,
        options: { sectionFocus?: string; sourceLanguage?: 'markdown' | 'text' } = {},
    ): DocConversionResult {
        const content = fs.readFileSync(docPath, 'utf-8');
        const lines = content.split(/\r?\n/);
        const notes: string[] = [];

        // -- Pass 1: structural parse — collect heading + body sections ---
        const sections = CSDocToIrConverter.collectSections(lines);
        const featureName = sections.title || path.basename(docPath, path.extname(docPath));

        // -- Pass 2: filter by sectionFocus, if any ----------------------
        let activeSections = sections.h2Sections;
        if (options.sectionFocus) {
            const needle = options.sectionFocus.toLowerCase();
            activeSections = sections.h2Sections.filter((s) =>
                s.title.toLowerCase().includes(needle),
            );
            if (activeSections.length === 0) {
                notes.push(
                    `No '##' section title matched sectionFocus='${options.sectionFocus}' (case-insensitive substring). Falling back to whole-document conversion.`,
                );
                activeSections = sections.h2Sections;
            }
        }

        // -- Pass 3: synthesize tests from sections ----------------------
        const tests: IRTest[] = [];
        let stepCount = 0;
        let nextScenarioIndex = 1;

        // If there are no `##` headings at all, fall back to "shall" sentences
        // or to the document body as one anonymous scenario.
        if (activeSections.length === 0 && sections.bodyLines.length > 0) {
            const requirementSentences = CSDocToIrConverter.extractRequirementSentences(
                sections.bodyLines,
            );
            if (requirementSentences.length > 0) {
                for (const sentence of requirementSentences) {
                    const id = `TS_${String(nextScenarioIndex).padStart(3, '0')}`;
                    nextScenarioIndex++;
                    const steps = CSDocToIrConverter.synthesizeStepsFromText([sentence]);
                    stepCount += steps.length;
                    tests.push({
                        id,
                        name: CSDocToIrConverter.titleCase(sentence.slice(0, 80)),
                        description: sentence,
                        tags: [],
                        steps,
                    });
                }
            } else {
                notes.push(
                    'Document had no `##` headings and no shall/must/should sentences — emitting a single placeholder scenario from the document body.',
                );
                const id = `TS_${String(nextScenarioIndex).padStart(3, '0')}`;
                nextScenarioIndex++;
                const steps = CSDocToIrConverter.synthesizeStepsFromText(sections.bodyLines);
                stepCount += steps.length;
                tests.push({
                    id,
                    name: featureName,
                    description: sections.bodyLines.slice(0, 3).join(' '),
                    tags: [],
                    steps,
                });
            }
        }

        // Otherwise, one scenario per `##` section.
        for (const section of activeSections) {
            const id = `TS_${String(nextScenarioIndex).padStart(3, '0')}`;
            nextScenarioIndex++;

            // If this section has `###` subsections, merge them in as additional steps.
            const sectionLines: string[] = [...section.bodyLines];
            for (const sub of section.h3Subsections) {
                sectionLines.push(`# Sub: ${sub.title}`);
                sectionLines.push(...sub.bodyLines);
            }

            const steps = CSDocToIrConverter.synthesizeStepsFromText(sectionLines);
            stepCount += steps.length;
            tests.push({
                id,
                name: section.title,
                description: section.bodyLines.slice(0, 2).join(' ').slice(0, 240),
                tags: section.tags,
                steps,
            });
        }

        if (tests.length === 0) {
            notes.push(
                'Empty doc or no extractable rules. Emitting an empty IR — legacy_transform will produce a feature stub for human authoring.',
            );
        }

        // -- Pass 4: build the IR envelope -------------------------------
        const hash = crypto
            .createHash('sha256')
            .update(content)
            .digest('hex')
            .slice(0, 16);

        const ir: IRInput = {
            source: {
                path: docPath,
                language: options.sourceLanguage ?? 'markdown',
                test_runner: 'document',
                hash: `sha256-${hash}`,
            },
            tests,
            page_objects: [],
            summary: {
                docTitle: featureName,
                sectionCount: sections.h2Sections.length,
                activeSectionCount: activeSections.length,
                shallSentencesFound: CSDocToIrConverter.countShallSentences(content),
            },
        };

        return {
            ir,
            featureName,
            scenarioCount: tests.length,
            stepCount,
            notes,
        };
    }

    // ------------------------------------------------------------------
    // Structural parser
    // ------------------------------------------------------------------

    private static collectSections(lines: string[]): {
        title: string | null;
        bodyLines: string[];
        h2Sections: Array<{
            title: string;
            tags: string[];
            bodyLines: string[];
            h3Subsections: Array<{ title: string; bodyLines: string[] }>;
        }>;
    } {
        let title: string | null = null;
        const bodyLines: string[] = [];
        const h2Sections: Array<{
            title: string;
            tags: string[];
            bodyLines: string[];
            h3Subsections: Array<{ title: string; bodyLines: string[] }>;
        }> = [];

        let currentH2: typeof h2Sections[0] | null = null;
        let currentH3: typeof h2Sections[0]['h3Subsections'][0] | null = null;

        for (const raw of lines) {
            const ln = raw.trimEnd();
            const h1 = /^#\s+(.+)$/.exec(ln);
            const h2 = /^##\s+(.+)$/.exec(ln);
            const h3 = /^###\s+(.+)$/.exec(ln);

            if (h1) {
                if (!title) title = h1[1].trim();
                currentH2 = null;
                currentH3 = null;
                continue;
            }
            if (h2) {
                const fullTitle = h2[1].trim();
                const { cleanTitle, tags } = CSDocToIrConverter.extractTags(fullTitle);
                currentH2 = {
                    title: cleanTitle,
                    tags,
                    bodyLines: [],
                    h3Subsections: [],
                };
                h2Sections.push(currentH2);
                currentH3 = null;
                continue;
            }
            if (h3 && currentH2) {
                currentH3 = { title: h3[1].trim(), bodyLines: [] };
                currentH2.h3Subsections.push(currentH3);
                continue;
            }
            // Body line — route to current scope.
            if (currentH3) {
                currentH3.bodyLines.push(ln);
            } else if (currentH2) {
                currentH2.bodyLines.push(ln);
            } else {
                bodyLines.push(ln);
            }
        }

        return { title, bodyLines, h2Sections };
    }

    /**
     * `## Login flow @smoke @critical` → title='Login flow', tags=['@smoke', '@critical']
     */
    private static extractTags(rawTitle: string): { cleanTitle: string; tags: string[] } {
        const tagRe = /(@[\w-]+)/g;
        const tags: string[] = [];
        let match: RegExpExecArray | null;
        while ((match = tagRe.exec(rawTitle)) !== null) tags.push(match[1]);
        const cleanTitle = rawTitle.replace(/\s*@[\w-]+/g, '').trim();
        return { cleanTitle: cleanTitle || rawTitle, tags };
    }

    // ------------------------------------------------------------------
    // Step synthesis
    // ------------------------------------------------------------------

    /**
     * From a block of body lines, emit a list of IR steps. Recognises:
     *   - Bullet items → numbered When-style steps
     *   - "shall / must / should / will" sentences → Then-style verifications
     *   - "Given / When / Then" → preserved verbatim
     * Lines that don't match any heuristic are ignored (most prose is
     * narrative, not test instructions).
     */
    private static synthesizeStepsFromText(lines: string[]): IRStep[] {
        const steps: IRStep[] = [];
        for (const raw of lines) {
            const ln = raw.trim();
            if (!ln) continue;

            const gwt = /^(Given|When|Then|And|But)\s+(.+)$/i.exec(ln);
            if (gwt) {
                const keyword = gwt[1];
                const body = gwt[2].trim();
                steps.push({
                    action: keyword.toLowerCase().startsWith('then')
                        ? `verify ${body}`
                        : `do ${body}`,
                    expected: keyword.toLowerCase().startsWith('then') ? body : undefined,
                    rawLine: ln,
                });
                continue;
            }

            const bullet = /^\s*[-*]\s+(.+)$/.exec(ln) ?? /^\s*\d+[.)]\s+(.+)$/.exec(ln);
            if (bullet) {
                steps.push({
                    action: `do ${bullet[1].trim()}`,
                    rawLine: ln,
                });
                continue;
            }

            const shall = /^([A-Z][^.]+?)\s+(?:shall|must|should|will)\s+(.+?)\.?$/i.exec(ln);
            if (shall) {
                steps.push({
                    action: `verify ${shall[1].trim()} ${shall[2].trim()}`,
                    expected: `${shall[1].trim()} ${shall[2].trim()}`,
                    rawLine: ln,
                });
                continue;
            }
            // Otherwise: skip narrative prose.
        }
        return steps;
    }

    // ------------------------------------------------------------------
    // Misc helpers
    // ------------------------------------------------------------------

    private static extractRequirementSentences(lines: string[]): string[] {
        const out: string[] = [];
        const re = /([A-Z][^.!?]*?\s+(?:shall|must|should|will)\s+[^.!?]+[.!?])/g;
        for (const ln of lines) {
            let m: RegExpExecArray | null;
            while ((m = re.exec(ln)) !== null) {
                out.push(m[1].trim());
            }
        }
        return out;
    }

    private static countShallSentences(content: string): number {
        const re = /\b(?:shall|must|should|will)\b/gi;
        return (content.match(re) ?? []).length;
    }

    private static titleCase(s: string): string {
        return s.replace(/\b\w/g, (c) => c.toUpperCase()).trim();
    }
}
