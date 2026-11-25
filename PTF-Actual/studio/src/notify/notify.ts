/**
 * Run notifications: when a test run ends, a message to a Microsoft Teams channel (a Workflows webhook), a Slack
 * channel (an incoming webhook) or any webhook (the run as JSON). Personal: the channels are kept on this computer and
 * each webhook address — a secret, anyone holding it can post — in the Studio's secret store, never in the repository.
 */
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import { randomBytes } from 'crypto';
import type { Connection } from '../core/network';
import { UserError } from '../core/errors';
import { writeFileAtomic } from '../core/paths';

export type NotifyKind = 'teams' | 'slack' | 'webhook';
/** always: every run; failures: runs that failed or broke; changes: a run whose result differs from the previous run of the same tests. */
export type NotifyWhen = 'always' | 'failures' | 'changes';

export interface NotifyChannel {
    id: string; name: string; kind: NotifyKind; when: NotifyWhen;
    /** Only runs of these projects / environments (none: all). */
    projects?: string[]; envs?: string[];
    enabled: boolean;
    /** Also what waits for a person (the inbox: agents' questions, plans and approvals, work to review). */
    inbox?: boolean;
}

/** What a notification says about a run (secrets were already masked by the runner). */
export interface RunNote {
    id: string; state: string; project: string; env: string; what: string; startedAt: string; endedAt?: string;
    passed?: number; failed?: number; skipped?: number; flaky?: number; durationMs?: number; by?: string; branch?: string;
    failures: Array<{ name: string; feature?: string; error?: string }>; message?: string;
}

export const secretName = (id: string) => `NOTIFY_WEBHOOK_${id.toUpperCase()}`;

export class NotifyStore {
    private readonly file: string;
    constructor(home: string) { this.file = path.join(home, 'notifications.json'); }
    get(): NotifyChannel[] {
        try { const d = JSON.parse(fs.readFileSync(this.file, 'utf8')); return Array.isArray(d.channels) ? d.channels.map(clean) : []; } catch { return []; }
    }
    set(channels: NotifyChannel[]): NotifyChannel[] {
        const out = validateChannels(channels);
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        writeFileAtomic(this.file, JSON.stringify({ channels: out }, null, 2));
        return out;
    }
}

const KINDS: NotifyKind[] = ['teams', 'slack', 'webhook'];
const WHENS: NotifyWhen[] = ['always', 'failures', 'changes'];
function clean(c: Partial<NotifyChannel>): NotifyChannel {
    return {
        id: /^[a-z0-9]{4,20}$/.test(String(c.id)) ? String(c.id) : randomBytes(4).toString('hex'),
        name: String(c.name ?? '').trim().slice(0, 60),
        kind: KINDS.includes(c.kind as NotifyKind) ? c.kind as NotifyKind : 'webhook',
        when: WHENS.includes(c.when as NotifyWhen) ? c.when as NotifyWhen : 'failures',
        ...(c.projects?.length ? { projects: c.projects.map(String).filter(Boolean) } : {}),
        ...(c.envs?.length ? { envs: c.envs.map(String).filter(Boolean) } : {}),
        enabled: c.enabled !== false,
        ...(c.inbox ? { inbox: true } : {}),
    };
}
export function validateChannels(list: unknown): NotifyChannel[] {
    if (!Array.isArray(list)) throw new UserError('channels must be a list.');
    if (list.length > 20) throw new UserError('At most 20 channels.');
    const out = list.map((c) => clean(c as Partial<NotifyChannel>));
    const names = new Set<string>();
    for (const c of out) {
        if (!c.name) throw new UserError('Every channel needs a name.');
        if (names.has(c.name.toLowerCase())) throw new UserError(`Two channels are named "${c.name}".`);
        names.add(c.name.toLowerCase());
    }
    return out;
}

/** A webhook address: https (http only for this computer), and for Teams/Slack the services' own hosts. */
export function validateWebhook(kind: NotifyKind, url: string): string {
    let u: URL;
    try { u = new URL(url.trim()); } catch { throw new UserError('Not a web address.'); }
    const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new UserError('The webhook address must start with https:// (http:// only for an address on this computer, such as 127.0.0.1 or localhost).');
    if (kind === 'slack' && !local && u.hostname !== 'hooks.slack.com') throw new UserError('A Slack incoming webhook starts with https://hooks.slack.com/.');
    if (kind === 'teams' && !local && !/(\.logic\.azure\.com|\.powerplatform\.com|\.webhook\.office\.com|\.azure-api\.net|\.powerautomate\.com)$/i.test(u.hostname)) {
        throw new UserError('A Teams webhook is the address of a Teams "Workflows" webhook (…logic.azure.com or …powerplatform.com).');
    }
    return u.toString();
}

