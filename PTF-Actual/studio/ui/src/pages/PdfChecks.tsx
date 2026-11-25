/**
 * PDF checks: pick or add a PDF, see what the framework reads from it, compare it with a test data file, a database
 * query, another PDF or values typed in (whole document, or one record per row), read the differences, and save the
 * check as a test that the framework's PDF steps run.
 */
import React from 'react';
import { Alert, App, Button, Checkbox, Col, Collapse, Empty, Form, Input, InputNumber, Modal, Row, Segmented, Select, Space, Spin, Table, Tabs, Tag, Tooltip, Typography, Upload } from 'antd';
import { CaretRightOutlined, CheckCircleFilled, CloseCircleFilled, ExperimentOutlined, FilePdfOutlined, PlusOutlined, ReloadOutlined, SearchOutlined, UploadOutlined } from '@ant-design/icons';
import { api, baseHashesOf, DbConnections, DbFeaturePreview, PdfCheckBody, PdfCompareDef, PdfFileDef, PdfInspectDef, PdfOptionsDef, PdfSourceDef } from '../api';
import { findingsSummary, PlanReview } from '../components/PlanReview';
import { Split } from '../components/Split';
import { errText, openInEditor, showRun } from '../state';
import { ago } from '../format';
import { usePageHeadTooltip, useStoredTab } from '../datagit-common';

const pref = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : d; } catch { return d; } };
const keep = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };
const kb = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

type Kind = 'file' | 'query' | 'pdf' | 'values';

function SaveTest({ open, onClose, body, project, env }: { open: boolean; onClose: () => void; body: PdfCheckBody | null; project: string; env?: string }) {
    const { message, modal } = App.useApp();
    const [name, setName] = React.useState('PDF check');
    const [p, setP] = React.useState<DbFeaturePreview | null>(null);
    const [err, setErr] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState(false);
    React.useEffect(() => {
        if (!open || !body) return;
        const t = setTimeout(() => { api.pdfFeature({ ...body, name }).then((x) => { setP(x); setErr(null); }).catch((e) => setErr(errText(e))); }, 250);
        return () => clearTimeout(t);
    }, [open, body, name]);
    const doSave = async (run: boolean, force: boolean) => {
        if (!body) return;
        setBusy(true);
        try {
            const r = await api.pdfFeature({ ...body, name, save: true, overwrite: true, baseHashes: baseHashesOf(p?.review), force });
            message.success(`Saved ${r.file}`);
            onClose();
            if (run) { const x = await api.startRun({ project, env: env ?? '', features: [r.file], headless: true, workers: 1 }); showRun(x.id); }
            else openInEditor(r.file, 1);
        } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
    };
    const save = (run: boolean) => {
        if (p?.review?.blocked) modal.confirm({ title: 'Save although the framework check found problems?', content: findingsSummary(p.review), okText: 'Save anyway', okButtonProps: { danger: true }, onOk: () => doSave(run, true) });
        else void doSave(run, false);
    };
    return (
        <Modal open={open} width={900} onCancel={onClose} title={<Space><ExperimentOutlined />Save this check as a test</Space>}
            footer={<Space><Button onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!p} onClick={() => save(false)}>Save and open</Button><Button type="primary" icon={<CaretRightOutlined />} loading={busy} disabled={!p} onClick={() => save(true)}>Save and run</Button></Space>}>
            <Space direction="vertical" style={{ width: '100%' }} size={10}>
                <Input value={name} onChange={(e) => setName(e.target.value)} addonBefore="Name" aria-label="Test name" />
                {err && <Alert type="error" showIcon message={err} />}
                {!p ? <Spin /> : <>
                    <Typography.Text>Uses the framework's PDF comparison steps; saved as <Typography.Text code>{p.file}</Typography.Text>{p.exists && <Typography.Text type="warning"> (replaces the existing file)</Typography.Text>}.</Typography.Text>
                    {p.review ? <PlanReview review={p.review} height={320} /> : <pre className="code-box" style={{ maxHeight: 360 }}>{p.text}</pre>}
                </>}
            </Space>
        </Modal>
    );
}

