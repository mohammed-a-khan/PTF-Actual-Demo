/**
 * Debugger keys while a debug run is going on, as in editors: F5 continue, F10 step over, F11 step into,
 * Shift+F11 step out, Shift+F5 stop. One listener for the whole Studio (whichever screen has the focus); the
 * screens that show a debug run (the Code screen's Debug tab, Run tests) register a handler while they are shown.
 *
 * Other parts of the shell can hand keys over without a keydown listener of their own (the shell keeps F5 from
 * reloading the page): `window.dispatchEvent(new CustomEvent('cs-debug-key', { detail: { key: 'F5', shiftKey: false } }))`
 * (detail.event: the KeyboardEvent, if there is one). The listener sets `detail.handled = true` when a debug run
 * took the key, and calls preventDefault() on that KeyboardEvent. `handleDebugKey(e)` does the same from code.
 */

export type DebugAction = 'continue' | 'over' | 'into' | 'out' | 'stop';

/** The action of a key (null: not a debugger key). Ctrl / Alt / Cmd with it: not one (the browser's own keys). */
export function debugActionOf(e: { key: string; shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean }): DebugAction | null {
    if (e.ctrlKey || e.altKey || e.metaKey) return null;
    if (e.key === 'F5') return e.shiftKey ? 'stop' : 'continue';
    if (e.key === 'F10') return e.shiftKey ? null : 'over';
    if (e.key === 'F11') return e.shiftKey ? 'out' : 'into';
    return null;
}

/** A screen showing a debug run: takes the action (true) or not (false: not paused, not shown…). */
export type DebugKeyHandler = (a: DebugAction) => boolean;
const handlers: DebugKeyHandler[] = [];

/** The handlers, the newest first, until one takes it. */
function dispatch(a: DebugAction): boolean {
    for (let i = handlers.length - 1; i >= 0; i--) if (handlers[i](a)) return true;
    return false;
}

/** A key event from the shell or a listener: true when a debug run took it. */
export function handleDebugKey(e: { key: string; shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean; repeat?: boolean; preventDefault?: () => void }): boolean {
    const a = debugActionOf(e);
    if (!a) return false;
    // The same key press handed over twice (the shell's event and this listener): taken once.
    if (seen.has(e as object)) return true;
    // A key held down repeats: one step per press.
    if (e.repeat) { if (handlers.length) e.preventDefault?.(); return handlers.length > 0; }
    const took = dispatch(a);
    if (took) { seen.add(e as object); e.preventDefault?.(); }
    return took;
}
const seen = new WeakSet<object>();

let installed = false;
function install(): void {
    if (installed || typeof window === 'undefined') return;
    installed = true;
    // Capture: before the editor (Monaco takes F10/F11 for itself) and before the browser reloads on F5.
    window.addEventListener('keydown', (e) => { if (handleDebugKey(e)) e.stopPropagation(); }, true);
    window.addEventListener('cs-debug-key', (ev) => {
        const d = (ev as CustomEvent<{ key: string; shiftKey?: boolean; event?: KeyboardEvent; handled?: boolean }>).detail;
        if (d && handleDebugKey(d.event ?? { key: d.key, shiftKey: d.shiftKey })) d.handled = true;
    });
}

/** Register a handler (while the screen is shown); returns its removal. */
export function registerDebugKeys(h: DebugKeyHandler): () => void {
    install();
    handlers.push(h);
    return () => { const i = handlers.lastIndexOf(h); if (i >= 0) handlers.splice(i, 1); };
}

/** Testing: the handlers registered now. */
export const debugKeyHandlers = (): number => handlers.length;

/** The command an action is where the run is paused: in the code, or before / after a feature step (null: none there). */
export type DebugCommand = 'next' | 'into' | 'continue' | 'resume' | 'stepOver' | 'stepInto' | 'stepOut';
export function commandFor(a: Exclude<DebugAction, 'stop'>, at: 'code' | 'step', stepKind?: string): DebugCommand | null {
    if (at === 'code') return ({ over: 'stepOver', into: 'stepInto', out: 'stepOut', continue: 'resume' } as const)[a];
    // Before a step: Step over runs it (pausing before the next), Step into pauses on the first line of its code.
    // After a failure: going on is the only way (Step over / Continue).
    if (a === 'over') return 'next';
    if (a === 'continue') return 'continue';
    if (a === 'into') return stepKind === 'before-step' ? 'into' : null;
    return null;
}
