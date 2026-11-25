/**
 * Post a test run's results to its pull request as a comment. The text is prepared (Markdown, as
 * Azure DevOps shows it), the user can change it, and nothing is posted until they press Post.
 */
import React from 'react';
import { Alert, App, Button, Input, Modal, Space, Typography } from 'antd';
import { api } from '../api';
import { errText } from '../state';

export function PrPostResults({ repo, id, run, open, onClose, onPosted }: { repo: string; id: number; run: string | null; open: boolean; onClose: () => void; onPosted?: () => void }) {
    const { message } = App.useApp();
    const [text, setText] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [err, setErr] = React.useState<string | null>(null);
    React.useEffect(() => {
        if (!open || !run) return;
        setText(''); setErr(null);
        api.prResultsComment(repo, id, run).then((r) => setText(r.text)).catch((e) => setErr(errText(e)));
    }, [open, run, repo, id]);
    const post = async () => {
        setBusy(true);
        try { await api.prComment(repo, id, text, 'results'); message.success(`Posted the results to pull request #${id}`); onClose(); onPosted?.(); }
        catch (e) { setErr(errText(e)); }
        finally { setBusy(false); }
    };
    return (
        <Modal open={open} title={`Post the results to pull request #${id}`} width={780} onCancel={onClose}
            footer={<Space><Button onClick={onClose}>Cancel</Button><Button type="primary" loading={busy} disabled={!text.trim()} onClick={post}>Post comment</Button></Space>}>
            <Typography.Paragraph type="secondary">Everyone on the pull request sees this comment. Change it as you like before posting (Markdown). It is posted as information (already resolved), so it never holds up completing the pull request.</Typography.Paragraph>
            {err && <Alert type="error" showIcon style={{ marginBottom: 8 }} message={err} />}
            <Input.TextArea className="mono" value={text} onChange={(e) => setText(e.target.value)} autoSize={{ minRows: 10, maxRows: 24 }} aria-label="Comment" />
        </Modal>
    );
}
