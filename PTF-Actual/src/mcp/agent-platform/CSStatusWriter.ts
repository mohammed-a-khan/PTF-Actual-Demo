/**
 * Agentic Test Platform — Status Writer (Rebuild M4)
 *
 * Renders `STATUS.md` from a `RunSnapshot` so the user can keep it open in
 * a side panel and watch progress live. Also produces the per-phase report
 * markdown that lands at `<phase-folder>/report.md`, and the final
 * `final-report.md` written at run completion.
 *
 * **Why a file instead of a chat update?** Long-running migrations span
 * many tool invocations across the LLM agent's loop; chat-line progress
 * gets buried while the user reads other things. A live file in the editor
 * is always-on and reviewable post-run. Pattern validated by Anthropic's
 * "long-running Claude" engineering blog and adopted by every major agent
 * framework (LangGraph checkpoints, CrewAI process logs, Aider's chat
 * history).
 *
 * The writer is push-driven: callers invoke `CSStatusWriter.write(ctx)`
 * after every state change (phase start/finish, retry, etc.). The function
 * is idempotent — same snapshot ⇒ same file.
 *
 * @module agent-platform/CSStatusWriter
 */

import * as fs from 'fs';
import * as path from 'path';
import { CSRunContext, PhaseSnapshot, RunSnapshot } from './CSRunContext';

// ============================================================================
// Public Types
// ============================================================================

const PHASE_LABELS: Record<string, string> = {
    intake: 'Intake',
    discover: 'Discover',
    analyze: 'Analyze',
    plan: 'Plan',
    translate: 'Translate',
    audit: 'Audit',
    write: 'Write',
    execute: 'Execute',
    verify: 'Verify',
};

// ============================================================================
// CSStatusWriter
// ============================================================================

export class CSStatusWriter {
    /**
     * Re-render `STATUS.md` from the current snapshot. Always overwrites.
     * Returns the absolute path of the file written.
     */
    public static write(runContext: CSRunContext): string {
        const snap = runContext.snapshot();
        const md = CSStatusWriter.renderStatus(snap);
        const target = path.join(runContext.runFolder, 'STATUS.md');
        fs.writeFileSync(target, md, 'utf-8');
        return target;
    }

    /**
     * Write the final summary report at run completion. Includes the same
     * phase table plus aggregated attempt counts, files written, and
     * outcome.
     */
    public static writeFinalReport(
        runContext: CSRunContext,
        opts: {
            filesWritten?: string[];
            trustScore?: number;
            adoRunUrl?: string;
            warnings?: string[];
        },
    ): string {
        const snap = runContext.snapshot();
        const md = CSStatusWriter.renderFinalReport(snap, opts);
        const target = path.join(runContext.runFolder, 'final-report.md');
        fs.writeFileSync(target, md, 'utf-8');
        return target;
    }

    /**
     * Write a per-phase markdown report at `<phase-folder>/report.md`.
     * Caller supplies the body; we wrap it with a stable header so the
     * `STATUS.md` "Reports" links resolve.
     */
    public static writePhaseReport(
        runContext: CSRunContext,
        phase: string,
        title: string,
        body: string,
    ): string {
        const phaseSlug = CSRunContext.phaseFolder(phase as never);
        const dir = path.join(runContext.runFolder, phaseSlug);
        const file = path.join(dir, 'report.md');
        const header = `# ${title}\n\n_Run ID: \`${runContext.runId}\`_  \n_Phase: \`${phase}\`_  \n_Generated: ${new Date().toISOString()}_\n\n---\n\n`;
        fs.writeFileSync(file, header + body, 'utf-8');
        return file;
    }

    // ------------------------------------------------------------------
    // Renderers (pure functions over the snapshot)
    // ------------------------------------------------------------------

