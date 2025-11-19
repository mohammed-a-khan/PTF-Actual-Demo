/**
 * CSCollectionUtility - General Collection Operations Utility Class
 *
 * Purpose: Provides static utility methods for working with various collection types
 * including Sets, Arrays, Maps, and mixed collections
 *
 * Features:
 * - Cross-collection operations
 * - Type conversions
 * - Set operations
 * - Collection validations
 * - Performance-optimized algorithms
 */

export class CSCollectionUtility {
    // ============================================================================
    // SET OPERATIONS
    // ============================================================================

    /**
     * Create Set from array
     * @param array - Source array
     * @returns Set from array elements
     */
    public static toSet<T>(array: T[]): Set<T> {
        if (!array || array.length === 0) return new Set();
        return new Set(array);
    }

    /**
     * Convert Set to array
     * @param set - Source set
     * @returns Array from set elements
     */
    public static fromSet<T>(set: Set<T>): T[] {
        if (!set || set.size === 0) return [];
        return Array.from(set);
    }

    /**
     * Set union operation
     * @param sets - Sets to unite
     * @returns Union of all sets
     */
    public static union<T>(...sets: Set<T>[]): Set<T> {
        if (!sets || sets.length === 0) return new Set();

        const result = new Set<T>();
        for (const set of sets) {
            if (set) {
                for (const item of set) {
                    result.add(item);
                }
            }
        }
        return result;
    }

    /**
     * Set intersection operation
     * @param sets - Sets to intersect
     * @returns Intersection of all sets
     */
    public static intersection<T>(...sets: Set<T>[]): Set<T> {
        if (!sets || sets.length === 0) return new Set();
        if (sets.length === 1) return new Set(sets[0]);

        const [first, ...rest] = sets;
        const result = new Set<T>();

        for (const item of first) {
            if (rest.every(set => set.has(item))) {
                result.add(item);
            }
        }
        return result;
    }

    /**
     * Set difference operation (elements in first set but not in others)
     * @param set1 - First set
     * @param set2 - Second set
     * @returns Difference of sets
     */
    public static difference<T>(set1: Set<T>, set2: Set<T>): Set<T> {
        if (!set1 || set1.size === 0) return new Set();
        if (!set2 || set2.size === 0) return new Set(set1);

        const result = new Set<T>();
        for (const item of set1) {
            if (!set2.has(item)) {
                result.add(item);
            }
        }
        return result;
    }

    /**
     * Symmetric difference (elements in either set but not both)
     * @param set1 - First set
     * @param set2 - Second set
     * @returns Symmetric difference of sets
     */
    public static symmetricDifference<T>(set1: Set<T>, set2: Set<T>): Set<T> {
        if (!set1 && !set2) return new Set();
        if (!set1) return new Set(set2);
        if (!set2) return new Set(set1);

        const result = new Set<T>();

        for (const item of set1) {
            if (!set2.has(item)) result.add(item);
        }
        for (const item of set2) {
            if (!set1.has(item)) result.add(item);
        }

        return result;
    }

    /**
     * Check if set is subset of another
     * @param subset - Potential subset
     * @param superset - Potential superset
     * @returns True if subset is contained in superset
     */
    public static isSubset<T>(subset: Set<T>, superset: Set<T>): boolean {
        if (!subset || subset.size === 0) return true;
        if (!superset || superset.size === 0) return false;
        if (subset.size > superset.size) return false;

        for (const item of subset) {
            if (!superset.has(item)) return false;
        }
        return true;
    }

    /**
     * Check if set is superset of another
     * @param superset - Potential superset
     * @param subset - Potential subset
     * @returns True if superset contains subset
     */
    public static isSuperset<T>(superset: Set<T>, subset: Set<T>): boolean {
        return this.isSubset(subset, superset);
    }

    /**
     * Check if sets are disjoint (no common elements)
     * @param set1 - First set
     * @param set2 - Second set
     * @returns True if sets have no common elements
     */
    public static areDisjoint<T>(set1: Set<T>, set2: Set<T>): boolean {
        if (!set1 || !set2 || set1.size === 0 || set2.size === 0) return true;

        // Check the smaller set
        const [smaller, larger] = set1.size <= set2.size ? [set1, set2] : [set2, set1];

        for (const item of smaller) {
            if (larger.has(item)) return false;
        }
        return true;
    }

    // ============================================================================
    // TYPE CONVERSIONS
    // ============================================================================

    /**
     * Convert Map to array of objects
     * @param map - Source map
     * @returns Array of {key, value} objects
     */
    public static mapToArray<K, V>(
        map: Map<K, V>
    ): Array<{ key: K; value: V }> {
        if (!map || map.size === 0) return [];

        const array: Array<{ key: K; value: V }> = [];
        for (const [key, value] of map.entries()) {
            array.push({ key, value });
        }
        return array;
    }

