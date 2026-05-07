/**
 * Agentic Test Platform — Page Object Composer
 *
 * Composes a TypeScript page-object source file from a Gherkin translation
 * plus a source-grounding map. Output uses the framework decorators
 * (`@CSPage`, `@CSGetElement`) and instance helpers (`this.elementByXPath`),
 * never raw Playwright APIs.
 *
 * Source-grounded elements yield real XPaths + CSS alternatives. Elements
 * that lack a grounding hit emit an XPath placeholder plus a
 * `// @needs-source-validation: <hint>` comment, and the artefact's
 * `needsSourceValidation` flag is set so the feature-file composer can add
 * a matching `@needs-source-validation` Gherkin tag.
 *
 * Privacy-by-design: all examples use generic placeholders. No domain or
 * project identifiers are embedded.
 *
 * @module agent-platform/CSPageObjectComposer
 */

import * as path from 'path';
import { MCPToolContext } from '../types/CSMCPTypes';
import { GherkinTranslation } from './CSStepToGherkinTranslator';
import { SourceGroundedElement, SourceGroundingMap } from './CSSourceGrounder';

// ============================================================================
// Public Types
// ============================================================================

/**
 * One generated page-object artefact, ready to write to disk.
 */
export interface PageObjectArtifact {
    filePath: string;
    content: string;
    imports: string[];
    className: string;
    elements: {
        name: string;
        locator: string;
        alternativeLocators: string[];
        description: string;
    }[];
    methods: { name: string; signature: string; body: string }[];
    framePages: { name: string; frame: string }[];
    needsSourceValidation: boolean;
}

// ============================================================================
// Verb extraction (drives generated method names)
// ============================================================================

/**
 * Map a step-phrase prefix to a method-name verb. Order matters — we pick
 * the first match.
 */
const VERB_TABLE: { re: RegExp; verb: string }[] = [
    { re: /^(?:click|tap|press)\b/i, verb: 'click' },
    { re: /^(?:fill|enter|type|input)\b/i, verb: 'fill' },
    { re: /^select\b/i, verb: 'select' },
    { re: /^upload\b/i, verb: 'upload' },
    { re: /^submit\b/i, verb: 'submit' },
    { re: /^choose\b/i, verb: 'choose' },
    { re: /^navigat(?:e|ing)\s+to\b/i, verb: 'navigateTo' },
    { re: /^open(?:s|ed)?\b/i, verb: 'open' },
    { re: /^verify\b/i, verb: 'verify' },
    { re: /^validate\b/i, verb: 'validate' },
    { re: /^see\b/i, verb: 'see' },
    { re: /^should\s+be\b/i, verb: 'expect' },
    { re: /^expect\b/i, verb: 'expect' },
];

// ============================================================================
// CSPageObjectComposer
// ============================================================================

/**
 * Static composer. Single public entry point: `compose`. Returns an
 * artefact whose `content` is ready to write to disk; the caller (the
 * orchestrator) owns the I/O side-effects.
 */
