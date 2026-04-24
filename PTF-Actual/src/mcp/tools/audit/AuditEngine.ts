/**
 * AuditEngine — deterministic rule runner over source files.
 *
 * Loads rules from the bundled `audit-rules/rules.yaml` skill and
 * applies them to provided content. Supports regex-based detection with
 * two modes:
 *
 *   invertMatch: false | undefined (required pattern)
 *     The regex MUST match at least once, or a violation is emitted.
 *     Example: `@CSPage\s*\(` in a page-object file.
 *
 *   invertMatch: true (anti-pattern)
 *     The regex MUST NOT match anywhere, or a violation is emitted for
 *     each match (with line number). Example: `console\.log` anywhere.
 *
 * Rules without a `detect` field are semantic-only and silently skipped
 * by this engine (future work: TypeScript AST integration).
 *
 * @module tools/audit/AuditEngine
 */

import * as yaml from 'js-yaml';
import { SKILL_CONTENT } from '../../skills/embeddedSkillContent';

// ============================================================================
// Types
// ============================================================================

export type RuleSeverity = 'error' | 'warn';

export type FileType = 'page' | 'step' | 'feature' | 'data' | 'helper' | 'ts';

export interface AuditRule {
    id: string;
    severity: RuleSeverity;
    appliesTo: string | string[];
    description?: string;
    detect?: string;
    invertMatch?: boolean;
    violation: string;
}

export interface AuditViolation {
    ruleId: string;
    severity: RuleSeverity;
    line: number | null;
    message: string;
    match?: string;
}

export interface AuditStats {
    totalRulesChecked: number;
    applicableRules: number;
    nonApplicableRules: number;
    semanticRulesSkipped: number;
    errors: number;
    warnings: number;
}

export interface AuditResult {
    pass: boolean;
    violations: AuditViolation[];
    stats: AuditStats;
}

// ============================================================================
// Engine
// ============================================================================

/**
 * File-type aliases — a rule `appliesTo: ts` also applies to page, step,
 * and helper files (all TypeScript). Feature and data files are their
 * own domain.
 */
const TS_FILE_TYPES: readonly FileType[] = ['page', 'step', 'helper', 'ts'];

export class AuditEngine {
    private readonly rules: AuditRule[];

    constructor(rules?: AuditRule[]) {
        this.rules = rules ?? AuditEngine.loadDefaultRules();
    }

    /**
     * Load rules from the embedded `audit-rules/rules.yaml` skill content.
     * Throws if the skill or its rules.yaml is missing or malformed.
     */
    static loadDefaultRules(): AuditRule[] {
        const skill = SKILL_CONTENT['audit-rules'];
        if (!skill) {
            throw new Error(
                'AuditEngine: audit-rules skill is not present in SKILL_CONTENT. ' +
                'Did embed-skills.js run before build?'
            );
        }
        const yamlText = skill['rules.yaml'];
        if (!yamlText) {
            throw new Error(
                'AuditEngine: audit-rules/rules.yaml is not present in the embedded skill.'
            );
        }
        const parsed = yaml.load(yamlText) as { rules?: AuditRule[] } | null;
        if (!parsed || !Array.isArray(parsed.rules)) {
            throw new Error(
                'AuditEngine: rules.yaml did not parse to a document with a top-level rules array.'
            );
        }
        return parsed.rules;
    }

    /**
     * Run the applicable subset of rules against the given content.
     */
    audit(content: string, fileType: FileType): AuditResult {
        const violations: AuditViolation[] = [];
        let applicable = 0;
        let semanticSkipped = 0;

        for (const rule of this.rules) {
            if (!this.appliesTo(rule, fileType)) continue;
            applicable++;

            if (!rule.detect) {
                // Semantic rule — no regex to run; handled by future AST engine.
                semanticSkipped++;
                continue;
            }

            const ruleViolations = this.checkRule(rule, content);
            violations.push(...ruleViolations);
        }

        const errors = violations.filter(v => v.severity === 'error').length;
        const warnings = violations.length - errors;

        return {
            pass: errors === 0,
            violations,
            stats: {
                totalRulesChecked: this.rules.length,
                applicableRules: applicable,
                nonApplicableRules: this.rules.length - applicable,
                semanticRulesSkipped: semanticSkipped,
                errors,
                warnings,
            },
        };
    }

    // --------------------------------------------------------------------
    // Internals
    // --------------------------------------------------------------------

    private appliesTo(rule: AuditRule, fileType: FileType): boolean {
        const raw = rule.appliesTo;
        const tokens = this.normaliseAppliesTo(raw);

        if (tokens.includes('any')) return true;
        if (tokens.includes(fileType)) return true;

        // A rule tagged `ts` applies to any TypeScript file type.
        if (tokens.includes('ts') && TS_FILE_TYPES.includes(fileType)) return true;

        return false;
    }

    private normaliseAppliesTo(raw: string | string[]): string[] {
        if (Array.isArray(raw)) {
            return raw.flatMap(s => String(s).split(',')).map(s => s.trim()).filter(Boolean);
        }
        if (typeof raw === 'string') {
            return raw.split(',').map(s => s.trim()).filter(Boolean);
        }
        return [];
    }

    private checkRule(rule: AuditRule, content: string): AuditViolation[] {
        // Only regex-based detection is supported in this engine.
        if (!rule.detect || !rule.detect.startsWith('regex:')) {
            return [];
        }

        const pattern = rule.detect.substring('regex:'.length);
        let regex: RegExp;
        try {
            regex = new RegExp(pattern, 'gm');
        } catch (err: any) {
            return [{
                ruleId: rule.id,
                severity: 'warn',
                line: null,
                message: `Rule ${rule.id} has invalid regex: ${err.message}`,
            }];
        }

        const matches: Array<{ match: string; line: number; index: number }> = [];
        let m: RegExpExecArray | null;
        while ((m = regex.exec(content)) !== null) {
            const line = AuditEngine.lineOf(content, m.index);
            matches.push({ match: m[0], line, index: m.index });
            if (regex.lastIndex === m.index) {
                regex.lastIndex++; // guard against zero-width infinite loops
            }
        }

        if (rule.invertMatch) {
            // Anti-pattern semantics: any match is a violation.
            return matches.map(({ line, match }) => ({
                ruleId: rule.id,
                severity: rule.severity,
                line,
                message: rule.violation,
                match,
            }));
        }

        // Required-pattern semantics: zero matches is a violation.
        if (matches.length === 0) {
            return [{
                ruleId: rule.id,
                severity: rule.severity,
                line: null,
                message: rule.violation,
            }];
        }
        return [];
    }

    private static lineOf(content: string, index: number): number {
        // 1-indexed line number of the character at `index`.
        let line = 1;
        for (let i = 0; i < index; i++) {
            if (content.charCodeAt(i) === 10) line++; // LF
        }
        return line;
    }
}
