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
    /** B2: DCT-based perceptual hash result (only present when enabled). */
    perceptualDctResult?: { passed: boolean; hammingDistance: number; maxDistance: number; threshold: number; adaptive: boolean };
    /** B2: Mean SSIM result (only present when enabled). */
    ssimResult?: { passed: boolean; score: number; threshold: number; adaptive: boolean };
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

/** B2: DCT-based perceptual hash options. */
export interface DctPerceptualHashOptions {
    /** Max Hamming distance on a 64-bit hash. Default from VISUAL_AI_DCT_THRESHOLD (8). */
    threshold?: number;
}

/** B2: SSIM options. */
export interface SSIMOptions {
    /**
     * Minimum SSIM score to pass, in [0, 1]. Default from
     * VISUAL_AI_SSIM_THRESHOLD (0.99). 1 = identical, ≥ 0.99 = no
     * human-perceivable change, ≥ 0.95 = minor cosmetic, < 0.9 = real change.
     */
    threshold?: number;
    /** Working dimensions for the SSIM comparison. Defaults to 256x256. */
    width?: number;
    height?: number;
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
    /** B2: when set or when VISUAL_AI_DCT_ENABLED=true, includes DCT-pHash in smart verdict. */
    perceptualDct?: DctPerceptualHashOptions;
    /** B2: when set or when VISUAL_AI_SSIM_ENABLED=true, includes Mean SSIM in smart verdict. */
    ssim?: SSIMOptions;
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
