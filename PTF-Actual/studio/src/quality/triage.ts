/**
 * Triage memory: what the team decided about a cause of failure (a failure signature: see failureSignature),
 * so the same failure in a later run arrives already triaged: its verdict, a note, and the bug it is reported
 * in.
 *
 *  - Kept in the repository at .cs-studio/triage.json (committed: the team shares it), keyed by the signature's
 *    tag (cs-failure-<hash>): the file holds no error text beyond a masked copy of the signature.
 *  - The framework files a bug for a failure with the same tag (ADO_CREATE_BUGS_ON_FAILURE: it finds the open
 *    bug by its tag rather than filing another), and a bug created here carries it too: either way the bug is
 *    found for the failure.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export const TRIAGE_PATH = '.cs-studio/triage.json';
export type TriageVerdict = 'product-bug' | 'test-issue' | 'environment' | 'flaky' | 'expected';
export const VERDICTS: TriageVerdict[] = ['product-bug', 'test-issue', 'environment', 'flaky', 'expected'];

export interface TriageEntry {
    /** The signature, masked (for reading the file). */
    signature: string;
    verdict?: TriageVerdict;
    note?: string;
    /** The Azure DevOps bug it is reported in. */
    bug?: number;
    by?: string;
    at: string;
}

/** The work item tag of a failure signature (the framework's signatureTag gives the same). */
export function signatureTag(signature: string): string {
    return `cs-failure-${crypto.createHash('sha256').update(signature).digest('hex').slice(0, 12)}`;
}

/**
 * The team's triage. A file that cannot be read (e.g. merge-conflict markers) reads as empty here, but `strict`
 * (used before writing) refuses it, so a save never wipes the other entries.
 */
export function readTriage(repoRoot: string, strict = false): Record<string, TriageEntry> {
    let text: string;
    try { text = fs.readFileSync(path.join(repoRoot, TRIAGE_PATH), 'utf8'); }
    catch { return {}; }
    try {
        const j = JSON.parse(text);
        const entries = j && typeof j === 'object' && j.entries && typeof j.entries === 'object' ? j.entries : {};
        const out: Record<string, TriageEntry> = {};
        for (const [k, v] of Object.entries(entries as Record<string, any>)) {
            if (!/^cs-failure-[0-9a-f]{12}$/.test(k) || !v || typeof v !== 'object') continue;
            out[k] = {
                signature: String(v.signature ?? ''), at: String(v.at ?? ''),
                ...(VERDICTS.includes(v.verdict) ? { verdict: v.verdict } : {}),
                ...(typeof v.note === 'string' && v.note ? { note: v.note.slice(0, 2000) } : {}),
                ...(Number.isInteger(v.bug) && v.bug > 0 ? { bug: v.bug } : {}),
                ...(typeof v.by === 'string' && v.by ? { by: v.by.slice(0, 200) } : {}),
            };
        }
        return out;
    } catch (e) {
        if (strict) throw new Error(`${TRIAGE_PATH} cannot be read (${(e as Error).message}); fix it (a merge conflict?) before triaging, so the team's other entries are kept.`);
        return {};
    }
}

/** Set (or, with nothing left in it, remove) the triage of a signature tag. Sorted keys: small, stable diffs. */
export function writeTriage(repoRoot: string, tag: string, entry: Omit<TriageEntry, 'at'> | null): Record<string, TriageEntry> {
    if (!/^cs-failure-[0-9a-f]{12}$/.test(tag)) throw new Error('Invalid failure tag.');
    const all = readTriage(repoRoot, true);
    if (!entry || (!entry.verdict && !entry.note && !entry.bug)) delete all[tag];
    else all[tag] = { ...entry, at: new Date().toISOString() };
    const sorted = Object.fromEntries(Object.keys(all).sort().map((k) => [k, all[k]]));
    const file = path.join(repoRoot, TRIAGE_PATH);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ version: 1, entries: sorted }, null, 2)}\n`);
    return all;
}

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A bug's repro steps (HTML) for a cause of failure: where it fails, the latest message, the signature. */
export function bugReproHtml(g: { signature: string; sample: string; failures: number; runs: number; firstSeen: string; lastSeen: string; scenarios: Array<{ name: string; feature: string }> }): string {
    return [
        `<p>Fails in ${g.scenarios.length} scenario${g.scenarios.length === 1 ? '' : 's'} (${g.failures} failure${g.failures === 1 ? '' : 's'} in ${g.runs} run${g.runs === 1 ? '' : 's'}, first ${esc(g.firstSeen)}, last ${esc(g.lastSeen)}):</p>`,
        `<ul>${g.scenarios.slice(0, 30).map((s) => `<li>${esc(s.name)} (${esc(s.feature)})</li>`).join('')}</ul>`,
        `<p><b>Latest message</b></p><pre>${esc(g.sample.slice(0, 4000))}</pre>`,
        `<p><small>Failure signature: ${esc(g.signature)}</small></p>`,
    ].join('\n');
}

/** WIQL for the open bugs carrying any of these tags (the bugs of these failures). */
export function bugsForTagsQuery(tags: string[]): string {
    const ok = tags.filter((t) => /^cs-failure-[0-9a-f]{12}$/.test(t)).slice(0, 60);
    if (!ok.length) throw new Error('No failure tags.');
    return `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.WorkItemType] = 'Bug' AND (${ok.map((t) => `[System.Tags] CONTAINS '${t}'`).join(' OR ')}) ORDER BY [System.ChangedDate] DESC`;
}
