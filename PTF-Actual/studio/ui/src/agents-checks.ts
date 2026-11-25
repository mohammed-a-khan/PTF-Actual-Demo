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
