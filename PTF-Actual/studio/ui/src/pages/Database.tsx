/**
 * Database: the project's connections (DB_<ALIAS>_* of the chosen environment), queried exactly as the
 * framework's database steps query them (the project's own framework and drivers, in a separate
 * process). Read-only unless changes are allowed (never on protected environments), each change
 * confirmed; tables and columns; saved queries in the project; results to Excel/CSV; a test from a
 * query and its result.
 */
import React from 'react';
import { Alert, App, Button, Checkbox, Drawer, Dropdown, Empty, Input, InputNumber, Modal, Radio, Segmented, Select, Space, Spin, Table, Tabs, Tag, Tooltip, Typography, Popconfirm } from 'antd';
import { CaretRightOutlined, CloseOutlined, CopyOutlined, DatabaseOutlined, DiffOutlined, DeleteOutlined, DownloadOutlined, ExperimentOutlined, FileTextOutlined, FunctionOutlined, KeyOutlined, LockOutlined, ReloadOutlined, SaveOutlined, StopOutlined, TableOutlined, UnlockOutlined, WarningFilled } from '@ant-design/icons';
import { findingsSummary, PlanReview } from '../components/PlanReview';
import { api, ApiError, baseHashesOf, DatePrecisionDef, DbCell, DbColumn, DbColumnInfo, DbCompareResponse, DbConnection, DbConnections, DbFeatureChecks, DbFeaturePreview, DbHistoryItem, DbObject, DbResult, DbSavedQuery } from '../api';
import { useUnsaved } from '../unsaved';
import { errText, filesChanged, openInEditor, showRun } from '../state';
import { navigate, useRoute } from '../route';
import { useAgentContext } from '../agentContext';
import { Split } from '../components/Split';
import { VirtualRows } from '../components/VirtualRows';
import { CodeEditor, CodeEditorHandle } from '../editor/CodeEditor';
import { selectSql } from '../../../src/db/schema';
import { ago } from '../format';
import { cellString, csvText } from '../dbFormat';
import { insertScript, tableOfQuery } from '../../../src/db/inserts';
import { askStaleSave, plural, useStoredTab } from '../datagit-common';
import { datagitApi } from '../datagit-api';
import { useKept } from '../kept';

const pref = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : d; } catch { return d; } };
const savePref = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };
const DB_SIDE_TABS = ['connections', 'objects', 'saved'] as const;
type DbSideTab = typeof DB_SIDE_TABS[number];
type DbResultTab = 'result' | 'history';
/**
 * What the address (#/db/…) says. A saved query: #/db/q/<file> (older links, #/db/test/<project>/queries/<name>.sql,
 * still open it: `legacy`, the address is then corrected). Otherwise the tabs shown: #/db/<side tab>[/history].
 * `valid` false: the address is to be replaced with a valid one (a missing or wrong tab).
 */
export type DbAddress = { kind: 'query'; file: string; legacy?: boolean } | { kind: 'tabs'; side: DbSideTab | null; result: DbResultTab | null; valid: boolean };
export function parseDbRoute(parts: string[]): DbAddress {
    const isSide = (x: string | undefined): x is DbSideTab => (DB_SIDE_TABS as readonly string[]).includes(x ?? '');
    const isResult = (x: string | undefined): x is DbResultTab => x === 'result' || x === 'history';
    if (parts[0] === 'q') return parts.length > 1 ? { kind: 'query', file: parts.slice(1).join('/') } : { kind: 'tabs', side: null, result: null, valid: false };
    if (!parts.length) return { kind: 'tabs', side: null, result: null, valid: false };
    const [a, b] = parts;
    if (isSide(a)) {
        if (parts.length === 1) return { kind: 'tabs', side: a, result: 'result', valid: true };
        if (parts.length === 2 && isResult(b)) return { kind: 'tabs', side: a, result: b, valid: b === 'history' };
        return { kind: 'tabs', side: a, result: null, valid: false };
    }
    if (isResult(a) && parts.length === 1) return { kind: 'tabs', side: null, result: a, valid: false };
    // An older link to a saved query (#/db/test/<project>/queries/<name>.sql).
    if (parts.length > 1 || /\.sql$/i.test(a)) return { kind: 'query', file: parts.join('/'), legacy: true };
    return { kind: 'tabs', side: null, result: null, valid: false };
}
/** The address of the Database screen with no query open: its tabs. */
export const dbHome = (side: DbSideTab, result: DbResultTab) => ['db', side, ...(result === 'history' ? ['history'] : [])];
/** Characters of a query name that do not reach its file name (emoji, punctuation), to say so before saving. */
export function queryNameDropped(name: string): string[] {
    return [...new Set(Array.from(name.normalize('NFC')).filter((c) => !/[\p{L}\p{M}\p{N}\s_-]/u.test(c)))];
}

