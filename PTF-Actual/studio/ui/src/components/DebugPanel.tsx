/**
 * The Debug tab of the Code screen: the debug run going on (started here or under Run tests), where it is
 * paused (a step of a feature file, or a line of the project's code), its controls, the call stack, the
 * variables of the selected frame (objects expand), an expression to evaluate, and the breakpoints.
 */
import React from 'react';
import { Button, Empty, Input, Space, Tag, Tooltip, Tree, Typography } from 'antd';
import type { DataNode } from 'antd/es/tree';
import { BugOutlined, CaretRightOutlined, DeleteOutlined, PauseOutlined, StepForwardOutlined, StopOutlined, VerticalAlignBottomOutlined, VerticalAlignTopOutlined, ArrowRightOutlined } from '@ant-design/icons';
import { api, Breakpoint, DebugScope, DebugState, DebugVariable, followDebug, RunInfo } from '../api';
import { errText } from '../state';

/** Where the run is paused in a file of the repository (for the editor). */
export interface ExecLocation { file: string; line: number; key: string }

type Node = DataNode & { objectId?: string; path: string; value?: string };
/** Keys are the variable's path (scope/name/name…): the same variable keeps its key from one pause to the next,
 *  so what was expanded stays expanded; a value that changed since the last pause is marked. */
const varNode = (v: DebugVariable, path: string, before: Map<string, string>): Node => ({
    key: path, path, value: v.value, objectId: v.objectId, isLeaf: !v.objectId,
    title: <span className="dbg-var"><span className="dbg-name">{v.name}</span>: <span className={`dbg-val t-${v.type}${before.has(path) && before.get(path) !== v.value ? ' chg' : ''}`}>{v.value}</span></span>,
});
const scopeTree = (scopes: DebugScope[], before: Map<string, string>): Node[] =>
    scopes.map((sc) => ({ key: sc.name, path: sc.name, title: <b>{sc.name}</b>, children: sc.variables.map((v) => varNode(v, `${sc.name}/${v.name}`, before)) }));
/** Replace a node's children in a tree. */
const withChildren = (list: Node[], key: string, kids: Node[]): Node[] =>
    list.map((n) => (n.key === key ? { ...n, children: kids } : n.children ? { ...n, children: withChildren(n.children as Node[], key, kids) } : n));
const findNode = (list: Node[], key: string): Node | undefined => {
    for (const n of list) { if (n.key === key) return n; const c = n.children ? findNode(n.children as Node[], key) : undefined; if (c) return c; }
    return undefined;
};

/** A command runs: until the next pause comes, a "running" state is shown only after this long (no flash between lines). */
const HOLD_MS = 350;
/** Presses made while a step runs are kept (each press is one step, as in editors), up to this many. */
const MAX_QUEUED = 10;
type Action = 'over' | 'into' | 'out' | 'continue';
/** The command an action is at a code pause or a feature step pause. */
const commandFor = (a: Action, at: 'code' | 'step', stepKind?: string): Parameters<typeof api.debugRun>[1] | null =>
    at === 'code' ? ({ over: 'stepOver', into: 'stepInto', out: 'stepOut', continue: 'resume' } as const)[a]
        : a === 'over' ? 'next' : a === 'continue' ? 'continue' : a === 'into' && stepKind === 'before-step' ? 'into' : null;

