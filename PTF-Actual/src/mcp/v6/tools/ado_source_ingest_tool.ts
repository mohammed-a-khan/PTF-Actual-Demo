/**
 * cs_qa_source_ingest — walks an application source tree and extracts a
 * source-of-truth model (endpoints, screens, validators, entities, messages)
 * to `.cs-qa/source-model/model.json`.
 *
 * The output is what a source-grounded generator reads to emit tests whose
 * xpaths/assertions/data-shapes match the real app, instead of hallucinating
 * against the AC text alone.
 *
 * Every extracted symbol carries a filePath + lineNumber cite. Every message-
 * bundle literal is parsed from the actual .properties/.yml file — never
 * fabricated. Files larger than the size guard are skipped with a warning.
 *
 * On-prem safe — pure file IO; no network calls.
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import { createLogger } from './_helpers/structured_logger';
import { bulkExecute } from './_helpers/bulk_batcher';
import { parseJavaFile, JavaController, JavaEntity, JavaValidator, JavaService, JavaDto, JavaField } from './_helpers/source_parsers/java_parser';
import { parseJspFile } from './_helpers/source_parsers/jsp_parser';
import { parseThymeleafFile } from './_helpers/source_parsers/thymeleaf_parser';
import { parseTsFile } from './_helpers/source_parsers/ts_parser';
import { parseProperties, parseYamlMessages, ParsedMessages } from './_helpers/source_parsers/properties_parser';
import { parseHbmFile } from './_helpers/source_parsers/hbm_parser';
import { parseCsFile } from './_helpers/source_parsers/cs_parser';

// -----------------------------------------------------------------------------
// Public model shape.
// -----------------------------------------------------------------------------

const FieldSchema = z.object({
    name: z.string(),
    type: z.string(),
    dbColumn: z.string().nullable(),
    nullable: z.boolean(),
    length: z.number().nullable(),
    isPk: z.boolean(),
    isFk: z.boolean(),
    fkTarget: z.string().nullable(),
    lineNumber: z.number(),
    constraints: z.array(z.object({
        kind: z.string(),
        args: z.record(z.string(), z.string()),
        errorMessageKey: z.string().nullable(),
        errorMessageLiteral: z.string().nullable(),
    })).default([]),
});

const EndpointSchema = z.object({
    id: z.string(),
    verb: z.string(),
    path: z.string(),
    controllerClass: z.string(),
    methodName: z.string(),
    requestDto: z.object({
        className: z.string(),
        fields: z.array(FieldSchema),
    }).nullable(),
    responseDto: z.object({
        className: z.string(),
        fields: z.array(FieldSchema),
    }).nullable(),
    validators: z.array(z.string()),
    pathVariables: z.array(z.string()),
    requestParams: z.array(z.string()),
    filePath: z.string(),
    lineNumber: z.number(),
});

const FormFieldSchema = z.object({
    id: z.string().nullable(),
    name: z.string().nullable(),
    tag: z.string(),
    type: z.string().nullable(),
    label: z.string().nullable(),
    messageKey: z.string().nullable(),
    required: z.boolean(),
    maxLength: z.number().nullable(),
    pattern: z.string().nullable(),
    lineNumber: z.number(),
});

const ScreenSchema = z.object({
    id: z.string(),
    screenName: z.string(),
    filePath: z.string(),
    forms: z.array(z.object({
        formId: z.string().nullable(),
        action: z.string().nullable(),
        method: z.string().nullable(),
        fields: z.array(FormFieldSchema),
        submitButtonId: z.string().nullable(),
        tables: z.array(z.object({
            id: z.string().nullable(),
            columns: z.array(z.object({ header: z.string(), boundField: z.string().nullable() })),
        })),
    })),
    navigation: z.array(z.object({ linkText: z.string(), href: z.string() })),
});

const ValidatorSchema = z.object({
    className: z.string(),
    filePath: z.string(),
    constraints: z.array(z.object({
        field: z.string(),
        kind: z.string(),
        args: z.record(z.string(), z.string()),
        errorMessageKey: z.string().nullable(),
        errorMessageLiteral: z.string().nullable(),
    })),
});

const EntitySchema = z.object({
    className: z.string(),
    tableName: z.string().nullable(),
    filePath: z.string(),
    columns: z.array(FieldSchema),
});

const ServiceSchema = z.object({
    className: z.string(),
    filePath: z.string(),
    kind: z.string(),
    calls: z.array(z.object({
        methodName: z.string(),
        callsService: z.string().nullable(),
        callsRepo: z.string().nullable(),
        callsValidator: z.string().nullable(),
    })),
});

const RouteSchema = z.object({
    path: z.string(),
    componentClass: z.string(),
    filePath: z.string(),
    lineNumber: z.number(),
});

const ModelSchema = z.object({
    ingestedAt: z.string(),
    sourceRoot: z.string(),
    languageStats: z.record(z.string(), z.object({ fileCount: z.number(), byteCount: z.number() })),
    endpoints: z.array(EndpointSchema),
    screens: z.array(ScreenSchema),
    validators: z.array(ValidatorSchema),
    entities: z.array(EntitySchema),
    messages: z.record(z.string(), z.record(z.string(), z.string())),
    services: z.array(ServiceSchema),
    routes: z.array(RouteSchema),
    warnings: z.array(z.string()),
    parseErrors: z.array(z.object({ filePath: z.string(), error: z.string() })),
});

export type SourceModel = z.infer<typeof ModelSchema>;

// -----------------------------------------------------------------------------
// File walker.
// -----------------------------------------------------------------------------

const DEFAULT_EXCLUDES = new Set(['node_modules', 'dist', 'build', 'target', 'out', 'bin', 'obj', '.git', '.idea', '.vscode', '.gradle', '.mvn']);
const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MB per file

interface DiscoveredFile {
    absPath: string;
    ext: string;
    kind: 'java' | 'jsp' | 'thymeleaf' | 'ts' | 'properties' | 'yaml' | 'hbm' | 'cs' | 'other';
    size: number;
}

function classifyExt(absPath: string): DiscoveredFile['kind'] {
    const lower = absPath.toLowerCase();
    if (lower.endsWith('.java')) return 'java';
    if (lower.endsWith('.jsp') || lower.endsWith('.jspx') || lower.endsWith('.tag')) return 'jsp';
    if (lower.endsWith('.ts') || lower.endsWith('.tsx') || lower.endsWith('.js') || lower.endsWith('.jsx')) return 'ts';
    if (lower.endsWith('.properties')) return 'properties';
    if (lower.endsWith('.yml') || lower.endsWith('.yaml')) return 'yaml';
    if (lower.endsWith('.hbm.xml')) return 'hbm';
    if (lower.endsWith('.cs')) return 'cs';
    if (lower.endsWith('.html') || lower.endsWith('.htm')) {
        return /\/templates\//.test(lower) ? 'thymeleaf' : 'other';
    }
    return 'other';
}

function walkTree(root: string, excludes: Set<string>): DiscoveredFile[] {
    const out: DiscoveredFile[] = [];
    const queue: string[] = [root];
    while (queue.length > 0) {
        const dir = queue.shift() as string;
        let ents: fs.Dirent[];
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { continue; }
        for (const e of ents) {
            if (excludes.has(e.name)) continue;
            if (e.name.startsWith('.')) {
                if (!['.classpath', '.project', '.settings'].includes(e.name)) continue;
            }
            const abs = path.join(dir, e.name);
            if (e.isDirectory()) queue.push(abs);
            else if (e.isFile()) {
                let stat: fs.Stats;
                try { stat = fs.statSync(abs); } catch { continue; }
                const kind = classifyExt(abs);
                if (kind === 'other') continue;
                out.push({ absPath: abs, ext: path.extname(e.name), kind, size: stat.size });
            }
        }
    }
    return out;
}

function readFileSafe(abs: string, maxBytes: number = MAX_FILE_BYTES): { content: string | null; warning?: string } {
    try {
        const st = fs.statSync(abs);
        if (st.size > maxBytes) return { content: null, warning: `skipped-large-file (${st.size} bytes): ${abs}` };
        const buf = fs.readFileSync(abs);
        return { content: buf.toString('utf-8') };
    } catch (e) {
        return { content: null, warning: `read-failed: ${abs}: ${(e as Error).message}` };
    }
}

// -----------------------------------------------------------------------------
// Language pipelines.
// -----------------------------------------------------------------------------

interface IngestState {
    endpoints: z.infer<typeof EndpointSchema>[];
    screens: z.infer<typeof ScreenSchema>[];
    validators: z.infer<typeof ValidatorSchema>[];
    entities: z.infer<typeof EntitySchema>[];
    services: z.infer<typeof ServiceSchema>[];
    messages: Record<string, Record<string, string>>;
    routes: z.infer<typeof RouteSchema>[];
    parseErrors: Array<{ filePath: string; error: string }>;
    warnings: string[];
    languageStats: Record<string, { fileCount: number; byteCount: number }>;
    // Cross-file registries used by later passes.
    dtoRegistry: Map<string, { className: string; filePath: string; fields: z.infer<typeof FieldSchema>[] }>;
}

function newState(): IngestState {
    return {
        endpoints: [], screens: [], validators: [], entities: [], services: [], routes: [],
        messages: {},
        parseErrors: [], warnings: [],
        languageStats: {},
        dtoRegistry: new Map(),
    };
}

function bumpStat(state: IngestState, lang: string, bytes: number) {
    const cur = state.languageStats[lang] || { fileCount: 0, byteCount: 0 };
    cur.fileCount++;
    cur.byteCount += bytes;
    state.languageStats[lang] = cur;
}

function normalizeConstraint(c: JavaField['constraints'][number]): z.infer<typeof FieldSchema>['constraints'][number] {
    return {
        kind: c.kind,
        args: Object.fromEntries(Object.entries(c.args).map(([k, v]) => [k, String(v)])),
        errorMessageKey: c.errorMessageKey,
        errorMessageLiteral: c.errorMessageLiteral,
    };
}

function toFieldSchema(f: JavaField): z.infer<typeof FieldSchema> {
    return {
        name: f.name, type: f.type,
        dbColumn: f.dbColumn, nullable: f.nullable, length: f.length,
        isPk: f.isPk, isFk: f.isFk, fkTarget: f.fkTarget,
        lineNumber: f.lineNumber,
        constraints: (f.constraints || []).map(normalizeConstraint),
    };
}

function processJavaFile(state: IngestState, file: DiscoveredFile) {
    const rd = readFileSafe(file.absPath);
    if (rd.warning) state.warnings.push(rd.warning);
    if (rd.content === null) return;
    bumpStat(state, 'java', file.size);

    let parsed;
    try {
        parsed = parseJavaFile(file.absPath, rd.content);
    } catch (e) {
        state.parseErrors.push({ filePath: file.absPath, error: (e as Error).message });
        return;
    }

    for (const w of parsed.warnings) state.warnings.push(`${file.absPath}: ${w}`);

    // DTOs registered for later cross-linking to endpoints.
    for (const dto of parsed.dtos as JavaDto[]) {
        state.dtoRegistry.set(dto.className, {
            className: dto.className,
            filePath: dto.filePath,
            fields: dto.fields.map(toFieldSchema),
        });
    }

    for (const ent of parsed.entities as JavaEntity[]) {
        state.entities.push({
            className: ent.className,
            tableName: ent.tableName,
            filePath: ent.filePath,
            columns: ent.fields.map(toFieldSchema),
        });
        // Entity itself may serve as a DTO in simple apps.
        if (!state.dtoRegistry.has(ent.className)) {
            state.dtoRegistry.set(ent.className, {
                className: ent.className, filePath: ent.filePath,
                fields: ent.fields.map(toFieldSchema),
            });
        }
    }

    for (const ctrl of parsed.controllers as JavaController[]) {
        for (const m of ctrl.methods) {
            const reqDto = m.requestDtoClass ? state.dtoRegistry.get(m.requestDtoClass) : null;
            const resDto = m.responseDtoClass ? state.dtoRegistry.get(m.responseDtoClass) : null;
            state.endpoints.push({
                id: `${ctrl.className}#${m.methodName}`,
                verb: m.verb,
                path: m.path || '/',
                controllerClass: ctrl.className,
                methodName: m.methodName,
                requestDto: reqDto ? { className: reqDto.className, fields: reqDto.fields } : null,
                responseDto: resDto ? { className: resDto.className, fields: resDto.fields } : null,
                validators: m.validatorRefs,
                pathVariables: m.pathVariables,
                requestParams: m.requestParams,
                filePath: ctrl.filePath,
                lineNumber: m.lineNumber,
            });
        }
    }

    for (const v of parsed.validators as JavaValidator[]) {
        state.validators.push({
            className: v.className,
            filePath: v.filePath,
            constraints: [],
        });
    }

    // Constraints from DTO fields are hoisted into a synthesized "validator"
    // entry keyed by the DTO class name — that's how a source-grounded generator
    // finds the message literal for a given field.
    for (const dto of parsed.dtos as JavaDto[]) {
        const flat: z.infer<typeof ValidatorSchema>['constraints'] = [];
        for (const f of dto.fields) {
            for (const c of f.constraints) {
                flat.push({
                    field: f.name,
                    kind: c.kind,
                    args: Object.fromEntries(Object.entries(c.args).map(([k, v]) => [k, String(v)])),
                    errorMessageKey: c.errorMessageKey,
                    errorMessageLiteral: c.errorMessageLiteral,
                });
            }
        }
        if (flat.length > 0) {
            state.validators.push({
                className: dto.className,
                filePath: dto.filePath,
                constraints: flat,
            });
        }
    }

    for (const s of parsed.services as JavaService[]) {
        state.services.push({
            className: s.className,
            filePath: s.filePath,
            kind: s.kind,
            calls: s.calls.map((c) => ({
                methodName: c.methodName,
                callsService: null, callsRepo: null,
                callsValidator: null,
            })),
        });
    }
}

function mergedMessages(state: IngestState): Record<string, string> {
    // Merge across all locales — `default` last so it wins ties. Real-world
    // deployments often have `messages.properties` alongside locale variants;
    // for the purpose of label resolution, ANY locale's literal is acceptable
    // because the message key is the stable identifier.
    const merged: Record<string, string> = {};
    for (const [locale, bundle] of Object.entries(state.messages)) {
        if (locale === 'default') continue;
        for (const [k, v] of Object.entries(bundle)) if (!(k in merged)) merged[k] = v;
    }
    for (const [k, v] of Object.entries(state.messages['default'] || {})) merged[k] = v;
    return merged;
}

function processJspFile(state: IngestState, file: DiscoveredFile) {
    const rd = readFileSafe(file.absPath);
    if (rd.warning) state.warnings.push(rd.warning);
    if (rd.content === null) return;
    bumpStat(state, 'jsp', file.size);
    // Merge every locale so label resolution finds the message key regardless
    // of locale suffix.
    const merged = mergedMessages(state);
    const parsed = parseJspFile(file.absPath, rd.content, merged);
    for (const key of parsed.unresolvedMessageKeys) state.warnings.push(`jsp-unresolved-message-key: ${key} in ${file.absPath}`);
    if (parsed.forms.length === 0 && parsed.navigation.length === 0) return;

    const rel = path.basename(file.absPath).replace(/\.(jspx?|tag)$/, '');
    state.screens.push({
        id: `jsp:${rel}`,
        screenName: rel,
        filePath: file.absPath,
        forms: parsed.forms.map((f) => ({
            formId: f.formId, action: f.action, method: f.method,
            fields: f.fields.map((ff) => ({
                id: ff.id, name: ff.name, tag: ff.tag, type: ff.type,
                label: ff.label, messageKey: ff.messageKey,
                required: ff.required, maxLength: ff.maxLength, pattern: ff.pattern,
                lineNumber: ff.lineNumber,
            })),
            submitButtonId: f.submitButtonId,
            tables: f.tables,
        })),
        navigation: parsed.navigation.map((n) => ({ linkText: n.linkText, href: n.href })),
    });
}

function processThymeleafFile(state: IngestState, file: DiscoveredFile) {
    const rd = readFileSafe(file.absPath);
    if (rd.warning) state.warnings.push(rd.warning);
    if (rd.content === null) return;
    bumpStat(state, 'thymeleaf', file.size);
    const merged = mergedMessages(state);
    const parsed = parseThymeleafFile(file.absPath, rd.content, merged);
    for (const key of parsed.unresolvedMessageKeys) state.warnings.push(`thymeleaf-unresolved-message-key: ${key} in ${file.absPath}`);
    if (parsed.forms.length === 0 && parsed.navigation.length === 0) return;
    const rel = path.basename(file.absPath).replace(/\.html?$/, '');
    state.screens.push({
        id: `thyme:${rel}`,
        screenName: rel,
        filePath: file.absPath,
        forms: parsed.forms.map((f) => ({
            formId: f.formId, action: f.action, method: f.method,
            fields: f.fields.map((ff) => ({
                id: ff.id, name: ff.name, tag: ff.tag, type: ff.type,
                label: ff.label, messageKey: ff.messageKey,
                required: ff.required, maxLength: ff.maxLength, pattern: null,
                lineNumber: ff.lineNumber,
            })),
            submitButtonId: f.submitButtonId,
            tables: [],
        })),
        navigation: parsed.navigation.map((n) => ({ linkText: n.linkText, href: n.href })),
    });
}

function processTsFile(state: IngestState, file: DiscoveredFile) {
    const rd = readFileSafe(file.absPath);
    if (rd.warning) state.warnings.push(rd.warning);
    if (rd.content === null) return;
    bumpStat(state, 'ts', file.size);
    const parsed = parseTsFile(file.absPath, rd.content);
    for (const w of parsed.warnings) state.warnings.push(`ts: ${w}`);
    for (const scr of parsed.screens) {
        state.screens.push({
            id: `${scr.kind}:${scr.componentName}`,
            screenName: scr.componentName,
            filePath: scr.filePath,
            forms: [{
                formId: scr.componentName,
                action: null,
                method: null,
                fields: scr.fields.map((f) => ({
                    id: f.id, name: f.name, tag: f.tag, type: f.type,
                    label: null,
                    messageKey: null,
                    required: false, maxLength: null, pattern: null,
                    lineNumber: f.lineNumber,
                })),
                submitButtonId: (scr.buttons.find((b) => (b.text || '').toLowerCase().includes('submit')) || scr.buttons[0])?.id ?? null,
                tables: [],
            }],
            navigation: [],
        });
    }
    for (const r of parsed.routes) state.routes.push(r);
}

function processPropertiesFile(state: IngestState, file: DiscoveredFile) {
    const rd = readFileSafe(file.absPath);
    if (rd.warning) state.warnings.push(rd.warning);
    if (rd.content === null) return;
    bumpStat(state, 'properties', file.size);
    let parsed: ParsedMessages;
    try {
        parsed = file.kind === 'yaml' ? parseYamlMessages(rd.content, path.basename(file.absPath)) : parseProperties(rd.content, path.basename(file.absPath));
    } catch (e) {
        state.parseErrors.push({ filePath: file.absPath, error: (e as Error).message });
        return;
    }
    const bucket = state.messages[parsed.locale] || {};
    for (const [k, v] of Object.entries(parsed.entries)) bucket[k] = v;
    state.messages[parsed.locale] = bucket;
    for (const w of parsed.warnings) state.warnings.push(`${file.absPath}: ${w}`);
}

function processHbmFile(state: IngestState, file: DiscoveredFile) {
    const rd = readFileSafe(file.absPath);
    if (rd.warning) state.warnings.push(rd.warning);
    if (rd.content === null) return;
    bumpStat(state, 'hbm', file.size);
    const parsed = parseHbmFile(file.absPath, rd.content);
    for (const w of parsed.warnings) state.warnings.push(`hbm: ${w}`);
    for (const cls of parsed.classes) {
        state.entities.push({
            className: cls.className,
            tableName: cls.tableName,
            filePath: cls.filePath,
            columns: cls.columns.map((c) => ({
                name: c.name, type: c.type || 'unknown',
                dbColumn: c.column,
                nullable: c.nullable, length: c.length,
                isPk: c.isPk, isFk: c.isFk, fkTarget: c.fkTarget,
                lineNumber: c.lineNumber, constraints: [],
            })),
        });
    }
}

function processCsFile(state: IngestState, file: DiscoveredFile) {
    const rd = readFileSafe(file.absPath);
    if (rd.warning) state.warnings.push(rd.warning);
    if (rd.content === null) return;
    bumpStat(state, 'cs', file.size);
    const parsed = parseCsFile(file.absPath, rd.content);
    for (const w of parsed.warnings) state.warnings.push(`cs: ${w}`);
    for (const ent of parsed.entities) {
        state.entities.push({
            className: ent.className,
            tableName: ent.tableName,
            filePath: ent.filePath,
            columns: ent.columns.map((c) => ({
                name: c.name, type: c.type,
                dbColumn: c.dbColumn,
                nullable: c.nullable, length: c.length,
                isPk: c.isPk, isFk: c.isFk, fkTarget: c.fkTarget,
                lineNumber: c.lineNumber,
                constraints: c.constraints.map((k) => ({
                    kind: k.kind,
                    args: Object.fromEntries(Object.entries(k.args).map(([kk, vv]) => [kk, String(vv)])),
                    errorMessageKey: null,
                    errorMessageLiteral: k.errorMessageLiteral,
                })),
            })),
        });
    }
    for (const ctrl of parsed.controllers) {
        for (const a of ctrl.actions) {
            state.endpoints.push({
                id: `${ctrl.className}#${a.methodName}`,
                verb: a.verb,
                path: a.path,
                controllerClass: ctrl.className,
                methodName: a.methodName,
                requestDto: null,
                responseDto: null,
                validators: [],
                pathVariables: [],
                requestParams: [],
                filePath: ctrl.filePath,
                lineNumber: a.lineNumber,
            });
        }
    }
}

// -----------------------------------------------------------------------------
// Registration.
// -----------------------------------------------------------------------------

registerPrimitive({
    name: 'cs_qa_source_ingest',
    description: 'Walk an application source tree and extract a source-of-truth model (endpoints, screens, validators, entities, message bundles) to .cs-qa/source-model/model.json. Real byte-level parsing for Java/Spring, JSP, Thymeleaf, TS/React/Angular, .properties/.yml, .hbm.xml, and .NET. Every extracted fact carries a filePath+lineNumber cite. Just pass sourceRoot — languages auto-detect from file extensions unless you narrow the set explicitly.',
    inputSchema: z.object({
        sourceRoot: z.string().min(1),
        include: z.array(z.string()).optional(),
        exclude: z.array(z.string()).optional(),
        languages: z.array(z.enum(['java', 'spring', 'jsp', 'thymeleaf', 'ts', 'js', 'react', 'angular', 'properties', 'hbm', 'jpa', 'cs-dotnet'])).optional().describe('OPTIONAL. Omit to auto-detect every supported language present in the tree. Pass an explicit list only to narrow the scope (e.g. ["java","properties"] to skip the frontend).'),
        outputPath: z.string().optional(),
        dryRun: z.boolean().default(false),
        maxFileBytes: z.number().int().positive().max(50 * 1024 * 1024).default(MAX_FILE_BYTES),
        localeCoverageThreshold: z.number().min(0).max(1).default(0.5),
        output: z.enum(['full-model', 'endpoints-only', 'db-schema-only', 'project-profile']).default('full-model').describe('full-model = full walk + model.json (default). endpoints-only = fast pass that emits only endpoints[] to endpoints.json. db-schema-only = fast pass that emits only entities[] to db-schema.json. project-profile = fastest pass — framework/tech-stack/folder-layout/env-files/package.json + test infra to project-profile.json (cold-start onboarding).'),
    }),
    outputSchema: z.object({
        ok: z.boolean(),
        outputPath: z.string().nullable(),
        filesDiscovered: z.number(),
        filesParsed: z.number(),
        languagesDetected: z.array(z.string()),
        languagesMode: z.enum(['auto', 'explicit']),
        counts: z.object({
            endpoints: z.number(),
            screens: z.number(),
            validators: z.number(),
            entities: z.number(),
            messages: z.number(),
            services: z.number(),
            routes: z.number(),
        }),
        warnings: z.array(z.string()),
        parseErrors: z.array(z.object({ filePath: z.string(), error: z.string() })),
        note: z.string().optional(),
        modelPreview: ModelSchema.optional(),
    }),
    run: async (ctx, input) => {
        const log = createLogger(ctx.invocationId, 'cs_qa_source_ingest', { workspaceRoot: ctx.workspaceRoot });
        const excludes = new Set([...DEFAULT_EXCLUDES, ...(input.exclude || [])]);

        // Resolve source root against workspace when relative.
        const sourceRoot = path.isAbsolute(input.sourceRoot) ? input.sourceRoot : path.join(ctx.workspaceRoot, input.sourceRoot);
        const languagesMode: 'auto' | 'explicit' = input.languages && input.languages.length > 0 ? 'explicit' : 'auto';
        if (!fs.existsSync(sourceRoot)) {
            return {
                ok: false, outputPath: null, filesDiscovered: 0, filesParsed: 0,
                languagesDetected: [], languagesMode,
                counts: { endpoints: 0, screens: 0, validators: 0, entities: 0, messages: 0, services: 0, routes: 0 },
                warnings: [], parseErrors: [], note: `sourceRoot does not exist: ${sourceRoot}`,
            };
        }

        // ---- Narrow-output modes: short-circuit BEFORE the full pipeline ----
        // These modes emit a compact focused artifact instead of the full model —
        // used by cold-start onboarding + targeted refresh flows. Never mutate
        // the full model.json; each writes its own JSON file.
        if (input.output === 'project-profile') {
            const profile = buildProjectProfile(sourceRoot, ctx.workspaceRoot);
            const outAbs = input.outputPath
                ? (path.isAbsolute(input.outputPath) ? input.outputPath : path.join(ctx.workspaceRoot, input.outputPath))
                : path.join(ctx.workspaceRoot, '.cs-qa', 'source-model', 'project-profile.json');
            if (!input.dryRun) {
                try {
                    fs.mkdirSync(path.dirname(outAbs), { recursive: true });
                    fs.writeFileSync(outAbs, JSON.stringify(profile, null, 2), 'utf-8');
                } catch (e) {
                    return {
                        ok: false, outputPath: null, filesDiscovered: 0, filesParsed: 0,
                        languagesDetected: profile.languagesDetected, languagesMode,
                        counts: { endpoints: 0, screens: 0, validators: 0, entities: 0, messages: 0, services: 0, routes: 0 },
                        warnings: [`write-failed: ${(e as Error).message}`], parseErrors: [],
                        note: 'project-profile write failed',
                    };
                }
            }
            log.info('project-profile emitted', { framework: profile.framework, techStack: profile.techStack });
            return {
                ok: true,
                outputPath: input.dryRun ? null : outAbs,
                filesDiscovered: profile.folderLayout.length,
                filesParsed: 0,
                languagesDetected: profile.languagesDetected,
                languagesMode,
                counts: { endpoints: 0, screens: 0, validators: 0, entities: 0, messages: 0, services: 0, routes: 0 },
                warnings: [], parseErrors: [],
                note: `project-profile: framework=${profile.framework || '(unknown)'}, techStack=[${profile.techStack.join(', ') || 'none'}], envFiles=${profile.envFiles.length}, testInfra=[${profile.testInfrastructure.join(', ') || 'none'}].`,
            };
        }

        if (input.output === 'endpoints-only' || input.output === 'db-schema-only') {
            // Fast focused pass — walk the tree once, dispatch only to parsers
            // that yield the requested facet. Skip JSP/Thymeleaf/TS/properties.
            const wantEndpoints = input.output === 'endpoints-only';
            const wantSchema = input.output === 'db-schema-only';
            const discovered = walkTree(sourceRoot, excludes).filter((f) => {
                if (wantEndpoints) return f.kind === 'java' || f.kind === 'cs';
                if (wantSchema) return f.kind === 'java' || f.kind === 'hbm' || f.kind === 'cs';
                return false;
            });
            const state = newState();
            for (const f of discovered) {
                if (f.kind === 'java') processJavaFile(state, f);
                else if (f.kind === 'hbm') processHbmFile(state, f);
                else if (f.kind === 'cs') processCsFile(state, f);
            }
            let outAbs: string;
            let payload: unknown;
            if (wantEndpoints) {
                outAbs = input.outputPath
                    ? (path.isAbsolute(input.outputPath) ? input.outputPath : path.join(ctx.workspaceRoot, input.outputPath))
                    : path.join(ctx.workspaceRoot, '.cs-qa', 'source-model', 'endpoints.json');
                payload = {
                    generatedAt: new Date().toISOString(),
                    sourceRoot,
                    total: state.endpoints.length,
                    endpoints: state.endpoints.map((e) => ({
                        controller: e.controllerClass,
                        method: e.methodName,
                        verb: e.verb,
                        path: e.path,
                        params: [...e.pathVariables, ...e.requestParams],
                    })),
                };
            } else {
                outAbs = input.outputPath
                    ? (path.isAbsolute(input.outputPath) ? input.outputPath : path.join(ctx.workspaceRoot, input.outputPath))
                    : path.join(ctx.workspaceRoot, '.cs-qa', 'source-model', 'db-schema.json');
                payload = {
                    generatedAt: new Date().toISOString(),
                    sourceRoot,
                    total: state.entities.length,
                    entities: state.entities,
                };
            }
            if (!input.dryRun) {
                try {
                    fs.mkdirSync(path.dirname(outAbs), { recursive: true });
                    fs.writeFileSync(outAbs, JSON.stringify(payload, null, 2), 'utf-8');
                } catch (e) {
                    state.warnings.push(`write-failed: ${(e as Error).message}`);
                }
            }
            log.info('narrow-output emitted', { output: input.output, count: wantEndpoints ? state.endpoints.length : state.entities.length });
            return {
                ok: true,
                outputPath: input.dryRun ? null : outAbs,
                filesDiscovered: discovered.length,
                filesParsed: discovered.length,
                languagesDetected: Array.from(new Set(discovered.map((f) => f.kind))).sort(),
                languagesMode,
                counts: {
                    endpoints: wantEndpoints ? state.endpoints.length : 0,
                    screens: 0,
                    validators: 0,
                    entities: wantSchema ? state.entities.length : 0,
                    messages: 0, services: 0, routes: 0,
                },
                warnings: state.warnings,
                parseErrors: state.parseErrors,
                note: wantEndpoints
                    ? `endpoints-only: ${state.endpoints.length} endpoint(s) extracted from ${discovered.length} file(s).`
                    : `db-schema-only: ${state.entities.length} entity/ies extracted from ${discovered.length} file(s).`,
            };
        }

        // Auto mode → allow every language we can parse; explicit mode → filter to caller's list.
        const wantsJava = languagesMode === 'auto' || input.languages!.includes('java') || input.languages!.includes('spring');
        const wantsJsp = languagesMode === 'auto' || input.languages!.includes('jsp');
        const wantsThyme = languagesMode === 'auto' || input.languages!.includes('thymeleaf');
        const wantsTs = languagesMode === 'auto' || input.languages!.includes('ts') || input.languages!.includes('js') || input.languages!.includes('react') || input.languages!.includes('angular');
        const wantsProps = languagesMode === 'auto' || input.languages!.includes('properties');
        const wantsHbm = languagesMode === 'auto' || input.languages!.includes('hbm');
        const wantsCs = languagesMode === 'auto' || input.languages!.includes('cs-dotnet');

        const discovered = walkTree(sourceRoot, excludes).filter((f) => {
            if (f.kind === 'java' && !wantsJava) return false;
            if (f.kind === 'jsp' && !wantsJsp) return false;
            if (f.kind === 'thymeleaf' && !wantsThyme) return false;
            if (f.kind === 'ts' && !wantsTs) return false;
            if ((f.kind === 'properties' || f.kind === 'yaml') && !wantsProps) return false;
            if (f.kind === 'hbm' && !wantsHbm) return false;
            if (f.kind === 'cs' && !wantsCs) return false;
            return true;
        });

        // Apply include-glob (basename substring match).
        const includeFilters = input.include || [];
        const filtered = includeFilters.length === 0 ? discovered : discovered.filter((f) => {
            const rel = path.relative(sourceRoot, f.absPath);
            return includeFilters.some((pat) => {
                const glob = pat.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*');
                return new RegExp('^' + glob + '$').test(rel) || rel.includes(pat);
            });
        });

        log.info('source-ingest: discovered', { count: filtered.length, root: sourceRoot });

        const state = newState();

        // PASS 1 — Properties FIRST so messages are available for JSP/Thymeleaf
        // label resolution in PASS 2.
        const propFiles = filtered.filter((f) => f.kind === 'properties' || f.kind === 'yaml');
        for (const f of propFiles) processPropertiesFile(state, f);

        // PASS 2 — JSP/Thymeleaf (use resolved messages).
        // PASS 3 — Java/TS/Cs/Hbm — DTO registry needs Java first for cross-refs.
        // We chunk-execute for concurrency (byte-bound but I/O bound in practice).
        const javaFiles = filtered.filter((f) => f.kind === 'java');
        await bulkExecute(javaFiles, {
            chunkSize: 20,
            concurrency: 8,
            workFn: async (chunk) => {
                for (const f of chunk) processJavaFile(state, f);
                return chunk.map(() => null);
            },
        });

        const jspFiles = filtered.filter((f) => f.kind === 'jsp');
        await bulkExecute(jspFiles, {
            chunkSize: 20,
            concurrency: 8,
            workFn: async (chunk) => { for (const f of chunk) processJspFile(state, f); return chunk.map(() => null); },
        });
        const thymeFiles = filtered.filter((f) => f.kind === 'thymeleaf');
        await bulkExecute(thymeFiles, {
            chunkSize: 20, concurrency: 8,
            workFn: async (chunk) => { for (const f of chunk) processThymeleafFile(state, f); return chunk.map(() => null); },
        });
        const tsFiles = filtered.filter((f) => f.kind === 'ts');
        await bulkExecute(tsFiles, {
            chunkSize: 20, concurrency: 8,
            workFn: async (chunk) => { for (const f of chunk) processTsFile(state, f); return chunk.map(() => null); },
        });
        const hbmFiles = filtered.filter((f) => f.kind === 'hbm');
        for (const f of hbmFiles) processHbmFile(state, f);
        const csFiles = filtered.filter((f) => f.kind === 'cs');
        for (const f of csFiles) processCsFile(state, f);

        // Locale coverage warning: any locale that resolved fewer than threshold
        // of the keys referenced anywhere in the model.
        const allReferencedKeys = new Set<string>();
        for (const s of state.screens) {
            for (const form of s.forms) for (const f of form.fields) if (f.messageKey) allReferencedKeys.add(f.messageKey);
        }
        for (const v of state.validators) for (const c of v.constraints) if (c.errorMessageKey) allReferencedKeys.add(c.errorMessageKey);
        if (allReferencedKeys.size > 0) {
            for (const [locale, bundle] of Object.entries(state.messages)) {
                const resolved = Array.from(allReferencedKeys).filter((k) => bundle[k] !== undefined).length;
                const ratio = resolved / allReferencedKeys.size;
                if (ratio < input.localeCoverageThreshold) {
                    state.warnings.push(`locale ${locale} resolves only ${resolved}/${allReferencedKeys.size} (${(ratio * 100).toFixed(1)}%) referenced keys (< ${(input.localeCoverageThreshold * 100).toFixed(0)}%).`);
                }
            }
        }

        const model: SourceModel = {
            ingestedAt: new Date().toISOString(),
            sourceRoot,
            languageStats: state.languageStats,
            endpoints: state.endpoints,
            screens: state.screens,
            validators: state.validators,
            entities: state.entities,
            messages: state.messages,
            services: state.services,
            routes: state.routes,
            warnings: state.warnings,
            parseErrors: state.parseErrors,
        };

        const outAbs = input.outputPath
            ? (path.isAbsolute(input.outputPath) ? input.outputPath : path.join(ctx.workspaceRoot, input.outputPath))
            : path.join(ctx.workspaceRoot, '.cs-qa', 'source-model', 'model.json');

        if (!input.dryRun) {
            try {
                fs.mkdirSync(path.dirname(outAbs), { recursive: true });
                fs.writeFileSync(outAbs, JSON.stringify(model, null, 2), 'utf-8');
            } catch (e) {
                state.warnings.push('write-failed: ' + (e as Error).message);
            }
        }

        const totalMsgs = Object.values(state.messages).reduce((s, m) => s + Object.keys(m).length, 0);

        const detectedKinds = new Set<string>();
        for (const f of filtered) if (f.kind !== 'other') detectedKinds.add(f.kind);
        const languagesDetected = Array.from(detectedKinds).sort();

        return {
            ok: true,
            outputPath: input.dryRun ? null : outAbs,
            filesDiscovered: discovered.length,
            filesParsed: filtered.length,
            languagesDetected,
            languagesMode,
            counts: {
                endpoints: state.endpoints.length,
                screens: state.screens.length,
                validators: state.validators.length,
                entities: state.entities.length,
                messages: totalMsgs,
                services: state.services.length,
                routes: state.routes.length,
            },
            warnings: state.warnings,
            parseErrors: state.parseErrors,
            note: `${languagesMode === 'auto' ? 'Auto-detected' : 'Filtered'} languages: [${languagesDetected.join(', ') || 'none'}]. ${state.endpoints.length} endpoints, ${state.screens.length} screens, ${state.entities.length} entities, ${totalMsgs} message keys extracted from ${filtered.length} files.`,
            modelPreview: input.dryRun ? model : undefined,
        };
    },
});

/**
 * Utility exported for downstream tools (e.g. cs_qa_ground_story) so they can
 * load the same shape without re-parsing.
 */
