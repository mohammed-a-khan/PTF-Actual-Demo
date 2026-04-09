/**
 * CSVisualAITypes - Type definitions for Visual AI Testing
 *
 * Enhancement #11: Visual AI Testing types for perceptual hash,
 * structural comparison, and combined smart visual comparison.
 */

export interface SmartVisualResult {
    passed: boolean;
    verdict: 'identical' | 'cosmetic_only' | 'visual_change' | 'structural_change';
    pixelResult: { passed: boolean; diffPercentage: number };
    perceptualResult: { passed: boolean; hammingDistance: number; maxDistance: number };
    structuralResult: { passed: boolean; ariaChanges: string[]; layoutChanges: LayoutChange[] };
    message: string;
    recommendations: string[];
}

export interface LayoutChange {
    element: string;
    type: 'moved' | 'resized' | 'added' | 'removed';
    before?: { x: number; y: number; width: number; height: number };
    after?: { x: number; y: number; width: number; height: number };
}

export interface PerceptualHashOptions {
    hashSize?: number;  // default 8 (8x8 = 64 bits)
    threshold?: number; // max Hamming distance
}

export interface StructuralComparisonOptions {
    ignorePositionChanges?: boolean;
    layoutTolerance?: number;
    ignoreRoles?: string[];
}

export interface SmartVisualOptions {
    name?: string;
    fullPage?: boolean;
    mask?: string[];
    perceptual?: PerceptualHashOptions;
    structural?: StructuralComparisonOptions;
    timeout?: number;
    updateBaseline?: boolean;
}

export interface LayoutElementInfo {
    selector: string;
    role: string;
    name: string;
    boundingBox: { x: number; y: number; width: number; height: number };
}

export interface StructuralBaseline {
    ariaSnapshot: string;
    layoutElements: LayoutElementInfo[];
    timestamp: string;
}

export interface PerceptualBaseline {
    hash: string;
    hashSize: number;
    timestamp: string;
}
