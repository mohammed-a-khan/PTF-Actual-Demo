/**
 * Run tests: pick project, environment and what to run; watch the output live; see results per
 * scenario with errors; open the framework's HTML report; rerun failed scenarios.
 * Secrets for the chosen environment are given to the run automatically (never shown).
 */
import React from 'react';
import { Alert, App, Button, Card, Checkbox, Col, Empty, Form, Input, InputNumber, List, Modal, Popconfirm, Row, Select, Space, Spin, Switch, Tabs, Tag, Tooltip, Typography } from 'antd';
import { SearchOutlined, BugOutlined, StepForwardOutlined, WarningOutlined, CaretRightOutlined, CommentOutlined, FileTextOutlined, LoadingOutlined, LockOutlined, DeleteOutlined, CloudUploadOutlined, ReloadOutlined, StopOutlined } from '@ant-design/icons';
import { api, BisectInfo, followRun, LogLine, RunCatalog, RunConfigDef, RunEvidence, RunInfo, RunRequest, ScenarioResult } from '../api';
import { errText, loadRunTarget, openInEditor, saveRunTarget, unsavedFiles, useStudio } from '../state';
import { RunEvidenceList } from '../components/Evidence';
import { fmtDur, RunTree } from '../components/RunTree';
import { EMPTY_PICK, Picked, pickOf, requestOf, RunPicker, scopeOf, selectedScenarios } from '../components/RunPicker';
import { levels, progressOf, RunLog } from '../components/RunLog';
import { stripAnsi } from '../components/Ansi';
import { Split } from '../components/Split';
import { PrPostResults } from '../components/PrPostResults';
import { MakePipeline } from '../components/MakePipeline';
import { StepTimeline, parseTimeline } from '../components/StepTimeline';
import { PublishToAdo } from '../components/PublishToAdo';
import { BisectPanel, BisectStart } from '../components/Bisect';
import { navigate, useRoute } from '../route';
import { askChangedElsewhere, isChangedElsewhere } from '../components/ChangedElsewhere';
import { StrictWholeNumber } from '../components/StrictWholeNumber';
import '../styles-tests.css';

const STATE_TAG: Record<RunInfo['state'], { color: string; label: string }> = {
    running: { color: 'processing', label: 'Running' }, passed: { color: 'success', label: 'Passed' }, failed: { color: 'error', label: 'Failed' },
    stopped: { color: 'default', label: 'Stopped' }, error: { color: 'warning', label: 'Could not run' },
};
const fmtMs = (ms: number) => fmtDur(ms);

/**
 * Run only the failed scenarios. The framework selects --scenarios by name in every feature it
 * loads, so the run is limited to the files those scenarios are in (from the report), else to the
 * features of the original run: same-named scenarios elsewhere must not run too.
 */
export function rerunFailed(run: RunInfo, ev: RunEvidence | null): RunRequest {
    const failed = (run.summary?.scenarios ?? []).filter((x) => x.status === 'failed' || x.status === 'broken');
    const files = [...new Set(failed.map((f) => ev?.scenarios.find((e) => e.name === f.name && e.feature === f.feature)?.location?.file).filter((x): x is string => !!x))];
    const all = files.length > 0 && failed.every((f) => ev?.scenarios.some((e) => e.name === f.name && e.feature === f.feature && e.location));
    return {
        ...run.request, tags: undefined, scenario: undefined,
        features: all ? files : run.request.features,
        scenarios: [...new Set(failed.map((x) => x.name))],
    };
}

/** Common Playwright device names (any other Playwright name can be typed in). */
const DEVICES = ['iPhone 15', 'iPhone 15 Pro Max', 'iPhone SE', 'iPad (gen 7)', 'iPad Pro 11', 'Pixel 7', 'Galaxy S9+', 'Galaxy Tab S4', 'Desktop Chrome', 'Desktop Edge', 'Desktop Firefox', 'Desktop Safari'];

