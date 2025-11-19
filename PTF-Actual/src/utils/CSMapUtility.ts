/**
 * CSMapUtility - Comprehensive Map Manipulation Utility Class
 *
 * Purpose: Provides static utility methods for advanced Map operations
 * including transformations, filtering, merging, and conversions
 *
 * Features:
 * - Null-safe operations
 * - Type-safe generics
 * - Functional programming patterns
 * - Map/Object interoperability
 * - Advanced map manipulations
 */

export class CSMapUtility {
    /**
     * Create Map from object
     * @param obj - Source object
     * @returns Map with object entries
     */
    public static fromObject<V = any>(obj: Record<string, V>): Map<string, V> {
        if (!obj) return new Map();
        return new Map(Object.entries(obj));
    }

    /**
     * Convert Map to plain object
     * @param map - Source map
     * @returns Plain object
     */
    public static toObject<K extends string | number | symbol, V>(
        map: Map<K, V>
    ): Record<K, V> {
        if (!map || map.size === 0) return {} as Record<K, V>;

        const obj = {} as Record<K, V>;
        for (const [key, value] of map.entries()) {
            obj[key] = value;
        }
        return obj;
    }

    /**
     * Filter map entries by predicate
     * @param map - Source map
     * @param predicate - Filter function
     * @returns Filtered map
     */
    public static filter<K, V>(
        map: Map<K, V>,
        predicate: (value: V, key: K) => boolean
    ): Map<K, V> {
        if (!map || map.size === 0) return new Map();

        const filtered = new Map<K, V>();
        for (const [key, value] of map.entries()) {
            if (predicate(value, key)) {
                filtered.set(key, value);
            }
        }
        return filtered;
    }

    /**
     * Transform map values
     * @param map - Source map
     * @param mapper - Transform function
     * @returns Map with transformed values
     */
    public static map<K, V, R>(
        map: Map<K, V>,
        mapper: (value: V, key: K) => R
    ): Map<K, R> {
        if (!map || map.size === 0) return new Map();

        const result = new Map<K, R>();
        for (const [key, value] of map.entries()) {
            result.set(key, mapper(value, key));
        }
        return result;
    }

    /**
     * Transform map keys
     * @param map - Source map
     * @param mapper - Key transform function
     * @returns Map with transformed keys
     */
    public static mapKeys<K, V, R>(
        map: Map<K, V>,
        mapper: (key: K, value: V) => R
    ): Map<R, V> {
        if (!map || map.size === 0) return new Map();

        const result = new Map<R, V>();
        for (const [key, value] of map.entries()) {
            result.set(mapper(key, value), value);
        }
        return result;
    }

    /**
     * Merge multiple maps (later maps override earlier ones)
     * @param maps - Maps to merge
     * @returns Merged map
     */
    public static merge<K, V>(...maps: Map<K, V>[]): Map<K, V> {
        if (!maps || maps.length === 0) return new Map();

        const merged = new Map<K, V>();
        for (const map of maps) {
            if (map) {
                for (const [key, value] of map.entries()) {
                    merged.set(key, value);
                }
            }
        }
        return merged;
    }

    /**
     * Deep merge multiple maps (recursively merges nested maps/objects)
     * @param maps - Maps to merge
     * @returns Deep merged map
     */
    public static deepMerge<K, V>(...maps: Map<K, V>[]): Map<K, V> {
        if (!maps || maps.length === 0) return new Map();

        const merged = new Map<K, V>();

        for (const map of maps) {
            if (!map) continue;

            for (const [key, value] of map.entries()) {
                const existing = merged.get(key);

                if (existing instanceof Map && value instanceof Map) {
                    merged.set(key, this.deepMerge(existing as any, value as any) as any);
                } else if (
                    typeof existing === 'object' &&
                    typeof value === 'object' &&
                    existing !== null &&
                    value !== null &&
                    !Array.isArray(existing) &&
                    !Array.isArray(value)
                ) {
                    merged.set(key, { ...existing, ...value } as any);
                } else {
                    merged.set(key, value);
                }
            }
        }
        return merged;
    }

