/** Agent events → the conversation shown in the Copilot panel. */
import type { AgentEventDef } from './api';

export type Item =
    | { kind: 'user'; seq: number; text: string }
    | { kind: 'assistant'; seq: number; text: string; streaming: boolean }
    | { kind: 'tool'; seq: number; id: string; tool: string; server?: string; args: string; done?: { ok: boolean; result: string; refused?: boolean } }
    | { kind: 'approval'; seq: number; id: string; title: string; detail: string; decided?: string; what?: string; once?: boolean }
    | { kind: 'note'; seq: number; text: string; error?: boolean };

/** A tool call the Studio refused (permissions, read only, unattended, the person): not a failure of the tool. */
export const REFUSED = /^(Denied by preToolUse hook|Refused|Not allowed|Denied|The person did not approve|The agent "[^"]*" is not allowed|This session only reads|Not done: this is an unattended run)/;

/** Events → the conversation (streamed text joined; tool start/end paired; approvals with their answer). */
export function toItems(events: AgentEventDef[]): Item[] {
    const out: Item[] = [];
    let live: Extract<Item, { kind: 'assistant' }> | null = null;
    const tools = new Map<string, Extract<Item, { kind: 'tool' }>>();
    const approvals = new Map<string, Extract<Item, { kind: 'approval' }>>();
    for (const e of events) {
        switch (e.type) {
            case 'user': live = null; out.push({ kind: 'user', seq: e.seq, text: e.text }); break;
            case 'delta': if (!live) { live = { kind: 'assistant', seq: e.seq, text: '', streaming: true }; out.push(live); } live.text += e.text; break;
            case 'assistant': if (live) { live.text = e.text; live.streaming = false; } else out.push({ kind: 'assistant', seq: e.seq, text: e.text, streaming: false }); live = null; break;
            case 'tool-start': { live = null; const t = { kind: 'tool' as const, seq: e.seq, id: e.id, tool: e.tool, server: e.server, args: e.args }; tools.set(e.id, t); out.push(t); break; }
            case 'tool-end': { const t = tools.get(e.id); if (t) t.done = { ok: e.ok, result: e.result, ...(!e.ok && REFUSED.test(e.result) ? { refused: true } : {}) }; break; }
            case 'approval': { const a = { kind: 'approval' as const, seq: e.seq, id: e.id, title: e.title, detail: e.detail, what: e.kind, ...((e as { once?: boolean }).once ? { once: true } : {}) }; approvals.set(e.id, a); out.push(a); break; }
            case 'approval-done': { const a = approvals.get(e.id); if (a) a.decided = e.decision; break; }
            case 'error': out.push({ kind: 'note', seq: e.seq, text: e.text, error: true }); live = null; break;
            case 'info': out.push({ kind: 'note', seq: e.seq, text: e.text }); break;
            default: break;
        }
    }
    return out;
}


/** Token count for the usage line: exact below 1000, then 1.2k, 35k, 1.2M. */
export function tokens(n: number): string {
    if (!n) return 'no token count';
    if (n < 1000) return `${n} tokens`;
    if (n < 1e6) return `${n < 10000 ? (Math.round(n / 100) / 10) : Math.round(n / 1000)}k tokens`;
    return `${Math.round(n / 1e5) / 10}M tokens`;
}
