/**
 * CSInstructionDecomposer - Rule-Based Compound Instruction Splitting
 *
 * Handles compound/multi-part instructions by decomposing them into
 * individual atomic instructions that each feed through the grammar engine.
 *
 * Supported patterns:
 *   - Conjunction splitting: "Click A and type B" → ["Click A", "Type B"]
 *   - Sequential: "Click A then verify B" → ["Click A", "Verify B"]
 *   - Conditional: "If A is visible, click A" → conditional execution
 *   - Loop: "For each item, verify visible" → iteration
 *
 * Zero external dependencies — pure regex + state machine parsing.
 *
 * @module ai/step-engine
 */

import { CSReporter } from '../../reporter/CSReporter';

/** Result of decomposing an instruction */
export interface DecomposedInstruction {
    /** Individual sub-instructions to execute */
    steps: SubInstruction[];
    /** Whether the instruction was decomposed */
    wasDecomposed: boolean;
    /** Original instruction */
    original: string;
}

/** A single sub-instruction */
export interface SubInstruction {
    /** The instruction text */
    text: string;
    /** Execution type */
    type: 'action' | 'conditional' | 'loop';
    /** Condition for conditional execution (if type === 'conditional') */
    condition?: {
        /** Element to check */
        element: string;
        /** Condition to check */
        check: 'visible' | 'exists' | 'enabled' | 'checked';
        /** Negate the condition */
        negate?: boolean;
    };
    /** Loop parameters (if type === 'loop') */
    loop?: {
        /** Number of iterations */
        count: number;
    };
}

/** Conjunction patterns that indicate instruction splitting */
const CONJUNCTION_PATTERNS = [
    // "and then" (must check before "and" alone)
    /\s+and\s+then\s+/i,
    // "then" (sequencing)
    /\s+then\s+/i,
    // "after that" / "after which"
    /\s+after\s+(?:that|which)\s+/i,
    // "followed by"
    /\s+followed\s+by\s+/i,
    // "and" between two action verbs
    // This one is trickier - we only split on "and" when both sides look like instructions
];

/** Action verbs that indicate the start of a new instruction */
const ACTION_VERBS = [
    'click', 'tap', 'press', 'type', 'enter', 'fill', 'input', 'write',
    'select', 'choose', 'pick', 'check', 'uncheck', 'toggle', 'mark',
    'hover', 'scroll', 'navigate', 'go', 'open', 'visit', 'browse',
    'verify', 'assert', 'check', 'confirm', 'validate', 'ensure',
    'wait', 'drag', 'drop', 'upload', 'download', 'clear', 'close',
    'switch', 'expand', 'collapse', 'sort', 'get', 'read', 'capture',
    'set', 'accept', 'dismiss', 'handle'
];

const ACTION_VERB_PATTERN = new RegExp(`^(${ACTION_VERBS.join('|')})\\b`, 'i');

export class CSInstructionDecomposer {
    private static instance: CSInstructionDecomposer;

    private constructor() {}

    public static getInstance(): CSInstructionDecomposer {
        if (!CSInstructionDecomposer.instance) {
            CSInstructionDecomposer.instance = new CSInstructionDecomposer();
        }
        return CSInstructionDecomposer.instance;
    }

    /**
     * Decompose a compound instruction into atomic sub-instructions.
     *
     * @param instruction - The original compound instruction
     * @returns DecomposedInstruction with list of sub-instructions
     */
    public decompose(instruction: string): DecomposedInstruction {
        const trimmed = instruction.trim();

        // Try conditional first
        const conditional = this.tryConditional(trimmed);
        if (conditional) {
            return { steps: conditional, wasDecomposed: true, original: trimmed };
        }

        // Try loop
        const loop = this.tryLoop(trimmed);
        if (loop) {
            return { steps: loop, wasDecomposed: true, original: trimmed };
        }

        // Try conjunction splitting
        const conjunctionSteps = this.trySplitConjunction(trimmed);
        if (conjunctionSteps && conjunctionSteps.length > 1) {
            CSReporter.debug(`CSInstructionDecomposer: Decomposed "${trimmed}" into ${conjunctionSteps.length} steps`);
            return {
                steps: conjunctionSteps.map(text => ({ text, type: 'action' as const })),
                wasDecomposed: true,
                original: trimmed
            };
        }

        // Not decomposable — return as-is
        return {
            steps: [{ text: trimmed, type: 'action' }],
            wasDecomposed: false,
            original: trimmed
        };
    }