    private static renderStatus(snap: RunSnapshot): string {
        const elapsed = CSStatusWriter.elapsedString(snap);
        const phaseLine = CSStatusWriter.currentPhaseLine(snap);
        const lines: string[] = [];

        lines.push(`# Migration Status — \`${snap.runId}\``);
        lines.push('');
        lines.push(`**Started:** ${snap.startedAt}  `);
        if (snap.finishedAt) {
            lines.push(`**Finished:** ${snap.finishedAt}  `);
        }
        if (snap.inputSummary) {
            lines.push(`**Input:** \`${CSStatusWriter.escapeMd(snap.inputSummary)}\`  `);
        }
        lines.push(`**Phase:** ${phaseLine}  `);
        lines.push(`**Elapsed:** ${elapsed}  `);
        lines.push(`**Status:** ${CSStatusWriter.statusBadge(snap.overallStatus)}`);
        lines.push('');
        lines.push('## Progress');
        lines.push('');
        lines.push(
            '| # | Phase    | Status      | Started   | Duration | Retries | Report |',
        );
        lines.push(
            '|---|----------|-------------|-----------|----------|---------|--------|',
        );
        snap.phases.forEach((p, i) => {
            const num = String(i + 1).padStart(1);
            const phaseName = PHASE_LABELS[p.name] ?? p.name;
            const statusText = CSStatusWriter.phaseStatusText(p);
            const started = p.startedAt
                ? CSStatusWriter.timeOnly(p.startedAt)
                : '—';
            const duration = p.durationMs
                ? CSStatusWriter.formatDuration(p.durationMs)
                : '—';
            const retries =
                p.retryCount > 0 ? `${p.retryCount}/3 ⚠` : `0/3`;
            const reportLink = p.reportPath
                ? `[📄](${CSStatusWriter.relPath(snap.runFolder, p.reportPath)})`
                : '—';
            lines.push(
                `| ${num} | ${phaseName.padEnd(8)} | ${statusText.padEnd(11)} | ${started.padEnd(9)} | ${duration.padEnd(8)} | ${retries.padEnd(7)} | ${reportLink} |`,
            );
        });
        lines.push('');

        const inflight = snap.phases.find((p) => p.status === 'running');
        if (inflight) {
            lines.push('## Current activity');
            lines.push('');
            lines.push(
                `- ${PHASE_LABELS[inflight.name] ?? inflight.name} in progress`,
            );
            if (inflight.retryCount > 0) {
                lines.push(
                    `- Retry ${inflight.retryCount}/3 (LLM-resolving the gate failure)`,
                );
            }
            lines.push('');
        }

        if (snap.autoResolvedCount > 0) {
            lines.push('## Auto-resolved by LLM (no user intervention needed)');
            lines.push('');
            for (const p of snap.phases) {
                if (p.status === 'auto_resolved' && p.retryCount > 0) {
                    lines.push(
                        `- **${PHASE_LABELS[p.name] ?? p.name}** retry ${p.retryCount}: see \`${CSRunContext.phaseFolder(p.name)}/retries/attempt-${p.retryCount}/\` for the prompt + response that fixed the gate.`,
                    );
                }
            }
            lines.push('');
        }

        if (snap.userBlockedReasons.length > 0) {
            lines.push('## User input needed (blocking)');
            lines.push('');
            for (const r of snap.userBlockedReasons) {
                lines.push(`- ${r}`);
            }
            lines.push('');
        } else if (snap.overallStatus === 'running') {
            lines.push('## User input needed (blocking)');
            lines.push('');
            lines.push('- None at this time');
            lines.push('');
        }

        lines.push('## Folder');
        lines.push('');
        lines.push(`\`${snap.runFolder}\``);
        lines.push('');
        lines.push('_This file is rewritten on every phase transition + retry._');

        return lines.join('\n') + '\n';
    }

