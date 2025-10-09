/**
 * Similarity Engine - Advanced similarity calculations between elements
 * Uses multiple algorithms and weighted scoring
 */

import {
    ElementFeatures,
    SimilarityScore,
    SimilarityWeights,
    DEFAULT_SIMILARITY_WEIGHTS
} from '../types/AITypes';
import { CSReporter } from '../../reporter/CSReporter';

export class CSSimilarityEngine {
    private static instance: CSSimilarityEngine;
    private weights: SimilarityWeights = DEFAULT_SIMILARITY_WEIGHTS;

    private constructor() {
        CSReporter.debug('[CSSimilarityEngine] Initialized');
    }

    public static getInstance(): CSSimilarityEngine {
        if (!CSSimilarityEngine.instance) {
            CSSimilarityEngine.instance = new CSSimilarityEngine();
        }
        return CSSimilarityEngine.instance;
    }

    /**
     * Calculate overall similarity between two element feature sets
     */
    public calculateSimilarity(features1: ElementFeatures, features2: ElementFeatures): SimilarityScore {
        const textScore = this.calculateTextSimilarity(features1, features2);
        const visualScore = this.calculateVisualSimilarity(features1, features2);
        const structuralScore = this.calculateStructuralSimilarity(features1, features2);
        const semanticScore = this.calculateSemanticSimilarity(features1, features2);
        const contextScore = this.calculateContextSimilarity(features1, features2);

        const overall =
            textScore * this.weights.text +
            visualScore * this.weights.visual +
            structuralScore * this.weights.structural +
            semanticScore * this.weights.semantic +
            contextScore * this.weights.context;

        return {
            overall,
            breakdown: {
                text: textScore,
                visual: visualScore,
                structural: structuralScore,
                semantic: semanticScore,
                context: contextScore
            }
        };
    }

    /**
     * Text similarity using multiple algorithms
     */
    private calculateTextSimilarity(f1: ElementFeatures, f2: ElementFeatures): number {
        let totalScore = 0;
        let count = 0;

        // Compare visible text
        if (f1.text.visibleText && f2.text.visibleText) {
            totalScore += this.levenshteinSimilarity(f1.text.visibleText, f2.text.visibleText);
            count++;
        }

        // Compare aria-label
        if (f1.text.ariaLabel && f2.text.ariaLabel) {
            totalScore += this.levenshteinSimilarity(f1.text.ariaLabel, f2.text.ariaLabel);
            count++;
        }

        // Compare title
        if (f1.text.title && f2.text.title) {
            totalScore += this.levenshteinSimilarity(f1.text.title, f2.text.title);
            count++;
        }

        // Compare placeholder
        if (f1.text.placeholder && f2.text.placeholder) {
            totalScore += this.levenshteinSimilarity(f1.text.placeholder, f2.text.placeholder);
            count++;
        }

        return count > 0 ? totalScore / count : 0;
    }

    /**
     * Visual similarity based on appearance
     */
    private calculateVisualSimilarity(f1: ElementFeatures, f2: ElementFeatures): number {
        let score = 0;
        let maxScore = 0;

        // Visibility match
        maxScore += 10;
        if (f1.visual.isVisible === f2.visual.isVisible) score += 10;

        // Position type match
        maxScore += 15;
        if (f1.visual.position === f2.visual.position) score += 15;

        // Display type match
        maxScore += 10;
        if (f1.visual.display === f2.visual.display) score += 10;

        // Font size similarity
        maxScore += 15;
        if (f1.visual.fontSize === f2.visual.fontSize) {
            score += 15;
        } else {
            const size1 = parseFloat(f1.visual.fontSize);
            const size2 = parseFloat(f2.visual.fontSize);
            if (!isNaN(size1) && !isNaN(size2)) {
                const diff = Math.abs(size1 - size2);
                score += Math.max(0, 15 - diff);
            }
        }

        // Bounding box similarity
        maxScore += 20;
        if (f1.visual.boundingBox && f2.visual.boundingBox) {
            const widthDiff = Math.abs(f1.visual.boundingBox.width - f2.visual.boundingBox.width);
            const heightDiff = Math.abs(f1.visual.boundingBox.height - f2.visual.boundingBox.height);

            const widthScore = Math.max(0, 10 - (widthDiff / 10));
            const heightScore = Math.max(0, 10 - (heightDiff / 10));
            score += widthScore + heightScore;
        }

        // Color similarity
        maxScore += 15;
        if (f1.visual.color === f2.visual.color) score += 7.5;
        if (f1.visual.backgroundColor === f2.visual.backgroundColor) score += 7.5;

        // Z-index similarity
        maxScore += 5;
        if (f1.visual.zIndex === f2.visual.zIndex) score += 5;

        // Opacity similarity
        maxScore += 5;
        if (Math.abs(f1.visual.opacity - f2.visual.opacity) < 0.1) score += 5;

        // Cursor type
        maxScore += 5;
        if (f1.visual.cursor === f2.visual.cursor) score += 5;

        return maxScore > 0 ? score / maxScore : 0;
    }