export function PdfChecks() {
    const { message, modal } = App.useApp();
    const [files, setFiles] = React.useState<PdfFileDef[] | null>(null);
    const [engine, setEngine] = React.useState<'project' | 'studio' | null>(null);
    const [filter, setFilter] = React.useState('');
    const [sel, setSel] = React.useState<string | null>(() => pref('cs-studio-pdf-file', null));
    // The chosen PDF as an object URL (fetched with the token), for View and Open PDF.
    const [pdfUrl, setPdfUrl] = React.useState<string | null>(null);
    React.useEffect(() => {
        if (!sel) { setPdfUrl(null); return; }
        let url: string | null = null, gone = false;
        api.pdfFile(sel).then((u) => { if (gone) URL.revokeObjectURL(u); else { url = u; setPdfUrl(u); } }).catch(() => setPdfUrl(null));
        return () => { gone = true; if (url) URL.revokeObjectURL(url); };
    }, [sel]);
    const [password, setPassword] = React.useState('');
    const [info, setInfo] = React.useState<PdfInspectDef | null>(null);
    const [infoErr, setInfoErr] = React.useState<string | null>(null);
    const [loading, setLoading] = React.useState(false);
    const [meta, setMeta] = React.useState<DbConnections | null>(null);
    const [project, setProject] = React.useState<string>(() => pref('cs-studio-pdf-project', ''));
    const [env, setEnv] = React.useState<string | undefined>(undefined);
    const [kind, setKind] = React.useState<Kind>(() => pref('cs-studio-pdf-kind', 'file'));
    const [file, setFile] = React.useState('');
    const [sheet, setSheet] = React.useState('');
    const [conn, setConn] = React.useState<string | undefined>(undefined);
    const [sql, setSql] = React.useState('');
    const [other, setOther] = React.useState<string | undefined>(undefined);
    const [values, setValues] = React.useState<string[][]>([['label', 'value'], ['', '']]);
    const [records, setRecords] = React.useState(false);
    const [key, setKey] = React.useState('');
    const [o, setO] = React.useState<PdfOptionsDef>({});
    const [res, setRes] = React.useState<PdfCompareDef | null>(null);
    const [resErr, setResErr] = React.useState<string | null>(null);
    const [running, setRunning] = React.useState(false);
    const [saveOpen, setSaveOpen] = React.useState(false);
    const [showMatched, setShowMatched] = React.useState(false);
    usePageHeadTooltip();
    const [detailTab, setDetailTab] = useStoredTab<'compare' | 'read' | 'view'>('pdf-detail', ['compare', 'read', 'view'], 'compare');

    const refresh = React.useCallback(() => { api.pdfList().then((r) => { setFiles(r.files); setEngine(r.engine); }).catch((e) => message.error(errText(e))); }, [message]);
    React.useEffect(() => { refresh(); }, [refresh]);
    React.useEffect(() => {
        api.dbConnections(project || undefined, env).then((m) => {
            setMeta(m);
            if (!project && m.projects[0]) setProject(m.projects[0]);
            if (!env && m.environment) setEnv(m.environment);
        }).catch(() => { /* no projects */ });
    }, [project, env]);
    React.useEffect(() => { keep('cs-studio-pdf-project', project); }, [project]);
    React.useEffect(() => { keep('cs-studio-pdf-kind', kind); }, [kind]);
    React.useEffect(() => { keep('cs-studio-pdf-file', sel); }, [sel]);

    const inspect = React.useCallback((p: string, pw = password) => {
        setLoading(true); setInfo(null); setInfoErr(null); setRes(null);
        api.pdfInspect(p, pw || undefined).then(setInfo).catch((e) => setInfoErr(errText(e))).finally(() => setLoading(false));
    }, [password]);
    React.useEffect(() => { if (sel) inspect(sel); }, [sel]); // eslint-disable-line react-hooks/exhaustive-deps

    const source = (): PdfSourceDef | null => {
        if (kind === 'file') return file.trim() ? { kind, file: file.trim(), ...(sheet.trim() ? { sheet: sheet.trim() } : {}) } : null;
        if (kind === 'query') return conn && sql.trim() ? { kind, connection: conn, sql } : null;
        if (kind === 'pdf') return other ? { kind, file: other } : null;
        return { kind, rows: values };
    };
    const body = () => { const s = source(); return s && sel ? { project, env, pdf: sel, source: s, key: records && key.trim() ? key.trim() : undefined, options: o, password: password || undefined } : null; };
    // The check as it was when "Save as test" was opened (a stable object for the preview).
    const saveBody = React.useMemo(() => (saveOpen ? body() : null), [saveOpen]); // eslint-disable-line react-hooks/exhaustive-deps
    const run = async () => {
        const b = body();
        if (!b) { message.warning({ key: 'pdf-compare-what', content: 'Choose what to compare the PDF with.' }); return; }
        setRunning(true); setResErr(null);
        try { setRes(await api.pdfCompare(b)); } catch (e) { setRes(null); setResErr(errText(e)); } finally { setRunning(false); }
    };
    const upload = async (f: File) => {
        if (!project) { message.warning('Choose a project first.'); return false; }
        if (f.size === 0) { message.error(`${f.name} is empty (0 bytes): choose a PDF file with content.`); return false; }
        const buf = new Uint8Array(await f.arrayBuffer());
        let bin = '';
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        const send = async (replace: boolean) => { const r = await api.pdfUpload(project, f.name, btoa(bin), replace); message.success(`${replace ? 'Replaced' : 'Added'} ${r.path}`); refresh(); setSel(r.path); };
        try { await send(false); }
        catch (e) {
            // A PDF with that name is there: replace it only when the person says so.
            if ((e as { status?: number }).status === 409) modal.confirm({ title: `Replace ${f.name}?`, content: errText(e) + ' Replace it with the file you chose?', okText: 'Replace', okButtonProps: { danger: true }, onOk: () => send(true).catch((x) => message.error(errText(x))) });
            else message.error(errText(e));
        }
        return false;
    };
    const useValue = (label: string, value: string) => { setKind('values'); setValues((v) => [...v.filter((r, i) => i === 0 || r.some((c) => c.trim())), [label, value]]); };

    const q = filter.trim().toLowerCase();
    const shown = (files ?? []).filter((f) => !q || f.path.toLowerCase().includes(q));
    const conns = (meta?.connections ?? []).filter((c) => !c.problems?.length).map((c) => ({ value: c.alias, label: `${c.alias} (${c.type})` }));

    return (
        <><Split id="pdf-checks" initial={300} min={200} max={600}>
            <div className="pdf-list" style={{ display: 'flex', flexDirection: 'column', gap: 8, height: 'calc(100vh - 150px)' }}>
                <Space.Compact>
                    <Input size="small" allowClear prefix={<SearchOutlined />} placeholder="Find a PDF" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Find a PDF" />
                    <Tooltip title="Look again"><Button size="small" icon={<ReloadOutlined />} onClick={refresh} aria-label="Refresh" /></Tooltip>
                    <Upload accept=".pdf,application/pdf" showUploadList={false} beforeUpload={(f) => upload(f)}><Tooltip title="Add a PDF to the project (test/<project>/data/pdf)"><Button size="small" icon={<UploadOutlined />} aria-label="Add a PDF" /></Tooltip></Upload>
                </Space.Compact>
                {engine === 'studio' && <Typography.Text type="secondary" style={{ fontSize: 12 }}>Using the Studio's framework: update the project's framework to use its PDF steps in tests.</Typography.Text>}
                {engine === null && files && <Alert type="warning" showIcon message="This repository's framework has no PDF comparison yet: update it (npm install)." />}
                <div style={{ overflow: 'auto', flex: 1 }}>
                    {files === null ? <Spin /> : !shown.length ? <Empty description={files.length ? 'No PDF matches' : 'No PDFs in this repository yet. Add one, or run a test that downloads one.'} /> :
                        shown.map((f) => (
                            <div key={f.path} className={`pdf-item${f.path === sel ? ' sel' : ''}`} role="button" tabIndex={0} onClick={() => setSel(f.path)} onKeyDown={(e) => { if (e.key === 'Enter') setSel(f.path); }}
                                style={{ padding: '6px 8px', cursor: 'pointer', borderRadius: 6, background: f.path === sel ? 'var(--sel-bg, rgba(147,24,108,.10))' : undefined }}>
                                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}><FilePdfOutlined style={{ color: '#c0392b' }} /><span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.path.split('/').pop()}</span></div>
                                <div style={{ fontSize: 11, opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.path}>{f.path.split('/').slice(0, -1).join('/') || '.'} · {kb(f.size)} · {ago(f.modified)}</div>
                            </div>))}
                </div>
            </div>
            <div style={{ padding: '0 0 0 12px', minWidth: 0 }}>
                {!sel ? <Empty description="Choose a PDF on the left" /> : <>
                    <div className="dg-toolbar" style={{ marginBottom: 8 }}>
                        <Typography.Text strong ellipsis={{ tooltip: sel }} style={{ minWidth: 0, flex: '1 1 200px' }}>{sel}</Typography.Text>
                        {info && <Tag>{info.pages} page{info.pages === 1 ? '' : 's'}</Tag>}
                        <Input.Password size="small" style={{ width: 180 }} placeholder="Password (if encrypted)" value={password} onChange={(e) => setPassword(e.target.value)} onPressEnter={() => sel && inspect(sel)} aria-label="PDF password" />
                        <Button size="small" disabled={!pdfUrl} onClick={() => {
                            if (!pdfUrl || !sel) return;
                            // A page titled with the file's name around the PDF (a bare blob address shows a random id as the title).
                            const w = window.open('', '_blank');
                            if (!w) { window.open(pdfUrl, '_blank', 'noopener'); return; }
                            const name = sel.split('/').pop() ?? 'PDF';
                            w.document.title = name;
                            w.document.body.style.margin = '0';
                            const f = w.document.createElement('iframe');
                            f.src = pdfUrl; f.title = name; f.style.cssText = 'border:0;width:100vw;height:100vh;display:block';
                            w.document.body.appendChild(f);
                        }}>Open PDF</Button>
                    </div>
                    {infoErr && !(engine === null && /framework/i.test(infoErr)) && <Alert type="error" showIcon message={infoErr} style={{ marginBottom: 8 }} />}
                    <Tabs size="small" activeKey={detailTab} onChange={(k) => setDetailTab(k as 'compare' | 'read' | 'view')} items={[
                        { key: 'compare', label: 'Compare', children: (
                            <Space direction="vertical" style={{ width: '100%' }} size={10}>
                                <Form layout="vertical" size="small" className="dg-compact-form" style={{ maxWidth: 820 }}>
                                    <Row gutter={12}>
                                        <Col xs={12} md={6}><Form.Item label="Project"><Select value={project || undefined} placeholder="Project" onChange={(p) => { setProject(p); setEnv(undefined); }} options={(meta?.projects ?? []).map((p) => ({ value: p, label: p }))} aria-label="Project" /></Form.Item></Col>
                                        <Col xs={12} md={6}><Form.Item label="Environment"><Select value={env} placeholder="env" onChange={setEnv} options={(meta?.environments[project] ?? []).map((e) => ({ value: e, label: e }))} aria-label="Environment" /></Form.Item></Col>
                                        <Col xs={24} md={12}><Form.Item label="Compare with"><Segmented value={kind} onChange={(v) => setKind(v as Kind)} options={[{ value: 'file', label: 'Data file' }, { value: 'query', label: 'Database' }, { value: 'pdf', label: 'Another PDF' }, { value: 'values', label: 'Values' }]} /></Form.Item></Col>
                                    </Row>
                                    {kind === 'file' && <Row gutter={12}>
                                        <Col xs={24} md={18}><Form.Item label="Data file" tooltip=".json, .yaml, .csv, .xlsx or .xml, path from the repository root"><Input value={file} maxLength={500} onChange={(e) => setFile(e.target.value)} placeholder={`test/${project || '<project>'}/data/expected.json`} aria-label="Data file" className="mono" /></Form.Item></Col>
                                        <Col xs={24} md={6}><Form.Item label="Excel sheet"><Input value={sheet} maxLength={100} onChange={(e) => setSheet(e.target.value)} placeholder="Sheet1" aria-label="Sheet" /></Form.Item></Col>
                                    </Row>}
                                    {kind === 'query' && <>
                                        <Row gutter={12}><Col xs={24} md={12}><Form.Item label="Connection"><Select value={conn} placeholder="Connection" onChange={setConn} options={conns} aria-label="Connection" notFoundContent="No database connections in this project/environment" /></Form.Item></Col></Row>
                                        <Form.Item label="Query" tooltip={'Name the columns as the PDF prints them (AS "Unit Price"), or map them in the options.'}>
                                            <Input.TextArea rows={3} value={sql} onChange={(e) => setSql(e.target.value)} placeholder="SELECT item AS Item, amount AS Amount FROM invoice_lines WHERE invoice_no = 'INV-1'" aria-label="Query" style={{ fontFamily: 'var(--mono, monospace)' }} />
                                        </Form.Item>
                                    </>}
                                    {kind === 'pdf' && <Form.Item label="Reference PDF" tooltip="The approved PDF this one must match"><Select showSearch value={other} onChange={setOther} placeholder="The approved (reference) PDF" aria-label="Reference PDF"
                                        options={(files ?? []).filter((f) => f.path !== sel).map((f) => ({ value: f.path, label: f.path }))} /></Form.Item>}
                                    {kind === 'values' && <Form.Item label="Expected values" tooltip={'First row: column names. Two columns named label and value check single fields; any other columns are a table. Click "Expect this" under "Read from the PDF" to add a value.'}>
                                        <table className="pdf-values"><tbody>{values.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}><Input size="small" value={c} onChange={(e) => setValues((v) => v.map((rr, ii) => (ii === i ? rr.map((cc, jj) => (jj === j ? e.target.value : cc)) : rr)))} aria-label={`Row ${i + 1} column ${j + 1}`} style={i === 0 ? { fontWeight: 600 } : undefined} /></td>)}</tr>)}</tbody></table>
                                        <Space style={{ marginTop: 6 }}><Button size="small" icon={<PlusOutlined />} onClick={() => setValues((v) => [...v, v[0].map(() => '')])}>Row</Button><Button size="small" icon={<PlusOutlined />} onClick={() => setValues((v) => v.map((r, i) => [...r, i === 0 ? `column ${r.length + 1}` : '']))}>Column</Button></Space>
                                    </Form.Item>}
                                    {kind !== 'pdf' && kind !== 'values' && <Row gutter={12} align="middle">
                                        <Col xs={24} md={14}><Form.Item><Checkbox checked={records} onChange={(e) => setRecords(e.target.checked)}>One record per row (a payslip, statement or letter per row)</Checkbox></Form.Item></Col>
                                        {records && <Col xs={24} md={10}><Form.Item><Input value={key} onChange={(e) => setKey(e.target.value)} placeholder="Key column, e.g. Employee ID" aria-label="Key column" /></Form.Item></Col>}
                                    </Row>}
                                    <Collapse size="small" className="pdf-options" defaultActiveKey={(o.keyColumns?.length || o.tolerance !== undefined || o.dayFirst || o.caseSensitive || o.extraRows || o.pages || o.ignore?.length) ? ['o'] : []}
                                        items={[{ key: 'o', label: 'Options', children: <>
                                            <Row gutter={12}>
                                                <Col xs={24} md={kind === 'pdf' ? 8 : 12}><Form.Item label="Row key columns" tooltip="Match table rows on these columns (in any order)"><Select mode="tags" open={false} value={o.keyColumns ?? []} onChange={(k) => setO({ ...o, keyColumns: k })} placeholder="Type a column, then Enter" aria-label="Row key columns" /></Form.Item></Col>
                                                <Col xs={12} md={kind === 'pdf' ? 4 : 6}><Form.Item label="Tolerance" tooltip="Allowed difference between numbers"><InputNumber min={0} step={0.01} style={{ width: '100%' }} value={o.tolerance} onChange={(v) => setO({ ...o, tolerance: v ?? undefined })} placeholder="0.01" aria-label="Tolerance" /></Form.Item></Col>
                                                <Col xs={12} md={kind === 'pdf' ? 4 : 6}><Form.Item label="Pages"><Input value={o.pages ?? ''} maxLength={50} onChange={(e) => setO({ ...o, pages: e.target.value || undefined })} placeholder="1-3" aria-label="Pages" /></Form.Item></Col>
                                                {kind === 'pdf' && <Col xs={24} md={8}><Form.Item label="Ignore (regex)" tooltip="Regular expressions blanked out before comparing (run IDs, timestamps). Dates with times, Page x of y and GUIDs are ignored already."><Select mode="tags" open={false} value={o.ignore ?? []} onChange={(k) => setO({ ...o, ignore: k })} placeholder="Type a pattern, then Enter" aria-label="Ignore" /></Form.Item></Col>}
                                            </Row>
                                            <Space wrap size={16}>
                                                <Checkbox checked={!!o.dayFirst} onChange={(e) => setO({ ...o, dayFirst: e.target.checked })}>Day first (04/03 = 4 March)</Checkbox>
                                                <Checkbox checked={!!o.caseSensitive} onChange={(e) => setO({ ...o, caseSensitive: e.target.checked })}>Case sensitive</Checkbox>
                                                <Checkbox checked={!!o.extraRows} onChange={(e) => setO({ ...o, extraRows: e.target.checked })}>Fail on extra PDF rows</Checkbox>
                                            </Space>
                                        </> }]} />
                                </Form>
                                <Space>
                                    <Button type="primary" icon={<CaretRightOutlined />} loading={running} onClick={(e) => { if (!running && e.detail < 2) void run(); }}>Compare</Button>
                                    <Button icon={<ExperimentOutlined />} disabled={!body()} onClick={() => setSaveOpen(true)}>Save as test…</Button>
                                </Space>
                                {resErr && <Alert type="error" showIcon message={resErr} />}
                                {res && <div>
                                    <Alert type={res.passed ? 'success' : 'error'} showIcon icon={res.passed ? <CheckCircleFilled /> : <CloseCircleFilled />} message={res.summary}
                                        action={res.reportId ? <Button size="small" onClick={() => void api.openPdfReport(res.reportId!).catch((e) => message.error(errText(e)))}>Full report</Button> : undefined} />
                                    {res.findings.length > 0 && <Table size="small" style={{ marginTop: 8 }} rowKey={(_, i) => String(i)} pagination={res.findings.length > 50 ? { pageSize: 50 } : false} dataSource={res.findings}
                                        columns={[{ title: 'Difference', dataIndex: 'kind', width: 150, render: (k: string) => <Tag color="red">{k.replace(/_/g, ' ').toLowerCase()}</Tag> },
                                            { title: 'Where', dataIndex: 'where' }, { title: 'Page', dataIndex: 'page', width: 60 },
                                            { title: 'Expected', dataIndex: 'expected', render: (v?: string) => <Typography.Text type="success">{v}</Typography.Text> },
                                            { title: 'In the PDF', dataIndex: 'actual', render: (v?: string) => <Typography.Text type="danger">{v}</Typography.Text> },
                                            { title: 'Note', dataIndex: 'note', render: (v?: string) => <Typography.Text type="secondary">{v}</Typography.Text> }]} />}
                                    {res.matched.length > 0 && <Button type="link" size="small" onClick={() => setShowMatched((x) => !x)}>{showMatched ? 'Hide' : 'Show'} the {res.matched.length} matches</Button>}
                                    {showMatched && <Table size="small" rowKey={(_, i) => `m${i}`} pagination={{ pageSize: 50 }} dataSource={res.matched}
                                        columns={[{ title: 'Where', dataIndex: 'where' }, { title: 'Page', dataIndex: 'page', width: 60 }, { title: 'Expected', dataIndex: 'expected' }, { title: 'In the PDF', dataIndex: 'actual' }, { title: 'How', dataIndex: 'how', render: (v?: string) => <Typography.Text type="secondary">{v}</Typography.Text> }]} />}
                                    <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8 }}>The same check in a test:</Typography.Text>
                                    <pre className="code-box">{res.steps.join('\n')}</pre>
                                </div>}
                            </Space>) },
                        { key: 'read', label: 'Read from the PDF', children: loading ? <Spin /> : !info ? <Empty description={infoErr ?? (engine === null ? 'Reading a PDF needs the framework\'s PDF comparison (1.55.0 or later): update the framework (npm install).' : 'Nothing read from this PDF.')} /> : (
                            <Tabs size="small" tabPosition="left" items={[
                                { key: 'fields', label: `Fields (${info.fields.length})`, children: <Table size="small" rowKey={(r) => r.label} pagination={false} dataSource={info.fields}
                                    columns={[{ title: 'Label', dataIndex: 'label' }, { title: 'Value', dataIndex: 'value' }, { title: 'Page', dataIndex: 'page', width: 60 },
                                        { title: '', width: 120, render: (_: unknown, r: { label: string; value: string }) => <Button size="small" type="link" onClick={() => useValue(r.label, r.value)}>Expect this</Button> }]} /> },
                                { key: 'tables', label: `Tables (${info.tables.length})`, children: info.tables.length ? info.tables.map((t, i) => (
                                    <div key={i} style={{ marginBottom: 16 }}><Typography.Text strong>{t.name}</Typography.Text>{t.page ? <Typography.Text type="secondary"> · page {t.page}</Typography.Text> : null}
                                        <Table size="small" rowKey={(_, j) => String(j)} pagination={t.rows.length > 25 ? { pageSize: 25 } : false} scroll={{ x: true }} dataSource={t.rows.map((r) => Object.fromEntries(t.columns.map((c, j) => [`c${j}`, r[j]])))}
                                            columns={t.columns.map((c, j) => ({ title: c, dataIndex: `c${j}` }))} /></div>)) : <Empty description="No table with headed columns found; rows are still matched against the text lines." /> },
                                { key: 'form', label: `Form fields (${info.formFields.length})`, children: <Table size="small" rowKey={(r) => r.name} pagination={false} dataSource={info.formFields}
                                    columns={[{ title: 'Name', dataIndex: 'name' }, { title: 'Label', dataIndex: 'label' }, { title: 'Type', dataIndex: 'type', width: 90 }, { title: 'Value', dataIndex: 'value' },
                                        { title: '', width: 120, render: (_: unknown, r: { name: string; label: string | null; value: string }) => <Button size="small" type="link" onClick={() => useValue(r.label || r.name, r.value)}>Expect this</Button> }]} /> },
                                { key: 'text', label: `Text (${info.linesTotal} lines)`, children: <pre className="code-box" style={{ maxHeight: 'calc(100vh - 300px)', whiteSpace: 'pre-wrap' }}>{info.lines.map((l, i) => `${i === 0 || info.lines[i - 1].page !== l.page ? `— page ${l.page} —\n` : ''}${l.text}`).join('\n')}{info.linesTotal > info.lines.length ? `\n… ${info.linesTotal - info.lines.length} more lines` : ''}</pre> },
                            ]} />) },
                        { key: 'view', label: 'View', children: <iframe title="PDF" src={pdfUrl ?? 'about:blank'} style={{ width: '100%', height: 'calc(100vh - 240px)', border: '1px solid var(--panel-border)', borderRadius: 6 }} /> },
                    ]} />
                </>}
            </div>
        </Split>
        <SaveTest open={saveOpen} onClose={() => setSaveOpen(false)} body={saveBody} project={project} env={env} /></>
    );
}
