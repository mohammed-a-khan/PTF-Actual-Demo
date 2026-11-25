/**
 * Load policies: how many virtual users are active at each second of a run.
 *
 * The set of shapes and their parameters follow the performance-testing-app's load patterns
 * (constant, ramp, step, spike, wave, breakpoint/stress, soak); the math is new: every shape can ramp
 * down at the end, ramps are linear per second (not ten coarse steps), and each shape is a pure
 * function of time so it can be drawn before the run and tested.
 */
/**
 * constant … wave: a number of users ("closed model": each user runs the path again and again, so a slower system gets
 * fewer iterations). arrival: iterations started at a rate ("open model": a new iteration every 1/rate seconds whatever
 * the response times, by an idle user, or a new one up to `users`; when all are busy the iteration is dropped).
 */
export type PolicyType = 'constant' | 'ramp' | 'steps' | 'peaks' | 'wave' | 'arrival' | 'custom';

export interface LoadPolicy {
    type: PolicyType;
    /** Total length of the run in seconds (ramp-down included). */
    duration: number;
    /** constant / ramp: users to reach and hold. */
    users: number;
    /** Seconds to go from `startUsers` to `users` at the start. */
    rampUp?: number;
    /** Seconds to go down to 0 at the end. */
    rampDown?: number;
    /** ramp / steps / wave: users at the start (default 1 for steps, 0 for ramps). */
    startUsers?: number;
    /** steps (also a breakpoint / stress search): add `stepUsers` every `stepEvery` seconds, up to `users`. */
    stepUsers?: number;
    stepEvery?: number;
    /** peaks: `users` is the base; every `peakEvery` seconds go to `peakUsers` for `peakLength` seconds. */
    peakUsers?: number;
    peakEvery?: number;
    peakLength?: number;
    /** wave: `users` ± `amplitude` with this period (seconds). */
    amplitude?: number;
    period?: number;
    /** arrival: iterations started per second (`users`: the most users at once). */
    rate?: number;
    /** arrival: the rate at the start of the ramp-up (default 0). */
    startRate?: number;
    /** custom: users at given seconds (straight lines between; a CSV of "second,users" or drawn), the last point holds to the end. */
    points?: Array<{ t: number; users: number }>;
}

/** A custom curve from CSV text ("second,users" per line; a header line is skipped). */
export function curveFromCsv(text: string): Array<{ t: number; users: number }> {
    const pts = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^[a-z]/i.test(l)).map((l) => l.split(/[,;\t ]+/).map(Number)).filter(([t, u]) => Number.isFinite(t) && Number.isFinite(u)).map(([t, u]) => ({ t: Math.max(0, t), users: Math.max(0, Math.round(u)) }));
    return pts.sort((a, b) => a.t - b.t);
}

/** The lines of a custom curve that are not "second,users" (non-negative numbers), each with its line number. */
export function curveProblems(text: string): string[] {
    const out: string[] = [];
    const lines = text.split(/\r?\n/);
    const headerAt = lines.findIndex((l) => l.trim());
    lines.forEach((raw, i) => {
        const l = raw.trim();
        if (!l || (i === headerAt && /^[a-z]/i.test(l))) return; // empty, or a header line (the first one with text)
        const parts = l.split(/[,;\t ]+/);
        const nums = parts.map(Number);
        if (parts.length !== 2 || nums.some((x) => !Number.isFinite(x))) out.push(`Line ${i + 1} ("${l.slice(0, 40)}"): write two numbers, second and users (for example 30,10).`);
        else if (nums.some((x) => x < 0)) out.push(`Line ${i + 1} ("${l}"): seconds and users cannot be negative.`);
        else if (!Number.isInteger(nums[1])) out.push(`Line ${i + 1} ("${l}"): users are a whole number.`);
        else if (nums[1] > 100_000) out.push(`Line ${i + 1} ("${l}"): at most 100000 users.`);
    });
    // In time order (the curve is read left to right): a point at or before the one above it is a mistake.
    let prev: { t: number; line: number } | null = null;
    lines.forEach((raw, i) => {
        const nums = raw.trim().split(/[,;\t ]+/).map(Number);
        if (nums.length !== 2 || nums.some((x) => !Number.isFinite(x) || x < 0)) return;
        if (prev && nums[0] <= prev.t) out.push(`Line ${i + 1} ("${raw.trim()}"): ${nums[0] === prev.t ? 'the same second as' : 'earlier than'} line ${prev.line}; the seconds go up from line to line.`);
        prev = { t: nums[0], line: i + 1 };
    });
    const first = lines.findIndex((l) => l.trim());
    if (first >= 0 && /^[a-z]/i.test(lines[first].trim()) && !/^[a-z_ ]+[,;\t ][a-z_ ]+$/i.test(lines[first].trim())) out.push(`Line ${first + 1} ("${lines[first].trim().slice(0, 40)}"): not a header (second,users) and not two numbers.`);
    if (!out.length && curveFromCsv(text).length < 2) out.push('Give at least 2 points (second,users).');
    if (!out.length && curveFromCsv(text).every((x) => x.users === 0)) out.push('Every point has 0 users: no one would run.');
    return out;
}

