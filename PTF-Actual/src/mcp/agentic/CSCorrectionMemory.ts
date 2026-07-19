/**
 * Agentic SDLC Platform — Correction Memory
 *
 * The deterministic learning loop: every resolved failure (heal, triage,
 * defect) is recorded as a compact entry keyed by its normalized error
 * signature. Future heal/triage sessions look up matching signatures and
 * inject the past resolutions into the LLM's grounding — so the second time
 * the platform sees a failure shape, diagnosis is a lookup, not a re-derivation.
 *
 * Cost contract: recording and lookup are pure TypeScript (zero tokens).
 * The only token cost is the few lines of matched hints included in a heal
 * handoff's instruction — bounded by MAX_HINTS.
 *
 * Storage: <workspace>/Agent-Processing/correction-memory.jsonl (append-only,
 * one JSON object per line, bounded by MAX_ENTRIES with oldest-first eviction).
 *
 * @module agentic/CSCorrectionMemory
 */

import * as fs from 'fs';
import * as path from 'path';

export interface CorrectionEntry {
    /** Normalized error signature (numbers → N, quoted strings → X). */
    signature: string;
    /** Failure category the fix addressed (locator_drift, timing_flake, …). */
    category: string;
    /** What actually fixed it — one concrete sentence. */
    resolution: string;
    /** Files that were changed by the fix (repo-relative). */
    files: string[];
    /** Project key the fix applied to. */
    project: string;
    /** ISO timestamp of the recording. */
    at: string;
    /** How many times this signature has been seen (bumped on re-record). */
    hits: number;
}

const FILE_NAME = 'correction-memory.jsonl';
const ROOT_DIR = 'Agent-Processing';
/** Hard cap on stored entries — oldest evicted first. */
const MAX_ENTRIES = 500;
/** Max hints ever injected into a single handoff instruction. */
const MAX_HINTS = 5;

export class CSCorrectionMemory {
    private static filePath(workspaceRoot: string): string {
        return path.join(workspaceRoot, ROOT_DIR, FILE_NAME);
    }

    /** Normalize an error message into a stable clustering signature. */
    public static signature(error: string): string {
        return (error || '')
            .split('\n')[0]
            .replace(/\d+/g, 'N')
            .replace(/["'`][^"'`]{0,80}["'`]/g, 'X')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 160);
    }

    private static readAll(workspaceRoot: string): CorrectionEntry[] {
        const file = this.filePath(workspaceRoot);
        if (!fs.existsSync(file)) return [];
        try {
            return fs
                .readFileSync(file, 'utf-8')
                .split('\n')
                .filter(Boolean)
                .map((l) => {
                    try {
                        return JSON.parse(l) as CorrectionEntry;
                    } catch {
                        return undefined;
                    }
                })
                .filter((e): e is CorrectionEntry => !!e && typeof e.signature === 'string');
        } catch {
            return [];
        }
    }

    private static writeAll(workspaceRoot: string, entries: CorrectionEntry[]): void {
        const file = this.filePath(workspaceRoot);
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            const bounded = entries.slice(-MAX_ENTRIES);
            fs.writeFileSync(file, bounded.map((e) => JSON.stringify(e)).join('\n') + (bounded.length ? '\n' : ''), 'utf-8');
        } catch {
            /* memory is best-effort — never fail the session over it */
        }
    }

    /**
     * Record a resolved failure. If the same signature+project already exists,
     * its entry is refreshed (resolution updated, hit count bumped) instead of
     * duplicated.
     */
    public static record(
        workspaceRoot: string,
        entry: Omit<CorrectionEntry, 'at' | 'hits' | 'signature'> & { errorText: string },
    ): void {
        const sig = this.signature(entry.errorText);
        if (!sig) return;
        const all = this.readAll(workspaceRoot);
        const existing = all.find((e) => e.signature === sig && e.project === entry.project);
        if (existing) {
            existing.resolution = entry.resolution || existing.resolution;
            existing.category = entry.category || existing.category;
            existing.files = entry.files?.length ? entry.files : existing.files;
            existing.at = new Date().toISOString();
            existing.hits += 1;
        } else {
            all.push({
                signature: sig,
                category: entry.category,
                resolution: entry.resolution,
                files: entry.files ?? [],
                project: entry.project,
                at: new Date().toISOString(),
                hits: 1,
            });
        }
        this.writeAll(workspaceRoot, all);
    }

    /**
     * Look up past resolutions matching any of the given error texts.
     * Same-project matches rank first, then cross-project; higher hit counts
     * rank higher. Bounded to MAX_HINTS.
     */
    public static lookup(
        workspaceRoot: string,
        errorTexts: string[],
        project: string,
    ): CorrectionEntry[] {
        const all = this.readAll(workspaceRoot);
        if (all.length === 0) return [];
        const sigs = new Set(errorTexts.map((t) => this.signature(t)).filter(Boolean));
        if (sigs.size === 0) return [];
        const matches = all.filter((e) => sigs.has(e.signature));
        matches.sort((a, b) => {
            const proj = Number(b.project === project) - Number(a.project === project);
            if (proj !== 0) return proj;
            return b.hits - a.hits;
        });
        return matches.slice(0, MAX_HINTS);
    }

    /**
     * Render matched entries as a compact instruction block for a heal/triage
     * handoff. Returns '' when there are no matches (zero token cost).
     */
    public static hintBlock(matches: CorrectionEntry[]): string {
        if (matches.length === 0) return '';
        const lines = matches.map(
            (m) =>
                `  • [${m.category}] seen ${m.hits}× — ${m.resolution}` +
                (m.files.length ? ` (files: ${m.files.slice(0, 3).join(', ')})` : ''),
        );
        return (
            '\nCORRECTION MEMORY — this platform has fixed matching failures before. ' +
            'Check these known resolutions FIRST before re-diagnosing from scratch:\n' +
            lines.join('\n') +
            '\n'
        );
    }

    /** Stats for status/reporting surfaces. */
    public static stats(workspaceRoot: string): { entries: number; totalHits: number } {
        const all = this.readAll(workspaceRoot);
        return { entries: all.length, totalHits: all.reduce((s, e) => s + e.hits, 0) };
    }
}
