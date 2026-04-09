/**
 * CSAIStepGrammar - Grammar Rules Engine
 *
 * Core algorithm that replaces LLM-based instruction parsing:
 * 1. Extracts quoted strings and replaces with placeholders
 * 2. Normalizes synonyms (tap -> click, enter -> type, etc.)
 * 3. Matches against priority-ordered grammar rules
 * 4. Returns structured extraction or null for NLP fallback
 *
 * @module ai/step-engine
 */

import { CSReporter } from '../../reporter/CSReporter';
import {
    GrammarRule,
    GrammarExtraction,
    ParsedStep,
    ElementTarget,
    StepParameters,
    StepModifiers,
    StepCategory,
    StepIntent,
    ACTION_SYNONYMS,
    ELEMENT_TYPE_SYNONYMS,
    ORDINAL_MAP
} from './CSAIStepTypes';
import { ACTION_GRAMMAR_RULES } from './grammars/action-grammars';
import { ASSERTION_GRAMMAR_RULES } from './grammars/assertion-grammars';
import { QUERY_GRAMMAR_RULES } from './grammars/query-grammars';
import { NAVIGATION_GRAMMAR_RULES } from './grammars/navigation-grammars';
import { BROWSER_GRAMMAR_RULES } from './grammars/browser-grammars';
import { TABLE_GRAMMAR_RULES } from './grammars/table-grammars';
import { DATA_GRAMMAR_RULES } from './grammars/data-grammars';
import { DATABASE_GRAMMAR_RULES } from './grammars/database-grammars';
import { FILE_GRAMMAR_RULES } from './grammars/file-grammars';
import { COMPARISON_GRAMMAR_RULES } from './grammars/comparison-grammars';
import { CONTEXT_GRAMMAR_RULES } from './grammars/context-grammars';
import { MAPPING_GRAMMAR_RULES } from './grammars/mapping-grammars';
import { ORCHESTRATION_GRAMMAR_RULES } from './grammars/orchestration-grammars';
import { FORM_CAPTURE_GRAMMAR_RULES } from './grammars/form-capture-grammars';
import { API_GRAMMAR_RULES } from './grammars/api-grammars';

export class CSAIStepGrammar {
    private static instance: CSAIStepGrammar;

    /** All grammar rules sorted by priority (lower = higher priority) */
    private rules: GrammarRule[];

    /** Cache for parsed instructions (instruction -> ParsedStep) */
    private cache: Map<string, ParsedStep> = new Map();

    /** Cache TTL in ms (default 5 minutes) */
    private cacheTTL: number = 300000;

    /** Last cache clear timestamp */
    private lastCacheClear: number = Date.now();

    private constructor() {
        // Combine all grammar rules and sort by priority
        this.rules = [
            ...ACTION_GRAMMAR_RULES,
            ...ASSERTION_GRAMMAR_RULES,
            ...QUERY_GRAMMAR_RULES,
            ...NAVIGATION_GRAMMAR_RULES,
            ...BROWSER_GRAMMAR_RULES,
            ...TABLE_GRAMMAR_RULES,
            ...DATA_GRAMMAR_RULES,
            ...DATABASE_GRAMMAR_RULES,
            ...FILE_GRAMMAR_RULES,
            ...COMPARISON_GRAMMAR_RULES,
            ...CONTEXT_GRAMMAR_RULES,
            ...MAPPING_GRAMMAR_RULES,
            ...ORCHESTRATION_GRAMMAR_RULES,
            ...FORM_CAPTURE_GRAMMAR_RULES,
            ...API_GRAMMAR_RULES
        ].sort((a, b) => a.priority !== b.priority ? a.priority - b.priority : a.id.localeCompare(b.id));

        CSReporter.debug(`CSAIStepGrammar: Loaded ${this.rules.length} grammar rules`);
    }

    /** Get singleton instance */
    public static getInstance(): CSAIStepGrammar {
        if (!CSAIStepGrammar.instance) {
            CSAIStepGrammar.instance = new CSAIStepGrammar();
        }
        return CSAIStepGrammar.instance;
    }

