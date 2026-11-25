/**
 * A new framework project, laid out as the team's projects are: the framework's defaults in config/global.env,
 * the project's settings and database queries in config/<project>/common, each environment's addresses and
 * credentials in config/<project>/environments (passwords encrypted by the framework); reviewed before written.
 */
import React from 'react';
import { Alert, App, Button, Collapse, Input, Modal, Select, Space, Steps, Tag, Tooltip, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { api, baseHashesOf, NewProjectPreview, NewProjectRequest } from '../api';
import { PlanReview } from './PlanReview';
import { errText } from '../state';

type Env = { name: string; baseUrl: string; loginUrl: string };

export function NewProjectWizard({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (slug: string, env: string) => void }) {
    const { message } = App.useApp();
    const [slug, setSlug] = React.useState('');
    const [envs, setEnvs] = React.useState<Env[]>([{ name: 'dev', baseUrl: '', loginUrl: '' }]);
    const [dbType, setDbType] = React.useState<NewProjectRequest['dbType']>('none');
    const [user, setUser] = React.useState('');
    const [password, setPassword] = React.useState('');
    const [displayName, setDisplayName] = React.useState('');
    const [preview, setPreview] = React.useState<NewProjectPreview | null>(null);
    const [busy, setBusy] = React.useState(false);
    React.useEffect(() => { if (!open) { setPreview(null); } }, [open]);

    const request = (): NewProjectRequest => ({
        slug: slug.trim(), dbType, ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
        environments: envs.filter((e) => e.name.trim() || e.baseUrl.trim()).map((e) => ({ name: e.name.trim(), baseUrl: e.baseUrl.trim(), ...(e.loginUrl.trim() ? { loginUrl: e.loginUrl.trim() } : {}) })),
        ...(user || password ? { credentials: { ...(user ? { username: user } : {}), ...(password ? { password } : {}) } } : {}),
    });
    const slugOk = /^[a-z][a-z0-9-]*$/.test(slug.trim());
    const envsOk = envs.some((e) => /^[a-z][a-z0-9-]*$/.test(e.name.trim()) && /^https?:\/\/\S+$/.test(e.baseUrl.trim()));
    const set = (i: number, k: keyof Env, v: string) => { setEnvs(envs.map((e, j) => (j === i ? { ...e, [k]: v } : e))); setPreview(null); };

    const review = async () => {
        setBusy(true);
        try { setPreview(await api.newProjectPreview(request())); } catch (e) { message.error(errText(e)); } finally { setBusy(false); }
    };
    const create = async () => {
        setBusy(true);
        try {
            const r = await api.newProjectApply({ ...request(), baseHashes: baseHashesOf(preview?.review), force: true });
            message.success(`Created the project ${slug} (${r.environments.join(', ')})`);
            onCreated(slug.trim(), request().environments[0].name);
            onClose();
        } catch (e) { message.error(errText(e)); } finally { setBusy(false); }
    };

    return (
        <Modal open={open} title="New project" width={preview ? 1080 : 720} onCancel={onClose} destroyOnClose
            footer={<Space>
                <Button onClick={onClose}>Cancel</Button>
                {preview && <Button onClick={() => setPreview(null)}>Back</Button>}
                {!preview
                    ? <Tooltip title={!slugOk ? 'Give the project a name: lower-case letters, digits and -, starting with a letter (for example claims-portal)' : !envsOk ? 'Give at least one environment a name (lower-case letters, digits, -) and an address starting with http:// or https://' : undefined}>
                        <Button type="primary" loading={busy} disabled={!slugOk || !envsOk} onClick={() => void review()}>Review the files</Button></Tooltip>
                    : <Button type="primary" loading={busy} disabled={!preview.review.files.length} onClick={() => void create()}>Create the project</Button>}
            </Space>}>
            <Steps size="small" current={preview ? 1 : 0} style={{ marginBottom: 16 }} items={[{ title: 'Project' }, { title: 'Review and create' }]} />
            {!preview && <Space direction="vertical" style={{ width: '100%' }}>
                <Typography.Text type="secondary">The framework's defaults stay in config/global.env; the project gets its own settings and database queries (config/&lt;project&gt;/common) and each environment's addresses and credentials (config/&lt;project&gt;/environments).</Typography.Text>
                <Space.Compact style={{ width: '100%' }}>
                    <Input addonBefore="Name" placeholder="e.g. crm or claims-portal" value={slug} status={slug && !slugOk ? 'error' : undefined} onChange={(e) => { setSlug(e.target.value.toLowerCase()); setPreview(null); }} aria-label="Project name" autoFocus />
                    <Input addonBefore="Shown as" placeholder={slug ? slug.toUpperCase() : 'e.g. Claims Portal'} value={displayName} onChange={(e) => { setDisplayName(e.target.value); setPreview(null); }} aria-label="Project shown name" />
                </Space.Compact>
                <Typography.Text strong>Environments</Typography.Text>
                {envs.map((e, i) => <Space.Compact key={i} style={{ width: '100%' }}>
                    <Input style={{ width: 110 }} placeholder="dev" value={e.name} onChange={(x) => set(i, 'name', x.target.value.toLowerCase())} aria-label={`Environment ${i + 1} name`} />
                    <Input placeholder="Application address (https://…)" value={e.baseUrl} onChange={(x) => set(i, 'baseUrl', x.target.value)} aria-label={`Environment ${i + 1} address`} className="mono" />
                    <Input style={{ width: 280 }} placeholder="Sign-in address (optional)" value={e.loginUrl} onChange={(x) => set(i, 'loginUrl', x.target.value)} aria-label={`Environment ${i + 1} sign-in address`} className="mono" />
                    <Button icon={<DeleteOutlined />} disabled={envs.length === 1} aria-label={`Remove environment ${i + 1}`} onClick={() => setEnvs(envs.filter((_x, j) => j !== i))} />
                </Space.Compact>)}
                <Button size="small" icon={<PlusOutlined />} disabled={envs.length >= 8} onClick={() => setEnvs([...envs, { name: ['sit', 'uat', 'prod'].find((n) => !envs.some((x) => x.name === n)) ?? '', baseUrl: '', loginUrl: '' }])}>Environment</Button>
                <Space wrap>
                    <span>Database</span>
                    <Select style={{ width: 160 }} value={dbType} onChange={(v) => { setDbType(v); setPreview(null); }} aria-label="Database"
                        options={[{ value: 'none', label: 'None' }, { value: 'oracle', label: 'Oracle' }, { value: 'sqlserver', label: 'SQL Server' }, { value: 'mysql', label: 'MySQL' }, { value: 'postgresql', label: 'PostgreSQL' }]} />
                </Space>
                <Collapse size="small" items={[{ key: 'c', label: 'Application user (optional)', children: <Space direction="vertical" style={{ width: '100%' }}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>Written to each environment's file as {(slug || 'project').toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_USERNAME and _PASSWORD; the framework encrypts the password (ENCRYPTED:). The Studio does not keep them. Change them per environment later.</Typography.Text>
                    <Input addonBefore="User" value={user} onChange={(e) => { setUser(e.target.value); setPreview(null); }} aria-label="Application user" autoComplete="off" />
                    <Input.Password addonBefore="Password" value={password} onChange={(e) => { setPassword(e.target.value); setPreview(null); }} aria-label="Application password" autoComplete="new-password" />
                </Space> }]} />
            </Space>}
            {preview && <Space direction="vertical" style={{ width: '100%' }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    config/global.env: {preview.globalEnv === 'written' ? <Tag color="green">the framework's defaults (this repository has none)</Tag> : preview.globalEnv === 'kept' ? <Tag>the repository's own, unchanged</Tag> : <Tag color="warning">not available in this framework version</Tag>}
                    {dbType !== 'none' && <>Database connection: <Tag className="mono">{preview.alias}</Tag></>}
                </Typography.Text>
                {preview.notes.map((n) => <Alert key={n} type="info" showIcon message={n} />)}
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>Folders: {preview.dirs.map((d) => <Tag key={d} className="mono">{d}</Tag>)}</Typography.Text>
                <PlanReview review={preview.review} height={420} />
            </Space>}
        </Modal>
    );
}
