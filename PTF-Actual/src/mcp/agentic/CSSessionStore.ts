/**
 * Agentic SDLC Platform — Session Store
 *
 * Filesystem-as-state: every session lives under
 *   Agent-Processing/<timestamp>_<sessionId>/
 *     session.json     — full serialized SessionRecord (system of record)
 *     STATUS.md        — live human-readable progress (open in a side panel)
 *     timeline.jsonl   — append-only event log
 *     artifacts/       — every produced artifact (reports, plans, designs)
 *
 * Sessions survive conversation compaction, IDE restarts, and process
 * restarts — `load()` re-hydrates from disk, so paid-for work is never
 * repeated.
 *
 * @module agentic/CSSessionStore
 */

import * as fs from 'fs';
import * as path from 'path';
import { SessionRecord, SessionState, SDLCMode, SessionUsage } from './types';

const ROOT_DIR_NAME = 'Agent-Processing';

/** Default per-session budget (mirrors agent-platform DEFAULT_BUDGET). */
export const SESSION_BUDGET_DEFAULTS = {
    maxTokens: 500_000,
    maxWallClockMs: 45 * 60 * 1000,
    maxCostUsd: 5.0,
};

export class CSSessionStore {
    private static readonly CACHE: Map<string, SessionRecord> = new Map();

    // ------------------------------------------------------------------
    // Creation / loading
    // ------------------------------------------------------------------

    public static create(
        mode: SDLCMode,
        inputs: Record<string, string | number | boolean>,
        workspaceRoot: string,
    ): SessionRecord {
        const now = new Date();
        const sessionId = `sdlc_${now.getTime().toString(36)}_${Math.random()
            .toString(36)
            .slice(2, 8)}`;
        const slug = CSSessionStore.timestampSlug(now.toISOString());
        const folder = path.join(workspaceRoot, ROOT_DIR_NAME, `${slug}_${sessionId}`);
        fs.mkdirSync(path.join(folder, 'artifacts'), { recursive: true });

        const usage: SessionUsage = {
            estimatedTokens: 0,
            toolCalls: 0,
            wallClockMs: 0,
            estimatedCostUsd: 0,
            budgetMaxTokens: SESSION_BUDGET_DEFAULTS.maxTokens,
            budgetMaxWallClockMs: SESSION_BUDGET_DEFAULTS.maxWallClockMs,
            budgetMaxCostUsd: SESSION_BUDGET_DEFAULTS.maxCostUsd,
            budgetExtensions: 0,
        };

        const record: SessionRecord = {
            sessionId,
            mode,
            state: 'ACTIVE',
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
            activeSince: now.toISOString(),
            inputs,
            stageIndex: 0,
            submitRetries: 0,
            healCycles: 0,
            stepsExecuted: 0,
            usage,
            folder,
            artifacts: [],
            stageLog: [],
        };

        CSSessionStore.CACHE.set(sessionId, record);
        CSSessionStore.save(record);
        CSSessionStore.appendTimeline(record, { event: 'session_created', mode, inputs });
        return record;
    }

    /** Load a session from cache or disk. Returns null when not found. */
    public static load(sessionId: string, workspaceRoot: string): SessionRecord | null {
        const cached = CSSessionStore.CACHE.get(sessionId);
        if (cached) return cached;

        const root = path.join(workspaceRoot, ROOT_DIR_NAME);
        if (!fs.existsSync(root)) return null;
        const match = fs
            .readdirSync(root)
            .find((d) => d.endsWith(`_${sessionId}`));
        if (!match) return null;
        const file = path.join(root, match, 'session.json');
        if (!fs.existsSync(file)) return null;
        try {
            const record = JSON.parse(fs.readFileSync(file, 'utf-8')) as SessionRecord;
            // Folder may have been produced on another machine — re-anchor.
            record.folder = path.join(root, match);
            // Fresh active period: the wall-clock budget measures active
            // work, not elapsed calendar time between resumes.
            record.activeSince = new Date().toISOString();
            CSSessionStore.CACHE.set(sessionId, record);
            return record;
        } catch {
            return null;
        }
    }