    /**
     * Invert map (swap keys and values)
     * @param map - Source map
     * @returns Inverted map
     */
    public static invert<K, V>(map: Map<K, V>): Map<V, K> {
        if (!map || map.size === 0) return new Map();

        const inverted = new Map<V, K>();
        for (const [key, value] of map.entries()) {
            inverted.set(value, key);
        }
        return inverted;
    }

    /**
     * Group map entries by value
     * @param map - Source map
     * @returns Map of arrays grouped by value
     */
    public static groupByValue<K, V>(map: Map<K, V>): Map<V, K[]> {
        if (!map || map.size === 0) return new Map();

        const grouped = new Map<V, K[]>();
        for (const [key, value] of map.entries()) {
            if (!grouped.has(value)) {
                grouped.set(value, []);
            }
            grouped.get(value)!.push(key);
        }
        return grouped;
    }

    /**
     * Pick specific keys from map
     * @param map - Source map
     * @param keys - Keys to pick
     * @returns Map with only specified keys
     */
    public static pick<K, V>(map: Map<K, V>, keys: K[]): Map<K, V> {
        if (!map || map.size === 0 || !keys || keys.length === 0) return new Map();

        const picked = new Map<K, V>();
        for (const key of keys) {
            if (map.has(key)) {
                picked.set(key, map.get(key)!);
            }
        }
        return picked;
    }

    /**
     * Omit specific keys from map
     * @param map - Source map
     * @param keys - Keys to omit
     * @returns Map without specified keys
     */
    public static omit<K, V>(map: Map<K, V>, keys: K[]): Map<K, V> {
        if (!map || map.size === 0) return new Map();
        if (!keys || keys.length === 0) return new Map(map);

        const omitted = new Map(map);
        for (const key of keys) {
            omitted.delete(key);
        }
        return omitted;
    }

    /**
     * Get keys as array
     * @param map - Source map
     * @returns Array of keys
     */
    public static keys<K, V>(map: Map<K, V>): K[] {
        if (!map || map.size === 0) return [];
        return Array.from(map.keys());
    }

    /**
     * Get values as array
     * @param map - Source map
     * @returns Array of values
     */
    public static values<K, V>(map: Map<K, V>): V[] {
        if (!map || map.size === 0) return [];
        return Array.from(map.values());
    }

    /**
     * Get entries as array of [key, value] tuples
     * @param map - Source map
     * @returns Array of entries
     */
    public static entries<K, V>(map: Map<K, V>): [K, V][] {
        if (!map || map.size === 0) return [];
        return Array.from(map.entries());
    }

    /**
     * Check if map is empty
     * @param map - Source map
     * @returns True if empty
     */
    public static isEmpty<K, V>(map: Map<K, V> | null | undefined): boolean {
        return !map || map.size === 0;
    }

    /**
     * Check if map has all specified keys
     * @param map - Source map
     * @param keys - Keys to check
     * @returns True if all keys exist
     */
    public static hasAll<K, V>(map: Map<K, V>, keys: K[]): boolean {
        if (!map || !keys) return false;
        return keys.every(key => map.has(key));
    }

    /**
     * Check if map has any of specified keys
     * @param map - Source map
     * @param keys - Keys to check
     * @returns True if any key exists
     */
    public static hasAny<K, V>(map: Map<K, V>, keys: K[]): boolean {
        if (!map || !keys) return false;
        return keys.some(key => map.has(key));
    }

    /**
     * Find key by value
     * @param map - Source map
     * @param value - Value to find
     * @returns Key or undefined
     */
    public static findKey<K, V>(map: Map<K, V>, value: V): K | undefined {
        if (!map || map.size === 0) return undefined;

        for (const [key, val] of map.entries()) {
            if (val === value) return key;
        }
        return undefined;
    }

    /**
     * Find all keys for a value
     * @param map - Source map
     * @param value - Value to find
     * @returns Array of matching keys
     */
    public static findKeys<K, V>(map: Map<K, V>, value: V): K[] {
        if (!map || map.size === 0) return [];

        const keys: K[] = [];
        for (const [key, val] of map.entries()) {
            if (val === value) keys.push(key);
        }
        return keys;
    }

