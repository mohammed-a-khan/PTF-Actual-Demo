/**
 * cs_qa_intent_brief — Source-normalizer producing a unified IntentBrief.
 *
 * Takes any mix of source refs (ADO story / test case / test plan, source-repo,
 * requirement documents, OpenAPI spec) and produces the same downstream shape.
 * Every field carries provenance so downstream design steps can reason about
 * trust (source code beats a stale requirement doc).
 *
 * Design principle: the model never round-trips raw source content. This
 * primitive dispatches to the existing per-source tools (cs_qa_ado_read,
 * cs_qa_doc_parse, etc.), extracts what it needs, and writes the raw payloads
 * to .cct-qa/resources/ for on-demand retrieval. The brief itself stays under
 * 5k tokens.
 *
 * Verbs:
 *   - build : Assemble a brief from a list of sources.
 *   - read  : Read a previously-persisted brief by briefId.
 *   - list  : Enumerate briefs on disk.
 *
 * @module mcp/v6/tools/intent_brief_tool
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { getPrimitive, registerPrimitive, type PrimitiveContext } from '../runtime/Primitive';

// -- Source refs (discriminated by kind) ------------------------------------

const AdoStorySource = z.object({
    kind: z.literal('ado-story'),
    ref: z.string().min(1).describe('ADO work-item ID.'),
});
const AdoTestCaseSource = z.object({
    kind: z.literal('ado-test-case'),
    ref: z.string().min(1).describe('ADO test-case ID.'),
});
const AdoTestPlanSource = z.object({
    kind: z.literal('ado-test-plan'),
    ref: z.string().min(1).describe('ADO test-plan ID.'),
    suiteId: z.string().or(z.number()).optional(),
});
const RepoSource = z.object({
    kind: z.literal('repo'),
    ref: z.string().min(1).describe('Absolute path to a source-code repo root.'),
    pathGlob: z
        .string()
        .default('**')
        .describe('Narrow the RAG-indexed subtree. Default ** — cap this for large monorepos.'),
    corpusName: z.string().optional().describe('Override the auto-derived RAG corpus name.'),
    forceReindex: z.boolean().default(false),
});
const DocSetSource = z.object({
    kind: z.literal('doc-set'),
    ref: z.array(z.string().min(1)).min(1).describe('List of file paths (pdf/docx/xlsx/md/txt/csv/json).'),
    corpusName: z.string().optional(),
});
const OpenApiSource = z.object({
    kind: z.literal('openapi'),
    ref: z.string().min(1).describe('Absolute or workspace-relative path to the OpenAPI spec (.yaml/.json).'),
});

const SourceRef = z.discriminatedUnion('kind', [
    AdoStorySource,
    AdoTestCaseSource,
    AdoTestPlanSource,
    RepoSource,
    DocSetSource,
    OpenApiSource,
]);

// -- Brief shape ------------------------------------------------------------

const TRUST_BY_KIND: Record<string, 'authoritative' | 'intent' | 'ground-truth' | 'reference'> = {
    'ado-test-case': 'authoritative',
    'ado-test-plan': 'authoritative',
    'ado-story': 'intent',
    repo: 'ground-truth',
    'doc-set': 'reference',
    openapi: 'reference',
};

const ProvenanceEntry = z.object({
    kind: z.string(),
    ref: z.string(),
    trustLevel: z.enum(['authoritative', 'intent', 'ground-truth', 'reference']),
    ragCorpus: z.string().optional(),
    warnings: z.array(z.string()).default([]),
});

const AcceptanceCriterion = z.object({
    id: z.string(),
    text: z.string(),
    source: z.string(),
});

const IntentBrief = z.object({
    briefId: z.string(),
    provenance: z.array(ProvenanceEntry),
    title: z.string(),
    summary: z.string(),
    acceptanceCriteria: z.array(AcceptanceCriterion),
    targetScreens: z.array(z.object({ name: z.string(), source: z.string() })),
    dataInputs: z.array(z.object({ field: z.string(), valueHint: z.string().optional(), source: z.string() })),
    reportOutputs: z.array(z.object({ name: z.string(), kind: z.string(), source: z.string() })),
    contextResourceRefs: z.array(z.string()),
    warnings: z.array(z.string()),
});
type IntentBriefT = z.infer<typeof IntentBrief>;

function briefsDir(ctx: { workspaceRoot: string }): string {
    return path.join(ctx.workspaceRoot, '.cct-qa', 'briefs');
}
function resourcesDir(ctx: { workspaceRoot: string }): string {
    return path.join(ctx.workspaceRoot, '.cct-qa', 'resources');
}

function briefIdOf(sources: unknown[]): string {
    const h = crypto.createHash('sha256');
    h.update(JSON.stringify(sources));
    return 'brief-' + h.digest('hex').slice(0, 12);
}

// -- Adapters ---------------------------------------------------------------
// Each adapter takes a source ref, invokes the appropriate existing tool,
// writes the raw payload as a resource, and returns a partial brief.

interface PartialBrief {
    provenance: z.infer<typeof ProvenanceEntry>;
    title?: string;
    summary?: string;
    acs: Array<z.infer<typeof AcceptanceCriterion>>;
    screens: Array<{ name: string; source: string }>;
    inputs: Array<{ field: string; valueHint?: string; source: string }>;
    outputs: Array<{ name: string; kind: string; source: string }>;
    resourceRefs: string[];
    warnings: string[];
}

function emptyProvenance(kind: string, ref: string): z.infer<typeof ProvenanceEntry> {
    return { kind, ref, trustLevel: TRUST_BY_KIND[kind] ?? 'reference', warnings: [] };
}

async function invokeIfPresent(
    ctx: PrimitiveContext,
    name: string,
    input: unknown,
): Promise<{ ok: true; output: unknown } | { ok: false; error: string }> {
    const p = getPrimitive(name);
    if (!p) return { ok: false, error: `Primitive ${name} not available in this runtime` };
    try {
        const parsed = p.inputSchema.parse(input);
        const output = await p.run(ctx, parsed as never);
        return { ok: true, output };
    } catch (e) {
        return { ok: false, error: (e as Error).message };
    }
}

function persistResource(ctx: PrimitiveContext, briefId: string, tag: string, payload: unknown): string {
    fs.mkdirSync(resourcesDir(ctx), { recursive: true });
    const p = path.join(resourcesDir(ctx), `${briefId}.${tag}.json`);
    fs.writeFileSync(p, JSON.stringify(payload, null, 2), 'utf-8');
    return p;
}

async function adaptAdoStory(
    ctx: PrimitiveContext,
    briefId: string,
    ref: string,
): Promise<PartialBrief> {
    const partial: PartialBrief = {
        provenance: emptyProvenance('ado-story', ref),
        acs: [],
        screens: [],
        inputs: [],
        outputs: [],
        resourceRefs: [],
        warnings: [],
    };
    const res = await invokeIfPresent(ctx, 'cs_qa_ado_read', { verb: 'work-item', id: ref });
    if (!res.ok) {
        partial.warnings.push(`ado-story read failed: ${res.error}`);
        return partial;
    }
    const raw = res.output as {
        title?: string;
        description?: string;
        acceptanceCriteria?: Array<{ id?: string; text?: string } | string>;
    };
    partial.title = raw.title;
    partial.summary = truncate(raw.description ?? '', 500);
    if (Array.isArray(raw.acceptanceCriteria)) {
        raw.acceptanceCriteria.forEach((ac, i) => {
            const id = typeof ac === 'object' && ac?.id ? ac.id : `AC${i + 1}`;
            const text = typeof ac === 'string' ? ac : ac?.text ?? '';
            if (text.trim().length > 0) {
                partial.acs.push({ id, text: truncate(text, 400), source: `ado-story:${ref}` });
            }
        });
    }
    partial.resourceRefs.push(persistResource(ctx, briefId, `ado-story-${ref}`, raw));
    return partial;
}

async function adaptAdoTestCase(
    ctx: PrimitiveContext,
    briefId: string,
    ref: string,
): Promise<PartialBrief> {
    const partial: PartialBrief = {
        provenance: emptyProvenance('ado-test-case', ref),
        acs: [],
        screens: [],
        inputs: [],
        outputs: [],
        resourceRefs: [],
        warnings: [],
    };
    const res = await invokeIfPresent(ctx, 'cs_qa_ado_read', { verb: 'test-case', id: ref });
    if (!res.ok) {
        partial.warnings.push(`ado-test-case read failed: ${res.error}`);
        return partial;
    }
    const raw = res.output as {
        title?: string;
        steps?: Array<{ action?: string; expectedResult?: string }>;
    };
    partial.title = raw.title;
    partial.summary = raw.steps
        ? `${raw.steps.length} test steps — first: ${raw.steps[0]?.action ?? '(empty)'}`
        : undefined;
    if (Array.isArray(raw.steps)) {
        raw.steps.forEach((s, i) => {
            const text = [s.action, s.expectedResult].filter(Boolean).join(' → ');
            if (text.trim().length > 0) {
                partial.acs.push({ id: `TC${ref}.S${i + 1}`, text: truncate(text, 400), source: `ado-test-case:${ref}` });
            }
        });
    }
    partial.resourceRefs.push(persistResource(ctx, briefId, `ado-test-case-${ref}`, raw));
    return partial;
}

async function adaptAdoTestPlan(
    ctx: PrimitiveContext,
    briefId: string,
    ref: string,
    suiteId: string | number | undefined,
): Promise<PartialBrief> {
    const partial: PartialBrief = {
        provenance: emptyProvenance('ado-test-plan', ref),
        acs: [],
        screens: [],
        inputs: [],
        outputs: [],
        resourceRefs: [],
        warnings: [],
    };
    const res = await invokeIfPresent(ctx, 'cs_qa_ado_read', {
        verb: 'test-plan',
        id: ref,
        ...(suiteId !== undefined ? { suiteId: String(suiteId) } : {}),
    });
    if (!res.ok) {
        partial.warnings.push(`ado-test-plan read failed: ${res.error}`);
        return partial;
    }
    const raw = res.output as {
        title?: string;
        suites?: Array<{ id?: string; title?: string; testCases?: Array<{ id?: string; title?: string }> }>;
    };
    partial.title = raw.title;
    partial.summary = `Plan with ${raw.suites?.length ?? 0} suite(s).`;
    for (const suite of raw.suites ?? []) {
        for (const tc of suite.testCases ?? []) {
            if (tc.title) {
                partial.acs.push({
                    id: tc.id ?? `${suite.id ?? '?'}.${partial.acs.length + 1}`,
                    text: truncate(tc.title, 400),
                    source: `ado-test-plan:${ref}/suite/${suite.id ?? '?'}`,
                });
            }
        }
    }
    partial.resourceRefs.push(persistResource(ctx, briefId, `ado-test-plan-${ref}`, raw));
    return partial;
}

async function adaptRepo(
    ctx: PrimitiveContext,
    briefId: string,
    source: z.infer<typeof RepoSource>,
): Promise<PartialBrief> {
    const partial: PartialBrief = {
        provenance: emptyProvenance('repo', source.ref),
        acs: [],
        screens: [],
        inputs: [],
        outputs: [],
        resourceRefs: [],
        warnings: [],
    };
    if (!fs.existsSync(source.ref)) {
        partial.warnings.push(`repo path does not exist: ${source.ref}`);
        return partial;
    }
    const corpus = source.corpusName ?? `repo-${path.basename(source.ref)}`.slice(0, 40);
    // List existing corpora first — skip re-index unless forceReindex.
    const list = await invokeIfPresent(ctx, 'cs_qa_rag', { verb: 'list' });
    let alreadyIndexed = false;
    if (list.ok) {
        const listed = list.output as { corpora?: Array<{ name?: string }> };
        alreadyIndexed = (listed.corpora ?? []).some((c) => c.name === corpus);
    }
    if (!alreadyIndexed || source.forceReindex) {
        const build = await invokeIfPresent(ctx, 'cs_qa_rag', {
            verb: 'build',
            corpus,
            roots: [source.ref],
        });
        if (!build.ok) partial.warnings.push(`rag build failed: ${build.error}`);
    } else {
        partial.warnings.push(`RAG corpus "${corpus}" already indexed — reusing. Pass forceReindex to rebuild.`);
    }
    partial.provenance.ragCorpus = corpus;
    partial.summary = `Source repo indexed as RAG corpus "${corpus}". Search via cs_qa_rag.`;
    return partial;
}

async function adaptDocSet(
    ctx: PrimitiveContext,
    briefId: string,
    source: z.infer<typeof DocSetSource>,
): Promise<PartialBrief> {
    const partial: PartialBrief = {
        provenance: emptyProvenance('doc-set', source.ref.join(',').slice(0, 200)),
        acs: [],
        screens: [],
        inputs: [],
        outputs: [],
        resourceRefs: [],
        warnings: [],
    };
    const paths: string[] = [];
    for (const p of source.ref) {
        const abs = path.isAbsolute(p) ? p : path.resolve(ctx.workspaceRoot, p);
        if (!fs.existsSync(abs)) {
            partial.warnings.push(`doc missing: ${abs}`);
            continue;
        }
        paths.push(abs);
    }
    // Parse each doc; keep only titles + first ~2000 chars as summary evidence.
    for (const p of paths) {
        const res = await invokeIfPresent(ctx, 'cs_qa_doc_parse', { verb: 'parse', path: p });
        if (!res.ok) {
            partial.warnings.push(`doc parse failed for ${path.basename(p)}: ${res.error}`);
            continue;
        }
        const parsed = res.output as { text?: string; sizeBytes?: number };
        partial.resourceRefs.push(persistResource(ctx, briefId, `doc-${path.basename(p)}`, { path: p, ...parsed }));
        const excerpt = truncate(parsed.text ?? '', 1500);
        if (excerpt) {
            partial.acs.push({
                id: `DOC.${path.basename(p, path.extname(p)).slice(0, 20)}`,
                text: excerpt,
                source: `doc-set:${path.basename(p)}`,
            });
        }
    }
    partial.summary = `${paths.length} document(s) parsed.`;
    // Optionally index the doc set into a RAG corpus for later search.
    if (paths.length > 0 && source.corpusName) {
        const build = await invokeIfPresent(ctx, 'cs_qa_rag', {
            verb: 'build',
            corpus: source.corpusName,
            roots: paths,
        });
        if (!build.ok) partial.warnings.push(`rag build failed: ${build.error}`);
        else partial.provenance.ragCorpus = source.corpusName;
    }
    return partial;
}

async function adaptOpenApi(
    ctx: PrimitiveContext,
    briefId: string,
    ref: string,
): Promise<PartialBrief> {
    const partial: PartialBrief = {
        provenance: emptyProvenance('openapi', ref),
        acs: [],
        screens: [],
        inputs: [],
        outputs: [],
        resourceRefs: [],
        warnings: [],
    };
    const abs = path.isAbsolute(ref) ? ref : path.resolve(ctx.workspaceRoot, ref);
    if (!fs.existsSync(abs)) {
        partial.warnings.push(`openapi spec missing: ${abs}`);
        return partial;
    }
    const res = await invokeIfPresent(ctx, 'cs_qa_ado_import_openapi', { verb: 'import', path: abs });
    if (!res.ok) {
        partial.warnings.push(`openapi import failed: ${res.error}. Falling back to raw read.`);
        try {
            const raw = fs.readFileSync(abs, 'utf-8').slice(0, 20_000);
            partial.resourceRefs.push(persistResource(ctx, briefId, `openapi-raw`, { path: abs, excerpt: raw }));
        } catch {
            /* leave empty */
        }
        return partial;
    }
    partial.resourceRefs.push(persistResource(ctx, briefId, `openapi-import`, res.output));
    partial.summary = `OpenAPI spec imported. Endpoints available as AC-shaped rows via the resource ref.`;
    return partial;
}

