/**
 * Agents: ready-made workflows (automate a story end to end: story → application code → manual run in
 * the Studio browser → framework test → run → fix; API tests; load tests; healing; page objects), the
 * agent settings (model: GitHub Copilot or the organisation's own; approvals; the framework's QA tools)
 * and the conversations. A workflow starts a conversation in the Copilot panel.
 */
import React from 'react';
import { Alert, App, Button, Card, Col, Collapse, Empty, Form, Input, Popconfirm, Radio, Row, Select, Space, Tabs, Tag, Tooltip, Typography } from 'antd';
import { ApiOutlined, BugOutlined, DashboardOutlined, DeleteOutlined, ExperimentOutlined, FileSearchOutlined, LayoutOutlined, LockOutlined, MessageOutlined, RocketOutlined, SettingOutlined } from '@ant-design/icons';
import { AgentSessionInfo, AgentSettingsDef, AgentStatus, api, PlanContext } from '../api';
import { AccountSetup, RuntimeSetup } from '../components/AgentSetup';
import { ToolServers } from '../components/ToolServers';
import { errText } from '../state';
import { ago } from '../format';
import { useRememberedTab } from '../agents-tabs';
import { useUnsaved } from '../unsaved';
import { useKept } from '../kept';
import { agentsApi, AgentStatusView } from '../agents-api';
import { askChangedElsewhere, isChangedElsewhere } from '../components/ChangedElsewhere';