    /**
     * Structural similarity based on DOM structure
     */
    private calculateStructuralSimilarity(f1: ElementFeatures, f2: ElementFeatures): number {
        let score = 0;
        let maxScore = 0;

        // Tag name match (most important)
        maxScore += 30;
        if (f1.structural.tagName === f2.structural.tagName) score += 30;

        // Role match
        maxScore += 20;
        if (f1.structural.role === f2.structural.role) score += 20;

        // ID similarity
        maxScore += 10;
        if (f1.structural.id && f2.structural.id) {
            score += 10 * this.levenshteinSimilarity(f1.structural.id, f2.structural.id);
        }

        // Class overlap
        maxScore += 20;
        const classOverlap = f1.structural.classList.filter(c => f2.structural.classList.includes(c)).length;
        const totalClasses = Math.max(f1.structural.classList.length, f2.structural.classList.length);
        if (totalClasses > 0) {
            score += 20 * (classOverlap / totalClasses);
        }

        // Depth similarity
        maxScore += 10;
        const depthDiff = Math.abs(f1.structural.depth - f2.structural.depth);
        score += Math.max(0, 10 - depthDiff);

        // Interactive state match
        maxScore += 5;
        if (f1.structural.isInteractive === f2.structural.isInteractive) score += 5;

        // Form element match
        maxScore += 5;
        if (f1.structural.formElement === f2.structural.formElement) score += 5;

        return maxScore > 0 ? score / maxScore : 0;
    }

    /**
     * Semantic similarity based on ARIA and semantics
     */
    private calculateSemanticSimilarity(f1: ElementFeatures, f2: ElementFeatures): number {
        let score = 0;
        let maxScore = 0;

        // Role match (most important for semantics)
        maxScore += 40;
        if (f1.semantic.role === f2.semantic.role) score += 40;

        // Semantic type match
        maxScore += 30;
        if (f1.semantic.semanticType === f2.semantic.semanticType) score += 30;

        // Landmark match
        maxScore += 10;
        if (f1.semantic.isLandmark === f2.semantic.isLandmark) score += 10;

        // Heading level match
        maxScore += 10;
        if (f1.semantic.headingLevel === f2.semantic.headingLevel) score += 10;

        // List item match
        maxScore += 5;
        if (f1.semantic.listItem === f2.semantic.listItem) score += 5;

        // Table cell match
        maxScore += 5;
        if (f1.semantic.tableCell === f2.semantic.tableCell) score += 5;

        return maxScore > 0 ? score / maxScore : 0;
    }

    /**
     * Context similarity based on surrounding elements
     */
    private calculateContextSimilarity(f1: ElementFeatures, f2: ElementFeatures): number {
        let score = 0;
        let maxScore = 0;

        // Parent tag match
        maxScore += 20;
        if (f1.context.parentTag === f2.context.parentTag) score += 20;

        // Form ID match
        maxScore += 20;
        if (f1.context.formId && f2.context.formId && f1.context.formId === f2.context.formId) {
            score += 20;
        }

        // Nearby heading similarity
        maxScore += 20;
        if (f1.context.nearbyHeading && f2.context.nearbyHeading) {
            score += 20 * this.levenshteinSimilarity(f1.context.nearbyHeading, f2.context.nearbyHeading);
        }

        // Label text similarity
        maxScore += 20;
        if (f1.context.labelText && f2.context.labelText) {
            score += 20 * this.levenshteinSimilarity(f1.context.labelText, f2.context.labelText);
        }

        // Nearest landmark match
        maxScore += 20;
        if (f1.context.nearestLandmark && f2.context.nearestLandmark) {
            if (f1.context.nearestLandmark.role === f2.context.nearestLandmark.role) {
                score += 20;
            }
        }

        return maxScore > 0 ? score / maxScore : 0;
    }