export class CSPageObjectComposer {
    /**
     * Compose a page object from the supplied translation + grounding.
     *
     * @param moduleName  Module name (used for the page registration key).
     * @param pageName    PascalCase page name (e.g. "Login", "Dashboard").
     * @param translation The Gherkin translation produced upstream.
     * @param grounding   Source grounding map (may be empty).
     * @param context     MCP tool context (used only for logging).
     */
    public static async compose(
        moduleName: string,
        pageName: string,
        translation: GherkinTranslation,
        grounding: SourceGroundingMap,
        context: MCPToolContext,
    ): Promise<PageObjectArtifact> {
        const className = `${CSPageObjectComposer.pascal(pageName)}Page`;
        const allSteps = [
            ...translation.given,
            ...translation.when,
            ...translation.then,
        ];

        // -- Element discovery -----------------------------------------------
        const elements: PageObjectArtifact['elements'] = [];
        const seenElementKeys = new Set<string>();
        let needsSourceValidation = false;

        for (const step of allSteps) {
            const desc = CSPageObjectComposer.extractElementDescription(step);
            if (!desc) continue;
            const key = desc.toLowerCase();
            if (seenElementKeys.has(key)) continue;
            seenElementKeys.add(key);

            const grounded = CSPageObjectComposer.lookupGrounded(desc, grounding);
            if (grounded) {
                elements.push({
                    name: CSPageObjectComposer.elementName(desc),
                    locator: grounded.primaryLocator,
                    alternativeLocators: grounded.alternativeLocators,
                    description: desc,
                });
            } else {
                needsSourceValidation = true;
                elements.push({
                    name: CSPageObjectComposer.elementName(desc),
                    locator: `//*[@id='<TODO_${CSPageObjectComposer.elementName(desc)}>']`,
                    alternativeLocators: [],
                    description: desc,
                });
            }
        }

        // -- Method discovery ------------------------------------------------
        const methods: PageObjectArtifact['methods'] = [];
        const seenMethodNames = new Set<string>();

        for (const step of allSteps) {
            const m = CSPageObjectComposer.deriveMethod(step, elements);
            if (!m) continue;
            if (seenMethodNames.has(m.name)) continue;
            seenMethodNames.add(m.name);
            methods.push(m);
        }

        // -- Render TS source ------------------------------------------------
        const moduleSlug = CSPageObjectComposer.slugify(moduleName);
        const pageSlug = CSPageObjectComposer.slugify(pageName);
        const registrationKey = `${moduleSlug}-${pageSlug}`;

        const imports = [
            "import { CSPage, CSGetElement, CSBasePage, CSWebElement } from '@mdakhan.mak/cs-playwright-test-framework/core';",
        ];

        const elementsSrc = elements
            .map((e) => CSPageObjectComposer.renderElement(e, !grounding.elements.size))
            .join('\n\n');

        const methodsSrc = methods
            .map((m) => CSPageObjectComposer.renderMethod(m))
            .join('\n\n');

        const header = needsSourceValidation
            ? '// @needs-source-validation: one or more elements are scaffolded;\n' +
              '// replace TODO XPaths with verified locators before merge.\n'
            : '';

        const content =
            `${imports.join('\n')}\n\n` +
            `${header}` +
            `@CSPage('${registrationKey}')\n` +
            `export class ${className} extends CSBasePage {\n` +
            `${CSPageObjectComposer.indent(elementsSrc, 4)}\n\n` +
            `${CSPageObjectComposer.indent(methodsSrc, 4)}\n` +
            `}\n`;

        const filePath = path.posix.join(
            'pages',
            moduleSlug,
            `${className}.ts`,
        );

        context.log('debug', 'CSPageObjectComposer: composed', {
            className,
            elementCount: elements.length,
            methodCount: methods.length,
            needsSourceValidation,
        });

        return {
            filePath,
            content,
            imports,
            className,
            elements,
            methods,
            framePages: [],
            needsSourceValidation,
        };
    }

    // ========================================================================
    // Element discovery
    // ========================================================================

    /**
     * Pull the most likely element description out of a step phrase.
     * Strategy:
     *   - quoted text wins ("Login" button → Login)
     *   - nouns immediately preceding "button|link|field|input|dropdown" win next
     *   - else, the trailing noun phrase
     */
    private static extractElementDescription(step: string): string | null {
        const quoted = step.match(/"([^"]{1,60})"/);
        if (quoted) return quoted[1].trim();

        const labeledRe =
            /\b(?:the\s+)?([A-Za-z][A-Za-z0-9 _-]{1,40}?)\s+(button|link|field|input|dropdown|checkbox|radio|menu|tab|icon)\b/i;
        const m = step.match(labeledRe);
        if (m) return m[1].trim();

        // Fallback: last noun-phrase candidate after a verb.
        const tail = step.match(/(?:click|fill|enter|select|verify|see)\s+(?:the\s+)?([A-Za-z][A-Za-z0-9 _-]{2,40})/i);
        if (tail) return tail[1].trim();

