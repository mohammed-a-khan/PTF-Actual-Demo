/** The request as code: cURL, PowerShell, Python, JavaScript, Java, C#, Go, PHP, Ruby, Kotlin, Swift… (values filled). */
import React from 'react';
import { Alert, App, Button, Checkbox, Modal, Select, Space, Typography } from 'antd';
import { CopyOutlined } from '@ant-design/icons';
import { api, ApiRequestDef } from '../api';
import { errText } from '../state';
import { AuthContext } from './AuthEditor';

const LANGS = [
    ['curl', 'cURL (bash)'], ['curl-cmd', 'cURL (Windows cmd)'], ['powershell', 'PowerShell'], ['httpie', 'HTTPie'], ['python', 'Python (requests)'], ['fetch', 'JavaScript (fetch)'],
    ['axios', 'JavaScript (axios)'], ['node', 'Node.js (https)'], ['java', 'Java (HttpClient)'], ['csharp', 'C# (HttpClient)'], ['go', 'Go (net/http)'], ['php', 'PHP (cURL)'],
    ['ruby', 'Ruby (Net::HTTP)'], ['kotlin', 'Kotlin (OkHttp)'], ['swift', 'Swift (URLSession)'],
];

export function SnippetModal({ open, req, saved, onClose }: { open: boolean; req: ApiRequestDef; saved: Record<string, string>; onClose: () => void }) {
    const { message } = App.useApp();
    const ctx = React.useContext(AuthContext);
    const [lang, setLang] = React.useState(() => { try { return localStorage.getItem('cs-studio-snippet-lang') ?? 'curl'; } catch { return 'curl'; } });
    const [reveal, setReveal] = React.useState(false);
    const [r, setR] = React.useState<{ code: string; missing: string[]; masked: boolean; note?: string } | null>(null);
    React.useEffect(() => {
        if (!open || !ctx) return;
        try { localStorage.setItem('cs-studio-snippet-lang', lang); } catch { /* no storage */ }
        api.apiSnippet({ project: ctx.project, env: ctx.env, collection: ctx.collection, request: req, saved, lang, reveal }).then(setR).catch((e) => message.error(errText(e)));
    }, [open, lang, reveal, req, saved, ctx, message]);
    return (
        <Modal open={open} onCancel={onClose} width={820} title="Code" footer={<Button icon={<CopyOutlined />} type="primary" disabled={!r} onClick={() => void navigator.clipboard?.writeText(r?.code ?? '').then(() => message.success('Copied'))}>Copy</Button>}>
            <Space direction="vertical" style={{ width: '100%' }}>
                <Space wrap>
                    <Select style={{ width: 220 }} value={lang} onChange={setLang} options={LANGS.map(([value, label]) => ({ value, label }))} aria-label="Language" />
                    <Checkbox checked={reveal} onChange={(e) => setReveal(e.target.checked)}>Show secret values</Checkbox>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>With this environment's values ({ctx?.env ?? 'default'}) and the saved values.</Typography.Text>
                </Space>
                {r?.missing.length ? <Alert type="warning" showIcon message={`Not filled in: ${r.missing.join(', ')}`} /> : null}
                {r?.masked && <Alert type="info" showIcon message="Secret values are shown as ••••••: tick Show secret values to copy them (do not share the code then)." />}
                {r?.note && <Alert type="info" showIcon message={r.note} />}
                <pre className="code-box" style={{ maxHeight: 460 }}>{r?.code ?? ''}</pre>
            </Space>
        </Modal>
    );
}
