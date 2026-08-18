/**
 * cs_qa_ground_story — reads an AC checkpoint (or inline story text) plus the
 * source-of-truth model produced by `cs_qa_source_ingest` and emits grounded
 * hints the test generator can use to emit REAL xpaths and REAL assertion
 * literals — never invented.
 *
 * Output goes to `.cs-qa/grounded-hints/story-<id>.json` and drives downstream
 * generation. Every `messageText` in the output is copied verbatim from the
 * model's `messages` bundle; every `csDecoratorSuggestion.decoratorCode`
 * references a real DOM id from the model's `screens[].forms[].fields[]`.
 *
 * On-prem safe — pure file IO.
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import { createLogger } from './_helpers/structured_logger';
import { loadModel, SourceModel } from './ado_source_ingest_tool';
import {
    tokenize, splitIdentifier, weightedScore, classifyConfidence,
    extractIntentVerb, verbMatchesHttp, suggestSample,
} from './_helpers/story_matcher';

// -----------------------------------------------------------------------------
// I/O schemas.
// -----------------------------------------------------------------------------

const InputSchema = z.object({
    storyId: z.number().int().positive().optional(),
    storyText: z.string().optional(),
    acCheckpointPath: z.string().optional(),
    sourceModelPath: z.string().optional(),
    outputPath: z.string().optional(),
    dryRun: z.boolean().default(false),
    matchThreshold: z.number().min(0).max(1).default(0.10),
    maxCandidatesPerAc: z.number().int().min(1).max(20).default(5),
}).refine((v) => v.storyId !== undefined || v.storyText !== undefined || v.acCheckpointPath !== undefined, {
    message: 'must supply one of: storyId, storyText, acCheckpointPath',
});

const AcSchema = z.object({ index: z.number(), tag: z.string(), text: z.string() });

const HintSchema = z.object({
    storyId: z.number().int().nullable(),
    generatedAt: z.string(),
    modelPath: z.string(),
    perAc: z.array(z.object({
        acIndex: z.number(),
        acTag: z.string(),
        acText: z.string(),
        matchedEndpoints: z.array(z.object({
            endpointId: z.string(), verb: z.string(), path: z.string(),
            score: z.number(), why: z.string(),
        })),
        matchedScreens: z.array(z.object({
            screenId: z.string(), screenName: z.string(),
            score: z.number(), why: z.string(),
        })),
        matchedValidators: z.array(z.object({
            className: z.string(), field: z.string(), constraint: z.string(),
            expectedMessageLiteral: z.string().nullable(),
            expectedMessageKey: z.string().nullable(),
        })),
        matchedEntities: z.array(z.object({
            className: z.string(), tableName: z.string().nullable(),
            score: z.number(),
        })),
        suggestedFields: z.array(z.object({
            fieldId: z.string(), fieldName: z.string().nullable(),
            tag: z.string(), type: z.string().nullable(),
            labelText: z.string().nullable(), messageKey: z.string().nullable(),
            screenId: z.string(),
            csDecoratorSuggestion: z.object({
                propertyName: z.string(),
                decoratorCode: z.string(),
            }),
        })),
        suggestedAssertions: z.array(z.object({
            kind: z.enum(['success', 'error', 'validation']),
            messageKey: z.string(),
            messageText: z.string(),
            triggerCondition: z.string(),
            sourceValidator: z.string().nullable(),
        })),
        suggestedTestData: z.array(z.object({
            fieldName: z.string(),
            dbColumn: z.string().nullable(),
            type: z.string(),
            sampleValid: z.string(),
            sampleInvalid: z.string(),
        })),
        confidence: z.enum(['high', 'medium', 'low', 'unmatched']),
        reasoning: z.array(z.string()),
    })),
    unmatched: z.array(z.object({ acIndex: z.number(), acText: z.string(), hint: z.string() })),
    totals: z.object({
        acsAnalyzed: z.number(),
        acsMatched: z.number(),
        fieldsSuggested: z.number(),
        assertionsSuggested: z.number(),
    }),
});

export type GroundedHints = z.infer<typeof HintSchema>;

// -----------------------------------------------------------------------------
// AC loading.
// -----------------------------------------------------------------------------

interface ACLoaded {
    storyId: number | null;
    acs: Array<{ index: number; tag: string; text: string }>;
    source: string;
}

function loadAcsFromCheckpoint(pathAbs: string): { data?: ACLoaded; error?: string } {
    try {
        const raw = fs.readFileSync(pathAbs, 'utf-8');
        const parsed = JSON.parse(raw);
        const storyId = typeof parsed.storyId === 'number' ? parsed.storyId : null;
        const acs = Array.isArray(parsed.acs) ? parsed.acs.filter((a: unknown) => AcSchema.safeParse(a).success) as ACLoaded['acs'] : [];
        if (acs.length === 0) return { error: `checkpoint has no acs: ${pathAbs}` };
        return { data: { storyId, acs, source: pathAbs } };
    } catch (e) {
        return { error: `checkpoint-read-failed: ${pathAbs}: ${(e as Error).message}` };
    }
}

function parseInlineStory(text: string): ACLoaded['acs'] {
    // Extract bullet-form ACs from freeform story text — line starts with a
    // digit + `.`/`)` or with `-`/`*`.
    const lines = text.split(/\r?\n/);
    const out: ACLoaded['acs'] = [];
    let idx = 0;
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const m = trimmed.match(/^(?:AC\s*(\d+)\s*[:.-]|(\d+)[.)]\s|[-*]\s)(.*)/i);
        if (m) {
            idx++;
            const explicit = m[1] || m[2];
            const acIndex = explicit ? parseInt(explicit, 10) : idx;
            const text = m[3].trim();
            if (text) out.push({ index: acIndex, tag: `ac${acIndex}`, text });
        }
    }
    if (out.length === 0 && text.trim()) {
        // Fall back: treat the entire text as one AC.
        out.push({ index: 1, tag: 'ac1', text: text.trim() });
    }
    return out;
}

// -----------------------------------------------------------------------------
// Matching.
// -----------------------------------------------------------------------------

function endpointTokens(ep: SourceModel['endpoints'][number]): string[] {
    const path = splitIdentifier(ep.path);
    const ctrl = splitIdentifier(ep.controllerClass);
    const method = splitIdentifier(ep.methodName);
    const dtoTok = ep.requestDto ? splitIdentifier(ep.requestDto.className) : [];
    return Array.from(new Set([...path, ...ctrl, ...method, ...dtoTok]));
}

function screenTokens(scr: SourceModel['screens'][number]): string[] {
    const name = splitIdentifier(scr.screenName);
    const fieldToks: string[] = [];
    for (const form of scr.forms) {
        for (const f of form.fields) {
            if (f.id) fieldToks.push(...splitIdentifier(f.id));
            if (f.label) fieldToks.push(...tokenize(f.label));
        }
    }
    return Array.from(new Set([...name, ...fieldToks]));
}

function entityTokens(ent: SourceModel['entities'][number]): string[] {
    return Array.from(new Set([
        ...splitIdentifier(ent.className),
        ...(ent.tableName ? splitIdentifier(ent.tableName) : []),
        ...ent.columns.flatMap((c) => splitIdentifier(c.name)),
    ]));
}

function toPropName(id: string): string {
    // buttons "employee-list-add" → employeeListAdd
    let s = id.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).map((p, i) => i === 0 ? p.toLowerCase() : p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join('');
    if (/^[0-9]/.test(s)) s = 'field' + s.charAt(0).toUpperCase() + s.slice(1);
    if (!s) s = 'element';
    return s;
}

function decoratorFor(fieldId: string, labelText: string | null): string {
    const desc = labelText ? labelText.replace(/"/g, '\\"') : fieldId;
    return `@CSGetElement({ xpath: "//*[@id='${fieldId}']", description: "${desc}" })`;
}

function findMessageForConstraint(model: SourceModel, key: string | null, literal: string | null): { key: string; text: string } | null {
    if (literal) {
        // Search for a locale bucket that CONTAINS this literal — if the app
        // developer put the literal directly in the annotation, we still emit
        // it (and track a synthetic key for the audit trail).
        for (const [_locale, bundle] of Object.entries(model.messages)) {
            for (const [k, v] of Object.entries(bundle)) {
                if (v === literal) return { key: k, text: v };
            }
        }
        // No matching key — return a synthetic entry so the assertion is still
        // traceable to the annotation literal.
        return { key: `_inline_literal_`, text: literal };
    }
    if (key) {
        for (const bundle of Object.values(model.messages)) {
            if (bundle[key] !== undefined) return { key, text: bundle[key] };
        }
    }
    return null;
}

// -----------------------------------------------------------------------------
// Register.
// -----------------------------------------------------------------------------

registerPrimitive({
    name: 'cs_qa_ground_story',
    description: 'Cross-reference a story or AC checkpoint against the source-of-truth model (from cs_qa_source_ingest) and emit grounded hints (real DOM ids, real assertion literals, real column shapes) to .cs-qa/grounded-hints/story-<id>.json. Every assertion literal is copied verbatim from the app source; every field id is real; every sample-invalid respects the actual validator constraints.',
    inputSchema: InputSchema,
    outputSchema: z.object({
        ok: z.boolean(),
        outputPath: z.string().nullable(),
        hintsPreview: HintSchema.optional(),
        note: z.string().optional(),
    }),
    run: async (ctx, input) => {
        const log = createLogger(ctx.invocationId, 'cs_qa_ground_story', { workspaceRoot: ctx.workspaceRoot });

        // Resolve model path.
        const modelPath = input.sourceModelPath
            ? (path.isAbsolute(input.sourceModelPath) ? input.sourceModelPath : path.join(ctx.workspaceRoot, input.sourceModelPath))
            : path.join(ctx.workspaceRoot, '.cs-qa', 'source-model', 'model.json');
        const model = loadModel(modelPath);
        if (!model) {
            return {
                ok: false, outputPath: null,
                note: `source model not found or invalid at ${modelPath}. Run cs_qa_source_ingest first.`,
            };
        }

        // Load ACs.
        let loaded: ACLoaded | null = null;
        if (input.acCheckpointPath) {
            const abs = path.isAbsolute(input.acCheckpointPath) ? input.acCheckpointPath : path.join(ctx.workspaceRoot, input.acCheckpointPath);
            const r = loadAcsFromCheckpoint(abs);
            if (r.error) return { ok: false, outputPath: null, note: r.error };
            loaded = r.data!;
        } else if (input.storyId !== undefined) {
            const abs = path.join(ctx.workspaceRoot, '.cs-qa', 'run-state', `story-${input.storyId}-acs.json`);
            const r = loadAcsFromCheckpoint(abs);
            if (r.error) return { ok: false, outputPath: null, note: r.error };
            loaded = r.data!;
        } else if (input.storyText !== undefined) {
            loaded = { storyId: null, acs: parseInlineStory(input.storyText), source: '<inline>' };
        }
        if (!loaded) return { ok: false, outputPath: null, note: 'no acs loaded (should not happen — refine passed)' };

        log.info('ground_story: loaded acs', { count: loaded.acs.length, source: loaded.source });

        const perAc: GroundedHints['perAc'] = [];
        const unmatched: GroundedHints['unmatched'] = [];

        for (const ac of loaded.acs) {
            const acTokens = tokenize(ac.text);
            const intent = extractIntentVerb(ac.text);
            const reasoning: string[] = [];
            reasoning.push(`AC tokens: ${acTokens.join(', ')}`);
            if (intent) reasoning.push(`Intent verb: ${intent}`);

            // ENDPOINT matches.
            const endpointScored = model.endpoints.map((ep) => {
                const { score, matched } = weightedScore(acTokens, endpointTokens(ep));
                const verbBoost = intent && verbMatchesHttp(intent, ep.verb) ? 0.15 : 0;
                return {
                    ep,
                    score: score + verbBoost,
                    matched,
                    verbMatched: verbBoost > 0,
                };
            }).filter((s) => s.score >= input.matchThreshold)
                .sort((a, b) => b.score - a.score)
                .slice(0, input.maxCandidatesPerAc);
            const matchedEndpoints = endpointScored.map((s) => ({
                endpointId: s.ep.id, verb: s.ep.verb, path: s.ep.path,
                score: Number(s.score.toFixed(3)),
                why: `token overlap: ${s.matched.join(', ') || '(verb-only)'}${s.verbMatched ? '; verb match (' + intent + '→' + s.ep.verb + ')' : ''}`,
            }));

            // SCREEN matches.
            const screenScored = model.screens.map((scr) => {
                const { score, matched } = weightedScore(acTokens, screenTokens(scr));
                // Boost if any matched endpoint's URL appears as an action on this
                // screen's form.
                let crossBoost = 0;
                for (const form of scr.forms) {
                    for (const ep of endpointScored) {
                        if (form.action && (form.action.includes(ep.ep.path) || ep.ep.path.includes(form.action))) crossBoost = Math.max(crossBoost, 0.15);
                    }
                }
                return { scr, score: score + crossBoost, matched, crossBoost };
            }).filter((s) => s.score >= input.matchThreshold)
                .sort((a, b) => b.score - a.score)
                .slice(0, input.maxCandidatesPerAc);
            const matchedScreens = screenScored.map((s) => ({
                screenId: s.scr.id, screenName: s.scr.screenName,
                score: Number(s.score.toFixed(3)),
                why: `token overlap: ${s.matched.join(', ')}${s.crossBoost > 0 ? '; form action ties to matched endpoint' : ''}`,
            }));

            // ENTITY matches.
            const entityScored = model.entities.map((ent) => {
                const { score, matched } = weightedScore(acTokens, entityTokens(ent));
                return { ent, score, matched };
            }).filter((s) => s.score >= input.matchThreshold)
                .sort((a, b) => b.score - a.score)
                .slice(0, input.maxCandidatesPerAc);
            const matchedEntities = entityScored.map((s) => ({
                className: s.ent.className, tableName: s.ent.tableName,
                score: Number(s.score.toFixed(3)),
            }));

            // VALIDATOR matches — a validator matches when its class is one of
            // the matched endpoints' request DTO OR the DTO's tokens overlap
            // the AC.
            const validatorFor: Array<{ className: string; field: string; constraint: string; expectedMessageLiteral: string | null; expectedMessageKey: string | null }> = [];
            const validatorClassesInScope = new Set<string>();
            for (const ep of endpointScored) {
                if (ep.ep.requestDto) validatorClassesInScope.add(ep.ep.requestDto.className);
                for (const v of ep.ep.validators) validatorClassesInScope.add(v);
            }
            for (const v of model.validators) {
                let inScope = validatorClassesInScope.has(v.className);
                if (!inScope) {
                    const { score } = weightedScore(acTokens, splitIdentifier(v.className));
                    if (score >= input.matchThreshold) inScope = true;
                }
                if (!inScope) continue;
                for (const c of v.constraints) {
                    validatorFor.push({
                        className: v.className, field: c.field, constraint: c.kind,
                        expectedMessageLiteral: c.errorMessageLiteral,
                        expectedMessageKey: c.errorMessageKey,
                    });
                }
            }
            const matchedValidators = validatorFor.slice(0, 50);

            // SUGGESTED FIELDS — real DOM ids from matched screens.
            const suggestedFields: GroundedHints['perAc'][number]['suggestedFields'] = [];
            for (const s of screenScored) {
                for (const form of s.scr.forms) {
                    for (const f of form.fields) {
                        if (!f.id) continue;
                        suggestedFields.push({
                            fieldId: f.id,
                            fieldName: f.name,
                            tag: f.tag,
                            type: f.type,
                            labelText: f.label,
                            messageKey: f.messageKey,
                            screenId: s.scr.id,
                            csDecoratorSuggestion: {
                                propertyName: toPropName(f.id),
                                decoratorCode: decoratorFor(f.id, f.label),
                            },
                        });
                    }
                }
                if (suggestedFields.length >= 40) break;
            }

            // SUGGESTED ASSERTIONS — from validator error messages found in the
            // messages bundle, verbatim.
            const suggestedAssertions: GroundedHints['perAc'][number]['suggestedAssertions'] = [];
            for (const v of matchedValidators) {
                const msg = findMessageForConstraint(model, v.expectedMessageKey, v.expectedMessageLiteral);
                if (!msg) continue;
                // Guard: never emit a "literal" that could not be found. If key was
                // present but not in any bundle, msg is null → we skip.
                suggestedAssertions.push({
                    kind: 'validation',
                    messageKey: msg.key,
                    messageText: msg.text,
                    triggerCondition: `field '${v.field}' fails ${v.constraint} on ${v.className}`,
                    sourceValidator: v.className,
                });
            }
            // Also suggest a success message when the message bundle contains a
            // "saved successfully" / "created successfully" style key that
            // token-overlaps the AC.
            for (const [_locale, bundle] of Object.entries(model.messages)) {
                for (const [k, v] of Object.entries(bundle)) {
                    const kt = splitIdentifier(k);
                    const { score } = weightedScore(acTokens, kt);
                    if (score < 0.15) continue;
                    if (/success|saved|created|updated|deleted|approved/i.test(v)) {
                        if (!suggestedAssertions.some((a) => a.messageKey === k)) {
                            suggestedAssertions.push({
                                kind: 'success',
                                messageKey: k,
                                messageText: v,
                                triggerCondition: 'workflow completes as ' + (extractIntentVerb(v) || 'expected'),
                                sourceValidator: null,
                            });
                        }
                    }
                }
                if (suggestedAssertions.length > 20) break;
            }

            // SUGGESTED TEST DATA — column-shape-aware.
            const suggestedTestData: GroundedHints['perAc'][number]['suggestedTestData'] = [];
            const seenFields = new Set<string>();
            for (const s of entityScored) {
                for (const col of s.ent.columns) {
                    if (seenFields.has(col.name)) continue;
                    seenFields.add(col.name);
                    // Correlate constraints from validators keyed by same field name.
                    const constraints = matchedValidators.filter((v) => v.field === col.name)
                        .map((v) => ({ kind: v.constraint, args: {} as Record<string, string> }));
                    // Also pick up field-level constraints from column itself.
                    for (const c of col.constraints) constraints.push({ kind: c.kind, args: c.args });
                    // And DTO-level constraints (from validators whose DTO matched).
                    for (const v of model.validators) {
                        for (const c of v.constraints) {
                            if (c.field === col.name && validatorClassesInScope.has(v.className)) {
                                constraints.push({ kind: c.kind, args: c.args });
                            }
                        }
                    }
                    suggestedTestData.push({
                        fieldName: col.name,
                        dbColumn: col.dbColumn,
                        type: col.type,
                        sampleValid: suggestSample(col.type, constraints, 'valid'),
                        sampleInvalid: suggestSample(col.type, constraints, 'invalid'),
                    });
                }
                if (suggestedTestData.length >= 20) break;
            }
            // Also add DTO fields as candidate test data when no entity matched.
            if (suggestedTestData.length === 0 && matchedEndpoints.length > 0) {
                for (const ep of endpointScored) {
                    if (!ep.ep.requestDto) continue;
                    for (const f of ep.ep.requestDto.fields) {
                        if (seenFields.has(f.name)) continue;
                        seenFields.add(f.name);
                        const constraints = f.constraints.map((c) => ({ kind: c.kind, args: c.args }));
                        suggestedTestData.push({
                            fieldName: f.name,
                            dbColumn: f.dbColumn,
                            type: f.type,
                            sampleValid: suggestSample(f.type, constraints, 'valid'),
                            sampleInvalid: suggestSample(f.type, constraints, 'invalid'),
                        });
                    }
                    if (suggestedTestData.length >= 20) break;
                }
            }

            // Confidence.
            const bestEndpointScore = endpointScored[0]?.score ?? 0;
            const bestScreenScore = screenScored[0]?.score ?? 0;
            const bestOverall = Math.max(bestEndpointScore, bestScreenScore);
            const hasDomainNoun = acTokens.some((t) => ['employee', 'account', 'order', 'invoice', 'customer', 'product', 'deal', 'series'].includes(t));
            const verbMatched = endpointScored.some((s) => s.verbMatched);
            const confidence = classifyConfidence(bestOverall, verbMatched, hasDomainNoun);

            if (confidence === 'unmatched') {
                unmatched.push({
                    acIndex: ac.index, acText: ac.text,
                    hint: intent
                        ? `no ${intent} endpoint matched; verify AC actually maps to backend behavior or is UI-only.`
                        : 'no matching endpoint or screen found — check if AC refers to UI-only state or an untested area of the app.',
                });
                perAc.push({
                    acIndex: ac.index, acTag: ac.tag, acText: ac.text,
                    matchedEndpoints, matchedScreens, matchedValidators, matchedEntities,
                    suggestedFields, suggestedAssertions, suggestedTestData,
                    confidence, reasoning,
                });
                continue;
            }

            reasoning.push(`Best endpoint score: ${bestEndpointScore.toFixed(3)}, best screen score: ${bestScreenScore.toFixed(3)}, verb matched: ${verbMatched}`);

            perAc.push({
                acIndex: ac.index, acTag: ac.tag, acText: ac.text,
                matchedEndpoints, matchedScreens, matchedValidators, matchedEntities,
                suggestedFields, suggestedAssertions, suggestedTestData,
                confidence, reasoning,
            });
        }

        const hints: GroundedHints = {
            storyId: loaded.storyId,
            generatedAt: new Date().toISOString(),
            modelPath,
            perAc,
            unmatched,
            totals: {
                acsAnalyzed: loaded.acs.length,
                acsMatched: perAc.filter((p) => p.confidence !== 'unmatched').length,
                fieldsSuggested: perAc.reduce((s, p) => s + p.suggestedFields.length, 0),
                assertionsSuggested: perAc.reduce((s, p) => s + p.suggestedAssertions.length, 0),
            },
        };

        // Guardrail — every messageText MUST be traceable to a bundle entry.
        for (const p of perAc) {
            for (const a of p.suggestedAssertions) {
                if (a.messageKey === '_inline_literal_') continue;
                const found = Object.values(model.messages).some((b) => b[a.messageKey] === a.messageText);
                if (!found) {
                    return { ok: false, outputPath: null, note: `internal guard failed: assertion key ${a.messageKey} not traceable to messages bundle` };
                }
            }
        }

        const outAbs = input.outputPath
            ? (path.isAbsolute(input.outputPath) ? input.outputPath : path.join(ctx.workspaceRoot, input.outputPath))
            : path.join(ctx.workspaceRoot, '.cs-qa', 'grounded-hints', `story-${loaded.storyId ?? 'inline'}.json`);

        if (!input.dryRun) {
            try {
                fs.mkdirSync(path.dirname(outAbs), { recursive: true });
                fs.writeFileSync(outAbs, JSON.stringify(hints, null, 2), 'utf-8');
            } catch (e) {
                return { ok: false, outputPath: null, note: 'write-failed: ' + (e as Error).message };
            }
        }

        return {
            ok: true,
            outputPath: input.dryRun ? null : outAbs,
            hintsPreview: input.dryRun ? hints : undefined,
            note: `${hints.totals.acsMatched}/${hints.totals.acsAnalyzed} ACs matched, ${hints.totals.fieldsSuggested} fields, ${hints.totals.assertionsSuggested} assertions suggested.`,
        };
    },
});

export { HintSchema };
