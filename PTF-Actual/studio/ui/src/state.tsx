/**
 * Shared Studio state: repository status, branches and environment summary. Every screen reads it,
 * and the coming Copilot assistant will read the same context (current branch, changes, problems).
 */
import React from 'react';
import { api, BranchInfo, Discover, RepoStatus } from './api';
import { useRoute } from './route';

const FILES_CHANGED = 'cs-studio:files-changed';
/** A screen wrote or deleted files in the repository (a saved query, a setting): the repository's status is read again. */
export function filesChanged(): void { window.dispatchEvent(new Event(FILES_CHANGED)); }

export interface StudioState {
    repoRoot: string;
    projectId: string;
    status: RepoStatus | null;
    branches: BranchInfo[];
    env: Discover | null;
    error: string | null;
    refresh: () => Promise<void>;
}

const Ctx = React.createContext<StudioState | null>(null);

export function StudioProvider({ children }: { children: React.ReactNode }) {
    const [repoRoot, setRepoRoot] = React.useState('');
    const [projectId, setProjectId] = React.useState('');
    const [status, setStatus] = React.useState<RepoStatus | null>(null);
    const [branches, setBranches] = React.useState<BranchInfo[]>([]);
    const [env, setEnv] = React.useState<Discover | null>(null);
    const [error, setError] = React.useState<string | null>(null);

    const refresh = React.useCallback(async () => {
        try {
            const [h, s, b, e] = await Promise.all([api.health(), api.status(), api.branches(), api.envDiscover()]);
            setRepoRoot(h.repoRoot); setProjectId(h.projectId); setStatus(s); setBranches(b); setEnv(e); setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }, []);

    React.useEffect(() => {
        void refresh();
        // Pick up changes made outside the Studio (editor saves, command-line git) when the tab regains focus or is
        // shown again, and files a screen wrote (a saved query, a setting): Source control's lists and badges follow.
        let timer: number | undefined;
        const soon = () => { window.clearTimeout(timer); timer = window.setTimeout(() => void refresh(), 150); };
        const onShown = () => { if (document.visibilityState === 'visible') soon(); };
        window.addEventListener('focus', soon);
        window.addEventListener(FILES_CHANGED, soon);
        document.addEventListener('visibilitychange', onShown);
        return () => { window.clearTimeout(timer); window.removeEventListener('focus', soon); window.removeEventListener(FILES_CHANGED, soon); document.removeEventListener('visibilitychange', onShown); };
    }, [refresh]);
    // Another screen opened (the menu, Back, a link): what it shows of the repository is read again.
    const screen = useRoute()[0];
    const firstScreen = React.useRef(true);
    React.useEffect(() => {
        if (firstScreen.current) { firstScreen.current = false; return; }
        void refresh();
    }, [screen, refresh]);

    return <Ctx.Provider value={{ repoRoot, projectId, status, branches, env, error, refresh }}>{children}</Ctx.Provider>;
}

export function useStudio(): StudioState {
    const v = React.useContext(Ctx);
    if (!v) throw new Error('useStudio outside StudioProvider');
    return v;
}

export const errText = (e: unknown) => {
    const m = e instanceof Error ? e.message : String(e);
    // The browser's words when the request never reached the Studio (stopped, restarted, or the network dropped).
    if (/^(Failed to fetch|NetworkError when attempting to fetch resource\.?|Load failed|The network connection was lost\.?)$/i.test(m.trim())) return 'The Studio did not answer: check that it is still running (the terminal where it was started), then try again.';
    if (e instanceof Error && e.name === 'AbortError') return 'The request was cancelled.';
    return m;
};

/** Ask the Code screen to open a file (from anywhere: problems, history, search). */
export function openInEditor(path: string, line?: number, column?: number): void {
    window.dispatchEvent(new CustomEvent('cs-open-file', { detail: { path, line, column } }));
}

/** Remembered "where to run" choice (project + environment and options), shared by every Run button. */
export interface RunTarget { project: string; env: string; browser?: string; headless?: boolean; workers?: number; retries?: number; device?: string; width?: number; height?: number; vars?: string; ado?: 'on' | 'off' }
export function loadRunTarget(): RunTarget | null {
    try { const v = JSON.parse(localStorage.getItem('cs-studio-run-target') ?? 'null'); return v && v.project && v.env ? v : null; } catch { return null; }
}
export function saveRunTarget(t: RunTarget): void { try { localStorage.setItem('cs-studio-run-target', JSON.stringify(t)); } catch { /* ignore */ } }
/** Ask the Run tests screen to show a run (after it was started from somewhere else). */
export function showRun(id: string): void { window.dispatchEvent(new CustomEvent('cs-show-run', { detail: { id } })); }

/** Files with unsaved edits in the editor (kept up to date by the Code screen). */
export const unsavedFiles = new Set<string>();