export function validPolicy(p: LoadPolicy): string | null {
    const n = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
    if (!['constant', 'ramp', 'steps', 'peaks', 'wave', 'arrival', 'custom'].includes(p.type)) return 'Unknown load policy.';
    if (p.type === 'custom') {
        if (!Array.isArray(p.points) || p.points.length < 2 || p.points.length > 10_000) return 'A custom curve needs 2 to 10000 points (second, users).';
        if (p.points.some((x, i) => !n(x?.t) || !n(x?.users) || x.users > 100_000 || (i > 0 && x.t < p.points![i - 1].t))) return 'The points of a custom curve go up in time, with 0 to 100000 users.';
    }
    if (!n(p.duration) || p.duration < 1 || p.duration > 7 * 24 * 3600) return 'The duration must be between 1 second and 7 days.';
    if (!n(p.users) || p.users < 1 || p.users > 100_000) return 'The number of users must be between 1 and 100000.';
    for (const k of ['rampUp', 'rampDown', 'startUsers', 'stepUsers', 'stepEvery', 'peakUsers', 'peakEvery', 'peakLength', 'amplitude', 'period', 'rate', 'startRate'] as const) if (p[k] !== undefined && !n(p[k])) return `"${k}" must be a positive number.`;
    if ((p.rampUp ?? 0) + (p.rampDown ?? 0) > p.duration) return 'Ramp-up and ramp-down are longer than the run.';
    if (p.type === 'steps' && (!p.stepUsers || !p.stepEvery)) return 'Steps need "users per step" and "seconds per step".';
    if (p.type === 'peaks' && (!p.peakUsers || !p.peakEvery || !p.peakLength)) return 'Peaks need the peak users, how often and how long.';
    if (p.type === 'wave' && (!p.period || p.amplitude === undefined)) return 'A wave needs its amplitude and period.';
    if (p.type === 'arrival' && (!p.rate || p.rate > 10_000)) return 'An arrival rate needs the iterations per second (up to 10000).';
    if (p.type === 'arrival' && (p.startRate ?? 0) > 10_000) return 'The start rate is up to 10000 iterations per second.';
    return null;
}

/** arrival: iterations to start per second, `t` seconds into the run (ramp-up from startRate, ramp-down to 0). */
export function rateAt(p: LoadPolicy, t: number): number {
    if (p.type !== 'arrival' || t < 0 || t >= p.duration) return 0;
    let r = p.rate ?? 0;
    const up = p.rampUp ?? 0, down = p.rampDown ?? 0, start = p.startRate ?? 0;
    if (up > 0 && t < up) r = start + (r - start) * (t / up);
    if (down > 0 && t >= p.duration - down) r = r * ((p.duration - t) / down);
    return Math.max(0, r);
}