    /**
     * Get value with default if key doesn't exist
     * @param map - Source map
     * @param key - Key to get
     * @param defaultValue - Default value
     * @returns Value or default
     */
    public static getOrDefault<K, V>(
        map: Map<K, V>,
        key: K,
        defaultValue: V
    ): V {
        if (!map) return defaultValue;
        return map.has(key) ? map.get(key)! : defaultValue;
    }

    /**
     * Count entries matching predicate
     * @param map - Source map
     * @param predicate - Count condition
     * @returns Number of matching entries
     */
    public static count<K, V>(
        map: Map<K, V>,
        predicate: (value: V, key: K) => boolean
    ): number {
        if (!map || map.size === 0) return 0;

        let count = 0;
        for (const [key, value] of map.entries()) {
            if (predicate(value, key)) count++;
        }
        return count;
    }

    /**
     * Check if every entry matches predicate
     * @param map - Source map
     * @param predicate - Test function
     * @returns True if all entries match
     */
    public static every<K, V>(
        map: Map<K, V>,
        predicate: (value: V, key: K) => boolean
    ): boolean {
        if (!map || map.size === 0) return true;

        for (const [key, value] of map.entries()) {
            if (!predicate(value, key)) return false;
        }
        return true;
    }

    /**
     * Check if any entry matches predicate
     * @param map - Source map
     * @param predicate - Test function
     * @returns True if any entry matches
     */
    public static some<K, V>(
        map: Map<K, V>,
        predicate: (value: V, key: K) => boolean
    ): boolean {
        if (!map || map.size === 0) return false;

        for (const [key, value] of map.entries()) {
            if (predicate(value, key)) return true;
        }
        return false;
    }

    /**
     * Reduce map to single value
     * @param map - Source map
     * @param reducer - Reducer function
     * @param initialValue - Initial accumulator value
     * @returns Reduced value
     */
    public static reduce<K, V, R>(
        map: Map<K, V>,
        reducer: (accumulator: R, value: V, key: K) => R,
        initialValue: R
    ): R {
        if (!map || map.size === 0) return initialValue;

        let accumulator = initialValue;
        for (const [key, value] of map.entries()) {
            accumulator = reducer(accumulator, value, key);
        }
        return accumulator;
    }

    /**
     * Clone map (shallow copy)
     * @param map - Source map
     * @returns Cloned map
     */
    public static clone<K, V>(map: Map<K, V>): Map<K, V> {
        if (!map) return new Map();
        return new Map(map);
    }

    /**
     * Deep clone map (recursive copy)
     * @param map - Source map
     * @returns Deep cloned map
     */
    public static deepClone<K, V>(map: Map<K, V>): Map<K, V> {
        if (!map) return new Map();

        const cloned = new Map<K, V>();
        for (const [key, value] of map.entries()) {
            if (value instanceof Map) {
                cloned.set(key, this.deepClone(value as any) as any);
            } else if (Array.isArray(value)) {
                cloned.set(key, [...value] as any);
            } else if (typeof value === 'object' && value !== null) {
                cloned.set(key, { ...value } as any);
            } else {
                cloned.set(key, value);
            }
        }
        return cloned;
    }

    /**
     * Check if two maps are equal (shallow comparison)
     * @param map1 - First map
     * @param map2 - Second map
     * @returns True if maps are equal
     */
    public static equals<K, V>(map1: Map<K, V>, map2: Map<K, V>): boolean {
        if (map1 === map2) return true;
        if (!map1 || !map2) return false;
        if (map1.size !== map2.size) return false;

        for (const [key, value] of map1.entries()) {
            if (!map2.has(key) || map2.get(key) !== value) {
                return false;
            }
        }
        return true;
    }

    /**
     * Partition map into two maps based on predicate
     * @param map - Source map
     * @param predicate - Partition function
     * @returns Tuple of [matching, non-matching] maps
     */
    public static partition<K, V>(
        map: Map<K, V>,
        predicate: (value: V, key: K) => boolean
    ): [Map<K, V>, Map<K, V>] {
        if (!map || map.size === 0) return [new Map(), new Map()];

        const truthy = new Map<K, V>();
        const falsy = new Map<K, V>();

        for (const [key, value] of map.entries()) {
            if (predicate(value, key)) {
                truthy.set(key, value);
            } else {
                falsy.set(key, value);
            }
        }

        return [truthy, falsy];
    }
}

export default CSMapUtility;
