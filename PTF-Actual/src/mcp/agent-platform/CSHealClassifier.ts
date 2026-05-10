/**
 * Agentic Test Platform — Heal Failure Classifier (Rebuild M10)
 *
 * Pure-function classifier that assigns a `(category, severity)` tag to
 * one test failure given:
 *   - the run's stdout/stderr text,
 *   - optional Playwright trace metadata (selectors, last successful action),
 *   - optional screenshot file path (path only — analysis happens
 *     downstream by the agent's vision-capable LLM).
 *
 * Pattern stolen from the colleague's pack and extended:
 *   - 4-category baseline: LOCATOR / TIMEOUT / SYNTAX / LOGIC
 *   - 7-row reclassification truth table (text × visual evidence)
 *   - 4-level source-mapping fallback (analysis-report → generated TS →
 *     legacy-source → unavailable)
 *   - Severity demotion when the app-knowledge cache (M3 retry
 *     correction-memory) holds a verified-fresh selector
 *
 * Wires into the gate engine: when execute phase fails, the orchestrator
 * calls `classify()`, then asks an LLM resolver to propose a fix bounded
 * by the category. After patch, gate engine re-runs the scenario.
 *
 * @module agent-platform/CSHealClassifier
 */

// ============================================================================
// Public Types
// ============================================================================

export type HealCategory = 'locator' | 'timeout' | 'syntax' | 'logic' | 'flaky' | 'unknown';
export type HealSeverity = 'low' | 'medium' | 'high';

export interface HealFailureSignals {
    /** Stdout + stderr from the runner. */
    stdout?: string;
    stderr?: string;
    /** Last failing test/scenario name when known. */
    failingScenario?: string;
    /** Selector that the runner reported as not found / not visible. */
    selectorReported?: string;
    /** Path to the screenshot Playwright captured at the failure point. */
    screenshotPath?: string;
    /**
     * Optional flags the agent adds AFTER inspecting the screenshot via a
     * vision LLM. The classifier reads these to apply the truth table.
     */
    visualEvidence?: VisualEvidenceFlags;
    /** Pulled from the analysis report's call-tree for the failing scenario. */
    analysisReportNode?: { stepLabel: string; pageClass?: string };
    /** Fresh hit from app-knowledge / correction memory? */
    knowledgeHit?: { selector: string; ttlValid: boolean };
}

export interface VisualEvidenceFlags {
    /** Modal / overlay / dropdown / spinner is covering the target. */
    blockingOverlay?: boolean;
    /** Page is on a clearly different URL/heading than expected. */
    wrongPage?: boolean;
    /** Form validation error visible. */
    validationErrorShown?: boolean;
    /** Login screen is showing despite being mid-test (session lost). */
    sessionLost?: boolean;
    /** Empty grid / "No results" visible. */
    emptyState?: boolean;
}

export interface HealClassification {
    category: HealCategory;
    severity: HealSeverity;
    /** Human-readable summary the orchestrator surfaces to the user. */
    summary: string;
    /** Recommended action for the LLM resolver to take. */
    suggestedAction: string;
    /** Tier of source-map data the classifier had access to. */
    sourceMapTier: 'analysis_report' | 'generated_ts' | 'legacy_source' | 'unavailable';
    /** True when knowledge cache demoted severity (high → medium). */
    demotedByKnowledge: boolean;
}

// ============================================================================
// CSHealClassifier
// ============================================================================

export class CSHealClassifier {
    /**
     * Classify one failure end-to-end.
     */
    public static classify(signals: HealFailureSignals): HealClassification {
        const baseline = CSHealClassifier.classifyByText(signals);
        const refined = CSHealClassifier.applyVisualReclassification(baseline, signals);
        const finalised = CSHealClassifier.applyKnowledgeDemote(refined, signals);
        return finalised;
    }

    // ------------------------------------------------------------------
    // Step 1 — text-only baseline classification
    // ------------------------------------------------------------------