/** Users that should be active `t` seconds into the run (whole number, 0 after the end). arrival: 0 (started by the rate). */
export function usersAt(p: LoadPolicy, t: number): number {
    if (t < 0 || t >= p.duration || p.type === 'arrival') return 0;
    const start = p.startUsers ?? (p.type === 'steps' ? 1 : 0);
    let u: number;
    switch (p.type) {
        case 'steps': {
            const k = Math.floor(t / (p.stepEvery || 1));
            u = Math.min(p.users, start + k * (p.stepUsers ?? 1));
            break;
        }
        case 'peaks': {
            const inPeak = p.peakEvery ? (t % p.peakEvery) >= (p.peakEvery - (p.peakLength ?? 0)) : false;
            u = inPeak ? (p.peakUsers ?? p.users) : p.users;
            break;
        }
        case 'wave': {
            u = p.users + (p.amplitude ?? 0) * Math.sin((2 * Math.PI * t) / (p.period || 60));
            break;
        }
        case 'custom': {
            const pts = p.points ?? [];
            const j = pts.findIndex((x) => x.t > t);
            if (j <= 0) return Math.max(0, Math.round(j === 0 ? pts[0].users : pts[pts.length - 1]?.users ?? 0));
            const a = pts[j - 1], b = pts[j];
            return Math.max(0, Math.round(a.users + (b.users - a.users) * ((t - a.t) / Math.max(1e-9, b.t - a.t))));
        }
        default: u = p.users; // constant, ramp
    }
    // Ramp-up from `start`, ramp-down to 0: linear, applied to every shape.
    const up = p.rampUp ?? 0, down = p.rampDown ?? 0;
    if (up > 0 && t < up) u = start + (u - start) * (t / up);
    if (down > 0 && t >= p.duration - down) u = u * ((p.duration - t) / down);
    return Math.max(0, Math.round(u));
}

/** The policy as points (one per second, at most ~600 points) for drawing it. */
export function policyCurve(p: LoadPolicy): Array<{ t: number; users: number; rate?: number }> {
    const step = Math.max(1, Math.ceil(p.duration / 600));
    const out: Array<{ t: number; users: number; rate?: number }> = [];
    const arrival = p.type === 'arrival';
    for (let t = 0; t < p.duration; t += step) out.push(arrival ? { t, users: 0, rate: Math.round(rateAt(p, t) * 100) / 100 } : { t, users: usersAt(p, t) });
    out.push(arrival ? { t: p.duration, users: 0, rate: 0 } : { t: p.duration, users: 0 });
    return out;
}

export const maxUsers = (p: LoadPolicy) => (p.type === 'arrival' ? p.users : policyCurve(p).reduce((m, x) => Math.max(m, x.users), 0));

/** The policy in a few words, for reports. */
/** "1 user", "5 users". */
export const usersText = (n: number | undefined) => `${n ?? 0} user${n === 1 ? '' : 's'}`;

export function describePolicy(p: LoadPolicy): string {
    const ramps = `${p.rampUp ? `, ramp-up ${p.rampUp} s` : ''}${p.rampDown ? `, ramp-down ${p.rampDown} s` : ''}`;
    const len = `${p.duration} s`;
    switch (p.type) {
        case 'constant': return `Constant ${usersText(p.users)} for ${len}${ramps}`;
        case 'ramp': return `Ramp ${p.startUsers ?? 0} → ${usersText(p.users)}, ${len}${ramps}`;
        case 'steps': return `Steps of ${usersText(p.stepUsers ?? 1)} every ${p.stepEvery ?? 0} s up to ${p.users}, ${len}${ramps}`;
        case 'peaks': return `${usersText(p.users)} with peaks of ${p.peakUsers ?? p.users} every ${p.peakEvery ?? 0} s for ${p.peakLength ?? 0} s, ${len}${ramps}`;
        case 'wave': return `Wave ${p.users} ± ${usersText(p.amplitude ?? 0)} every ${p.period ?? 0} s, ${len}${ramps}`;
        case 'arrival': return `${p.startRate && p.rampUp ? `${p.startRate} → ` : ''}${p.rate ?? 0} iterations per second (arrival rate), up to ${p.users} users, ${len}${ramps}`;
        case 'custom': return `Custom curve of ${p.points?.length ?? 0} points up to ${Math.max(0, ...(p.points ?? []).map((x) => x.users))} users, ${len}`;
        default: return `${p.users} users, ${len}`;
    }
}