        return null;
    }

    /**
     * Look up an element description in the grounding map. Tries exact
     * lowercase match first, then falls back to substring search.
     */
    private static lookupGrounded(
        description: string,
        grounding: SourceGroundingMap,
    ): SourceGroundedElement | null {
        if (!grounding || grounding.elements.size === 0) return null;
        const key = description.toLowerCase();
        const direct = grounding.elements.get(key);
        if (direct) return direct;
        for (const [k, v] of grounding.elements) {
            if (k.includes(key) || key.includes(k)) return v;
        }
        return null;
    }

    // ========================================================================
    // Method derivation
    // ========================================================================

    /**
     * Derive a method skeleton from a step phrase. Returns null if the
     * step does not warrant a dedicated method (e.g. a simple navigation
     * step that the framework's default Given handler covers).
     */
    private static deriveMethod(
        step: string,
        elements: PageObjectArtifact['elements'],
    ): PageObjectArtifact['methods'][number] | null {
        const verbEntry = VERB_TABLE.find((v) => v.re.test(step));
        if (!verbEntry) return null;

        const desc = CSPageObjectComposer.extractElementDescription(step) ?? '';
        const elName = desc
            ? CSPageObjectComposer.elementName(desc)
            : '';
        const elementMatch = elements.find((e) => e.name === elName);

        const methodName = `${verbEntry.verb}${
            CSPageObjectComposer.pascal(desc || verbEntry.verb)
        }`;

        // Pick a body shape based on verb.
        let body: string;
        let signature: string;

        switch (verbEntry.verb) {
            case 'click':
            case 'submit':
            case 'choose':
            case 'open':
                signature = `(): Promise<void>`;
                body = elementMatch
                    ? `await this.${elName}.clickWithTimeout(30000);`
                    : `// @needs-source-validation: click target not grounded\n` +
                      `await this.elementByXPath('${CSPageObjectComposer.escTs("//*[@id='<TODO>']")}').clickWithTimeout(30000);`;
                break;
            case 'fill':
                signature = `(value: string): Promise<void>`;
                body = elementMatch
                    ? `await this.${elName}.fillWithTimeout(value, 30000);`
                    : `// @needs-source-validation: fill target not grounded\n` +
                      `await this.elementByXPath('${CSPageObjectComposer.escTs("//*[@id='<TODO>']")}').fillWithTimeout(value, 30000);`;
                break;
            case 'select':
                signature = `(label: string): Promise<void>`;
                body = elementMatch
                    ? `await this.${elName}.selectOptionByLabel(label);`
                    : `// @needs-source-validation: select target not grounded\n` +
                      `await this.elementByXPath('${CSPageObjectComposer.escTs("//*[@id='<TODO>']")}').selectOptionByLabel(label);`;
                break;
            case 'upload':
                signature = `(filePath: string): Promise<void>`;
                body = elementMatch
                    ? `await this.${elName}.uploadFile(filePath);`
                    : `// @needs-source-validation: upload target not grounded\n` +
                      `await this.elementByXPath('${CSPageObjectComposer.escTs("//*[@id='<TODO>']")}').uploadFile(filePath);`;
                break;
            case 'verify':
            case 'validate':
            case 'see':
            case 'expect':
                signature = `(): Promise<void>`;
                body = elementMatch
                    ? `await this.${elName}.shouldBeVisible();`
                    : `// @needs-source-validation: verification target not grounded\n` +
                      `await this.elementByXPath('${CSPageObjectComposer.escTs("//*[@id='<TODO>']")}').shouldBeVisible();`;
                break;
            case 'navigateTo':
                signature = `(url: string): Promise<void>`;
                body = `await this.navigateTo(url);`;
                break;
            default:
                signature = `(): Promise<void>`;
                body = `// composed step body\n// TODO: implement`;
        }

        return { name: methodName, signature, body };
    }

    // ========================================================================
    // Rendering helpers
    // ========================================================================

    private static renderElement(
        e: PageObjectArtifact['elements'][number],
        scaffold: boolean,
    ): string {
        const altSrc =
            e.alternativeLocators.length > 0
                ? `, alternativeLocators: ${JSON.stringify(e.alternativeLocators)}`
                : '';
        const validateNote = scaffold
            ? '// @needs-source-validation: replace placeholder XPath with grounded value\n'
            : '';
        return (
            `${validateNote}@CSGetElement({ xpath: '${CSPageObjectComposer.escTs(e.locator)}'${altSrc}, description: '${CSPageObjectComposer.escTs(e.description)}' })\n` +
            `public ${e.name}!: CSWebElement;`
        );
    }

    private static renderMethod(
        m: PageObjectArtifact['methods'][number],
    ): string {
        return (
            `public async ${m.name}${m.signature} {\n` +
            `${CSPageObjectComposer.indent(m.body, 4)}\n` +
            `}`
        );
    }

    // ========================================================================
    // Naming / formatting helpers
    // ========================================================================

    private static elementName(description: string): string {
        const camel = CSPageObjectComposer.camel(description);
        if (/^[a-z]/.test(camel)) return camel;
        return `el${CSPageObjectComposer.pascal(description)}`;
    }

    private static pascal(s: string): string {
        return s
            .replace(/[^A-Za-z0-9]+/g, ' ')
            .trim()
            .split(/\s+/)
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
            .join('');
    }

    private static camel(s: string): string {
        const p = CSPageObjectComposer.pascal(s);
        return p.charAt(0).toLowerCase() + p.slice(1);
    }

    private static slugify(s: string): string {
        return s
            .replace(/[^A-Za-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .toLowerCase();
    }

    private static escTs(s: string): string {
        return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    }

    private static indent(s: string, n: number): string {
        const pad = ' '.repeat(n);
        return s
            .split('\n')
            .map((l) => (l.length > 0 ? pad + l : l))
            .join('\n');
    }
}
