/**
 * Breakpoints in the project's TypeScript (step definitions, page objects, helpers) during a test run: a client
 * of the Node inspector (Chrome DevTools Protocol over a WebSocket), as editors use it.
 *
 *  - The run starts with --inspect-brk=127.0.0.1:0; its "Debugger listening on ws://…" line gives the address.
 *  - The framework loads project TypeScript with ts-node and inline source maps: a script's lines are mapped to the
 *    .ts file's lines with its source map (both ways: breakpoints in, paused positions out).
 *  - Breakpoints are set on each script as it is parsed (and again when they change); a line without code moves
 *    to the next line that has some, as editors do.
 *  - Stepping skips node_modules (blackboxed) and Node's own code: V8 does not blackbox Node's internal scripts, so
 *    a step that stops outside the project's code steps on by itself until it reaches it (as editors' "skip files").
 *  - A step that leaves the project's code (past the end of a step definition) asks the framework to pause before
 *    the next feature step and lets the run go on; "into the step" from a feature step pause breaks when the
 *    step's definition (a function the framework names) is called.
 */
import * as path from 'path';
import { EventEmitter } from 'events';

// ---- Source maps (version 3, VLQ mappings)

export interface Mapping { genLine: number; genCol: number; src: number; line: number; col: number }
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64I = new Map([...B64].map((c, i) => [c, i]));

/** The segments of a source map's "mappings" (0-based lines and columns). */
export function decodeMappings(mappings: string): Mapping[] {
    const out: Mapping[] = [];
    let src = 0, line = 0, col = 0;
    const lines = mappings.split(';');
    for (let g = 0; g < lines.length; g++) {
        let genCol = 0;
        for (const seg of lines[g].split(',')) {
            if (!seg) continue;
            const v: number[] = [];
            let shift = 0, value = 0;
            for (const ch of seg) {
                const d = B64I.get(ch);
                if (d === undefined) break;
                value += (d & 31) << shift;
                if (d & 32) { shift += 5; continue; }
                v.push(value & 1 ? -(value >>> 1) : value >>> 1);
                shift = 0; value = 0;
            }
            genCol += v[0] ?? 0;
            if (v.length >= 4) { src += v[1]; line += v[2]; col += v[3]; out.push({ genLine: g, genCol, src, line, col }); }
        }
    }
    return out;
}

export interface ScriptMap { sources: string[]; mappings: Mapping[] }
/** A data: URL source map (what ts-node writes inline). */
export function readInlineMap(url: string | undefined): ScriptMap | null {
    const m = /^data:application\/json[^,]*?(;base64)?,(.*)$/s.exec(url ?? '');
    if (!m) return null;
    try {
        const j = JSON.parse(m[1] ? Buffer.from(m[2], 'base64').toString('utf8') : decodeURIComponent(m[2])) as { sources?: string[]; mappings?: string };
        return { sources: j.sources ?? [], mappings: decodeMappings(j.mappings ?? '') };
    } catch { return null; }
}

/** Where code of an original (1-based) line starts in the script: the line itself, else the next one with code (up to 20 on). */
export function generatedFor(map: ScriptMap | null, line: number): { genLine: number; genCol: number; line: number } | null {
    if (!map) return { genLine: line - 1, genCol: 0, line };
    for (let l = line - 1; l < line + 19; l++) {
        let best: Mapping | null = null;
        for (const m of map.mappings) if (m.line === l && (!best || m.genLine < best.genLine || (m.genLine === best.genLine && m.genCol < best.genCol))) best = m;
        if (best) return { genLine: best.genLine, genCol: best.genCol, line: l + 1 };
    }
    return null;
}