    /**
     * Try to split on conjunction patterns ("and then", "then", "and", etc.)
     */
    private trySplitConjunction(instruction: string): string[] | null {
        // First, protect quoted strings from splitting
        const quotedStrings: string[] = [];
        let protected_ = instruction.replace(/'[^']*'|"[^"]*"/g, (match) => {
            quotedStrings.push(match);
            return `__PROTECTED_${quotedStrings.length - 1}__`;
        });

        // Try splitting on each conjunction pattern
        for (const pattern of CONJUNCTION_PATTERNS) {
            const parts = protected_.split(pattern);
            if (parts.length > 1) {
                // Restore quoted strings and validate each part
                const restored = parts
                    .map(p => this.restoreProtected(p.trim(), quotedStrings))
                    .filter(p => p.length > 0);

                // Only accept if all parts look like instructions (start with an action verb)
                if (restored.every(p => this.looksLikeInstruction(p))) {
                    return restored;
                }
            }
        }

        // Try splitting on "and" only when both sides start with action verbs
        const andParts = protected_.split(/\s+and\s+/i);
        if (andParts.length === 2) {
            const restored = andParts
                .map(p => this.restoreProtected(p.trim(), quotedStrings))
                .filter(p => p.length > 0);

            if (restored.length === 2 && restored.every(p => this.looksLikeInstruction(p))) {
                return restored;
            }
        }

        return null;
    }

    /**
     * Try to parse a conditional instruction.
     * Patterns: "If X is visible, click X", "When X exists, type Y"
     */
    private tryConditional(instruction: string): SubInstruction[] | null {
        // Pattern: "If/When <element> is <condition>, <action>"
        const match = instruction.match(
            /^(?:if|when|unless)\s+(?:the\s+)?(.+?)\s+(?:is\s+)?(visible|displayed|shown|exists?|present|enabled|disabled|checked|unchecked)(?:\s*,\s*|\s+then\s+)(.+)$/i
        );

        if (match) {
            const element = match[1].trim();
            const conditionWord = match[2].toLowerCase();
            const action = match[3].trim();

            // Map condition words to check types
            let check: 'visible' | 'exists' | 'enabled' | 'checked' = 'visible';
            let negate = false;

            if (['visible', 'displayed', 'shown'].includes(conditionWord)) check = 'visible';
            else if (['exists', 'exist', 'present'].includes(conditionWord)) check = 'exists';
            else if (conditionWord === 'enabled') check = 'enabled';
            else if (conditionWord === 'disabled') { check = 'enabled'; negate = true; }
            else if (conditionWord === 'checked') check = 'checked';
            else if (conditionWord === 'unchecked') { check = 'checked'; negate = true; }

            if (instruction.toLowerCase().startsWith('unless')) negate = !negate;

            if (this.looksLikeInstruction(action)) {
                return [{
                    text: action,
                    type: 'conditional',
                    condition: { element, check, negate }
                }];
            }
        }

        return null;
    }

    /**
     * Try to parse a loop instruction.
     * Patterns: "Repeat X times: <action>", "Do <action> 3 times"
     */
    private tryLoop(instruction: string): SubInstruction[] | null {
        // Pattern: "Repeat <N> times: <action>"
        const repeatMatch = instruction.match(
            /^repeat\s+(\d+)\s+times?\s*[:\-]\s*(.+)$/i
        );

        if (repeatMatch) {
            const count = parseInt(repeatMatch[1]);
            const action = repeatMatch[2].trim();
            if (count > 0 && count <= 100 && this.looksLikeInstruction(action)) {
                return [{
                    text: action,
                    type: 'loop',
                    loop: { count }
                }];
            }
        }

        // Pattern: "<action> <N> times"
        const timesMatch = instruction.match(
            /^(.+?)\s+(\d+)\s+times?$/i
        );

        if (timesMatch) {
            const action = timesMatch[1].trim();
            const count = parseInt(timesMatch[2]);
            if (count > 0 && count <= 100 && this.looksLikeInstruction(action)) {
                return [{
                    text: action,
                    type: 'loop',
                    loop: { count }
                }];
            }
        }

        return null;
    }

    /**
     * Check if a string looks like a valid instruction (starts with an action verb).
     */
    private looksLikeInstruction(text: string): boolean {
        const trimmed = text.trim();
        return ACTION_VERB_PATTERN.test(trimmed);
    }

    /**
     * Restore protected quoted strings.
     */
    private restoreProtected(text: string, quotedStrings: string[]): string {
        return text.replace(/__PROTECTED_(\d+)__/g, (_, idx) => quotedStrings[parseInt(idx)] || '');
    }
}