export function loadModel(modelPath: string): SourceModel | null {
    try {
        const raw = fs.readFileSync(modelPath, 'utf-8');
        const parsed = JSON.parse(raw);
        const verify = ModelSchema.safeParse(parsed);
        if (!verify.success) return null;
        return verify.data;
    } catch { return null; }
}

export { ModelSchema };

// -----------------------------------------------------------------------------
// project-profile — fast onboarding pass.
// Detects framework / tech stack / folder layout / env files / package.json
// deps / test infra. No parsers invoked — pure filesystem + JSON reads. Emits
// exactly the shape a cold-start scaffold needs to decide how to wire itself
// up (playwright vs cypress vs cs-framework, jest vs vitest, spring vs express,
// etc.). Never mutates model.json.
// -----------------------------------------------------------------------------

interface ProjectProfile {
    generatedAt: string;
    sourceRoot: string;
    framework: string | null;
    frameworks: string[];
    techStack: string[];
    languagesDetected: string[];
    folderLayout: string[];
    envFiles: string[];
    packageJson: { name?: string; version?: string; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | null;
    testInfrastructure: string[];
    warnings: string[];
}

function buildProjectProfile(sourceRoot: string, workspaceRoot: string): ProjectProfile {
    const profile: ProjectProfile = {
        generatedAt: new Date().toISOString(),
        sourceRoot,
        framework: null,
        frameworks: [],
        techStack: [],
        languagesDetected: [],
        folderLayout: [],
        envFiles: [],
        packageJson: null,
        testInfrastructure: [],
        warnings: [],
    };

    // Top-level folder layout — one level deep so we don't recurse.
    try {
        const entries = fs.readdirSync(sourceRoot, { withFileTypes: true });
        for (const e of entries) {
            if (DEFAULT_EXCLUDES.has(e.name) || e.name.startsWith('.')) continue;
            if (e.isDirectory()) profile.folderLayout.push(e.name + '/');
            else if (e.isFile()) profile.folderLayout.push(e.name);
        }
        profile.folderLayout.sort();
    } catch (e) {
        profile.warnings.push(`folder-scan failed: ${(e as Error).message}`);
    }

    // package.json parse (if present at sourceRoot or workspaceRoot).
    const pkgPath = [path.join(sourceRoot, 'package.json'), path.join(workspaceRoot, 'package.json')].find((p) => fs.existsSync(p));
    if (pkgPath) {
        try {
            const raw = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
            profile.packageJson = {
                name: raw.name as string | undefined,
                version: raw.version as string | undefined,
                scripts: raw.scripts as Record<string, string> | undefined,
                dependencies: raw.dependencies as Record<string, string> | undefined,
                devDependencies: raw.devDependencies as Record<string, string> | undefined,
            };
            const alldeps: Record<string, string> = { ...(profile.packageJson.dependencies || {}), ...(profile.packageJson.devDependencies || {}) };
            // Tech-stack detection by dep names.
            if (alldeps['@playwright/test'] || alldeps['playwright']) profile.techStack.push('playwright');
            if (alldeps['cypress']) profile.techStack.push('cypress');
            if (alldeps['jest']) profile.techStack.push('jest');
            if (alldeps['vitest']) profile.techStack.push('vitest');
            if (alldeps['mocha']) profile.techStack.push('mocha');
            if (alldeps['jasmine']) profile.techStack.push('jasmine');
            if (alldeps['@cucumber/cucumber']) profile.techStack.push('cucumber');
            if (Object.keys(alldeps).some((k) => k.endsWith('/cs-playwright-test-framework'))) profile.techStack.push('cs-playwright-framework');
            if (alldeps['react']) profile.techStack.push('react');
            if (alldeps['vue']) profile.techStack.push('vue');
            if (alldeps['angular'] || alldeps['@angular/core']) profile.techStack.push('angular');
            if (alldeps['express']) profile.techStack.push('express');
            if (alldeps['fastify']) profile.techStack.push('fastify');
            if (alldeps['next']) profile.techStack.push('nextjs');
            if (alldeps['nuxt']) profile.techStack.push('nuxt');
            if (alldeps['typescript']) profile.techStack.push('typescript');
            // Test infra sub-scan.
            for (const dep of Object.keys(alldeps)) {
                if (/^@?playwright/.test(dep) || /^@?cypress/.test(dep) || dep === 'jest' || dep === 'vitest' || dep === 'mocha' || dep === 'jasmine' || dep === '@cucumber/cucumber' || dep === 'k6') {
                    if (!profile.testInfrastructure.includes(dep)) profile.testInfrastructure.push(dep);
                }
            }
        } catch (e) {
            profile.warnings.push(`package.json parse failed: ${(e as Error).message}`);
        }
    }

    // Framework detection — walk one level of top folders for tell-tale files.
    // Spring: pom.xml or build.gradle with `spring-boot` dep or @SpringBootApplication.
    // .NET: *.csproj file.
    // Django: manage.py.
    // Rails: Gemfile with 'rails'.
    const rootFiles = safeReaddirFlat(sourceRoot);
    if (rootFiles.includes('pom.xml')) {
        profile.frameworks.push('maven');
        try {
            const pom = fs.readFileSync(path.join(sourceRoot, 'pom.xml'), 'utf-8');
            if (/spring-boot/i.test(pom)) profile.frameworks.push('spring-boot');
            else if (/springframework/i.test(pom)) profile.frameworks.push('spring');
            if (/junit/i.test(pom)) profile.testInfrastructure.push('junit');
            if (/testng/i.test(pom)) profile.testInfrastructure.push('testng');
        } catch { /* ignore */ }
    }
    if (rootFiles.some((f) => f === 'build.gradle' || f === 'build.gradle.kts')) profile.frameworks.push('gradle');
    if (rootFiles.some((f) => f.endsWith('.csproj') || f === 'global.json')) profile.frameworks.push('dotnet');
    if (rootFiles.includes('manage.py')) profile.frameworks.push('django');
    if (rootFiles.includes('Gemfile')) profile.frameworks.push('ruby');
    if (rootFiles.includes('go.mod')) profile.frameworks.push('go');
    if (rootFiles.includes('Cargo.toml')) profile.frameworks.push('rust');
    if (rootFiles.includes('composer.json')) profile.frameworks.push('php');
    if (rootFiles.includes('requirements.txt') || rootFiles.includes('pyproject.toml')) profile.frameworks.push('python');
    if (profile.frameworks.length > 0) profile.framework = profile.frameworks[0];
    else if (profile.techStack.includes('cs-playwright-framework')) profile.framework = 'cs-playwright-framework';
    else if (profile.packageJson) profile.framework = 'node';

    // env-file detection.
    const envCandidates: string[] = [];
    const configDir = path.join(sourceRoot, 'config');
    if (fs.existsSync(configDir)) {
        try {
            const projects = fs.readdirSync(configDir, { withFileTypes: true }).filter((d) => d.isDirectory());
            for (const p of projects) {
                const envDir = path.join(configDir, p.name, 'environments');
                if (fs.existsSync(envDir)) {
                    const envFiles = fs.readdirSync(envDir).filter((f) => f.endsWith('.env'));
                    for (const f of envFiles) envCandidates.push(`config/${p.name}/environments/${f}`);
                }
            }
        } catch { /* ignore */ }
    }
    for (const f of rootFiles) if (f === '.env' || f.startsWith('.env.')) envCandidates.push(f);
    profile.envFiles = envCandidates;

    // language detection — cheap top-level walk (2 levels deep).
    const langSet = new Set<string>();
    scanForLanguages(sourceRoot, langSet, 2);
    profile.languagesDetected = Array.from(langSet).sort();

    return profile;
}

function safeReaddirFlat(dir: string): string[] {
    try { return fs.readdirSync(dir); } catch { return []; }
}

function scanForLanguages(dir: string, out: Set<string>, remainingDepth: number): void {
    if (remainingDepth < 0) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
        if (DEFAULT_EXCLUDES.has(e.name) || e.name.startsWith('.')) continue;
        if (e.isFile()) {
            const kind = classifyExt(path.join(dir, e.name));
            if (kind !== 'other') out.add(kind);
        } else if (e.isDirectory() && remainingDepth > 0) {
            scanForLanguages(path.join(dir, e.name), out, remainingDepth - 1);
        }
    }
}
