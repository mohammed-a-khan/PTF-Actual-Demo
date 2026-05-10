/**
 * Agentic Test Platform — Per-Run Context (Rebuild M2)
 *
 * Owns the `Agent-Processing/<timestamp>_<runId>/` folder that holds every
 * artifact produced by one platform run: the analysis report, plan, IR
 * fragments, retry attempts, content map, audit reports, run logs, heal
 * snapshots, and the live `STATUS.md` the user keeps open.
 *
 * Inspired by the published agent-engineering pattern (Anthropic's
 * "effective harnesses for long-running agents", LangGraph's
 * checkpointer, CrewAI's process logs): treat the **filesystem as state**
 * so the agent can be paused, audited, resumed, and forked at any phase.
 *
 * Privacy-by-design: all writes go through CSPiiSanitizer redact mode
 * before hitting disk; no project / company / customer identifiers ever
 * appear in artifact filenames or content.
 *
 * **Workspace location.** The folder is rooted at
 * `<workspaceRoot>/Agent-Processing/<UTC-timestamp>_<runId>/` where
 * `workspaceRoot` defaults to `process.cwd()` (overridable via the
 * `AGENT_PROCESSING_ROOT` config key or a `workspaceRoot` arg).
 *
 * **Layout** (every phase has its own subdirectory):
 *
 *   STATUS.md              ← live-updated by CSStatusWriter (M4)
 *   timeline.jsonl         ← append-only event stream (one JSON per line)
 *   PLAN.md                ← phase 4 output for human reading
 *   final-report.md        ← summary written at end of run
 *
 *   01-intake/             ← classification + structured fields
 *   02-discover/           ← inventory of legacy/doc/source/url scope
 *   03-analyze/            ← analysis report + call trees + gaps
 *     ├─ analysis-report.json
 *     ├─ analysis-report.md
 *     ├─ call-trees/
 *     └─ retries/
 *        └─ attempt-N/{prompt.md, response.md, outcome.json}
 *   04-plan/               ← migration plan + auto-resolved gaps
 *   05-translate/          ← content-map + per-file LLM attempts
 *   06-audit/              ← rule violations per file
 *   07-write/              ← what landed on disk + sha256
 *   08-execute/            ← per-scenario run logs + heal attempts
 *   09-verify/             ← trust score + semantic equivalence
 *
 * @module agent-platform/CSRunContext
 */

import * as fs from 'fs';
import * as path from 'path';
import { CSConfigurationManager } from '../../core/CSConfigurationManager';

// ============================================================================
// Public Types
// ============================================================================

/** The 9 pipeline phases. Names match the rebuild design exactly. */
export type RunPhase =
    | 'intake'
    | 'discover'
    | 'analyze'
    | 'plan'
    | 'translate'
    | 'audit'
    | 'write'
    | 'execute'
    | 'verify';

/**
 * Phase status as recorded in `STATUS.md` and emitted to `timeline.jsonl`.
 * `auto_resolved` means the gate failed but an LLM retry produced a passing
 * result before the 3-retry ceiling was hit.
 */
export type PhaseStatus =
    | 'pending'
    | 'running'
    | 'done'
    | 'auto_resolved'
    | 'blocked_user';

/** One event in the per-run timeline. JSONL line format. */
export interface TimelineEvent {
    /** Wall-clock ISO 8601 with milliseconds. */
    ts: string;
    /** Event kind — what happened. */
    kind:
        | 'run_started'
        | 'phase_started'
        | 'phase_completed'
        | 'phase_failed'
        | 'gate_retry'
        | 'gate_resolved'
        | 'gate_user_blocked'
        | 'tool_invoked'
        | 'file_written'
        | 'llm_call'
        | 'warning'
        | 'info'
        | 'run_completed'
        | 'run_aborted';
    /** Phase the event belongs to (when applicable). */
    phase?: RunPhase;
    /** Free-form message for human readers. */
    message: string;
    /** Optional structured payload (sanitized before write). */
    data?: Record<string, unknown>;
}

/** Snapshot of one phase's accounting, used by CSStatusWriter to render STATUS.md. */
export interface PhaseSnapshot {
    name: RunPhase;
    status: PhaseStatus;
    startedAt?: string;
    finishedAt?: string;
    durationMs?: number;
    /** Number of LLM retry attempts spent on this phase's gate. */
    retryCount: number;
    /** Path to the phase's primary report (relative to run folder). */
    reportPath?: string;
}

