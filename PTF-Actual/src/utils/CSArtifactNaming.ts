/**
 * CSArtifactNaming — safe, bounded filenames for screenshots / videos /
 * traces / HAR files.
 *
 * WHY THIS EXISTS
 * ---------------
 * Evidence filenames are frequently derived from assertion messages, step
 * text, scenario names, or element action names — all of which can be very
 * long (an assertion message can be 150+ chars). On Windows the classic
 * `MAX_PATH` limit is 260 characters for the WHOLE path. In a CI agent the
 * base directory is already deep, e.g.:
 *
 *   C:\azagent2\4\s\<repo>\reports\test-results-<ts>\screenshots\
 *
 * so an over-long filename pushes the full path past 260 and downstream
 * steps blow up — most visibly the "zip the results" step, where
 * PowerShell `Compress-Archive` throws
 * `CompressArchiveUnauthorizedAccessError` / `DirectoryNotFoundException`
 * ("Could not find a part of the path ...") even though the file exists.
 *
 * This helper GUARANTEES a bounded, filesystem-safe segment: the descriptive
 * part is sanitized and hard-capped, and when it has to be truncated a short
 * deterministic hash of the original is appended so distinct long names never
 * collide after truncation.
 *
 * It is a pure string utility — no Node fs/path imports needed for the core
 * logic — so it is trivially testable and safe to call from any layer.
 *
 * @module utils/CSArtifactNaming
 */

/**
 * Maximum length of the DESCRIPTIVE segment of an artifact filename (before
 * any status prefix, worker suffix, timestamp, or extension are added).
 *
 * 40 keeps a full path comfortably under Windows MAX_PATH even in deep CI
 * workspaces: base(~110) + prefix(~12) + name(40) + suffix/ts(~30) +
 * ext(4) ≈ 196 < 260.
 */
export const MAX_ARTIFACT_NAME_SEGMENT = 40;

/**
 * Deterministic, dependency-free short hash (djb2 → base36, 6 chars). Used to
 * keep truncated names unique. Not cryptographic — collision-resistance at
 * this scale is all that is required.
 */
function shortHash(input: string): string {
    let h = 5381;
    for (let i = 0; i < input.length; i++) {
        h = (h * 33) ^ input.charCodeAt(i);
    }
    // >>> 0 → unsigned; base36 for compactness.
    return (h >>> 0).toString(36).slice(0, 6).padStart(6, '0');
}

/**
 * Sanitize + hard-cap a descriptive filename segment.
 *
 * - Replaces every run of non-alphanumerics with a single '-'.
 * - Trims leading/trailing '-'.
 * - If the result exceeds `maxLen`, truncates and appends `-<hash>` (where
 *   the hash is derived from the ORIGINAL, so two different long inputs that
 *   share a prefix still produce different names). The final string is
 *   guaranteed to be at most `maxLen` characters.
 * - Never returns an empty string (falls back to the hash, or 'artifact').
 *
 * @param raw     the raw descriptive text (assertion message, action name…)
 * @param maxLen  max length of the returned segment (default 40)
 */
export function boundedNameSegment(raw: string, maxLen: number = MAX_ARTIFACT_NAME_SEGMENT): string {
    const original = (raw ?? '').toString();
    const cleaned = original
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');

    if (cleaned.length <= maxLen) {
        return cleaned.length > 0 ? cleaned : (original.length > 0 ? shortHash(original) : 'artifact');
    }

    // Too long → truncate and append a hash of the original for uniqueness.
    const hash = shortHash(original);
    const keep = Math.max(1, maxLen - hash.length - 1); // room for '-' + hash
    const head = cleaned.slice(0, keep).replace(/-+$/g, '');
    return `${head}-${hash}`.slice(0, maxLen);
}

/**
 * Build a complete, bounded artifact filename.
 *
 * Shape: `<prefix><name><suffix>-<timestamp><ext>` where `<name>` is the
 * bounded segment. The timestamp is caller-supplied so existing call sites
 * keep their exact timestamp format.
 *
 * @example
 *   safeArtifactFilename({
 *     name: assertionMessage,           // possibly 200 chars
 *     prefix: 'assert-fail-',
 *     timestamp: ts,
 *     ext: '.png',
 *   });
 *   // → 'assert-fail-Expected-new-tab-title-URL-to-cont-1a2b3c-2026-...png'
 */
export function safeArtifactFilename(opts: {
    name: string;
    timestamp: string;
    ext: string;            // include the dot, e.g. '.png'
    prefix?: string;        // e.g. 'assert-fail-', 'fail-'
    suffix?: string;        // e.g. '_w3' for a worker id
    maxNameSegment?: number;
}): string {
    const name = boundedNameSegment(opts.name, opts.maxNameSegment);
    const prefix = opts.prefix ?? '';
    const suffix = opts.suffix ?? '';
    return `${prefix}${name}${suffix}-${opts.timestamp}${opts.ext}`;
}
