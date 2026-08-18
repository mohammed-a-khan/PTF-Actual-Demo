/**
 * CS Report Validation — Standalone section validator.
 *
 * Given a `CanonicalReport` and its spec, decides whether every
 * `spec.requiredSections` entry was detected (and — under
 * `spec.enforceSectionOrder` — that they appeared in the declared order).
 * Emits `MISSING` findings for absent sections and `SECTION_RESTRUCTURE`
 * findings for order violations, both using the same FNV-1a-32 id scheme
 * as the reconciler so downstream diff reports can merge results cleanly.
 *
 * PURE FUNCTION
 * -------------
 * No I/O, no reporter side effects, no collaborators. `validate(canonical, spec)`
 * returns a `SectionValidationResult` and nothing else. `CSReportValidationService`
 * exposes a thin passthrough for BDD-step ergonomics; direct consumers (project
 * code that just wants section validation without orchestration) import from here.
 *
 * @module report-validation/CSReportSectionValidator
 */

import type { CanonicalReport, Finding } from './CSReportModel';
import type { ReportSpec } from './CSReportSpec';

/** Section-validation outcome. */
export interface SectionValidationResult {
    /** True iff every `spec.requiredSections` entry was `present: true` on the canonical, and (when `enforceSectionOrder`) they appeared in the declared order. */
    passed: boolean;
    /** Findings suitable for merging into a reconciliation report. */
    findings: Finding[];
    /** Canonical ids that were detected. */
    presentSections: string[];
    /** Canonical ids required by the spec that were not detected. */
    missingSections: string[];
    /** Human-readable notes describing any order violations (empty when order was fine or not enforced). */
    orderIssues: string[];
}

/**
 * Static entry point. Kept as a class-with-static-method (matching the reconciler
 * and diff-reporter shape) so consumers have one consistent import style across
 * the module.
 */
export class CSReportSectionValidator {
    static validate(canonical: CanonicalReport, spec: ReportSpec): SectionValidationResult {
        return validateSections(canonical, spec);
    }
}

/**
 * Function form of the validator — importable directly by callers that prefer
 * free functions to static classes.
 */
export function validateSections(canonical: CanonicalReport, spec: ReportSpec): SectionValidationResult {
    const detectedByCanonicalId = new Map<string, number>(); // canonicalId → order
    for (const s of canonical.sections) {
        if (s.present) detectedByCanonicalId.set(s.id, s.order);
    }

    const presentSections: string[] = [];
    const missingSections: string[] = [];
    const findings: Finding[] = [];
    for (const req of spec.requiredSections) {
        if (detectedByCanonicalId.has(req.id)) {
            presentSections.push(req.id);
        } else {
            missingSections.push(req.id);
            findings.push({
                id: sectionFindingId(req.id, 'missing'),
                classification: 'MISSING',
                section: req.id,
                key: {},
                reason: `Required section "${req.title}" is missing from the ${canonical.source} report`,
            });
        }
    }

    const orderIssues: string[] = [];
    if (spec.enforceSectionOrder) {
        const expected = spec.requiredSections
            .filter((r) => detectedByCanonicalId.has(r.id))
            .sort((a, b) => a.order - b.order)
            .map((r) => r.id);
        const actual = [...detectedByCanonicalId.entries()]
            .sort((a, b) => a[1] - b[1])
            .map(([id]) => id)
            .filter((id) => expected.includes(id));
        if (!arraysEqual(expected, actual)) {
            const note = `Section order mismatch on ${canonical.source}: expected [${expected.join(', ')}] but got [${actual.join(', ')}]`;
            orderIssues.push(note);
            findings.push({
                id: sectionFindingId('*order*', 'restructure'),
                classification: 'SECTION_RESTRUCTURE',
                section: '*',
                key: {},
                reason: note,
            });
        }
    }

    const passed = missingSections.length === 0 && orderIssues.length === 0;
    return { passed, findings, presentSections, missingSections, orderIssues };
}

// ---------------------------------------------------------------------------
// Internals — kept module-local; share the FNV-1a-32 scheme with the reconciler
// and checksum validator so merged diff reports have consistent ids.
// ---------------------------------------------------------------------------

function sectionFindingId(section: string, kind: string): string {
    const s = `${section}${kind}`;
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}

function arraysEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}