    private static classifyByText(signals: HealFailureSignals): HealClassification {
        const text = `${signals.stdout ?? ''}\n${signals.stderr ?? ''}`;

        // SYNTAX / build-time failures take precedence.
        if (/SyntaxError|TS\d{4}|Cannot find module|Cannot find name|TypeError: .* is not a function/.test(text)) {
            return {
                category: 'syntax',
                severity: 'high',
                summary: 'Build-time / type error in generated test files.',
                suggestedAction: 'Inspect compile_check / tsc output; fix import / type mismatch in the most-recently generated file.',
                sourceMapTier: signals.analysisReportNode ? 'analysis_report' : 'generated_ts',
                demotedByKnowledge: false,
            };
        }

        // TIMEOUT — Playwright `Timeout 5000ms exceeded`, `waiting for selector`, etc.
        if (/Timeout\s*\d+ms exceeded|waiting for selector|TimeoutError|Test timeout/i.test(text)) {
            return {
                category: 'timeout',
                severity: 'medium',
                summary: 'Action timed out waiting for an element / page state.',
                suggestedAction: 'Inspect screenshot for blocking overlay; if absent, the locator is wrong (LOCATOR) or the app is on the wrong page (LOGIC).',
                sourceMapTier: signals.analysisReportNode ? 'analysis_report' : 'generated_ts',
                demotedByKnowledge: false,
            };
        }

        // LOCATOR — explicit "no node found" / "strict mode violation" patterns.
        if (/locator\.|no node was found|strict mode violation|Element not found|NoSuchElementException/i.test(text)) {
            return {
                category: 'locator',
                severity: 'medium',
                summary: `Selector \`${signals.selectorReported ?? '?'}\` did not resolve.`,
                suggestedAction: 'Re-derive the selector from app-knowledge cache or live-DOM capture; patch the page object.',
                sourceMapTier: signals.analysisReportNode ? 'analysis_report' : 'generated_ts',
                demotedByKnowledge: false,
            };
        }

        // LOGIC — assertion text mismatches / wrong-value failures.
        if (/expect\([^)]+\)\.toBe|AssertionError|Expected.*Received|to equal|is not equal/i.test(text)) {
            return {
                category: 'logic',
                severity: 'high',
                summary: 'Assertion failure — expected vs received mismatch.',
                suggestedAction: 'Compare assertion text against the analysis-report Section 9 trace; if the legacy test asserts the same value, the app behaviour drifted (LOGIC/HIGH).',
                sourceMapTier: signals.analysisReportNode ? 'analysis_report' : 'generated_ts',
                demotedByKnowledge: false,
            };
        }