// -- Merge ------------------------------------------------------------------

function mergePartials(briefId: string, partials: PartialBrief[]): IntentBriefT {
    const seenAcs = new Set<string>();
    const acs: Array<z.infer<typeof AcceptanceCriterion>> = [];
    const screens: Array<{ name: string; source: string }> = [];
    const inputs: Array<{ field: string; valueHint?: string; source: string }> = [];
    const outputs: Array<{ name: string; kind: string; source: string }> = [];
    const resourceRefs: string[] = [];
    const warnings: string[] = [];
    const provenance: Array<z.infer<typeof ProvenanceEntry>> = [];
    let title: string | undefined;
    let summary: string | undefined;

    // Title from most-authoritative source. Order: authoritative > intent > ground-truth > reference.
    const trustOrder = { authoritative: 0, intent: 1, 'ground-truth': 2, reference: 3 };
    const sorted = [...partials].sort((a, b) => trustOrder[a.provenance.trustLevel] - trustOrder[b.provenance.trustLevel]);

    for (const p of sorted) {
        provenance.push(p.provenance);
        if (!title && p.title) title = p.title;
        if (!summary && p.summary) summary = p.summary;
        for (const ac of p.acs) {
            const fp = fingerprintText(ac.text);
            if (seenAcs.has(fp)) continue;
            seenAcs.add(fp);
            acs.push(ac);
        }
        screens.push(...p.screens);
        inputs.push(...p.inputs);
        outputs.push(...p.outputs);
        resourceRefs.push(...p.resourceRefs);
        warnings.push(...p.warnings);
    }

    return {
        briefId,
        provenance,
        title: title ?? '(untitled — no source produced one)',
        summary: summary ?? '(no summary)',
        acceptanceCriteria: acs,
        targetScreens: screens,
        dataInputs: inputs,
        reportOutputs: outputs,
        contextResourceRefs: resourceRefs,
        warnings,
    };
}