/** The original (1-based) line of a position in the script. */
export function originalFor(map: ScriptMap | null, genLine: number, genCol: number): number {
    if (!map) return genLine + 1;
    let best: Mapping | null = null;
    for (const m of map.mappings) {
        if (m.genLine !== genLine) continue;
        if (m.genCol <= genCol && (!best || m.genCol > best.genCol)) best = m;
    }
    if (!best) for (const m of map.mappings) if (m.genLine === genLine && (!best || m.genCol < best.genCol)) best = m;
    return best ? best.line + 1 : genLine + 1;
}

// ---- The session

/** Steps taken by themselves through code outside the project before the run is let go on. */
const MAX_AUTO_STEPS = 20000;

export interface CodeFrame { index: number; name: string; file?: string; line?: number; external: boolean }
/** seq: numbers the pauses of a session (a new one on every stop, even on the same line). */
export interface CodePause { seq: number; reason: string; frames: CodeFrame[]; exception?: string }
export interface Variable { name: string; value: string; type: string; objectId?: string }
export interface Scope { name: string; variables: Variable[] }
interface PropertyPreview { name: string; type: string; value?: string; subtype?: string }
interface RemoteObject { type: string; subtype?: string; className?: string; value?: unknown; description?: string; objectId?: string; unserializableValue?: string;
    preview?: { overflow: boolean; properties: PropertyPreview[]; subtype?: string } }

/** A value as an editor shows it: "mug", 2, {sku: "mug", qty: 2, …}, Array(3) [1, 2, 3]. */
const preview = (o: RemoteObject): string => {
    if (o.type === 'undefined') return 'undefined';
    if (o.subtype === 'null') return 'null';
    if (o.type === 'string') return JSON.stringify(o.value);
    if (o.unserializableValue) return o.unserializableValue;
    if (o.value !== undefined && o.type !== 'object') return String(o.value);
    if (o.type === 'object' && o.preview && o.subtype !== 'error' && o.subtype !== 'date' && o.subtype !== 'regexp') {
        const p = o.preview;
        const one = (x: PropertyPreview) => (x.type === 'string' ? JSON.stringify(x.value ?? '') : x.type === 'object' ? (x.subtype === 'null' ? 'null' : x.value || 'Object') : x.value ?? x.type);
        const more = p.overflow ? ', …' : '';
        if (o.subtype === 'array') return `${o.description ?? 'Array'} [${p.properties.map(one).join(', ')}${more}]`.slice(0, 300);
        const name = o.className && o.className !== 'Object' ? `${o.className} ` : '';
        return `${name}{${p.properties.map((x) => `${x.name}: ${one(x)}`).join(', ')}${more}}`.slice(0, 300);
    }
    return (o.description ?? o.className ?? o.type).slice(0, 300);
};
const variable = (name: string, o: RemoteObject): Variable => ({ name, value: preview(o), type: o.subtype ?? o.type, ...(o.objectId && (o.type === 'object' || o.type === 'function') ? { objectId: o.objectId } : {}) });

export class InspectorSession extends EventEmitter {
    private ws: WebSocket;
    private seq = 0;
    private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    /** Project scripts: id → file (relative to the project) and source map. */
    private scripts = new Map<string, { file: string; map: ScriptMap | null }>();
    /** Every script's address (frames outside the project show where they are). */
    private urls = new Map<string, string>();
    /** Wanted breakpoints: "file:line" → set breakpoint ids. */
    private wanted = new Map<string, string[]>();
    /** Steps taken by themselves since the user's last step command (null: the user did not step). */
    private autoSteps: number | null = null;
    /** Stepping into the next project code from outside it (after breakInto), not from a project line. */
    private stepIn = false;
    /** The one-off breakpoint on the step definition's function (breakInto). */
    private intoBreakpoint: string | null = null;
    private pauseSeq = 0;
    private callFrames: Array<{ callFrameId: string; scopeChain: Array<{ type: string; object: RemoteObject }> }> = [];
    paused: CodePause | null = null;
    private ready: Promise<void>;