    /**
     * Parse an instruction using grammar rules
     * @param instruction - Natural language instruction (e.g., "Click the Login button")
     * @returns ParsedStep if a grammar rule matched, null if no match (needs NLP fallback)
     */
    public parse(instruction: string): ParsedStep | null {
        const startTime = Date.now();

        // Check cache
        this.evictStaleCache();
        const cached = this.cache.get(instruction);
        if (cached) {
            CSReporter.debug(`CSAIStepGrammar: Cache hit for "${instruction.substring(0, 50)}..."`);
            return cached;
        }

        // Step 1: Extract quoted strings
        const { text: cleanedText, quotedStrings } = this.extractQuotedStrings(instruction);

        // Two-pass matching strategy:
        // Pass 1: Try grammar rules on ORIGINAL text (without synonym normalization)
        //   This ensures "Press Enter" matches press-key, not click (since 'press' -> 'click' synonym)
        // Pass 2: Normalize synonyms and try again for instructions that use non-canonical verbs
        //   This ensures "Tap the Submit button" normalizes to "click" and matches

        // Pass 1: Match against original text
        const pass1Result = this.tryMatchRules(cleanedText, quotedStrings, instruction);
        if (pass1Result) {
            const duration = Date.now() - startTime;
            CSReporter.debug(`CSAIStepGrammar: Matched rule "${pass1Result.matchedRuleId}" in ${duration}ms (pass 1, confidence: ${pass1Result.confidence.toFixed(2)})`);
            this.cache.set(instruction, pass1Result);
            return pass1Result;
        }

        // Pass 2: Normalize synonyms and try again
        const normalizedText = this.normalizeSynonyms(cleanedText);
        if (normalizedText !== cleanedText) {
            const pass2Result = this.tryMatchRules(normalizedText, quotedStrings, instruction);
            if (pass2Result) {
                const duration = Date.now() - startTime;
                CSReporter.debug(`CSAIStepGrammar: Matched rule "${pass2Result.matchedRuleId}" in ${duration}ms (pass 2 with synonyms, confidence: ${pass2Result.confidence.toFixed(2)})`);
                this.cache.set(instruction, pass2Result);
                return pass2Result;
            }
        }

        const duration = Date.now() - startTime;
        CSReporter.debug(`CSAIStepGrammar: No grammar rule matched in ${duration}ms for: "${instruction.substring(0, 80)}"`);
        return null;
    }

    /**
     * Try matching text against all grammar rules (priority-ordered)
     * @returns ParsedStep if a rule matched, null otherwise
     */
    private tryMatchRules(text: string, quotedStrings: string[], rawInstruction: string): ParsedStep | null {
        for (const rule of this.rules) {
            const match = text.match(rule.pattern);
            if (match) {
                try {
                    const extraction = rule.extract(match, quotedStrings);
                    return this.buildParsedStep(rawInstruction, rule, extraction, quotedStrings);
                } catch (error: any) {
                    CSReporter.debug(`CSAIStepGrammar: Rule "${rule.id}" extraction failed: ${error.message}`);
                    continue;
                }
            }
        }
        return null;
    }

