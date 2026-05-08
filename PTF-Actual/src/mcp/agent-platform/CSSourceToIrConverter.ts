/**
 * Agentic Test Platform — Source → IR converter
 *
 * Converts an existing TypeScript page-object / source file into the
 * minimal IR shape that `legacy_transform` consumes. Handles two cases:
 *
 *   1. The source file is a CS Playwright page object (decorated with
 *      `@CSPage` / `@CSGetElement`) → extract elements + public methods
 *      and emit a one-page-object IR with stub scenarios per method
 *
 *   2. The source file is a controller / view / service in the
 *      application under test (Java, JSP, .ts) → emit a placeholder
 *      IR + a note telling the user to provide a requirements doc
 *      instead, since auto-inferring scenarios from random source is
 *      brittle without business intent
 *
 * Same architecture as CSDocToIrConverter: deterministic, no LLM.
 *
 * @module agent-platform/CSSourceToIrConverter
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// IR Types — keep inline to avoid circular dep on transform tool's types.
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
    summary?: Record<string, unknown>;
}

export interface SourceConversionResult {
    ir: IRInput;
    featureName: string;
    /** True iff input looked like a CS Playwright page object (decorators present). */
    detectedAsPageObject: boolean;
    /** Public methods discovered (used as scenario stubs). */
    publicMethods: string[];
    notes: string[];
}

// ============================================================================
// CSSourceToIrConverter
// ============================================================================

export class CSSourceToIrConverter {
    /**
     * Convert a TS / Java / JSP source file into IR. The choice of
     * extractor is driven by the file extension and content sniffing —
     * `.ts` with `@CSPage` decorator → page-object extractor, anything
     * else → placeholder + note.
     */
    public static convert(
        sourcePath: string,
        options: { targetSurface?: 'ui' | 'api' | 'both' } = {},
    ): SourceConversionResult {
        const content = fs.readFileSync(sourcePath, 'utf-8');
        const ext = path.extname(sourcePath).toLowerCase();
        const featureName = path
            .basename(sourcePath)
            .replace(/\.(ts|tsx|js|java|jsp|py|cs)$/i, '')
            .replace(/[^A-Za-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .toLowerCase();

        const notes: string[] = [];
        const detectedAsPageObject =
            ext === '.ts' && /@CSPage\s*\(/.test(content) && /@CSGetElement/.test(content);

        const hash = crypto
            .createHash('sha256')
            .update(content)
            .digest('hex')
            .slice(0, 16);

        if (detectedAsPageObject) {
            const className =
                CSSourceToIrConverter.extractClassName(content) ?? featureName;
            const pageId = CSSourceToIrConverter.extractPageId(content) ?? featureName;
            const elements = CSSourceToIrConverter.extractElements(content);
            const methods = CSSourceToIrConverter.extractPublicMethods(content);

            // Build one stub scenario per public method — the user will
            // refine assertions; we only emit the action skeleton.
            const tests: IRTest[] = methods.map((m, i) => ({
                id: `TS_${String(i + 1).padStart(3, '0')}`,
                name: CSSourceToIrConverter.humanise(m.name),
                description: `Auto-generated scenario stub for ${className}.${m.name}()`,
                tags: [`@${className}`],
                steps: [
                    {
                        action: `do invoke ${m.name}()`,
                        rawLine: `${className}.${m.name}(${m.params})`,
                    },
                    {
                        action: `verify the action completes without error`,
                        expected: 'no exception thrown',
                    },
                ],
            }));

            const irPageObject: IRPageObject = {
                name: pageId,
                elements: elements.map((e) => ({
                    field: e.name,
                    locator_type: 'xpath',
                    value: e.xpath ?? '',
                    description: e.description ?? `Element ${e.name}`,
                })),
            };

            const ir: IRInput = {
                source: {
                    path: sourcePath,
                    language: 'typescript',
                    test_runner: 'page-object',
                    hash: `sha256-${hash}`,
                },
                tests,
                page_objects: [irPageObject],
                summary: {
                    detectedAs: 'cs-playwright-page-object',
                    className,
                    pageId,
                    elementCount: elements.length,
                    methodCount: methods.length,
                    targetSurface: options.targetSurface ?? 'ui',
                },
            };

            notes.push(
                `Source recognised as CS Playwright page object. Extracted ${elements.length} element(s) and ${methods.length} public method(s). Each method becomes a stub scenario — refine the verification step before merging.`,
            );

            return {
                ir,
                featureName,
                detectedAsPageObject: true,
                publicMethods: methods.map((m) => m.name),
                notes,
            };
        }

        // Non-page-object source — controller, view, service. We can't
        // infer business intent from random source. Emit a placeholder IR
        // and surface a note pointing the user at document_path mode.
        notes.push(
            'Source did not match the CS Playwright page-object pattern (no @CSPage / @CSGetElement decorators). Auto-inferring scenarios from controller / view / service source is unreliable without a paired requirements document. Re-invoke with document_path mode pointing at a spec, or natural_language_chat with a description of what to test.',
        );

        const ir: IRInput = {
            source: {
                path: sourcePath,
                language: ext.slice(1) || 'unknown',
                test_runner: 'source-passive',
                hash: `sha256-${hash}`,
            },
            tests: [
                {
                    id: 'TS_001',
                    name: featureName,
                    description: `Placeholder scenario for ${path.basename(sourcePath)} — refine with real test intent.`,
                    tags: [],
                    steps: [
                        {
                            action: `do navigate to {config:APP_URL}`,
                            rawLine: 'placeholder',
                        },
                        {
                            action: 'verify the expected outcome',
                            expected: 'TODO: replace with real assertion',
                        },
                    ],
                },
            ],
            page_objects: [],
            summary: {
                detectedAs: 'unknown-source',
                fileType: ext,
                targetSurface: options.targetSurface ?? 'ui',
            },
        };

        return {
            ir,
            featureName,
            detectedAsPageObject: false,
            publicMethods: [],
            notes,
        };
    }

    // ------------------------------------------------------------------
    // Page-object extractors — match CSRepoInventory's regex contracts.
    // ------------------------------------------------------------------

    private static extractClassName(content: string): string | null {
        const m = /\bexport\s+class\s+([A-Z][A-Za-z0-9_]*)/.exec(content);
        return m ? m[1] : null;
    }

    private static extractPageId(content: string): string | null {
        // Backreferenced quote pair to handle inner quotes correctly.
        const m = /@CSPage\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1\s*\)/.exec(content);
        return m ? m[2] : null;
    }

    private static extractElements(
        content: string,
    ): Array<{ name: string; xpath?: string; description?: string }> {
        const elements: Array<{ name: string; xpath?: string; description?: string }> = [];
        const re = /@CSGetElement\s*\(\s*\{([\s\S]*?)\}\s*\)\s*(?:public|private|protected)?\s*([A-Za-z_$][\w$]*)\s*[!:]/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(content)) !== null) {
            const optionsBlock = m[1];
            const fieldName = m[2];
            elements.push({
                name: fieldName,
                xpath: CSSourceToIrConverter.extractKeyString(optionsBlock, 'xpath'),
                description: CSSourceToIrConverter.extractKeyString(optionsBlock, 'description'),
            });
        }
        return elements;
    }