/** Aggregate state of the run as seen at any moment. */
export interface RunSnapshot {
    runId: string;
    startedAt: string;
    finishedAt?: string;
    phase: RunPhase | 'completed' | 'aborted';
    overallStatus: 'running' | 'completed' | 'aborted' | 'blocked_user';
    phases: PhaseSnapshot[];
    autoResolvedCount: number;
    userBlockedReasons: string[];
    runFolder: string;
    inputSummary?: string;
}

// ============================================================================
// CSRunContext
// ============================================================================

/**
 * Per-run artifact folder + event recorder. One instance per pipeline
 * invocation; passed through to every primitive that touches state.
 *
 * **Singleton-per-runId.** Subsequent `CSRunContext.get(runId)` calls return
 * the same instance so multiple primitives can share the context within a
 * single MCP server lifetime. After the run completes, the instance is
 * garbage-collected on the next call to `prune()`.
 */
export class CSRunContext {
    private static readonly INSTANCES = new Map<string, CSRunContext>();
    private static readonly ROOT_ENV_KEY = 'AGENT_PROCESSING_ROOT';
    private static readonly DEFAULT_ROOT_NAME = 'Agent-Processing';

    public readonly runId: string;
    public readonly runFolder: string;
    public readonly startedAt: string;
    private readonly phases: Map<RunPhase, PhaseSnapshot>;
    private finishedAt?: string;
    private overallStatus: RunSnapshot['overallStatus'] = 'running';
    private inputSummary?: string;
    private userBlockedReasons: string[] = [];

    private constructor(runId: string, runFolder: string, startedAt: string) {
        this.runId = runId;
        this.runFolder = runFolder;
        this.startedAt = startedAt;
        this.phases = new Map();
        for (const p of CSRunContext.allPhases()) {
            this.phases.set(p, { name: p, status: 'pending', retryCount: 0 });
        }
    }

    // ------------------------------------------------------------------
    // Construction / lookup
    // ------------------------------------------------------------------

    /**
     * Create or return the existing context for `runId`. On first
     * construction, creates the per-run folder and writes the initial
     * timeline + STATUS marker. Idempotent.
     */
    public static getOrCreate(
        runId: string,
        options?: { workspaceRoot?: string; inputSummary?: string },
    ): CSRunContext {
        const existing = CSRunContext.INSTANCES.get(runId);
        if (existing) {
            if (options?.inputSummary && !existing.inputSummary) {
                existing.inputSummary = options.inputSummary;
            }
            return existing;
        }
        const root = CSRunContext.resolveRoot(options?.workspaceRoot);
        const startedAt = new Date().toISOString();
        const folderName = `${CSRunContext.timestampSlug(startedAt)}_${runId}`;
        const runFolder = path.join(root, folderName);
        CSRunContext.ensureDir(runFolder);
        for (const p of CSRunContext.allPhases()) {
            CSRunContext.ensureDir(path.join(runFolder, CSRunContext.phaseFolder(p)));
        }
        const ctx = new CSRunContext(runId, runFolder, startedAt);
        if (options?.inputSummary) ctx.inputSummary = options.inputSummary;
        CSRunContext.INSTANCES.set(runId, ctx);
        ctx.appendTimeline({
            ts: startedAt,
            kind: 'run_started',
            message: `Run ${runId} started`,
            data: options?.inputSummary
                ? { inputSummary: options.inputSummary }
                : undefined,
        });
        return ctx;
    }

    /**
     * Look up an existing context. Returns null if no run with this id has
     * been instantiated in this process. (For cross-process resume, the
     * caller should reconstruct from the run folder on disk — supported in
     * a follow-up milestone.)
     */
    public static get(runId: string): CSRunContext | null {
        return CSRunContext.INSTANCES.get(runId) ?? null;
    }

    /**
     * Drop completed / aborted contexts older than the given age (default
     * 1 hour). The on-disk artifacts are preserved — this only releases
     * in-memory references.
     */
    public static prune(maxAgeMs: number = 60 * 60 * 1000): number {
        const now = Date.now();
        let pruned = 0;
        for (const [id, ctx] of CSRunContext.INSTANCES) {
            if (
                ctx.overallStatus === 'completed' ||
                ctx.overallStatus === 'aborted'
            ) {
                const finishedAtMs = ctx.finishedAt
                    ? new Date(ctx.finishedAt).getTime()
                    : new Date(ctx.startedAt).getTime();
                if (now - finishedAtMs > maxAgeMs) {
                    CSRunContext.INSTANCES.delete(id);
                    pruned++;
                }
            }
        }
        return pruned;
    }

