/**
 * "Open in merge tool": resolve the conflict in the user's own merge tool (Beyond Compare, KDiff3, P4Merge, WinMerge,
 * Meld, VS Code, or one set up in Git). The Studio waits for the tool to close and picks up the result.
 */
import React from 'react';
import { App, Button, Dropdown, Space, Tooltip, Typography } from 'antd';
import { DownOutlined, LoadingOutlined } from '@ant-design/icons';
import { api } from '../api';
import { errText } from '../state';

type Tools = Awaited<ReturnType<typeof api.mergeTools>>;
let cached: Promise<Tools> | null = null;

export function MergeToolButton({ file, onResolved, onClosed }: { file: string; onResolved: () => void; onClosed: () => void }) {
    const { message } = App.useApp();
    const [tools, setTools] = React.useState<Tools | null>(null);
    const [waiting, setWaiting] = React.useState<string | null>(null);
    React.useEffect(() => {
        cached ??= api.mergeTools().catch((e) => { cached = null; throw e; });
        void cached.then((t) => { setTools(t); const r = t.runs[file]; if (r && !r.done) setWaiting(r.tool); }).catch(() => setTools({ tools: [], runs: {} }));
    }, [file]);
    React.useEffect(() => {
        if (!waiting) return;
        const t = setInterval(() => {
            void api.mergeTools().then((x) => {
                const r = x.runs[file];
                if (!r?.done) return;
                setWaiting(null);
                if (r.done.resolved) { message.success(r.done.message); onResolved(); } else { message.warning(r.done.message); onClosed(); }
            }).catch(() => undefined);
        }, 1500);
        return () => clearInterval(t);
    }, [waiting, file]); // eslint-disable-line react-hooks/exhaustive-deps
    if (!tools) return null;
    if (!tools.tools.length) return <Tooltip title="No merge tool was found on this computer. Install one (for example Beyond Compare, KDiff3, P4Merge, WinMerge, Meld or VS Code), or set one up in Git (git config --global merge.tool …)."><Button size="small" disabled>Open in merge tool</Button></Tooltip>;
    const open = async (tool: string) => {
        try {
            const r = await api.openMergeTool(file, tool);
            if (r.done) { (r.done.resolved ? message.success : message.error)(r.done.message); if (r.done.resolved) onResolved(); return; }
            setWaiting(tool);
        } catch (e) { message.error(errText(e)); }
    };
    if (waiting) return <Space size={6}><LoadingOutlined /><Typography.Text>Waiting for {tools.tools.find((t) => t.name === waiting)?.label ?? waiting} to close…</Typography.Text></Space>;
    const first = tools.tools[0];
    return (
        <Dropdown.Button size="small" onClick={() => void open(first.name)} icon={<DownOutlined />}
            menu={{ items: tools.tools.map((t) => ({ key: t.name, label: <span>{t.label}{t.name === tools.default ? <Typography.Text type="secondary"> (your default)</Typography.Text> : t.userDefined ? <Typography.Text type="secondary"> (from your Git settings)</Typography.Text> : null}</span> })), onClick: ({ key }) => void open(key) }}>
            <Tooltip title="Resolve this file in your own merge tool; the Studio picks up the result when you close it">Open in {first.label}</Tooltip>
        </Dropdown.Button>
    );
}
