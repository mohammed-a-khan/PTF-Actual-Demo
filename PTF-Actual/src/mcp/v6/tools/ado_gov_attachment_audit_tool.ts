/**
 * cs_qa_gov_attachment_audit — Scan attachments referenced by an ADO work
 * item OR a local test-run output folder. Per-attachment verdict considers:
 *   - MIME-vs-extension mismatch (declared vs sniffed via magic bytes)
 *   - Size caps (default 20 MB; overridable via input.maxBytes)
 *   - SHA-256 checked against `.cs-qa/gov/attachment-blocklist.json`
 *
 * Sources (any combination):
 *   workItemId    → fetches relations, downloads AttachedFile blobs via
 *                   AdoHttpClient.getBinary (Retry-After honored, size-capped)
 *   localDir      → glob every regular file under the folder (recursive)
 *   localFiles    → explicit file list (absolute or workspace-relative)
 *
 * Read-only — no elicitation. Returns per-attachment verdict + aggregate
 * counts. On blocklist HIT, verdict is 'block' regardless of size/mime.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import { AdoHttpClient, type AdoBinaryResponse } from './_helpers/ado_http_client';
import { createLogger } from './_helpers/structured_logger';
import { getResolvedCreds } from './ado_config_tool';
import { loadAttachmentBlocklist } from './_helpers/governance_config';

const InputSchema = z.object({
    workItemId: z.number().int().positive().optional().describe('When set, list AttachedFile relations on this work item and audit each.'),
    localDir: z.string().min(1).optional().describe('Workspace-relative or absolute directory to audit recursively.'),
    localFiles: z.array(z.string().min(1)).optional().describe('Explicit list of files to audit.'),
    maxBytes: z.number().int().positive().default(20 * 1024 * 1024).describe('Files larger than this are flagged with verdict=block, kind=size-cap.'),
    forbidExtensions: z.array(z.string().min(1)).default(['exe', 'bat', 'cmd', 'com', 'ps1', 'sh', 'dll', 'msi', 'jar', 'scr']).describe('Extensions (no dot) that are always blocked regardless of MIME.'),
    /** ADO cascade overrides. */
    orgUrl: z.string().url().optional(),
    project: z.string().min(1).optional(),
    pat: z.string().min(1).optional(),
});

const VerdictSchema = z.object({
    source: z.enum(['ado-work-item', 'local-file']),
    file: z.string(),
    sizeBytes: z.number(),
    sha256: z.string(),
    declaredMime: z.string().optional(),
    sniffedMime: z.string().optional(),
    extension: z.string().optional(),
    verdict: z.enum(['pass', 'warn', 'block']),
    reasons: z.array(z.string()),
    matchedBlocklistHash: z.boolean(),
});

const OutputSchema = z.object({
    ok: z.boolean(),
    blocklistPath: z.string(),
    blocklistCount: z.number(),
    scanned: z.number(),
    passed: z.number(),
    warned: z.number(),
    blocked: z.number(),
    verdicts: z.array(VerdictSchema),
    warnings: z.array(z.string()),
    note: z.string().optional(),
});

