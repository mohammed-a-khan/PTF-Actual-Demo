/**
 * CSArrayUtility - Comprehensive Array Manipulation Utility Class
 *
 * Purpose: Provides static utility methods for advanced array operations
 * including filtering, transformation, grouping, sorting, and statistical analysis
 *
 * Features:
 * - Null-safe operations
 * - Type-safe generics
 * - Functional programming patterns
 * - Performance-optimized algorithms
 * - Comprehensive array manipulations
 */

export class CSArrayUtility {
    /**
     * Remove duplicates from array
     * @param array - Input array
     * @param key - Optional key function for object comparison
     * @returns Array without duplicates
     */
    public static unique<T>(array: T[], key?: (item: T) => any): T[] {
        if (!array || array.length === 0) return [];

        if (!key) {
            return [...new Set(array)];
        }

        const seen = new Set();
        return array.filter(item => {
            const k = key(item);
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
        });
    }

    /**
     * Chunk array into smaller arrays of specified size
     * @param array - Input array
     * @param size - Chunk size
     * @returns Array of chunks
     */
    public static chunk<T>(array: T[], size: number): T[][] {
        if (!array || array.length === 0) return [];
        if (size <= 0) throw new Error('Chunk size must be greater than 0');

        const chunks: T[][] = [];
        for (let i = 0; i < array.length; i += size) {
            chunks.push(array.slice(i, i + size));
        }
        return chunks;
    }

    /**
     * Flatten nested array to specified depth
     * @param array - Nested array
     * @param depth - Depth to flatten (default: 1)
     * @returns Flattened array
     */
    public static flatten<T>(array: any[], depth: number = 1): T[] {
        if (!array || array.length === 0) return [];
        if (depth <= 0) return array as T[];

        return array.reduce((acc, val) => {
            if (Array.isArray(val)) {
                acc.push(...this.flatten(val, depth - 1));
            } else {
                acc.push(val);
            }
            return acc;
        }, []);
    }

    /**
     * Group array elements by key function
     * @param array - Input array
     * @param keyFn - Function to generate group key
     * @returns Map of grouped items
     */
    public static groupBy<T, K = string>(
        array: T[],
        keyFn: (item: T) => K
    ): Map<K, T[]> {
        if (!array || array.length === 0) return new Map();

        const groups = new Map<K, T[]>();
        for (const item of array) {
            const key = keyFn(item);
            if (!groups.has(key)) {
                groups.set(key, []);
            }
            groups.get(key)!.push(item);
        }
        return groups;
    }

    /**
     * Partition array into two arrays based on predicate
     * @param array - Input array
     * @param predicate - Function to test each element
     * @returns Tuple of [matching, non-matching]
     */
    public static partition<T>(
        array: T[],
        predicate: (item: T, index: number) => boolean
    ): [T[], T[]] {
        if (!array || array.length === 0) return [[], []];

        const truthy: T[] = [];
        const falsy: T[] = [];

        array.forEach((item, index) => {
            if (predicate(item, index)) {
                truthy.push(item);
            } else {
                falsy.push(item);
            }
        });

        return [truthy, falsy];
    }

    /**
     * Find intersection of multiple arrays
     * @param arrays - Arrays to intersect
     * @returns Array containing only common elements
     */
    public static intersection<T>(...arrays: T[][]): T[] {
        if (!arrays || arrays.length === 0) return [];
        if (arrays.length === 1) return arrays[0];

        const [first, ...rest] = arrays;
        return first.filter(item =>
            rest.every(arr => arr.includes(item))
        );
    }

    /**
     * Find difference between two arrays (elements in first but not in second)
     * @param array1 - First array
     * @param array2 - Second array
     * @returns Elements unique to first array
     */
    public static difference<T>(array1: T[], array2: T[]): T[] {
        if (!array1 || array1.length === 0) return [];
        if (!array2 || array2.length === 0) return array1;

        const set2 = new Set(array2);
        return array1.filter(item => !set2.has(item));
    }

    /**
     * Find union of multiple arrays (all unique elements)
     * @param arrays - Arrays to unite
     * @returns Array containing all unique elements
     */
    public static union<T>(...arrays: T[][]): T[] {
        if (!arrays || arrays.length === 0) return [];
        return this.unique(arrays.flat());
    }

    /**
     * Shuffle array randomly (Fisher-Yates algorithm)
     * @param array - Input array
     * @returns Shuffled copy of array
     */
    public static shuffle<T>(array: T[]): T[] {
        if (!array || array.length <= 1) return [...array];

        const shuffled = [...array];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled;
    }

    /**
     * Get random sample from array
     * @param array - Input array
     * @param count - Number of items to sample
     * @returns Random sample of specified size
     */
    public static sample<T>(array: T[], count: number = 1): T[] {
        if (!array || array.length === 0) return [];
        if (count >= array.length) return this.shuffle(array);

        const shuffled = this.shuffle(array);
        return shuffled.slice(0, count);
    }

    /**
     * Sort array by multiple keys
     * @param array - Input array
     * @param compareFns - Array of comparison functions
     * @returns Sorted copy of array
     */
    public static sortBy<T>(
        array: T[],
        ...compareFns: Array<(a: T, b: T) => number>
    ): T[] {
        if (!array || array.length <= 1) return [...array];

        return [...array].sort((a, b) => {
            for (const compareFn of compareFns) {
                const result = compareFn(a, b);
                if (result !== 0) return result;
            }
            return 0;
        });
    }