    private static renderFinalReport(
        snap: RunSnapshot,
        opts: {
            filesWritten?: string[];
            trustScore?: number;
            adoRunUrl?: string;
            warnings?: string[];
        },
    ): string {
        const elapsed = CSStatusWriter.elapsedString(snap);
        const lines: string[] = [];

        lines.push(`# Final Report — \`${snap.runId}\``);
        lines.push('');
        lines.push(
            `**Outcome:** ${CSStatusWriter.statusBadge(snap.overallStatus)}  `,
        );
        lines.push(`**Started:** ${snap.startedAt}  `);
        if (snap.finishedAt) lines.push(`**Finished:** ${snap.finishedAt}  `);
        lines.push(`**Total elapsed:** ${elapsed}  `);
        if (typeof opts.trustScore === 'number') {
            lines.push(`**Trust score:** ${opts.trustScore.toFixed(2)} / 1.00  `);
        }
        if (opts.adoRunUrl) {
            lines.push(`**ADO run:** [${opts.adoRunUrl}](${opts.adoRunUrl})  `);
        }
        lines.push('');

        lines.push('## Phases');
        lines.push('');
        lines.push('| # | Phase    | Status        | Duration | Retries |');
        lines.push('|---|----------|---------------|----------|---------|');
        snap.phases.forEach((p, i) => {
            const num = String(i + 1).padStart(1);
            const phaseName = PHASE_LABELS[p.name] ?? p.name;
            const status = CSStatusWriter.phaseStatusText(p);
            const duration = p.durationMs
                ? CSStatusWriter.formatDuration(p.durationMs)
                : '—';
            const retries = `${p.retryCount}`;
            lines.push(
                `| ${num} | ${phaseName.padEnd(8)} | ${status.padEnd(13)} | ${duration.padEnd(8)} | ${retries} |`,
            );
        });
        lines.push('');

        // v1.39.8 — Sub-agent model preferences + Copilot UI lag note.
        // Each sub-agent declares its preferred model in its .md front-matter.
        // Copilot Chat's hover tooltip is known to lag and show the parent
        // conversation's model even when the sub-agent is actually executing
        // on its declared model. This footer is the authoritative record.
        lines.push('## Sub-agent model preferences');
        lines.push('');
        lines.push('Each phase runs under its sub-agent\'s declared model. VS Code Copilot Chat\'s hover tooltip can lag — if the panel shows the same model for every phase, that\'s a known Copilot UI quirk, NOT a misconfiguration.');
        lines.push('');
        lines.push('| Phase    | Sub-agent              | Declared model chain                          |');
        lines.push('|----------|------------------------|-----------------------------------------------|');
        lines.push('| intake/discover | cs-scope-mapper        | Haiku 4.5 → Sonnet 4.6 → Sonnet 4.5     |');
        lines.push('| analyze/plan    | cs-bdd-author          | Sonnet 4.6 → Sonnet 4.5                 |');
        lines.push('| translate/audit | cs-artifact-synthesizer | Sonnet 4.6 → Sonnet 4.5                |');
        lines.push('| write/credentials | cs-vault-writer       | Haiku 4.5 → Sonnet 4.6 → Sonnet 4.5     |');
        lines.push('| preflight       | cs-preflight-auditor   | Haiku 4.5 → Sonnet 4.6 → Sonnet 4.5     |');
        lines.push('| execute/heal    | cs-resilience-engineer | Sonnet 4.6 → Sonnet 4.5                 |');
        lines.push('| verify/publish  | cs-trust-arbiter       | Haiku 4.5 → Sonnet 4.6 → Sonnet 4.5     |');
        lines.push('');

        if ((opts.filesWritten ?? []).length > 0) {
            lines.push('## Files written');
            lines.push('');
            for (const f of opts.filesWritten as string[]) {
                lines.push(`- \`${f}\``);
            }
            lines.push('');
        }

        if (snap.autoResolvedCount > 0) {
            lines.push('## Auto-resolved gates');
            lines.push('');
            lines.push(
                `${snap.autoResolvedCount} phase(s) had at least one LLM-resolved retry. See per-phase \`retries/attempt-N/\` folders for the full prompt + response trail.`,
            );
            lines.push('');
        }

        if ((opts.warnings ?? []).length > 0) {
            lines.push('## Warnings');
            lines.push('');
            for (const w of opts.warnings as string[]) {
                lines.push(`- ${w}`);
            }
            lines.push('');
        }

        lines.push('## Run folder');
        lines.push('');
        lines.push(`\`${snap.runFolder}\``);
        lines.push('');
        lines.push(
            '_The full per-phase artefacts (analysis report, plan, IR, retry attempts, run logs) are preserved in the folder above for audit + resume._',
        );

        return lines.join('\n') + '\n';
    }