/** The longest model or deployment name (the server says the same). */
const MODEL_MAX = 120;
/** Why an endpoint address is not right (the server checks the same), or null. */
export function endpointProblem(v: string): string | null {
    const t = v.trim();
    if (!t) return 'The endpoint address is needed (https://…).';
    if (t.length > 2000) return 'At most 2000 characters.';
    if (!/^https?:\/\//i.test(t)) return 'A web address starting with http:// or https://, e.g. https://my-resource.openai.azure.com/openai/v1.';
    if (!/^[\x21-\x7e]+$/.test(t)) return 'A web address has no spaces, emoji or other special characters.';
    try { if (!new URL(t).hostname) throw new Error(); } catch { return 'Not a web address: http(s)://host[:port]/path.'; }
    return null;
}

interface Field { key: string; label: string; placeholder?: string; required?: boolean; multiline?: boolean; kind?: 'project' | 'env' | 'seed' }
interface Workflow { key: string; title: string; icon: React.ReactNode; about: string; fields: Field[]; task: (v: Record<string, string>) => string; prompt: (v: Record<string, string>) => string }

const P: Field = { key: 'project', label: 'Project', kind: 'project', required: true };
const E: Field = { key: 'env', label: 'Environment', kind: 'env', required: true };

/** The story as the agent gets it: the work item's text read by the Studio, or what the person wrote. */
const storyText = (v: Record<string, string>) => v.storyContext || (/^#?\d+$/.test((v.story ?? '').trim())
    ? `Azure DevOps work item ${(v.story ?? '').trim().replace('#', '')} (read it, with its acceptance criteria, through the Studio's Azure DevOps calls)` : v.story ?? '');

export const WORKFLOWS: Workflow[] = [
    {
        key: 'plan', title: 'Plan a story first', icon: <FileSearchOutlined />,
        about: 'Writes the test plan for a story as a feature (scenarios per acceptance criterion, worded like the existing steps, in the style of an example feature) and stops for your approval, showing which steps are reused and which are new. Only then writes the new steps, pages and data, runs and fixes.',
        fields: [P, E, { key: 'story', label: 'Story', placeholder: 'Azure DevOps work item number, or the story and its acceptance criteria', required: true, multiline: true },
            { key: 'seed', label: 'Style example', kind: 'seed' },
            { key: 'url', label: 'Application address', placeholder: 'Empty: BASE_URL of the environment' }],
        task: (v) => `Plan, then automate a story in project ${v.project}, environment ${v.env}.`,
        prompt: (v) => `Plan first, then automate this story in project ${v.project}, environment ${v.env}.
Story: ${storyText(v)}
${v.seed ? `Style example: ${v.seed}. Read it first and follow it: its tags, Background, Scenario Outline with JSON test data (runFlag), and how its steps are worded.\n` : ''}Application: ${v.url || `the BASE_URL of ${v.env}`}.

Phase 1, the plan (write only the feature file, no step definitions, pages or data yet):
1. One scenario per acceptance criterion, positive and negative cases; name each after what it checks.
2. Word every step like an existing step where one fits: list the steps with studio_call GET /api/lang/steps, and check the plan with studio_call POST /api/lang/plan {"path": "<the feature>"} — reword new steps that are close to existing ones.
3. Save the feature in the project's feature folder.
4. Call plan_submit with the feature and short notes (what it covers, what it leaves out, questions). Stop and wait: the person approves it, or tells you what to change (then revise and submit again).

Phase 2, only after plan_submit says approved, from the feature as approved:
5. Write only the new steps (reuse the existing ones exactly), the page objects and the JSON test data, following the framework's standards; check the application in the Studio browser where you need locators.
6. Run the feature with tests_run in ${v.env}; fix failures and run again until it passes.
7. Tell me the files you created and anything you could not automate.`,
    },
    {
        key: 'story', title: 'Automate a story end to end', icon: <RocketOutlined />,
        about: 'Reads the story and the application code of the area under test, runs it by hand in the Studio browser, writes the framework test (feature, JSON data, pages, steps), runs it and fixes it until it passes.',
        fields: [P, E, { key: 'story', label: 'Story', placeholder: 'Azure DevOps work item number, or the story and its acceptance criteria', required: true, multiline: true },
            { key: 'url', label: 'Application address', placeholder: 'Empty: BASE_URL of the environment' },
            { key: 'repo', label: 'Application repository', placeholder: 'Clone URL of the application code (optional)' },
            { key: 'area', label: 'Area under test', placeholder: 'e.g. Orders > Create order; src/app/orders' }],
        task: (v) => `Automate a story end to end in project ${v.project}, environment ${v.env}, with the framework's standards.`,
        prompt: (v) => `Automate this story end to end in project ${v.project}, environment ${v.env}.
Story: ${/^\d+$/.test(v.story.trim()) ? `Azure DevOps work item ${v.story.trim()} (read it, with its acceptance criteria, through the Studio's Azure DevOps calls)` : v.story}
${v.area ? `Area under test: ${v.area}\n` : ''}${v.repo ? `Application code: ${v.repo} (get it with app_code_checkout and read the area under test first: routes, pages, fields, validation, API calls).\n` : ''}Application: ${v.url || `the BASE_URL of ${v.env}`}.

1. List the scenarios to automate (one per acceptance criterion, positive and negative) and the test data each needs.
2. For each scenario, run it by hand in the Studio browser: open the application, read each screen (snapshot / scrape), act like a tester and check the expected results with browser_check.
3. Turn each manual run into a test with browser_save_as_test (preview first; name the pages; typed values as data columns, passwords as secrets). Reuse the project's pages and steps.
4. Add the data rows for the other cases to the JSON data files.
5. Run the new features with tests_run in ${v.env}; fix failures (locators, waits, data, steps) and run again until they pass.
6. Tell me what you created (files), what the data covers, and anything you could not automate.`,
    },
    {
        key: 'api', title: 'Generate API tests', icon: <ApiOutlined />,
        about: 'Builds API requests with checks (from an OpenAPI description, a collection or the application code), runs them with the collection runner, and saves them as framework features.',
        fields: [P, E, { key: 'source', label: 'From', placeholder: 'OpenAPI file or address, collection, or endpoints to cover', required: true, multiline: true },
            { key: 'cover', label: 'What to cover', placeholder: 'e.g. happy path, validation errors, authorisation, negative cases' }],
        task: (v) => `Generate API tests in project ${v.project}, environment ${v.env}.`,
        prompt: (v) => `Create API tests in project ${v.project}, environment ${v.env}, from: ${v.source}.
${v.cover ? `Cover: ${v.cover}.\n` : ''}Use the Studio's API workspace (collections, requests with checks and saved values, OpenAPI import) through studio_call, run them with the collection runner, fix what fails, then save them as framework features (the API feature generation) and run those with tests_run. Keep secrets as {env:NAME} / Studio secrets.`,
    },
    {
        key: 'load', title: 'Create a load test', icon: <DashboardOutlined />,
        about: 'Builds a load scenario (user path, test data, users, duration, service levels) from API requests and runs a short check.',
        fields: [P, E, { key: 'journey', label: 'User journey', placeholder: 'e.g. log in, search products, add to cart, check out', required: true, multiline: true },
            { key: 'load', label: 'Load and service levels', placeholder: 'e.g. 50 users for 10 minutes, 95% under 800 ms, errors under 1%' }],
        task: (v) => `Create a load test in project ${v.project}, environment ${v.env}.`,
        prompt: (v) => `Create a load test in project ${v.project}, environment ${v.env} for this journey: ${v.journey}.
${v.load ? `Load and service levels: ${v.load}.\n` : ''}Build or reuse the API collection with the journey's requests (with saved values for correlation), then a load scenario (performance screens: think time, test data source, policy, SLAs) through studio_call. Run a short smoke run with few users first and show me the results before any longer run.`,
    },
    {
        key: 'heal', title: 'Fix failing tests', icon: <BugOutlined />,
        about: 'Runs the failing tests, reads the evidence (errors, screenshots), finds the cause in the application, fixes locators, waits, data or steps, and runs again until they pass.',
        fields: [P, E, { key: 'what', label: 'Which tests', placeholder: 'Features, tags or a run (empty: the last run with failures)' }],
        task: (v) => `Fix failing tests in project ${v.project}, environment ${v.env}.`,
        prompt: (v) => `Fix the failing tests in project ${v.project}, environment ${v.env}${v.what ? `: ${v.what}` : ' (the latest run with failures)'}.
Run them with tests_run, read each failure's evidence, check the application in the Studio browser where needed, decide whether the test or the application is wrong (do not hide real defects), fix the test (locators in page objects, waits, data, steps), and run again until they pass. Tell me each cause and fix, and any defects you found in the application.`,
    },
    {
        key: 'pages', title: 'Explore the application', icon: <LayoutOutlined />,
        about: 'Walks through screens of the application in the Studio browser and builds page objects (elements with stable locators) and steps for them.',
        fields: [P, E, { key: 'screens', label: 'Screens', placeholder: 'e.g. Login, Dashboard, Orders list, Order details', required: true, multiline: true }, { key: 'url', label: 'Application address', placeholder: 'Empty: BASE_URL of the environment' }],
        task: (v) => `Build page objects for project ${v.project}.`,
        prompt: (v) => `Explore these screens of the application in project ${v.project}, environment ${v.env}: ${v.screens}. Start at ${v.url || `the BASE_URL of ${v.env}`}.
For each screen: open it in the Studio browser, read it (snapshot, forms, tables), note stable locators (test ids, labels, roles), and exercise its main controls. Save the walk through as tests with browser_save_as_test (one page per screen) so the page objects and steps follow the framework's standards, then run them.`,
    },
    {
        key: 'free', title: 'Your own task', icon: <ExperimentOutlined />,
        about: 'Anything you would do in the Studio: describe the task.',
        fields: [{ key: 'task', label: 'Task', required: true, multiline: true, placeholder: 'e.g. Add a database check after the order is created in features/orders.feature' }],
        task: (v) => v.task.slice(0, 300),
        prompt: (v) => v.task,
    },
];

function SettingsCard({ status, onSaved, onReload }: { status: AgentStatusView | null; onSaved: (s: AgentStatus) => void; onReload: () => void }) {
    const { message, modal } = App.useApp();
    const [s, setS] = React.useState<AgentSettingsDef | null>(status?.settings ?? null);
    const [keys, setKeys] = React.useState({ providerKey: '', copilotToken: '' });
    const [saving, setSaving] = React.useState(false);
    const [saveErr, setSaveErr] = React.useState<string | null>(null);
    React.useEffect(() => { if (status?.settings) setS(status.settings); }, [status?.settings]);
    const dirty = !!s && !!status?.settings && (JSON.stringify(s) !== JSON.stringify(status.settings) || !!keys.providerKey || !!keys.copilotToken);
    // Opening another screen (or another tab of the browser) asks first, like the agent editor.
    useUnsaved('agent-settings', dirty, 'agent settings', { lostOnLeave: true, discard: () => { if (status?.settings) setS(status.settings); setKeys({ providerKey: '', copilotToken: '' }); } });
    if (!s) return null;
    // A model or deployment name: one word (the server says the same).
    const modelText = s.model === 'auto' ? '' : s.model;
    const modelProblem = s.provider !== 'custom' ? null : !modelText.trim() ? 'The model or deployment name is needed.'
        : modelText.trim().length > MODEL_MAX ? `At most ${MODEL_MAX} characters (it has ${modelText.trim().length}).`
            : !/^[\w.:/@-]{1,120}$/.test(modelText.trim()) ? `Up to ${MODEL_MAX} letters, digits and . _ : / @ - (no spaces or emoji).` : null;
    const urlProblem = s.provider !== 'custom' ? null : endpointProblem(s.custom?.baseUrl ?? '');
    const pol = status?.policy;
    const rank = { auto: 0, ask: 1, deny: 2 } as const;
    const ap = (k: keyof AgentSettingsDef['approvals'], label: string, deny = false) => {
        const min = pol?.approvals?.[k];
        const value = min && rank[min] > rank[s.approvals[k]] ? min : s.approvals[k];
        return <Col xs={24} md={12} key={k}><Form.Item label={label} tooltip={min ? `The repository's policy: at least "${min === 'deny' ? 'Never' : 'Ask me'}"` : undefined}><Select size="small" style={{ width: '100%' }} value={value} aria-label={label} onChange={(v) => setS({ ...s, approvals: { ...s.approvals, [k]: v } })}
            options={[{ value: 'ask', label: 'Ask me' }, { value: 'auto', label: 'Allow' }, ...(deny || min === 'deny' ? [{ value: 'deny', label: 'Never' }] : [])].map((o) => ({ ...o, disabled: !!min && rank[o.value as keyof typeof rank] < rank[min] }))} /></Form.Item></Col>;
    };
    const save = async (force = false) => {
        if (saving) return;
        if (modelProblem) { setSaveErr(`Not saved: ${modelProblem}`); return; }
        if (urlProblem) { setSaveErr(`Not saved: Endpoint: ${urlProblem}`); return; }
        setSaving(true);
        try {
            onSaved(await agentsApi.saveAgentSettings({ ...s, model: s.model.trim() || s.model, ...(s.custom ? { custom: { ...s.custom, baseUrl: s.custom.baseUrl.trim() } } : {}) }, { ...(keys.providerKey ? { providerKey: keys.providerKey } : {}), ...(keys.copilotToken ? { copilotToken: keys.copilotToken } : {}) }, status?.settingsVersion, force));
            setKeys({ providerKey: '', copilotToken: '' }); setSaveErr(null); message.success('Saved.');
        } catch (e) {
            // Saved in another tab meanwhile: reload those settings, or overwrite them with these on purpose.
            if (isChangedElsewhere(e)) askChangedElsewhere(modal, e, 'The agent settings', { reload: () => { setKeys({ providerKey: '', copilotToken: '' }); setSaveErr(null); onReload(); }, overwrite: () => { setSaving(false); return save(true); } });
            else setSaveErr(`Not saved: ${errText(e)}`);
        } finally { setSaving(false); }
    };
    return (
        <Form layout="vertical" size="small">
            <Form.Item label="Model from">
                <Radio.Group value={s.provider} optionType="button" buttonStyle="solid" onChange={(e) => setS({ ...s, provider: e.target.value, ...(e.target.value === 'custom' && !s.custom ? { custom: { type: 'azure', baseUrl: '' } } : {}) })}>
                    <Tooltip title="Your Copilot licence"><Radio value="copilot">GitHub Copilot</Radio></Tooltip>
                    <Radio value="custom">Our own model endpoint</Radio>
                </Radio.Group>
            </Form.Item>
            {s.provider === 'copilot' ? <Row gutter={12}>
                <Col xs={24} md={12}><Form.Item label="Model"><Select size="small" style={{ width: '100%' }} value={s.model} aria-label="Copilot model" onChange={(m) => setS({ ...s, model: m })} showSearch
                    options={[{ value: 'auto', label: 'Auto (Copilot chooses)' }, ...(status?.models ?? []).map((m) => ({ value: m.id, label: `${m.name}${typeof m.multiplier === 'number' ? ` · ${m.multiplier === 0 ? 'included' : `×${m.multiplier}`}` : ''}`, disabled: m.enabled === false }))]} /></Form.Item></Col>
                <Col xs={24} md={12}><Form.Item label="GitHub token (optional)" tooltip="For automation, instead of signing in: a GitHub token with Copilot access (e.g. a fine-grained token with the Copilot Requests permission), kept in the Studio's secret store">
                    <Input.Password size="small" placeholder={status?.copilotTokenSet ? '(saved)' : 'Not needed when signed in'} value={keys.copilotToken} onChange={(e) => setKeys({ ...keys, copilotToken: e.target.value })} aria-label="GitHub token" autoComplete="new-password" /></Form.Item></Col>
            </Row> : <Row gutter={12}>
                <Col xs={24} md={12}><Form.Item label="Type"><Select size="small" style={{ width: '100%' }} value={s.custom?.type} aria-label="Endpoint type" onChange={(t) => setS({ ...s, custom: { ...(s.custom ?? { baseUrl: '' }), type: t } })}
                    options={[{ value: 'azure', label: 'Azure OpenAI' }, { value: 'openai', label: 'OpenAI-compatible' }, { value: 'anthropic', label: 'Anthropic' }]} /></Form.Item></Col>
                <Col xs={24} md={12}><Form.Item label="Model / deployment" validateStatus={modelProblem ? 'error' : undefined} help={modelProblem ?? undefined}><Input size="small" maxLength={MODEL_MAX} showCount value={modelText} onChange={(e) => setS({ ...s, model: e.target.value })} aria-label="Model or deployment" /></Form.Item></Col>
                <Col xs={24} md={12}><Form.Item label="Endpoint" validateStatus={urlProblem && (s.custom?.baseUrl ?? '') !== '' ? 'error' : undefined} help={urlProblem && (s.custom?.baseUrl ?? '') !== '' ? urlProblem : undefined}><Input size="small" maxLength={2000} placeholder="https://my-resource.openai.azure.com/openai/v1" value={s.custom?.baseUrl} onChange={(e) => setS({ ...s, custom: { ...(s.custom ?? { type: 'azure' }), baseUrl: e.target.value } })} aria-label="Endpoint" /></Form.Item></Col>
                <Col xs={24} md={12}><Form.Item label="API key"><Input.Password size="small" placeholder={status?.providerKeySet ? '(saved)' : 'Kept in the Studio\'s secret store'} value={keys.providerKey} onChange={(e) => setKeys({ ...keys, providerKey: e.target.value })} aria-label="API key" autoComplete="new-password" /></Form.Item></Col>
            </Row>}
            <Typography.Text strong style={{ fontSize: 13 }}>Ask before an agent…</Typography.Text>
            <Row gutter={12} style={{ marginTop: 6 }}>
                {ap('files', 'changes files')}{ap('studio', 'changes in the Studio')}{ap('shell', 'runs commands', true)}{ap('mcp', 'uses MCP tools (your Copilot settings)')}{ap('urls', 'fetches web pages')}
            </Row>
            {saveErr && <Alert type="error" showIcon style={{ marginBottom: 8 }} message={saveErr} closable onClose={() => setSaveErr(null)} />}
            <Space><Button type="primary" size="small" loading={saving} disabled={!!modelProblem || !!urlProblem} onClick={() => void save()}>Save</Button>
                {dirty && <><Tag color="gold" bordered={false}>unsaved</Tag><Button size="small" type="link" onClick={() => { setS(status!.settings); setKeys({ providerKey: '', copilotToken: '' }); setSaveErr(null); }}>Discard changes</Button></>}</Space>
        </Form>
    );
}

export function Agents({ openPanel }: { openPanel: (sessionId: string) => void }) {
    const { message } = App.useApp();
    const [status, setStatus] = React.useState<AgentStatusView | null>(null);
    const [meta, setMeta] = React.useState<{ projects: string[]; environments: Record<string, string[]> } | null>(null);
    const [sessions, setSessions] = React.useState<AgentSessionInfo[]>([]);
    // The workflow chosen stays chosen when the person comes back (Back, the menu, a reload of the tab).
    const [open, setOpen] = useKept<string | null>('agents-workflow', null);
    const [values, setValues] = React.useState<Record<string, string>>({});
    const [starting, setStarting] = React.useState(false);
    const [tab, setTab] = useRememberedTab('agents', 'workflows', ['workflows', 'conversations', 'tools', 'setup'], 'agents');
    const refresh = React.useCallback(() => { api.agentSessions().then((r) => setSessions(r.sessions)).catch(() => {}); }, []);
    const reload = React.useCallback(() => { api.agentStatus().then(setStatus).catch((e) => setStatus({ error: errText(e) } as AgentStatus)); }, []);
    React.useEffect(() => {
        reload();
        api.dbConnections().then((r) => setMeta({ projects: r.projects, environments: r.environments })).catch(() => {});
        refresh();
    }, [refresh]);
    const wf = WORKFLOWS.find((w) => w.key === open);
    // What was typed into the workflow's form is not kept when another screen opens: leaving asks first.
    const typed = !!wf && Object.entries(values).some(([k, x]) => k !== 'project' && k !== 'env' && typeof x === 'string' && x.trim() !== '');
    useUnsaved('agents-workflow-form', typed, `the "${wf?.title ?? 'workflow'}" form`, { lostOnLeave: true, discard: () => setValues((v) => ({ project: v.project ?? '', env: v.env ?? '' })) });
    // Plan first: the project's features (style example) and the story read from Azure DevOps.
    // Read for these values only (project | environment | story): a context read for other values is not used.
    const planKey = `${values.project ?? ''}|${values.env ?? ''}|${values.story?.trim() ?? ''}`;
    const [planRead, setPlanCtx] = React.useState<(PlanContext & { key: string }) | null>(null);
    const planCtx = planRead && planRead.key === planKey ? planRead : null;
    React.useEffect(() => {
        if (open !== 'plan' || !values.project) { setPlanCtx(null); return; }
        let live = true;
        const key = planKey;
        const t = setTimeout(() => {
            api.agentPlanContext(values.project!, values.env || undefined, values.story?.trim() || undefined)
                .then((c) => live && setPlanCtx({ ...c, key })).catch(() => live && setPlanCtx(null));
        }, 400);
        return () => { live = false; clearTimeout(t); };
    }, [open, values.project, values.env, values.story]);
    /** The workflow's values with what the Studio read: the work item's text, the default style example. */
    const withContext = (v: Record<string, string>): Record<string, string> => {
        if (open !== 'plan' || !planCtx) return v;
        const st = planCtx.story;
        return {
            ...v, seed: v.seed ?? planCtx.seed ?? '',
            ...(st ? { storyContext: `${st.type} ${st.id}: ${st.title} (${st.state})\n${st.description ? `Description:\n${st.description}\n` : ''}${st.acceptanceCriteria ? `Acceptance criteria:\n${st.acceptanceCriteria}` : 'No acceptance criteria on the work item.'}` } : {}),
        };
    };
    const startingRef = React.useRef(false);
    const start = async () => {
        if (!wf || startingRef.current) return;
        const v: Record<string, string> = { ...withContext(values), env: values.env || (meta?.environments[values.project ?? ''] ?? [])[0] || '' };
        // A work item number not read yet: its text would be missing from the plan.
        if (open === 'plan' && /^\d+$/.test(values.story?.trim() ?? '') && !planCtx) { message.info('Reading the work item: start again in a moment.'); return; }
        const missing = wf.fields.filter((f) => f.required && !v[f.key]?.trim()).map((f) => f.label);
        if (missing.length) { message.warning(`Fill in: ${missing.join(', ')}`); return; }
        setStarting(true); startingRef.current = true;
        try {
            const s = await api.agentCreate(`${wf.title}${v.project ? ` (${v.project})` : ''}`, wf.task(v));
            await api.agentSend(s.id, wf.prompt(v));
            setValues((x) => ({ project: x.project ?? '', env: x.env ?? '' }));
            openPanel(s.id);
            refresh();
        } catch (e) { message.error(errText(e)); } finally { setStarting(false); startingRef.current = false; }
    };
    const envs = meta?.environments[values.project ?? ''] ?? [];
    const ready = !!status?.auth?.isAuthenticated && !status.error && !status.policyProblems?.length;
    const pick = (key: string) => { if (key === open) return; setOpen(key); setValues((v) => ({ project: v.project || meta?.projects[0] || '', env: v.env ?? '' })); };
    // A workflow kept from before the page was left: its project is filled in again.
    React.useEffect(() => { if (open && meta && !values.project) setValues((v) => ({ ...v, project: v.project || meta.projects[0] || '' })); }, [open, meta]); // eslint-disable-line react-hooks/exhaustive-deps
    const chats = sessions.filter((s) => !s.id.startsWith('mission-'));
    const workflows = (
        <Row gutter={[12, 12]}>
            <Col xs={24} lg={9}>
                <Card size="small" styles={{ body: { padding: 0 } }}>
                    {WORKFLOWS.map((w) => (
                        <div key={w.key} role="button" tabIndex={0} className={`item-row${open === w.key ? ' selected' : ''}`} onClick={() => pick(w.key)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(w.key); } }}>
                            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}><span style={{ color: '#93186C' }}>{w.icon}</span><span style={{ flex: 1, minWidth: 0 }}><Typography.Text strong>{w.title}</Typography.Text>
                                <Typography.Text type="secondary" ellipsis={{ tooltip: { title: w.about, placement: 'right', mouseEnterDelay: 0.4, styles: { root: { pointerEvents: 'none' } } } }} style={{ fontSize: 12, display: 'block' }}>{w.about}</Typography.Text></span></div>
                        </div>))}
                </Card>
            </Col>
            <Col xs={24} lg={15}>
                {!wf ? <Card size="small"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Choose a workflow on the left." /></Card> : <Card size="small" title={<Space>{wf.icon}{wf.title}</Space>}>
                    <Typography.Paragraph type="secondary" ellipsis={{ rows: 1, expandable: true, symbol: 'more' }} style={{ fontSize: 12, marginTop: -4 }}>{wf.about}</Typography.Paragraph>
                    <Form layout="vertical" size="small">
                        <Row gutter={12}>
                            {wf.fields.filter((f) => f.kind).map((f) => <Col key={f.key} xs={24} md={f.kind === 'seed' ? 24 : 12}><Form.Item label={f.label} required={f.required}
                                tooltip={f.kind === 'seed' ? 'A feature whose structure and step wording the plan follows. The default: STUDIO_SEED_FEATURE in the project\'s configuration.' : undefined}>
                                <Select size="small" style={{ width: '100%' }} value={(f.kind === 'seed' ? (values.seed ?? planCtx?.seed) : values[f.key]) || undefined} aria-label={f.label} onChange={(v) => setValues({ ...values, [f.key]: v ?? '', ...(f.kind === 'project' ? { env: '' } : {}) })}
                                    allowClear={f.kind === 'seed'} showSearch={f.kind === 'seed'}
                                    options={(f.kind === 'project' ? meta?.projects ?? [] : f.kind === 'seed' ? planCtx?.features ?? [] : envs).map((x) => ({ value: x, label: f.kind === 'seed' && planCtx ? x.slice(planCtx.folder.length + 1) : x }))}
                                    placeholder={f.kind === 'env' ? envs[0] : f.kind === 'seed' ? 'None' : undefined} /></Form.Item></Col>)}
                        </Row>
                        {wf.fields.filter((f) => !f.kind).map((f) => <Form.Item key={f.key} label={f.label} required={f.required}>
                            {f.multiline ? <Input.TextArea autoSize={{ minRows: 2, maxRows: 8 }} placeholder={f.placeholder} value={values[f.key] ?? ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} aria-label={f.label} />
                                : <Input placeholder={f.placeholder} value={values[f.key] ?? ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} onPressEnter={() => { if (ready && !starting) void start(); }} aria-label={f.label} />}</Form.Item>)}
                        {wf.key === 'plan' && planCtx?.story && <Alert type="info" showIcon style={{ marginBottom: 10 }}
                            message={<span>{planCtx.story.type} {planCtx.story.id}: <a href={planCtx.story.url} target="_blank" rel="noreferrer noopener">{planCtx.story.title}</a> <Tag bordered={false}>{planCtx.story.state}</Tag></span>}
                            description={planCtx.story.acceptanceCriteria ? <pre className="code-box" style={{ whiteSpace: 'pre-wrap', margin: 0, maxHeight: 180, overflow: 'auto' }}>{planCtx.story.acceptanceCriteria}</pre> : 'No acceptance criteria on the work item: the plan follows its description.'} />}
                        {wf.key === 'plan' && planCtx?.storyError && <Alert type="warning" showIcon style={{ marginBottom: 10 }} message="The work item could not be read here" description={`${planCtx.storyError} The agent will try to read it itself.`} />}
                        <Collapse ghost size="small" items={[{ key: 'p', label: 'What the agent is asked', children: <pre className="code-box" style={{ whiteSpace: 'pre-wrap' }}>{wf.prompt({ ...withContext(values), project: values.project || '<project>', env: values.env || envs[0] || '<env>', story: values.story ?? '', task: values.task ?? '', source: values.source ?? '', journey: values.journey ?? '', screens: values.screens ?? '' })}</pre> }]} />
                        <Tooltip title={ready ? undefined : 'Set up the agents first (Setup & settings tab)'}><Button type="primary" icon={<RocketOutlined />} loading={starting} disabled={!ready} onClick={() => void start()}>Start</Button></Tooltip>
                    </Form>
                </Card>}
            </Col>
        </Row>
    );
    return (
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
            {status?.error && <Alert type="error" showIcon message="The agent runtime could not start" description={status.error} />}
            {!!status?.policyProblems?.length && <Alert type="error" showIcon message="Not allowed by this repository's agent policy" description={<ul style={{ margin: 0, paddingLeft: 18 }}>{status.policyProblems.map((p, i) => <li key={i}>{p}</li>)}{status.policy?.note && <li>{status.policy.note}</li>}</ul>} />}
            {status && !status.error && !status.policyProblems?.length && !status.auth?.isAuthenticated && tab !== 'setup' && <Alert type="info" showIcon message="Agents are not set up on this computer yet: install the runtime and sign in to start a workflow." action={<Button size="small" type="primary" onClick={() => setTab('setup')}>Set up</Button>} />}
            <Tabs size="small" activeKey={tab} onChange={setTab} items={[
                { key: 'workflows', icon: <RocketOutlined />, label: <span>Workflows</span>, children: workflows },
                { key: 'conversations', icon: <MessageOutlined />, label: <span>Conversations <Tag bordered={false} style={{ marginInlineEnd: 0 }}>{chats.length}</Tag></span>, children: (
                    <Card size="small" styles={{ body: { padding: 0 } }} extra={null}>
                        {!chats.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ padding: 16 }} description="None yet: start a workflow, or open Copilot from the top bar." /> : chats.map((s) => (
                            <div key={s.id} role="button" tabIndex={0} className="item-row" style={{ display: 'flex', alignItems: 'center', gap: 8 }} onClick={() => openPanel(s.id)} onKeyDown={(e) => { if (e.key === 'Enter') openPanel(s.id); }}>
                                <Typography.Text ellipsis={{ tooltip: s.title }} style={{ flex: 1, minWidth: 0 }}>{s.busy && <Tag color="processing" bordered={false}>working</Tag>}{s.title}</Typography.Text>
                                <span className="item-id">{ago(s.createdAt)}</span>
                                <Popconfirm title="Delete this conversation?" okText="Delete" okButtonProps={{ danger: true }} onConfirm={(e) => { e?.stopPropagation(); void api.agentDelete(s.id).then(refresh).catch((x) => message.error(errText(x))); }} onCancel={(e) => e?.stopPropagation()}>
                                    <Button size="small" type="text" icon={<DeleteOutlined />} aria-label="Delete conversation" onClick={(e) => e.stopPropagation()} />
                                </Popconfirm>
                            </div>))}
                    </Card>) },
                { key: 'tools', icon: <ApiOutlined />, label: <span>Tool servers</span>, children: <Card size="small"><ToolServers /></Card> },
                { key: 'setup', icon: <SettingOutlined />, label: <span>Setup &amp; settings</span>, children: (
                    <Row gutter={[12, 12]}>
                        <Col xs={24} xl={12}>
                            <Space direction="vertical" style={{ width: '100%' }} size={12}>
                                {status?.settings && <Card size="small" title="Setup">
                                    <Space direction="vertical" style={{ width: '100%' }} size={8}>
                                        <RuntimeSetup status={status} onChange={reload} />
                                        {status.sdk?.installed && !status.error && !status.policyProblems?.length && <AccountSetup status={status} onChange={reload} />}
                                        {status.auth?.isAuthenticated && status.settings.provider === 'copilot' && <Typography.Text type="secondary" style={{ fontSize: 12 }}>Model: GitHub Copilot, {status.settings.model === 'auto' ? 'Auto' : status.settings.model}</Typography.Text>}
                                    </Space>
                                </Card>}
                                {status?.policy && <Card size="small" title={<Space><LockOutlined />Team policy <Tooltip title="Set by the team in the repository (changed through pull requests); personal settings can be stricter, not looser."><Typography.Text type="secondary" className="mono" style={{ fontSize: 12 }}>{status.policy.file}</Typography.Text></Tooltip></Space>}>
                                    <Space direction="vertical" size={4} style={{ fontSize: 13 }}>
                                        {status.policy.note && <Typography.Text>{status.policy.note}</Typography.Text>}
                                        {status.policy.enabled === false && <Tag color="red">Agents off</Tag>}
                                        {!!status.policy.providers?.length && <span>Models from: {status.policy.providers.map((p) => <Tag key={p} bordered={false}>{p === 'copilot' ? 'GitHub Copilot' : 'own endpoint'}</Tag>)}</span>}
                                        {!!status.policy.models?.length && <span>Models: {status.policy.models.map((m) => <Tag key={m} bordered={false}>{m}</Tag>)}</span>}
                                        {!!status.policy.customEndpoints?.length && <span>Endpoints: {status.policy.customEndpoints.map((m) => <Tag key={m} bordered={false} className="mono">{m}</Tag>)}</span>}
                                        {!!Object.keys(status.policy.approvals ?? {}).length && <span>Approvals: {Object.entries(status.policy.approvals ?? {}).map(([k, v]) => <Tag key={k} bordered={false}>{k}: {v === 'deny' ? 'never' : 'always ask'}</Tag>)}</span>}
                                        {!!status.policy.blockedAreas?.length && <span>Studio areas agents cannot use: {status.policy.blockedAreas.map((m) => <Tag key={m} bordered={false}>{m}</Tag>)}</span>}
                                        {!!status.policy.blockedTools?.length && <span>Tools agents cannot use: {status.policy.blockedTools.map((m) => <Tag key={m} bordered={false} className="mono">{m}</Tag>)}</span>}
                                        {!!status.policy.allowedHosts?.length && <span>The Studio browser may open: {status.policy.allowedHosts.map((m) => <Tag key={m} bordered={false} className="mono">{m}</Tag>)}</span>}
                                    </Space></Card>}
                            </Space>
                        </Col>
                        <Col xs={24} xl={12}><Card size="small" title="Settings"><SettingsCard status={status} onSaved={setStatus} onReload={reload} /></Card></Col>
                    </Row>) },
            ]} />
        </Space>
    );
}
