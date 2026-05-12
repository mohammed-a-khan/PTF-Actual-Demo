/**
 * Phase-scoped work queue for the v1.38 iterator architecture.
 *
 * Why this exists: through v1.37.x the framework offered LLM clients
 * "envelopes" describing all the work to do (produce 9 scenarios, then
 * produce 14 files). The LLM kept blowing per-message output caps trying
 * to compose multi-piece payloads. We added chunked recording + hard
 * payload caps as bandaids, but each release surfaced a new way for the
 * LLM to do too much per turn.
 *
 * v1.38 flips it. The framework owns the iteration. Each tool response
 * carries the spec for ONE next piece of work. The LLM never sees the
 * full set in its context — only "produce this one thing, submit it,
 * I'll tell you what's next."
 *
 * Pattern is borrowed from LangGraph's per-step checkpointer model:
 * persist queue state after every advance; on crash/compaction the
 * caller resumes from the last persisted position via `peekNext`.
 *
 * @module agent-platform/CSWorkQueue
 */

import * as fs from 'fs';
import * as path from 'path';
import { CSRunContext } from './CSRunContext';

/** Items appear in two flavours — one per phase. */
export type AnalyzeQueueItem = {
    kind: 'analyze-scenario';
    /** scenarioId as it appears in @MetaData / @QAFDataProvider. */
    id: string;
    /** Java method name (legacyMethodName in the analysis). */
    methodName: string;
    /** Absolute path to the entry test file. */
    legacyFile: string;
    /** [startLine, endLine] of the @Test method body (1-indexed). */
    legacyLineRange: [number, number];
    /** Helper invocations that MUST be expanded inline via csaa_expand_helper. */
    helpersToExpand: Array<{ helperClass: string; helperMethod: string }>;
    /**
     * Floor for the LLM's emitted step count. Derived from
     * CSLegacySignatureExtractor.expectedActionCount(). The
     * record_analysis step-coverage gate uses this as the >=70% floor.
     */
    expectedActionCount: number;
    /** Optional: legacy data file the LLM should call csaa_read_legacy_data on. */
    dataFileHint?: { annotationValue: string; sheetName?: string; rowKey?: string };
};

export type TranslateQueueItem =
    | {
          kind: 'feature';
          relativePath: string;
          /** scenarioIds the feature must declare (one Scenario per id). */
          scenarioIds: string[];
      }
    | {
          kind: 'steps';
          relativePath: string;
          /** Step-def patterns the LLM must implement (collected from feature). */
          stepDefTexts: string[];
      }
    | {
          kind: 'page';
          relativePath: string;
          /** Legacy class name to extract @FindBy from via csaa_extract_page_fields. */
          legacyClassName: string;
          /** Floor for @CSGetElement count (from page-coverage signature gate). */
          minFieldCount: number;
      }
    | {
          kind: 'data';
          relativePath: string;
          /** ScenarioIds whose dataRow columns must appear in the JSON. */
          scenarioIds: string[];
      };

export type QueueItem = AnalyzeQueueItem | TranslateQueueItem;

export type Phase = 'analyze' | 'translate';

interface QueueState {
    version: 1;
    analyze: {
        items: AnalyzeQueueItem[];
        position: number; // index of NEXT item to produce
        completedAt?: string; // ISO timestamp when queue drained
    };
    translate: {
        items: TranslateQueueItem[];
        position: number;
        completedAt?: string;
    };
}

const QUEUE_FILE = 'queue.json';

/**
 * Stateful work queue persisted to `<runFolder>/queue.json`. All mutations
 * write through to disk so the queue survives conversation compaction and
 * process restarts — symmetric with LangGraph's checkpointer pattern.
 */
export class CSWorkQueue {
    private ctx: CSRunContext;
    private state: QueueState;
    private queuePath: string;

    private constructor(ctx: CSRunContext, state: QueueState, queuePath: string) {
        this.ctx = ctx;
        this.state = state;
        this.queuePath = queuePath;
    }

    /**
     * Load the queue for a run. Creates a fresh empty queue if none exists.
     * Callers should use `seedAnalyze` / `seedTranslate` after load to
     * populate items the first time.
     */
    static load(ctx: CSRunContext): CSWorkQueue {
        const queuePath = path.join(ctx.runFolder, QUEUE_FILE);
        let state: QueueState;
        if (fs.existsSync(queuePath)) {
            try {
                const raw = fs.readFileSync(queuePath, 'utf-8');
                state = JSON.parse(raw) as QueueState;
                if (state.version !== 1) {
                    state = CSWorkQueue.emptyState();
                }
            } catch {
                state = CSWorkQueue.emptyState();
            }
        } else {
            state = CSWorkQueue.emptyState();
        }
        return new CSWorkQueue(ctx, state, queuePath);
    }

    private static emptyState(): QueueState {
        return {
            version: 1,
            analyze: { items: [], position: 0 },
            translate: { items: [], position: 0 },
        };
    }

    /** Replace the analyze queue with a fresh item list. */
    seedAnalyze(items: AnalyzeQueueItem[]): void {
        this.state.analyze = { items, position: 0 };
        this.persist();
    }

    /** Replace the translate queue with a fresh item list. */
    seedTranslate(items: TranslateQueueItem[]): void {
        this.state.translate = { items, position: 0 };
        this.persist();
    }

    /** Returns the next un-completed item for a phase, or null when drained. */
    peekNext(phase: Phase): QueueItem | null {
        const slot = this.state[phase];
        if (slot.position >= slot.items.length) return null;
        return slot.items[slot.position];
    }

    /**
     * Advance the queue by one item. Returns the NEW next item (or null if
     * the queue is now drained). Callers typically use this in the tool
     * handler's append flow:
     *   ` const nextItem = queue.advance(phase); `
     *   ` if (nextItem) return { ...spec for next... }; `
     *   ` else return { ...transition to next phase or finalize... }; `
     */
    advance(phase: Phase): QueueItem | null {
        const slot = this.state[phase];
        if (slot.position < slot.items.length) {
            slot.position++;
            if (slot.position >= slot.items.length) {
                slot.completedAt = new Date().toISOString();
            }
        }
        this.persist();
        return this.peekNext(phase);
    }

    /** True when every item in the phase has been advanced past. */
    isEmpty(phase: Phase): boolean {
        const slot = this.state[phase];
        return slot.position >= slot.items.length;
    }

    /** Total items seeded in the phase (constant after seeding). */
    total(phase: Phase): number {
        return this.state[phase].items.length;
    }

    /** Items completed so far (== position). */
    completed(phase: Phase): number {
        return Math.min(this.state[phase].position, this.state[phase].items.length);
    }

    /** Human-readable progress string, e.g. "3/9". */
    progress(phase: Phase): string {
        return `${this.completed(phase)}/${this.total(phase)}`;
    }

    /**
     * Reset position to 0 for a phase. Used when the LLM needs to start the
     * phase over (rare — only after a catastrophic semantic-gate rejection
     * that invalidates every staged item).
     */
    rewind(phase: Phase): void {
        this.state[phase].position = 0;
        delete this.state[phase].completedAt;
        this.persist();
    }

    /** Raw state read for diagnostics — do not mutate the result. */
    snapshot(): Readonly<QueueState> {
        return this.state;
    }

    private persist(): void {
        fs.writeFileSync(this.queuePath, JSON.stringify(this.state, null, 2), 'utf-8');
    }
}
