import React from 'react';
import { Checkbox, Segmented, Select, Space, Tooltip } from 'antd';
import { DiffPrefs } from './DiffView';

export function DiffToolbar({ prefs, onChange }: { prefs: DiffPrefs; onChange: (p: Partial<DiffPrefs>) => void }) {
    return (
        <Space size={8} wrap>
            <Segmented size="small" value={prefs.mode} onChange={(v) => onChange({ mode: v as DiffPrefs['mode'] })}
                options={[{ value: 'unified', label: 'Inline' }, { value: 'split', label: 'Side by side' }]} />
            <Tooltip title="Hide changes that are only spaces or tabs">
                <Select size="small" value={prefs.ws} onChange={(v) => onChange({ ws: v })} style={{ width: 168 }}
                    options={[{ value: 'none', label: 'Show whitespace changes' }, { value: 'changes', label: 'Ignore whitespace changes' }, { value: 'all', label: 'Ignore all whitespace' }]} />
            </Tooltip>
            <Tooltip title="Ignore Windows/Unix line-ending differences (CRLF vs LF)">
                <Checkbox checked={prefs.eol} onChange={(e) => onChange({ eol: e.target.checked })}>Ignore line endings</Checkbox>
            </Tooltip>
        </Space>
    );
}
