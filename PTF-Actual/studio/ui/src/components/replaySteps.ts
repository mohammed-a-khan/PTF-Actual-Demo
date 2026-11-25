/** A recorded agent session as replay steps (Replay.tsx). */
import type { AgentEventDef } from '../api';

export interface ReplayStep { i: number; at: number; kind: 'user' | 'assistant' | 'tool' | 'approval' | 'info' | 'error' | 'reasoning'; title: string; detail?: string; result?: string; ok?: boolean; ms?: number; decision?: string; flagged?: boolean }

/** The events as steps: a tool's start and end are one step; streamed text and idle markers are left out. */
export function toSteps(events: AgentEventDef[]): ReplayStep[] {
    const steps: ReplayStep[] = [];
    const tools = new Map<string, ReplayStep>(), approvals = new Map<string, ReplayStep>();
    for (const e of events) {
        const add = (s: Omit<ReplayStep, 'i' | 'at'>) => { const st = { i: steps.length, at: e.at, ...s }; steps.push(st); return st; };
        if (e.type === 'user') add({ kind: 'user', title: 'Request', detail: e.text });
        else if (e.type === 'assistant') add({ kind: 'assistant', title: 'Answer', detail: e.text });
        else if (e.type === 'reasoning') add({ kind: 'reasoning', title: 'Thinking', detail: e.text });
        else if (e.type === 'tool-start') tools.set(e.id, add({ kind: 'tool', title: `${e.server ? `${e.server} · ` : ''}${e.tool}`, detail: e.args }));
        else if (e.type === 'tool-end') { const t = tools.get(e.id); if (t) { t.result = e.result; t.ok = e.ok; t.ms = e.at - t.at; t.flagged = /^⚠ Possible prompt injection/.test(e.result) || t.flagged; } }
        else if (e.type === 'approval') approvals.set(e.id, add({ kind: 'approval', title: e.title, detail: e.detail }));
        else if (e.type === 'approval-done') { const a = approvals.get(e.id); if (a) a.decision = e.decision; }
        else if (e.type === 'info') add({ kind: 'info', title: e.text.split(':')[0].slice(0, 80), detail: e.text, flagged: /prompt injection|looks suspicious|Refused/.test(e.text) });
        else if (e.type === 'error') add({ kind: 'error', title: 'Error', detail: e.text, flagged: true });
    }
    return steps;
}

