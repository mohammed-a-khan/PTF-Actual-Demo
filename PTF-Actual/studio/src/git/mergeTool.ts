/**
 * Resolve a conflict in the user's own merge tool (Beyond Compare, KDiff3, P4Merge, WinMerge, Meld, VS Code, or one
 * defined in their Git settings): Git's `mergetool` opens it with the base, both sides and the result; when the tool
 * closes, the file is resolved if Git says so, or if no conflict markers are left in it (then the Studio stages it).
 * Terminal-only tools (vim, Emacs) are not offered: the Studio has no terminal for them.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { runGit } from './run';
import { UserError } from '../core/errors';

export interface MergeTool { name: string; label: string; userDefined?: boolean }
const TERMINAL = /^(n?vimdiff\d?|emerge)$/;
/** VS Code when it is installed and Git does not know it as a tool (older Git). */
const VSCODE_CMD = 'code --wait --merge "$REMOTE" "$LOCAL" "$BASE" "$MERGED"';

function onPath(bin: string): boolean {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    return r.status === 0 && !!r.stdout.trim();
}

/** The merge tools Git can start here, the one set as default first. */
export async function mergeTools(cwd: string, o: { vscode?: boolean } = {}): Promise<{ tools: MergeTool[]; default?: string }> {
    const help = await runGit(['mergetool', '--tool-help'], { cwd, allowFailure: true, timeoutMs: 20_000 });
    const text = help.stdout + help.stderr;
    const avail = text.split(/The following tools are valid, but not currently available:/)[0];
    const tools: MergeTool[] = [];
    let user = false;
    for (const line of avail.split('\n')) {
        if (/^\s*user-defined:/.test(line)) { user = true; continue; }
        if (user) {
            const m = /^\s+([\w.-]+?)\.cmd\s/.exec(line);
            if (m) tools.push({ name: m[1], label: m[1], userDefined: true });
            continue;
        }
        const m = /^\t\t([\w.-]+)\s+(.*)$/.exec(line);
        if (m && !TERMINAL.test(m[1])) tools.push({ name: m[1], label: m[2].replace(/^Use\s+/, '').replace(/\s*\(requires a graphical session\)/, '').replace(/\s*\(see `git help.*$/, '').replace(/ with .*$/, '').trim() || m[1] });
    }
    if ((o.vscode ?? onPath('code')) && !tools.some((t) => t.name === 'vscode')) tools.push({ name: 'vscode', label: 'Visual Studio Code' });
    const def = (await runGit(['config', '--get', 'merge.tool'], { cwd, allowFailure: true })).stdout.trim() || undefined;
    if (def) tools.sort((a, b) => Number(b.name === def) - Number(a.name === def));
    return { tools, ...(def ? { default: def } : {}) };
}

const unmerged = async (cwd: string, file: string) => (await runGit(['ls-files', '-u', '--', file], { cwd, allowFailure: true })).stdout.trim().length > 0;
export const hasMarkers = (text: string) => /^<{7}( |$)/m.test(text) && /^>{7}( |$)/m.test(text) && /^={7}$/m.test(text);

/**
 * Open the tool on one conflicted file and wait for it to close (it may be open for a long time).
 * Resolves with how it ended; the file is staged when it is resolved.
 */
export async function runMergeTool(o: { cwd: string; file: string; tool: string; known: MergeTool[]; timeoutMs?: number }): Promise<{ resolved: boolean; message: string }> {
    if (!o.known.some((t) => t.name === o.tool)) throw new UserError(`${o.tool} is not a merge tool Git can start here.`);
    if (!o.file || o.file.startsWith('-') || path.isAbsolute(o.file) || o.file.split(/[\\/]/).includes('..')) throw new UserError('Invalid file.');
    if (!(await unmerged(o.cwd, o.file))) throw new UserError(`${o.file} has no conflict to resolve.`);
    const vscode = o.tool === 'vscode' && !o.known.find((t) => t.name === 'vscode')?.userDefined;
    const args = [
        '-c', 'mergetool.keepBackup=false', '-c', 'mergetool.keepTemporaries=false', '-c', 'mergetool.prompt=false',
        ...(vscode ? ['-c', `mergetool.vscode.cmd=${VSCODE_CMD}`, '-c', 'mergetool.vscode.trustExitCode=false'] : []),
        'mergetool', '--no-prompt', `--tool=${o.tool}`, '--', o.file,
    ];
    // No input: if Git asks "Was the merge successful?" the answer is no, and the file is checked below.
    const r = await runGit(args, { cwd: o.cwd, allowFailure: true, timeoutMs: o.timeoutMs ?? 6 * 3600_000 });
    if (!(await unmerged(o.cwd, o.file))) return { resolved: true, message: `Resolved in ${o.tool}.` };
    const abs = path.join(o.cwd, o.file);
    const text = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
    if (text !== null && !hasMarkers(text) && r.code === 0) {
        await runGit(['add', '--', o.file], { cwd: o.cwd });
        return { resolved: true, message: `Resolved in ${o.tool}: no conflict markers are left, so the file was staged.` };
    }
    const why = (r.stderr || r.stdout).trim().split('\n').filter((l) => l && !/^(Merging|Normal merge conflict|  \{local\}|  \{remote\})/.test(l)).slice(-2).join(' ');
    return { resolved: false, message: text !== null && hasMarkers(text) ? `${o.tool} closed and the file still has conflict markers: it is still in conflict.` : `${o.tool} closed without resolving the file${why ? ` (${why})` : ''}.` };
}
