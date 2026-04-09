import * as fs from 'fs';
import * as path from 'path';
import { CSReporter } from '../reporter/CSReporter';

export interface StepTimingEntry {
    stepName: string;
    keyword: string;  // Given/When/Then/And
    status: 'passed' | 'failed' | 'skipped';
    startOffset: number;  // milliseconds from scenario start
    endOffset: number;
    duration: number;
}

export class CSStepTimeline {
    private static instance: CSStepTimeline;

    // Current scenario timing data
    private scenarioStartTime: number = 0;
    private currentStepStartTime: number = 0;
    private steps: StepTimingEntry[] = [];
    private scenarioName: string = '';

    private constructor() {}

    static getInstance(): CSStepTimeline {
        // Use global key to handle cross-module singleton (same pattern as CSBrowserManager)
        const globalKey = '__csStepTimelineInstance';
        if ((global as any)[globalKey]) {
            CSStepTimeline.instance = (global as any)[globalKey];
            return CSStepTimeline.instance;
        }
        if (!CSStepTimeline.instance) {
            CSStepTimeline.instance = new CSStepTimeline();
            (global as any)[globalKey] = CSStepTimeline.instance;
        }
        return CSStepTimeline.instance;
    }

    /** Called when a new scenario starts */
    startScenario(scenarioName: string): void {
        this.scenarioName = scenarioName;
        this.scenarioStartTime = Date.now();
        this.steps = [];
    }

    /** Called when a step starts executing */
    startStep(keyword: string, stepText: string): void {
        this.currentStepStartTime = Date.now();
    }

    /** Called when a step completes */
    endStep(keyword: string, stepText: string, status: 'passed' | 'failed' | 'skipped'): void {
        const now = Date.now();
        this.steps.push({
            stepName: `${keyword} ${stepText}`,
            keyword,
            status,
            startOffset: this.currentStepStartTime - this.scenarioStartTime,
            endOffset: now - this.scenarioStartTime,
            duration: now - this.currentStepStartTime,
        });
    }

    /** Get all step timing entries for the current scenario */
    getSteps(): StepTimingEntry[] {
        return [...this.steps];
    }

    /** Get total scenario duration so far */
    getScenarioDuration(): number {
        return Date.now() - this.scenarioStartTime;
    }

    /**
     * Generate a WebVTT subtitle file from step timing data.
     * Each step becomes a subtitle cue with pass/fail prefix.
     *
     * @param outputPath - where to save the .vtt file
     * @param steps - step timing entries (defaults to current scenario's steps)
     */
    generateVTT(outputPath: string, steps?: StepTimingEntry[]): void {
        const entries = steps || this.steps;
        if (entries.length === 0) return;

        let vtt = 'WEBVTT\n\n';
        for (let i = 0; i < entries.length; i++) {
            const s = entries[i];
            const startTime = this.formatVTTTime(s.startOffset);
            const endTime = this.formatVTTTime(s.endOffset);
            const icon = s.status === 'passed' ? 'PASS' : s.status === 'failed' ? 'FAIL' : 'SKIP';
            vtt += `${i + 1}\n`;
            vtt += `${startTime} --> ${endTime}\n`;
            vtt += `[${icon}] Step ${i + 1}/${entries.length}: ${s.stepName}\n\n`;
        }

        try {
            const dir = path.dirname(outputPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(outputPath, vtt, 'utf-8');
            CSReporter.debug(`Step timeline VTT saved: ${outputPath}`);
        } catch (e) {
            CSReporter.debug(`Failed to save VTT: ${e}`);
        }
    }

    /**
     * Generate timeline data as a JSON object for embedding in HTML reports.
     * Each entry has the step info + time offsets in seconds.
     */
    generateTimelineData(steps?: StepTimingEntry[]): Array<{
        index: number;
        name: string;
        keyword: string;
        status: string;
        startSec: number;
        endSec: number;
        durationSec: number;
    }> {
        const entries = steps || this.steps;
        return entries.map((s, i) => ({
            index: i + 1,
            name: s.stepName,
            keyword: s.keyword,
            status: s.status,
            startSec: Math.round(s.startOffset / 100) / 10, // 1 decimal
            endSec: Math.round(s.endOffset / 100) / 10,
            durationSec: Math.round(s.duration / 100) / 10,
        }));
    }

    /** Convert milliseconds to VTT timestamp format (HH:MM:SS.mmm) */
    private formatVTTTime(ms: number): string {
        const totalSeconds = Math.max(0, ms / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = Math.floor(totalSeconds % 60);
        const millis = Math.round((totalSeconds % 1) * 1000);
        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
    }

    /** Reset for next scenario */
    reset(): void {
        this.steps = [];
        this.scenarioStartTime = 0;
        this.currentStepStartTime = 0;
        this.scenarioName = '';
    }
}