    private static extractKeyString(block: string, key: string): string | undefined {
        const re = new RegExp(
            `\\b${key}\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1).)*)\\1`,
        );
        const m = re.exec(block);
        return m ? m[2] : undefined;
    }

    /**
     * Extract public methods from a TS class. Skips the constructor and
     * any method named `getElement` / `waitFor*` / etc. that the framework
     * provides via inheritance.
     */
    private static extractPublicMethods(
        content: string,
    ): Array<{ name: string; params: string }> {
        const methods: Array<{ name: string; params: string }> = [];
        // Match `public async X(): Promise<Y>` or `public X(...) {` or `async X(...)`
        const re = /^\s*(?:public\s+)?(?:async\s+)?([a-z][\w$]*)\s*\(([^)]*)\)\s*(?::\s*Promise<[^>]+>)?\s*\{/gm;
        let m: RegExpExecArray | null;
        const skip = new Set([
            'constructor',
            'navigate',
            'navigateTo',
            'waitFor',
            'getElement',
            'isAt',
        ]);
        while ((m = re.exec(content)) !== null) {
            const name = m[1];
            const params = m[2].trim();
            if (skip.has(name)) continue;
            // Skip if it's clearly an arrow function in a property
            // assignment or other non-method context.
            if (/=\s*$/.test(content.slice(Math.max(0, m.index - 8), m.index))) continue;
            methods.push({ name, params });
        }
        return methods;
    }

    private static humanise(name: string): string {
        return name
            .replace(/([A-Z])/g, ' $1')
            .replace(/^./, (c) => c.toUpperCase())
            .trim();
    }
}