// Small magic-byte sniffer covering the top formats we see in QA artefacts.
function sniffMime(buf: Buffer): string | undefined {
    if (buf.length < 4) return undefined;
    if (buf.slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'image/png';
    if (buf.slice(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
    if (buf.slice(0, 4).equals(Buffer.from([0x25, 0x50, 0x44, 0x46]))) return 'application/pdf';
    if (buf.slice(0, 2).equals(Buffer.from([0x50, 0x4b])) && buf.length > 30) {
        // ZIP family (also .docx/.xlsx/.pptx/.jar).
        return 'application/zip';
    }
    if (buf.slice(0, 4).equals(Buffer.from([0x47, 0x49, 0x46, 0x38]))) return 'image/gif';
    if (buf.slice(0, 2).equals(Buffer.from([0x4d, 0x5a]))) return 'application/x-msdownload'; // MZ (Windows PE)
    if (buf.slice(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return 'application/x-elf';
    if (buf.slice(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return 'application/vnd.ms-office';
    // UTF-8 text heuristic — probe first 512 bytes.
    const probe = buf.slice(0, 512).toString('utf-8');
    if (/^[\x09\x0a\x0d\x20-\x7e]*$/.test(probe)) {
        if (/^\s*[\[{]/.test(probe)) return 'application/json';
        if (/^\s*</.test(probe)) return 'application/xml';
        return 'text/plain';
    }
    return undefined;
}

function extToMime(ext: string): string | undefined {
    const map: Record<string, string> = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
        pdf: 'application/pdf', zip: 'application/zip', json: 'application/json',
        xml: 'application/xml', txt: 'text/plain', log: 'text/plain', md: 'text/markdown',
        csv: 'text/csv', html: 'text/html', htm: 'text/html', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        exe: 'application/x-msdownload', bat: 'application/x-msdownload',
        sh: 'application/x-sh', jar: 'application/java-archive', msi: 'application/x-msi',
        dll: 'application/x-msdownload', ps1: 'text/x-powershell',
    };
    return map[ext.toLowerCase()];
}

function extIsIn(files: string, forbid: string[]): { forbid: boolean; ext: string } {
    const ext = path.extname(files).replace(/^\./, '').toLowerCase();
    return { forbid: forbid.map((e) => e.toLowerCase()).includes(ext), ext };
}

function auditBuffer(source: 'ado-work-item' | 'local-file', fileName: string, buf: Buffer, declaredMime: string | undefined, maxBytes: number, forbidExtensions: string[], blocklist: Set<string>): z.infer<typeof VerdictSchema> {
    const reasons: string[] = [];
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const sniffed = sniffMime(buf);
    const { forbid, ext } = extIsIn(fileName, forbidExtensions);
    let verdict: 'pass' | 'warn' | 'block' = 'pass';
    if (buf.length > maxBytes) {
        verdict = 'block';
        reasons.push(`size ${buf.length} bytes exceeds cap ${maxBytes}`);
    }
    if (forbid) {
        verdict = 'block';
        reasons.push(`extension .${ext} is on the forbidden-extensions list`);
    }
    const matchedBlocklistHash = blocklist.has(sha256);
    if (matchedBlocklistHash) {
        verdict = 'block';
        reasons.push(`sha256 ${sha256} is on .cs-qa/gov/attachment-blocklist.json`);
    }
    const extMime = ext ? extToMime(ext) : undefined;
    if (declaredMime && sniffed && !declaredMime.startsWith(sniffed.split('/')[0])) {
        if (verdict === 'pass') verdict = 'warn';
        reasons.push(`declared MIME "${declaredMime}" does not match sniffed "${sniffed}"`);
    }
    if (extMime && sniffed && extMime.split('/')[0] !== sniffed.split('/')[0]) {
        if (verdict === 'pass') verdict = 'warn';
        reasons.push(`extension .${ext} implies "${extMime}" but bytes look like "${sniffed}" — possible extension spoof`);
    }
    return {
        source, file: fileName, sizeBytes: buf.length, sha256,
        declaredMime, sniffedMime: sniffed, extension: ext || undefined,
        verdict, reasons, matchedBlocklistHash,
    };
}

function walkFiles(root: string): string[] {
    const out: string[] = [];
    function walk(p: string): void {
        let stat: fs.Stats;
        try { stat = fs.statSync(p); } catch { return; }
        if (stat.isFile()) { out.push(p); return; }
        if (!stat.isDirectory()) return;
        let entries: string[] = [];
        try { entries = fs.readdirSync(p); } catch { return; }
        for (const e of entries) {
            if (e === 'node_modules' || e === '.git') continue;
            walk(path.join(p, e));
        }
    }
    walk(root);
    return out;
}

registerPrimitive({
    name: 'cs_qa_gov_attachment_audit',
    description: 'Governance hook — scan attachments referenced by an ADO work item or a local test-run folder. Per-attachment verdict considers MIME-vs-extension mismatch, size cap (default 20 MB), forbidden extensions (exe/bat/cmd/dll/…), and SHA-256 against .cs-qa/gov/attachment-blocklist.json. Read-only. Inputs: {workItemId?, localDir?, localFiles?, maxBytes?, forbidExtensions?}. Example: {workItemId:12345, maxBytes:10485760} — audits every AttachedFile relation on WI 12345 and blocks any over 10 MB or in the blocklist.',
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    run: async (ctx, input) => {
        const log = createLogger(ctx.invocationId, 'cs_qa_gov_attachment_audit', { workspaceRoot: ctx.workspaceRoot });
        const warnings: string[] = [];
        const { blocklist, warning: blWarn, path: blPath } = loadAttachmentBlocklist(ctx.workspaceRoot);
        if (blWarn) warnings.push(blWarn);
        const blocklistSet = new Set(blocklist.hashes.map((h) => h.sha256.toLowerCase()));
        const verdicts: Array<z.infer<typeof VerdictSchema>> = [];

        // 1. Local files.
        const localTargets: string[] = [];
        if (input.localFiles) {
            for (const f of input.localFiles) {
                const abs = path.isAbsolute(f) ? f : path.join(ctx.workspaceRoot, f);
                localTargets.push(abs);
            }
        }
        if (input.localDir) {
            const abs = path.isAbsolute(input.localDir) ? input.localDir : path.join(ctx.workspaceRoot, input.localDir);
            if (fs.existsSync(abs)) localTargets.push(...walkFiles(abs));
            else warnings.push(`localDir does not exist: ${abs}`);
        }
        for (const f of localTargets) {
            try {
                const stat = fs.statSync(f);
                if (!stat.isFile()) continue;
                // For size-cap check, if the file is over cap, still read up to cap to
                // compute a partial SHA-256 (real full hash requires full read) — for
                // audit purposes we surface a block verdict on size alone.
                if (stat.size > input.maxBytes) {
                    verdicts.push({
                        source: 'local-file', file: f, sizeBytes: stat.size, sha256: '',
                        declaredMime: undefined, sniffedMime: undefined, extension: path.extname(f).replace(/^\./, ''),
                        verdict: 'block', reasons: [`size ${stat.size} bytes exceeds cap ${input.maxBytes}; skipped hash`], matchedBlocklistHash: false,
                    });
                    continue;
                }
                const buf = fs.readFileSync(f);
                verdicts.push(auditBuffer('local-file', f, buf, undefined, input.maxBytes, input.forbidExtensions, blocklistSet));
            } catch (e) {
                warnings.push(`Failed to read ${f}: ${(e as Error).message}`);
            }
        }

        // 2. Work item attachments.
        if (input.workItemId) {
            const credsRes = getResolvedCreds(ctx.workspaceRoot, { orgUrl: input.orgUrl, project: input.project, personalAccessToken: input.pat });
            if (!credsRes.creds) {
                warnings.push(credsRes.diagnostic);
            } else {
                const client = new AdoHttpClient(credsRes.creds);
                try {
                    const wi = await client.get<Record<string, unknown>>(`_apis/wit/workitems/${input.workItemId}?api-version=7.0&$expand=relations`);
                    const relations = ((wi?.relations as Array<Record<string, unknown>>) || []).filter((r) => r && r.rel === 'AttachedFile');
                    if (relations.length === 0) {
                        warnings.push(`Work item ${input.workItemId} has no attachments.`);
                    }
                    for (const rel of relations) {
                        const url = String(rel.url ?? '');
                        const attrs = (rel.attributes as Record<string, unknown>) || {};
                        const name = String(attrs.name ?? 'unnamed');
                        const declaredMime = (attrs.resourceContentType as string) || undefined;
                        const guidMatch = /\/attachments\/([0-9a-f-]{36})/i.exec(url);
                        if (!guidMatch) {
                            warnings.push(`Could not parse attachment guid from url: ${url}`);
                            continue;
                        }
                        try {
                            const bin: AdoBinaryResponse = await client.getBinary(
                                `_apis/wit/attachments/${guidMatch[1]}?download=true&api-version=7.0`,
                                { maxResponseBytes: input.maxBytes + 4096 }, // small headroom to detect overflow
                            );
                            if (bin.truncated) {
                                verdicts.push({
                                    source: 'ado-work-item', file: name, sizeBytes: bin.contentLength, sha256: '',
                                    declaredMime, sniffedMime: undefined, extension: path.extname(name).replace(/^\./, ''),
                                    verdict: 'block', reasons: [`response truncated at cap ${input.maxBytes} — full attachment exceeds cap`], matchedBlocklistHash: false,
                                });
                                continue;
                            }
                            verdicts.push(auditBuffer('ado-work-item', name, bin.body, declaredMime, input.maxBytes, input.forbidExtensions, blocklistSet));
                        } catch (e) {
                            warnings.push(`Attachment "${name}" download failed: ${(e as Error).message}`);
                        }
                    }
                } catch (e) {
                    warnings.push(`Work item ${input.workItemId} fetch failed: ${(e as Error).message}`);
                }
            }
        }

        const passed = verdicts.filter((v) => v.verdict === 'pass').length;
        const warned = verdicts.filter((v) => v.verdict === 'warn').length;
        const blocked = verdicts.filter((v) => v.verdict === 'block').length;
        log.info('attachment audit complete', { scanned: verdicts.length, passed, warned, blocked, blocklistCount: blocklistSet.size });
        return {
            ok: blocked === 0,
            blocklistPath: blPath,
            blocklistCount: blocklistSet.size,
            scanned: verdicts.length,
            passed, warned, blocked,
            verdicts,
            warnings,
            note: `${verdicts.length} attachment(s) scanned — ${passed} pass, ${warned} warn, ${blocked} block. Blocklist entries: ${blocklistSet.size}.`,
        };
    },
});
