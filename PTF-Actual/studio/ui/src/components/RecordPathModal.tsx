/**
 * Record a user path for load tests: a recording address in front of the service; the app, a browser or the BDD tests
 * use it; stopped, the requests become a collection (values correlated, pauses kept as think times), new or updating
 * an existing one (its checks and saved values kept).
 */
import React from 'react';
import { Alert, App, Input, Modal, Radio, Select, Space, Typography } from 'antd';
import { api, ApiCollectionInfo } from '../api';
import { errText } from '../state';

export function RecordPathModal({ open, project, collections, onClose, onSaved }: { open: boolean; project: string; collections: ApiCollectionInfo[]; onClose: () => void; onSaved: (file: string) => void }) {
    const { message, modal } = App.useApp();
    const [target, setTarget] = React.useState('');
    const [rec, setRec] = React.useState<{ url: string; count: number } | null>(null);
    const [mode, setMode] = React.useState<'new' | 'update'>('new');
    const [name, setName] = React.useState('Recorded session');
    const [into, setInto] = React.useState<string | undefined>();
    const [busy, setBusy] = React.useState(false);
    React.useEffect(() => {
        if (!rec) return;
        const t = setInterval(() => { void api.loadRecordStatus().then((s) => setRec((r) => (r && s.url ? { ...r, count: s.count ?? 0 } : r))).catch(() => undefined); }, 1500);
        return () => clearInterval(t);
    }, [rec?.url]); // eslint-disable-line react-hooks/exhaustive-deps
    const ok = async () => {
        setBusy(true);
        try {
            if (!rec) { const r = await api.loadRecordStart(target.trim()); setRec({ url: r.url, count: 0 }); return; }
            const r = await api.loadRecordStop(mode === 'update' && into ? { mergeInto: into } : { name });
            setRec(null);
            const saved = await api.apiSaveCollection(project, r.collection, mode === 'update' ? into : undefined);
            onSaved(saved.file);
            modal.info({ title: mode === 'update' ? 'The user path was updated' : `Saved ${saved.file}`, width: 600, content: <Space direction="vertical">
                {r.merge ? <span>{r.merge.updated.length} request(s) updated, {r.merge.added.length} added, {r.merge.kept.length} unchanged.{r.merge.missing.length ? ` Not in the new recording (kept): ${r.merge.missing.join(', ')}.` : ''}</span>
                    : <span>{r.report.imported} requests; {r.report.correlations.length} value(s) correlated (each user gets its own tokens and ids); the pauses are kept as recorded think times (Logic → with the recorded think times).</span>}
                {r.report.warnings.map((w, i) => <Typography.Text key={i} type="warning">• {w}</Typography.Text>)}
            </Space> });
            onClose();
        } catch (e) { message.error(errText(e)); } finally { setBusy(false); }
    };
    return (
        <Modal open={open} title="Record a user path" width={680} confirmLoading={busy} okText={rec ? 'Stop and save' : 'Start recording'}
            okButtonProps={{ disabled: rec ? (mode === 'update' ? !into : !name.trim()) : !/^https?:\/\//.test(target.trim()) }}
            onCancel={() => { if (rec) void api.loadRecordStop({}).catch(() => undefined); setRec(null); onClose(); }} onOk={() => void ok()}>
            <Space direction="vertical" style={{ width: '100%' }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>The service the users call (its API, or the site). A recording address is put in front of it: point the app, a browser or the BDD tests at that address and use them as a user would. Everything goes through to the real service and is kept.</Typography.Text>
                <Input className="mono" disabled={!!rec} value={target} onChange={(e) => setTarget(e.target.value)} placeholder="https://shop.example.com" aria-label="Service to record" />
                {rec && <Alert type="info" showIcon message={<span>Recording: use <Typography.Text code copyable>{rec.url}</Typography.Text> instead of the service.</span>} description={`${rec.count} request${rec.count === 1 ? '' : 's'} so far. For the BDD tests: set their API base URL to this address for one run.`} />}
                {rec && <>
                    <Radio.Group value={mode} onChange={(e) => setMode(e.target.value)}>
                        <Radio value="new">A new collection</Radio><Radio value="update" disabled={!collections.length}>Update a collection (record the path again)</Radio>
                    </Radio.Group>
                    {mode === 'new' ? <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name of the collection" aria-label="Collection name" />
                        : <Select style={{ width: '100%' }} value={into} onChange={setInto} placeholder="Collection to update" aria-label="Collection to update" options={collections.filter((c) => c.project === project).map((c) => ({ value: c.file, label: `${c.name} (${c.file})` }))} />}
                </>}
            </Space>
        </Modal>
    );
}
