/**
 * Chunked concurrent execution with per-item failure isolation.
 *
 * Every ADO batch operation (work items, attachments, test results) has server-
 * side chunk caps. Callers slice their input into chunks, dispatch each chunk
 * in parallel, and want failures in one chunk NOT to fail the whole run.
 *
 * `Promise.allSettled` is the natural primitive; `bulkExecute` adds:
 * - chunk splitting at a caller-chosen `chunkSize` (200 for WI, 50 for attachments)
 * - per-chunk retry via caller-supplied workFn (which typically wraps AdoHttpClient
 *   whose retry policy already handles 429/5xx)
 * - clean `{ok: [...], failed: [{item, error}]}` output so callers can render
 *   both halves in a single report without try/catch scaffolding
 *
 * The workFn receives the full chunk (not one item at a time) so batch endpoints
 * that accept N items per request can still exploit their batching.
 */

export interface BulkOptions<In, Out> {
    /** Items per chunk sent to workFn; ADO WI cap is 200, attachments cap is 50. */
    chunkSize: number;
    /** Max chunks in flight at any moment; default 4. */
    concurrency?: number;
    /** Turn `In[]` chunk into `Out[]` — must return one Out per In in the same order. */
    workFn: (chunk: In[], chunkIndex: number) => Promise<Out[]>;
    /**
     * Optional: called ONCE per failed chunk with the raw error before results are
     * broken down per item. Useful for logging. Failures are then attributed to
     * every item in the chunk.
     */
    onChunkError?: (err: Error, chunk: In[], chunkIndex: number) => void;
}

export interface BulkResult<In, Out> {
    ok: Out[];
    failed: Array<{ item: In; error: Error; chunkIndex: number }>;
    /** Chunks attempted (input array length / chunkSize, rounded up). */
    chunks: number;
    /** Chunks that threw entirely (workFn rejected). */
    failedChunks: number;
}

export function chunk<T>(items: T[], size: number): T[][] {
    if (size <= 0) throw new Error('bulk_batcher: chunkSize must be positive');
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
        out.push(items.slice(i, i + size));
    }
    return out;
}

export async function bulkExecute<In, Out>(items: In[], opts: BulkOptions<In, Out>): Promise<BulkResult<In, Out>> {
    if (items.length === 0) return { ok: [], failed: [], chunks: 0, failedChunks: 0 };
    const chunks = chunk(items, opts.chunkSize);
    const concurrency = Math.max(1, opts.concurrency ?? 4);
    const ok: Out[] = [];
    const failed: Array<{ item: In; error: Error; chunkIndex: number }> = [];
    let failedChunks = 0;

    // Simple concurrency gate: process chunks in windows of `concurrency`.
    // Using Promise.allSettled per window keeps memory bounded and preserves
    // failure isolation without pulling in p-limit.
    for (let base = 0; base < chunks.length; base += concurrency) {
        const window = chunks.slice(base, base + concurrency);
        const settled = await Promise.allSettled(
            window.map(async (chunkItems, offsetInWindow) => {
                const chunkIndex = base + offsetInWindow;
                try {
                    const result = await opts.workFn(chunkItems, chunkIndex);
                    return { chunkIndex, chunkItems, result };
                } catch (err) {
                    const error = err instanceof Error ? err : new Error(String(err));
                    if (opts.onChunkError) {
                        try { opts.onChunkError(error, chunkItems, chunkIndex); } catch { /* swallow */ }
                    }
                    // Re-throw so the outer allSettled sees a rejection.
                    throw { chunkIndex, chunkItems, error };
                }
            }),
        );
        for (const s of settled) {
            if (s.status === 'fulfilled') {
                for (const r of s.value.result) ok.push(r);
            } else {
                failedChunks++;
                const payload = s.reason as { chunkIndex: number; chunkItems: In[]; error: Error };
                for (const item of payload.chunkItems) failed.push({ item, error: payload.error, chunkIndex: payload.chunkIndex });
            }
        }
    }
    return { ok, failed, chunks: chunks.length, failedChunks };
}