export function Runs() {
    const { message, modal } = App.useApp();
    const { env: disc } = useStudio();
    const projects = disc?.projects ?? [];
    const saved = loadRunTarget();
    const [target, setTarget] = React.useState({ project: saved?.project ?? '', env: saved?.env ?? '', browser: saved?.browser ?? 'chromium', headless: saved?.headless ?? true, workers: saved?.workers ?? 1,
        retries: saved?.retries ?? 0, device: saved?.device ?? '', width: saved?.width, height: saved?.height, vars: saved?.vars ?? '', ado: saved?.ado as 'on' | 'off' | undefined });
    const [configs, setConfigs] = React.useState<RunConfigDef[]>([]);
    // The version read: saving over a newer file (another tab, a teammate's pull) is refused, and the screen offers to reload.
    const configsVersion = React.useRef<string | undefined>(undefined);
    // The list as last read (the Save dialog's closure would otherwise keep the list from when it was opened).
    const configsRef = React.useRef<RunConfigDef[]>([]);
    configsRef.current = configs;
    const loadConfigs = React.useCallback(() => { api.runConfigs().then((r) => { setConfigs(r.configs); configsVersion.current = r.version; }).catch(() => undefined); }, []);
    React.useEffect(loadConfigs, [loadConfigs]);
    // Saved in another tab (or pulled): the list follows when this tab is shown again, so it is not stale.
    React.useEffect(() => {
        const onShown = () => { if (document.visibilityState === 'visible') loadConfigs(); };
        window.addEventListener('focus', onShown);
        document.addEventListener('visibilitychange', onShown);
        return () => { window.removeEventListener('focus', onShown); document.removeEventListener('visibilitychange', onShown); };
    }, [loadConfigs]);
    /**
     * Save the whole list; a refusal because it changed elsewhere asks Reload / Overwrite / Keep editing.
     * Resolves true when saved, 'reloaded' when the person chose Reload (their change is dropped), false otherwise.
     */
    const writeConfigs = (next: RunConfigDef[], ok: string, force = false): Promise<boolean | 'reloaded'> => api.saveRunConfigs(next, configsVersion.current, force)
        .then((r) => { setConfigs(r.configs); configsVersion.current = r.version; message.success(ok); return true; })
        .catch((e) => {
            if (!isChangedElsewhere(e)) { message.error(errText(e)); return false; }
            return new Promise<boolean | 'reloaded'>((resolve) => askChangedElsewhere(modal, e, 'The saved runs', {
                reload: () => { loadConfigs(); resolve('reloaded'); },
                overwrite: async () => resolve(await writeConfigs(next, ok, true)),
                keepEditing: () => resolve(false),
            }));
        });
    const [pick, setPick] = React.useState<Picked>(EMPTY_PICK);
    const [catalog, setCatalog] = React.useState<RunCatalog | null>(null);
    const loadCatalog = React.useCallback(() => api.runCatalog().then(setCatalog).catch(() => undefined), []);
    // The Run button was pressed and the server has not answered yet.
    const [starting, setStarting] = React.useState(false);
    // A pull request run: post its results to the pull request.
    const [posting, setPosting] = React.useState<string | null>(null);
    const [fw, setFw] = React.useState<{ installed: boolean; version?: string; message?: string; severalScenarios?: boolean } | null>(null);
    const [runs, setRuns] = React.useState<RunInfo[]>([]);
    const [sel, setSel] = React.useState<string | null>(null);
    const [bisect, setBisect] = React.useState<BisectInfo | null>(null);
    const [bisectOpen, setBisectOpen] = React.useState(false);
    const [publishOpen, setPublishOpen] = React.useState(false);
    const [pipelineOpen, setPipelineOpen] = React.useState(false);
    const [outView, setOutViewRaw] = React.useState<'steps' | 'output'>(() => { try { return localStorage.getItem('cs-studio-run-view') === 'output' ? 'output' : 'steps'; } catch { return 'steps'; } });
    const setOutView = (v: 'steps' | 'output') => { setOutViewRaw(v); try { localStorage.setItem('cs-studio-run-view', v); } catch { /* ignore */ } };
    React.useEffect(() => { void api.bisect().then((r) => setBisect(r.bisect)).catch(() => undefined); }, []);
    const [log, setLog] = React.useState<LogLine[]>([]);
    const [now, setNow] = React.useState(Date.now());
    const follow = React.useRef<AbortController | null>(null);

    const loadRuns = React.useCallback(async () => {
        try { setRuns(await api.runs()); } catch (e) { message.error(errText(e)); }
        api.untrackedRunOutput().then((r) => setOutputDirs(r.paths)).catch(() => undefined);
    }, [message]);
    // Report folders and .flaky-test-data the framework writes into the project.
    const [outputDirs, setOutputDirs] = React.useState<string[]>([]);
    const { refresh } = useStudio();
    React.useEffect(() => { void loadRuns(); api.framework().then(setFw).catch(() => undefined); void loadCatalog(); }, [loadRuns, loadCatalog]);
    // Runs started or finished in another tab (or by a teammate's agent): the list follows when this tab is shown
    // again, every few seconds while a run is in progress and now and then otherwise, so Run is disabled (and enabled
    // again) before a click.
    const pollRuns = React.useCallback(() => { api.runs().then(setRuns).catch(() => undefined); }, []);
    React.useEffect(() => {
        const onShown = () => { if (document.visibilityState === 'visible') pollRuns(); };
        window.addEventListener('focus', onShown);
        document.addEventListener('visibilitychange', onShown);
        return () => { window.removeEventListener('focus', onShown); document.removeEventListener('visibilitychange', onShown); };
    }, [pollRuns]);
    const anyRunning = runs.some((r) => r.state === 'running');
    React.useEffect(() => {
        const t = setInterval(() => { if (document.visibilityState === 'visible') pollRuns(); }, anyRunning ? 3000 : 15000);
        return () => clearInterval(t);
    }, [anyRunning, pollRuns]);
    React.useEffect(() => { if (!target.project && projects.length) setTarget((t) => ({ ...t, project: projects[0] })); }, [projects, target.project]);
    const envs = target.project ? (disc?.environments[target.project] ?? []) : [];
    React.useEffect(() => { if (target.project && envs.length && !envs.includes(target.env)) setTarget((t) => ({ ...t, env: envs[0] })); }, [target.project, envs.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
    React.useEffect(() => { if (target.project && target.env) saveRunTarget(target); }, [target]);

    const current = runs.find((r) => r.id === sel) ?? null;
    // Failure evidence of the selected (finished) run, read from its report.
    const [evidence, setEvidence] = React.useState<{ id: string; ev: RunEvidence } | null>(null);
    const evKey = current && current.state !== 'running' && current.summary ? `${current.id}|${current.endedAt}` : '';
    React.useEffect(() => {
        if (!evKey || !current) return;
        let cancelled = false;
        api.runEvidence(current.id).then((ev) => { if (!cancelled) setEvidence({ id: current.id, ev }); }).catch(() => { if (!cancelled) setEvidence(null); });
        return () => { cancelled = true; };
    }, [evKey]); // eslint-disable-line react-hooks/exhaustive-deps
    const ev = evidence && current && evidence.id === current.id ? evidence.ev : null;
    // Run-wide files that are not shown with a scenario (console logs, HAR, session videos).
    const runFiles = React.useMemo(() => {
        if (!ev) return [];
        const shown = new Set(ev.scenarios.flatMap((x) => [...x.files.map((f) => f.file), ...(x.failedStep?.screenshot ? [x.failedStep.screenshot.file] : [])]));
        return ev.run.filter((f) => !shown.has(f.file) && f.kind !== 'screenshot');
    }, [ev]);
    React.useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

    // Show a run: load its output, and follow it live while it runs.
    const open = React.useCallback(async (id: string) => {
        follow.current?.abort();
        setSel(id); setLog([]);
        const ctrl = new AbortController(); follow.current = ctrl;
        const lines: LogLine[] = [];
        let pending = false;
        const flush = () => { pending = false; setLog([...lines]); };
        try {
            await followRun(id, 0, (l) => { lines.push(l); if (!pending) { pending = true; requestAnimationFrame(flush); } },
                (r) => { setRuns((rs) => rs.some((x) => x.id === r.id) ? rs.map((x) => x.id === r.id ? r : x) : [r, ...rs]); }, ctrl.signal);
            flush();
        } catch (e) {
            if (ctrl.signal.aborted) return;
            // A wrong run in the address is replaced (by the latest run): forget it first, or the list would select it again.
            if ((e as { status?: number }).status === 404) { message.warning('That run is not in this Studio (it was removed, or it belongs to another repository).'); setSel((s) => (s === id ? null : s)); setLog([]); navigate(['runs'], true); }
            else message.error(errText(e));
        }
    }, [message]);
    React.useEffect(() => () => follow.current?.abort(), []);

    // The shown run comes from the address (#/runs/<id>), so Back/Forward move between runs.
    const route = useRoute();
    const onPage = route[0] === 'runs';
    const routeId = onPage ? route[1] : undefined;
    React.useEffect(() => { if (routeId && routeId !== sel) void open(routeId); }, [routeId]); // eslint-disable-line react-hooks/exhaustive-deps
    // A run started elsewhere (a pull request, the editor): not in the list yet, so read it again.
    React.useEffect(() => { if (routeId && !runs.some((r) => r.id === routeId)) void loadRuns(); }, [routeId]); // eslint-disable-line react-hooks/exhaustive-deps
    React.useEffect(() => { if (onPage && !routeId && runs.length) navigate(['runs', sel ?? runs[0].id], true); }, [onPage, routeId, runs.length]); // eslint-disable-line react-hooks/exhaustive-deps
    // Runs started elsewhere (editor ▶ buttons): the list needs them (the shell navigates here).
    React.useEffect(() => {
        // The form shows what that run runs (pressing Run again runs the same, not the form's older choice).
        const h = (e: Event) => {
            void loadRuns();
            const id = (e as CustomEvent<{ id: string }>).detail?.id;
            if (id) void api.run(id).then((r) => { if (r?.request && !r.request.debug) { setTarget((t) => ({ ...t, project: r.request.project, env: r.request.env })); setPick(pickOf(r.request, catalog)); } }).catch(() => undefined);
        };
        window.addEventListener('cs-show-run', h);
        return () => window.removeEventListener('cs-show-run', h);
    }, [loadRuns, catalog]);
    // Feature files may have changed while the user was on another screen.
    React.useEffect(() => { if (onPage) void loadCatalog(); }, [onPage, loadCatalog]);

    // Options typed wrong (2.5 workers, a width of 0): shown under the field, and Run / Save wait until they are put right.
    const [badOpts, setBadOpts] = React.useState<string[]>([]);
    const validity = React.useCallback((field: string) => (ok: boolean) => setBadOpts((b) => (ok ? b.filter((x) => x !== field) : b.includes(field) ? b : [...b, field])), []);
    const start = async (r: RunRequest) => {
        if (badOpts.length) { message.error(`Put the options right first: ${badOpts.join(', ')}.`); setSetupTab('options'); return; }
        // The framework runs the files on disk: unsaved edits in the editor would not be tested.
        const unsaved = [...unsavedFiles].filter((f) => /\.(feature|ts|js|env|json|ya?ml)$/.test(f));
        if (unsaved.length) {
            const go = await new Promise<boolean>((resolve) => modal.confirm({
                title: `${unsaved.length} file${unsaved.length === 1 ? ' has' : 's have'} unsaved changes in the editor`,
                content: <>The run uses the saved versions of: <ul style={{ margin: '6px 0 0 16px', padding: 0 }}>{unsaved.slice(0, 8).map((f) => <li key={f}><Typography.Text code>{f}</Typography.Text></li>)}</ul>Save them in the editor first to test your latest changes.</>,
                okText: 'Run anyway', cancelText: 'Cancel', onOk: () => resolve(true), onCancel: () => resolve(false),
            }));
            if (!go) return;
        }
        setStarting(true);
        try {
            const run = await api.startRun(r);
            setRuns((rs) => [run, ...rs]);
            navigate(['runs', run.id]);
        } catch (e) { message.error(errText(e)); }
        finally { setStarting(false); }
    };
    /** Rerun the failed scenarios of a pull request's run, in its local copy (never the working copy). */
    const rerunPr = async (r: RunInfo) => {
        if (!r.pr) return;
        setStarting(true);
        try {
            const req = rerunFailed(r, ev);
            const run = await api.prRun(r.pr.repository, r.pr.id, { ...req, title: r.pr.title });
            setRuns((rs) => [run, ...rs]);
            navigate(['runs', run.id]);
        } catch (e) { modal.error({ title: 'Could not rerun', content: errText(e) }); }
        finally { setStarting(false); }
    };
    const variables = (): Record<string, string> | undefined => {
        const out: Record<string, string> = {};
        for (const line of target.vars.split(/\r?\n/)) { const m = /^\s*([A-Za-z][\w]*)\s*=\s*(.*)$/.exec(line); if (m) out[m[1].toUpperCase()] = m[2].trim(); }
        return Object.keys(out).length ? out : undefined;
    };
    const request = (): RunRequest => ({
        project: target.project, env: target.env, browser: target.browser, headless: target.headless, workers: target.workers,
        retries: Math.max(0, Math.round(target.retries ?? 0)), ...(target.device ? { device: target.device } : {}),
        ...(target.width && target.height ? { viewport: { width: target.width, height: target.height } } : {}),
        ...(variables() ? { variables: variables() } : {}),
        ...(target.ado ? { ado: target.ado === 'on' } : {}),
        ...requestOf(pick, catalog, target.project),
    });
    const [saveTip, setSaveTip] = React.useState(false);
    const saveConfig = () => {
        if (badOpts.length) { message.error(`Put the options right first: ${badOpts.join(', ')}.`); setSetupTab('options'); return; }
        let name = '', saving = false;
        let nameInput: { focus: () => void } | null = null;
        const inst = modal.confirm({ title: 'Save this run for the team', icon: null, okText: 'Save', autoFocusButton: null,
            content: <Space direction="vertical" style={{ width: '100%' }}><Typography.Text type="secondary">Saved in .cs-studio/run-configurations.json in the repository: commit it to share it.</Typography.Text><Input autoFocus ref={(el) => { const first = !nameInput; if (el) nameInput = el; if (el && first) setTimeout(() => el.focus(), 60); }} placeholder="Name, e.g. Smoke on QA (mobile)" maxLength={120} showCount onChange={(e) => { name = e.target.value; }} aria-label="Run configuration name"
                onPressEnter={(e) => (e.currentTarget.closest('.ant-modal-content')?.querySelector('.ant-modal-confirm-btns .ant-btn-primary') as HTMLButtonElement | null)?.click()} /></Space>,
            // The dialog closes itself only when saved (a missing name or a declined replace keeps it open, without errors).
            onOk: (close: () => void) => { void (async () => {
                if (!name.trim()) { message.warning({ content: 'Give it a name.', key: 'save-run-name' }); return; }
                const configs = configsRef.current;
                if (configs.some((c) => c.name.toLowerCase() === name.trim().toLowerCase())
                    && !(await new Promise<boolean>((ok) => modal.confirm({ title: `A saved run named "${name.trim()}" exists`, content: 'Replace it with this run?', okText: 'Replace', onOk: () => ok(true), onCancel: () => ok(false),
                        // Focus goes back into the Save dialog under it, so Esc then closes that one too.
                        focusTriggerAfterClose: false, afterClose: () => { if (!saving) nameInput?.focus(); } })))) return;
                const next = [...configs.filter((c) => c.name.toLowerCase() !== name.trim().toLowerCase()), { name: name.trim(), request: request() }];
                if (saving) return; // a double click saves once
                saving = true; inst.update({ okButtonProps: { loading: true } });
                try { if (await writeConfigs(next, `Saved "${name.trim()}"`)) close(); } // saved, or Reload chosen (Keep editing stays here)
                finally { saving = false; inst.update({ okButtonProps: { loading: false } }); }
            })(); } });
    };
    const useConfig = (c: RunConfigDef) => {
        const r = c.request;
        setTarget({ project: r.project, env: r.env, browser: r.browser ?? 'chromium', headless: r.headless ?? true, workers: r.workers ?? 1, retries: r.retries ?? 0, device: r.device ?? '',
            width: r.viewport?.width, height: r.viewport?.height, vars: Object.entries(r.variables ?? {}).map(([k, v]) => `${k}=${v}`).join('\n'),
            ado: r.ado === undefined ? undefined : r.ado ? 'on' : 'off' });
        // What to run, too (features, tags, scenarios), so Run runs what was saved.
        setPick(pickOf(r, catalog));
        message.info(`"${c.name}" is filled in: press Run to start it.`);
    };
    const runConfig = async (c: RunConfigDef) => {
        setStarting(true);
        try { const run = await api.startRun(c.request); setRuns((rs) => [run, ...rs]); navigate(['runs', run.id]); }
        catch (e) { modal.error({ title: `Could not start "${c.name}"`, content: errText(e) }); }
        finally { setStarting(false); }
    };
    const removeConfig = async (c: RunConfigDef) => { await writeConfigs(configs.filter((x) => x !== c), `Deleted "${c.name}"`); };
    // The form's concerns, one per tab (remembered on this computer).
    type SetupTab = 'what' | 'options' | 'saved';
    const [setupTab, setSetupTabRaw] = React.useState<SetupTab>(() => { try { const v = localStorage.getItem('cs-studio-runs-setup-tab'); return (v === 'options' || v === 'saved' ? v : 'what'); } catch { return 'what'; } });
    const setSetupTab = (v: SetupTab) => { setSetupTabRaw(v); try { localStorage.setItem('cs-studio-runs-setup-tab', v); } catch { /* ignore */ } if (v === 'saved') loadConfigs(); };
    const optSummary = `${target.browser}${target.device ? ` · ${target.device}` : ''} · ${target.workers} worker${target.workers === 1 ? '' : 's'}${target.retries ? ` · ${target.retries} retr${target.retries === 1 ? 'y' : 'ies'}` : ''} · ${target.headless ? 'browser hidden' : 'browser shown'}${target.width && target.height ? ` · ${target.width}×${target.height}` : ''}${variables() ? ` · ${Object.keys(variables()!).length} value(s)` : ''}${target.ado ? ` · Azure DevOps ${target.ado === 'on' ? 'on' : 'off'}` : ''}`;
    // Lines of "Values for this run" that are not KEY=value (they are left out of the run).
    const badVars = target.vars.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^[A-Za-z][\w]*\s*=/.test(l));
    const scope = scopeOf(pick, catalog, target.project);
    const nothing = !!catalog && selectedScenarios(pick, scope.features).length === 0;
    // Several chosen scenarios need a framework that reads --scenarios (1.55+): said before Run, not after.
    const tooMany = fw?.severalScenarios === false && new Set(pick.scenarios.map((k) => { const [path, i] = k.split('#'); return catalog?.features.find((f) => f.path === path)?.scenarios[Number(i)]?.name; })).size > 1;
    const running = runs.some((r) => r.state === 'running');
    // A debug run's pauses: its state is read every second while it runs (not its output again).
    const debugging = current?.state === 'running' && !!current.request.debug ? current.id : null;
    React.useEffect(() => {
        if (!debugging) return;
        let live = true;
        const tick = async () => {
            try { const r = await api.run(debugging, Number.MAX_SAFE_INTEGER); if (live) setRuns((rs) => rs.map((x) => (x.id === r.id ? { ...x, paused: r.paused ?? null } : x))); } catch { /* next tick */ }
        };
        void tick();
        const t = setInterval(tick, 800);
        return () => { live = false; clearInterval(t); };
    }, [debugging]);
    const [debugOpen, setDebugOpen] = React.useState(false);
    const [debugOpts, setDebugOpts] = React.useState({ steps: true, pauseOnFailure: true, slowMo: 0 });
    const debugCmd = async (id: string, cmd: 'next' | 'continue' | 'stop') => {
        setRuns((rs) => rs.map((x) => (x.id === id ? { ...x, paused: null } : x)));
        try { await api.debugRun(id, cmd); } catch (e) { message.error(errText(e)); }
    };
    const progress = React.useMemo(() => current?.state === 'running' ? progressOf(log) : null, [log, current?.state]);
    // A run that ended without results (the framework stopped before running scenarios): say why.
    const firstError = React.useMemo(() => {
        if (!current || current.state === 'running' || current.summary) return null;
        const lv = levels(log);
        // The error that stopped the run: a real error line before a warning (⚠, "could not be decrypted", …).
        const errs = log.map((l, i) => ({ i, t: stripAnsi(l.text) })).filter((x) => lv[x.i] === 'error' && !/^\s*(\[[^\]]*\]\s*){0,2}(⚠|warn)/i.test(x.t) && !/could not be decrypted|deprecat/i.test(x.t));
        const best = errs.find((x) => /\b(Error|Exception)\b|failed to|doesn't exist|cannot find|not found|ENOENT|ECONNREFUSED|Timeout/i.test(x.t)) ?? errs[0];
        return best ? best.t.replace(/^\s*(\[[^\]]*\]\s*){1,2}/, '').slice(0, 400) : null;
    }, [log, current]);
    const s = current?.summary;

    const openScenario = async (sc: ScenarioResult) => {
        try {
            const hits = await api.search(sc.name, { glob: '*.feature' });
            const h = hits.find((x) => /Scenario( Outline| Template)?:/.test(x.text)) ?? hits[0];
            if (h) openInEditor(h.path, h.line); else message.info('Could not find this scenario in the feature files.');
        } catch (e) { message.error(errText(e)); }
    };

    // Results of the shown run, one concern per tab: scenarios (with their evidence), live steps, raw output, run-wide files.
    type ResTab = 'scenarios' | 'steps' | 'output' | 'files';
    const [resTabRaw, setResTabRaw] = React.useState<ResTab>(() => { try { const v = localStorage.getItem('cs-studio-run-results-tab'); return (['scenarios', 'steps', 'output', 'files'].includes(v ?? '') ? v : 'scenarios') as ResTab; } catch { return 'scenarios'; } });
    const setResTab = (v: ResTab) => { setResTabRaw(v); if (v === 'steps' || v === 'output') setOutView(v); try { localStorage.setItem('cs-studio-run-results-tab', v); } catch { /* ignore */ } };
    const hasScenarios = !!s && s.scenarios.length > 0;
    const hasFiles = runFiles.length > 0 && !!ev && !!current?.reportKey;
    const resTab: ResTab = resTabRaw === 'scenarios' && hasScenarios ? 'scenarios' : resTabRaw === 'files' && hasFiles ? 'files'
        : resTabRaw === 'steps' || resTabRaw === 'output' ? resTabRaw : hasScenarios ? 'scenarios' : outView;
    const resultsCard = current && (
        <Card size="small" className="tests-results" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
            styles={{ body: { padding: 0, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: resTab === 'scenarios' || resTab === 'files' ? 'auto' : 'hidden' } }}
            tabProps={{ size: 'small' }} activeTabKey={resTab} onTabChange={(k) => setResTab(k as ResTab)}
            tabList={[
                ...(hasScenarios ? [{ key: 'scenarios', label: <span>Scenarios <span className="q-count">{s!.scenarios.length}</span></span> }] : []),
                { key: 'steps', label: <Tooltip title="What ran, read live from the output">Steps</Tooltip> },
                { key: 'output', label: 'Output' },
                ...(hasFiles ? [{ key: 'files', label: <Tooltip title="Files the run saved that do not belong to one scenario (console logs, network recordings, videos of the whole session)"><span>Run files <span className="q-count">{runFiles.length}</span></span></Tooltip> }] : []),
            ]}>
            {resTab === 'files' && hasFiles ? <RunEvidenceList runId={current.id} reportKey={current.reportKey!} files={runFiles} hasPlaywright={ev!.hasPlaywright} />
                : resTab === 'scenarios' && hasScenarios ? <RunTree runId={current.id} reportKey={current.reportKey} scenarios={s!.scenarios} ev={ev}
                    onOpenScenario={(sc, se) => {
                        // A pull request's run: its files are the pull request's version, shown in its Files tab.
                        if (current.pr) navigate(['prs', current.pr.repository, current.pr.id, 'files', ...(se?.location ? [se.location.file] : [])]);
                        else if (se?.location) openInEditor(se.location.file, se.location.line); else void openScenario(sc);
                    }} />
                : resTab === 'output' ? <RunLog log={log} running={current.state === 'running'} />
                : <StepTimeline log={log} running={current.state === 'running'} />}
        </Card>
    );

    return (
        <Split id="runs-left" initial={400} min={300} max={720} style={{ height: '100%' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, flex: 1 }}>
                <Card size="small" title="New run" className="tests-setup" styles={{ body: { maxHeight: 'calc(100vh - var(--chrome) - 200px)', overflow: 'auto', paddingTop: 0 } }}
                    extra={<Space size={6}>
                        {running && <Button size="small" danger icon={<StopOutlined />} onClick={() => { const r = runs.find((x) => x.state === 'running'); if (r) void api.stopRun(r.id); }}>Stop</Button>}
                        <Tooltip title={running ? 'A run is already in progress' : badOpts.length ? `Put the options right first: ${badOpts.join(', ')}` : nothing ? 'Nothing matches this choice' : tooMany ? `Framework ${fw?.version ?? ''} runs one chosen scenario at a time (several need 1.55 or later): choose one, or use a tag` : undefined}>
                            <Button type="primary" icon={<CaretRightOutlined />} loading={starting} disabled={running || !target.project || nothing || tooMany || fw?.installed === false || badOpts.length > 0}
                                onClick={() => start(request())}>{starting ? 'Starting…' : 'Run'}</Button>
                        </Tooltip>
                        <Tooltip title="Run in a visible browser and pause before each step or when a step fails">
                            <Button icon={<BugOutlined />} disabled={running || !target.project || nothing || fw?.installed === false} onClick={() => setDebugOpen(true)}>Debug</Button>
                        </Tooltip>
                    </Space>}>
                    {fw && !fw.installed && <Alert type="warning" showIcon style={{ margin: '8px 0' }} message={fw.message} />}
                    {running && <Alert type="info" showIcon style={{ margin: '8px 0' }} message={<>A run is already in progress: Run is available again when it ends.{' '}
                        {(() => { const r = runs.find((x) => x.state === 'running'); return r && r.id !== sel ? <a onClick={() => navigate(['runs', r.id])}>Show it</a> : null; })()}</>} />}
                    <Form layout="vertical" size="small">
                        <Tabs size="small" activeKey={setupTab} onChange={(k) => setSetupTab(k as SetupTab)} className="tests-tabs" items={[
                            { key: 'what', label: 'What to run', children: <>
                                <Row gutter={12}>
                                    <Col span={12}><Form.Item label="Project" style={{ marginBottom: 8 }} htmlFor="cs-runs-project"><Select id="cs-runs-project" value={target.project} onChange={(v) => setTarget({ ...target, project: v })} options={projects.map((p) => ({ value: p, label: p }))} /></Form.Item></Col>
                                    <Col span={12}><Form.Item label="Environment" style={{ marginBottom: 8 }} htmlFor="cs-runs-environment"><Select id="cs-runs-environment" value={target.env} onChange={(v) => setTarget({ ...target, env: v })} options={(envs.length ? envs : ['dev']).map((e) => ({ value: e, label: e }))} /></Form.Item></Col>
                                </Row>
                                {catalog ? <RunPicker catalog={catalog} project={target.project} value={pick} onChange={setPick} /> : <Spin size="small" style={{ margin: 8 }} />}
                                {tooMany && <Alert type="warning" showIcon style={{ marginBottom: 8 }} message={`Framework ${fw?.version ?? ''} runs one chosen scenario at a time; several need version 1.55 or later. Choose one scenario, or use a tag.`} />}
                                <div className="tests-optline">
                                    <Typography.Text type="secondary" ellipsis style={{ fontSize: 12, flex: 1, minWidth: 0 }}>{optSummary}</Typography.Text>
                                    <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setSetupTab('options')}>Change</Button>
                                    {(pick.features.length > 0 || pick.tags.length > 0 || pick.scenarios.length > 0) && <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setPick(EMPTY_PICK)}>Clear choice</Button>}
                                </div>
                            </> },
                            { key: 'options', label: 'Options', children: <>
                                <Row gutter={12}>
                                    <Col span={12}><Form.Item label="Browser" style={{ marginBottom: 8 }} htmlFor="cs-runs-browser"><Select id="cs-runs-browser" value={target.browser} onChange={(v) => setTarget({ ...target, browser: v })} options={['chromium', 'chrome', 'msedge', 'firefox', 'webkit'].map((b) => ({ value: b, label: b }))} /></Form.Item></Col>
                                    <Col span={12}><Form.Item label="Device" style={{ marginBottom: 8 }} htmlFor="cs-runs-device" tooltip="Emulate a phone or tablet (viewport, user agent, touch): any Playwright device name">
                                        <Select id="cs-runs-device" showSearch allowClear value={target.device || undefined} placeholder="Desktop" onChange={(v) => setTarget({ ...target, device: v ?? '' })}
                                            options={DEVICES.map((d) => ({ value: d, label: d }))} /></Form.Item></Col>
                                </Row>
                                <Row gutter={12}>
                                    <Col span={8}><Form.Item label="Workers" style={{ marginBottom: 8 }} htmlFor="cs-runs-workers" tooltip="Scenarios run at the same time"><StrictWholeNumber id="cs-runs-workers" label="Workers" min={1} max={16} value={target.workers} onChange={(v) => setTarget((t) => ({ ...t, workers: v }))} onValidity={validity('Workers')} /></Form.Item></Col>
                                    <Col span={8}><Form.Item label="Retries" style={{ marginBottom: 8 }} htmlFor="cs-runs-retries" tooltip="Run a failed scenario again, up to this many times (passing on a retry marks it flaky)"><StrictWholeNumber id="cs-runs-retries" label="Retries" min={0} max={5} value={target.retries} onChange={(v) => setTarget((t) => ({ ...t, retries: v }))} onValidity={validity('Retries')} /></Form.Item></Col>
                                    <Col span={8}><Form.Item label="Show browser" style={{ marginBottom: 8 }}><Switch aria-label="Show the browser" checked={!target.headless} onChange={(v) => setTarget({ ...target, headless: !v })} /></Form.Item></Col>
                                </Row>
                                <Row gutter={12}>
                                    <Col span={24}><Form.Item label="Window size" style={{ marginBottom: 8 }} tooltip="Browser window size (width × height); empty: the project's setting">
                                        <div style={{ display: 'flex', gap: 8 }}><StrictWholeNumber label="Window width" placeholder="Width" style={{ flex: 1 }} min={200} max={7680} value={target.width} onChange={(v) => setTarget((t) => ({ ...t, width: v }))} onClear={() => setTarget((t) => ({ ...t, width: undefined }))} onValidity={validity('Window width')} /><StrictWholeNumber label="Window height" placeholder="Height" style={{ flex: 1 }} min={200} max={7680} value={target.height} onChange={(v) => setTarget((t) => ({ ...t, height: v }))} onClear={() => setTarget((t) => ({ ...t, height: undefined }))} onValidity={validity('Window height')} /></div></Form.Item></Col>
                                </Row>
                                <Form.Item label="Azure DevOps results" style={{ marginBottom: 8 }} htmlFor="cs-runs-ado" tooltip="Whether this run sends its results to Azure DevOps test plans. Don't send: for local tries, and off the company network (otherwise each call waits for Azure DevOps).">
                                    <Select id="cs-runs-ado" value={target.ado ?? 'config'} onChange={(v) => setTarget({ ...target, ado: v === 'config' ? undefined : v as 'on' | 'off' })}
                                        options={[{ value: 'config', label: 'As the project is configured' }, { value: 'off', label: "Don't send" }, { value: 'on', label: 'Send' }]} />
                                </Form.Item>
                                <Form.Item label="Values for this run" style={{ marginBottom: 8 }} htmlFor="cs-runs-vars" tooltip="One KEY=value per line; they override the project's configuration for this run only (e.g. BASE_URL, a feature flag)"
                                    help={badVars.length ? `Not KEY=value, left out: ${badVars.slice(0, 3).join(', ')}${badVars.length > 3 ? '…' : ''}` : undefined} validateStatus={badVars.length ? 'warning' : undefined}>
                                    <Input.TextArea id="cs-runs-vars" autoSize={{ minRows: 2, maxRows: 8 }} value={target.vars} onChange={(e) => setTarget({ ...target, vars: e.target.value })} placeholder={'BASE_URL=https://qa2.example.test\nFEATURE_NEW_CHECKOUT=true'} style={{ fontFamily: 'var(--mono, monospace)', fontSize: 12 }} />
                                </Form.Item>
                                {fw?.version && <Typography.Text type="secondary" style={{ fontSize: 12 }}>Framework {fw.version}</Typography.Text>}
                            </> },
                            { key: 'saved', label: <span>Saved runs{configs.length ? <span className="q-count">{configs.length}</span> : null}</span>, children: <>
                                <Space size={6} style={{ marginBottom: 8 }} wrap>
                                    {/* Closed when pressed: the dialog covers the button, so the tooltip would never see the mouse leave and stay open after it. */}
                                    <Tooltip title="Saved in .cs-studio/run-configurations.json: commit it to share it with the team" open={saveTip} onOpenChange={setSaveTip}><Button size="small" onClick={() => { setSaveTip(false); saveConfig(); }} disabled={!target.project || !target.env}>Save this run…</Button></Tooltip>
                                    <Tooltip title="An Azure DevOps pipeline (YAML) that runs these tests on a schedule, on pushes or for pull requests"><Button size="small" onClick={() => setPipelineOpen(true)} disabled={!target.project || !target.env}>Pipeline…</Button></Tooltip>
                                </Space>
                                <List size="small" bordered dataSource={configs} aria-label="Saved runs" locale={{ emptyText: 'No saved runs yet. Choose what to run, then press Save this run…' }}
                                    renderItem={(c) => (
                                        <List.Item className="tests-saved" actions={[
                                            <Tooltip key="f" title="Fill in the form with it"><Button size="small" type="text" onClick={() => { useConfig(c); setSetupTab('what'); }} aria-label={`Use ${c.name}`}>Use</Button></Tooltip>,
                                            <Tooltip key="r" title="Run it now"><Button size="small" type="text" icon={<CaretRightOutlined />} disabled={running || starting} onClick={() => void runConfig(c)} aria-label={`Run ${c.name}`} /></Tooltip>,
                                            <Popconfirm key="d" title={`Delete "${c.name}"?`} okText="Delete" okButtonProps={{ danger: true }} onConfirm={() => void removeConfig(c)}>
                                                <Tooltip title="Delete"><Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label={`Delete ${c.name}`} /></Tooltip></Popconfirm>,
                                        ]}>
                                            <List.Item.Meta title={<Typography.Text ellipsis={{ tooltip: c.name }} style={{ maxWidth: '100%' }}>{c.name}</Typography.Text>}
                                                description={<Typography.Text type="secondary" ellipsis={{ tooltip: true }} style={{ fontSize: 12, maxWidth: '100%' }}>{c.request.project} / {c.request.env}{c.request.tags ? ` · ${c.request.tags}` : ''}{c.request.scenarios?.length ? ` · ${c.request.scenarios.length} scenario(s)` : c.request.features?.length ? ` · ${c.request.features.length} feature(s)` : ''}{c.request.ado === undefined ? '' : ` · Azure DevOps ${c.request.ado ? 'on' : 'off'}`}</Typography.Text>} />
                                        </List.Item>
                                    )} />
                            </> },
                        ]} />
                    </Form>
                    {outputDirs.length > 0 && <div className="hint-line">
                        Runs write {outputDirs.map((d, i) => <React.Fragment key={d}>{i ? ', ' : ''}<Typography.Text code>{d}/</Typography.Text></React.Fragment>)} into the project.{' '}
                        <Button type="link" size="small" style={{ padding: 0, height: 'auto' }} onClick={async () => {
                            try { await api.ignoreRunOutput(outputDirs); message.success('Added to .gitignore (commit .gitignore to share it)'); setOutputDirs([]); await refresh(); }
                            catch (e) { message.error(errText(e)); }
                        }}>Keep them out of Git</Button>
                        <Button type="text" size="small" aria-label="Dismiss" style={{ padding: 0, height: 'auto', marginLeft: 6 }} onClick={() => setOutputDirs([])}>✕</Button>
                    </div>}
                </Card>
                <Card size="small" title={<Space>Recent runs <Button aria-label="Refresh the runs" size="small" type="text" icon={<ReloadOutlined />} onClick={loadRuns} /></Space>} style={{ flex: 1, minHeight: 120, display: 'flex', flexDirection: 'column' }} styles={{ body: { overflow: 'auto', flex: 1, padding: 0 } }}>
                    <List size="small" dataSource={runs} locale={{ emptyText: 'No runs yet.' }} renderItem={(r) => (
                        <List.Item onClick={() => navigate(['runs', r.id])} style={{ cursor: 'pointer', paddingInline: 12, background: r.id === sel ? 'rgba(147,24,108,.08)' : undefined }}>
                            <Space direction="vertical" size={0} style={{ width: '100%', minWidth: 0 }}>
                                <Space><Tag color={STATE_TAG[r.state].color} icon={r.state === 'running' ? <LoadingOutlined /> : undefined}>{STATE_TAG[r.state].label}</Tag><Typography.Text>{r.request.project} / {r.request.env}</Typography.Text>{r.bisect && <Tag color="geekblue">search {r.bisect.commit.slice(0, 7)}</Tag>}
                                    {r.summary && <Typography.Text type="secondary">{r.summary.passed}✓ {r.summary.failed}✗{r.summary.flaky ? <Tooltip title="Passed only after a retry"> <Typography.Text type="warning">{r.summary.flaky}↻</Typography.Text></Tooltip> : null}</Typography.Text>}</Space>
                                <Typography.Text type="secondary" title={r.command.slice(3).join(' ')} style={{ fontSize: 12, maxWidth: '100%', display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{new Date(r.startedAt).toLocaleString()} · {r.command.slice(3).join(' ') || 'everything'}</Typography.Text>
                            </Space>
                        </List.Item>
                    )} />
                </Card>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, minWidth: 0, flex: 1 }}>
                {bisect && <BisectPanel value={bisect} onChange={(b) => { setBisect(b); void loadRuns(); }} onOpenRun={(id) => navigate(['runs', id])} />}
                {bisectOpen && current?.summary && <BisectStart project={current.request.project} env={current.request.env} browser={current.request.browser} onClose={() => setBisectOpen(false)}
                    onStarted={(b) => { setBisectOpen(false); setBisect(b); }}
                    failed={current.summary.scenarios.filter((x) => x.status === 'failed' || x.status === 'broken').filter((x, i, a) => a.findIndex((y) => y.name === x.name) === i)
                        .map((x) => ({ name: x.name, file: ev?.scenarios.find((e) => e.name === x.name && e.feature === x.feature)?.location?.file ?? current.request.features?.find((f) => f.endsWith('.feature') && current.request.features!.length === 1) }))} />}
                {pipelineOpen && <MakePipeline open={pipelineOpen} onClose={() => setPipelineOpen(false)} request={request()} envs={envs} />}
                {current && publishOpen && <PublishToAdo run={current} open={publishOpen} onClose={() => setPublishOpen(false)} />}
                {current?.pr && <PrPostResults repo={current.pr.repository} id={current.pr.id} run={posting} open={!!posting} onClose={() => setPosting(null)} />}
                {starting ? (
                    <Card style={{ flex: 1 }}><Space direction="vertical" align="center" style={{ width: '100%', marginTop: 80 }}>
                        <Spin size="large" /><Typography.Text>Starting the test run…</Typography.Text>
                    </Space></Card>
                ) : !current ? <Card style={{ flex: 1 }}><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Choose what to run on the left and press Run, or press ▶ next to a Feature or Scenario in the editor" /></Card> : (
                    <>
                        <Card size="small" styles={{ body: { padding: '8px 12px' } }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                                <Tag color={STATE_TAG[current.state].color} icon={current.state === 'running' ? <LoadingOutlined /> : undefined} style={{ fontSize: 13, padding: '2px 8px', marginInlineEnd: 0 }}>{STATE_TAG[current.state].label}</Tag>
                                <Typography.Text strong>{current.request.project} / {current.request.env}</Typography.Text>
                                {current.bisect && <Tooltip title="A step of the search for the commit that broke a scenario, run on an earlier commit in a separate copy (removed when the search ended, with its report)"><Tag color="geekblue" style={{ marginInlineEnd: 0 }}>Search step · {current.bisect.commit.slice(0, 8)}</Tag></Tooltip>}
                                {current.pr && <Tooltip title={`${current.pr.based === 'merge' ? 'Merge result' : 'Source branch'} ${current.pr.commit.slice(0, 8)} of "${current.pr.title}"`}>
                                    <Tag color="purple" style={{ cursor: 'pointer', marginInlineEnd: 0 }} onClick={() => navigate(['prs', current.pr!.repository, current.pr!.id, 'tests'])}>Pull request !{current.pr.id}</Tag></Tooltip>}
                                {/* Two durations, named: the whole run (with the framework's start-up and the report) and the tests' own time as the report counts it. */}
                                <Tooltip title="From pressing Run to the end, with the framework's start-up, browser launch and report writing"><Typography.Text type="secondary">Run time (with start-up) {fmtMs((current.endedAt ? Date.parse(current.endedAt) : now) - Date.parse(current.startedAt))}</Typography.Text></Tooltip>
                                {s && s.duration > 0 && <Tooltip title="The tests' own time, as the framework's HTML report shows it (its header and Timeline)"><Typography.Text type="secondary">· Test time (report) {fmtMs(s.duration)}</Typography.Text></Tooltip>}
                                {s && <Space size={6} className="run-counts">
                                    <span><b>{s.total}</b> scenario{s.total === 1 ? '' : 's'}</span>
                                    <Tag color="success" style={{ marginInlineEnd: 0 }}>{s.passed} passed</Tag>
                                    {!!s.flaky && <Tooltip title="Passed only when the framework ran them again after a failure (RETRY_COUNT): flaky tests"><Tag color="warning" style={{ marginInlineEnd: 0 }}>{s.flaky} only after a retry</Tag></Tooltip>}
                                    <Tag color={s.failed ? 'error' : 'default'} style={{ marginInlineEnd: 0 }}>{s.failed} failed</Tag>
                                    {s.skipped > 0 && <Tag style={{ marginInlineEnd: 0 }}>{s.skipped} skipped</Tag>}
                                    {!!s.missing?.length && <Tooltip title={<span>The output shows these ran, but the framework's report does not have them:{s.missing.map((m) => <div key={m.name}>• {m.name}: {m.status}{m.retries ? ` after ${m.retries} retr${m.retries === 1 ? 'y' : 'ies'}` : ''}</div>)}</span>}>
                                        <Tag color="warning" icon={<WarningOutlined />} style={{ marginInlineEnd: 0 }}>{s.missing.length} not in the report</Tag></Tooltip>}
                                </Space>}
                                <div style={{ flex: 1 }} />
                                <Space wrap size={6}>
                                    {current.state === 'running' && <Button size="small" danger icon={<StopOutlined />} onClick={() => api.stopRun(current.id)}>Stop</Button>}
                                    {current.reportKey && (!current.bisect || current.state === 'running') && <Button size="small" icon={<FileTextOutlined />} href={`/report/${current.id}/${current.reportKey}/${current.reportIndex ?? 'index.html'}`} target="_blank" rel="noreferrer">Open report</Button>}
                                    {s && !running && current.state !== 'running' && !current.bisect && <Tooltip title="Publish these results to Azure DevOps Test Plans (test runs on the test cases the scenarios automate)"><Button size="small" icon={<CloudUploadOutlined />} onClick={() => setPublishOpen(true)}>Publish to Azure DevOps</Button></Tooltip>}
                                    {s && s.failed > 0 && !running && <Tooltip title="Run only the scenarios that failed"><Button size="small" onClick={() => current.pr ? void rerunPr(current) : start(rerunFailed(current, ev))}>Rerun failed</Button></Tooltip>}
                                    {s && s.failed > 0 && !running && !current.pr && !current.bisect && bisect?.state !== 'running' && <Tooltip title="Run this scenario on earlier commits to find the one where it started failing"><Button size="small" icon={<SearchOutlined />} onClick={() => setBisectOpen(true)}>Which commit broke it?</Button></Tooltip>}
                                    {!running && current.state !== 'running' && !current.pr && <Button size="small" icon={<CaretRightOutlined />} onClick={() => start(current.request)}>Run again</Button>}
                                    {current.pr && current.state !== 'running' && <>
                                        {s && <Button size="small" type="primary" icon={<CommentOutlined />} onClick={() => setPosting(current.id)}>Post results to the PR</Button>}
                                        <Button size="small" onClick={() => navigate(['prs', current.pr!.repository, current.pr!.id, 'tests'])}>Back to the pull request</Button>
                                    </>}
                                </Space>
                            </div>
                            {current.state === 'running' && current.request.debug && current.codePaused && (() => {
                                const top = current.codePaused.frames.find((f) => !f.external) ?? current.codePaused.frames[0];
                                return <Alert className="dbg-bar" type={current.codePaused.reason === 'exception' ? 'error' : 'warning'} showIcon icon={<BugOutlined />} style={{ marginTop: 8 }}
                                    message={<span>Paused in the code at <b className="mono">{top?.file}:{top?.line}</b>{top ? ` (${top.name})` : ''}</span>}
                                    description={current.codePaused.exception ? <Typography.Text code style={{ fontSize: 12 }}>{current.codePaused.exception}</Typography.Text> : 'Variables, call stack and stepping are in the Code screen\'s Debug tab.'}
                                    action={<Space direction="vertical" size={4}>
                                        {top?.file && <Button size="small" type="primary" onClick={() => navigate(['code', top.file!, top.line ?? 1])}>Open in Code</Button>}
                                        <Button size="small" icon={<CaretRightOutlined />} onClick={() => void api.debugRun(current.id, 'resume')}>Continue</Button>
                                    </Space>} />;
                            })()}
                            {current.state === 'running' && current.request.debug && !current.codePaused && (current.paused
                                ? <Alert className="dbg-bar" type={current.paused.kind === 'after-failure' ? 'error' : 'info'} showIcon icon={current.paused.kind === 'after-failure' ? <WarningOutlined /> : <BugOutlined />} style={{ marginTop: 8 }}
                                    message={<span>{current.paused.kind === 'after-failure' ? 'Paused after a failure in' : 'Paused before'} <b className="mono">{current.paused.step}</b></span>}
                                    description={<>
                                        {current.paused.scenario && <div style={{ fontSize: 12 }}>Scenario: {current.paused.scenario}</div>}
                                        {current.paused.error && <Typography.Text code style={{ whiteSpace: 'pre-wrap', fontSize: 12, display: 'block', marginTop: 4 }}>{current.paused.error.split('\n')[0]}</Typography.Text>}
                                        <div style={{ fontSize: 12, marginTop: 4 }}>{current.paused.kind === 'after-failure' ? 'A browser the test uses is still open on the failed page: look at it (its developer tools too), then go on.' : 'A browser the test uses shows the page as it is before this step.'}</div>
                                    </>}
                                    action={<Space direction="vertical" size={4}>
                                        <Button size="small" type="primary" icon={<StepForwardOutlined />} onClick={() => void debugCmd(current.id, 'next')}>{current.paused.kind === 'after-failure' ? 'Go on' : 'Run this step'}</Button>
                                        {(current.paused.kind === 'before-step' || current.request.debug.steps) && <Button size="small" icon={<CaretRightOutlined />} onClick={() => void debugCmd(current.id, 'continue')}>Continue</Button>}
                                        <Button size="small" danger icon={<StopOutlined />} onClick={() => void debugCmd(current.id, 'stop')}>Stop</Button>
                                    </Space>} />
                                : <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}><BugOutlined /> Debug run: {current.request.debug.steps ? 'pauses before each step' : ''}{current.request.debug.steps && current.request.debug.pauseOnFailure ? ' and ' : ''}{current.request.debug.pauseOnFailure ? 'pauses when a step fails' : ''}.</Typography.Text>)}
                            {progress && <Typography.Text style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
                                {progress.started === 0 ? 'Starting the framework (configuration, step definitions, browser)…'
                                    : <>Scenario {progress.started}: <b>{progress.current}</b></>}
                            </Typography.Text>}
                            <Typography.Text code style={{ fontSize: 11, display: 'block', marginTop: 4 }} ellipsis={{ tooltip: current.command.join(' ') }}>{current.command.join(' ')}</Typography.Text>
                            {current.secretNames.length > 0 && <Typography.Text type="secondary" style={{ fontSize: 12 }}><LockOutlined /> Secrets given to this run: {current.secretNames.join(', ')}</Typography.Text>}
                            {current.message && <Typography.Text type="danger" style={{ display: 'block' }}>{current.message}</Typography.Text>}
                            {!s && current.state === 'stopped' && (() => {
                                // What finished before the stop, read from the output (the framework writes its report only at the end).
                                const done = parseTimeline(log).filter((x) => x.state === 'passed' || x.state === 'failed');
                                const byName = new Map(done.map((x) => [`${x.feature}|${x.name}`, x])); // the last attempt of each
                                const fin = [...byName.values()];
                                const failed = fin.filter((x) => x.state === 'failed').length;
                                return <Alert type="info" showIcon style={{ marginTop: 6 }} message={fin.length
                                    ? `You stopped the run after ${fin.length} scenario${fin.length === 1 ? '' : 's'} finished (${fin.length - failed} passed, ${failed} failed). The framework writes its report at the end, so there is no report: the Steps tab below shows what ran.`
                                    : 'You stopped the run before any scenario finished, so there are no results.'} />;
                            })()}
                            {!s && current.state !== 'running' && current.state !== 'stopped' && log.length > 0 && (
                                <Alert type="error" showIcon style={{ marginTop: 6 }} message="The run ended before any scenario finished, so there are no results."
                                    description={firstError ? <>First error: <Typography.Text code style={{ whiteSpace: 'pre-wrap' }}>{firstError}</Typography.Text><br />The output below has the details (use <b>Errors</b> to see only the problems).</> : 'See the output below.'} />
                            )}
                        </Card>
                        {resultsCard}
                    </>
                )}
                <Modal open={debugOpen} title="Debug run" okText="Start debugging" onCancel={() => setDebugOpen(false)}
                    okButtonProps={{ disabled: !debugOpts.steps && !debugOpts.pauseOnFailure, icon: <BugOutlined /> }}
                    onOk={() => { setDebugOpen(false); void start({ ...request(), debug: { steps: debugOpts.steps, pauseOnFailure: debugOpts.pauseOnFailure, ...(debugOpts.slowMo ? { slowMo: debugOpts.slowMo } : {}) } }); }}>
                    <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>The chosen scenarios run one at a time in a visible browser on this computer. When the run pauses, the page here shows where, with buttons to go on.</Typography.Paragraph>
                    <Space direction="vertical">
                        <Checkbox checked={debugOpts.steps} onChange={(e) => setDebugOpts({ ...debugOpts, steps: e.target.checked })}>Pause before each step</Checkbox>
                        <Checkbox checked={debugOpts.pauseOnFailure} onChange={(e) => setDebugOpts({ ...debugOpts, pauseOnFailure: e.target.checked })}>Pause when a step fails (the browser stays on the failed page)</Checkbox>
                        <Space><span>Slow motion</span><InputNumber size="small" min={0} max={5000} step={100} value={debugOpts.slowMo} onChange={(v) => setDebugOpts({ ...debugOpts, slowMo: v ?? 0 })} addonAfter="ms per action" style={{ width: 170 }} aria-label="Slow motion" /></Space>
                    </Space>
                </Modal>
            </div>
        </Split>
    );
}