    /**
     * Convert array of objects to Map
     * @param array - Array of {key, value} objects
     * @returns Map created from array
     */
    public static arrayToMap<K, V>(
        array: Array<{ key: K; value: V }>
    ): Map<K, V> {
        if (!array || array.length === 0) return new Map();

        const map = new Map<K, V>();
        for (const item of array) {
            map.set(item.key, item.value);
        }
        return map;
    }

    /**
     * Convert object to Set of values
     * @param obj - Source object
     * @returns Set of object values
     */
    public static objectValuesToSet<V>(obj: Record<string, V>): Set<V> {
        if (!obj) return new Set();
        return new Set(Object.values(obj));
    }

    /**
     * Convert object to Set of keys
     * @param obj - Source object
     * @returns Set of object keys
     */
    public static objectKeysToSet(obj: Record<string, any>): Set<string> {
        if (!obj) return new Set();
        return new Set(Object.keys(obj));
    }

    // ============================================================================
    // VALIDATION & CHECKING
    // ============================================================================

    /**
     * Check if collection is empty
     * @param collection - Collection to check (Array, Map, Set, or Object)
     * @returns True if empty
     */
    public static isEmpty(
        collection:
            | any[]
            | Map<any, any>
            | Set<any>
            | Record<string, any>
            | null
            | undefined
    ): boolean {
        if (!collection) return true;

        if (Array.isArray(collection)) {
            return collection.length === 0;
        }
        if (collection instanceof Map || collection instanceof Set) {
            return collection.size === 0;
        }
        if (typeof collection === 'object') {
            return Object.keys(collection).length === 0;
        }

        return true;
    }

    /**
     * Check if collection is not empty
     * @param collection - Collection to check
     * @returns True if not empty
     */
    public static isNotEmpty(
        collection:
            | any[]
            | Map<any, any>
            | Set<any>
            | Record<string, any>
            | null
            | undefined
    ): boolean {
        return !this.isEmpty(collection);
    }

    /**
     * Get size of collection
     * @param collection - Collection to measure
     * @returns Size of collection
     */
    public static size(
        collection:
            | any[]
            | Map<any, any>
            | Set<any>
            | Record<string, any>
            | null
            | undefined
    ): number {
        if (!collection) return 0;

        if (Array.isArray(collection)) {
            return collection.length;
        }
        if (collection instanceof Map || collection instanceof Set) {
            return collection.size;
        }
        if (typeof collection === 'object') {
            return Object.keys(collection).length;
        }

        return 0;
    }

    /**
     * Check if value exists in collection
     * @param collection - Collection to search
     * @param value - Value to find
     * @returns True if value exists
     */
    public static contains<T>(
        collection: T[] | Set<T> | Map<any, T>,
        value: T
    ): boolean {
        if (!collection) return false;

        if (Array.isArray(collection)) {
            return collection.includes(value);
        }
        if (collection instanceof Set) {
            return collection.has(value);
        }
        if (collection instanceof Map) {
            for (const val of collection.values()) {
                if (val === value) return true;
            }
        }

        return false;
    }

    // ============================================================================
    // FILTERING & TRANSFORMATION
    // ============================================================================

    /**
     * Filter Set by predicate
     * @param set - Source set
     * @param predicate - Filter function
     * @returns Filtered set
     */
    public static filterSet<T>(
        set: Set<T>,
        predicate: (value: T) => boolean
    ): Set<T> {
        if (!set || set.size === 0) return new Set();

        const filtered = new Set<T>();
        for (const value of set) {
            if (predicate(value)) {
                filtered.add(value);
            }
        }
        return filtered;
    }

    /**
     * Map Set values
     * @param set - Source set
     * @param mapper - Transform function
     * @returns New set with transformed values
     */
    public static mapSet<T, R>(
        set: Set<T>,
        mapper: (value: T) => R
    ): Set<R> {
        if (!set || set.size === 0) return new Set();

        const mapped = new Set<R>();
        for (const value of set) {
            mapped.add(mapper(value));
        }
        return mapped;
    }

    /**
     * Reduce Set to single value
     * @param set - Source set
     * @param reducer - Reducer function
     * @param initialValue - Initial accumulator value
     * @returns Reduced value
     */
    public static reduceSet<T, R>(
        set: Set<T>,
        reducer: (accumulator: R, value: T) => R,
        initialValue: R
    ): R {
        if (!set || set.size === 0) return initialValue;

        let accumulator = initialValue;
        for (const value of set) {
            accumulator = reducer(accumulator, value);
        }
        return accumulator;
    }

    // ============================================================================
    // ADVANCED OPERATIONS
    // ============================================================================

