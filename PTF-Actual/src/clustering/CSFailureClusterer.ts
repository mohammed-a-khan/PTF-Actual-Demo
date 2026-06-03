/**
 * CSFailureClusterer - Group failed scenarios by likely root cause
 *
 * At end of a run, takes every recorded failure and groups them with
 * DBSCAN over a composite similarity vector. The output answers the
 * question "I have 12 failures — how many actual bugs is that?".
 *
 * Singleton, in-memory only (cluster output is per-run; no
 * cross-run persistence needed). Gated by
 * `FAILURE_CLUSTERING_ENABLED` (default false) so suites that don't
 * opt in see no behaviour change.
 *
 * Similarity vector:
 *   - Normalised error-message token set, Jaccard similarity
 *   - Normalised stack-trace token set (top frames), Jaccard similarity
 *   - Composite = w_msg · J(msg) + w_stack · J(stack)
 *   - Distance = 1 - composite, range [0, 1]
 *
 * DBSCAN:
 *   - For each point, find neighbours within `eps` distance
 *   - If ≥ `minPts` neighbours, point is a core, expand cluster
 *   - Else point is an outlier (noise)
 *
 * Pure TypeScript, no new npm dependency.
 *
 * @module clustering
 */

import { CSReporter } from '../reporter/CSReporter';
import { CSConfigurationManager } from '../core/CSConfigurationManager';
import { FailureSample, FailureCluster, FailureClusterReport } from './CSFailureClusterTypes';

const STOPWORDS = new Set([
    'the', 'and', 'for', 'with', 'this', 'that', 'are', 'was', 'were', 'not',
    'but', 'has', 'have', 'had', 'into', 'from', 'their', 'they', 'will',
    'can', 'cannot', 'when', 'while', 'where', 'what', 'which', 'who',
    'error', 'failed', 'failure', 'expected', 'actual', 'got', 'received',
]);

export class CSFailureClusterer {
    private static instance: CSFailureClusterer;
    private config: CSConfigurationManager;
    private samples: FailureSample[] = [];

    private constructor() {
        this.config = CSConfigurationManager.getInstance();
    }

    public static getInstance(): CSFailureClusterer {
        if (!CSFailureClusterer.instance) {
            CSFailureClusterer.instance = new CSFailureClusterer();
        }
        return CSFailureClusterer.instance;
    }

    public isEnabled(): boolean {
        return this.config.getBoolean('FAILURE_CLUSTERING_ENABLED', false);
    }

    private getEps(): number {
        return this.config.getNumber('FAILURE_CLUSTERING_EPS', 0.4);
    }

    private getMinPts(): number {
        return this.config.getNumber('FAILURE_CLUSTERING_MIN_PTS', 2);
    }

    private getMessageWeight(): number {
        return this.config.getNumber('FAILURE_CLUSTERING_MSG_WEIGHT', 0.6);
    }

    private getStackWeight(): number {
        return this.config.getNumber('FAILURE_CLUSTERING_STACK_WEIGHT', 0.4);
    }

    /**
     * Record a single failure. Called from the BDD runner at the same
     * place as `CSFlakyTestDetector.recordTestResult(... 'failed' ...)`.
     */
    public recordFailure(sample: Omit<FailureSample, 'timestamp'>): void {
        if (!this.isEnabled()) return;
        this.samples.push({ ...sample, timestamp: new Date().toISOString() });
    }

    /** Clear all recorded samples — useful between independent runs in the same process. */
    public reset(): void {
        this.samples = [];
    }

    /** Snapshot of currently-recorded failures, for debugging / inspection. */
    public getSamples(): FailureSample[] {
        return [...this.samples];
    }

