/** Who last changed each line of a file (git blame), grouped into runs of lines from the same commit. */
import React from 'react';
import { Modal, Spin, Table, Typography } from 'antd';
import { api } from '../api';
import { errText } from '../state';

interface Run { from: number; to: number; sha: string; author: string; date: string; summary: string }

export function BlameView({ file, onClose }: { file: string; onClose: () => void }) {
    const [rows, setRows] = React.useState<Run[] | null>(null);
    const [err, setErr] = React.useState<string | null>(null);
    React.useEffect(() => {
        api.blame(file).then((lines) => {
            const runs: Run[] = [];
            for (const l of lines) {
                const last = runs[runs.length - 1];
                if (last && last.sha === l.sha && last.to === l.line - 1) last.to = l.line;
                else runs.push({ from: l.line, to: l.line, sha: l.sha, author: l.author, date: l.date, summary: l.summary });
            }
            setRows(runs);
        }).catch((e) => setErr(errText(e)));
    }, [file]);
    return (
        <Modal open width={900} footer={null} onCancel={onClose} title={`Who changed ${file}`}>
            {err ? <Typography.Text type="danger">{err}</Typography.Text> : !rows ? <Spin /> : (
                <Table<Run> size="small" rowKey={(r) => `${r.from}`} dataSource={rows} pagination={{ pageSize: 50, hideOnSinglePage: true }}
                    columns={[
                        { title: 'Lines', width: 90, render: (_, r) => (r.from === r.to ? r.from : `${r.from}–${r.to}`) },
                        { title: 'Commit', width: 90, render: (_, r) => (/^0+$/.test(r.sha) ? <Typography.Text type="warning">not committed</Typography.Text> : <Typography.Text code>{r.sha.slice(0, 7)}</Typography.Text>) },
                        { title: 'Who', dataIndex: 'author', width: 160, ellipsis: true },
                        { title: 'When', width: 110, render: (_, r) => (r.date ? new Date(r.date).toLocaleDateString() : '') },
                        { title: 'Message', dataIndex: 'summary', ellipsis: true },
                    ]} />
            )}
        </Modal>
    );
}