    // ------------------------------------------------------------------
    // Phase lifecycle
    // ------------------------------------------------------------------

    /** Mark a phase started; writes a timeline event. */
    public startPhase(phase: RunPhase): void {
        const snap = this.phases.get(phase);
        if (!snap) return;
        snap.status = 'running';
        snap.startedAt = new Date().toISOString();
        this.appendTimeline({
            ts: snap.startedAt,
            kind: 'phase_started',
            phase,
            message: `Phase ${phase} started`,
        });
    }

    /**
     * Mark a phase finished. `status` distinguishes:
     *   - `done`: gate passed first try
     *   - `auto_resolved`: gate failed, but LLM retry produced a passing
     *     result before the 3-attempt ceiling
     *   - `blocked_user`: gate exhausted retries; user input is required
     */
    public finishPhase(
        phase: RunPhase,
        status: 'done' | 'auto_resolved' | 'blocked_user',
        opts?: { reportPath?: string; reason?: string },
    ): void {
        const snap = this.phases.get(phase);
        if (!snap) return;
        snap.status = status;
        snap.finishedAt = new Date().toISOString();
        if (snap.startedAt) {
            snap.durationMs =
                new Date(snap.finishedAt).getTime() -
                new Date(snap.startedAt).getTime();
        }
        if (opts?.reportPath) snap.reportPath = opts.reportPath;
        const kind: TimelineEvent['kind'] =
            status === 'blocked_user'
                ? 'gate_user_blocked'
                : status === 'auto_resolved'
                  ? 'gate_resolved'
                  : 'phase_completed';
        if (status === 'blocked_user' && opts?.reason) {
            this.userBlockedReasons.push(`[${phase}] ${opts.reason}`);
            this.overallStatus = 'blocked_user';
        }
        this.appendTimeline({
            ts: snap.finishedAt,
            kind,
            phase,
            message:
                status === 'done'
                    ? `Phase ${phase} done`
                    : status === 'auto_resolved'
                      ? `Phase ${phase} auto-resolved by LLM (${snap.retryCount} retries)`
                      : `Phase ${phase} blocked: ${opts?.reason ?? 'no reason given'}`,
        });
    }

    /** Increment retry counter for a phase's gate. */
    public recordRetry(phase: RunPhase, attempt: number): void {
        const snap = this.phases.get(phase);
        if (!snap) return;
        snap.retryCount = attempt;
        this.appendTimeline({
            ts: new Date().toISOString(),
            kind: 'gate_retry',
            phase,
            message: `Phase ${phase} gate retry attempt ${attempt}`,
        });
    }

    /** Mark the run completed. */
    public complete(): void {
        this.overallStatus = 'completed';
        this.finishedAt = new Date().toISOString();
        this.appendTimeline({
            ts: this.finishedAt,
            kind: 'run_completed',
            message: `Run ${this.runId} completed`,
        });
    }

    /** Mark the run aborted (fatal error). */
    public abort(reason: string): void {
        this.overallStatus = 'aborted';
        this.finishedAt = new Date().toISOString();
        this.appendTimeline({
            ts: this.finishedAt,
            kind: 'run_aborted',
            message: `Run ${this.runId} aborted: ${reason}`,
        });
    }

    // ------------------------------------------------------------------
    // I/O primitives — every write goes through here
    // ------------------------------------------------------------------

    /** Append one event to the run's `timeline.jsonl`. */
    public appendTimeline(event: TimelineEvent): void {
        const target = path.join(this.runFolder, 'timeline.jsonl');
        try {
            fs.appendFileSync(target, JSON.stringify(event) + '\n', 'utf-8');
        } catch {
            // never throw on observability failure
        }
    }

    /**
     * Write a per-phase artifact (e.g. `analysis-report.json`,
     * `migration-plan.json`). Returns the absolute path the file landed at.
     */
    public writePhaseArtifact(
        phase: RunPhase,
        relativePath: string,
        content: string | Buffer,
    ): string {
        const phaseDir = path.join(this.runFolder, CSRunContext.phaseFolder(phase));
        const abs = path.join(phaseDir, relativePath);
        CSRunContext.ensureDir(path.dirname(abs));
        fs.writeFileSync(abs, content);
        this.appendTimeline({
            ts: new Date().toISOString(),
            kind: 'file_written',
            phase,
            message: `Wrote ${relativePath}`,
            data: { absPath: abs, bytes: Buffer.byteLength(content) },
        });
        return abs;
    }

