/**
 * CSVisualDctPHash — DCT-based perceptual hash (pHash)
 *
 * B2 addition (2026-05-26): the framework's existing perceptual hash
 * uses average hash (aHash): downscale to N×N grayscale, hash bits =
 * pixel ≥ avg. Fast, but coarse — small structural changes that
 * preserve the average don't change the hash, and any change that
 * crosses the average flips many bits.
 *
 * DCT-based pHash is the standard alternative. It captures the
 * low-frequency components of the image, which is where human-
 * perceivable structure lives, and is much more robust to small
 * rotations, crops, brightness/contrast changes and JPEG-style
 * artefacts.
 *
 * Algorithm (Zauner 2010):
 *
 *   1. Resize to 32×32 grayscale.
 *   2. Apply 2D DCT to the 32×32 matrix.
 *   3. Take the top-left 8×8 block of DCT coefficients (low frequencies).
 *   4. Compute the median of the 64 coefficients, excluding the DC term
 *      at [0,0] which dominates and would otherwise tilt the median.
 *   5. Each of the 64 output bits = 1 if coefficient > median, else 0.
 *   6. Pack the 64 bits into a 16-char hex string.
 *
 * Compare two hashes via Hamming distance (count of differing bits).
 * Range: 0 (identical) to 64 (anti-correlated). For screenshots,
 * distance ≤ ~5 typically means "human can't tell them apart";
 * distance ≤ ~10 means "minor visual change"; distance ≥ ~20 means
 * "definitely changed".
 *
 * Pure TypeScript + sharp (for decode + resize + grayscale). No new
 * npm dep.
 */

import sharp from 'sharp';

const SAMPLE_SIZE = 32; // resize target
const HASH_SIZE = 8;    // output is HASH_SIZE × HASH_SIZE bits

// Pre-compute the DCT-II coefficient table for SAMPLE_SIZE so we don't
// recompute cosines per call. dctCoeffs[u][x] = cos((2x+1)uπ / (2N))
const dctCoeffs: number[][] = (() => {
    const N = SAMPLE_SIZE;
    const t: number[][] = [];
    for (let u = 0; u < N; u++) {
        t[u] = [];
        for (let x = 0; x < N; x++) {
            t[u][x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N));
        }
    }
    return t;
})();

// alpha(u) factor for the orthonormal DCT-II: 1/√2 at u=0, else 1.
function alpha(u: number): number {
    return u === 0 ? 1 / Math.sqrt(2) : 1;
}

/**
 * Compute the DCT-pHash of an image buffer.
 *
 * @returns 16-char lowercase hex string (64 bits packed into 16 hex
 *          chars), or null if the buffer cannot be decoded.
 */
export async function computeDctPerceptualHash(image: Buffer): Promise<string | null> {
    let raw: Buffer;
    try {
        raw = await sharp(image)
            .resize(SAMPLE_SIZE, SAMPLE_SIZE, { fit: 'fill' })
            .grayscale()
            .raw()
            .toBuffer();
    } catch (e) {
        return null;
    }

    if (raw.length !== SAMPLE_SIZE * SAMPLE_SIZE) {
        return null;
    }

    // Apply 2D DCT-II to the 32×32 grayscale matrix. We only need the
    // top-left 8×8 block, so we restrict u, v ∈ [0, HASH_SIZE).
    // Standard formula:
    //   F(u,v) = (2/N) · α(u) · α(v) · Σ_x Σ_y f(x,y) · cos((2x+1)uπ/2N) · cos((2y+1)vπ/2N)
    // We drop the (2/N) prefactor since the median-comparison ignores
    // absolute scale.
    const coeffs: number[] = []; // 64 entries, row-major
    for (let u = 0; u < HASH_SIZE; u++) {
        for (let v = 0; v < HASH_SIZE; v++) {
            let sum = 0;
            for (let x = 0; x < SAMPLE_SIZE; x++) {
                const cu = dctCoeffs[u][x];
                const rowOff = x * SAMPLE_SIZE;
                for (let y = 0; y < SAMPLE_SIZE; y++) {
                    sum += raw[rowOff + y] * cu * dctCoeffs[v][y];
                }
            }
            coeffs.push(alpha(u) * alpha(v) * sum);
        }
    }

    // Median of the 63 non-DC coefficients (skip index 0).
    const nonDc = coeffs.slice(1).slice();
    nonDc.sort((a, b) => a - b);
    const mid = Math.floor(nonDc.length / 2);
    const median = nonDc.length % 2 === 0
        ? (nonDc[mid - 1] + nonDc[mid]) / 2
        : nonDc[mid];

    // Each bit = 1 if coefficient > median, else 0. The DC term gets
    // its bit too (compared against the same median for simplicity).
    let bits = '';
    for (let i = 0; i < coeffs.length; i++) {
        bits += coeffs[i] > median ? '1' : '0';
    }

    // Pack 64 bits → 16 hex chars.
    let hex = '';
    for (let i = 0; i < 64; i += 4) {
        const nibble = parseInt(bits.slice(i, i + 4), 2);
        hex += nibble.toString(16);
    }
    return hex;
}

/**
 * Hamming distance between two hex-encoded 64-bit pHashes.
 * Returns -1 if either hash is malformed.
 */
export function dctPerceptualHashDistance(a: string, b: string): number {
    if (!a || !b || a.length !== b.length) return -1;
    let distance = 0;
    for (let i = 0; i < a.length; i++) {
        const va = parseInt(a[i], 16);
        const vb = parseInt(b[i], 16);
        if (Number.isNaN(va) || Number.isNaN(vb)) return -1;
        // popcount of xor
        let x = va ^ vb;
        x = x - ((x >> 1) & 0x5);
        x = (x & 0x3) + ((x >> 2) & 0x3);
        distance += x;
    }
    return distance;
}
