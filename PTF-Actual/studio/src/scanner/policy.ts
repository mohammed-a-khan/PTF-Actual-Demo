/**
 * Team policy for the secret scan, stored in the repository at `.cs-studio/policy.json`.
 *
 *   {
 *     "secretScan": {
 *       "allowOverride": true,            // may a user commit anyway after giving a reason?
 *       "overrideHighConfidence": true,   // ...also when a finding is high-confidence?
 *       "scanOnPush": true                // re-scan every commit a push would send
 *     }
 *   }
 *
 * Defaults follow the agreed product decision: block, explain, offer fixes, and allow an
 * override with a recorded reason.
 */
import * as fs from 'fs';
import * as path from 'path';
import { RawFinding } from './types';

export interface SecretScanPolicy {
    allowOverride: boolean;
    overrideHighConfidence: boolean;
    scanOnPush: boolean;
    /** The policy file exists but cannot be read: the strict policy applies (no override) until it is fixed. */
    problem?: string;
}

export const POLICY_PATH = '.cs-studio/policy.json';

export const DEFAULT_POLICY: SecretScanPolicy = {
    allowOverride: true,
    overrideHighConfidence: true,
    scanOnPush: true,
};

export function readPolicy(repoRoot: string): SecretScanPolicy {
    let text: string;
    try { text = fs.readFileSync(path.join(repoRoot, POLICY_PATH), 'utf8'); }
    catch { return { ...DEFAULT_POLICY }; }
    try {
        // Comments as in the example above are allowed.
        const data = JSON.parse(text.replace(/\/\*[\s\S]*?\*\/|(^|[^:"'\\])\/\/.*$/gm, '$1').replace(/,(\s*[}\]])/g, '$1'));
        const s = data?.secretScan ?? {};
        return {
            allowOverride: typeof s.allowOverride === 'boolean' ? s.allowOverride : DEFAULT_POLICY.allowOverride,
            overrideHighConfidence: typeof s.overrideHighConfidence === 'boolean' ? s.overrideHighConfidence : DEFAULT_POLICY.overrideHighConfidence,
            scanOnPush: typeof s.scanOnPush === 'boolean' ? s.scanOnPush : DEFAULT_POLICY.scanOnPush,
        };
    } catch (e) {
        // A team that wrote a policy meant to restrict: never fall back to the permissive defaults.
        return { allowOverride: false, overrideHighConfidence: false, scanOnPush: true, problem: `${POLICY_PATH} cannot be read (${(e as Error).message})` };
    }
}

/** Why an override is not allowed for these findings, or null if it is allowed. */
export function overrideRefusal(policy: SecretScanPolicy, findings: RawFinding[]): string | null {
    if (policy.problem) return `${policy.problem}: until it is fixed, committing with secret-scan findings is not allowed.`;
    if (!policy.allowOverride) return 'Your team policy does not allow committing with secret-scan findings.';
    if (!policy.overrideHighConfidence && findings.some((f) => f.confidence === 'high')) {
        return 'Your team policy does not allow overriding high-confidence findings. Fix them first.';
    }
    return null;
}

/** Minimum length of a usable override reason (a word or two, not just "x"). */
export const MIN_OVERRIDE_REASON = 8;

export function validateOverrideReason(reason: string | undefined): string | null {
    const r = (reason ?? '').replace(/\s+/g, ' ').trim();
    if (r.length < MIN_OVERRIDE_REASON) return `Please give a reason of at least ${MIN_OVERRIDE_REASON} characters.`;
    if (/[\r\n]/.test(reason ?? '')) return 'The reason must be a single line.';
    return null;
}

export const OVERRIDE_TRAILER = 'Secret-Scan-Override';