        // Flaky if test passed last cycle and failed this cycle (caller must
        // pass that signal — we expose the category for downstream use).
        return {
            category: 'unknown',
            severity: 'medium',
            summary: 'Failure cause not classified by text alone.',
            suggestedAction: 'Capture screenshot + DOM snapshot; ask vision LLM for visual evidence flags then re-classify.',
            sourceMapTier: signals.analysisReportNode ? 'analysis_report' : 'unavailable',
            demotedByKnowledge: false,
        };
    }

    // ------------------------------------------------------------------
    // Step 2 — visual-evidence reclassification truth table
    // ------------------------------------------------------------------

    private static applyVisualReclassification(
        baseline: HealClassification,
        signals: HealFailureSignals,
    ): HealClassification {
        const v = signals.visualEvidence;
        if (!v) return baseline;

        // Row 1: Blocking overlay overrides locator/timeout → LOGIC/HIGH.
        // The element exists but is visually covered. Patching the locator
        // won't help; the test logic must close the overlay first.
        if (v.blockingOverlay && (baseline.category === 'locator' || baseline.category === 'timeout')) {
            return {
                ...baseline,
                category: 'logic',
                severity: 'high',
                summary: 'A modal / overlay / spinner is covering the target element. Locator is correct; logic gap.',
                suggestedAction: 'Close the overlay first (dismiss button, ESC key, wait-until-hidden). Do not patch the locator.',
            };
        }

        // Row 2: Wrong page → LOGIC/HIGH (navigation error upstream).
        if (v.wrongPage) {
            return {
                ...baseline,
                category: 'logic',
                severity: 'high',
                summary: 'App is on a different page than expected. Navigation step upstream did not land on the target.',
                suggestedAction: 'Re-trace the call-tree to find the navigation step that landed elsewhere. May be a missing pre-flight step.',
            };
        }

        // Row 3: Session lost → LOGIC/HIGH (cookie/SSO).
        if (v.sessionLost) {
            return {
                ...baseline,
                category: 'logic',
                severity: 'high',
                summary: 'Login screen visible mid-test — session was lost (likely SSO cookie expiry / clear).',
                suggestedAction: 'Add explicit re-login on session-lost detection, or persist auth via storageState.',
            };
        }

        // Row 4: Validation error visible + LOGIC failure → LOGIC/MEDIUM (test data wrong).
        if (v.validationErrorShown && baseline.category === 'logic') {
            return {
                ...baseline,
                category: 'logic',
                severity: 'medium',
                summary: 'Validation error visible. Test data likely violates the form rules.',
                suggestedAction: 'Compare submitted values against legacy test data; the migrated JSON row may have a wrong value or missing field.',
            };
        }

        // Row 5: Empty state + assertion fail → LOGIC/MEDIUM.
        if (v.emptyState && baseline.category === 'logic') {
            return {
                ...baseline,
                severity: 'medium',
                summary: 'Empty grid / "No results" — DB row probably missing.',
                suggestedAction: 'Pre-seed the row via mutation-cleanup helper or re-check the data scenario id mapping.',
            };
        }

        // Row 6: No visual evidence + locator → keep LOCATOR/MEDIUM (knowledge cache may demote in step 3).
        // Row 7: No visual evidence + unknown → bump severity HIGH so the user reviews.
        if (baseline.category === 'unknown' && Object.keys(v).length === 0) {
            return { ...baseline, severity: 'high' };
        }
        return baseline;
    }

    // ------------------------------------------------------------------
    // Step 3 — knowledge cache demote
    // ------------------------------------------------------------------

    private static applyKnowledgeDemote(
        cls: HealClassification,
        signals: HealFailureSignals,
    ): HealClassification {
        if (!signals.knowledgeHit) return cls;
        if (!signals.knowledgeHit.ttlValid) {
            // Stale knowledge — mark high so user knows refresh is needed.
            return {
                ...cls,
                severity: 'high',
                suggestedAction: `App-knowledge for selector \`${signals.knowledgeHit.selector}\` has expired. Refresh by running App-Explorer agent against the page.`,
            };
        }
        if (cls.category === 'locator' && cls.severity === 'high') {
            return {
                ...cls,
                severity: 'medium',
                demotedByKnowledge: true,
                summary: `${cls.summary} App-knowledge has a fresh verified selector — patch is likely safe.`,
                suggestedAction: `Replace the broken locator with the cached one: \`${signals.knowledgeHit.selector}\``,
            };
        }
        return cls;
    }

    // ------------------------------------------------------------------
    // Step 4 — render Markdown for STATUS + retry artifacts
    // ------------------------------------------------------------------

    public static renderMarkdown(cls: HealClassification, signals: HealFailureSignals): string {
        const lines: string[] = [];
        lines.push('## Heal classification');
        lines.push('');
        lines.push(`- **Category:** ${cls.category}`);
        lines.push(`- **Severity:** ${cls.severity}`);
        lines.push(`- **Source-map tier:** ${cls.sourceMapTier}`);
        if (cls.demotedByKnowledge) lines.push(`- **Demoted by app-knowledge cache.**`);
        lines.push(`- **Summary:** ${cls.summary}`);
        lines.push(`- **Suggested action:** ${cls.suggestedAction}`);
        if (signals.failingScenario) lines.push(`- **Scenario:** \`${signals.failingScenario}\``);
        if (signals.selectorReported) lines.push(`- **Selector:** \`${signals.selectorReported}\``);
        if (signals.screenshotPath) lines.push(`- **Screenshot:** \`${signals.screenshotPath}\``);
        return lines.join('\n') + '\n';
    }
}