    /** Most recent sessions (for csaa_status list / resume). */
    public static list(
        workspaceRoot: string,
        limit: number = 10,
    ): Array<Pick<SessionRecord, 'sessionId' | 'mode' | 'state' | 'createdAt' | 'updatedAt'>> {
        const root = path.join(workspaceRoot, ROOT_DIR_NAME);
        if (!fs.existsSync(root)) return [];
        const rows: SessionRecord[] = [];
        for (const dir of fs.readdirSync(root)) {
            const file = path.join(root, dir, 'session.json');
            if (!fs.existsSync(file)) continue;
            try {
                rows.push(JSON.parse(fs.readFileSync(file, 'utf-8')) as SessionRecord);
            } catch {
                /* skip unreadable sessions */
            }
        }
        rows.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
        return rows.slice(0, limit).map((r) => ({
            sessionId: r.sessionId,
            mode: r.mode,
            state: r.state,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
        }));
    }

    // ------------------------------------------------------------------
    // Persistence
    // ------------------------------------------------------------------

    public static save(record: SessionRecord): void {
        record.updatedAt = new Date().toISOString();
        const file = path.join(record.folder, 'session.json');
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf-8');
        fs.renameSync(tmp, file);
        CSSessionStore.writeStatus(record);
    }

    public static appendTimeline(record: SessionRecord, event: Record<string, unknown>): void {
        const line = JSON.stringify({ at: new Date().toISOString(), ...event });
        fs.appendFileSync(path.join(record.folder, 'timeline.jsonl'), line + '\n', 'utf-8');
    }

    /** Write an artifact under artifacts/ and register it on the session. */
    public static writeArtifact(record: SessionRecord, relPath: string, content: string): string {
        const safeRel = relPath.replace(/\.\./g, '_');
        const abs = path.join(record.folder, 'artifacts', safeRel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, 'utf-8');
        if (!record.artifacts.includes(abs)) record.artifacts.push(abs);
        return abs;
    }

    public static transition(record: SessionRecord, state: SessionState, note?: string): void {
        record.state = state;
        if (note) {
            CSSessionStore.appendTimeline(record, { event: 'state', state, note });
        }
        CSSessionStore.save(record);
    }

    // ------------------------------------------------------------------
    // STATUS.md
    // ------------------------------------------------------------------

    public static statusPath(record: SessionRecord): string {
        return path.join(record.folder, 'STATUS.md');
    }

    private static writeStatus(record: SessionRecord): void {
        const pct = Math.min(
            100,
            Math.round((record.usage.estimatedTokens / record.usage.budgetMaxTokens) * 100),
        );
        const lines: string[] = [
            `# CS AI Auto-Assist — ${record.mode}`,
            '',
            `| | |`,
            `|---|---|`,
            `| Session | \`${record.sessionId}\` |`,
            `| State | **${record.state}** |`,
            `| Started | ${record.createdAt} |`,
            `| Updated | ${record.updatedAt} |`,
            `| Budget used | ~${record.usage.estimatedTokens.toLocaleString()} tokens (${pct}%) across ${record.usage.toolCalls} tool calls |`,
            record.trustScore !== undefined
                ? `| Trust score | ${record.trustScore.toFixed(2)} — ${record.trustLevel ?? ''} |`
                : '',
            record.blockedReason ? `| Blocked | ${record.blockedReason} |` : '',
            '',
            '## Stages',
            '',
        ].filter((l) => l !== '');

        for (const s of record.stageLog) {
            const icon =
                s.status === 'complete' || s.status === 'finished'
                    ? '✅'
                    : s.status === 'blocked'
                      ? '⛔'
                      : '🔄';
            lines.push(`- ${icon} \`${s.stageId}\` — ${s.summary} _(${s.at})_`);
        }

        if (record.artifacts.length > 0) {
            lines.push('', '## Artifacts', '');
            for (const a of record.artifacts) lines.push(`- ${a}`);
        }

        fs.writeFileSync(CSSessionStore.statusPath(record), lines.join('\n') + '\n', 'utf-8');
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /** 2026-01-31T09-15-02 style slug (mirrors CSRunContext.timestampSlug). */
    public static timestampSlug(iso: string): string {
        return iso.replace(/:/g, '-').replace(/\..+$/, '');
    }
}
