/**
 * An Azure DevOps (or other) error, with a one-click way out when the fix is "save a secret":
 * "Save your … token as the secret ADO_PAT" gets an "Add ADO_PAT" button that opens the Secrets
 * screen with the name filled in.
 */
import React from 'react';
import { Alert, Button, Space } from 'antd';
import { LockOutlined } from '@ant-design/icons';
import { navigate } from '../route';

export function ErrorAlert({ title, error, style, onRetry }: { title: React.ReactNode; error: string; style?: React.CSSProperties; onRetry?: () => void }) {
    const secret = /\bsecret ([A-Z][A-Z0-9_]{1,63})\b/.exec(error)?.[1] ?? (/\bADO_PAT\b/.test(error) ? 'ADO_PAT' : undefined);
    return <Alert type="error" showIcon style={style} message={title} description={error}
        action={(secret || onRetry) ? <Space direction="vertical" size={4}>
            {secret && <Button size="small" type="primary" icon={<LockOutlined />} onClick={() => navigate(['secrets', 'add', secret])}>{/rejected/.test(error) ? 'Replace' : 'Add'} {secret}</Button>}
            {onRetry && <Button size="small" onClick={onRetry}>Try again</Button>}</Space> : undefined} />;
}
