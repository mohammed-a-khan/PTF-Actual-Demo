/**
 * Run tests: what the form keeps when the project changes, and what can pause a debug run.
 */
import type { Breakpoint } from './api';

/**
 * The form after the project was changed by hand: the environment stays when the new project has it, else its
 * first one (none listed: "dev", what the list then offers). Browser, workers and the other options stay.
 * The choice of features, tags and scenarios is the old project's: the caller clears it (changed: true).
 */
export function targetForProject<T extends { project: string; env: string }>(t: T, project: string, envs: string[]): { target: T; changed: boolean } {
    const env = envs.length ? (envs.includes(t.env) ? t.env : envs[0]) : (t.env || 'dev');
    return { target: { ...t, project, env }, changed: project !== t.project };
}

/** The environment the form shows for a project's list (null: it stays). */
export function envFor(current: string, envs: string[]): string | null {
    return envs.length && !envs.includes(current) ? envs[0] : null;
}

export const isCodeFile = (f: string) => /\.(ts|tsx|js|mjs|cjs)$/i.test(f);

export interface DebugPlan {
    /** Breakpoints that can pause this run: code ones, and feature ones in the feature files that run. */
    breakpoints: Breakpoint[];
    files: number;
    /** Start debugging: something can pause the run. */
    startable: boolean;
    /** Why not (the button's tooltip), or what will pause it. */
    reason: string;
}

/** What can pause a debug run of this choice: breakpoints, before each step, on a failure. */
export function debugPlan(all: Breakpoint[], runFeatures: string[] | null, opts: { steps: boolean; pauseOnFailure: boolean }): DebugPlan {
    const run = runFeatures ? new Set(runFeatures) : null;
    const bps = all.filter((b) => isCodeFile(b.file) || (b.file.endsWith('.feature') && (!run || run.has(b.file))));
    const files = new Set(bps.map((b) => b.file)).size;
    const startable = bps.length > 0 || opts.steps || opts.pauseOnFailure;
    const skipped = all.length - bps.length;
    const reason = startable
        ? [bps.length ? `${bps.length} breakpoint${bps.length === 1 ? '' : 's'} in ${files} file${files === 1 ? '' : 's'} will pause the run` : '',
            opts.steps ? 'pauses before each step' : '', opts.pauseOnFailure ? 'pauses when a step fails' : ''].filter(Boolean).join('; ')
        : `Nothing would pause the run: there are no breakpoints${skipped ? ` in what runs (${skipped} in feature files that do not run)` : ''} and neither box is ticked. Set a breakpoint (click a line number in the Code screen) or tick a box.`;
    return { breakpoints: bps, files, startable, reason };
}