/** The file name a query name becomes (as the server makes it). */
export const queryFileOf = (name: string) => name.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 120).replace(/-+$/, '');
/** Why the server would refuse this query name, or null. */
export function queryNameProblem(name: string): string | null {
    if (!name.trim()) return null;
    if (/[\\/]|\.\./.test(name)) return 'No "/", "\\" or ".." in the name: the query is saved as one file in the project\'s queries folder. Use letters, digits and spaces.';
    if (!queryFileOf(name)) return 'Use letters or digits in the name (it becomes the file name).';
    return null;
}
const KIND_ICON = { table: <TableOutlined />, view: <FileTextOutlined />, procedure: <FunctionOutlined />, function: <FunctionOutlined /> };
const fmtCount = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1000)}k` : String(n));

function CellView({ c }: { c: DbCell }) {
    if (c === null) return <span className="db-null">NULL</span>;
    if (typeof c === 'boolean') return <span className="db-bool">{String(c)}</span>;
    if (typeof c === 'number') return <span className="db-num">{c}</span>;
    if (typeof c === 'string') return <>{c}</>;
    if (c.$t === 'bin') return <span className="db-bin">0x{c.v}{c.n > 64 ? '…' : ''} <i>({c.n} bytes)</i></span>;
    if (c.$t === 'text') return <>{c.v}<i className="db-more"> … ({c.n.toLocaleString()} characters)</i></>;
    return <span className={c.$t === 'json' ? 'db-json' : c.$t === 'date' ? 'db-date' : 'db-num'}>{c.v}</span>;
}
const csv = csvText;
const download = (blob: Blob, name: string) => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); URL.revokeObjectURL(a.href); };

/** The result grid: fixed-width columns, only visible rows drawn (100 000 rows stay fast). */
function ResultGrid({ r }: { r: DbResult }) {
    const { message } = App.useApp();
    const widths = React.useMemo(() => r.columns.map((col, i) => {
        let w = Math.max(col.name.length, col.type.length) * 7.5 + 28;
        for (const row of r.rows.slice(0, 200)) w = Math.max(w, Math.min(cellString(row[i]).length, 60) * 7.2 + 20);
        return Math.min(Math.max(w, 70), 420);
    }), [r]);
    const total = widths.reduce((a, b) => a + b, 0) + 56;
    if (!r.columns.length) return null;
    return (
        <div className="db-grid" style={{ minWidth: total }}>
            <div className="db-row db-head"><span className="db-cell db-rn">#</span>{r.columns.map((c, i) => <span key={i} className="db-cell" style={{ width: widths[i] }} title={`${c.name} (${c.type})`}><b>{c.name}</b><small>{c.type}</small></span>)}</div>
            <VirtualRows items={r.rows.map((row, i) => ({ row, i }))} rowHeight={26} threshold={200} height="100%" keyOf={(x) => String(x.i)}
                render={({ row, i }) => (
                    <div className="db-row">
                        <span className="db-cell db-rn">{i + 1}</span>
                        {row.map((c, j) => <span key={j} className="db-cell" style={{ width: widths[j] }} title={cellString(c).slice(0, 2000)}
                            onDoubleClick={() => { void navigator.clipboard?.writeText(cellString(c)).then(() => message.success('Copied')); }}><CellView c={c} /></span>)}
                    </div>)} />
        </div>
    );
}

function FeatureModal({ open, onClose, project, env, alias, file, sql, params, result }: { open: boolean; onClose: () => void; project: string; env: string; alias: string; file?: string; sql: string; params: string[]; result: DbResult }) {
    const { message, modal } = App.useApp();
    const [name, setName] = React.useState('');
    const [checks, setChecks] = React.useState<DbFeatureChecks>({ rowCount: 'exact', columns: true, rows: 0, firstRow: true });
    const [p, setP] = React.useState<DbFeaturePreview | null>(null);
    const [err, setErr] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState(false);
    const canTable = !result.truncated && result.total > 0 && result.total <= 50;
    React.useEffect(() => {
        if (!open) return;
        setName(file ? file.split('/').pop()!.replace(/\.sql$/i, '').replace(/[-_]+/g, ' ') : `${alias.toLowerCase()} query check`);
        setChecks({ rowCount: 'exact', columns: true, rows: canTable && result.total <= 10 ? result.total : 0, firstRow: !(canTable && result.total <= 10) && result.total > 0 });
    }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
    const body = React.useCallback((save?: boolean) => ({ project, name: name.trim() || 'query check', alias, file, sql, params, result: { columns: result.columns, rows: result.rows.slice(0, 50), total: result.total, truncated: result.truncated }, checks, save, overwrite: save, env }), [project, name, alias, file, sql, params, result, checks, env]);
    React.useEffect(() => {
        if (!open) return;
        const t = setTimeout(() => { api.dbFeature(body()).then((x) => { setP(x); setErr(null); }).catch((e) => setErr(errText(e))); }, 250);
        return () => clearTimeout(t);
    }, [open, body]);
    const save = (run: boolean) => {
        if (p?.review?.blocked) modal.confirm({ title: 'Save although the framework check found problems?', content: findingsSummary(p.review), okText: 'Save anyway', okButtonProps: { danger: true }, onOk: () => doSave(run, true) });
        else void doSave(run, false);
    };
    const doSave = async (run: boolean, force: boolean) => {
        setBusy(true);
        try {
            const r = await api.dbFeature({ ...body(true), baseHashes: baseHashesOf(p?.review), force });
            message.success(`Saved ${r.file}`);
            onClose();
            if (run) { const x = await api.startRun({ project, env, features: [r.file], headless: true, workers: 1 }); showRun(x.id); }
            else openInEditor(r.file, 1);
        } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
    };
    return (
        <Modal open={open} width={920} onCancel={onClose} title={<Space><ExperimentOutlined />Create a test from this query</Space>}
            footer={<Space><Button onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!p} onClick={() => void save(false)}>Save and open</Button><Button type="primary" icon={<CaretRightOutlined />} loading={busy} disabled={!p} onClick={() => void save(true)}>Save and run</Button></Space>}>
            <Space direction="vertical" style={{ width: '100%' }} size={10}>
                <Input value={name} onChange={(e) => setName(e.target.value)} addonBefore="Name" aria-label="Test name" />
                <div className="db-checks">
                    <span>Row count</span>
                    <Radio.Group size="small" value={checks.rowCount} onChange={(e) => setChecks({ ...checks, rowCount: e.target.value })} options={[{ value: 'exact', label: `exactly ${result.total}` }, { value: 'atLeast', label: `at least ${result.total}` }, { value: 'none', label: 'no check' }]} optionType="button" />
                    <Checkbox checked={checks.columns} onChange={(e) => setChecks({ ...checks, columns: e.target.checked })}>The columns</Checkbox>
                    <Tooltip title={canTable ? 'Every row and value, as a table (the step also checks the row count)' : `Needs all rows (at most 50); this result has ${result.total}${result.truncated ? ', not all fetched' : ''}`}>
                        <Checkbox disabled={!canTable} checked={checks.rows > 0} onChange={(e) => setChecks({ ...checks, rows: e.target.checked ? result.total : 0 })}>All rows and values</Checkbox>
                    </Tooltip>
                    <Checkbox disabled={!result.total} checked={checks.firstRow} onChange={(e) => setChecks({ ...checks, firstRow: e.target.checked })}>First-row values</Checkbox>
                </div>
                {err && <Alert type="error" showIcon message={err} />}
                {!p ? <Spin /> : <>
                    <Typography.Text>Uses only the framework's database steps; saved as <Typography.Text code>{p.file}</Typography.Text>{p.exists && <Typography.Text type="warning"> (replaces the existing file)</Typography.Text>}. The values come from this result: the test fails when the data changes.</Typography.Text>
                    {p.review ? <PlanReview review={p.review} height={340} /> : <>
                        {p.warnings.length > 0 && <Alert type="warning" showIcon message={`${p.warnings.length} thing${p.warnings.length === 1 ? '' : 's'} to look at`} description={<ul style={{ margin: 0, paddingLeft: 18 }}>{p.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>} />}
                        <pre className="code-box" style={{ maxHeight: 380 }}>{p.text}</pre></>}
                </>}
            </Space>
        </Modal>
    );
}

/** A generated script: copy, download, or open it in the editor. */
function ScriptModal({ open, title, sql, warnings, onClose, onEditor }: { open: boolean; title: string; sql: string; warnings?: string[]; onClose: () => void; onEditor: (t: string) => void }) {
    const { message } = App.useApp();
    return (
        <Modal open={open} width={900} onCancel={onClose} title={<Space><FileTextOutlined />{title}</Space>}
            footer={<Space><Button icon={<CopyOutlined />} disabled={!sql} onClick={() => void navigator.clipboard?.writeText(sql).then(() => message.success('Copied'))}>Copy</Button>
                <Button icon={<DownloadOutlined />} disabled={!sql} onClick={() => download(new Blob([sql], { type: 'text/plain' }), `${title.replace(/[^\w.-]+/g, '_')}.sql`)}>Download</Button>
                <Button type="primary" disabled={!sql} onClick={() => onEditor(sql)}>Open in the editor</Button></Space>}>
            {warnings?.length ? <Alert type="warning" showIcon style={{ marginBottom: 8 }} message={<ul style={{ margin: 0, paddingLeft: 18 }}>{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>} /> : null}
            {!sql ? <Spin /> : <pre className="code-box" style={{ maxHeight: 520 }}>{sql}</pre>}
        </Modal>
    );
}

/** INSERT statements for a result: target table, columns, rows per statement (SQL Server: identity insert). */
function InsertModal({ open, onClose, result, sql, onEditor }: { open: boolean; onClose: () => void; result: DbResult; sql: string; onEditor: (t: string) => void }) {
    const [table, setTable] = React.useState(() => tableOfQuery(sql) || 'my_table');
    const [cols, setCols] = React.useState<string[]>(() => result.columns.map((c) => c.name));
    const [per, setPer] = React.useState(1);
    const [identity, setIdentity] = React.useState(false);
    const out = React.useMemo(() => { try { return { ...insertScript(result.type, result.columns, result.rows, { table, columns: cols, rowsPerStatement: per, identityInsert: identity }), error: null }; } catch (e) { return { sql: '', statements: 0, warnings: [], error: (e as Error).message }; } }, [result, table, cols, per, identity]);
    const { message } = App.useApp();
    return (
        <Modal open={open} width={960} onCancel={onClose} title={<Space><FileTextOutlined /><span>{`INSERT script (${result.rows.length.toLocaleString()} row${result.rows.length === 1 ? '' : 's'})`}</span></Space>}
            footer={<Space><Button icon={<CopyOutlined />} disabled={!out.sql} onClick={() => void navigator.clipboard?.writeText(out.sql).then(() => message.success('Copied'))}>Copy</Button>
                <Button icon={<DownloadOutlined />} disabled={!out.sql} onClick={() => download(new Blob([out.sql], { type: 'text/plain' }), `insert-${table.replace(/[^\w.-]+/g, '_')}.sql`)}>Download</Button>
                <Button type="primary" disabled={!out.sql} onClick={() => onEditor(out.sql)}>Open in the editor</Button></Space>}>
            <Space direction="vertical" style={{ width: '100%' }}>
                <div className="db-checks">
                    <Input size="small" style={{ width: 280 }} addonBefore="Into" value={table} onChange={(e) => setTable(e.target.value)} aria-label="Target table" />
                    <Select size="small" style={{ width: 190 }} value={per} onChange={setPer} aria-label="Rows per statement" options={[1, 10, 100, 500, 1000].map((n) => ({ value: n, label: n === 1 ? 'One INSERT per row' : `${n} rows per INSERT` }))} />
                    {result.type === 'sqlserver' && <Tooltip title="Explicit values for an IDENTITY column"><Checkbox checked={identity} onChange={(e) => setIdentity(e.target.checked)}>SET IDENTITY_INSERT</Checkbox></Tooltip>}
                    {result.truncated && <Typography.Text type="warning">Only the {result.rows.length.toLocaleString()} rows shown are included.</Typography.Text>}
                </div>
                <Select size="small" mode="multiple" style={{ width: '100%' }} value={cols} onChange={setCols} maxTagCount="responsive" aria-label="Columns" placeholder="Columns"
                    options={result.columns.map((c) => ({ value: c.name, label: c.name }))} />
                {out.error && <Alert type="error" showIcon message={out.error} />}
                {out.warnings.length > 0 && <Alert type="warning" showIcon message={<ul style={{ margin: 0, paddingLeft: 18 }}>{out.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>} />}
                <pre className="code-box" style={{ maxHeight: 440 }}>{out.sql.length > 400000 ? `${out.sql.slice(0, 400000)}\n… (${out.statements.toLocaleString()} statements: Copy or Download for all of it)` : out.sql}</pre>
            </Space>
        </Modal>
    );
}

/** version: what the saved query held when it was opened or saved here (a save over a change made since is refused). */
interface Editor { file: string | null; text: string; dirty: boolean; version?: string }


/** A query name for the configuration: DB_QUERY_<NAME> (letters, digits, _). */
const queryKey = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'QUERY';


const DATES: Array<{ value: DatePrecisionDef; label: string }> = [{ value: 'exact', label: 'Exact' }, { value: 'second', label: 'To the second' }, { value: 'minute', label: 'To the minute' }, { value: 'day', label: 'Same day' }];
const IGNORE_HELP = 'Columns left out: names or patterns (* any characters, ? one): *_at, audit_*, created_?y; one table\'s column with its name: orders.notes, *.row_version';

type CmpPair = { name: string; source?: { schema: string; name: string; rows?: number }; target?: { schema: string; name: string; rows?: number } };
type CmpTable = { result: DbCompareResponse['result']; keys: string[]; keyKind: string; idColumns?: string[]; primaryKey?: string[]; source: { rows: number; truncated: boolean; columns: string[] }; target: { rows: number; truncated: boolean; columns: string[] };
    side: { columns: string[]; targetColumn: Record<string, string>; truncated: boolean; rows: Array<{ key: string; status: 'differs' | 'missing' | 'extra' | 'same'; source?: Record<string, unknown>; target?: Record<string, unknown>; differing: string[] }> } };
const cellText = (v: unknown) => (v === null || v === undefined ? 'NULL' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/**
 * The tables of two databases (two environments, or two connections): paired by name; each table's rows matched by its
 * primary key (or every column without one), compared as data; a table's rows side by side, its differences marked.
 */
function TablesCompare({ project, env, src, tgt }: { project: string; env: string; src: { alias: string; env: string }; tgt: { alias: string; env: string } }) {
    const [pairs, setPairs] = React.useState<CmpPair[] | null>(null);
    const [picked, setPicked] = React.useState<string[]>([]);
    const [results, setResults] = React.useState<Record<string, CmpTable | { error: string } | 'running'>>({});
    const { message } = App.useApp();
    const [opts, setOpts] = React.useState({ ignore: [] as string[], tolerance: 0, ignoreCase: false, trim: true, idsDiffer: false, dates: 'exact' as DatePrecisionDef });
    // The project's rules (DB_COMPARE_IGNORE, DB_COMPARE_DATES), as the framework's steps apply them.
    const [rulesFile, setRulesFile] = React.useState('');
    React.useEffect(() => { api.dbCompareRules(project, env).then((r) => { setOpts((o) => ({ ...o, ignore: r.ignore, dates: r.dates })); setRulesFile(r.file); }).catch(() => {}); }, [project, env]);
    const saveRules = async () => { try { const r = await api.dbSaveCompareRules(project, opts.ignore, opts.dates); message.success(`Saved in ${r.file}: the ignored columns and the date precision apply to every comparison of the project (here and in tests). Tolerance, case, trim and ids are chosen per comparison.`, 6); } catch (e) { setErr(errText(e)); } };
    // A business key chosen per table (the ids differ between environments): table → columns.
    const [keysOf, setKeysOf] = React.useState<Record<string, string[]>>({});
    const [busy, setBusy] = React.useState(false);
    const [err, setErr] = React.useState<string | null>(null);
    const [open, setOpen] = React.useState<string | null>(null);
    const [showSame, setShowSame] = React.useState(false);
    const stopRef = React.useRef(false);
    const sides = { source: { env: src.env, alias: src.alias }, target: { env: tgt.env, alias: tgt.alias } };
    React.useEffect(() => { setPairs(null); setResults({}); setOpen(null); }, [src.alias, src.env, tgt.alias, tgt.env]);
    const listTables = async () => {
        setBusy(true); setErr(null); setResults({}); setOpen(null);
        try { const r = await api.dbCompareTables({ project, env, ...sides }); setPairs(r.pairs); setPicked(r.pairs.filter((p) => p.source && p.target).map((p) => p.name)); }
        catch (e) { setErr(errText(e)); setPairs(null); } finally { setBusy(false); }
    };
    const one = async (p: CmpPair, same = false, keys = keysOf[p.name]) => {
        setResults((m) => ({ ...m, [p.name]: 'running' }));
        try {
            const r = await api.dbCompareTable({ project, env, source: { ...sides.source, table: p.source! }, target: { ...sides.target, table: p.target! }, options: { ...opts, ...(keys?.length ? { keys } : {}) }, same });
            setResults((m) => ({ ...m, [p.name]: r }));
        } catch (e) { setResults((m) => ({ ...m, [p.name]: { error: errText(e) } })); }
    };
    const compareAll = async () => {
        if (!pairs) return;
        setBusy(true); stopRef.current = false;
        for (const p of pairs.filter((x) => picked.includes(x.name) && x.source && x.target)) { if (stopRef.current) break; await one(p); }
        setBusy(false);
    };
    const done = Object.values(results).filter((x): x is CmpTable => typeof x === 'object' && 'result' in x);
    const differ = done.filter((x) => !x.result.passed).length;
    const failed = Object.values(results).filter((x) => typeof x === 'object' && 'error' in x).length;
    const cur = open ? results[open] : undefined;
    const curT = cur && typeof cur === 'object' && 'result' in cur ? cur : null;
    const statusTag = (p: CmpPair) => {
        if (!p.target) return <Tag bordered={false} color="orange">only in source</Tag>;
        if (!p.source) return <Tag bordered={false} color="orange">only in target</Tag>;
        const r = results[p.name];
        if (!r) return null;
        if (r === 'running') return <Spin size="small" />;
        if ('error' in r) return <Tooltip title={r.error}><Tag bordered={false} color="red">error</Tag></Tooltip>;
        const x = r.result;
        return x.passed ? <Tag bordered={false} color="green">same</Tag>
            : <Space size={2} wrap><Tag bordered={false} color="red">differs</Tag>
                {x.rowsDiffering > 0 && <Tag bordered={false}>{x.rowsDiffering} changed</Tag>}
                {x.missingInTarget.length > 0 && <Tag bordered={false}>{x.missingInTarget.length} missing</Tag>}
                {x.extraInTarget.length > 0 && <Tag bordered={false}>{x.extraInTarget.length} extra</Tag>}
                {(x.duplicateKeys.source.length > 0 || x.duplicateKeys.target.length > 0) && <Tag bordered={false} color="orange">keys not unique</Tag>}</Space>;
    };
    return (
        <Space direction="vertical" style={{ width: '100%' }} size={8}>
            <div className="db-cmp-opts">
                <Tooltip title={IGNORE_HELP}><span>Ignore</span></Tooltip>
                <Select size="small" mode="tags" style={{ minWidth: 220 }} value={opts.ignore} onChange={(k) => setOpts({ ...opts, ignore: k })} placeholder="*_at, audit_*, orders.notes" tokenSeparators={[',', ' ']} aria-label="Ignored columns (every table)" />
                <Tooltip title="Dates and times compared exactly, or to the second, minute or day (load times, time zones)"><span>Dates</span></Tooltip>
                <Select size="small" style={{ width: 130 }} value={opts.dates} onChange={(d) => setOpts({ ...opts, dates: d })} options={DATES} aria-label="Date precision (tables)" />
                <Tooltip title="Numbers equal within this difference"><span>Tolerance</span></Tooltip>
                <InputNumber size="small" min={0} step={0.01} style={{ width: 90 }} value={opts.tolerance} onChange={(v) => setOpts({ ...opts, tolerance: Number(v ?? 0) })} aria-label="Tolerance (tables)" />
                <Checkbox checked={opts.ignoreCase} onChange={(e) => setOpts({ ...opts, ignoreCase: e.target.checked })}>Ignore case</Checkbox>
                <Checkbox checked={opts.trim} onChange={(e) => setOpts({ ...opts, trim: e.target.checked })}>Trim</Checkbox>
                <Tooltip title="Generated ids (identity, sequence, UUID) are not the same in each environment: the primary key and the id columns (id, …_id) are left out, and rows match by their other columns, or by the business key chosen for the table (Key)">
                    <Checkbox checked={opts.idsDiffer} onChange={(e) => setOpts({ ...opts, idsDiffer: e.target.checked })}>Ids differ between environments</Checkbox></Tooltip>
                <span style={{ flex: 1 }} />
                <Tooltip title={`Keep the ignored columns and the date precision for the project (${rulesFile || 'common.env'}: DB_COMPARE_IGNORE, DB_COMPARE_DATES): every comparison uses them, here and in the framework's steps. Tolerance, case, trim and ids stay per comparison.`}>
                    <Button size="small" onClick={() => void saveRules()}>Save as project rules</Button></Tooltip>
                <Button size="small" loading={busy && !pairs} disabled={!src.alias || !tgt.alias} onClick={() => void listTables()}>List tables</Button>
                {pairs && (busy ? <Button size="small" danger icon={<StopOutlined />} onClick={() => { stopRef.current = true; }}>Stop</Button>
                    : <Button size="small" type="primary" icon={<CaretRightOutlined />} disabled={!picked.length} onClick={() => void compareAll()}>Compare {picked.length} table{picked.length === 1 ? '' : 's'}</Button>)}
            </div>
            {err && <Alert type="error" showIcon message={<pre className="db-error">{err}</pre>} />}
            {pairs && (done.length > 0 || failed > 0) && <Alert type={differ || failed ? 'error' : 'success'} showIcon
                message={`${done.length} of ${picked.length} tables compared: ${done.length - differ} the same, ${differ} differ${failed ? `, ${failed} could not be read` : ''}.`}
                description={`${src.alias} (${src.env}) and ${tgt.alias} (${tgt.env}). ${pairs.filter((p) => !p.source || !p.target).length ? `${pairs.filter((p) => !p.source || !p.target).length} table(s) in one only.` : ''}`} />}
            {pairs && <Table<CmpPair> size="small" rowKey="name" pagination={pairs.length > 50 ? { pageSize: 50 } : false} dataSource={pairs} scroll={{ y: 300 }}
                rowSelection={{ selectedRowKeys: picked, onChange: (k) => setPicked(k as string[]), getCheckboxProps: (p) => ({ disabled: !p.source || !p.target, name: p.name }) }}
                onRow={(p) => ({ onClick: () => { const r = results[p.name]; if (r && typeof r === 'object' && 'result' in r) setOpen(p.name); }, style: { cursor: results[p.name] && typeof results[p.name] === 'object' && 'result' in (results[p.name] as object) ? 'pointer' : undefined } })}
                columns={[
                    { title: 'Table', dataIndex: 'name', render: (n: string) => <span className="mono">{n}</span> },
                    { title: `Rows (${src.env})`, width: 110, align: 'right', render: (_v, p) => { const r = results[p.name]; return r && typeof r === 'object' && 'result' in r ? r.source.rows.toLocaleString() : p.source ? (p.source.rows ? `~${p.source.rows.toLocaleString()}` : '') : '—'; } },
                    { title: `Rows (${tgt.env})`, width: 110, align: 'right', render: (_v, p) => { const r = results[p.name]; return r && typeof r === 'object' && 'result' in r ? r.target.rows.toLocaleString() : p.target ? (p.target.rows ? `~${p.target.rows.toLocaleString()}` : '') : '—'; } },
                    { title: <Tooltip title="How a row of one environment finds its row in the other. Choose a business key (order_number, email…) when the ids differ.">Key</Tooltip>, width: 230, render: (_v, p) => {
                        const r = results[p.name];
                        if (!r || typeof r !== 'object' || !('result' in r)) return keysOf[p.name]?.length ? <span className="mono" style={{ fontSize: 12 }}>{keysOf[p.name].join(', ')}</span> : null;
                        const shown = r.keyKind === 'chosen' ? r.keys : [];
                        return <span onClick={(e) => e.stopPropagation()}><Select size="small" mode="multiple" style={{ width: 210 }} maxTagCount={2} value={shown} aria-label={`Key of ${p.name}`}
                            placeholder={r.keyKind === 'primary key' ? `${r.keys.join(', ')} (primary key)` : r.keyKind === 'all columns' ? '(every column)' : '(the other columns)'}
                            options={r.source.columns.map((c) => ({ value: c, label: c }))}
                            onChange={(k: string[]) => { setKeysOf((m) => ({ ...m, [p.name]: k })); void one(p, false, k); }} /></span>;
                    } },
                    { title: 'Result', width: 300, render: (_v, p) => statusTag(p) },
                ]} />}
            {curT && open && <div className="db-sbs">
                <div className="db-sbs-head">
                    <b className="mono">{open}</b>
                    <span>{curT.result.matched.toLocaleString()} matched · {curT.result.rowsDiffering} changed · {curT.result.missingInTarget.length} missing in {tgt.env} · {curT.result.extraInTarget.length} only in {tgt.env}</span>
                    {(curT.source.truncated || curT.target.truncated) && <Typography.Text type="warning">Only the first rows were read.</Typography.Text>}
                    <span style={{ flex: 1 }} />
                    <Checkbox checked={showSame} onChange={(e) => { setShowSame(e.target.checked); const p = pairs?.find((x) => x.name === open); if (p) void one(p, e.target.checked); }}>Show matching rows</Checkbox>
                    <Button size="small" type="text" icon={<CloseOutlined />} aria-label="Close the side-by-side view" onClick={() => setOpen(null)} />
                </div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>Rows matched by {curT.keyKind === 'other columns (ids left out)' ? 'their other columns' : curT.keyKind === 'all columns' ? 'every column' : <span className="mono">{curT.keys.join(', ')}</span>}{curT.keyKind === 'primary key' ? ' (primary key)' : ''}{curT.idColumns?.length ? <>; ids left out (they differ between environments): <span className="mono">{curT.idColumns.join(', ')}</span></> : ''}.{curT.keyKind === 'other columns (ids left out)' ? ' A changed row shows as missing and extra: choose a business key (Key) to see the changed cells.' : ''}</Typography.Text>
                {(curT.result.onlyInSource.length > 0 || curT.result.onlyInTarget.length > 0) && <Typography.Text type="secondary" style={{ fontSize: 12 }}>Columns in one only (not compared): {[...curT.result.onlyInSource.map((c) => `${c} (${src.env})`), ...curT.result.onlyInTarget.map((c) => `${c} (${tgt.env})`)].join(', ')}</Typography.Text>}
                {!curT.side.rows.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Every row matches" /> :
                    <div className="db-sbs-grid" role="table" aria-label={`${open} side by side`}>
                        <div className="db-sbs-row db-sbs-h" role="row">
                            <span className="db-sbs-key" role="columnheader">Row</span>
                            <span className="db-sbs-side" role="columnheader">{src.alias} · {src.env}</span>
                            <span className="db-sbs-side" role="columnheader">{tgt.alias} · {tgt.env}</span>
                        </div>
                        <div className="db-sbs-row db-sbs-h db-sbs-cols" role="row">
                            <span className="db-sbs-key" />
                            <span className="db-sbs-side">{curT.side.columns.map((c) => <span key={c} className="db-sbs-c">{c}</span>)}</span>
                            <span className="db-sbs-side">{curT.side.columns.map((c) => <span key={c} className="db-sbs-c">{curT.side.targetColumn[c] ?? c}</span>)}</span>
                        </div>
                        {curT.side.rows.map((x) => (
                            <div key={`${x.status}-${x.key}`} className={`db-sbs-row db-sbs-${x.status}`} role="row">
                                <span className="db-sbs-key mono" title={x.key}>{x.key}{x.status !== 'differs' && x.status !== 'same' ? <Tag bordered={false} color="orange" style={{ marginLeft: 4 }}>{x.status === 'missing' ? `not in ${tgt.env}` : `only in ${tgt.env}`}</Tag> : null}</span>
                                <span className="db-sbs-side">{curT.side.columns.map((c) => <span key={c} className={`db-sbs-c mono${x.differing.includes(c) ? ' db-sbs-diff' : ''}${x.source ? '' : ' db-sbs-none'}`} title={x.source ? cellText(x.source[c]) : ''}>{x.source ? cellText(x.source[c]) : '—'}</span>)}</span>
                                <span className="db-sbs-side">{curT.side.columns.map((c) => { const tc = curT.side.targetColumn[c] ?? c; return <span key={c} className={`db-sbs-c mono${x.differing.includes(c) ? ' db-sbs-diff' : ''}${x.target ? '' : ' db-sbs-none'}`} title={x.target ? cellText(x.target[tc]) : ''}>{x.target ? cellText(x.target[tc]) : '—'}</span>; })}</span>
                            </div>))}
                        {curT.side.truncated && <Typography.Text type="secondary" style={{ fontSize: 12, padding: 6 }}>The first {curT.side.rows.length} rows that differ are shown.</Typography.Text>}
                    </div>}
            </div>}
        </Space>);
}