    /**
     * Count occurrences of each element
     * @param array - Input array
     * @returns Map of element counts
     */
    public static countBy<T>(array: T[]): Map<T, number> {
        if (!array || array.length === 0) return new Map();

        const counts = new Map<T, number>();
        for (const item of array) {
            counts.set(item, (counts.get(item) || 0) + 1);
        }
        return counts;
    }

    /**
     * Sum numeric array
     * @param array - Array of numbers
     * @returns Sum of all numbers
     */
    public static sum(array: number[]): number {
        if (!array || array.length === 0) return 0;
        return array.reduce((sum, val) => sum + val, 0);
    }

    /**
     * Calculate average of numeric array
     * @param array - Array of numbers
     * @returns Average value
     */
    public static average(array: number[]): number {
        if (!array || array.length === 0) return 0;
        return this.sum(array) / array.length;
    }

    /**
     * Find minimum value in array
     * @param array - Array of numbers
     * @returns Minimum value
     */
    public static min(array: number[]): number {
        if (!array || array.length === 0) return 0;
        return Math.min(...array);
    }

    /**
     * Find maximum value in array
     * @param array - Array of numbers
     * @returns Maximum value
     */
    public static max(array: number[]): number {
        if (!array || array.length === 0) return 0;
        return Math.max(...array);
    }

    /**
     * Calculate median of numeric array
     * @param array - Array of numbers
     * @returns Median value
     */
    public static median(array: number[]): number {
        if (!array || array.length === 0) return 0;

        const sorted = [...array].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);

        return sorted.length % 2 === 0
            ? (sorted[mid - 1] + sorted[mid]) / 2
            : sorted[mid];
    }

    /**
     * Rotate array left by n positions
     * @param array - Input array
     * @param positions - Number of positions to rotate
     * @returns Rotated copy of array
     */
    public static rotateLeft<T>(array: T[], positions: number = 1): T[] {
        if (!array || array.length <= 1) return [...array];
        const n = positions % array.length;
        return [...array.slice(n), ...array.slice(0, n)];
    }

    /**
     * Rotate array right by n positions
     * @param array - Input array
     * @param positions - Number of positions to rotate
     * @returns Rotated copy of array
     */
    public static rotateRight<T>(array: T[], positions: number = 1): T[] {
        if (!array || array.length <= 1) return [...array];
        return this.rotateLeft(array, array.length - (positions % array.length));
    }

    /**
     * Zip multiple arrays together
     * @param arrays - Arrays to zip
     * @returns Array of tuples
     */
    public static zip<T>(...arrays: T[][]): T[][] {
        if (!arrays || arrays.length === 0) return [];
        const maxLength = Math.max(...arrays.map(arr => arr.length));
        const result: T[][] = [];

        for (let i = 0; i < maxLength; i++) {
            result.push(arrays.map(arr => arr[i]));
        }
        return result;
    }

    /**
     * Compact array - remove falsy values
     * @param array - Input array
     * @returns Array without falsy values
     */
    public static compact<T>(array: T[]): T[] {
        if (!array || array.length === 0) return [];
        return array.filter(Boolean);
    }

    /**
     * Pluck specific property from array of objects
     * @param array - Array of objects
     * @param key - Property key to extract
     * @returns Array of property values
     */
    public static pluck<T, K extends keyof T>(array: T[], key: K): T[K][] {
        if (!array || array.length === 0) return [];
        return array.map(item => item[key]);
    }

    /**
     * Index array of objects by key
     * @param array - Array of objects
     * @param key - Property key to index by
     * @returns Map indexed by key
     */
    public static indexBy<T, K extends keyof T>(
        array: T[],
        key: K
    ): Map<T[K], T> {
        if (!array || array.length === 0) return new Map();

        const indexed = new Map<T[K], T>();
        for (const item of array) {
            indexed.set(item[key], item);
        }
        return indexed;
    }

    /**
     * Take first n elements
     * @param array - Input array
     * @param count - Number of elements to take
     * @returns First n elements
     */
    public static take<T>(array: T[], count: number): T[] {
        if (!array || array.length === 0 || count <= 0) return [];
        return array.slice(0, count);
    }

    /**
     * Take last n elements
     * @param array - Input array
     * @param count - Number of elements to take
     * @returns Last n elements
     */
    public static takeLast<T>(array: T[], count: number): T[] {
        if (!array || array.length === 0 || count <= 0) return [];
        return array.slice(-count);
    }

    /**
     * Drop first n elements
     * @param array - Input array
     * @param count - Number of elements to drop
     * @returns Array without first n elements
     */
    public static drop<T>(array: T[], count: number): T[] {
        if (!array || array.length === 0 || count <= 0) return [...array];
        return array.slice(count);
    }

    /**
     * Drop last n elements
     * @param array - Input array
     * @param count - Number of elements to drop
     * @returns Array without last n elements
     */
    public static dropLast<T>(array: T[], count: number): T[] {
        if (!array || array.length === 0 || count <= 0) return [...array];
        return array.slice(0, -count);
    }

    /**
     * Check if arrays are equal (deep comparison)
     * @param array1 - First array
     * @param array2 - Second array
     * @returns True if arrays are equal
     */
    public static equals<T>(array1: T[], array2: T[]): boolean {
        if (array1 === array2) return true;
        if (!array1 || !array2) return false;
        if (array1.length !== array2.length) return false;

        for (let i = 0; i < array1.length; i++) {
            if (Array.isArray(array1[i]) && Array.isArray(array2[i])) {
                if (!this.equals(array1[i] as any, array2[i] as any)) return false;
            } else if (array1[i] !== array2[i]) {
                return false;
            }
        }
        return true;
    }
}

export default CSArrayUtility;