    /**
     * Extract quoted strings and replace with placeholders
     * Handles both single quotes and double quotes.
     *
     * Input:  "Type 'hello world' in the 'Email' field"
     * Output: { text: "Type __QUOTED_0__ in the __QUOTED_1__ field", quotedStrings: ["hello world", "Email"] }
     */
    public extractQuotedStrings(instruction: string): { text: string; quotedStrings: string[] } {
        const quotedStrings: string[] = [];
        let text = instruction;

        // Match both single and double quoted strings
        // Process double quotes first, then single quotes
        text = text.replace(/"([^"]*?)"/g, (_, content) => {
            const index = quotedStrings.length;
            quotedStrings.push(content);
            return `__QUOTED_${index}__`;
        });

        text = text.replace(/'([^']*?)'/g, (_, content) => {
            const index = quotedStrings.length;
            quotedStrings.push(content);
            return `__QUOTED_${index}__`;
        });

        return { text, quotedStrings };
    }

    /**
     * Normalize synonyms in the instruction text
     * Replaces common synonyms with canonical keywords before regex matching
     */
    public normalizeSynonyms(text: string): string {
        let normalized = text;

        // Sort synonym keys by length (longest first) to avoid partial matches
        const sortedSynonyms = Object.keys(ACTION_SYNONYMS)
            .sort((a, b) => b.length - a.length);

        for (const synonym of sortedSynonyms) {
            const canonical = ACTION_SYNONYMS[synonym];
            // Only replace at word boundaries, case-insensitive
            const regex = new RegExp(`\\b${this.escapeRegex(synonym)}\\b`, 'gi');
            normalized = normalized.replace(regex, canonical);
        }

        return normalized;
    }

    /**
     * Build a ParsedStep from grammar rule match and extraction
     */
    private buildParsedStep(
        rawText: string,
        rule: GrammarRule,
        extraction: GrammarExtraction,
        quotedStrings: string[]
    ): ParsedStep {
        // Parse the target element
        const target = this.parseElementTarget(extraction.targetText, extraction.elementType, quotedStrings);

        // Build parameters
        const parameters: StepParameters = {
            value: extraction.value,
            expectedValue: extraction.expectedValue,
            ...(extraction.params || {})
        };

        // Build modifiers
        const modifiers: StepModifiers = {
            ...(extraction.modifiers || {})
        };

        // Calculate confidence
        const confidence = this.calculateConfidence(rule, extraction, target);

        return {
            category: rule.category,
            intent: rule.intent,
            target,
            parameters,
            rawText,
            confidence,
            modifiers,
            matchedRuleId: rule.id
        };
    }

    /**
     * Parse element target description into structured ElementTarget
     */
    private parseElementTarget(
        targetText: string,
        elementType: string | undefined,
        quotedStrings: string[]
    ): ElementTarget {
        let text = targetText;

        // Resolve any remaining quoted placeholders in target
        text = text.replace(/__QUOTED_(\d+)__/g, (_, idx) => quotedStrings[parseInt(idx)] || '');

        // Extract ordinal (first, second, 1st, 2nd, etc.)
        let ordinal: number | undefined;
        for (const [word, num] of Object.entries(ORDINAL_MAP)) {
            const regex = new RegExp(`\\b${this.escapeRegex(word)}\\b`, 'i');
            if (regex.test(text)) {
                ordinal = num;
                text = text.replace(regex, '').trim();
                break;
            }
        }

        // Extract position cues
        let position: string | undefined;
        const positionMatch = text.match(/\b(top|bottom|left|right|upper|lower)\b/i);
        if (positionMatch) {
            position = positionMatch[1].toLowerCase();
        }

        // Extract relative references (near, next to, inside, etc.)
        let relativeTo: string | undefined;
        let relation: string | undefined;
        const relativePatterns = [
            /\s+(?:near|next\s+to|beside)\s+(?:the\s+)?(.+?)$/i,
            /\s+(?:inside|within|in)\s+(?:the\s+)?(.+?)$/i,
            /\s+(?:after|below|under)\s+(?:the\s+)?(.+?)$/i,
            /\s+(?:before|above|over)\s+(?:the\s+)?(.+?)$/i
        ];

        for (const relPattern of relativePatterns) {
            const relMatch = text.match(relPattern);
            if (relMatch) {
                relativeTo = relMatch[1].trim();
                relation = relPattern.source.includes('near|next') ? 'near' :
                           relPattern.source.includes('inside|within') ? 'inside' :
                           relPattern.source.includes('after|below') ? 'after' : 'before';
                text = text.replace(relPattern, '').trim();
                break;
            }
        }

        // Normalize element type from synonyms
        if (elementType) {
            elementType = ELEMENT_TYPE_SYNONYMS[elementType.toLowerCase()] || elementType;
        }

        // Build descriptors from the remaining text.
        // Do NOT filter any words here — the grammar's stripElementType() already
        // removes element-type words (button, field, etc.) from targetText before
        // it reaches this method. Filtering again here breaks element names like
        // "Log On" (strips "On"), "Sign In" (strips "In"), "Add To Cart" (strips "To").
        const descriptors = text.split(/\s+/).filter(w => w.length > 0);

        return {
            elementType,
            descriptors,
            ordinal,
            position,
            relativeTo,
            relation,
            rawText: text  // Use resolved text (not raw with __QUOTED_N__ placeholders)
        };
    }

    /**
     * Calculate parsing confidence based on rule match quality
     */
    private calculateConfidence(
        rule: GrammarRule,
        extraction: GrammarExtraction,
        target: ElementTarget
    ): number {
        let confidence = 0.8; // Base confidence for grammar match

        // Boost for having an element type
        if (target.elementType) {
            confidence += 0.05;
        }

        // Boost for having descriptors
        if (target.descriptors.length > 0) {
            confidence += 0.05;
        }

        // Boost for having a value (type, select actions)
        if (extraction.value) {
            confidence += 0.05;
        }

        // Slight reduction for lower-priority rules (they are more general/ambiguous)
        if (rule.priority > 100) {
            confidence -= 0.02;
        }

        // Boost for ordinal (more specific targeting)
        if (target.ordinal) {
            confidence += 0.03;
        }

        return Math.min(confidence, 1.0);
    }

    /** Escape special regex characters */
    private escapeRegex(str: string): string {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /** Evict expired cache entries */
    private evictStaleCache(): void {
        const now = Date.now();
        if (now - this.lastCacheClear > this.cacheTTL) {
            this.cache.clear();
            this.lastCacheClear = now;
        }
    }

    /** Get total number of loaded grammar rules */
    public getRuleCount(): number {
        return this.rules.length;
    }

    /** Get cache statistics */
    public getCacheStats(): { size: number; ttl: number } {
        return { size: this.cache.size, ttl: this.cacheTTL };
    }

    /** Clear the parse cache */
    public clearCache(): void {
        this.cache.clear();
        this.lastCacheClear = Date.now();
    }

    /** Register a custom grammar rule (for extensibility) */
    public registerRule(rule: GrammarRule): void {
        this.rules.push(rule);
        this.rules.sort((a, b) => a.priority !== b.priority ? a.priority - b.priority : a.id.localeCompare(b.id));
        this.cache.clear();
        CSReporter.debug(`CSAIStepGrammar: Registered custom rule "${rule.id}" (total: ${this.rules.length})`);
    }

    /** Get all loaded rule IDs (for debugging) */
    public getRuleIds(): string[] {
        return this.rules.map(r => r.id);
    }
}
