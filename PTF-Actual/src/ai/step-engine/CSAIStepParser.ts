/**
 * CSAIStepParser - Instruction Parser Orchestrator
 *
 * Converts natural language instructions into structured ParsedStep objects.
 * Two-tier parsing strategy:
 *   1. Grammar rules (fast, deterministic, ~95% of instructions)
 *   2. CSNaturalLanguageEngine fallback (handles unusual phrasing)
 *
 * @module ai/step-engine
 */

import { CSReporter } from '../../reporter/CSReporter';
import { CSNaturalLanguageEngine } from '../nlp/CSNaturalLanguageEngine';
import { NLPResult, IntentType } from '../types/AITypes';
import { CSAIStepGrammar } from './CSAIStepGrammar';
import {
    ParsedStep,
    ElementTarget,
    StepParameters,
    StepModifiers,
    StepCategory,
    StepIntent,
    ActionIntent,
    AssertionIntent,
    QueryIntent,
    ELEMENT_TYPE_SYNONYMS,
    ORDINAL_MAP
} from './CSAIStepTypes';

export class CSAIStepParser {
    private static instance: CSAIStepParser;
    private grammar: CSAIStepGrammar;

    private constructor() {
        this.grammar = CSAIStepGrammar.getInstance();
    }

    /** Get singleton instance */
    public static getInstance(): CSAIStepParser {
        if (!CSAIStepParser.instance) {
            CSAIStepParser.instance = new CSAIStepParser();
        }
        return CSAIStepParser.instance;
    }

    /**
     * Parse an instruction into a structured ParsedStep
     * @param instruction - Natural language instruction
     * @returns ParsedStep with category, intent, target, parameters
     */
    public async parse(instruction: string): Promise<ParsedStep> {
        const startTime = Date.now();
        const trimmed = instruction.trim();

        if (!trimmed) {
            throw new Error('CSAIStepParser: Empty instruction');
        }

        // Tier 1: Try grammar rules (fast, deterministic)
        const grammarResult = this.grammar.parse(trimmed);
        if (grammarResult) {
            const duration = Date.now() - startTime;
            CSReporter.debug(`CSAIStepParser: Grammar parse succeeded in ${duration}ms - ${grammarResult.intent} (rule: ${grammarResult.matchedRuleId})`);
            return grammarResult;
        }

        // Tier 2: Fall back to NLP engine
        CSReporter.debug(`CSAIStepParser: No grammar match, falling back to NLP for: "${trimmed.substring(0, 80)}"`);
        const nlpResult = await this.parseWithNLP(trimmed);

        const duration = Date.now() - startTime;
        CSReporter.debug(`CSAIStepParser: NLP fallback completed in ${duration}ms - ${nlpResult.intent} (confidence: ${nlpResult.confidence.toFixed(2)})`);

        return nlpResult;
    }

