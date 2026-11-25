/**
 * Shared bits of the data / source-control / Azure DevOps / settings screens:
 *  - useStoredTab: the inner tab a screen shows, remembered on this computer;
 *  - AdoNotSetUp: one short, calm "not set up" state for the Azure DevOps screens.
 */
import React from 'react';
import { Button, Result, Space, Typography } from 'antd';
import { CloudServerOutlined, LockOutlined, ReloadOutlined, SettingOutlined } from '@ant-design/icons';
import { navigate } from './route';
import './styles-datagit.css';

/** The selected inner tab of a screen, kept in localStorage (private mode: just not remembered). */
export function useStoredTab<T extends string>(key: string, tabs: readonly T[], fallback: T): [T, (t: T) => void] {
    const [tab, setRaw] = React.useState<T>(() => {
        try { const v = localStorage.getItem(`cs-studio-tab:${key}`) as T | null; return v && tabs.includes(v) ? v : fallback; } catch { return fallback; }
    });
    const set = React.useCallback((t: T) => { setRaw(t); try { localStorage.setItem(`cs-studio-tab:${key}`, t); } catch { /* private mode */ } }, [key]);
    return [tab, set];
}

/** An error that means "Azure DevOps is not set up here" (no address, project or token), not a failure. */
export function isAdoNotSetUp(error: string | null | undefined): boolean {
    if (!error) return false;
    return /personal access token as the secret|No ADO personal access token|ADO_ORGANIZATION(_URL)? is not set|ADO_PROJECT is not set|No framework project found|organization URL looks wrong|Azure DevOps is not set up/i.test(error);
}

/** The secret the error asks for (ADO_PAT unless it names another). */
function secretOf(error: string): string {
    return /\bsecret ([A-Z][A-Z0-9_]{1,63})\b/.exec(error)?.[1] ?? 'ADO_PAT';
}

/** "Azure DevOps is not set up": what the screen would show, one line why, and the ways out. */
export function AdoNotSetUp({ what, error, onRetry, compact }: { what: string; error: string; onRetry?: () => void; compact?: boolean }) {
    const needsToken = /access token|ADO_PAT|secret/i.test(error);
    return (
        <div className={`dg-ado-empty${compact ? ' compact' : ''}`} data-testid="ado-not-set-up">
            <Result icon={<CloudServerOutlined />} title="Azure DevOps is not set up"
                subTitle={<Space direction="vertical" size={2}>
                    <span>{what} come from Azure DevOps.</span>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>{error.replace(/\s*\((Secrets|Settings) → [^)]*\)/g, '')}</Typography.Text>
                </Space>}
                extra={<Space wrap style={{ justifyContent: 'center' }}>
                    {needsToken && <Button type="primary" icon={<LockOutlined />} onClick={() => navigate(['secrets', 'add', secretOf(error)])}>Add {secretOf(error)}</Button>}
                    <Button icon={<SettingOutlined />} onClick={() => navigate(['settings', 'ado'])}>Azure DevOps settings</Button>
                    {onRetry && <Button icon={<ReloadOutlined />} onClick={onRetry}>Try again</Button>}
                </Space>} />
        </div>
    );
}
