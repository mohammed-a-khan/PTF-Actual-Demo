/**
 * Agentic Test Platform — Run Trace
 *
 * Append-only JSONL trace of every significant step a `cs_ai_auto_assist`
 * run takes. Lands at `.agent-runs/runs/<runId>.jsonl` so users can post-
 * mortem an escalated heal loop, audit cost per attempt, or replay the
 * decision sequence.
 *
 * Each line is a single JSON object with a stable shape:
 *
 *   { ts: ISO, runId, kind, ...payload }
 *
 * The trace is best-effort — write failures are logged but never block
 * the actual run. Missing trace entries don't compromise correctness.
 *
 * Privacy-by-design: payloads are sanitised through `CSPiiSanitizer.redact`
 * before being written, so secrets / PII can't leak into the trace file.
 *
 * @module agent-platform/CSRunTrace
 */

import * as fs from 'fs';
import * as path from 'path';
import { CSPiiSanitizer } from './CSPiiSanitizer';

// ============================================================================
// Public Types
// ============================================================================

/** Step kinds we know how to trace. Open enum — callers can pass any string. */
export type RunTraceKind =
    | 'run_start'
    | 'sanitize'
    | 'classify'
    | 'clarify'
    | 'budget_check'
    | 'mode_dispatch'
    | 'cache_lookup'
    | 'delegate_call'
    | 'delegate_result'
    | 'gate_run'
    | 'heal_attempt'
    | 'cache_store'
    | 'create_back'
    | 'ado_publish'
    | 'run_end'
    | string;

export interface RunTraceEntry {
    runId: string;
    kind: RunTraceKind;
    payload?: Record<string, unknown>;
}

// ============================================================================
// CSRunTrace
// ============================================================================

/**
 * Per-run trace writer. Construct once at master-tool entry, pass through
 * options to handlers / heal loop. Disable by passing `enabled: false`.
 */
export class CSRunTrace {
    private readonly runId: string;
    private readonly tracePath: string;
    private readonly enabled: boolean;
    private writeFailureCount = 0;

    public constructor(args: {
        runId: string;
        cwd?: string;
        enabled?: boolean;
    }) {
        this.runId = args.runId;
        this.enabled = args.enabled !== false;
        const cwd = args.cwd ?? process.cwd();
        const dir = path.join(cwd, '.agent-runs', 'runs');
        this.tracePath = path.join(dir, `${args.runId}.jsonl`);
        if (this.enabled) {
            try {
                fs.mkdirSync(dir, { recursive: true });
            } catch {
                // Best-effort. If we can't make the dir, append() will warn.
            }
        }
    }

    /**
     * Append a step to the trace. Synchronous + best-effort. Payload is
     * deeply sanitised (PII / secrets redacted) before serialisation.
     */
    public append(kind: RunTraceKind, payload?: Record<string, unknown>): void {
        if (!this.enabled) return;
        const entry = {
            ts: new Date().toISOString(),
            runId: this.runId,
            kind,
            ...(payload ? { payload: this.sanitisePayload(payload) } : {}),
        };
        try {
            fs.appendFileSync(this.tracePath, JSON.stringify(entry) + '\n', 'utf-8');
        } catch (err) {
            this.writeFailureCount += 1;
            if (this.writeFailureCount === 1) {
                // Surface the first failure once — subsequent failures are
                // deliberately silent to avoid log spam.
                // eslint-disable-next-line no-console
                console.warn(
                    `CSRunTrace: append failed (${err instanceof Error ? err.message : String(err)})`,
                );
            }
        }
    }

    /** Path to the trace file. Surface in the master tool's result. */
    public getTracePath(): string {
        return this.tracePath;
    }

    public getRunId(): string {
        return this.runId;
    }

    public getWriteFailureCount(): number {
        return this.writeFailureCount;
    }

    // ========================================================================
    // Internal
    // ========================================================================

    /**
     * Recursively sanitise string fields in the payload. Numeric / boolean
     * fields pass through unchanged. Nested objects + arrays are walked.
     * Cycles are not handled — pass plain shallow data only.
     */
    private sanitisePayload(payload: Record<string, unknown>): Record<string, unknown> {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(payload)) {
            out[k] = this.sanitiseValue(v);
        }
        return out;
    }

    private sanitiseValue(v: unknown): unknown {
        if (typeof v === 'string') {
            // Trim payload strings to avoid logging huge file content.
            const trimmed = v.length > 4096 ? v.slice(0, 4096) + '…(truncated)' : v;
            return CSPiiSanitizer.sanitize(trimmed, 'redact').cleaned;
        }
        if (Array.isArray(v)) {
            return v.slice(0, 50).map((x) => this.sanitiseValue(x));
        }
        if (v && typeof v === 'object') {
            const obj = v as Record<string, unknown>;
            const out: Record<string, unknown> = {};
            for (const [k, val] of Object.entries(obj)) {
                out[k] = this.sanitiseValue(val);
            }
            return out;
        }
        return v;
    }
}
