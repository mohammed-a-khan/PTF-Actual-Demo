/**
 * A save of the Agents screens refused because what it saves changed since the screen read it (409: another browser
 * tab, someone else, a pull). The person chooses: Reload (see the saved version; their changes here are dropped),
 * Overwrite (save theirs over it on purpose), or keep editing.
 */
import React from 'react';
import { App, Button, Space } from 'antd';
import { ApiError } from '../api';
import { errText } from '../state';

export const isChangedElsewhere = (e: unknown): boolean => e instanceof ApiError && e.status === 409;

type Modal = ReturnType<typeof App.useApp>['modal'];

/** The questions open now (by title): a second refused save (a double click on Save) does not stack a second one. */
const openQuestions = new Set<string>();

/** Ask what to do; `what` names the thing ("The agent "Checkout reviewer"", "The knowledge sources"). */
export function askChangedElsewhere(modal: Modal, e: unknown, what: string, o: {
    reload: () => void; overwrite: () => Promise<unknown> | void;
    /** Optional: called on "Keep editing" (and on closing the question), e.g. so the next save goes through. */
    keepEditing?: () => void;
    /** "Keep editing" makes the next Save replace the version saved elsewhere (keepEditing hands that version over): said in the question. */
    keepOverwrites?: boolean;
}): void {
    const title = `${what} changed in another tab or by someone else`;
    if (openQuestions.has(title)) return;
    openQuestions.add(title);
    let busy = false;
    let decided = false;
    const m = modal.confirm({
        afterClose: () => { openQuestions.delete(title); if (!decided) o.keepEditing?.(); },
        title,
        content: <>{errText(e)}<br /><br /><b>Reload</b> shows the saved version (your changes here are dropped). <b>Overwrite</b> saves yours over it (the other change is lost).
            {o.keepOverwrites ? <> <b>Keep editing</b> keeps your changes here: your next Save will replace the version saved elsewhere.</> : null}</>,
        closable: true, maskClosable: false,
        footer: () => (
            <Space style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }} wrap>
                <Button onClick={() => m.destroy()}>Keep editing</Button>
                <Button danger onClick={async () => { if (busy) return; busy = true; decided = true; try { await o.overwrite(); } finally { busy = false; m.destroy(); } }}>Overwrite</Button>
                <Button type="primary" onClick={() => { decided = true; m.destroy(); o.reload(); }}>Reload</Button>
            </Space>
        ),
    });
}
