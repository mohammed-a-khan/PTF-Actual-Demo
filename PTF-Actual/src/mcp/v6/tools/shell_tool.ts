import { spawn, spawnSync } from 'child_process';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_BYTES = 200_000;
const IS_WINDOWS = process.platform === 'win32';

function killProcessTree(pid: number): void {
    if (IS_WINDOWS) {
        try { spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' }); } catch { /* noop */ }
    } else {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* noop */ }
    }
}

registerPrimitive({
    name: 'cs_qa_shell',
    description: 'Run a command inside the workspace. Pass command + args as separate fields — do NOT wrap in cmd.exe /c "..." with pipes or redirects (breaks streaming + tree-kill on timeout). If you need output filtering, run the command clean and filter in your own reasoning. Output captured up to 200KB per stream. Timeouts kill the full process tree.',
    inputSchema: z.object({
        command: z.string().min(1),
        args: z.array(z.string()).default([]),
        cwd: z.string().optional(),
        env: z.record(z.string(), z.string()).optional(),
        timeoutMs: z.number().int().positive().max(30 * 60_000).default(DEFAULT_TIMEOUT_MS),
    }),
    outputSchema: z.object({
        command: z.string(),
        args: z.array(z.string()),
        exitCode: z.number().nullable(),
        signal: z.string().nullable(),
        durationMs: z.number(),
        stdoutBytes: z.number(),
        stderrBytes: z.number(),
        stdout: z.string(),
        stderr: z.string(),
        timedOut: z.boolean(),
        truncated: z.boolean(),
    }),
    run: async (ctx, input) => {
        const cwd = input.cwd ? require('path').resolve(ctx.workspaceRoot, input.cwd) : ctx.workspaceRoot;
        return new Promise((resolve) => {
            const started = Date.now();
            let settled = false;
            const child = spawn(input.command, input.args, {
                cwd,
                env: { ...process.env, ...(input.env ?? {}) },
                shell: false,
                detached: !IS_WINDOWS,
            });
            let stdout = '';
            let stderr = '';
            let stdoutBytes = 0;
            let stderrBytes = 0;
            let truncated = false;
            let timedOut = false;
            child.stdout.on('data', (chunk) => {
                stdoutBytes += chunk.length;
                if (stdout.length < MAX_OUTPUT_BYTES) {
                    stdout += chunk.toString('utf-8');
                    if (stdout.length > MAX_OUTPUT_BYTES) {
                        stdout = stdout.slice(0, MAX_OUTPUT_BYTES);
                        truncated = true;
                    }
                } else {
                    truncated = true;
                }
            });
            child.stderr.on('data', (chunk) => {
                stderrBytes += chunk.length;
                if (stderr.length < MAX_OUTPUT_BYTES) {
                    stderr += chunk.toString('utf-8');
                    if (stderr.length > MAX_OUTPUT_BYTES) {
                        stderr = stderr.slice(0, MAX_OUTPUT_BYTES);
                        truncated = true;
                    }
                } else {
                    truncated = true;
                }
            });
            const settle = (exitCode: number | null, signal: NodeJS.Signals | string | null): void => {
                if (settled) return;
                settled = true;
                clearTimeout(to);
                clearTimeout(backup);
                resolve({
                    command: input.command,
                    args: input.args,
                    exitCode,
                    signal: signal as string | null,
                    durationMs: Date.now() - started,
                    stdoutBytes,
                    stderrBytes,
                    stdout,
                    stderr,
                    timedOut,
                    truncated,
                });
            };
            const to = setTimeout(() => {
                timedOut = true;
                if (child.pid) killProcessTree(child.pid);
                try { child.kill('SIGKILL'); } catch { /* noop */ }
            }, input.timeoutMs);
            // Backup: if kill doesn't produce a close event within 10s
            // (grandchildren holding stdio open), settle anyway.
            const backup = setTimeout(() => {
                if (!settled) settle(null, 'KILL_TIMEOUT');
            }, input.timeoutMs + 10_000);
            child.on('close', (exitCode, signal) => settle(exitCode, signal));
            child.on('error', (err) => {
                if (settled) return;
                settled = true;
                clearTimeout(to);
                clearTimeout(backup);
                resolve({
                    command: input.command,
                    args: input.args,
                    exitCode: null,
                    signal: null,
                    durationMs: Date.now() - started,
                    stdoutBytes: 0,
                    stderrBytes: err.message.length,
                    stdout: '',
                    stderr: err.message,
                    timedOut: false,
                    truncated: false,
                });
            });
        });
    },
});
