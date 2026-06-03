/**
 * CSVisualSSIM — Mean Structural Similarity Index Measure (MSSIM)
 *
 * B2 addition (2026-05-26): SSIM correlates with human perception of
 * image quality far better than pixel-by-pixel diff or simple average
 * hashing. The framework's existing perceptual comparison uses average
 * hash (aHash) — fast but blind to local structural changes. SSIM
 * complements that: aHash is the cheap pre-filter, SSIM is the
 * accurate confirmer when the cheap test flags a possible change.
 *
 * This file implements Mean SSIM from scratch in TypeScript — no new
 * npm dependency. `sharp` (already a dep) handles PNG decode, resize
 * and grayscale conversion; the SSIM math itself is plain TS.
 *
 * Algorithm (Wang et al. 2004, simplified):
 *
 *   For each 8x8 window (sliding stride = 8, no overlap):
 *     μ_x = mean(window_baseline)
 *     μ_y = mean(window_current)
 *     σ²_x = variance(window_baseline)
 *     σ²_y = variance(window_current)
 *     σ_xy = covariance(window_baseline, window_current)
 *     SSIM_window = ((2 μ_x μ_y + C1)(2 σ_xy + C2))
 *                 / ((μ_x² + μ_y² + C1)(σ²_x + σ²_y + C2))
 *
 *   Final score = mean(SSIM_window across all windows), clamped to [0, 1].
 *
 * Higher = more similar. SSIM ≥ 0.99 ≈ no human-perceivable change in
 * practice. SSIM ≥ 0.95 ≈ minor cosmetic differences. SSIM < 0.9 = real
 * visual change.
 */

import sharp from 'sharp';

const WINDOW = 8;
// SSIM stabilising constants — standard values from the original paper.
const L = 255; // dynamic range of grayscale pixels
const K1 = 0.01;
const K2 = 0.03;
const C1 = (K1 * L) * (K1 * L); // 6.5025
const C2 = (K2 * L) * (K2 * L); // 58.5225

/**
 * Compare two image buffers via Mean SSIM. Both buffers are decoded,
 * resized to the same dimensions, converted to grayscale, then scored.
 *
 * @returns SSIM score in [0, 1]. 1.0 = identical, 0.0 = unrelated.
 *          Returns -1 if either buffer cannot be decoded or the size
 *          is below the window size (8x8).
 */
export async function computeSSIM(baseline: Buffer, current: Buffer, opts?: { width?: number; height?: number }): Promise<number> {
    // Default working size — 256x256 gives plenty of windows (32x32 = 1024)
    // for stable mean SSIM while staying fast (a few ms per comparison).
    const targetW = opts?.width || 256;
    const targetH = opts?.height || 256;

    if (targetW < WINDOW || targetH < WINDOW) {
        return -1;
    }

    const a = await sharp(baseline)
        .resize(targetW, targetH, { fit: 'fill' })
        .grayscale()
        .raw()
        .toBuffer();
    const b = await sharp(current)
        .resize(targetW, targetH, { fit: 'fill' })
        .grayscale()
        .raw()
        .toBuffer();

    if (a.length !== b.length || a.length === 0) {
        return -1;
    }

    // Sliding 8x8 window with stride = 8 (non-overlapping). Faster than
    // stride=1 and the mean SSIM is virtually identical for screenshots.
    const winSize = WINDOW * WINDOW;
    let totalSSIM = 0;
    let windowCount = 0;

    for (let y = 0; y + WINDOW <= targetH; y += WINDOW) {
        for (let x = 0; x + WINDOW <= targetW; x += WINDOW) {
            let sumA = 0, sumB = 0;
            // First pass: means
            for (let dy = 0; dy < WINDOW; dy++) {
                const rowOff = (y + dy) * targetW + x;
                for (let dx = 0; dx < WINDOW; dx++) {
                    sumA += a[rowOff + dx];
                    sumB += b[rowOff + dx];
                }
            }
            const meanA = sumA / winSize;
            const meanB = sumB / winSize;

            // Second pass: variances and covariance
            let varA = 0, varB = 0, covAB = 0;
            for (let dy = 0; dy < WINDOW; dy++) {
                const rowOff = (y + dy) * targetW + x;
                for (let dx = 0; dx < WINDOW; dx++) {
                    const da = a[rowOff + dx] - meanA;
                    const db = b[rowOff + dx] - meanB;
                    varA += da * da;
                    varB += db * db;
                    covAB += da * db;
                }
            }
            varA /= winSize;
            varB /= winSize;
            covAB /= winSize;

            const numerator = (2 * meanA * meanB + C1) * (2 * covAB + C2);
            const denominator = (meanA * meanA + meanB * meanB + C1) * (varA + varB + C2);
            const ssim = denominator > 0 ? numerator / denominator : 1;
            totalSSIM += ssim;
            windowCount += 1;
        }
    }

    if (windowCount === 0) return -1;
    const mean = totalSSIM / windowCount;
    // SSIM mathematically lives in [-1, 1] but for normal screenshots it's
    // always ≥ 0. Clamp negatives to 0 so the caller doesn't have to.
    return Math.max(0, Math.min(1, mean));
}