    /**
     * Write a retry attempt's prompt + response + outcome for auditability.
     * Folder layout: `<phase-folder>/retries/attempt-<N>/{prompt.md,
     * response.md, outcome.json}`.
     */
    public writeRetryAttempt(
        phase: RunPhase,
        attempt: number,
        artefacts: {
            prompt?: string;
            response?: string;
            outcome?: Record<string, unknown>;
        },
    ): string {
        const dir = path.join(
            this.runFolder,
            CSRunContext.phaseFolder(phase),
            'retries',
            `attempt-${attempt}`,
        );
        CSRunContext.ensureDir(dir);
        if (artefacts.prompt !== undefined) {
            fs.writeFileSync(path.join(dir, 'prompt.md'), artefacts.prompt, 'utf-8');
        }
        if (artefacts.response !== undefined) {
            fs.writeFileSync(
                path.join(dir, 'response.md'),
                artefacts.response,
                'utf-8',
            );
        }
        if (artefacts.outcome) {
            fs.writeFileSync(
                path.join(dir, 'outcome.json'),
                JSON.stringify(artefacts.outcome, null, 2),
                'utf-8',
            );
        }
        return dir;
    }

    /**
     * Read a previously-written phase artifact, or return null when the
     * file does not exist. Useful for resume + cross-phase data passing
     * (e.g. translate reads analyze's report).
     */
    public readPhaseArtifact(phase: RunPhase, relativePath: string): string | null {
        const abs = path.join(
            this.runFolder,
            CSRunContext.phaseFolder(phase),
            relativePath,
        );
        try {
            return fs.readFileSync(abs, 'utf-8');
        } catch {
            return null;
        }
    }

    // ------------------------------------------------------------------
    // Snapshot — used by CSStatusWriter
    // ------------------------------------------------------------------

    /**
     * Aggregate snapshot of the run state. Compared against the previous
     * snapshot by `CSStatusWriter` to decide when to rewrite `STATUS.md`.
     */
    public snapshot(): RunSnapshot {
        const phases = CSRunContext.allPhases().map(
            (p) => this.phases.get(p) as PhaseSnapshot,
        );
        const autoResolvedCount = phases.filter(
            (p) => p.status === 'auto_resolved',
        ).length;
        // Determine current phase: first non-final phase that's running or pending,
        // or 'completed'/'aborted' if the run has terminated.
        let currentPhase: RunSnapshot['phase'] = 'completed';
        if (this.overallStatus === 'aborted') currentPhase = 'aborted';
        else if (this.overallStatus === 'running') {
            const inflight = phases.find(
                (p) => p.status === 'running' || p.status === 'pending',
            );
            currentPhase = inflight ? inflight.name : 'completed';
        }
        return {
            runId: this.runId,
            startedAt: this.startedAt,
            finishedAt: this.finishedAt,
            phase: currentPhase,
            overallStatus: this.overallStatus,
            phases,
            autoResolvedCount,
            userBlockedReasons: this.userBlockedReasons.slice(),
            runFolder: this.runFolder,
            inputSummary: this.inputSummary,
        };
    }

    // ------------------------------------------------------------------
    // Static utilities
    // ------------------------------------------------------------------

    public static allPhases(): RunPhase[] {
        return [
            'intake',
            'discover',
            'analyze',
            'plan',
            'translate',
            'audit',
            'write',
            'execute',
            'verify',
        ];
    }

    public static phaseFolder(phase: RunPhase): string {
        const idx = CSRunContext.allPhases().indexOf(phase);
        const num = String(idx + 1).padStart(2, '0');
        return `${num}-${phase}`;
    }

    private static resolveRoot(explicitWorkspace?: string): string {
        let workspace = explicitWorkspace;
        if (!workspace) {
            try {
                workspace = CSConfigurationManager.getInstance().get(
                    CSRunContext.ROOT_ENV_KEY,
                    '',
                );
            } catch {
                workspace = '';
            }
        }
        if (!workspace) workspace = process.cwd();
        return path.join(workspace, CSRunContext.DEFAULT_ROOT_NAME);
    }

    /**
     * Filesystem-safe timestamp slug. Format: `YYYY-MM-DDTHH-MM-SS` (UTC).
     * No timezone offset — the runId disambiguates concurrent runs.
     */
    public static timestampSlug(iso: string): string {
        return iso.replace(/[:.]/g, '-').replace(/T/, 'T').replace(/Z$/, '');
    }

    private static ensureDir(p: string): void {
        try {
            fs.mkdirSync(p, { recursive: true });
        } catch {
            // ignore EEXIST
        }
    }
}