function fingerprintText(t: string): string {
    return t.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 120);
}

function truncate(s: string, max: number): string {
    return s.length <= max ? s : s.slice(0, max - 3) + '...';
}

// -- Primitive registration -------------------------------------------------

registerPrimitive({
    name: 'cs_qa_intent_brief',
    description:
        "Source-normalizer: reads any mix of ADO story / test case / test plan / source-code repo / requirement documents / OpenAPI spec, dispatches to the existing per-source tools, and merges into a unified IntentBrief with provenance + trust-level. Model reads the brief instead of raw sources — saves tokens + preserves trust info. Verbs: build (assemble from sources), read (by briefId), list (enumerate saved briefs).",
    inputSchema: z.discriminatedUnion('verb', [
        z.object({
            verb: z.literal('build'),
            sources: z.array(SourceRef).min(1),
        }),
        z.object({ verb: z.literal('read'), briefId: z.string().min(1) }),
        z.object({ verb: z.literal('list') }),
    ]),
    outputSchema: z.union([
        z.object({
            status: z.enum(['ok', 'error']),
            verb: z.literal('build'),
            briefId: z.string(),
            briefPath: z.string(),
            brief: IntentBrief,
            error: z.string().optional(),
        }),
        z.object({
            status: z.enum(['ok', 'error']),
            verb: z.literal('read'),
            briefId: z.string(),
            briefPath: z.string(),
            brief: IntentBrief.optional(),
            error: z.string().optional(),
        }),
        z.object({
            status: z.enum(['ok', 'error']),
            verb: z.literal('list'),
            briefs: z.array(z.object({ briefId: z.string(), briefPath: z.string(), title: z.string().optional() })),
            error: z.string().optional(),
        }),
    ]),
    async run(ctx, input) {
        try {
            if (input.verb === 'list') {
                const dir = briefsDir(ctx);
                if (!fs.existsSync(dir)) return { status: 'ok' as const, verb: 'list' as const, briefs: [] };
                const briefs = fs
                    .readdirSync(dir)
                    .filter((f) => f.endsWith('.json'))
                    .map((f) => {
                        const briefPath = path.join(dir, f);
                        let title: string | undefined;
                        try {
                            const b = JSON.parse(fs.readFileSync(briefPath, 'utf-8')) as { title?: string };
                            title = b.title;
                        } catch {
                            /* leave undefined */
                        }
                        return { briefId: path.basename(f, '.json'), briefPath, title };
                    });
                return { status: 'ok' as const, verb: 'list' as const, briefs };
            }
            if (input.verb === 'read') {
                const p = path.join(briefsDir(ctx), `${input.briefId}.json`);
                if (!fs.existsSync(p)) {
                    return { status: 'error' as const, verb: 'read' as const, briefId: input.briefId, briefPath: p, error: `Brief not found: ${input.briefId}` };
                }
                const brief = JSON.parse(fs.readFileSync(p, 'utf-8'));
                return { status: 'ok' as const, verb: 'read' as const, briefId: input.briefId, briefPath: p, brief };
            }

            // build
            const briefId = briefIdOf(input.sources);
            const partials: PartialBrief[] = [];
            for (const s of input.sources) {
                let partial: PartialBrief;
                switch (s.kind) {
                    case 'ado-story':
                        partial = await adaptAdoStory(ctx, briefId, s.ref);
                        break;
                    case 'ado-test-case':
                        partial = await adaptAdoTestCase(ctx, briefId, s.ref);
                        break;
                    case 'ado-test-plan':
                        partial = await adaptAdoTestPlan(ctx, briefId, s.ref, s.suiteId);
                        break;
                    case 'repo':
                        partial = await adaptRepo(ctx, briefId, s);
                        break;
                    case 'doc-set':
                        partial = await adaptDocSet(ctx, briefId, s);
                        break;
                    case 'openapi':
                        partial = await adaptOpenApi(ctx, briefId, s.ref);
                        break;
                }
                partials.push(partial);
            }
            const brief = mergePartials(briefId, partials);
            fs.mkdirSync(briefsDir(ctx), { recursive: true });
            const briefPath = path.join(briefsDir(ctx), `${briefId}.json`);
            fs.writeFileSync(briefPath, JSON.stringify(brief, null, 2), 'utf-8');
            await ctx.audit({
                ts: new Date().toISOString(),
                tool: 'cs_qa_intent_brief',
                input: { verb: 'build', sourceKinds: input.sources.map((s) => s.kind) },
                outputSummary: {
                    briefId,
                    acCount: brief.acceptanceCriteria.length,
                    provenanceCount: brief.provenance.length,
                    warningCount: brief.warnings.length,
                },
                durationMs: 0,
            });
            return { status: 'ok' as const, verb: 'build' as const, briefId, briefPath, brief };
        } catch (e) {
            const err = (e as Error).message;
            if (input.verb === 'build')
                return {
                    status: 'error' as const,
                    verb: 'build' as const,
                    briefId: '',
                    briefPath: '',
                    brief: {
                        briefId: '',
                        provenance: [],
                        title: '',
                        summary: '',
                        acceptanceCriteria: [],
                        targetScreens: [],
                        dataInputs: [],
                        reportOutputs: [],
                        contextResourceRefs: [],
                        warnings: [err],
                    },
                    error: err,
                };
            if (input.verb === 'read')
                return { status: 'error' as const, verb: 'read' as const, briefId: input.briefId, briefPath: '', error: err };
            return { status: 'error' as const, verb: 'list' as const, briefs: [], error: err };
        }
    },
});
