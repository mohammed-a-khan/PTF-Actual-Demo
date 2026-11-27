/**
 * Switching branches with uncommitted changes. They belong to the working folder, not to a branch, so Git takes
 * them along to the other branch (and refuses when that branch has other versions of the same files). Asked
 * each time, as editors do: stash them on this branch and switch (they are offered back on return), take them
 * along, or stay. Back on a branch whose changes were stashed this way, they are offered back.
 */
import React from 'react';
import { App, Button, Space, Typography } from 'antd';
import { api, StashEntry } from './api';
import { errText, useStudio } from './state';

type Choice = 'stash' | 'carry' | 'cancel';

export function useSwitchBranch(): (name: string) => Promise<boolean> {
    const { modal, message } = App.useApp();
    const { status, refresh } = useStudio();
    const ask = (name: string, n: number) => new Promise<Choice>((resolve) => {
        let done = false;
        const pick = (c: Choice) => { if (done) return; done = true; inst.destroy(); resolve(c); };
        const inst = modal.confirm({
            title: `Switch to ${name} with ${n} uncommitted change${n === 1 ? '' : 's'}?`,
            content: <>
                <Typography.Paragraph>Uncommitted changes belong to the working folder, not to a branch: switching takes them along to {name}, where they show as changes too.</Typography.Paragraph>
                <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}><b>Keep them on {status?.branch ?? 'this branch'}</b> stashes them; when you come back to {status?.branch ?? 'it'} you are asked whether to put them back.</Typography.Paragraph>
            </>,
            closable: true, keyboard: true, width: 520,
            onCancel: () => { if (!done) { done = true; resolve('cancel'); } },
            afterClose: () => { if (!done) { done = true; resolve('cancel'); } },
            footer: () => <Space style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }} wrap>
                <Button onClick={() => pick('cancel')}>Cancel</Button>
                <Button onClick={() => pick('carry')} data-testid="switch-carry">Take them along</Button>
                <Button type="primary" autoFocus onClick={() => pick('stash')} data-testid="switch-stash">Keep them on {status?.branch ?? 'this branch'}</Button>
            </Space>,
        });
    });
    const offerBack = (name: string, st: StashEntry) => new Promise<void>((resolve) => {
        modal.confirm({
            title: `Put back the changes you left on ${name}?`,
            content: `When you switched away from ${name} (${new Date(st.date).toLocaleString()}), its uncommitted changes were stashed. They can be put back now, or later from Source control → Stashes.`,
            okText: 'Put them back', cancelText: 'Not now',
            onOk: async () => {
                try {
                    const r = await api.stashApply(st.index, true, st.sha);
                    if (r.status === 'ok') message.success('Changes put back');
                    else modal.warning({ title: 'Put back with conflicts', content: r.message ?? 'Some files conflict: resolve them in Source control.' });
                } catch (e) { modal.error({ title: 'Could not put the changes back', content: errText(e) }); }
                await refresh(); resolve();
            },
            onCancel: () => resolve(),
        });
    });
    return async (name: string) => {
        const n = status?.files.length ?? 0;
        const choice: Choice = n ? await ask(name, n) : 'carry';
        if (choice === 'cancel') return false;
        try {
            const r = await api.switchBranch(name, { stash: choice === 'stash' });
            message.success(r.stashed ? `Switched to ${name}; ${n} change${n === 1 ? '' : 's'} kept on the branch you left` : `Switched to ${name}`);
            await refresh();
            if (r.autoStash) await offerBack(name, r.autoStash);
            return true;
        } catch (e) {
            modal.error({ title: `Could not switch to ${name}`, content: errText(e), width: 560 });
            await refresh();
            return false;
        }
    };
}