    constructor(url: string, private readonly root: string) {
        super();
        this.ws = new WebSocket(url);
        this.ready = new Promise((resolve, reject) => {
            this.ws.addEventListener('open', () => resolve());
            this.ws.addEventListener('error', () => reject(new Error('Could not connect to the test run\'s debugger.')));
        });
        this.ws.addEventListener('message', (ev) => this.onMessage(String((ev as MessageEvent).data)));
        this.ws.addEventListener('close', () => { for (const p of this.pending.values()) p.reject(new Error('The debugger connection closed.')); this.pending.clear(); this.paused = null; this.emit('closed'); });
    }

    private send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
        const id = ++this.seq;
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }

    /** Connect, set the breakpoints, and let the run start (it waits at its first line with --inspect-brk). */
    async start(breakpoints: Array<{ file: string; line: number }>, opts: { pauseOnExceptions?: 'none' | 'uncaught' } = {}): Promise<void> {
        await this.ready;
        for (const b of breakpoints) this.wanted.set(`${b.file}:${b.line}`, []);
        await this.send('Runtime.enable');
        await this.send('Debugger.enable');
        await this.send('Debugger.setBlackboxPatterns', { patterns: ['/node_modules/', '^node:', '^internal/'] }).catch(() => undefined);
        await this.send('Debugger.setPauseOnExceptions', { state: opts.pauseOnExceptions ?? 'none' });
        await this.send('Runtime.runIfWaitingForDebugger');
    }

    close(): void { try { this.ws.close(); } catch { /* closed */ } }

    private relFile(url: string): string | null {
        let p = url;
        if (p.startsWith('file://')) { try { p = new URL(p).pathname; if (process.platform === 'win32') p = p.replace(/^\/([A-Za-z]:)/, '$1'); } catch { return null; } }
        if (!path.isAbsolute(p)) return null;
        const rel = path.relative(this.root, p);
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.split(path.sep).includes('node_modules')) return null;
        return rel.split(path.sep).join('/');
    }

    private onMessage(raw: string): void {
        let msg: { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: any };
        try { msg = JSON.parse(raw); } catch { return; }
        if (msg.id !== undefined) {
            const p = this.pending.get(msg.id);
            if (!p) return;
            this.pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
            return;
        }
        if (msg.method === 'Debugger.scriptParsed') {
            if (msg.params.url) this.urls.set(msg.params.scriptId, msg.params.url);
            const file = this.relFile(msg.params.url);
            if (!file || !/\.(ts|js|mjs|cjs)$/.test(file)) return;
            this.scripts.set(msg.params.scriptId, { file, map: readInlineMap(msg.params.sourceMapURL) });
            for (const key of this.wanted.keys()) if (key.startsWith(`${file}:`)) void this.place(key, msg.params.scriptId);
        } else if (msg.method === 'Debugger.paused') {
            if (msg.params.reason === 'Break on start') { void this.send('Debugger.resume').catch(() => undefined); return; }
            const frames: any[] = msg.params.callFrames;
            if (this.intoBreakpoint && msg.params.hitBreakpoints?.includes(this.intoBreakpoint)) {
                // Into the step: a step, not a breakpoint of the user's; a wrapper of the framework's is stepped through.
                const into = this.intoBreakpoint;
                this.intoBreakpoint = null;
                void this.send('Debugger.removeBreakpoint', { breakpointId: into }).catch(() => undefined);
                if (!this.scripts.has(frames[0]?.location.scriptId)) { this.autoSteps = 0; this.stepIn = true; this.autoStep(frames); return; }
                msg.params.hitBreakpoints = msg.params.hitBreakpoints.filter((b: string) => b !== into);
            }
            const hit = !!msg.params.hitBreakpoints?.length, exception = msg.params.reason === 'exception' || msg.params.reason === 'promiseRejection';
            if (this.autoSteps !== null && !hit && !exception && !this.scripts.has(frames[0]?.location.scriptId)) {
                this.autoStep(frames);
                return;
            }
            this.autoSteps = null; this.stepIn = false;
            this.callFrames = msg.params.callFrames;
            this.paused = {
                seq: ++this.pauseSeq,
                reason: exception ? 'exception' : hit ? 'breakpoint' : 'step',
                frames: msg.params.callFrames.map((f: any, index: number) => {
                    const s = this.scripts.get(f.location.scriptId);
                    const url = this.urls.get(f.location.scriptId) ?? f.url ?? '';
                    const short = String(url).replace(/^file:\/\//, '').replace(/^.*\/node_modules\//, '').split(/[\\/]/).slice(-3).join('/');
                    return { index, name: f.functionName || '(anonymous)', ...(s ? { file: s.file, line: originalFor(s.map, f.location.lineNumber, f.location.columnNumber ?? 0) } : { ...(short ? { file: short } : {}), line: f.location.lineNumber + 1 }), external: !s };
                }),
                ...(msg.params.data && (msg.params.reason === 'exception' || msg.params.reason === 'promiseRejection') ? { exception: preview(msg.params.data) } : {}),
            };
            this.emit('paused', this.paused);
        } else if (msg.method === 'Debugger.resumed') {
            const wasPaused = this.paused !== null;
            this.paused = null; this.callFrames = [];
            // Steps taken by themselves through code outside the project resume many times: say it once.
            if (wasPaused) this.emit('resumed');
        }
    }

    /** A step stopped outside the project's code: go on to the project's next line (or the framework's next step). */
    private autoStep(frames: Array<{ callFrameId: string; location: { scriptId: string } }>): void {
        const n = ++this.autoSteps!;
        const inProject = frames.some((f) => this.scripts.has(f.location.scriptId));
        if (n > MAX_AUTO_STEPS) { this.autoSteps = null; this.stepIn = false; void this.send('Debugger.resume').catch(() => undefined); return; }
        // Called from the project's code (a require, a library call): back out to it.
        if (inProject) { void this.send('Debugger.stepOut').catch(() => undefined); return; }
        if (this.stepIn) { void this.send('Debugger.stepInto').catch(() => undefined); return; }
        // The step definition returned: pause before the next feature step, and let the run go on until then.
        this.autoSteps = null;
        // In the global scope: Node's own code has no Symbol, globalThis… in scope.
        void this.send('Runtime.evaluate', { expression: "globalThis[Symbol.for('cs-test.debug')]?.pauseBeforeNextStep()", silent: true })
            .catch(() => undefined)
            .then(() => this.send('Debugger.resume'))
            .catch(() => undefined);
    }

    /** Break when the step definition of the step the framework is paused before is called (false: none found). */
    async breakInto(): Promise<boolean> {
        const r = await this.send<{ result: RemoteObject }>('Runtime.evaluate', { expression: "globalThis[Symbol.for('cs-test.debug')]?.stepFunction()", silent: true }).catch(() => null);
        if (!r || r.result.type !== 'function' || !r.result.objectId) return false;
        if (this.intoBreakpoint) await this.send('Debugger.removeBreakpoint', { breakpointId: this.intoBreakpoint }).catch(() => undefined);
        const b = await this.send<{ breakpointId: string }>('Debugger.setBreakpointOnFunctionCall', { objectId: r.result.objectId }).catch(() => null);
        this.intoBreakpoint = b?.breakpointId ?? null;
        return !!this.intoBreakpoint;
    }

    /** Set one wanted breakpoint in one script. */
    private async place(key: string, scriptId: string): Promise<void> {
        const s = this.scripts.get(scriptId);
        const line = Number(key.slice(key.lastIndexOf(':') + 1));
        if (!s) return;
        const at = generatedFor(s.map, line);
        if (!at) return;
        try {
            const r = await this.send<{ breakpointId: string; actualLocation: { lineNumber: number; columnNumber: number } }>('Debugger.setBreakpoint', { location: { scriptId, lineNumber: at.genLine, columnNumber: at.genCol } });
            this.wanted.get(key)?.push(r.breakpointId);
            this.emit('breakpoint', { file: s.file, line, actual: originalFor(s.map, r.actualLocation.lineNumber, r.actualLocation.columnNumber) });
        } catch { /* not a place for a breakpoint */ }
    }

    /** Replace the code breakpoints (while the run goes on). */
    async setBreakpoints(list: Array<{ file: string; line: number }>): Promise<void> {
        const next = new Set(list.map((b) => `${b.file}:${b.line}`));
        for (const [key, ids] of [...this.wanted]) {
            if (next.has(key)) continue;
            for (const id of ids) await this.send('Debugger.removeBreakpoint', { breakpointId: id }).catch(() => undefined);
            this.wanted.delete(key);
        }
        for (const key of next) {
            if (this.wanted.has(key)) continue;
            this.wanted.set(key, []);
            const file = key.slice(0, key.lastIndexOf(':'));
            for (const [id, s] of this.scripts) if (s.file === file) await this.place(key, id);
        }
    }

    async command(c: 'resume' | 'stepOver' | 'stepInto' | 'stepOut' | 'pause'): Promise<void> {
        this.autoSteps = c === 'stepOver' || c === 'stepInto' || c === 'stepOut' ? 0 : null;
        this.stepIn = false;
        // Continue runs on to the next breakpoint: the framework no longer pauses before the next step for "Next step".
        if (c === 'resume' && this.paused) await this.send('Runtime.evaluate', { expression: "globalThis[Symbol.for('cs-test.debug')]?.runToBreakpoint()", silent: true }).catch(() => undefined);
        await this.send(`Debugger.${c}`);
    }

    /** The variables of a frame's scopes (local, closure, block…; not the global one). */
    async scopes(frame: number): Promise<Scope[]> {
        const f = this.callFrames[frame];
        if (!f) throw new Error('That frame is not there any more.');
        const out: Scope[] = [];
        for (const sc of f.scopeChain) {
            if (sc.type === 'global' || !sc.object.objectId) continue;
            const vars = await this.properties(sc.object.objectId);
            out.push({ name: sc.type === 'local' ? 'Local' : sc.type === 'closure' ? 'Closure' : sc.type === 'block' ? 'Block' : sc.type === 'catch' ? 'Catch' : sc.type === 'module' ? 'Module' : sc.type, variables: vars });
        }
        return out;
    }

    /** The properties of an object (to expand a variable). */
    async properties(objectId: string): Promise<Variable[]> {
        const r = await this.send<{ result: Array<{ name: string; value?: RemoteObject; get?: RemoteObject }> }>('Runtime.getProperties', { objectId, ownProperties: true, generatePreview: true });
        return r.result.filter((p) => p.value).slice(0, 300).map((p) => variable(p.name, p.value!));
    }

    /** Evaluate an expression in a frame (or globally when not paused). */
    async evaluate(expression: string, frame = 0): Promise<Variable> {
        const f = this.callFrames[frame];
        const r = f
            ? await this.send<{ result: RemoteObject; exceptionDetails?: { exception?: RemoteObject; text: string } }>('Debugger.evaluateOnCallFrame', { callFrameId: f.callFrameId, expression, generatePreview: true, timeout: 5000 })
            : await this.send<{ result: RemoteObject; exceptionDetails?: { exception?: RemoteObject; text: string } }>('Runtime.evaluate', { expression, generatePreview: true, timeout: 5000 });
        if (r.exceptionDetails) return { name: expression, value: preview(r.exceptionDetails.exception ?? { type: 'string', value: r.exceptionDetails.text }), type: 'error' };
        return variable(expression, r.result);
    }
}

/** The inspector address in the run's output ("Debugger listening on ws://127.0.0.1:9229/…"). */
export const inspectorUrl = (line: string): string | null => /Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[\w-]+)/.exec(line)?.[1] ?? null;
