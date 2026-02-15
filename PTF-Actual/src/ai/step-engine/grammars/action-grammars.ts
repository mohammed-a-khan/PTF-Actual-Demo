/**
 * Action Grammar Rules
 *
 * ~20 grammar rules for action intents: click, type, select, check, hover, etc.
 * Each rule extracts target element and parameters from natural language instructions.
 *
 * Patterns use __QUOTED_N__ placeholders where quoted strings were extracted.
 */

import { GrammarRule } from '../CSAIStepTypes';

/** Helper to resolve a quoted placeholder back to its value */
function resolveQuoted(text: string, quotedStrings: string[]): string {
    return text.replace(/__QUOTED_(\d+)__/g, (_, idx) => quotedStrings[parseInt(idx)] || '');
}

/** Helper to extract element type from target text */
function inferElementType(text: string): string | undefined {
    const lower = text.toLowerCase().trim();
    const typeKeywords: Record<string, string> = {
        'button': 'button', 'btn': 'button',
        'link': 'link', 'hyperlink': 'link',
        'input': 'input', 'field': 'input', 'textbox': 'input', 'text box': 'input',
        'checkbox': 'checkbox', 'check box': 'checkbox',
        'radio': 'radio', 'radio button': 'radio',
        'dropdown': 'dropdown', 'drop-down': 'dropdown', 'select': 'dropdown', 'combobox': 'dropdown',
        'tab': 'tab',
        'menu item': 'menuitem', 'menuitem': 'menuitem',
        'menu': 'menu',
        'heading': 'heading', 'header': 'heading',
        'icon': 'image',
        'image': 'image',
        'switch': 'switch', 'toggle': 'switch',
        'slider': 'slider'
    };

    // Check multi-word types first (longer matches take priority)
    const multiWord = ['menu item', 'radio button', 'check box', 'text box', 'drop-down'];
    for (const mw of multiWord) {
        if (lower.includes(mw)) return typeKeywords[mw];
    }

    // Then check single-word types at word boundary
    for (const [keyword, type] of Object.entries(typeKeywords)) {
        if (!keyword.includes(' ')) {
            const regex = new RegExp(`\\b${keyword}\\b`, 'i');
            if (regex.test(lower)) return type;
        }
    }

    return undefined;
}

/** Strip trailing element type words from target text for cleaner descriptors */
function stripElementType(text: string): string {
    // Iteratively strip — handles "input field", "data table", etc.
    let result = text;
    const typeWords = /\s+(?:button|btn|link|field|input|textbox|checkbox|radio|dropdown|tab|menu\s*item|heading|header|icon|image|switch|toggle|slider|table|grid)$/i;
    for (let i = 0; i < 3; i++) {
        const stripped = result.replace(typeWords, '').trim();
        if (stripped === result) break;
        result = stripped;
    }
    return result;
}

