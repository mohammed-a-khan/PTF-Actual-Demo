/** Git identity (user.name / user.email) for the Settings screen. */
import { runGit } from './run';
import { UserError } from '../core/errors';

export interface GitIdentity { name: string; email: string; scope: 'repository' | 'global' | 'none' }

/** The longest name Git is given (characters as people count them). */
export const IDENTITY_NAME_MAX = 100;
/** The longest email address (RFC 5321). */
export const IDENTITY_EMAIL_MAX = 254;
/** Control characters (line breaks, tabs …) and the bidi controls that make text read differently from how it is stored. */
const HIDDEN = /[\p{Cc}؜‎‏‪-‮⁦-⁩]/u;

/** Why Git should not be given this name and email (the Settings screen shows the same as you type), or null. */
export function identityProblem(name: string, email: string): string | null {
    const n = name.trim(), e = email.trim();
    if (!n) return 'Enter your name.';
    const len = Array.from(n).length;
    if (len > IDENTITY_NAME_MAX) return `The name is too long: at most ${IDENTITY_NAME_MAX} characters (it has ${len}).`;
    if (/[<>]/.test(n)) return 'The name cannot contain < or > (Git writes it as "Name <email>").';
    if (HIDDEN.test(n)) return 'The name cannot contain line breaks, tabs or hidden direction marks (such as right-to-left override).';
    if (!e) return 'Enter your email address: Git puts it on every commit, next to your name.';
    if (e.length > IDENTITY_EMAIL_MAX) return `The email address is too long: at most ${IDENTITY_EMAIL_MAX} characters.`;
    if (HIDDEN.test(e) || !/^[^\s@<>]+@[^\s@<>]+$/.test(e)) return 'Enter a valid email address, such as name@company.com.';
    return null;
}

export async function getIdentity(repo: string): Promise<GitIdentity> {
    const get = async (k: string, scope: string[]) => (await runGit(['config', ...scope, '--get', k], { cwd: repo, allowFailure: true })).stdout.trim();
    const local = { name: await get('user.name', ['--local']), email: await get('user.email', ['--local']) };
    if (local.name && local.email) return { ...local, scope: 'repository' };
    const eff = { name: await get('user.name', []), email: await get('user.email', []) };
    return { ...eff, scope: eff.name && eff.email ? 'global' : 'none' };
}

export async function setIdentity(repo: string, name: string, email: string, scope: 'repository' | 'global'): Promise<GitIdentity> {
    const problem = identityProblem(name, email);
    if (problem) throw new UserError(problem);
    const n = name.trim(), e = email.trim();
    const s = scope === 'global' ? ['--global'] : ['--local'];
    await runGit(['config', ...s, 'user.name', n], { cwd: repo });
    await runGit(['config', ...s, 'user.email', e], { cwd: repo });
    return getIdentity(repo);
}