/**
 * Compare data: a source query and a target query (two connections, or two tables of one), their rows matched by
 * key columns and compared as data (numbers, dates, booleans across databases), and their vital checks. The step
 * that checks the same in a test, with its queries as DB_QUERY_ settings.
 */
function CompareDrawer({ open, onClose, project, env, envs, conns, alias, sql }: { open: boolean; onClose: () => void; project: string; env: string; envs: string[]; conns: DbConnection[]; alias?: string; sql: string }) {
    const { message } = App.useApp();
    const [src, setSrc] = React.useState({ alias: alias ?? '', sql, env });
    const [tgt, setTgt] = React.useState({ alias: alias ?? '', sql: '', env });
    // Opened again: both sides start from the connection chosen on the screen (and the current query).
    React.useEffect(() => {
        if (!open || !alias) return;
        setSrc((x) => ({ ...x, alias, sql: sql || x.sql }));
        setTgt((x) => ({ ...x, alias }));
    }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
    // The connections of each side's environment (the screen's are known).
    const [connsOf, setConnsOf] = React.useState<Record<string, DbConnection[]>>({});
    React.useEffect(() => { setConnsOf((m) => ({ ...m, [env]: conns })); }, [env, conns]);
    // Another environment on the screen: both sides start from it (a side's own choice is made in the drawer).
    const screenEnv = React.useRef(env);
    React.useEffect(() => {
        if (screenEnv.current === env) return;
        const was = screenEnv.current; screenEnv.current = env;
        setSrc((x) => (x.env === was ? { ...x, env } : x)); setTgt((x) => (x.env === was ? { ...x, env } : x));
    }, [env]);
    React.useEffect(() => {
        for (const e of [src.env, tgt.env]) if (e && !connsOf[e]) api.dbConnections(project, e).then((r) => setConnsOf((m) => ({ ...m, [e]: r.connections }))).catch(() => setConnsOf((m) => ({ ...m, [e]: [] })));
    }, [project, src.env, tgt.env]); // eslint-disable-line react-hooks/exhaustive-deps
    const [o, setO] = React.useState<{ keys: string[]; ignore: string[]; map: string; tolerance: number; ignoreCase: boolean; trim: boolean; dates: DatePrecisionDef }>({ keys: [], ignore: [], map: '', tolerance: 0, ignoreCase: false, trim: true, dates: 'exact' });
    React.useEffect(() => { if (open) api.dbCompareRules(project, env).then((r) => setO((x) => (x.ignore.length || x.dates !== 'exact' ? x : { ...x, ignore: r.ignore, dates: r.dates }))).catch(() => {}); }, [open, project, env]); // eslint-disable-line react-hooks/exhaustive-deps
    const [busy, setBusy] = React.useState(false);
    const [res, setRes] = React.useState<DbCompareResponse | null>(null);
    const [err, setErr] = React.useState<string | null>(null);
    const [tab, setTab] = React.useState('diff');
    // Whole tables of the two databases (default), or a query on each side.
    const [mode, setMode] = React.useState<'tables' | 'query'>('tables');
    React.useEffect(() => { if (open) { setSrc((x) => ({ ...x, alias: x.alias || alias || '', sql: x.sql || sql, env: x.env || env })); setTgt((x) => ({ ...x, alias: x.alias || alias || '', env: x.env || env })); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
    const readyIn = (e: string) => (connsOf[e] ?? []).filter((c) => !c.problems.length && c.driverInstalled).map((c) => ({ value: c.alias, label: c.alias }));
    const crossEnv = src.env !== tgt.env;
    const cols = res ? [...new Set([...res.source.columns])] : [];
    const mapList = o.map.split(',').map((x) => x.trim()).filter(Boolean);
    const run = async () => {
        setBusy(true); setErr(null);
        try {
            const r = await api.dbCompare({ project, env, source: src, target: tgt, options: { keys: o.keys, ignore: o.ignore, map: mapList, tolerance: o.tolerance, ignoreCase: o.ignoreCase, trim: o.trim, dates: o.dates } });
            setRes(r); setTab(r.result.passed ? (r.vitals.passed ? 'step' : 'vitals') : 'diff');
        } catch (e) { setErr(errText(e)); setRes(null); } finally { setBusy(false); }
    };
    const one = (t: string) => t.replace(/\s+/g, ' ').trim();
    const sk = `${queryKey(src.alias)}_COMPARE_SOURCE`, tk = `${queryKey(tgt.alias)}_COMPARE_TARGET`;
    const opts: Array<[string, string]> = [
        ...(o.keys.length ? [['keys', o.keys.join(', ')] as [string, string]] : []),
        ...(o.ignore.length ? [['ignore', o.ignore.join(', ')] as [string, string]] : []),
        ...(mapList.length ? [['map', mapList.join(', ')] as [string, string]] : []),
        ...(o.tolerance ? [['tolerance', String(o.tolerance)] as [string, string]] : []),
        ...(o.ignoreCase ? [['ignore case', 'yes'] as [string, string]] : []),
        ...(!o.trim ? [['trim', 'no'] as [string, string]] : []),
        ...(o.dates !== 'exact' ? [['dates', o.dates] as [string, string]] : []),
    ];
    const w = Math.max(5, ...opts.map(([k]) => k.length)), wv = Math.max(5, ...opts.map(([, v]) => v.length));
    // Each side in its environment when they differ (else the test's environment, whichever it runs in).
    const inEnv = (e: string) => (crossEnv ? ` in "${e}"` : '');
    const stepText = [
        crossEnv ? `# config/${project}/common/common.env (both environments read them; each side connects with its environment's DB_ settings)` : '# config/<project>/common/common.env (or the environment\'s file)',
        `DB_QUERY_${sk}=${one(src.sql)}`,
        `DB_QUERY_${tk}=${one(tgt.sql)}`,
        '',
        `Then the database query "${sk}" on "${src.alias}"${inEnv(src.env)} should match the query "${tk}" on "${tgt.alias}"${inEnv(tgt.env)}${opts.length ? ' with:' : ` by "${o.keys.join(', ')}"`}`,
        ...opts.map(([k, v]) => `  | ${k.padEnd(w)} | ${v.padEnd(wv)} |`),
        `Then the database vital checks of "${sk}" on "${src.alias}"${inEnv(src.env)} should match "${tk}" on "${tgt.alias}"${inEnv(tgt.env)}${opts.filter(([k]) => k !== 'keys').length ? ' with:' : ''}`,
        ...opts.filter(([k]) => k !== 'keys').map(([k, v]) => `  | ${k.padEnd(w)} | ${v.padEnd(wv)} |`),
    ].join('\n');
    const r = res?.result;
    const sideEditor = (label: string, v: { alias: string; sql: string; env: string }, set: (x: { alias: string; sql: string; env: string }) => void) => (
        <div className="db-cmp-side">
            <div className="db-cmp-head"><b>{label}</b><span style={{ display: 'flex', gap: 6 }}>
                <Select size="small" style={{ width: 110 }} value={v.env} aria-label={`${label} environment`} options={envs.map((e) => ({ value: e, label: e }))}
                    onChange={(e: string) => set({ ...v, env: e, alias: (connsOf[e] ?? []).some((c) => c.alias === v.alias) || !connsOf[e] ? v.alias : '' })} />
                <Select size="small" style={{ width: 240 }} popupMatchSelectWidth={false} value={v.alias || undefined} placeholder="Connection" aria-label={`${label} connection`} options={readyIn(v.env)} onChange={(a) => set({ ...v, alias: a })} /></span></div>
            {mode === 'query' && <Input.TextArea className="mono" autoSize={{ minRows: 4, maxRows: 10 }} value={v.sql} onChange={(e) => set({ ...v, sql: e.target.value })} placeholder="SELECT … (a read)" aria-label={`${label} query`} />}
        </div>);
    return (
        <Drawer open={open} onClose={onClose} width="min(1100px, 96vw)" title="Compare data" destroyOnClose={false}>
            <Space direction="vertical" style={{ width: '100%' }} size={10}>
                <Segmented size="small" value={mode} onChange={(v) => setMode(v as 'tables' | 'query')} options={[{ value: 'tables', label: 'Tables (whole database)' }, { value: 'query', label: 'A query' }]} aria-label="What to compare" />
                <div className="db-cmp-sides">{sideEditor('Source', src, setSrc)}{sideEditor('Target', tgt, setTgt)}</div>
                {mode === 'tables' && <TablesCompare project={project} env={env} src={src} tgt={tgt} />}
                {mode === 'query' && <><div className="db-cmp-opts">
                    <Tooltip title="The columns that identify a row (in the source's names). None: rows are compared in order (an aggregate query)."><span>Key</span></Tooltip>
                    <Select size="small" mode="tags" style={{ minWidth: 200 }} value={o.keys} onChange={(k) => setO({ ...o, keys: k })} options={cols.map((c) => ({ value: c, label: c }))} placeholder="order_id" aria-label="Key columns" />
                    <Tooltip title={IGNORE_HELP}><span>Ignore</span></Tooltip>
                    <Select size="small" mode="tags" style={{ minWidth: 160 }} value={o.ignore} onChange={(k) => setO({ ...o, ignore: k })} options={[...cols, ...(res?.target.columns ?? [])].map((c) => ({ value: c, label: c }))} placeholder="loaded_at" aria-label="Ignored columns" />
                    <Tooltip title="Dates and times compared exactly, or to the second, minute or day"><span>Dates</span></Tooltip>
                    <Select size="small" style={{ width: 130 }} value={o.dates} onChange={(d) => setO({ ...o, dates: d })} options={DATES} aria-label="Date precision" />
                    <Tooltip title="Source column = target column, where the names differ (comma-separated)"><span>Map</span></Tooltip>
                    <Input size="small" style={{ width: 210 }} value={o.map} onChange={(e) => setO({ ...o, map: e.target.value })} placeholder="total = total_amount" aria-label="Column map" />
                    <Tooltip title="Numbers equal within this difference"><span>Tolerance</span></Tooltip>
                    <InputNumber size="small" min={0} step={0.01} style={{ width: 90 }} value={o.tolerance} onChange={(v) => setO({ ...o, tolerance: Number(v ?? 0) })} aria-label="Tolerance" />
                    <Checkbox checked={o.ignoreCase} onChange={(e) => setO({ ...o, ignoreCase: e.target.checked })}>Ignore case</Checkbox>
                    <Tooltip title="Leading and trailing spaces left out (CHAR columns are padded)"><Checkbox checked={o.trim} onChange={(e) => setO({ ...o, trim: e.target.checked })}>Trim</Checkbox></Tooltip>
                    <span style={{ flex: 1 }} />
                    <Button type="primary" size="small" icon={<CaretRightOutlined />} loading={busy} disabled={!src.alias || !tgt.alias || !src.sql.trim() || !tgt.sql.trim()} onClick={() => void run()}>Compare</Button>
                </div>
                {err && <Alert type="error" showIcon message={<pre className="db-error">{err}</pre>} />}
                {res && r && <>
                    <Alert type={r.passed && res.vitals.passed ? 'success' : 'error'} showIcon
                        message={r.passed ? (res.vitals.passed ? `The data matches: ${r.matched.toLocaleString()} rows${r.columnsCompared.length ? `, ${r.columnsCompared.length} columns compared` : ''}.` : 'The rows match; some vital checks differ.') : 'The data differs.'}
                        description={<span className="db-cmp-sum">Source {res.source.alias}{crossEnv || res.source.env !== res.target.env ? ` (${res.source.env})` : ''}: {res.source.rows.toLocaleString()} rows ({res.source.ms} ms) · Target {res.target.alias}{res.source.env !== res.target.env ? ` (${res.target.env})` : ''}: {res.target.rows.toLocaleString()} rows ({res.target.ms} ms) · {r.matched.toLocaleString()} matched
                            {r.rowsDiffering ? ` · ${r.rowsDiffering.toLocaleString()} with different values` : ''}{r.missingInTarget.length ? ` · ${r.missingInTarget.length.toLocaleString()} missing in the target` : ''}{r.extraInTarget.length ? ` · ${r.extraInTarget.length.toLocaleString()} only in the target` : ''}
                            {(res.source.truncated || res.target.truncated) && <Typography.Text type="warning"> · Only the first rows were compared: narrow the queries.</Typography.Text>}
                            {(r.onlyInSource.length > 0 || r.onlyInTarget.length > 0) && <><br />Not compared (in one only): {[...r.onlyInSource.map((c) => `${c} (source)`), ...r.onlyInTarget.map((c) => `${c} (target)`)].join(', ')}</>}
                            {(r.duplicateKeys.source.length > 0 || r.duplicateKeys.target.length > 0) && <><br /><Typography.Text type="danger">Keys that are not unique: {[...r.duplicateKeys.source, ...r.duplicateKeys.target].slice(0, 8).join('; ')}</Typography.Text></>}</span>} />
                    <Tabs size="small" activeKey={tab} onChange={setTab} items={[
                        { key: 'diff', label: `Values (${r.differences.length}${r.truncated ? '+' : ''})`, children: r.differences.length
                            ? <Table size="small" rowKey={(d) => `${d.key}|${d.column}`} pagination={{ pageSize: 50, hideOnSinglePage: true }} dataSource={r.differences}
                                columns={[{ title: 'Row', dataIndex: 'key', width: 220 }, { title: 'Column', dataIndex: 'column', width: 160 }, { title: 'Source', dataIndex: 'source', render: (v: string) => <span className="mono db-cmp-v">{v}</span> }, { title: 'Target', dataIndex: 'target', render: (v: string) => <span className="mono db-cmp-v">{v}</span> }]} />
                            : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No values differ in the matched rows" /> },
                        { key: 'rows', label: `Rows (${r.missingInTarget.length + r.extraInTarget.length})`, children: r.missingInTarget.length + r.extraInTarget.length
                            ? <Table size="small" rowKey={(x) => `${x.side}|${x.key}`} pagination={{ pageSize: 50, hideOnSinglePage: true }}
                                dataSource={[...r.missingInTarget.map((key) => ({ key, side: 'Missing in the target' })), ...r.extraInTarget.map((key) => ({ key, side: 'Only in the target' }))]}
                                columns={[{ title: 'Row', dataIndex: 'key' }, { title: '', dataIndex: 'side', width: 220, render: (v: string) => <Tag bordered={false} color={v.startsWith('Missing') ? 'red' : 'orange'}>{v}</Tag> }]} />
                            : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Both have the same rows" /> },
                        { key: 'vitals', label: `Vital checks (${res.vitals.differences.length})`, children: res.vitals.differences.length
                            ? <Table size="small" rowKey={(d, i) => `${d.check}|${d.column}|${i}`} pagination={false} dataSource={res.vitals.differences}
                                columns={[{ title: 'Column', dataIndex: 'column', width: 180, render: (v?: string) => v ?? '(rows)' }, { title: 'Check', dataIndex: 'check', width: 100 }, { title: 'Source', dataIndex: 'source', render: (v: unknown) => <span className="mono">{String(v)}</span> }, { title: 'Target', dataIndex: 'target', render: (v: unknown) => <span className="mono">{String(v)}</span> }]} />
                            : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={`Count, empty values, distinct values, sums, min and max match (${res.vitals.source.count.toLocaleString()} rows)`} /> },
                        { key: 'step', label: 'In a test', children: res.stepAvailable
                            ? <div><Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 6 }}>The queries go in the configuration as DB_QUERY_ settings; the steps compare the same way in every run.</Typography.Paragraph>
                                <pre className="code-box">{stepText}</pre>
                                <Button size="small" icon={<CopyOutlined />} onClick={() => void navigator.clipboard?.writeText(stepText).then(() => message.success('Copied'))}>Copy</Button></div>
                            : <Alert type="info" showIcon message="The project's framework version has no data comparison steps: update the framework to check this in a test." /> },
                    ]} />
                </>}
                </>}
            </Space>
        </Drawer>);
}

export function Database() {
    const { message, modal } = App.useApp();
    const route = useRoute();
    const here = route[0] === 'db';
    const addr = here ? parseDbRoute(route.slice(1)) : null;
    const fileInRoute = addr?.kind === 'query' ? addr.file : null;
    const [meta, setMeta] = React.useState<DbConnections | null>(null);
    const [project, setProjectRaw] = React.useState<string>(() => pref('cs-studio-db-project', ''));
    const [env, setEnvRaw] = React.useState<string | undefined>(() => pref<string | undefined>('cs-studio-db-env', undefined));
    const [alias, setAliasRaw] = React.useState<string | undefined>();
    const [objects, setObjects] = React.useState<{ alias: string; list: DbObject[]; unsupported?: boolean; error?: string } | null>(null);
    const [retry, setRetry] = React.useState(0);
    const [find, setFind] = React.useState('');
    const [open, setOpenCols] = React.useState<Record<string, DbColumnInfo[] | 'loading' | string>>({});
    const [queries, setQueries] = React.useState<DbSavedQuery[]>([]);
    const [ed, setEd] = React.useState<Editor>({ file: null, text: '', dirty: false });
    useUnsaved('db-query', ed.dirty && !!ed.text.trim(), 'a database query');
    const [params, setParams] = React.useState<string[]>([]);
    const [script, setScript] = React.useState<{ title: string; sql: string; warnings?: string[] } | null>(null);
    const [inserting, setInserting] = React.useState(false);
    const [maxRows, setMaxRows] = React.useState<number>(() => pref('cs-studio-db-rows', 500));
    const [running, setRunning] = React.useState(false);
    const [result, setResult] = React.useState<{ r: DbResult; sql: string; params: string[]; alias: string } | null>(null);
    const agentRoute = useRoute();
    useAgentContext('db', { project, environment: env, connection: alias, queryFile: ed.file, query: ed.text.slice(0, 2000), lastResult: result ? { connection: result.alias, rows: result.r.total, columns: result.r.columns.map((c) => c.name).slice(0, 40) } : null }, agentRoute[0] === 'db');
    const [error, setError] = React.useState<{ text: string; code?: string } | null>(null);
    const [tab, setTab] = useKept<DbResultTab>('db-result-tab', 'result');
    const [sideTab, setSideTab] = useStoredTab<DbSideTab>('db-side', DB_SIDE_TABS, 'connections');
    // The tabs are in the address while no saved query is open (#/db/saved, #/db/connections/history), so Back and
    // Forward move between them; a wrong or missing tab is replaced with a valid address.
    const home = (side: DbSideTab = sideTab, result: DbResultTab = tab) => dbHome(side, result);
    React.useEffect(() => {
        if (!addr) return;
        // Back on the screen from the menu (#/db) with a saved query open: the address names it again.
        if (route.length === 1 && ed.file) { navigate(['db', 'q', ...ed.file.split('/')], true); return; }
        if (addr.kind === 'query') { if (addr.legacy) navigate(['db', 'q', ...addr.file.split('/')], true); return; }
        const side = addr.side ?? sideTab, result = addr.result ?? (addr.side ? 'result' : tab === 'history' ? 'history' : 'result');
        if (side !== sideTab) setSideTab(side);
        if (result !== tab) setTab(result);
        if (!addr.valid) navigate(dbHome(side, result), true);
    }, [here, route.join('/')]); // eslint-disable-line react-hooks/exhaustive-deps
    const chooseSideTab = (k: DbSideTab) => { setSideTab(k); if (!fileInRoute) navigate(home(k, tab)); };
    const chooseResultTab = (k: DbResultTab) => { setTab(k); if (!fileInRoute) navigate(home(sideTab, k)); };
    /** Show the result (after a run): the address follows when it holds the tabs. */
    const showResult = () => { setTab('result'); if (here && !fileInRoute && tab !== 'result') navigate(home(sideTab, 'result'), true); };
    const [history, setHistory] = React.useState<DbHistoryItem[] | null>(null);
    const [feature, setFeature] = React.useState(false);
    const [comparing, setComparing] = React.useState(false);
    const [err, setErr] = React.useState<string | null>(null);
    const editor = React.useRef<CodeEditorHandle>(null);
    // The screen stays loaded when hidden: a drawer or dialog left open closes when the screen is left (Back, the menu).
    React.useEffect(() => { if (!here) { setComparing(false); setFeature(false); setInserting(false); setScript(null); } }, [here]);

    const environment = env ?? meta?.environments[project]?.[0];
    const conns = meta?.connections ?? [];
    const conn: DbConnection | undefined = conns.find((c) => c.alias === alias);
    const locked = !!meta?.protected || !!conn?.readOnlyByConfig;
    /** Why Run is off, in words (on the button's tooltip, not only on the small ⚠ by the connection). */
    const runBlocked: string | null = !conn ? 'Choose a connection first.'
        : conn.problems.length ? `${conn.alias} cannot run queries yet: ${conn.problems.join(' ')}`
        : !conn.driverInstalled ? `${conn.alias} needs its database driver${conn.driver ? ` (${conn.driver})` : ''}, which is not installed.`
        : null;
    const load = React.useCallback(async (p?: string, e?: string) => {
        try {
            const first = p ? null : await api.dbConnections();
            const proj = p ?? (first!.projects.includes(project) ? project : first!.projects[0] ?? '');
            if (!proj) { setMeta(first); return; }
            if (proj !== project) setProjectRaw(proj);
            const m = await api.dbConnections(proj, e ?? env);
            setMeta(m);
            setAliasRaw((a) => (a && m.connections.some((c) => c.alias === a) ? a : pref<string | undefined>(`cs-studio-db-alias-${proj}`, undefined) ?? m.connections.find((c) => !c.problems.length && c.driverInstalled)?.alias ?? m.connections[0]?.alias));
            api.dbQueries(proj).then((r) => setQueries(r.queries)).catch(() => setQueries([]));
        } catch (x) { setErr(errText(x)); }
    }, [project, env]);
    React.useEffect(() => { if (here && !meta) void load(); }, [here]); // eslint-disable-line react-hooks/exhaustive-deps
    const setProject = (p: string) => { setProjectRaw(p); savePref('cs-studio-db-project', p); setEnvRaw(undefined); setObjects(null); void load(p, undefined); };
    const setEnv = (e?: string) => { setEnvRaw(e); savePref('cs-studio-db-env', e); setObjects(null); void load(project, e); };
    const setAlias = (a: string) => { setAliasRaw(a); savePref(`cs-studio-db-alias-${project}`, a); };

    // Tables, views and procedures of the chosen connection.
    React.useEffect(() => {
        if (!here || !conn || !environment || conn.problems.length || !conn.driverInstalled) { setObjects(null); return; }
        setObjects(null); setOpenCols({});
        api.dbObjects(project, environment, conn.alias).then((r) => setObjects({ alias: conn.alias, list: r.objects, unsupported: r.unsupported })).catch((e) => setObjects({ alias: conn.alias, list: [], error: errText(e) }));
    }, [here, conn?.alias, environment, project, retry]); // eslint-disable-line react-hooks/exhaustive-deps

    // A saved query from the address (#/db/test/<project>/queries/<name>.sql).
    React.useEffect(() => {
        if (!fileInRoute || fileInRoute === ed.file) return;
        const asked = fileInRoute;
        datagitApi.dbQueryFile(asked).then((r) => { setEd({ file: r.file, text: r.text, dirty: false, version: r.version }); if (r.connection) setAliasRaw(r.connection); setResult(null); setError(null); })
            .catch((e) => {
                // A link to a query that is gone: the editor must not keep showing another query under its name.
                setEd({ file: null, text: '', dirty: false }); setResult(null); setError(null);
                navigate(home(), true);
                message.error(`${errText(e)} The editor is empty: pick a query under Saved, or write a new one.`);
                api.dbQueries(project).then((x) => setQueries(x.queries)).catch(() => {});
            });
    }, [fileInRoute]); // eslint-disable-line react-hooks/exhaustive-deps

    const paramCount = React.useMemo(() => { let n = 0; let s = ''; const t = ed.text; for (let i = 0; i < t.length; i++) { const c = t[i]; if (s) { if (c === s) s = ''; continue; } if (c === "'" || c === '"') { s = c; continue; } if (c === '-' && t[i + 1] === '-') { const e = t.indexOf('\n', i); i = e < 0 ? t.length : e; continue; } if (c === '?') n++; } return n; }, [ed.text]);
    React.useEffect(() => { setParams((p) => (p.length === paramCount ? p : Array.from({ length: paramCount }, (_, i) => p[i] ?? ''))); }, [paramCount]);

    /** Run the selection, or the whole query; `text` runs that text instead (e.g. just put in the editor). */
    const run = async (confirmed = false, text?: string, withParams?: string[]) => {
        if (!conn || !environment) return;
        const sel = text === undefined ? editor.current?.selection() ?? '' : '';
        const sql = text ?? (sel.trim() ? sel : ed.text);
        if (!sql.trim()) { message.info('Write a query first.'); return; }
        const usedParams = withParams ?? (sel.trim() || text !== undefined ? [] : params);
        setRunning(true); setError(null); showResult();
        try {
            const r = await api.dbQuery({ project, env: environment, alias: conn.alias, sql, params: usedParams, maxRows, confirmed });
            setResult({ r, sql, params: usedParams, alias: conn.alias });
            if (r.kind === 'change') void load(project, env);
        } catch (e) {
            const code = e instanceof ApiError ? e.code : undefined;
            if (code === 'db-confirm') {
                setRunning(false);
                modal.confirm({
                    title: `Run a change on ${conn.alias} (${environment})?`, okText: 'Run the change', okButtonProps: { danger: true }, width: 560,
                    content: <Space direction="vertical"><span>{(e as Error).message} It runs as written and is not undone.</span><pre className="code-box" style={{ maxHeight: 200 }}>{sql.slice(0, 2000)}</pre></Space>,
                    onOk: () => run(true, sql, usedParams),
                });
                return;
            }
            setError({ text: errText(e), code });
            setResult(null);
        } finally { setRunning(false); }
    };
    // Ctrl+Enter runs the query from anywhere on this screen (not inside a dialog).
    const runRef = React.useRef(run);
    runRef.current = run;
    React.useEffect(() => {
        if (!here) return;
        const onKey = (e: KeyboardEvent) => {
            if (!(e.ctrlKey || e.metaKey) || e.key !== 'Enter' || (e.target as HTMLElement)?.closest?.('.ant-modal')) return;
            e.preventDefault();
            if (!running) void runRef.current();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [here, running]);
    const showDdl = async (o: DbObject) => {
        if (!conn || !environment) return;
        setScript({ title: `${o.kind} ${o.schema ? `${o.schema}.` : ''}${o.name}`, sql: '' });
        try { const x = await api.dbDdl(project, environment, conn.alias, o.kind, o.schema, o.name); setScript({ title: `${o.kind} ${o.schema ? `${o.schema}.` : ''}${o.name}`, sql: x.sql }); }
        catch (e) { setScript(null); message.error(errText(e)); }
    };
    /** Put a script in the editor (as a new, unsaved query). */
    const toEditor = (text: string) => {
        const put = () => { setEd({ file: null, text, dirty: true }); setResult(null); setError(null); navigate(home(), true); setScript(null); setInserting(false); };
        if (ed.dirty && ed.text.trim()) modal.confirm({ title: 'Replace the current query?', okText: 'Replace', onOk: put }); else put();
    };
    const stop = async () => { if (environment) { await api.dbStop(project, environment).catch(() => {}); } };
    const save = async (asNew = false) => {
        if (!project) return;
        const doSave = async (name?: string, force = false, version = ed.version): Promise<string | null> => {
            try {
                const text = !ed.file && conn && !/^--\s*connection:/im.test(ed.text) && !['mongodb', 'redis'].includes(conn.type) ? `-- connection: ${conn.alias}\n${ed.text}` : ed.text;
                // An open saved query goes back with the version it was read at: changed since (another tab) → refused.
                const r = await datagitApi.dbSaveQuery({ project, text, ...(asNew || !ed.file ? { name: name! } : { file: ed.file, version, ...(force ? { force: true } : {}) }) });
                setEd({ file: r.file, text, dirty: false, version: r.version });
                message.success(`Saved ${r.file}`);
                navigate(['db', 'q', ...r.file.split('/')], true);
                api.dbQueries(project).then((x) => setQueries(x.queries)).catch(() => {});
                filesChanged();
                return null;
            } catch (e) {
                if (!asNew && ed.file) {
                    const file = ed.file;
                    askStaleSave({ message, modal }, e, `The query ${file}`, {
                        reload: () => { datagitApi.dbQueryFile(file).then((r) => setEd({ file: r.file, text: r.text, dirty: false, version: r.version })).catch((x) => message.error(errText(x))); },
                        overwrite: async () => { const err = await doSave(undefined, true); if (err) message.error(err); },
                        // Keep editing: the next Save goes over what is saved now (the question was asked once).
                        keep: (v) => setEd((x) => (x.file === file ? { ...x, version: v ?? '' } : x)),
                    });
                    return '';
                }
                return errText(e);
            }
        };
        if (ed.file && !asNew) { const err = await doSave(); if (err) message.error(err); return; }
        // The name dialog stays open with the problem shown (a name in use, too long), keeping what was typed.
        let name = '';
        const body = (problem: string | null) => <Space direction="vertical" style={{ width: '100%' }}>
            <Input autoFocus maxLength={120} showCount placeholder="Name, e.g. active customers by country" defaultValue={name} status={problem ? 'error' : undefined}
                onChange={(e) => { name = e.target.value; const p = queryNameProblem(name); inst.update({ okButtonProps: { disabled: !name.trim() || !!p }, content: body(p) }); }} onPressEnter={() => submit(() => inst.destroy())} aria-label="Query name" />
            {problem && <Typography.Text type="danger" style={{ fontSize: 12 }}>{problem}</Typography.Text>}
            {!problem && name.trim() && <Typography.Text type="secondary" style={{ fontSize: 12 }}>File: <Typography.Text code>{queryFileOf(name)}.sql</Typography.Text></Typography.Text>}
            {!problem && queryNameDropped(name).length > 0 && <Typography.Text type="warning" style={{ fontSize: 12 }}>Left out of the file name: {queryNameDropped(name).join(' ')} (a file name keeps letters of any script, digits, spaces, - and _).</Typography.Text>}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>Saved as test/{project}/queries/&lt;name&gt;.sql: in the project, reviewed through Git, run by the framework's "user executes query from file" step.</Typography.Text>
        </Space>;
        let saving = false;
        const submit = (close: () => void) => {
            if (!name.trim() || saving || queryNameProblem(name)) return;
            saving = true;
            inst.update({ okButtonProps: { loading: true } });
            void doSave(name.trim()).then((err) => { saving = false; inst.update({ okButtonProps: { loading: false } }); if (err) inst.update({ content: body(err) }); else close(); });
        };
        const inst = modal.confirm({ title: 'Save the query', icon: <SaveOutlined />, autoFocusButton: null, content: body(null), okText: 'Save', okButtonProps: { disabled: true },
            // Not async: antd closes the dialog when a returned promise settles; it closes here only when saved.
            onOk: (close: () => void) => submit(close) });
    };
    const openQuery = (q: DbSavedQuery) => {
        const go = () => navigate(['db', 'q', ...q.file.split('/')]);
        if (ed.dirty) modal.confirm({ title: 'Discard the changes to the current query?', okText: 'Discard', onOk: go }); else go();
    };
    const toggleCols = (o: DbObject) => {
        const k = `${o.schema}.${o.name}`;
        if (open[k]) { const n = { ...open }; delete n[k]; setOpenCols(n); return; }
        if (!conn || !environment) return;
        setOpenCols({ ...open, [k]: 'loading' });
        api.dbColumns(project, environment, conn.alias, o.schema, o.name).then((r) => setOpenCols((x) => ({ ...x, [k]: r.columns }))).catch((e) => setOpenCols((x) => ({ ...x, [k]: errText(e) })));
    };
    const selectRows = (o: DbObject) => {
        if (!conn) return;
        // A Redis key group: its keys with their type and value (Redis has no query for that).
        if (conn.type === 'redis' && environment) {
            setRunning(true); setError(null); showResult();
            api.dbRows(project, environment, conn.alias, o.name, maxRows)
                .then((r) => setResult({ r, sql: `keys ${o.name}`, params: [], alias: conn.alias }))
                .catch((e) => { setError({ text: errText(e) }); setResult(null); })
                .finally(() => setRunning(false));
            return;
        }
        const text = selectSql(conn.type, o.schema, o.name, 100);
        const put = () => { setEd({ file: null, text, dirty: true }); if (fileInRoute) navigate(home(), true); void run(false, text); };
        if (ed.dirty && ed.text.trim()) modal.confirm({ title: 'Replace the current query?', okText: 'Replace', onOk: put }); else put();
    };
    React.useEffect(() => { if (here && tab === 'history') api.dbHistory().then((r) => setHistory(r.items)).catch(() => setHistory([])); }, [here, tab, result]);

    const shownObjects = (objects?.list ?? []).filter((o) => !find || `${o.schema}.${o.name}`.toLowerCase().includes(find.toLowerCase()));
    const r = result?.r;
    return (<>
        <Split id="db-side" initial={320} min={240} max={560} style={{ height: 'calc(100vh - var(--chrome))' }}>
            <div className="panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                <div className="toolbar" style={{ display: 'block' }}>
                    <div className="filter-row">
                        <Select size="small" style={{ flex: 1, minWidth: 110 }} showSearch value={project || undefined} placeholder="Project" onChange={setProject} options={(meta?.projects ?? []).map((p) => ({ value: p, label: p }))} aria-label="Project" />
                        <Select size="small" style={{ width: 110 }} value={environment} placeholder="env" onChange={setEnv} options={(meta?.environments[project] ?? []).map((e) => ({ value: e, label: e }))} aria-label="Environment" />
                        <Tooltip title="Read the settings again"><Button size="small" icon={<ReloadOutlined />} onClick={() => void load(project, env)} aria-label="Refresh" /></Tooltip>
                    </div>
                </div>
                {err && <Alert type="error" showIcon closable onClose={() => setErr(null)} style={{ margin: 8 }} message={err} />}
                {meta?.protected && <Alert type="info" showIcon icon={<LockOutlined />} style={{ margin: '6px 8px', padding: '4px 10px' }} message={<Tooltip title={`Changes are never run here: ${meta.protected}.`}><span>Read only: changes are never run here</span></Tooltip>} />}
                {meta && meta.frameworkInstalled === false && <Alert type="error" showIcon style={{ margin: '6px 8px' }} message="The framework is not installed in this repository (npm install)." />}
                <Tabs size="small" className="dg-db-side-tabs" tabBarGutter={14} activeKey={sideTab} onChange={(k) => chooseSideTab(k as DbSideTab)} items={[
                    {
                        key: 'connections', label: `Connections${conns.length ? ` (${conns.length})` : ''}`, children: <div>
                    {meta && !conns.length && <Typography.Text type="secondary" style={{ display: 'block', padding: '2px 12px 8px', fontSize: 12 }}>None for {project}/{environment}. A connection is a set of settings DB_&lt;NAME&gt;_TYPE, _HOST, _DATABASE, _USERNAME, _PASSWORD (Environments).</Typography.Text>}
                    {conns.map((c) => (
                        <div key={c.alias} className={`item-row${c.alias === alias ? ' selected' : ''}`} onClick={() => { setAlias(c.alias); if (!c.problems.length && c.driverInstalled) setSideTab('objects'); }}>
                            <div className="item-title"><DatabaseOutlined /><span className="t">{c.alias}</span><Tag bordered={false} style={{ marginInlineEnd: 0 }}>{c.type}</Tag>
                                {c.problems.length > 0 && <Tooltip title={c.problems.join(' ')}><WarningFilled style={{ color: '#bf8700' }} /></Tooltip>}
                                {c.readOnlyByConfig && <Tooltip title={`DB_${c.alias}_STUDIO_READONLY=true`}><LockOutlined /></Tooltip>}</div>
                            <div className="item-meta">{c.host}{c.port ? `:${c.port}` : ''} / {c.database}{c.username ? ` · ${c.username}` : c.trusted ? ' · Windows login' : ''}</div>
                            {!c.driverInstalled && c.driver && <div className="item-meta" style={{ color: '#cf222e' }}>Driver missing: npm install {c.driver}</div>}
                        </div>))}
                        </div>,
                    },
                    {
                        key: 'objects', label: <Tooltip title={conn ? `Tables, views and procedures of ${conn.alias}` : undefined}>Objects{objects && !objects.error ? ` (${objects.list.length.toLocaleString()})` : ''}</Tooltip>, children: <div style={{ paddingTop: 6 }}>
                            {!conn ? <Typography.Text type="secondary" style={{ display: 'block', padding: '4px 12px', fontSize: 12 }}>Choose a connection first.</Typography.Text>
                                : conn.problems.length || !conn.driverInstalled ? <Typography.Text type="secondary" style={{ display: 'block', padding: '4px 12px', fontSize: 12 }}>{conn.alias} cannot be browsed: {conn.problems.length ? conn.problems.join(' ') : `driver missing (npm install ${conn.driver})`}</Typography.Text>
                                : <>
                        <div style={{ padding: '0 10px 6px' }}><Input size="small" allowClear placeholder="Find a table, view or procedure" value={find} onChange={(e) => setFind(e.target.value)} aria-label="Find an object" /></div>
                        {!objects ? <Spin size="small" style={{ margin: '4px 14px' }} /> : objects.error ? <ConnectError alias={objects.alias} error={objects.error} onRetry={() => setRetry((n) => n + 1)} />
                            : objects.unsupported ? <Typography.Text type="secondary" style={{ display: 'block', padding: '0 12px', fontSize: 12 }}>Browsing is not available for {conn.type}; queries work.</Typography.Text>
                            : <div className="db-objects">{shownObjects.slice(0, 400).map((o) => {
                                const k = `${o.schema}.${o.name}`; const cols = open[k];
                                return (<div key={`${o.kind}:${k}`}>
                                    <div className="db-obj" onClick={() => (o.kind === 'table' || o.kind === 'view' ? toggleCols(o) : undefined)} title={k}>
                                        {KIND_ICON[o.kind]}<span className="t">{o.schema && conn.type !== 'mysql' ? <span className="db-schema">{o.schema}.</span> : null}{o.name}</span>
                                        {o.rows !== undefined && <span className="item-id">{fmtCount(o.rows)}</span>}
                                        {(o.kind === 'table' || o.kind === 'view') && <Button size="small" type="link" className="db-obj-act" onClick={(e) => { e.stopPropagation(); selectRows(o); }}>Select</Button>}
                                        {!['mongodb', 'redis'].includes(conn.type) && <Tooltip title={`CREATE script of this ${o.kind}`}><Button size="small" type="link" className="db-obj-act" onClick={(e) => { e.stopPropagation(); void showDdl(o); }}>Script</Button></Tooltip>}
                                    </div>
                                    {cols && <div className="db-cols">{cols === 'loading' ? <Spin size="small" /> : typeof cols === 'string' ? <Typography.Text type="danger" style={{ fontSize: 12 }}>{cols}</Typography.Text>
                                        : cols.map((c) => <div key={c.name} className="db-col">{c.key ? <KeyOutlined style={{ color: '#bf8700' }} /> : <span style={{ width: 14, display: 'inline-block' }} />}<span>{c.name}</span><span className="db-type">{c.type}{c.nullable ? '' : ' · not null'}</span></div>)}</div>}
                                </div>);
                            })}{shownObjects.length > 400 && <Typography.Text type="secondary" style={{ display: 'block', padding: '4px 12px', fontSize: 12 }}>{shownObjects.length - 400} more: refine the search.</Typography.Text>}</div>}
                                </>}
                        </div>,
                    },
                    {
                        key: 'saved', label: <Tooltip title="Saved queries (test/<project>/queries)">Saved{queries.length ? ` (${queries.length})` : ''}</Tooltip>, children: <div style={{ paddingTop: 6 }}>
                    {!queries.length ? <Typography.Text type="secondary" style={{ display: 'block', padding: '0 12px 8px', fontSize: 12 }}>None yet: Save keeps a query in test/{project}/queries/.</Typography.Text>
                        : queries.map((q) => <div key={q.file} className={`item-row${ed.file === q.file ? ' selected' : ''}`} onClick={() => openQuery(q)}><div className="item-title"><FileTextOutlined /><span className="t">{q.name}</span>{q.connection && <span className="item-id">{q.connection}</span>}</div></div>)}
                        </div>,
                    },
                ]} />
            </div>
            <div className="panel" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                <div className="toolbar">
                    <Typography.Text type="secondary" style={{ fontSize: 12, flex: '1 1 160px', minWidth: 160 }} ellipsis title={ed.file ?? undefined}>{ed.file ?? 'New query'}{ed.dirty && <span className="dirty-dot" title="Not saved" />}</Typography.Text>
                    <Select size="small" style={{ width: 190 }} showSearch optionFilterProp="label" value={alias} onChange={setAlias} options={conns.map((c) => ({ value: c.alias, label: c.alias, disabled: !!c.problems.length || !c.driverInstalled }))} placeholder="Connection" aria-label="Connection" />
                    {locked && <Tooltip title={meta?.protected ? `Only reads run here: ${meta.protected}. The database session is read-only too.` : `Only reads run on this connection: DB_${conn?.alias}_STUDIO_READONLY=true.`}><Tag icon={<LockOutlined />} color="gold" bordered={false} style={{ marginInlineEnd: 0 }}>Read only</Tag></Tooltip>}
                    <Select size="small" style={{ width: 118 }} value={maxRows} onChange={(v) => { setMaxRows(v); savePref('cs-studio-db-rows', v); }} aria-label="Rows to show"
                        options={[100, 500, 1000, 5000, 20000, 100000].map((n) => ({ value: n, label: `${n.toLocaleString()} rows` }))} />
                    {running ? <Button size="small" danger icon={<StopOutlined />} onClick={(e) => { if (e.detail > 1) return; /* the second click of a double-click on Run */ void stop(); }}>Stop</Button>
                        : <Tooltip title={runBlocked ?? 'Ctrl+Enter (the selected text only, when there is a selection)'}><Button size="small" type="primary" icon={<CaretRightOutlined />} disabled={!!runBlocked} onClick={(e) => { if (e.detail > 1) return; void run(); }}>Run</Button></Tooltip>}
                    <Button size="small" icon={<SaveOutlined />} type={ed.dirty && ed.file ? 'primary' : 'default'} disabled={!ed.text.trim()} onClick={() => void save()}>Save</Button>
                    <Tooltip title="Compare this query's data with another query (another connection, or another table): rows by key, values, vital checks"><Button size="small" icon={<DiffOutlined />} disabled={!conns.length} onClick={() => setComparing(true)}>Compare</Button></Tooltip>
                    <Tooltip title={!r || r.kind === 'change' ? 'Run a query first: the test checks its result' : undefined}><Button size="small" icon={<ExperimentOutlined />} disabled={!r || r.kind === 'change' || !result} onClick={() => setFeature(true)}>Create test</Button></Tooltip>
                    <Dropdown menu={{ items: [{ key: 'new', label: 'New query' }, { key: 'saveas', label: 'Save as…', disabled: !ed.text.trim() }, ...(ed.file ? [{ key: 'del', danger: true, label: 'Delete this saved query…' }] : [])],
                        onClick: ({ key }) => {
                            if (key === 'new') { const go = () => { setEd({ file: null, text: '', dirty: false }); setResult(null); setError(null); navigate(home(), true); }; if (ed.dirty) modal.confirm({ title: 'Discard the changes?', okText: 'Discard', onOk: go }); else go(); }
                            if (key === 'saveas') void save(true);
                            if (key === 'del' && ed.file) modal.confirm({ title: `Delete ${ed.file}?`, okButtonProps: { danger: true }, okText: 'Delete', onOk: async () => { const f = ed.file!; try { await api.dbDeleteQuery(f); } catch (e) { message.error(errText(e)); return; } filesChanged(); message.success(`Deleted ${f}. The text stays in the editor (not saved).`); setEd({ file: null, text: ed.text, dirty: true }); navigate(home(), true); api.dbQueries(project).then((x) => setQueries(x.queries)).catch(() => {}); } });
                        } }}><Button size="small" aria-label="More">⋯</Button></Dropdown>
                </div>
                <Split id="db-editor" direction="column" sizeOf="second" initial={340} min={120} max={900} style={{ flex: 1, minHeight: 0 }}>
                    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                        <div style={{ flex: 1, minHeight: 0 }}>
                            <CodeEditor ref={editor} value={ed.text} lang={conn?.type === 'mongodb' ? 'ts' : 'sql'} onChange={(text) => setEd({ ...ed, text, dirty: true })} onSave={() => void save()} />
                        </div>
                        {paramCount > 0 && <div className="db-params">
                            <Tooltip title="Values for the ? placeholders, in order (as the parameterized-query step reads them: null, true/false, numbers and YYYY-MM-DD dates are converted)"><span>Parameters</span></Tooltip>
                            {params.map((p, i) => <Input key={i} size="small" style={{ width: 150 }} prefix={<span className="item-id">{i + 1}</span>} value={p} onChange={(e) => setParams(params.map((x, j) => (j === i ? e.target.value : x)))} aria-label={`Parameter ${i + 1}`} />)}
                        </div>}
                    </div>
                    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0, borderTop: '1px solid var(--panel-border)' }}>
                        <Tabs size="small" activeKey={tab} onChange={(k) => chooseResultTab(k as DbResultTab)} style={{ padding: '0 10px' }} items={[{ key: 'result', label: 'Result' }, { key: 'history', label: 'History' }]}
                            tabBarExtraContent={tab === 'result' && r && r.columns.length > 0 ? <Space size={4}>
                                {!['mongodb', 'redis'].includes(r.type) && <Tooltip title="INSERT statements for these rows"><Button size="small" type="text" icon={<FileTextOutlined />} onClick={() => setInserting(true)}>INSERT script</Button></Tooltip>}
                                <Tooltip title="Copy as CSV"><Button size="small" type="text" icon={<CopyOutlined />} onClick={() => void navigator.clipboard?.writeText(csv(r.columns, r.rows)).then(() => message.success('Copied'))} aria-label="Copy" /></Tooltip>
                                <Dropdown menu={{ items: [{ key: 'csv', label: `CSV (${r.rows.length.toLocaleString()} rows)` }, { key: 'xlsx', label: `Excel (${r.rows.length.toLocaleString()} rows)` }, ...(r.truncated ? [{ key: 'more', disabled: true, label: 'Raise the row limit to export more' }] : [])], onClick: async ({ key }) => {
                                    if (key === 'csv') download(new Blob([csv(r.columns, r.rows)], { type: 'text/csv' }), 'query-result.csv');
                                    else { try { download(await api.dbExport(r.columns, r.rows), 'query-result.xlsx'); } catch (e) { message.error(errText(e)); } }
                                } }}><Button size="small" type="text" icon={<DownloadOutlined />}>Export</Button></Dropdown>
                            </Space> : tab === 'history' ? <Popconfirm title="Clear the query history?" description="The queries run on this computer are forgotten (saved queries stay)." okText="Clear" okButtonProps={{ danger: true }} onConfirm={async () => { try { await api.dbClearHistory(); setHistory([]); } catch (e) { message.error(errText(e)); } }}><Button size="small" type="text" icon={<DeleteOutlined />} disabled={!history?.length}>Clear</Button></Popconfirm> : null} />
                        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
                            {tab === 'history' ? (!history ? <Spin style={{ margin: 16 }} /> : !history.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Queries you run appear here (on this computer)." />
                                : history.map((h, i) => (
                                    <div key={i} className="item-row" onClick={() => { setEd({ file: null, text: h.sql, dirty: true }); setTab('result'); navigate(home(sideTab, 'result'), true); }}>
                                        <div className="item-title">{h.ok ? null : <WarningFilled style={{ color: '#cf222e' }} />}<span className="t mono" style={{ fontSize: 12 }}>{h.sql.replace(/\s+/g, ' ').slice(0, 160)}</span>{h.kind === 'change' && <Tag color="orange" bordered={false}>change</Tag>}</div>
                                        <div className="item-meta">{ago(h.at)} · {h.alias} · {h.env}{h.ok ? ` · ${plural(h.rows ?? 0, 'row')}${h.affected ? ` · ${h.affected} affected` : ''} · ${h.ms} ms` : ` · ${h.error}`}</div>
                                    </div>)))
                                : running ? <div style={{ padding: 16 }}><Spin /> <Typography.Text type="secondary">Running on {alias} ({environment})… Stop ends the query.</Typography.Text></div>
                                : error ? <div style={{ padding: 12 }}>
                                    <Alert type={error.code === 'db-protected' ? 'warning' : 'error'} showIcon message={<pre className="db-error">{error.text}</pre>} />
                                </div>
                                : r ? <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                                    <div className="db-status">
                                        {r.kind === 'change' ? <Tag color="orange" bordered={false}>{r.command || 'change'}</Tag> : null}
                                        {r.columns.length ? <span><b>{r.total.toLocaleString()}</b> row{r.total === 1 ? '' : 's'}{r.truncated ? <Typography.Text type="warning"> (showing the first {r.rows.length.toLocaleString()}: narrow the query or show more rows)</Typography.Text> : null}</span>
                                            : <span>{r.affected !== undefined ? <><b>{r.affected.toLocaleString()}</b> row{r.affected === 1 ? '' : 's'} affected</> : 'Done'}</span>}
                                        <span>· {r.ms.toLocaleString()} ms</span>
                                        {r.interpolated && <Tooltip title="{config:…}, {env:…}, ${…} or <…> placeholders were filled in, as the framework does in a test"><Tag bordered={false}>values filled in</Tag></Tooltip>}
                                        {r.rolledBack && <Tag color="green" bordered={false}>read only: rolled back</Tag>}
                                        <span style={{ flex: 1 }} /><Typography.Text type="secondary" style={{ fontSize: 11 }}>Double-click a value to copy it</Typography.Text>
                                    </div>
                                    <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>{r.columns.length ? <ResultGrid r={r} /> : null}</div>
                                </div>
                                : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginTop: 30 }} description={conn ? 'Write a query and press Run (Ctrl+Enter). Select a table on the left to start from its rows.' : 'Choose a connection'} />}
                        </div>
                    </div>
                </Split>
            </div>
        </Split>
        <ScriptModal open={!!script} title={script?.title ?? ''} sql={script?.sql ?? ''} warnings={script?.warnings} onClose={() => setScript(null)} onEditor={toEditor} />
        {inserting && result && <InsertModal open={inserting} onClose={() => setInserting(false)} result={result.r} sql={result.sql} onEditor={toEditor} />}
        {environment && <CompareDrawer open={comparing} onClose={() => setComparing(false)} project={project} env={environment} envs={meta?.environments[project] ?? [environment]} conns={conns} alias={alias} sql={ed.text} />}
        {feature && result && conn && environment && <FeatureModal open={feature} onClose={() => setFeature(false)} project={project} env={environment} alias={result.alias}
            file={ed.file && !ed.dirty && result.sql === ed.text ? ed.file : undefined} sql={result.sql} params={result.params} result={result.r} />}
    </>);
}


/** A database connection that failed: the reason first, the driver's hints as a list, and Try again. */
export function splitDbError(raw: string): { code?: string; reason: string; hints: string[] } {
    const m = /^\s*\[([A-Z_]+)\]\s*/.exec(raw);
    const rest = m ? raw.slice(m[0].length) : raw;
    const [reason, tips] = rest.split(/\s*Troubleshooting:\s*/i);
    const hints = (tips ?? '').split(/\s*\d+\.\s+/).map((h) => h.trim()).filter(Boolean);
    return { ...(m ? { code: m[1] } : {}), reason: reason.trim(), hints };
}
function ConnectError({ alias, error, onRetry }: { alias: string; error: string; onRetry: () => void }) {
    const e = splitDbError(error);
    return <Alert type="error" showIcon style={{ margin: '0 8px' }} message={`${alias}: ${e.code === 'CONNECTION_FAILED' ? 'cannot connect' : 'cannot list its tables'}`}
        description={<Space direction="vertical" size={2}><Typography.Text style={{ fontSize: 12 }}>{e.reason}</Typography.Text>
            {e.hints.length > 0 && <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>{e.hints.map((h) => <li key={h}>{h}</li>)}</ul>}
            <Button size="small" onClick={onRetry} style={{ marginTop: 4 }}>Try again</Button></Space>} />;
}
