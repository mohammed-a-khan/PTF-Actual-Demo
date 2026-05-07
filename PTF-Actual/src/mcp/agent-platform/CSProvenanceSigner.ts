/**
 * Agentic Test Platform — Provenance Signer (Phase 8).
 *
 * Computes / verifies HMAC-SHA256 signatures over a generated artefact's
 * provenance metadata. Lets a downstream auditor confirm that:
 *   1. The file was produced by THIS platform run (not hand-written)
 *   2. The content matches what the platform emitted (not tampered)
 *   3. The signing key has not changed since emit (key rotation gate)
 *
 * Key handling: the signing key is read from `CS_PROVENANCE_KEY` in
 * `CSConfigurationManager` (auto-decrypts `ENCRYPTED:` payloads). When
 * absent, signing is **disabled** rather than failing — provenance
 * headers still get stamped, just without the signature line. This
 * preserves backward compatibility with existing artefacts.
 *
 * The signature line is appended to the existing provenance header
 * block, so it does NOT change file structure for tools that already
 * read provenance (`emit_provenance_header`).
 *
 * @module agent-platform/CSProvenanceSigner
 */

import * as crypto from 'crypto';
import { CSConfigurationManager } from '../../core/CSConfigurationManager';

// ============================================================================
// Public Types
// ============================================================================

export interface ProvenanceMetadata {
    runId: string;
    pipelineVersion: string;
    sourceHash: string;
    /** ISO 8601 timestamp when the artefact was generated. */
    emittedAt: string;
    /** Mode that produced the artefact (e.g. legacy_test_code). */
    mode: string;
}

export interface SignedProvenance {
    metadata: ProvenanceMetadata;
    /** Hex-encoded HMAC-SHA256 signature, or undefined when no key. */
    signature?: string;
    /**
     * Short fingerprint of the key used to sign — first 8 chars of
     * SHA-256(key). Lets verifiers detect key rotation without revealing
     * the key. Undefined when signing is disabled.
     */
    keyFingerprint?: string;
}

export interface VerifyResult {
    verified: boolean;
    reason?: string;
    /** True when signing was disabled (no key configured) — distinct from a
     *  failed verification. */
    skipped?: boolean;
}

// ============================================================================
// CSProvenanceSigner
// ============================================================================

export class CSProvenanceSigner {
    /** Config key for the signing secret. Encrypted-at-rest recommended. */
    private static readonly KEY_NAME = 'CS_PROVENANCE_KEY';

    /**
     * Compute the canonical sign-payload string for a given metadata
     * record. Order matters — verifiers must produce the exact same
     * string. Sort keys + use a stable separator.
     */
    private static canonicalPayload(
        metadata: ProvenanceMetadata,
        contentHash: string,
    ): string {
        const ordered: Record<string, string> = {
            contentHash,
            emittedAt: metadata.emittedAt,
            mode: metadata.mode,
            pipelineVersion: metadata.pipelineVersion,
            runId: metadata.runId,
            sourceHash: metadata.sourceHash,
        };
        return Object.entries(ordered)
            .map(([k, v]) => `${k}=${v}`)
            .join('|');
    }

    private static readKey(): string | null {
        try {
            const v = CSConfigurationManager.getInstance().get(
                CSProvenanceSigner.KEY_NAME,
                '',
            );
            return v && v.length >= 16 ? v : null;
        } catch {
            return null;
        }
    }

    private static fingerprint(key: string): string {
        return crypto.createHash('sha256').update(key).digest('hex').slice(0, 8);
    }

    /**
     * Hash the file content (sha256, hex) — separate from the source
     * hash because the artefact is the OUTPUT of the migration, not the
     * input.
     */
    public static hashContent(content: string): string {
        return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
    }

    /**
     * Sign a metadata record + the artefact content hash. Returns a
     * `SignedProvenance` even when no key is configured (signature
     * fields are undefined in that case so callers can handle both
     * paths uniformly).
     */
    public static sign(
        metadata: ProvenanceMetadata,
        contentHash: string,
    ): SignedProvenance {
        const key = CSProvenanceSigner.readKey();
        if (!key) {
            return { metadata };
        }
        const payload = CSProvenanceSigner.canonicalPayload(metadata, contentHash);
        const signature = crypto
            .createHmac('sha256', key)
            .update(payload)
            .digest('hex');
        return {
            metadata,
            signature,
            keyFingerprint: CSProvenanceSigner.fingerprint(key),
        };
    }

    /**
     * Verify a previously-signed record against the current artefact
     * content. Returns `{verified: true}` on a match, `{verified: false,
     * reason}` on mismatch, `{verified: false, skipped: true}` when the
     * signing key isn't currently configured (treat as informational —
     * the artefact may have been signed under an earlier key).
     */
    public static verify(
        signed: SignedProvenance,
        currentContent: string,
    ): VerifyResult {
        if (!signed.signature || !signed.keyFingerprint) {
            return {
                verified: false,
                skipped: true,
                reason: 'no signature on record (signing was disabled at emit time)',
            };
        }
        const key = CSProvenanceSigner.readKey();
        if (!key) {
            return {
                verified: false,
                skipped: true,
                reason: `verification key (${CSProvenanceSigner.KEY_NAME}) not configured`,
            };
        }
        if (CSProvenanceSigner.fingerprint(key) !== signed.keyFingerprint) {
            return {
                verified: false,
                reason: `key fingerprint mismatch: signed under ${signed.keyFingerprint}, current key is ${CSProvenanceSigner.fingerprint(key)}`,
            };
        }
        const currentHash = CSProvenanceSigner.hashContent(currentContent);
        const payload = CSProvenanceSigner.canonicalPayload(
            signed.metadata,
            currentHash,
        );
        const expected = crypto
            .createHmac('sha256', key)
            .update(payload)
            .digest('hex');
        // Constant-time comparison to avoid timing oracles.
        const a = Buffer.from(signed.signature, 'hex');
        const b = Buffer.from(expected, 'hex');
        if (a.length !== b.length) {
            return { verified: false, reason: 'signature length mismatch' };
        }
        if (!crypto.timingSafeEqual(a, b)) {
            return {
                verified: false,
                reason: 'signature mismatch — content was modified after sign',
            };
        }
        return { verified: true };
    }

    /**
     * Render a signed-provenance block as a comment string suitable for
     * appending to the existing `# @generated …` header block in
     * generated artefacts. Returns empty string when no signature is
     * present (no key configured) so callers can simply concatenate.
     */
    public static renderHeaderLines(
        signed: SignedProvenance,
        commentPrefix: string = '#',
    ): string {
        if (!signed.signature) return '';
        return [
            `${commentPrefix} @signature ${signed.signature}`,
            `${commentPrefix} @key-fingerprint ${signed.keyFingerprint}`,
        ].join('\n');
    }
}