export const ACTION_GRAMMAR_RULES: GrammarRule[] = [
    // ========================================================================
    // TABLE ROW-SCOPED ACTIONS (Priority 5-9)
    // Must be checked BEFORE basic actions to capture the row/table context
    // ========================================================================
    {
        id: 'action-table-type',
        pattern: /^(?:type|enter|fill|input|write)\s+__QUOTED_(\d+)__\s+(?:in|into)\s+(?:the\s+)?(.+?)\s+(?:at|in|on)\s+row\s+(?:number\s+)?(\d+)\s+(?:in|of)\s+(?:the\s+)?(.+?)$/i,
        category: 'action',
        intent: 'fill',
        priority: 5,
        extract: (match, quotedStrings) => {
            const value = quotedStrings[parseInt(match[1])] || '';
            const raw = resolveQuoted(match[2], quotedStrings).trim();
            const rowIndex = parseInt(match[3]);
            const tableRef = resolveQuoted(match[4], quotedStrings).trim();
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw) || 'input',
                value,
                params: { rowIndex, tableRef: stripElementType(tableRef) }
            };
        },
        examples: [
            "Type '1000' in the 'Amount' input field at row number 1 in the Balances table",
            "Enter '500' in the 'Quantity' field at row 2 in the Orders table"
        ]
    },
    {
        id: 'action-table-clear',
        pattern: /^(?:clear|empty|erase)\s+(?:the\s+)?(?:text\s+in\s+)?(?:the\s+)?(.+?)\s+(?:at|in|on)\s+row\s+(?:number\s+)?(\d+)\s+(?:in|of)\s+(?:the\s+)?(.+?)$/i,
        category: 'action',
        intent: 'clear',
        priority: 6,
        extract: (match, quotedStrings) => {
            const raw = resolveQuoted(match[1], quotedStrings).trim();
            const rowIndex = parseInt(match[2]);
            const tableRef = resolveQuoted(match[3], quotedStrings).trim();
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw) || 'input',
                params: { rowIndex, tableRef: stripElementType(tableRef) }
            };
        },
        examples: [
            "Clear the text in the 'Amount' input field at row number 1 in the Balances table",
            "Clear the 'Quantity' field at row 2 in the Orders table"
        ]
    },
    {
        id: 'action-table-click',
        pattern: /^click\s+(?:on\s+)?(?:the\s+)?(.+?)\s+(?:at|in|on)\s+row\s+(?:number\s+)?(\d+)\s+(?:in|of)\s+(?:the\s+)?(.+?)$/i,
        category: 'action',
        intent: 'click',
        priority: 7,
        extract: (match, quotedStrings) => {
            const raw = resolveQuoted(match[1], quotedStrings).trim();
            const rowIndex = parseInt(match[2]);
            const tableRef = resolveQuoted(match[3], quotedStrings).trim();
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw),
                params: { rowIndex, tableRef: stripElementType(tableRef) }
            };
        },
        examples: [
            "Click the 'Update' button at row number 1 in the Balances table",
            "Click the 'Delete' link at row 3 in the Orders table"
        ]
    },
    {
        id: 'action-table-select',
        pattern: /^(?:select|pick|choose)\s+(?:the\s+)?(?:option\s+)?__QUOTED_(\d+)__\s+(?:option\s+)?(?:from|in)\s+(?:the\s+)?(.+?)\s+(?:at|in|on)\s+row\s+(?:number\s+)?(\d+)\s+(?:in|of)\s+(?:the\s+)?(.+?)$/i,
        category: 'action',
        intent: 'select',
        priority: 8,
        extract: (match, quotedStrings) => {
            const value = quotedStrings[parseInt(match[1])] || '';
            const raw = resolveQuoted(match[2], quotedStrings).trim();
            const rowIndex = parseInt(match[3]);
            const tableRef = resolveQuoted(match[4], quotedStrings).trim();
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw) || 'dropdown',
                value,
                params: { rowIndex, tableRef: stripElementType(tableRef) }
            };
        },
        examples: [
            "Select 'USD' from the 'Currency' dropdown at row 1 in the Payments table"
        ]
    },

    // ========================================================================
    // CLICK ACTIONS (Priority 10-19)
    // ========================================================================
    {
        id: 'action-click-basic',
        pattern: /^click\s+(?:on\s+)?(?:the\s+)?(.+?)$/i,
        category: 'action',
        intent: 'click',
        priority: 10,
        extract: (match, quotedStrings) => {
            const raw = resolveQuoted(match[1], quotedStrings).trim();
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw)
            };
        },
        examples: [
            'Click the Login button',
            'Click on Submit',
            'Click the "Save Changes" link'
        ]
    },
    {
        id: 'action-double-click',
        pattern: /^double[\s-]?click\s+(?:on\s+)?(?:the\s+)?(.+?)$/i,
        category: 'action',
        intent: 'double-click',
        priority: 11,
        extract: (match, quotedStrings) => {
            const raw = resolveQuoted(match[1], quotedStrings).trim();
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw)
            };
        },
        examples: ['Double click on the row', 'Double-click the cell']
    },
    {
        id: 'action-right-click',
        pattern: /^right[\s-]?click\s+(?:on\s+)?(?:the\s+)?(.+?)$/i,
        category: 'action',
        intent: 'right-click',
        priority: 12,
        extract: (match, quotedStrings) => {
            const raw = resolveQuoted(match[1], quotedStrings).trim();
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw)
            };
        },
        examples: ['Right click on the item', 'Right-click the row']
    },

    // ========================================================================
    // TYPE / FILL ACTIONS (Priority 20-29)
    // ========================================================================
    {
        id: 'action-type-value-in-target',
        pattern: /^(?:type|enter|fill|input|write)\s+__QUOTED_(\d+)__\s+(?:in|into|on)\s+(?:the\s+)?(.+?)$/i,
        category: 'action',
        intent: 'fill',
        priority: 20,
        extract: (match, quotedStrings) => {
            const value = quotedStrings[parseInt(match[1])] || '';
            const raw = resolveQuoted(match[2], quotedStrings).trim();
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw) || 'input',
                value
            };
        },
        examples: [
            "Type 'admin@test.com' in the Email field",
            "Enter 'password123' into the Password input",
            "Fill 'John' in the First Name field"
        ]
    },
    {
        id: 'action-type-in-target-value',
        pattern: /^(?:type|enter|fill|input|write)\s+(?:in|into)\s+(?:the\s+)?(.+?)\s+(?:the\s+)?(?:value|text)\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'fill',
        priority: 21,
        extract: (match, quotedStrings) => {
            const raw = resolveQuoted(match[1], quotedStrings).trim();
            const value = quotedStrings[parseInt(match[2])] || '';
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw) || 'input',
                value
            };
        },
        examples: ["Type in the search field the value 'test query'"]
    },
    {
        id: 'action-type-target-with-value',
        pattern: /^(?:type|enter|fill|input|write)\s+(?:the\s+)?(.+?)\s+(?:with|as)\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'fill',
        priority: 22,
        extract: (match, quotedStrings) => {
            const raw = resolveQuoted(match[1], quotedStrings).trim();
            const value = quotedStrings[parseInt(match[2])] || '';
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw) || 'input',
                value
            };
        },
        examples: ["Fill the Username field with 'admin'"]
    },
    {
        id: 'action-clear-field',
        // Exclude clear session/storage/cookies patterns so they match browser grammars instead
        pattern: /^(?:clear|empty|erase)\s+(?:the\s+)?(?!(?:browser\s+)?(?:session|context|cookies?|local\s+storage|session\s+storage|all\s+storage|storage)\b)(.+?)$/i,
        category: 'action',
        intent: 'clear',
        priority: 25,
        extract: (match, quotedStrings) => {
            const raw = resolveQuoted(match[1], quotedStrings).trim();
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw) || 'input'
            };
        },
        examples: ['Clear the search field', 'Clear the Email input']
    },

    // ========================================================================
    // SELECT ACTIONS (Priority 30-39)
    // ========================================================================
    {
        id: 'action-select-option-from',
        pattern: /^(?:select|pick|choose)\s+(?:the\s+)?(?:option\s+)?__QUOTED_(\d+)__\s+(?:option\s+)?(?:from|in)\s+(?:the\s+)?(.+?)$/i,
        category: 'action',
        intent: 'select',
        priority: 30,
        extract: (match, quotedStrings) => {
            const value = quotedStrings[parseInt(match[1])] || '';
            const raw = resolveQuoted(match[2], quotedStrings).trim();
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw) || 'dropdown',
                value
            };
        },
        examples: [
            "Select 'Admin' from the Role dropdown",
            "Choose 'USD' from the Currency select",
            "Pick 'Option 1' from the dropdown",
            "Select 'Q1-2025' option from the Period dropdown"
        ]
    },
    {
        id: 'action-select-option-in',
        pattern: /^(?:select|pick|choose)\s+(?:the\s+)?(?:option\s+)?__QUOTED_(\d+)__\s+(?:option\s+)?(?:in|on)\s+(?:the\s+)?(.+?)$/i,
        category: 'action',
        intent: 'select',
        priority: 31,
        extract: (match, quotedStrings) => {
            const value = quotedStrings[parseInt(match[1])] || '';
            const raw = resolveQuoted(match[2], quotedStrings).trim();
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw) || 'dropdown',
                value
            };
        },
        examples: ["Select the option 'Yes' in the Confirmation dropdown"]
    },

    // ========================================================================
    // CHECK / UNCHECK ACTIONS (Priority 40-49)
    // ========================================================================
    {
        id: 'action-check',
        // Negative lookahead prevents matching assertion patterns:
        //   "Check if/that/whether..." (explicit assertion keywords)
        //   "Check 'X' is displayed/shown/visible..." (value-in-field assertions)
        // Priority 125 ensures assertion rules (100-124) are tried first
        pattern: /^(?:check|mark|tick)\s+(?:the\s+)?(?!(?:if|that|whether)\b)(?!__QUOTED_\d+__\s+(?:is\s+)?(?:displayed|shown|visible|present|available)\b)(.+?)(?:\s+checkbox)?$/i,
        category: 'action',
        intent: 'check',
        priority: 125,
        extract: (match, quotedStrings) => {
            const raw = resolveQuoted(match[1], quotedStrings).trim();
            return {
                targetText: stripElementType(raw),
                elementType: 'checkbox'
            };
        },
        examples: ['Check the "Remember Me" checkbox', 'Check the Terms checkbox', 'Tick the agreement']
    },
    {
        id: 'action-uncheck',
        pattern: /^(?:uncheck|untick|unmark|deselect)\s+(?:the\s+)?(.+?)(?:\s+checkbox)?$/i,
        category: 'action',
        intent: 'uncheck',
        priority: 126,
        extract: (match, quotedStrings) => {
            const raw = resolveQuoted(match[1], quotedStrings).trim();
            return {
                targetText: stripElementType(raw),
                elementType: 'checkbox'
            };
        },
        examples: ['Uncheck the "Remember Me" checkbox', 'Untick the newsletter']
    },
    {
        id: 'action-toggle',
        pattern: /^toggle\s+(?:the\s+)?(.+?)(?:\s+(?:switch|toggle))?$/i,
        category: 'action',
        intent: 'toggle',
        priority: 127,
        extract: (match, quotedStrings) => {
            const raw = resolveQuoted(match[1], quotedStrings).trim();
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw) || 'switch'
            };
        },
        examples: ['Toggle the Dark Mode switch', 'Toggle notifications']
    },

    // ========================================================================
    // HOVER / SCROLL / FOCUS ACTIONS (Priority 50-59)
    // ========================================================================
    {
        id: 'action-hover',
        pattern: /^(?:hover|mouse\s*over)\s+(?:over\s+)?(?:the\s+)?(.+?)$/i,
        category: 'action',
        intent: 'hover',
        priority: 50,
        extract: (match, quotedStrings) => {
            const raw = resolveQuoted(match[1], quotedStrings).trim();
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw)
            };
        },
        examples: ['Hover over the Profile menu', 'Hover the Settings icon', 'Mouse over the tooltip trigger']
    },
    {
        id: 'action-scroll-to',
        pattern: /^scroll\s+(?:to|until)\s+(?:the\s+)?(.+?)(?:\s+is\s+visible)?$/i,
        category: 'action',
        intent: 'scroll-to',
        priority: 51,
        extract: (match, quotedStrings) => {
            const raw = resolveQuoted(match[1], quotedStrings).trim();
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw)
            };
        },
        examples: ['Scroll to the footer', 'Scroll until the Submit button is visible']
    },
    {
        id: 'action-scroll-direction',
        pattern: /^scroll\s+(up|down|left|right)(?:\s+(?:the\s+)?(.+?))?$/i,
        category: 'action',
        intent: 'scroll',
        priority: 52,
        extract: (match, quotedStrings) => {
            const direction = match[1].toLowerCase();
            const raw = match[2] ? resolveQuoted(match[2], quotedStrings).trim() : 'page';
            return {
                targetText: raw,
                elementType: inferElementType(raw),
                params: { value: direction }
            };
        },
        examples: ['Scroll down', 'Scroll up the list', 'Scroll down the page']
    },
    {
        id: 'action-focus',
        pattern: /^(?:focus|set\s+focus)\s+(?:on\s+)?(?:the\s+)?(.+?)$/i,
        category: 'action',
        intent: 'focus',
        priority: 55,
        extract: (match, quotedStrings) => {
            const raw = resolveQuoted(match[1], quotedStrings).trim();
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw)
            };
        },
        examples: ['Focus on the Email field', 'Set focus to the search input']
    },

    // ========================================================================
    // KEYBOARD ACTIONS (Priority 60-69)
    // ========================================================================
    {
        id: 'action-press-key',
        pattern: /^press\s+(?:the\s+)?(?:key\s+)?(.+?)(?:\s+key)?$/i,
        category: 'action',
        intent: 'press-key',
        priority: 61,
        extract: (match, quotedStrings) => {
            const key = resolveQuoted(match[1], quotedStrings).trim();
            return {
                targetText: '',
                params: { key }
            };
        },
        examples: ['Press Enter', 'Press the Tab key', 'Press Escape']
    },
    {
        id: 'action-press-key-on',
        pattern: /^press\s+(?:the\s+)?(.+?)\s+(?:key\s+)?(?:on|in)\s+(?:the\s+)?(.+?)$/i,
        category: 'action',
        intent: 'press-key',
        priority: 60,
        extract: (match, quotedStrings) => {
            const key = resolveQuoted(match[1], quotedStrings).trim();
            const raw = resolveQuoted(match[2], quotedStrings).trim();
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw),
                params: { key }
            };
        },
        examples: ['Press Enter on the search field', 'Press Tab on the username input']
    },

    // ========================================================================
    // UPLOAD / DRAG ACTIONS (Priority 70-79)
    // ========================================================================
    {
        id: 'action-upload',
        pattern: /^upload\s+(?:the\s+)?(?:file\s+)?__QUOTED_(\d+)__\s+(?:to|in|on)\s+(?:the\s+)?(.+?)$/i,
        category: 'action',
        intent: 'upload',
        priority: 70,
        extract: (match, quotedStrings) => {
            const filePath = quotedStrings[parseInt(match[1])] || '';
            const raw = resolveQuoted(match[2], quotedStrings).trim();
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw) || 'button',
                params: { filePath }
            };
        },
        examples: ["Upload the file 'test.pdf' to the file input"]
    },
    {
        id: 'action-upload-multiple',
        pattern: /^upload\s+files?\s+__QUOTED_(\d+)__\s+(?:to|in|on)\s+(?:the\s+)?(.+?)$/i,
        category: 'action',
        intent: 'upload',
        priority: 71,
        extract: (match, quotedStrings) => {
            const filePaths = quotedStrings[parseInt(match[1])] || '';
            const raw = resolveQuoted(match[2], quotedStrings).trim();
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw) || 'button',
                params: { filePath: filePaths }
            };
        },
        examples: [
            "Upload files 'doc1.pdf, doc2.pdf, doc3.pdf' to the file input",
            "Upload files 'report.xlsx, data.csv' to the upload area"
        ]
    },
    {
        id: 'action-drag-to',
        pattern: /^drag\s+(?:the\s+)?(.+?)\s+(?:to|onto|into)\s+(?:the\s+)?(.+?)$/i,
        category: 'action',
        intent: 'drag',
        priority: 72,
        extract: (match, quotedStrings) => {
            const source = resolveQuoted(match[1], quotedStrings).trim();
            const target = resolveQuoted(match[2], quotedStrings).trim();
            return {
                targetText: stripElementType(source),
                elementType: inferElementType(source),
                params: { dragTarget: target }
            };
        },
        examples: ['Drag the card to the Done column', 'Drag Item 1 onto the trash']
    },

    // ========================================================================
    // WAIT ACTIONS (Priority 80-89)
    // ========================================================================
    {
        id: 'action-wait-for-element',
        pattern: /^wait\s+(?:for\s+)?(?:the\s+)?(.+?)\s+(?:to\s+)?(?:be\s+)?(?:visible|displayed|shown|appear)$/i,
        category: 'action',
        intent: 'wait-for',
        priority: 80,
        extract: (match, quotedStrings) => {
            const raw = resolveQuoted(match[1], quotedStrings).trim();
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw)
            };
        },
        examples: ['Wait for the loading spinner to be visible', 'Wait for the dashboard to appear']
    },
    {
        id: 'action-wait-for-element-gone',
        pattern: /^wait\s+(?:for\s+)?(?:the\s+)?(.+?)\s+(?:to\s+)?(?:be\s+)?(?:hidden|gone|disappear|removed)$/i,
        category: 'action',
        intent: 'wait-for',
        priority: 81,
        extract: (match, quotedStrings) => {
            const raw = resolveQuoted(match[1], quotedStrings).trim();
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw),
                modifiers: { negated: true }
            };
        },
        examples: ['Wait for the spinner to disappear', 'Wait for the loading to be hidden']
    },

    // ========================================================================
    // ENHANCED WAIT ACTIONS (Priority 82-87) - Phase 1
    // ========================================================================
    {
        id: 'action-wait-seconds',
        pattern: /^(?:wait|pause)\s+(?:for\s+)?(\d+)\s*(seconds?|secs?|milliseconds?|ms)$/i,
        category: 'action',
        intent: 'wait-seconds',
        priority: 82,
        extract: (match) => {
            const amount = parseInt(match[1]);
            const unit = match[2].toLowerCase();
            const ms = unit.startsWith('ms') || unit.startsWith('millis') ? amount : amount * 1000;
            return {
                targetText: '',
                params: { timeout: ms }
            };
        },
        examples: [
            'Wait 5 seconds',
            'Pause for 3 seconds',
            'Wait 500 milliseconds',
            'Wait 2 secs'
        ]
    },
    {
        id: 'action-wait-url-contain',
        pattern: /^wait\s+(?:for\s+)?(?:the\s+)?url\s+to\s+(?:contain|include|have)\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'wait-url-change',
        priority: 83,
        extract: (match, quotedStrings) => {
            const urlPattern = quotedStrings[parseInt(match[1])] || '';
            return {
                targetText: '',
                params: { url: urlPattern }
            };
        },
        examples: [
            "Wait for URL to contain '/dashboard'",
            "Wait for the URL to include '/home'"
        ]
    },
    {
        id: 'action-wait-url-change',
        pattern: /^wait\s+(?:for\s+)?(?:the\s+)?url\s+to\s+change$/i,
        category: 'action',
        intent: 'wait-url-change',
        priority: 84,
        extract: () => {
            return {
                targetText: '',
                params: {}
            };
        },
        examples: ['Wait for the URL to change', 'Wait for URL to change']
    },
    {
        id: 'action-wait-text-to-be',
        pattern: /^wait\s+(?:for\s+)?(?:the\s+)?(.+?)\s+(?:text\s+)?to\s+(?:be|equal|show|read)\s+__QUOTED_(\d+)__$/i,
        category: 'action',
        intent: 'wait-text-change',
        priority: 85,
        extract: (match, quotedStrings) => {
            const raw = resolveQuoted(match[1], quotedStrings).trim();
            const expectedText = quotedStrings[parseInt(match[2])] || '';
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw),
                expectedValue: expectedText
            };
        },
        examples: [
            "Wait for the heading text to be 'Welcome'",
            "Wait for the status to show 'Complete'"
        ]
    },
    {
        id: 'action-wait-text-change',
        pattern: /^wait\s+(?:for\s+)?(?:the\s+)?(.+?)\s+(?:text\s+)?to\s+change$/i,
        category: 'action',
        intent: 'wait-text-change',
        priority: 86,
        extract: (match, quotedStrings) => {
            const raw = resolveQuoted(match[1], quotedStrings).trim();
            return {
                targetText: stripElementType(raw),
                elementType: inferElementType(raw)
            };
        },
        examples: [
            'Wait for the status text to change',
            'Wait for the counter to change'
        ]
    },

    // ========================================================================
    // PAGE LOAD STATE WAITS (Priority 87-89)
    // ========================================================================
    {
        id: 'action-wait-domcontentloaded',
        pattern: /^wait\s+(?:for\s+)?(?:the\s+)?(?:dom\s+content\s+loaded|domcontentloaded|dom\s+(?:to\s+)?(?:be\s+)?(?:loaded|ready))$/i,
        category: 'action',
        intent: 'wait-page-load',
        priority: 87,
        extract: () => ({
            targetText: '',
            params: { loadState: 'domcontentloaded' }
        }),
        examples: [
            'Wait for DOM content loaded',
            'Wait for domcontentloaded',
            'Wait for DOM to be loaded',
            'Wait for DOM ready'
        ]
    },
    {
        id: 'action-wait-page-load',
        pattern: /^wait\s+(?:for\s+)?(?:the\s+)?(?:page\s+(?:to\s+)?(?:be\s+)?(?:loaded|load|complete|ready)|full\s+page\s+load|page\s+load\s+complete)$/i,
        category: 'action',
        intent: 'wait-page-load',
        priority: 88,
        extract: () => ({
            targetText: '',
            params: { loadState: 'load' }
        }),
        examples: [
            'Wait for page to load',
            'Wait for the page to be loaded',
            'Wait for page load complete',
            'Wait for page to be ready'
        ]
    },
    {
        id: 'action-wait-network-idle',
        pattern: /^wait\s+(?:for\s+)?(?:the\s+)?(?:network\s+(?:to\s+)?(?:be\s+)?idle|network\s*idle|no\s+(?:more\s+)?network\s+(?:activity|requests))$/i,
        category: 'action',
        intent: 'wait-page-load',
        priority: 89,
        extract: () => ({
            targetText: '',
            params: { loadState: 'networkidle' }
        }),
        examples: [
            'Wait for network idle',
            'Wait for network to be idle',
            'Wait for no more network activity',
            'Wait for no network requests'
        ]
    },

    // ========================================================================
    // KEY COMBINATIONS (Priority 62-67) - Phase 3
    // ========================================================================
    {
        id: 'action-press-key-combo',
        pattern: /^press\s+((?:ctrl|control|alt|shift|meta|cmd|command)(?:\s*\+\s*(?:ctrl|control|alt|shift|meta|cmd|command|[a-z0-9]))+)(?:\s+(?:on|in)\s+(?:the\s+)?(.+?))?$/i,
        category: 'action',
        intent: 'press-key',
        priority: 62,
        extract: (match, quotedStrings) => {
            const combo = match[1].trim();
            const raw = match[2] ? resolveQuoted(match[2], quotedStrings).trim() : '';
            return {
                targetText: raw ? stripElementType(raw) : '',
                elementType: raw ? inferElementType(raw) : undefined,
                params: { key: combo }
            };
        },
        examples: [
            'Press Ctrl+A',
            'Press Control+Shift+Delete',
            "Press Ctrl+C on the text field"
        ]
    },
    {
        id: 'action-select-all-text',
        pattern: /^select\s+all\s+(?:text|content)$/i,
        category: 'action',
        intent: 'press-key',
        priority: 63,
        extract: () => ({
            targetText: '',
            params: { key: 'Control+a' }
        }),
        examples: ['Select all text', 'Select all content']
    },
    {
        id: 'action-copy-text',
        pattern: /^copy(?:\s+(?:the\s+)?(?:text|content|selection))?$/i,
        category: 'action',
        intent: 'press-key',
        priority: 64,
        extract: () => ({
            targetText: '',
            params: { key: 'Control+c' }
        }),
        examples: ['Copy', 'Copy the text', 'Copy the selection']
    },
    {
        id: 'action-paste',
        pattern: /^paste(?:\s+(?:the\s+)?(?:text|content|clipboard))?$/i,
        category: 'action',
        intent: 'press-key',
        priority: 65,
        extract: () => ({
            targetText: '',
            params: { key: 'Control+v' }
        }),
        examples: ['Paste', 'Paste the text', 'Paste the clipboard']
    },
    {
        id: 'action-cut',
        pattern: /^cut(?:\s+(?:the\s+)?(?:text|content|selection))?$/i,
        category: 'action',
        intent: 'press-key',
        priority: 66,
        extract: () => ({
            targetText: '',
            params: { key: 'Control+x' }
        }),
        examples: ['Cut', 'Cut the text', 'Cut the selection']
    },
    {
        id: 'action-undo',
        pattern: /^undo$/i,
        category: 'action',
        intent: 'press-key',
        priority: 67,
        extract: () => ({
            targetText: '',
            params: { key: 'Control+z' }
        }),
        examples: ['Undo']
    },
    {
        id: 'action-redo',
        pattern: /^redo$/i,
        category: 'action',
        intent: 'press-key',
        priority: 68,
        extract: () => ({
            targetText: '',
            params: { key: 'Control+y' }
        }),
        examples: ['Redo']
    }
];
