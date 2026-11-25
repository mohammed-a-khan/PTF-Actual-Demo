/**
 * The Studio browser, live: what agents (or the person) do in it. Click on the picture or type while it
 * has the focus to take over; an address bar opens pages. The agent's actions are recorded: "Open in
 * Recorder" turns them into a framework test there.
 */
import React from 'react';
import { App, Button, Empty, Input, Space, Tag, Tooltip, Typography } from 'antd';
import { ArrowLeftOutlined, CloseOutlined, ReloadOutlined, VideoCameraOutlined } from '@ant-design/icons';
import { api, BrowserFrame } from '../api';
import { errText } from '../state';
import { navigate } from '../route';

export const RECORDER_IMPORT_KEY = 'cs-studio-rec-import';

export function AgentBrowser({ active }: { active: boolean }) {
    const { message } = App.useApp();
    const [frame, setFrame] = React.useState<BrowserFrame | null>(null);
    const [url, setUrl] = React.useState('');
    const [lines, setLines] = React.useState(0);
    const seq = React.useRef(0);
    const img = React.useRef<HTMLImageElement>(null);

    React.useEffect(() => {
        if (!active) return;
        let stop = false;
        const tick = async () => {
            try {
                const f = await api.browserFrame(seq.current);
                if (stop) return;
                if (f.frame) { seq.current = f.frame.seq; setFrame(f); } else setFrame((x) => (x ? { ...x, running: f.running, actor: f.actor } : f));
            } catch { /* next tick */ }
            if (!stop) setTimeout(tick, 250);
        };
        void tick();
        const count = () => { api.browserRecording().then((x) => setLines(x.lines)).catch(() => {}); };
        count();
        const r = setInterval(count, 2000);
        return () => { stop = true; clearInterval(r); };
    }, [active]);

    const send = (input: Record<string, unknown>) => api.browserInput(input).catch((e) => message.error(errText(e)));
    const onClick = (e: React.MouseEvent<HTMLImageElement>) => {
        const f = frame?.frame;
        const el = img.current;
        if (!f || !el) return;
        const r = el.getBoundingClientRect();
        void send({ type: 'click', x: Math.round(((e.clientX - r.left) / r.width) * f.width), y: Math.round(((e.clientY - r.top) / r.height) * f.height) });
        el.focus();
    };
    const onKey = (e: React.KeyboardEvent) => {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        e.preventDefault();
        if (e.key.length === 1) void send({ type: 'type', text: e.key });
        else void send({ type: 'key', key: e.key });
    };
    const open = async () => { if (!url.trim()) return; try { await api.browserOpen(/^https?:\/\//.test(url.trim()) ? url.trim() : `https://${url.trim()}`); } catch (e) { message.error(errText(e)); } };
    const toRecorder = async () => {
        const r = await api.browserRecording();
        try { localStorage.setItem(RECORDER_IMPORT_KEY, r.script); } catch { /* private mode */ }
        navigate(['recorder']);
    };
    const f = frame?.frame;
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, height: '100%', minHeight: 0 }}>
            <Space.Compact style={{ width: '100%' }}>
                <Tooltip title="Back"><Button size="small" icon={<ArrowLeftOutlined />} aria-label="Back" disabled={!frame?.running} onClick={() => void send({ type: 'back' })} /></Tooltip>
                <Tooltip title="Reload"><Button size="small" icon={<ReloadOutlined />} aria-label="Reload" disabled={!frame?.running} onClick={() => void send({ type: 'reload' })} /></Tooltip>
                <Input size="small" className="mono" placeholder={f?.url || 'Address to open'} value={url} onChange={(e) => setUrl(e.target.value)} onPressEnter={() => void open()} aria-label="Browser address" />
                <Tooltip title="Close the browser"><Button size="small" icon={<CloseOutlined />} aria-label="Close the browser" disabled={!frame?.running} onClick={() => void api.browserClose().then(() => setFrame(null))} /></Tooltip>
            </Space.Compact>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                {frame?.running ? <Tag color={frame.actor === 'person' ? 'blue' : 'purple'} bordered={false}>{frame.actor === 'person' ? 'You' : frame.actor === 'agent' ? 'Agent' : 'Ready'}</Tag> : <Tag bordered={false}>Not started</Tag>}
                <Typography.Text type="secondary" ellipsis style={{ flex: 1, fontSize: 12 }} className="mono">{f?.url}</Typography.Text>
                <Tooltip title="The agent's actions (and passing checks) as a recording: turn it into a framework test in the Recorder">
                    <Button size="small" icon={<VideoCameraOutlined />} disabled={!lines} onClick={() => void toRecorder()}>Open in Recorder ({lines})</Button>
                </Tooltip>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflow: 'auto', border: '1px solid var(--panel-border)', borderRadius: 6, background: '#000', display: 'grid', placeItems: 'start center' }}>
                {f ? <img ref={img} tabIndex={0} alt={`Studio browser: ${f.url}`} src={`data:image/jpeg;base64,${f.data}`} onClick={onClick} onKeyDown={onKey}
                    style={{ width: '100%', height: 'auto', cursor: 'pointer', outline: 'none' }} />
                    : <Empty style={{ marginTop: 60 }} description={<span style={{ color: '#aaa' }}>The browser starts when an agent opens the application, or when you enter an address.</span>} />}
            </div>
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>Click the picture and type to take over; the agent continues from what the page shows.</Typography.Text>
        </div>
    );
}
