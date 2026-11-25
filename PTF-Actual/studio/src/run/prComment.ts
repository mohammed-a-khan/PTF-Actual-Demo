/**
 * A test run of a pull request, written as a pull request comment (Markdown, as Azure DevOps
 * renders it). The user sees it, can change it, and posts it themselves.
 */
import type { RunInfo } from './runner';
import { selectionCheck } from './prImpact';

const dur = (ms: number) => ms < 1000 ? `${Math.round(ms)} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`;
/** Table cells: no pipes or line breaks (they would break the table). */
const cell = (t: string) => t.replace(/\|/g, '\\|').replace(/\s*\r?\n\s*/g, ' ').trim();

export function resultsComment(r: RunInfo, mask: (t: string) => string = (t) => t): string {
    const s = r.summary;
    const lines: string[] = [];
    const icon = !s ? '⚠️' : s.failed ? '❌' : '✅';
    lines.push(`### ${icon} Test results (CS Test Studio)`);
    if (r.pr) lines.push(`Tested the ${r.pr.based === 'merge' ? '**merge result** (what will land)' : '**source branch** (the merge result was not available)'} at \`${r.pr.commit.slice(0, 8)}\`.`);
    const opts = [`project \`${r.request.project}\``, `environment \`${r.request.env}\``, r.request.browser ? `browser ${r.request.browser}` : '', r.request.workers && r.request.workers > 1 ? `${r.request.workers} workers` : ''].filter(Boolean);
    lines.push(`Run on ${new Date(r.startedAt).toUTCString()}: ${opts.join(', ')}.`);
    lines.push('');
    if (!s) {
        lines.push(`The run ended without results (${r.state}${r.message ? `: ${mask(r.message)}` : ''}).`);
        return lines.join('\n');
    }
    const time = r.endedAt ? dur(Date.parse(r.endedAt) - Date.parse(r.startedAt)) : '';
    lines.push(`**${s.total} scenario${s.total === 1 ? '' : 's'}: ${s.passed} passed, ${s.failed} failed${s.skipped ? `, ${s.skipped} skipped` : ''}**${time ? ` (${time})` : ''}`);
    lines.push('');
    lines.push('| | Scenario | Feature | Time |');
    lines.push('|---|---|---|---|');
    const order = (st: string) => (st === 'failed' || st === 'broken' ? 0 : st === 'passed' ? 2 : 1);
    for (const sc of [...s.scenarios].sort((a, b) => order(a.status) - order(b.status)).slice(0, 200)) {
        const mark = sc.status === 'passed' ? '✅' : sc.status === 'failed' || sc.status === 'broken' ? '❌' : '⏭️';
        lines.push(`| ${mark} | ${cell(mask(sc.name))} | ${cell(mask(sc.feature))} | ${dur(sc.duration)} |`);
    }
    if (s.scenarios.length > 200) lines.push(`| | … and ${s.scenarios.length - 200} more | | |`);
    const sel = r.pr?.selection;
    if (sel) {
        lines.push('');
        const n = sel.features.length;
        if (!sel.observe) lines.push(`Ran the tests chosen for this change: ${n} feature${n === 1 ? '' : 's'}.`);
        else {
            const c = selectionCheck(r);
            if (c) lines.push(c.missed.length
                ? `**Selection check:** every test ran; the ${n} chosen feature${n === 1 ? '' : 's'} would have missed ${c.missed.length} failure${c.missed.length === 1 ? '' : 's'}: ${c.missed.slice(0, 5).map((m) => cell(mask(m.scenario))).join(', ')}.`
                : `**Selection check:** every test ran; the ${n} chosen feature${n === 1 ? '' : 's'} (${c.selected} scenario${c.selected === 1 ? '' : 's'}) would have caught ${c.failed ? `all ${c.failed} failure${c.failed === 1 ? '' : 's'}` : 'every failure (none)'}.`);
        }
    }
    const failed = s.scenarios.filter((x) => (x.status === 'failed' || x.status === 'broken') && x.error);
    if (failed.length) {
        lines.push('');
        lines.push('**Failures**');
        for (const f of failed.slice(0, 20)) lines.push(`- **${cell(mask(f.name))}**: ${cell(mask(f.error!).split('\n')[0]).slice(0, 300)}`);
    }
    return lines.join('\n');
}
