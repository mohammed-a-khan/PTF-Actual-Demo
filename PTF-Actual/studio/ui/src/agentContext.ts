/**
 * What the person is looking at, for agents: the screen (and its route: file, run, collection…) plus
 * details a screen adds (selected connection, query, scenario…). Sent with every message and kept up
 * to date on the server, so an agent's studio_context tool sees the current screen.
 */
import React from 'react';

type Ctx = Record<string, unknown>;
let screen: Ctx = {};
const details = new Map<string, Ctx>();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let sender: ((c: Ctx) => void) | null = null;

export function agentContext(): Ctx {
    const out: Ctx = { ...screen };
    for (const d of details.values()) Object.assign(out, d);
    return out;
}

function changed() {
    for (const l of listeners) l();
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => sender?.(agentContext()), 400);
}

/** The app: which screen is open (and its route). */
export function setAgentScreen(c: Ctx) { screen = c; changed(); }
/** Send the context to the server when it changes (set once by the app). */
export function onAgentContext(fn: (c: Ctx) => void) { sender = fn; }
export function subscribeAgentContext(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }

/** A screen adds what is selected there (removed when the screen is left). */
export function useAgentContext(key: string, value: Ctx | null, active = true) {
    const json = JSON.stringify(value ?? null);
    React.useEffect(() => {
        if (!active || !value) { if (details.delete(key)) changed(); return; }
        details.set(key, value);
        changed();
        return () => { details.delete(key); changed(); };
    }, [key, json, active]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Open Copilot with a question about what is on the screen (the person can change it before sending). */
let pendingAsk: string | null = null;
export function askCopilot(text: string) {
    pendingAsk = text;
    window.dispatchEvent(new CustomEvent('cs-studio:ask-copilot', { detail: text }));
}
/** The question handed over before the panel was open (once). */
export function takePendingAsk(): string | null { const t = pendingAsk; pendingAsk = null; return t; }