    /**
     * Parse using the existing CSNaturalLanguageEngine as fallback
     */
    private async parseWithNLP(instruction: string): Promise<ParsedStep> {
        const nlpEngine = CSNaturalLanguageEngine.getInstance();
        const nlpResult: NLPResult = await nlpEngine.processDescription(instruction);

        // Map NLP IntentType to our StepIntent
        const { category, intent } = this.mapNLPIntent(nlpResult.intent, instruction);

        // Extract quoted text from instruction for value parameter
        const { quotedStrings } = this.grammar.extractQuotedStrings(instruction);

        // Build target from NLP keywords
        const target = this.buildTargetFromNLP(nlpResult, instruction);

        // Build parameters
        const parameters: StepParameters = {};
        if (quotedStrings.length > 0) {
            // First quoted string is usually the value
            if (category === 'action' && (intent === 'fill' || intent === 'type' || intent === 'select')) {
                parameters.value = quotedStrings[0];
            } else if (category === 'assertion') {
                parameters.expectedValue = quotedStrings[0];
            }
        }

        // Detect negation
        const modifiers: StepModifiers = {};
        const negationPattern = /\b(?:not|no|isn't|doesn't|shouldn't|without|never)\b/i;
        if (negationPattern.test(instruction)) {
            modifiers.negated = true;
        }

        // Adjust confidence (NLP fallback is less confident than grammar match)
        const confidence = Math.min(nlpResult.confidence * 0.85, 0.8);

        return {
            category,
            intent,
            target,
            parameters,
            rawText: instruction,
            confidence,
            modifiers,
            matchedRuleId: null
        };
    }

    /**
     * Map NLP IntentType to our StepCategory + StepIntent
     */
    private mapNLPIntent(nlpIntent: IntentType, instruction: string): { category: StepCategory; intent: StepIntent } {
        const lower = instruction.toLowerCase();

        // Check for assertion keywords first
        if (/^(?:verify|assert|check|confirm|ensure|should|must|expect)\b/i.test(lower)) {
            return this.inferAssertionIntent(lower);
        }

        // Check for query keywords
        if (/^(?:get|read|extract|fetch|retrieve|capture|grab|how\s+many|count|list)\b/i.test(lower)) {
            return this.inferQueryIntent(lower);
        }

        // Check for wait patterns (more specific than generic 'wait')
        if (/^(?:wait|pause)\s+(?:for\s+)?\d+\s*(?:seconds?|secs?|ms|milliseconds?)/i.test(lower)) {
            return { category: 'action', intent: 'wait-seconds' };
        }
        if (/^wait\s+(?:for\s+)?(?:the\s+)?url/i.test(lower)) {
            return { category: 'action', intent: 'wait-url-change' };
        }

        // Check for tab/browser management patterns
        if (/^switch\s+(?:to\s+)?(?:tab|the\s+(?:latest|main|first)\s+tab)/i.test(lower)) {
            return { category: 'action', intent: 'switch-tab' };
        }
        if (/^open\s+(?:a\s+)?new\s+tab/i.test(lower)) {
            return { category: 'action', intent: 'open-new-tab' };
        }
        if (/^close\s+(?:the\s+)?(?:current\s+)?tab/i.test(lower)) {
            return { category: 'action', intent: 'close-tab' };
        }
        if (/^clear\s+(?:browser\s+)?(?:session|context)/i.test(lower)) {
            return { category: 'action', intent: 'clear-session' };
        }
        if (/^take\s+(?:a\s+)?screenshot/i.test(lower)) {
            return { category: 'action', intent: 'take-screenshot' };
        }

        // Map NLP intent to action
        const intentMap: Record<IntentType, StepIntent> = {
            'click': 'click',
            'type': 'fill',
            'select': 'select',
            'check': 'check',
            'uncheck': 'uncheck',
            'hover': 'hover',
            'navigate': 'navigate',
            'validate': 'verify-visible',
            'extract': 'get-text',
            'wait': 'wait-for'
        };

        const mappedIntent = intentMap[nlpIntent] || 'click';
        const category: StepCategory = nlpIntent === 'validate' ? 'assertion' :
                                        nlpIntent === 'extract' ? 'query' : 'action';

        return { category, intent: mappedIntent };
    }

    /**
     * Infer specific assertion intent from instruction text
     */
    private inferAssertionIntent(lower: string): { category: StepCategory; intent: AssertionIntent } {
        if (/(?:visible|displayed|shown|present|appearing)/.test(lower)) {
            return { category: 'assertion', intent: 'verify-visible' };
        }
        if (/(?:hidden|invisible|not\s+displayed|not\s+visible|not\s+shown|disappeared)/.test(lower)) {
            return { category: 'assertion', intent: 'verify-hidden' };
        }
        if (/(?:enabled)/.test(lower)) {
            return { category: 'assertion', intent: 'verify-enabled' };
        }
        if (/(?:disabled|not\s+enabled|greyed?\s+out)/.test(lower)) {
            return { category: 'assertion', intent: 'verify-disabled' };
        }
        if (/\bchecked\b/.test(lower) && !/\bunchecked\b/.test(lower)) {
            return { category: 'assertion', intent: 'verify-checked' };
        }
        if (/\bunchecked\b/.test(lower) || /\bnot\s+checked\b/.test(lower)) {
            return { category: 'assertion', intent: 'verify-unchecked' };
        }
        if (/(?:contains?|includes?)/.test(lower)) {
            return { category: 'assertion', intent: 'verify-contains' };
        }
        if (/(?:count|number\s+of)/.test(lower)) {
            return { category: 'assertion', intent: 'verify-count' };
        }
        if (/\burl\b/i.test(lower)) {
            return { category: 'assertion', intent: 'verify-url' };
        }
        if (/\btitle\b/i.test(lower)) {
            return { category: 'assertion', intent: 'verify-title' };
        }
        if (/(?:text|equals?|shows?|reads?|says?)/.test(lower)) {
            return { category: 'assertion', intent: 'verify-text' };
        }
        // Default assertion
        return { category: 'assertion', intent: 'verify-visible' };
    }

    /**
     * Infer specific query intent from instruction text
     */
    private inferQueryIntent(lower: string): { category: StepCategory; intent: QueryIntent } {
        if (/(?:count|number\s+of|how\s+many|total)/.test(lower)) {
            return { category: 'query', intent: 'get-count' };
        }
        if (/(?:all|list|every|options?|items?)/.test(lower)) {
            return { category: 'query', intent: 'get-list' };
        }
        if (/\bvalue\b/.test(lower)) {
            return { category: 'query', intent: 'get-value' };
        }
        if (/\battribute\b/.test(lower)) {
            return { category: 'query', intent: 'get-attribute' };
        }
        if (/\burl\b/i.test(lower)) {
            return { category: 'query', intent: 'get-url' };
        }
        if (/\btitle\b/i.test(lower)) {
            return { category: 'query', intent: 'get-title' };
        }
        if (/(?:exist|there)/.test(lower)) {
            return { category: 'query', intent: 'check-exists' };
        }
        // Default query
        return { category: 'query', intent: 'get-text' };
    }

    /**
     * Build ElementTarget from NLP result
     */
    private buildTargetFromNLP(nlpResult: NLPResult, instruction: string): ElementTarget {
        // Extract element type
        let elementType = nlpResult.elementType;
        if (elementType) {
            elementType = ELEMENT_TYPE_SYNONYMS[elementType.toLowerCase()] || elementType;
        }

        // Use NLP keywords as descriptors
        const descriptors = nlpResult.keywords.filter(k =>
            k.toLowerCase() !== elementType?.toLowerCase() &&
            k.length > 2
        );

        // Extract ordinal from keywords
        let ordinal: number | undefined;
        for (const keyword of nlpResult.keywords) {
            const ordinalValue = ORDINAL_MAP[keyword.toLowerCase()];
            if (ordinalValue !== undefined) {
                ordinal = ordinalValue;
                // Remove ordinal from descriptors
                const idx = descriptors.indexOf(keyword);
                if (idx >= 0) descriptors.splice(idx, 1);
                break;
            }
        }

        // Extract position from NLP position cues
        const position = nlpResult.positionCues?.position;
        const relativeTo = nlpResult.positionCues?.relativeTo;
        const relation = nlpResult.positionCues?.relation;

        // Extract text content from NLP
        if (nlpResult.textContent && !descriptors.includes(nlpResult.textContent)) {
            descriptors.unshift(nlpResult.textContent);
        }

        return {
            elementType,
            descriptors,
            ordinal,
            position,
            relativeTo,
            relation,
            rawText: instruction
        };
    }

    /** Get grammar engine reference (for advanced usage) */
    public getGrammar(): CSAIStepGrammar {
        return this.grammar;
    }

    /** Clear all caches */
    public clearCache(): void {
        this.grammar.clearCache();
    }
}