    // ------------------------------------------------------------------
    // Formatters
    // ------------------------------------------------------------------

    private static phaseStatusText(p: PhaseSnapshot): string {
        switch (p.status) {
            case 'pending':
                return '⬜ pending';
            case 'running':
                return '⏳ running';
            case 'done':
                return '✅ done';
            case 'auto_resolved':
                return '✅ resolved';
            case 'blocked_user':
                return '🛑 blocked';
            default:
                return p.status;
        }
    }

    private static statusBadge(s: RunSnapshot['overallStatus']): string {
        switch (s) {
            case 'running':
                return '⏳ Running';
            case 'completed':
                return '✅ Completed';
            case 'aborted':
                return '❌ Aborted';
            case 'blocked_user':
                return '🛑 Blocked — user input required';
            default:
                return s;
        }
    }

    private static currentPhaseLine(snap: RunSnapshot): string {
        const inflight = snap.phases.find((p) => p.status === 'running');
        if (inflight) {
            return `⏳ ${PHASE_LABELS[inflight.name] ?? inflight.name} (${snap.phases.indexOf(inflight) + 1}/9)`;
        }
        const lastDone = [...snap.phases]
            .reverse()
            .find((p) => p.status === 'done' || p.status === 'auto_resolved');
        if (snap.overallStatus === 'completed') {
            return '✅ All phases complete';
        }
        if (snap.overallStatus === 'aborted') {
            return '❌ Run aborted';
        }
        if (snap.overallStatus === 'blocked_user') {
            return '🛑 Blocked on user input';
        }
        return lastDone
            ? `done up to ${PHASE_LABELS[lastDone.name] ?? lastDone.name}`
            : 'pending';
    }

    private static elapsedString(snap: RunSnapshot): string {
        const start = new Date(snap.startedAt).getTime();
        const end = snap.finishedAt
            ? new Date(snap.finishedAt).getTime()
            : Date.now();
        return CSStatusWriter.formatDuration(end - start);
    }

    private static formatDuration(ms: number): string {
        if (ms < 1000) return `${ms}ms`;
        const s = Math.floor(ms / 1000);
        if (s < 60) return `${s}s`;
        const m = Math.floor(s / 60);
        const rem = s % 60;
        if (m < 60) return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
        const h = Math.floor(m / 60);
        const remM = m % 60;
        return remM === 0 ? `${h}h` : `${h}h ${remM}m`;
    }

    private static timeOnly(iso: string): string {
        // HH:MM:SS slice
        const t = new Date(iso);
        const hh = String(t.getUTCHours()).padStart(2, '0');
        const mm = String(t.getUTCMinutes()).padStart(2, '0');
        const ss = String(t.getUTCSeconds()).padStart(2, '0');
        return `${hh}:${mm}:${ss}`;
    }

    private static escapeMd(s: string): string {
        return s.replace(/`/g, '\\`').replace(/\n/g, ' ');
    }

    private static relPath(runFolder: string, abs: string): string {
        try {
            const r = path.relative(runFolder, abs);
            return r.startsWith('..') ? abs : `./${r.replace(/\\/g, '/')}`;
        } catch {
            return abs;
        }
    }
}