/** Does this run go to this channel? `previous`: the state of the last run of the same tests before it. */
export function shouldNotify(c: NotifyChannel, n: RunNote, previous?: string): boolean {
    if (!c.enabled) return false;
    if (n.state === 'stopped' || n.state === 'running') return false;
    if (c.projects?.length && !c.projects.includes(n.project)) return false;
    if (c.envs?.length && !c.envs.includes(n.env)) return false;
    if (c.when === 'always') return true;
    if (c.when === 'failures') return n.state === 'failed' || n.state === 'error';
    return previous !== undefined && previous !== n.state && !(previous === 'stopped');
}

const cut = (s: string | undefined, n: number) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const dur = (ms?: number) => (ms === undefined ? '' : ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);
const ICON: Record<string, string> = { passed: '✅', failed: '❌', error: '⚠️' };

export function headline(n: RunNote): string {
    const counts = n.passed !== undefined ? ` — ${n.passed} passed, ${n.failed} failed${n.skipped ? `, ${n.skipped} skipped` : ''}${n.flaky ? `, ${n.flaky} only after a retry` : ''}` : '';
    return `${ICON[n.state] ?? ''} ${n.state.toUpperCase()}: ${n.project} on ${n.env}${counts}`.trim();
}

/** The message body for the channel's service. */
export function payload(kind: NotifyKind, n: RunNote): unknown {
    const facts: Array<[string, string]> = [['Tests', n.what], ['Duration', dur(n.durationMs)], ...(n.branch ? [['Branch', n.branch] as [string, string]] : []), ...(n.by ? [['Run by', n.by] as [string, string]] : [])].filter(([, v]) => v) as Array<[string, string]>;
    const fails = n.failures.slice(0, 8);
    const more = n.failures.length - fails.length;
    if (kind === 'webhook') return { event: 'run.finished', run: n };
    if (kind === 'slack') {
        return {
            text: headline(n),
            blocks: [
                { type: 'section', text: { type: 'mrkdwn', text: `*${headline(n)}*${n.message ? `\n${cut(n.message, 300)}` : ''}` } },
                { type: 'context', elements: facts.map(([k, v]) => ({ type: 'mrkdwn', text: `*${k}:* ${cut(v, 200)}` })) },
                ...(fails.length ? [{ type: 'section', text: { type: 'mrkdwn', text: fails.map((f) => `• *${cut(f.feature ? `${f.feature}: ${f.name}` : f.name, 150)}*${f.error ? `\n  \`${cut(f.error, 200)}\`` : ''}`).join('\n') + (more > 0 ? `\n…and ${more} more` : '') } }] : []),
            ],
        };
    }
    // Teams: an Adaptive Card, the format a Teams "Workflows" webhook posts to the channel.
    return {
        type: 'message',
        attachments: [{
            contentType: 'application/vnd.microsoft.card.adaptive',
            content: {
                $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4',
                body: [
                    { type: 'TextBlock', text: headline(n), weight: 'Bolder', size: 'Medium', wrap: true, color: n.state === 'passed' ? 'Good' : 'Attention' },
                    ...(n.message ? [{ type: 'TextBlock', text: cut(n.message, 300), wrap: true }] : []),
                    { type: 'FactSet', facts: facts.map(([title, value]) => ({ title, value: cut(value, 200) })) },
                    ...fails.map((f) => ({ type: 'TextBlock', wrap: true, spacing: 'Small', text: `**${cut(f.feature ? `${f.feature}: ${f.name}` : f.name, 150)}**${f.error ? `  \n${cut(f.error, 200)}` : ''}` })),
                    ...(more > 0 ? [{ type: 'TextBlock', text: `…and ${more} more`, isSubtle: true }] : []),
                ],
            },
        }],
    };
}

/** POST the JSON, through the Studio's network settings (proxy, company certificates). */
export function postJson(url: string, body: unknown, conn?: Connection, timeoutMs = 15_000): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
        const data = Buffer.from(JSON.stringify(body));
        const plain = /^http:/i.test(url);
        const req = (plain ? http : https).request(url, {
            method: 'POST', timeout: timeoutMs, agent: conn?.agentFor(url),
            headers: { 'Content-Type': 'application/json', 'Content-Length': String(data.length), 'User-Agent': 'cs-test-studio' },
            ...(plain || !conn?.ca ? {} : { ca: conn.ca }),
        }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => { if (chunks.reduce((a, b) => a + b.length, 0) < 4096) chunks.push(c); });
            res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8').slice(0, 500) }));
        });
        req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
        req.on('error', reject);
        req.end(data);
    });
}

export interface Delivery { at: string; channel: string; run: string; ok: boolean; detail: string }

/** Send to one channel; the webhook's answer as a delivery record (never throws). The address is never in the record. */
export async function deliver(c: NotifyChannel, url: string, n: RunNote, conn?: Connection): Promise<Delivery> {
    const at = new Date().toISOString();
    try {
        const r = await postJson(url, payload(c.kind, n), conn);
        const ok = r.status >= 200 && r.status < 300;
        return { at, channel: c.name, run: n.id, ok, detail: ok ? `HTTP ${r.status}` : `HTTP ${r.status}${r.text ? `: ${cut(r.text, 200)}` : ''}` };
    } catch (e) {
        const err = e as NodeJS.ErrnoException;
        return { at, channel: c.name, run: n.id, ok: false, detail: err.code ?? err.message };
    }
}

/** The run as a notification: what ran, the counts, the failures. */
export function runNote(run: import('../run/runner').RunInfo, by?: string, branch?: string): RunNote {
    const r = run.request;
    const what = [r.features?.length ? r.features.map((f) => f.split('/').pop()).join(', ') : '', r.tags ? `tags ${r.tags}` : '', r.scenario ? `"${r.scenario}"` : '',
        r.scenarios?.length ? `${r.scenarios.length} scenario${r.scenarios.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ') || 'all tests';
    const s = run.summary;
    return {
        id: run.id, state: run.state, project: r.project, env: r.env, what: run.pr ? `pull request !${run.pr.id} — ${what}` : what, startedAt: run.startedAt,
        ...(run.endedAt ? { endedAt: run.endedAt, durationMs: Date.parse(run.endedAt) - Date.parse(run.startedAt) } : {}),
        ...(s ? { passed: s.passed, failed: s.failed, skipped: s.skipped, ...(s.flaky ? { flaky: s.flaky } : {}) } : {}),
        failures: (s?.scenarios ?? []).filter((x) => x.status === 'failed').map((x) => ({ name: x.name, feature: x.feature, ...(x.error ? { error: x.error } : {}) })),
        ...(run.message ? { message: run.message } : {}), ...(by ? { by } : {}), ...(branch ? { branch } : {}),
    };
}

/** The run before this one of the same tests (project, environment and selection). */
export function previousState(runs: Array<import('../run/runner').RunInfo>, run: import('../run/runner').RunInfo): string | undefined {
    const key = (x: import('../run/runner').RunInfo) => JSON.stringify([x.request.project, x.request.env, x.request.features ?? [], x.request.tags ?? '', x.request.scenario ?? '', x.request.scenarios ?? [], x.pr?.id ?? null]);
    const k = key(run);
    return runs.filter((x) => x.id !== run.id && x.state !== 'running' && x.state !== 'stopped' && key(x) === k && x.startedAt < run.startedAt).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]?.state;
}

/** What waits for a person, as a notification (the inbox). */
export interface InboxNote { id: string; kind: string; title: string; detail?: string; source: { type: string; id: string; title: string }; who?: string; at: string }
const KIND_TEXT: Record<string, string> = { question: 'A question for you', plan: 'A plan to approve', approval: 'An approval for you', review: 'Work to review', regression: 'An agent got worse' };
export function inboxPayload(kind: NotifyKind, n: InboxNote): unknown {
    const head = `🔔 ${KIND_TEXT[n.kind] ?? 'Waiting for you'}: ${cut(n.title, 200)}`;
    const from = `${n.source.type === 'mission' ? 'Mission' : n.source.type === 'conversation' ? 'Agent conversation' : 'Evaluation'}: ${cut(n.source.title, 150)}${n.who ? ` (${n.who})` : ''}`;
    const detail = n.detail ? cut(n.detail, 400) : '';
    if (kind === 'webhook') return { event: 'inbox.item', item: n };
    if (kind === 'slack') return { text: head, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `*${head}*${detail ? `\n${detail}` : ''}` } }, { type: 'context', elements: [{ type: 'mrkdwn', text: `${from} · answer it in CS Test Studio → Inbox` }] }] };
    return {
        type: 'message',
        attachments: [{
            contentType: 'application/vnd.microsoft.card.adaptive',
            content: {
                $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4',
                body: [
                    { type: 'TextBlock', text: head, weight: 'Bolder', size: 'Medium', wrap: true, color: 'Warning' },
                    ...(detail ? [{ type: 'TextBlock', text: detail, wrap: true }] : []),
                    { type: 'TextBlock', text: `${from} · answer it in CS Test Studio → Inbox`, isSubtle: true, wrap: true, spacing: 'Small' },
                ],
            },
        }],
    };
}
export async function deliverInbox(c: NotifyChannel, url: string, n: InboxNote, conn?: Connection): Promise<Delivery> {
    const at = new Date().toISOString();
    try {
        const r = await postJson(url, inboxPayload(c.kind, n), conn);
        const ok = r.status >= 200 && r.status < 300;
        return { at, channel: c.name, run: `inbox: ${cut(n.title, 60)}`, ok, detail: ok ? `HTTP ${r.status}` : `HTTP ${r.status}${r.text ? `: ${cut(r.text, 200)}` : ''}` };
    } catch (e) {
        const err = e as NodeJS.ErrnoException;
        return { at, channel: c.name, run: `inbox: ${cut(n.title, 60)}`, ok: false, detail: err.code ?? err.message };
    }
}