    /**
     * Run DBSCAN over the recorded failures and produce the cluster
     * report. Returns null when clustering is disabled or there are
     * fewer than two failures (nothing to cluster).
     */
    public cluster(): FailureClusterReport | null {
        if (!this.isEnabled()) return null;
        const n = this.samples.length;
        if (n === 0) return null;

        const eps = this.getEps();
        const minPts = this.getMinPts();
        const wMsg = this.getMessageWeight();
        const wStack = this.getStackWeight();

        // Pre-compute token sets per sample.
        const msgTokens: Array<Set<string>> = this.samples.map(s => tokeniseMessage(s.errorMessage));
        const stackTokens: Array<Set<string>> = this.samples.map(s => tokeniseStack(s.stackTrace || ''));

        // Pairwise distance — only ever needs the upper triangle.
        const distance = (i: number, j: number): number => {
            const sMsg = jaccard(msgTokens[i], msgTokens[j]);
            const sStack = jaccard(stackTokens[i], stackTokens[j]);
            const composite = wMsg * sMsg + wStack * sStack;
            return 1 - composite;
        };

        // DBSCAN.
        const labels: number[] = new Array(n).fill(-2); // -2 = unvisited, -1 = noise, ≥0 = cluster id
        let nextCluster = 0;

        for (let i = 0; i < n; i++) {
            if (labels[i] !== -2) continue;
            const neighbours = regionQuery(i, n, eps, distance);
            if (neighbours.length < minPts) {
                labels[i] = -1; // noise (may be reclassified into a cluster later)
                continue;
            }
            // Start a new cluster.
            const clusterId = nextCluster++;
            labels[i] = clusterId;
            const queue = [...neighbours];
            while (queue.length > 0) {
                const q = queue.shift()!;
                if (labels[q] === -1) {
                    labels[q] = clusterId; // border point, absorbed into the cluster
                }
                if (labels[q] !== -2) continue;
                labels[q] = clusterId;
                const qNeighbours = regionQuery(q, n, eps, distance);
                if (qNeighbours.length >= minPts) {
                    for (const qn of qNeighbours) {
                        if (labels[qn] === -2 || labels[qn] === -1) queue.push(qn);
                    }
                }
            }
        }

        // Build cluster records.
        const byCluster = new Map<number, number[]>();
        const outlierIdx: number[] = [];
        for (let i = 0; i < n; i++) {
            const lbl = labels[i];
            if (lbl === -1 || lbl === -2) {
                outlierIdx.push(i);
            } else {
                const arr = byCluster.get(lbl) || [];
                arr.push(i);
                byCluster.set(lbl, arr);
            }
        }

        const clusters: FailureCluster[] = [];
        let clusterCounter = 1;
        // Sort clusters by size, largest first.
        const sortedClusterIds = Array.from(byCluster.keys()).sort(
            (a, b) => (byCluster.get(b)!.length - byCluster.get(a)!.length),
        );
        for (const cid of sortedClusterIds) {
            const memberIdx = byCluster.get(cid)!;
            // Representative: the member whose average similarity to the rest is highest (the medoid).
            const repIdx = chooseMedoid(memberIdx, msgTokens, stackTokens, wMsg, wStack);
            const sharedStackFrames = sharedFramesFromMembers(memberIdx.map(i => this.samples[i].stackTrace || ''));
            clusters.push({
                id: clusterCounter++,
                size: memberIdx.length,
                sharedErrorMessage: this.samples[repIdx].errorMessage,
                sharedStackFrames,
                members: memberIdx.map(i => ({
                    testId: this.samples[i].testId,
                    testName: this.samples[i].testName,
                    featureFile: this.samples[i].featureFile,
                    errorMessage: this.samples[i].errorMessage,
                })),
            });
        }

        const outliers = outlierIdx.map(i => ({
            testId: this.samples[i].testId,
            testName: this.samples[i].testName,
            featureFile: this.samples[i].featureFile,
            errorMessage: this.samples[i].errorMessage,
        }));

        const report: FailureClusterReport = {
            generatedAt: new Date().toISOString(),
            totalFailures: n,
            clusterCount: clusters.length,
            outlierCount: outliers.length,
            clusters,
            outliers,
            parameters: { eps, minPts, messageWeight: wMsg, stackWeight: wStack },
        };

        CSReporter.debug(
            `[FailureClusterer] ${n} failure(s) -> ${clusters.length} cluster(s), ${outliers.length} outlier(s)`,
        );
        return report;
    }
}

