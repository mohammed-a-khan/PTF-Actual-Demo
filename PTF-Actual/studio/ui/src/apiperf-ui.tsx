/**
 * Small helpers shared by the API and Performance screens: an inner tab remembered per screen (localStorage,
 * private mode tolerated), and a section title with its help in a tooltip instead of a paragraph.
 */
import React from 'react';
import { Tooltip, Typography } from 'antd';
import { QuestionCircleOutlined } from '@ant-design/icons';
import './styles-apiperf.css';

const KEY = 'cs-apiperf-tab:';

/** The selected inner tab of a screen, remembered on this computer; an unknown key falls back to the first one. */
export function useRememberedTab(id: string, def: string): [string, (k: string) => void] {
    const [k, setK] = React.useState<string>(() => { try { return localStorage.getItem(KEY + id) ?? def; } catch { return def; } });
    const set = React.useCallback((v: string) => { setK(v); try { localStorage.setItem(KEY + id, v); } catch { /* private mode */ } }, [id]);
    return [k, set];
}
/** The remembered tab when it is one of the tabs shown now, else the first. */
export const shownTab = (k: string, keys: Array<string | undefined | false>): string => {
    const ok = keys.filter((x): x is string => !!x);
    return ok.includes(k) ? k : ok[0] ?? k;
};

/** A small section title with its explanation behind a "?" (no paragraphs above forms). */
export function SectionTitle({ children, help, extra }: { children: React.ReactNode; help?: React.ReactNode; extra?: React.ReactNode }) {
    return (
        <div className="ap-section-title">
            <Typography.Text strong>{children}</Typography.Text>
            {help && <Tooltip title={help}><QuestionCircleOutlined className="ap-help" aria-label="Help" /></Tooltip>}
            {extra && <span className="ap-section-extra">{extra}</span>}
        </div>
    );
}
