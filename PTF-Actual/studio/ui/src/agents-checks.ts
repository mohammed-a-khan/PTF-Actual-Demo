/**
 * The Agent builder's checks as the person types: the server's own rules (src/agents/builder.ts validateAgent and
 * saveAgent, src/agents/cron.ts), so a problem shows next to its field and Save waits, instead of a toast after Save.
 */
import { parseCron } from '../../src/agents/cron';

/** An agent id (its file name): the server's rule. */
export const AGENT_ID = /^[a-z0-9][a-z0-9-]{1,39}$/;
/** The fewest characters of instructions the server accepts. */
export const INSTRUCTIONS_MIN = 20;

/** Why a new agent's id cannot be used (format, a built-in mission's name, an agent that exists), or null. */
export function agentIdProblem(id: string, o: { reserved?: string[]; existing?: string[] } = {}): string | null {
    if (!id) return 'Give the agent an id (lower-case letters, digits and -).';
    if (!AGENT_ID.test(id)) return id.length > 40 ? `At most 40 characters (it has ${id.length}).` : id.length < 2 ? 'At least 2 characters.' : 'Lower-case letters, digits and -, starting with a letter or digit.';
    if (o.reserved?.includes(id)) return `"${id}" is the name of a built-in mission: choose another id.`;
    if (o.existing?.includes(id)) return `An agent "${id}" exists: choose another id.`;
    return null;
}

/** Why the instructions are not enough, or null. */
export function instructionsProblem(text: string): string | null {
    const n = text.trim().length;
    if (!n) return 'Write how it works: its role, rules and steps.';
    return n < INSTRUCTIONS_MIN ? `At least ${INSTRUCTIONS_MIN} characters (now ${n}).` : null;
}

/** Why a schedule is not a five-field cron line, or null (the server's message). */
export function cronProblem(cron: string): string | null {
    const t = cron.trim();
    if (!t) return 'Give the schedule: five fields, e.g. "0 2 * * 1-5" for 02:00 on weekdays.';
    if (parseCron(t)) return null;
    const n = t.split(/\s+/).length;
    return `${n !== 5 ? `${n} field${n === 1 ? '' : 's'}, not 5: ` : 'Not a schedule: '}minute 0-59, hour 0-23, day 1-31, month 1-12, weekday 0-7 (e.g. "0 2 * * 1-5").`;
}

/** An evaluation check as the cases editor holds it (src/agents/evals.ts validateSuite has the same rules). */
export type EvalCheckLike = { kind: string; text?: string; pattern?: string; tool?: string; calls?: number; seconds?: number; criteria?: string };

/** Why an evaluation check cannot be saved (the server's rule), or null. */
export function evalCheckProblem(k: EvalCheckLike): string | null {
    if ((k.kind === 'contains' || k.kind === 'not-contains') && !String(k.text ?? '').trim()) return 'Write the text to look for.';
    if (k.kind === 'matches') {
        if (!String(k.pattern ?? '').trim()) return 'Write the pattern to match.';
        try { new RegExp(String(k.pattern), 'i'); } catch (e) { return `Not a valid pattern (${(e as Error).message.replace(/^Invalid regular expression: /, '')}).`; }
    }
    if ((k.kind === 'tool-called' || k.kind === 'tool-not-called') && !/^[\w.-]{1,80}$/.test(String(k.tool ?? ''))) return String(k.tool ?? '').trim() ? 'A tool name: letters, digits, _ . and - (at most 80).' : 'Write the tool\'s name.';
    if (k.kind === 'max-calls' && !(Number(k.calls) >= 1)) return 'A number of calls, 1 or more.';
    if (k.kind === 'max-seconds' && !(Number(k.seconds) >= 1)) return 'A number of seconds, 1 or more.';
    if (k.kind === 'judge' && String(k.criteria ?? '').trim().length < 10) return 'Write the grader\'s criteria (at least 10 characters).';
    return null;
}

/** Why an evaluation case's prompt cannot be saved, or null. */
export const evalPromptProblem = (prompt: string): string | null => (String(prompt ?? '').trim() ? null : 'Write the prompt: what the person asks the agent.');