export function DebugPanel({ breakpoints, onRemoveBreakpoint, onClearBreakpoints, onLocation, onStart, canStart }: {
    breakpoints: Breakpoint[];
    onRemoveBreakpoint: (b: Breakpoint) => void;
    onClearBreakpoints: () => void;
    /** Called with each new paused location (to open the file there and highlight the line), and null when it runs on. */
    onLocation: (loc: ExecLocation | null) => void;
    onStart: () => void;
    canStart: boolean;
}) {
    const [run, setRun] = React.useState<RunInfo | null>(null);
    const [dbg, setDbg] = React.useState<DebugState | null>(null);
    const [frame, setFrame] = React.useState(0);
    const [tree, setTree] = React.useState<Node[]>([]);
    const [expanded, setExpanded] = React.useState<React.Key[]>([]);
    const [expr, setExpr] = React.useState('');
    const [evals, setEvals] = React.useState<Array<{ expr: string; v: DebugVariable }>>([]);
    /** A command was sent and the run has not paused again yet: further presses wait (none get lost or doubled). */
    const [pending, setPending] = React.useState(false);
    const pendingRef = React.useRef(false);
    const lastKey = React.useRef('');
    const queued = React.useRef<Action[]>([]);
    const actRef = React.useRef<(a: Action) => void>(() => undefined);
    const values = React.useRef(new Map<string, string>());
    const expandedRef = React.useRef<React.Key[]>([]);
    expandedRef.current = expanded;

    // The debug run: looked for while there is none, then followed live (each pause pushed as it happens).
    React.useEffect(() => {
        let live = true;
        let following: string | null = null;
        let ctrl: AbortController | null = null;
        let hold: ReturnType<typeof setTimeout> | undefined;
        const setPend = (v: boolean) => { pendingRef.current = v; setPending(v); };
        const onState = (st: DebugState) => {
            if (!live) return;
            clearTimeout(hold);
            if (!st.paused && !st.codePaused && pendingRef.current) {
                // Running after a step: keep the current line shown a moment; the next pause usually comes first.
                hold = setTimeout(() => { if (live) { setPend(false); setDbg(st); } }, HOLD_MS);
                return;
            }
            if (st.paused || st.codePaused) setPend(false);
            setDbg(st);
            // The next press made while that step ran.
            if ((st.paused || st.codePaused) && queued.current.length) { const a = queued.current.shift()!; setTimeout(() => actRef.current(a), 0); }
        };
        const find = async () => {
            if (following || !live) return;
            // Looked for only while the Code screen is shown in a visible tab (no polling of the runs from other screens).
            if (typeof document !== 'undefined' && (document.hidden || !/^#\/?code(\/|$)/.test(window.location.hash))) return;
            try {
                const r = (await api.runs()).find((x) => x.state === 'running' && x.request.debug);
                if (!live || !r || following) { if (live && !r) setRun(null); return; }
                following = r.id; setRun(r); setDbg({ paused: r.paused ?? null, codePaused: r.codePaused ?? null });
                ctrl = new AbortController();
                await followDebug(r.id, onState, ctrl.signal).catch(() => undefined);
                if (!live) return;
                following = null; ctrl = null; clearTimeout(hold); setPend(false); queued.current = [];
                setRun(null); setDbg(null);
            } catch { /* tried again */ }
        };
        void find();
        const t = setInterval(() => void find(), 1000);
        return () => { live = false; clearInterval(t); clearTimeout(hold); ctrl?.abort(); };
    }, []);

    const code = dbg?.codePaused ?? null;
    const step = dbg?.paused ?? null;
    // Where it is paused, in a file of the repository: tell the editor once per pause.
    React.useEffect(() => {
        const f = code?.frames[frame];
        const loc = code && f && !f.external && f.file && f.line ? { file: f.file, line: f.line } : !code && step?.file && step.line ? { file: step.file, line: step.line } : null;
        const key = loc ? `${run?.id}:${loc.file}:${loc.line}:${code ? `${code.seq}:${frame}` : step?.step}` : '';
        if (key === lastKey.current) return;
        lastKey.current = key;
        onLocation(loc ? { ...loc, key } : null);
    }, [code, step, frame, run?.id, onLocation]);
    // A new pause: its top frame.
    React.useEffect(() => { setFrame(0); }, [code?.seq]);
    // The variables: the top frame's come with the pause; another frame's are asked for. Expanded objects are
    // read again, so they stay open from one line to the next.
    React.useEffect(() => {
        if (!run || !code) { setTree([]); return; }
        let live = true;
        const before = values.current;
        const show = async (scopes: DebugScope[]) => {
            let t = scopeTree(scopes, before);
            const keep = expandedRef.current.length ? expandedRef.current : scopes.length ? [scopes[0].name] : [];
            for (const k of [...keep].sort((a, b) => String(a).split('/').length - String(b).split('/').length)) {
                const n = findNode(t, String(k));
                if (!n?.objectId || n.children) continue;
                const r = await api.debugProperties(run.id, n.objectId).catch(() => null);
                if (!live) return;
                if (r) t = withChildren(t, n.key as string, r.variables.map((v) => varNode(v, `${n.path}/${v.name}`, before)));
            }
            if (!live) return;
            if (frame === 0) {
                const next = new Map<string, string>();
                const walk = (list: Node[]) => { for (const n of list) { if (n.value !== undefined) next.set(n.path, n.value); if (n.children) walk(n.children as Node[]); } };
                walk(t);
                values.current = next;
            }
            setTree(t);
            if (!expandedRef.current.length) setExpanded(keep);
        };
        if (frame === 0 && dbg?.scopes) void show(dbg.scopes);
        else api.debugScopes(run.id, frame).then((r) => show(r.scopes)).catch(() => undefined);
        return () => { live = false; };
    }, [run?.id, code?.seq, frame]); // eslint-disable-line react-hooks/exhaustive-deps

    const send = async (cmd: Parameters<typeof api.debugRun>[1]) => {
        if (!run || pendingRef.current) return;
        const stays = cmd === 'pause';
        if (!stays) { pendingRef.current = true; setPending(true); }
        try { await api.debugRun(run.id, cmd); } catch (e) {
            pendingRef.current = false; setPending(false); queued.current = [];
            setEvals((x) => [...x, { expr: cmd, v: { name: cmd, value: errText(e), type: 'error' } }]);
        }
    };
    /** Step over / into / out or continue where it is paused now; pressed while a step runs, it waits its turn
     *  (Continue drops the presses waiting: it runs on). */
    const act = (a: Action) => {
        if (pendingRef.current) { if (a === 'continue') queued.current = []; if (queued.current.length < MAX_QUEUED) queued.current.push(a); return; }
        const cmd = code ? commandFor(a, 'code') : step ? commandFor(a, 'step', step.kind) : null;
        if (cmd) void send(cmd);
    };
    actRef.current = act;
    const evaluate = async () => {
        if (!run || !expr.trim()) return;
        try { const v = await api.debugEvaluate(run.id, expr.trim(), frame); setEvals((x) => [...x.slice(-30), { expr: expr.trim(), v }]); } catch (e) { setEvals((x) => [...x, { expr, v: { name: expr, value: errText(e), type: 'error' } }]); }
    };
    // Keys as in editors: F5 continue, F10 step over, F11 step into, Shift+F11 step out. A key held down or
    // pressed again before the next pause is not sent (it would reach a run that is not paused yet).
    React.useEffect(() => {
        const h = (e: KeyboardEvent) => {
            if (!run || !['F5', 'F10', 'F11'].includes(e.key)) return;
            if (!code && !step && !pendingRef.current) return;
            e.preventDefault();
            act(e.key === 'F5' ? 'continue' : e.key === 'F10' ? 'over' : e.shiftKey ? 'out' : 'into');
        };
        window.addEventListener('keydown', h);
        return () => window.removeEventListener('keydown', h);
    }); // eslint-disable-line react-hooks/exhaustive-deps

    const loadChildren = async (node: Node) => {
        if (!run || !node.objectId || node.children) return;
        const r = await api.debugProperties(run.id, node.objectId);
        setTree((t) => withChildren(t, node.key as string, r.variables.map((v) => varNode(v, `${node.path}/${v.name}`, values.current))));
    };

    const bps = (
        <div className="dbg-section">
            <div className="dbg-head">Breakpoints <Typography.Text type="secondary" style={{ fontSize: 12 }}>(click a line number in the editor)</Typography.Text>
                {breakpoints.length > 0 && <Tooltip title="Remove all"><Button size="small" type="text" icon={<DeleteOutlined />} onClick={onClearBreakpoints} aria-label="Remove all breakpoints" /></Tooltip>}</div>
            {breakpoints.length === 0 ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>None.</Typography.Text>
                : breakpoints.map((b) => (
                    <div key={`${b.file}:${b.line}`} className="dbg-row">
                        <span className="ed-bp-inline" />
                        <a onClick={() => onLocation({ file: b.file, line: b.line, key: `bp:${b.file}:${b.line}:${Date.now()}` })} className="mono">{b.file.split('/').pop()}:{b.line}</a>
                        <Typography.Text type="secondary" style={{ fontSize: 11 }} ellipsis>{b.file}</Typography.Text>
                        <Button size="small" type="text" icon={<DeleteOutlined />} onClick={() => onRemoveBreakpoint(b)} aria-label="Remove the breakpoint" />
                    </div>
                ))}
        </div>
    );

    if (!run) {
        return (
            <div className="dbg">
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ margin: '8px 0' }} description={<span>No debug run. Add breakpoints by clicking line numbers, then debug the open feature.</span>}>
                    <Button type="primary" size="small" icon={<BugOutlined />} disabled={!canStart} onClick={onStart}>Debug this feature</Button>
                </Empty>
                {bps}
            </div>
        );
    }
    return (
        <div className="dbg">
            <div className="dbg-bar">
                {code ? <Tag color={code.reason === 'exception' ? 'error' : 'warning'} bordered={false}>{code.reason === 'exception' ? 'Paused on an error' : code.reason === 'breakpoint' ? 'Paused on a breakpoint' : 'Paused'}</Tag>
                    : step ? <Tag color={step.kind === 'after-failure' ? 'error' : 'processing'} bordered={false}>{step.kind === 'after-failure' ? 'Paused after a failure' : step.reason === 'breakpoint' ? 'Breakpoint before a step' : 'Paused before a step'}</Tag>
                        : <Tag bordered={false}>Running</Tag>}
                {pending && (code || step) && <Typography.Text type="secondary" style={{ fontSize: 12 }}>running…</Typography.Text>}
                {code ? <Space size={2}>
                    <Tooltip title="Continue (F5)"><Button size="small" icon={<CaretRightOutlined />} onClick={() => act('continue')} aria-label="Continue" /></Tooltip>
                    <Tooltip title="Step over (F10)"><Button size="small" icon={<StepForwardOutlined />} onClick={() => act('over')} aria-label="Step over" /></Tooltip>
                    <Tooltip title="Step into (F11)"><Button size="small" icon={<VerticalAlignBottomOutlined />} onClick={() => act('into')} aria-label="Step into" /></Tooltip>
                    <Tooltip title="Step out (Shift+F11)"><Button size="small" icon={<VerticalAlignTopOutlined />} onClick={() => act('out')} aria-label="Step out" /></Tooltip>
                </Space> : step ? <Space size={4}>
                    <Tooltip title={step.kind === 'after-failure' ? 'Go on' : 'Run this step and pause before the next (F10)'}><Button size="small" icon={<StepForwardOutlined />} onClick={() => act('over')}>{step.kind === 'after-failure' ? 'Go on' : 'Next step'}</Button></Tooltip>
                    {step.kind === 'before-step' && <Tooltip title="Run this step and pause on the first line of its code (F11)"><Button size="small" icon={<VerticalAlignBottomOutlined />} onClick={() => act('into')}>Step into</Button></Tooltip>}
                    <Tooltip title="Run to the next breakpoint (F5)"><Button size="small" icon={<CaretRightOutlined />} onClick={() => act('continue')}>Continue</Button></Tooltip>
                </Space> : <Tooltip title="Pause the code where it is"><Button size="small" icon={<PauseOutlined />} onClick={() => void send('pause')} aria-label="Pause" /></Tooltip>}
                <Tooltip title="Stop the run"><Button size="small" danger icon={<StopOutlined />} onClick={() => void api.stopRun(run.id)} aria-label="Stop" /></Tooltip>
                <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis>{run.request.project} / {run.request.env}</Typography.Text>
            </div>
            {step && !code && <div className="dbg-section">
                <div className="mono dbg-step">{step.step}</div>
                {step.scenario && <Typography.Text type="secondary" style={{ fontSize: 12 }}>Scenario: {step.scenario}</Typography.Text>}
                {step.error && <Typography.Text type="danger" style={{ display: 'block', fontSize: 12, whiteSpace: 'pre-wrap' }}>{step.error.split('\n')[0]}</Typography.Text>}
            </div>}
            {code && <div className="dbg-cols">
                <div className="dbg-section">
                    <div className="dbg-head">Call stack</div>
                    {code.exception && <Typography.Text type="danger" style={{ display: 'block', fontSize: 12 }}>{code.exception}</Typography.Text>}
                    {code.frames.slice(0, 40).map((f) => (
                        <div key={f.index} className={`dbg-frame${f.index === frame ? ' sel' : ''}${f.external ? ' ext' : ''}`} onClick={() => setFrame(f.index)}>
                            {f.index === frame && <ArrowRightOutlined style={{ fontSize: 10 }} />}
                            <span className="mono">{f.name}</span>
                            <Typography.Text type="secondary" className="mono" style={{ fontSize: 11 }} ellipsis>{f.file ? `${f.file}:${f.line}` : ''}</Typography.Text>
                        </div>
                    ))}
                </div>
                <div className="dbg-section">
                    <div className="dbg-head">Variables</div>
                    {tree.length ? <Tree<Node> treeData={tree} loadData={loadChildren} blockNode selectable={false} expandedKeys={expanded} onExpand={(k) => setExpanded(k)} />
                        : <Typography.Text type="secondary" style={{ fontSize: 12 }}>Loading…</Typography.Text>}
                </div>
            </div>}
            {code && <div className="dbg-section">
                <div className="dbg-head">Evaluate</div>
                {evals.map((e, i) => <div key={i} className="dbg-eval"><span className="mono">{e.expr}</span> = <span className={`dbg-val t-${e.v.type} mono`}>{e.v.value}</span></div>)}
                <Input size="small" className="mono" placeholder="An expression in the selected frame, e.g. this.lines.length (Enter)" value={expr} onChange={(e) => setExpr(e.target.value)} onPressEnter={() => void evaluate()} aria-label="Expression" />
            </div>}
            {bps}
        </div>
    );
}
