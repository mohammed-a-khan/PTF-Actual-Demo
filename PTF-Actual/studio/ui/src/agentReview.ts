/**
 * The agent edits waiting for review, shared by the editor (changed lines, Keep / Undo), the agent panel
 * (the "files changed" bar) and the Changes tab. Asked again every few seconds while the page is visible,
 * at once after a Keep or Undo, and when the agent sessions change.
 */
import React from 'react';
import { AgentReviewFile, api } from './api';

let files: AgentReviewFile[] = [];
let loaded = false;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };

export function refreshAgentReview(): Promise<void> {
    if (inflight) return inflight;
    inflight = api.agentReview()
        .then((r) => {
            const same = loaded && r.files.length === files.length && r.files.every((f, i) => f.session === files[i].session && f.path === files[i].path && f.before === files[i].before && f.after === files[i].after);
            files = r.files; loaded = true;
            if (!same) emit();
        })
        .catch(() => undefined)
        .finally(() => { inflight = null; });
    return inflight;
}

let timer: number | undefined;
function start() {
    if (timer !== undefined || typeof window === 'undefined') return;
    void refreshAgentReview();
    timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refreshAgentReview(); }, 4000);
    window.addEventListener('cs-studio:agent-sessions-changed', () => void refreshAgentReview());
}

/** All files waiting for review (every conversation). */
export function useAgentReview(): AgentReviewFile[] {
    const [, bump] = React.useReducer((n: number) => n + 1, 0);
    React.useEffect(() => { start(); listeners.add(bump); return () => { listeners.delete(bump); }; }, []);
    return files;
}

/** The review of one file: the newest conversation that changed it. */
export const reviewOf = (all: AgentReviewFile[], path: string): AgentReviewFile | undefined => all.find((f) => f.path === path);