// =====================================================================
// Helpers
// =====================================================================

function regionQuery(
    i: number,
    n: number,
    eps: number,
    distance: (a: number, b: number) => number,
): number[] {
    const out: number[] = [];
    for (let j = 0; j < n; j++) {
        if (j === i) continue;
        if (distance(i, j) <= eps) out.push(j);
    }
    return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 1;
    let intersect = 0;
    for (const t of a) if (b.has(t)) intersect++;
    const union = a.size + b.size - intersect;
    return union === 0 ? 0 : intersect / union;
}

/** Normalise an error message into a stable token bag. */
function tokeniseMessage(msg: string): Set<string> {
    const norm = (msg || '')
        .toLowerCase()
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, ' uuid ')
        .replace(/https?:\/\/\S+/g, ' url ')
        .replace(/\b\d+\b/g, ' n ')
        .replace(/[^a-z\s_]/g, ' ');
    const tokens = norm.split(/\s+/).filter(t => t.length >= 3 && !STOPWORDS.has(t));
    return new Set(tokens);
}

/** Normalise a stack trace into a token bag built from the top frames. */
function tokeniseStack(stack: string): Set<string> {
    const lines = (stack || '').split('\n').slice(1, 6); // top 5 frames after the message line
    const out = new Set<string>();
    for (const raw of lines) {
        // Strip absolute paths and line:col positions so different machines / shifts produce the same token.
        const norm = raw
            .toLowerCase()
            .replace(/\([^)]*\)/g, '')
            .replace(/[a-z]:\\[^\s)]+|\/[^\s)]+/g, '')
            .replace(/:\d+:\d+/g, '')
            .replace(/[^a-z0-9._]/g, ' ');
        for (const tok of norm.split(/\s+/)) {
            if (tok.length >= 3) out.add(tok);
        }
    }
    return out;
}

/** Within a cluster, pick the member most similar (on average) to the rest. */
function chooseMedoid(
    memberIdx: number[],
    msgTokens: Array<Set<string>>,
    stackTokens: Array<Set<string>>,
    wMsg: number,
    wStack: number,
): number {
    if (memberIdx.length === 1) return memberIdx[0];
    let bestIdx = memberIdx[0];
    let bestScore = -Infinity;
    for (const i of memberIdx) {
        let sum = 0;
        for (const j of memberIdx) {
            if (i === j) continue;
            sum += wMsg * jaccard(msgTokens[i], msgTokens[j])
                 + wStack * jaccard(stackTokens[i], stackTokens[j]);
        }
        if (sum > bestScore) { bestScore = sum; bestIdx = i; }
    }
    return bestIdx;
}

/** Return stack-trace lines that appear in ≥ half the cluster's members (normalised compare). */
function sharedFramesFromMembers(stacks: string[]): string[] {
    if (stacks.length === 0) return [];
    const counts = new Map<string, { display: string; count: number }>();
    for (const s of stacks) {
        const lines = (s || '').split('\n').slice(1, 6);
        const seenThisStack = new Set<string>();
        for (const raw of lines) {
            const display = raw.trim();
            const key = display
                .toLowerCase()
                .replace(/\([^)]*\)/g, '')
                .replace(/:\d+:\d+/g, '')
                .replace(/[a-z]:\\[^\s)]+|\/[^\s)]+/g, '');
            if (!key || seenThisStack.has(key)) continue;
            seenThisStack.add(key);
            const e = counts.get(key);
            if (e) e.count += 1;
            else counts.set(key, { display, count: 1 });
        }
    }
    const threshold = Math.ceil(stacks.length / 2);
    return Array.from(counts.values())
        .filter(e => e.count >= threshold)
        .sort((a, b) => b.count - a.count)
        .map(e => e.display)
        .slice(0, 3);
}
