/**
 * Git actions offered in more than one place (Source control, the Code file tree and editor menus):
 * one confirm and one way of doing each, so they behave the same everywhere.
 */
import type { useAppProps } from 'antd/es/app/context';
import { api } from './api';
import { errText } from './state';
import { navigate } from './route';

type Ui = Pick<useAppProps, 'modal' | 'message'>;

/** "Discard changes…": asks, then puts the files back to their last committed version (a copy of yours is kept). */
export function confirmDiscard(ui: Ui, paths: string[], after?: () => void | Promise<void>): void {
    ui.modal.confirm({
        title: paths.length === 1 ? `Discard your changes to ${paths[0]}?` : `Discard changes in ${paths.length} files?`,
        content: 'The files go back to their last committed version (new files are removed). A copy of your version is kept in the recovery folder, just in case.',
        okText: 'Discard', okButtonProps: { danger: true },
        onOk: async () => {
            try {
                const r = await api.discard(paths);
                const short = r.recoveryDir.replace(/\\/g, '/').replace(/^.*?(\.git\/)/, '$1');
                ui.message.success(`Discarded. A copy of your version is in ${short}`);
                await after?.();
            } catch (e) { ui.message.error(errText(e)); }
        },
    });
}

/** Source control's diff of a changed file (the area it is in: staged, not staged yet, or a conflict). */
export function openChanges(path: string, area: 'staged' | 'changes' | 'conflict'): void {
    navigate(['git', 'changes', area, path]);
}

let pendingHistoryPath: string | null = null;
export const HISTORY_PATH_EVENT = 'cs-history-path';
/** Source control's History, filtered to the commits that changed a file or folder. */
export function showHistory(path: string): void {
    pendingHistoryPath = path;
    window.dispatchEvent(new CustomEvent(HISTORY_PATH_EVENT, { detail: { path } }));
    navigate(['git', 'history']);
}
/** The path History was asked to filter by (once). */
export function takeHistoryPath(): string | null {
    const p = pendingHistoryPath;
    pendingHistoryPath = null;
    return p;
}

/** Copy text to the clipboard, saying so (or saying it could not). */
export function copyText(ui: Pick<Ui, 'message'>, text: string, what: string): void {
    const ok = () => ui.message.success(`${what} copied`, 1.2);
    const fail = () => ui.message.warning(`Could not copy: ${text}`);
    if (!navigator.clipboard?.writeText) { fail(); return; }
    navigator.clipboard.writeText(text).then(ok, fail);
}
