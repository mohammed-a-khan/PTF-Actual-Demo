import { spawn } from 'child_process';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';

function run(cmd: string, args: string[], cwd: string): Promise<{ exitCode: number | null; stdout: string; stderr: string; durationMs: number }> {
    const started = Date.now();
    return new Promise((resolve) => {
        const child = spawn(cmd, args, { cwd, shell: false });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (c) => { stdout += c.toString('utf-8').slice(0, 200_000); });
        child.stderr.on('data', (c) => { stderr += c.toString('utf-8').slice(0, 200_000); });
        child.on('close', (exitCode) => resolve({ exitCode, stdout, stderr, durationMs: Date.now() - started }));
        child.on('error', (e) => resolve({ exitCode: 1, stdout: '', stderr: e.message, durationMs: Date.now() - started }));
    });
}

registerPrimitive({
    name: 'cs_qa_git',
    description: 'Git operations inside the workspace. Verbs: status, diff (file or all), log (last N commits), branch (list/create/switch), add, commit, push, current-branch. Mutations require two-phase confirmation (call once without `confirmed`, get preview, retry with `confirmed:true`). NEVER runs destructive ops (reset --hard, clean -f, branch -D, push --force) — those are explicitly refused.',
    inputSchema: z.discriminatedUnion('verb', [
        z.object({ verb: z.literal('status') }),
        z.object({ verb: z.literal('diff'), file: z.string().optional(), staged: z.boolean().default(false) }),
        z.object({ verb: z.literal('log'), count: z.number().int().positive().max(50).default(10), file: z.string().optional() }),
        z.object({ verb: z.literal('current-branch') }),
        z.object({ verb: z.literal('branch-list') }),
        z.object({ verb: z.literal('branch-create'), name: z.string().min(1), fromRef: z.string().optional() }),
        z.object({ verb: z.literal('branch-switch'), name: z.string().min(1) }),
        z.object({ verb: z.literal('add'), files: z.array(z.string()).min(1) }),
        z.object({ verb: z.literal('commit'), message: z.string().min(3) }),
        z.object({ verb: z.literal('push'), remote: z.string().default('origin'), branch: z.string().optional(), setUpstream: z.boolean().default(true) }),
    ]),
    outputSchema: z.object({
        verb: z.string(),
        exitCode: z.number().nullable(),
        stdout: z.string(),
        stderr: z.string(),
        durationMs: z.number(),
        note: z.string().optional(),
        requiresConfirmation: z.boolean().optional(),
        destructive: z.boolean().optional(),
        confirmationHint: z.string().optional(),
    }),
    run: async (ctx, input) => {
        const cwd = ctx.workspaceRoot;
        const mutations = new Set(['branch-create', 'branch-switch', 'add', 'commit', 'push']);
        if (mutations.has(input.verb)) {
            if ((input as { confirmed?: boolean }).confirmed !== true) {
                return {
                    verb: input.verb,
                    exitCode: null,
                    stdout: '',
                    stderr: '',
                    durationMs: 0,
                    requiresConfirmation: true,
                    destructive: true,
                    confirmationHint: `Confirm git ${input.verb}: ${JSON.stringify(input)}. No write performed. Retry the SAME call with confirmed:true (added at the top level).`,
                    note: 'requires confirmation — retry with confirmed:true',
                } as never;
            }
        }
        let args: string[];
        if (input.verb === 'status') args = ['status', '--short'];
        else if (input.verb === 'diff') args = input.staged ? ['diff', '--staged', ...(input.file ? ['--', input.file] : [])] : ['diff', ...(input.file ? ['--', input.file] : [])];
        else if (input.verb === 'log') args = ['log', `-${input.count}`, '--oneline', ...(input.file ? ['--', input.file] : [])];
        else if (input.verb === 'current-branch') args = ['branch', '--show-current'];
        else if (input.verb === 'branch-list') args = ['branch', '--list', '--all'];
        else if (input.verb === 'branch-create') args = input.fromRef ? ['checkout', '-b', input.name, input.fromRef] : ['checkout', '-b', input.name];
        else if (input.verb === 'branch-switch') args = ['checkout', input.name];
        else if (input.verb === 'add') args = ['add', '--', ...input.files.map((f) => path.normalize(f))];
        else if (input.verb === 'commit') args = ['commit', '-m', input.message];
        else args = input.branch ? ['push', ...(input.setUpstream ? ['-u'] : []), input.remote, input.branch] : ['push', ...(input.setUpstream ? ['-u'] : []), input.remote];
        const result = await run('git', args, cwd);
        return { verb: input.verb, ...result };
    },
});
