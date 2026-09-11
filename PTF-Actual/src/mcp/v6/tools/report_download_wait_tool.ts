/**
 * cs_qa_report_download_wait — Trigger + wait for a PDF download from a live page.
 *
 * Wraps Playwright's `page.waitForEvent('download')`. Used inside the E2E
 * report-validation flow: after data entry, the agent clicks a "Generate"
 * button and needs to capture the emitted PDF onto disk before it can run
 * spec init / validate.
 *
 * Two shapes:
 *   - triggerClick: The primitive both waits for the download AND clicks the
 *     trigger inside the wait — needed because Playwright's download event
 *     fires DURING the click, not after.
 *   - triggerNone: Assume the click already happened, just wait for a download
 *     event within the timeout. Used when the click was fired by an earlier
 *     step-def and the agent just needs to save the payload.
 *
 * The downloaded file is saved to `saveTo` (or auto-generated under
 * `.cct-qa/downloads/`) so the agent can pass it to `cs_qa_report_spec_init`
 * or `cs_qa_report_validate` in the next step.
 *
 * @module mcp/v6/tools/report_download_wait_tool
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { registerPrimitive } from '../runtime/Primitive';
import { getOrStart } from '../browser/session';

registerPrimitive({
    name: 'cs_qa_report_download_wait',
    description:
        "Wait for (and optionally trigger) a PDF download from a live browser session. Uses the shared browser session managed by cs_qa_browse. Returns the saved file path + size + mime. Verbs: click-then-wait (fires a click inside the wait — needed by Playwright's event ordering), wait-only (click already fired elsewhere, just capture the payload).",
    inputSchema: z.discriminatedUnion('verb', [
        z.object({
            verb: z.literal('click-then-wait'),
            sessionId: z.string().min(1).describe('The session id used by cs_qa_browse. Reuses the same page.'),
            triggerSelector: z.string().min(1).describe('Selector for the button that triggers the download.'),
            saveTo: z.string().optional().describe('Where to save the download. Default: .cct-qa/downloads/<suggested>.'),
            timeoutMs: z.number().int().positive().max(300_000).default(30_000),
        }),
        z.object({
            verb: z.literal('wait-only'),
            sessionId: z.string().min(1),
            saveTo: z.string().optional(),
            timeoutMs: z.number().int().positive().max(300_000).default(30_000),
        }),
    ]),
    outputSchema: z.object({
        status: z.enum(['ok', 'error', 'timeout']),
        filePath: z.string().optional(),
        suggestedFilename: z.string().optional(),
        sizeBytes: z.number().optional(),
        downloadedAt: z.string().optional(),
        error: z.string().optional(),
    }),
    async run(ctx, input) {
        try {
            const session = await getOrStart(input.sessionId);
            const page = session.page;

            const downloadPromise = page.waitForEvent('download', { timeout: input.timeoutMs });
            if (input.verb === 'click-then-wait') {
                // Click inside the wait — Playwright's download event fires during
                // the click, not after, so we can't await the click first.
                try {
                    await page.click(input.triggerSelector, { timeout: input.timeoutMs });
                } catch (e) {
                    return { status: 'error' as const, error: `Click failed on ${input.triggerSelector}: ${(e as Error).message}` };
                }
            }

            let download;
            try {
                download = await downloadPromise;
            } catch (e) {
                const msg = (e as Error).message;
                if (msg.includes('Timeout') || msg.includes('timeout')) {
                    return { status: 'timeout' as const, error: `No download event within ${input.timeoutMs}ms` };
                }
                return { status: 'error' as const, error: msg };
            }

            const suggested = download.suggestedFilename();
            const targetDir = path.join(ctx.workspaceRoot, '.cct-qa', 'downloads');
            fs.mkdirSync(targetDir, { recursive: true });
            const savePath = input.saveTo
                ? path.isAbsolute(input.saveTo)
                    ? input.saveTo
                    : path.resolve(ctx.workspaceRoot, input.saveTo)
                : path.join(targetDir, `${Date.now()}-${suggested}`);
            fs.mkdirSync(path.dirname(savePath), { recursive: true });
            await download.saveAs(savePath);

            const stat = fs.statSync(savePath);
            await ctx.audit({
                ts: new Date().toISOString(),
                tool: 'cs_qa_report_download_wait',
                input: { verb: input.verb, sessionId: input.sessionId, saveTo: input.saveTo },
                outputSummary: { filePath: savePath, sizeBytes: stat.size, suggestedFilename: suggested },
                durationMs: 0,
            });

            return {
                status: 'ok' as const,
                filePath: savePath,
                suggestedFilename: suggested,
                sizeBytes: stat.size,
                downloadedAt: new Date().toISOString(),
            };
        } catch (e) {
            return { status: 'error' as const, error: (e as Error).message };
        }
    },
});
