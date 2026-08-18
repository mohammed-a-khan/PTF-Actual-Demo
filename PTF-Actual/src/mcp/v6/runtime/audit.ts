import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AuditEvent } from './Primitive';

export function auditRoot(): string {
    return process.env.CS_QA_V6_HOME
        ? path.join(process.env.CS_QA_V6_HOME, 'audit')
        : path.join(os.homedir(), '.cs-qa', 'v5', 'audit');
}

export async function appendAudit(event: AuditEvent): Promise<void> {
    const dir = auditRoot();
    fs.mkdirSync(dir, { recursive: true });
    const day = new Date(event.ts).toISOString().slice(0, 10);
    const file = path.join(dir, `${day}.jsonl`);
    fs.appendFileSync(file, JSON.stringify(event) + '\n', 'utf-8');
}