    /**
     * Levenshtein distance similarity (0-1)
     */
    private levenshteinSimilarity(s1: string, s2: string): number {
        if (s1 === s2) return 1.0;
        if (!s1 || !s2) return 0.0;

        s1 = s1.toLowerCase();
        s2 = s2.toLowerCase();

        const longer = s1.length > s2.length ? s1 : s2;
        const shorter = s1.length > s2.length ? s2 : s1;

        if (longer.length === 0) return 1.0;

        const distance = this.levenshteinDistance(longer, shorter);
        return (longer.length - distance) / longer.length;
    }

    /**
     * Calculate Levenshtein distance
     */
    private levenshteinDistance(s1: string, s2: string): number {
        const costs: number[] = [];

        for (let i = 0; i <= s1.length; i++) {
            let lastValue = i;
            for (let j = 0; j <= s2.length; j++) {
                if (i === 0) {
                    costs[j] = j;
                } else if (j > 0) {
                    let newValue = costs[j - 1];
                    if (s1.charAt(i - 1) !== s2.charAt(j - 1)) {
                        newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
                    }
                    costs[j - 1] = lastValue;
                    lastValue = newValue;
                }
            }
            if (i > 0) {
                costs[s2.length] = lastValue;
            }
        }

        return costs[s2.length];
    }

    /**
     * Jaro-Winkler similarity (alternative algorithm)
     */
    private jaroWinklerSimilarity(s1: string, s2: string): number {
        if (s1 === s2) return 1.0;
        if (!s1 || !s2) return 0.0;

        s1 = s1.toLowerCase();
        s2 = s2.toLowerCase();

        const matchWindow = Math.floor(Math.max(s1.length, s2.length) / 2) - 1;
        const s1Matches = new Array(s1.length).fill(false);
        const s2Matches = new Array(s2.length).fill(false);

        let matches = 0;
        let transpositions = 0;

        // Find matches
        for (let i = 0; i < s1.length; i++) {
            const start = Math.max(0, i - matchWindow);
            const end = Math.min(i + matchWindow + 1, s2.length);

            for (let j = start; j < end; j++) {
                if (s2Matches[j] || s1[i] !== s2[j]) continue;
                s1Matches[i] = true;
                s2Matches[j] = true;
                matches++;
                break;
            }
        }

        if (matches === 0) return 0.0;

        // Find transpositions
        let k = 0;
        for (let i = 0; i < s1.length; i++) {
            if (!s1Matches[i]) continue;
            while (!s2Matches[k]) k++;
            if (s1[i] !== s2[k]) transpositions++;
            k++;
        }

        const jaro = (matches / s1.length + matches / s2.length + (matches - transpositions / 2) / matches) / 3;

        // Jaro-Winkler bonus for matching prefixes
        let prefixLength = 0;
        for (let i = 0; i < Math.min(s1.length, s2.length, 4); i++) {
            if (s1[i] === s2[i]) prefixLength++;
            else break;
        }

        return jaro + prefixLength * 0.1 * (1 - jaro);
    }

    /**
     * Update similarity weights
     */
    public setWeights(weights: Partial<SimilarityWeights>): void {
        this.weights = { ...this.weights, ...weights };

        // Normalize to ensure they sum to 1.0
        const total = Object.values(this.weights).reduce((sum, w) => sum + w, 0);
        if (total > 0) {
            this.weights.text /= total;
            this.weights.visual /= total;
            this.weights.structural /= total;
            this.weights.semantic /= total;
            this.weights.context /= total;
        }

        CSReporter.debug('[SimilarityEngine] Weights updated');
    }

    /**
     * Get current weights
     */
    public getWeights(): SimilarityWeights {
        return { ...this.weights };
    }

    /**
     * Reset to default weights
     */
    public resetWeights(): void {
        this.weights = { ...DEFAULT_SIMILARITY_WEIGHTS };
        CSReporter.debug('[SimilarityEngine] Weights reset to defaults');
    }
}