    /**
     * Cartesian product of multiple arrays
     * @param arrays - Arrays to compute product
     * @returns Array of all combinations
     */
    public static cartesianProduct<T>(...arrays: T[][]): T[][] {
        if (!arrays || arrays.length === 0) return [];
        if (arrays.some(arr => !arr || arr.length === 0)) return [];

        return arrays.reduce(
            (acc, curr) => {
                return acc.flatMap(a => curr.map(b => [...(Array.isArray(a) ? a : [a]), b]));
            },
            [[]] as T[][]
        );
    }

    /**
     * Power set (all subsets) of array
     * @param array - Source array
     * @returns Array of all subsets
     */
    public static powerSet<T>(array: T[]): T[][] {
        if (!array || array.length === 0) return [[]];

        const result: T[][] = [[]];

        for (const item of array) {
            const length = result.length;
            for (let i = 0; i < length; i++) {
                result.push([...result[i], item]);
            }
        }

        return result;
    }

    /**
     * Generate combinations of array elements
     * @param array - Source array
     * @param size - Combination size
     * @returns Array of combinations
     */
    public static combinations<T>(array: T[], size: number): T[][] {
        if (!array || array.length === 0 || size <= 0) return [];
        if (size > array.length) return [];
        if (size === 1) return array.map(item => [item]);

        const result: T[][] = [];

        const combine = (start: number, combo: T[]) => {
            if (combo.length === size) {
                result.push([...combo]);
                return;
            }

            for (let i = start; i < array.length; i++) {
                combo.push(array[i]);
                combine(i + 1, combo);
                combo.pop();
            }
        };

        combine(0, []);
        return result;
    }

    /**
     * Generate permutations of array elements
     * @param array - Source array
     * @param size - Permutation size (optional, defaults to array length)
     * @returns Array of permutations
     */
    public static permutations<T>(array: T[], size?: number): T[][] {
        if (!array || array.length === 0) return [];

        const len = size !== undefined ? size : array.length;
        if (len === 0) return [[]];
        if (len === 1) return array.map(item => [item]);

        const result: T[][] = [];

        const permute = (arr: T[], perm: T[] = []) => {
            if (perm.length === len) {
                result.push([...perm]);
                return;
            }

            for (let i = 0; i < arr.length; i++) {
                const remaining = arr.slice(0, i).concat(arr.slice(i + 1));
                permute(remaining, [...perm, arr[i]]);
            }
        };

        permute(array);
        return result;
    }

    /**
     * Deep clone any collection type
     * @param collection - Collection to clone
     * @returns Deep cloned collection
     */
    public static deepClone<T>(collection: T): T {
        if (collection === null || typeof collection !== 'object') {
            return collection;
        }

        if (collection instanceof Date) {
            return new Date(collection.getTime()) as any;
        }

        if (collection instanceof Array) {
            return collection.map(item => this.deepClone(item)) as any;
        }

        if (collection instanceof Set) {
            const cloned = new Set();
            for (const item of collection) {
                cloned.add(this.deepClone(item));
            }
            return cloned as any;
        }

        if (collection instanceof Map) {
            const cloned = new Map();
            for (const [key, value] of collection.entries()) {
                cloned.set(this.deepClone(key), this.deepClone(value));
            }
            return cloned as any;
        }

        if (typeof collection === 'object') {
            const cloned: any = {};
            for (const key in collection) {
                if (collection.hasOwnProperty(key)) {
                    cloned[key] = this.deepClone((collection as any)[key]);
                }
            }
            return cloned;
        }

        return collection;
    }

    /**
     * Check deep equality of two collections
     * @param coll1 - First collection
     * @param coll2 - Second collection
     * @returns True if deeply equal
     */
    public static deepEquals(coll1: any, coll2: any): boolean {
        if (coll1 === coll2) return true;
        if (coll1 === null || coll2 === null) return false;
        if (typeof coll1 !== typeof coll2) return false;

        if (Array.isArray(coll1) && Array.isArray(coll2)) {
            if (coll1.length !== coll2.length) return false;
            return coll1.every((item, i) => this.deepEquals(item, coll2[i]));
        }

        if (coll1 instanceof Set && coll2 instanceof Set) {
            if (coll1.size !== coll2.size) return false;
            for (const item of coll1) {
                if (!coll2.has(item)) return false;
            }
            return true;
        }

        if (coll1 instanceof Map && coll2 instanceof Map) {
            if (coll1.size !== coll2.size) return false;
            for (const [key, value] of coll1.entries()) {
                if (!coll2.has(key) || !this.deepEquals(value, coll2.get(key))) {
                    return false;
                }
            }
            return true;
        }

        if (typeof coll1 === 'object' && typeof coll2 === 'object') {
            const keys1 = Object.keys(coll1);
            const keys2 = Object.keys(coll2);
            if (keys1.length !== keys2.length) return false;

            return keys1.every(key =>
                this.deepEquals(coll1[key], coll2[key])
            );
        }

        return coll1 === coll2;
    }
}

export default CSCollectionUtility;
