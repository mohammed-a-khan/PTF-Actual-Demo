/**
 * CSAIColumnNormalizer - Database-agnostic column name normalization
 *
 * Handles column name variations across database engines:
 * - Oracle: ORDER_STATUS, ITEM_CODE, CREATED_DATE (UPPERCASE with underscores)
 * - SQL Server: OrderStatus, Item_Code, CreatedDate (MixedCase)
 * - PostgreSQL: order_status, item_code, created_date (lowercase with underscores)
 * - User-friendly: Order Status, Item Code (with spaces)
 *
 * Uses dual-key storage: rows retain original DB column names AND get camelCase aliases.
 * Field lookups use normalized comparison so any column name format resolves correctly.
 *
 * @module ai/step-engine
 */

export class CSAIColumnNormalizer {

    /**
     * Normalize a column name to a canonical lookup key.
     * Strips all spaces, underscores, hyphens → lowercase.
     *
     * "ORDER_STATUS" → "orderstatus"
     * "Order Status" → "orderstatus"
     * "orderStatus"  → "orderstatus"
     * "order-status" → "orderstatus"
     */
    static normalize(name: string): string {
        return name.replace(/[\s_\-]/g, '').toLowerCase();
    }

    /**
     * Get a field value from a row object using normalized lookup.
     * Tries: 1) exact match, 2) normalized match across all keys.
     *
     * Works regardless of whether the row was stored with original
     * DB column names or already normalized.
     */
    static getField(row: Record<string, any>, fieldName: string): any {
        // 1. Exact match (fastest path)
        if (fieldName in row) return row[fieldName];
        // 2. Normalized match
        const target = this.normalize(fieldName);
        for (const key of Object.keys(row)) {
            if (this.normalize(key) === target) return row[key];
        }
        return undefined;
    }

    /**
     * Find the original column key name in a row for a given field reference.
     * Returns the actual key as stored in the object.
     */
    static findOriginalKey(row: Record<string, any>, fieldName: string): string | undefined {
        if (fieldName in row) return fieldName;
        const target = this.normalize(fieldName);
        for (const key of Object.keys(row)) {
            if (this.normalize(key) === target) return key;
        }
        return undefined;
    }

    /**
     * List all available columns (original names) for error messages.
     */
    static getAvailableColumns(row: Record<string, any>): string[] {
        return Object.keys(row);
    }

    /**
     * Normalize an entire row — store BOTH original AND camelCase keys.
     *
     * This is critical: the row retains its original DB column names
     * AND adds camelCase aliases. So a mapping file that references
     * "ORDER_STATUS" (Oracle original) or "orderStatus" (camelCase)
     * or "Order Status" (user-friendly) will ALL find the value,
     * because getField() normalizes on lookup.
     *
     * Input:  { ORDER_STATUS: "ACTIVE", ITEM_CODE: "A123" }
     * Output: { ORDER_STATUS: "ACTIVE", orderStatus: "ACTIVE",
     *           ITEM_CODE: "A123",      itemCode: "A123" }
     */
    static normalizeRow(row: Record<string, any>): Record<string, any> {
        const result: Record<string, any> = {};
        for (const [key, value] of Object.entries(row)) {
            // Keep original key
            result[key] = value;
            // Add camelCase alias if different
            const camel = this.toCamelCase(key);
            if (camel !== key) {
                result[camel] = value;
            }
        }
        return result;
    }

    /**
     * Normalize an array of rows.
     */
    static normalizeRows(rows: Record<string, any>[]): Record<string, any>[] {
        return rows.map(row => this.normalizeRow(row));
    }

    /**
     * Convert any column name format to camelCase.
     * "ORDER_STATUS" → "orderStatus"
     * "Order Status" → "orderStatus"
     * "order-status" → "orderStatus"
     * "order_status" → "orderStatus"
     * "orderStatus"  → "orderStatus" (already camelCase, no change)
     */
    static toCamelCase(name: string): string {
        // Handle ALL_CAPS_WITH_UNDERSCORES → split on underscores
        if (/^[A-Z][A-Z0-9_]*$/.test(name)) {
            return name.toLowerCase().replace(/_(.)/g, (_, c) => c.toUpperCase());
        }
        // Handle spaces, underscores, hyphens as word boundaries
        const result = name
            .replace(/[\s_\-]+(.)/g, (_, c) => c.toUpperCase())
            .replace(/^[A-Z]/, c => c.toLowerCase());
        return result;
    }

    /**
     * Check if a field exists in a row using normalized lookup.
     */
    static hasField(row: Record<string, any>, fieldName: string): boolean {
        return this.getField(row, fieldName) !== undefined;
    }

    /**
     * Set a field value in a row using normalized key lookup.
     * Updates the original key if found, otherwise adds with the given fieldName.
     */
    static setField(row: Record<string, any>, fieldName: string, value: any): void {
        const originalKey = this.findOriginalKey(row, fieldName);
        if (originalKey) {
            row[originalKey] = value;
            // Also update camelCase alias if it exists
            const camel = this.toCamelCase(originalKey);
            if (camel !== originalKey && camel in row) {
                row[camel] = value;
            }
        } else {
            row[fieldName] = value;
        }
    }
}
