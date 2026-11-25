/** Git identity (user.name / user.email) for the Settings screen. */
import { runGit } from './run';
import { UserError } from '../core/errors';

export interface GitIdentity { name: string; email: string; scope: 'repository' | 'global' | 'none' }

export async function getIdentity(repo: string): Promise<GitIdentity> {
    const get = async (k: string, scope: string[]) => (await runGit(['config', ...scope, '--get', k], { cwd: repo, allowFailure: true })).stdout.trim();
    const local = { name: await get('user.name', ['--local']), email: await get('user.email', ['--local']) };
    if (local.name && local.email) return { ...local, scope: 'repository' };
    const eff = { name: await get('user.name', []), email: await get('user.email', []) };
    return { ...eff, scope: eff.name && eff.email ? 'global' : 'none' };
}

export async function setIdentity(repo: string, name: string, email: string, scope: 'repository' | 'global'): Promise<GitIdentity> {
    const n = name.trim(), e = email.trim();
    if (!n) throw new UserError('Please enter your name.');
    if (n.length > 200) throw new UserError('The name is too long (at most 200 characters).');
    if (/[\n<>]/.test(n)) throw new UserError('The name cannot contain < or > or a line break (Git writes it as "Name <email>").');
    if (!/^[^\s@<>]+@[^\s@<>]+$/.test(e) || e.length > 320) throw new UserError('Please enter a valid email address.');
    const s = scope === 'global' ? ['--global'] : ['--local'];
    await runGit(['config', ...s, 'user.name', n], { cwd: repo });
    await runGit(['config', ...s, 'user.email', e], { cwd: repo });
    return getIdentity(repo);
}
