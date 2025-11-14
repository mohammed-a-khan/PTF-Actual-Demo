/**
 * Page Boundary Detector - Intelligent Multi-Page Detection
 *
 * This module intelligently detects page boundaries in recorded tests
 * and generates appropriate page names based on:
 * - URL changes (explicit page.goto() calls)
 * - Navigation actions (link clicks, button clicks that navigate)
 * - Action context and intent
 * - URL path analysis and domain terminology
 */

import {
    Action,
    DeepCodeAnalysis,
    IntentAnalysis
} from '../types';

export interface PageBoundary {
    boundaryIndex: number;      // Index in actions array where boundary occurs
    boundaryType: 'explicit' | 'implicit';
    trigger?: Action;           // Action that caused the boundary
    url?: string;              // Target URL if known
    urlPattern?: string;       // URL pattern for matching
}

export interface PageSegment {
    id: string;
    pageName: string;          // Generated page class name
    startIndex: number;        // First action index
    endIndex: number;          // Last action index (exclusive)
    actions: Action[];         // Actions in this page
    url?: string;              // Primary URL for this page
    urlPattern?: string;       // URL pattern
    intent: string;            // Primary intent (login, dashboard, form, etc.)
    confidence: number;        // Confidence in page detection
    triggerAction?: Action;    // Action that triggered this page (link click)
}

export class PageBoundaryDetector {

    /**
     * Detect page boundaries and segment actions into pages
     */
    public detectPages(
        analysis: DeepCodeAnalysis,
        intentAnalysis: IntentAnalysis
    ): PageSegment[] {
        const { actions } = analysis;

        if (actions.length === 0) {
            return [];
        }

        // Step 1: Detect boundaries
        const boundaries = this.detectBoundaries(actions);

        // Step 2: Segment actions into pages
        const segments = this.segmentActions(actions, boundaries);

        // Step 3: Generate intelligent page names
        const namedSegments = this.generatePageNames(segments, intentAnalysis);

        return namedSegments;
    }

    /**
     * Detect page boundaries in actions
     */
    private detectBoundaries(actions: Action[]): PageBoundary[] {
        const boundaries: PageBoundary[] = [];

        for (let i = 0; i < actions.length; i++) {
            const action = actions[i];

            // Explicit boundary: page.goto() calls
            if (action.type === 'navigation' && action.method === 'goto') {
                boundaries.push({
                    boundaryIndex: i,
                    boundaryType: 'explicit',
                    trigger: action,
                    url: action.args[0] as string,
                    urlPattern: this.extractUrlPattern(action.args[0] as string)
                });
                continue;
            }

            // Implicit boundary: Navigation clicks (links, menu items)
            if (this.isNavigationAction(action, actions, i)) {
                const nextNavAction = this.findNextNavigationAction(actions, i + 1);
                boundaries.push({
                    boundaryIndex: i + 1, // Boundary is AFTER the click
                    boundaryType: 'implicit',
                    trigger: action,
                    url: nextNavAction?.args[0] as string,
                    urlPattern: nextNavAction ? this.extractUrlPattern(nextNavAction.args[0] as string) : undefined
                });
            }
        }

        return boundaries;
    }

    /**
     * Check if action is a navigation action (link/menu click)
     */
    private isNavigationAction(action: Action, allActions: Action[], currentIndex: number): boolean {
        if (action.type !== 'click') {
            return false;
        }

        // Check if next action is a navigation (goto)
        const nextAction = allActions[currentIndex + 1];
        if (nextAction?.type === 'navigation' && nextAction?.method === 'goto') {
            return true;
        }

        // STRICT: Only treat link clicks as page boundaries
        // This prevents menuitems, buttons, and other elements from creating false boundaries
        if (action.target?.type === 'getByRole' && action.target?.selector === 'link') {
            return true;
        }

        return false;
    }

    /**
     * Check if element name suggests navigation
     */
    private isLikelyNavigationElement(elementName: string): boolean {
        const lowerName = elementName.toLowerCase();

        // Navigation indicators
        const navKeywords = [
            'menu', 'nav', 'link', 'tab', 'dashboard',
            'home', 'back', 'next', 'go to'
        ];

        // Exclude submit/form actions
        const formKeywords = ['submit', 'save', 'create', 'update', 'delete', 'login', 'sign'];

        const hasNavKeyword = navKeywords.some(kw => lowerName.includes(kw));
        const hasFormKeyword = formKeywords.some(kw => lowerName.includes(kw));

        return hasNavKeyword && !hasFormKeyword;
    }

    /**
     * Extract element name from action
     */
    private extractElementName(action: Action): string {
        if (action.target?.options?.name) {
            return action.target.options.name;
        }

        const expr = action.expression;
        const nameMatch = expr.match(/name:\s*['"]([^'"]+)['"]/);
        if (nameMatch) return nameMatch[1];

        const textMatch = expr.match(/getByText\(['"]([^'"]+)['"]/);
        if (textMatch) return textMatch[1];

        return action.target?.selector || '';
    }

    /**
     * Find next navigation action after given index
     */
    private findNextNavigationAction(actions: Action[], fromIndex: number): Action | null {
        for (let i = fromIndex; i < actions.length; i++) {
            if (actions[i].type === 'navigation') {
                return actions[i];
            }
        }
        return null;
    }

    /**
     * Extract URL pattern (path without query params)
     */
    private extractUrlPattern(url: string): string {
        try {
            const urlObj = new URL(url);
            return urlObj.pathname;
        } catch {
            return url;
        }
    }

    /**
     * Segment actions into pages based on boundaries
     */
    private segmentActions(actions: Action[], boundaries: PageBoundary[]): PageSegment[] {
        const segments: PageSegment[] = [];

        if (boundaries.length === 0) {
            // No boundaries - single page
            segments.push({
                id: 'segment_0',
                pageName: 'Page',  // Temporary name
                startIndex: 0,
                endIndex: actions.length,
                actions: actions,
                url: this.extractUrlFromActions(actions),
                intent: 'generic',
                confidence: 0.5
            });
            return segments;
        }

        // Sort boundaries by index
        const sortedBoundaries = [...boundaries].sort((a, b) => a.boundaryIndex - b.boundaryIndex);

        // Create segments between boundaries
        let startIndex = 0;
        let previousBoundary: PageBoundary | null = null;

        for (let i = 0; i < sortedBoundaries.length; i++) {
            const boundary = sortedBoundaries[i];
            const endIndex = boundary.boundaryIndex;

            if (endIndex > startIndex) {
                const segmentActions = actions.slice(startIndex, endIndex);

                // Get URL from the FIRST action in this segment (which should be the navigation)
                const segmentUrl = this.extractUrlFromActions(segmentActions) || boundary.url;
                const segmentUrlPattern = segmentUrl ? this.extractUrlPattern(segmentUrl) : boundary.urlPattern;

                segments.push({
                    id: `segment_${i}`,
                    pageName: 'Page',  // Temporary name
                    startIndex,
                    endIndex,
                    actions: segmentActions,
                    url: segmentUrl,
                    urlPattern: segmentUrlPattern,
                    intent: 'generic',
                    confidence: 0.7,
                    triggerAction: previousBoundary?.trigger  // Link that was clicked to get here
                });
            }

            previousBoundary = boundary;
            startIndex = endIndex;
        }

        // Last segment (after last boundary)
        if (startIndex < actions.length) {
            const lastSegmentActions = actions.slice(startIndex);
            const segmentUrl = this.extractUrlFromActions(lastSegmentActions);

            segments.push({
                id: `segment_${sortedBoundaries.length}`,
                pageName: 'Page',  // Temporary name
                startIndex,
                endIndex: actions.length,
                actions: lastSegmentActions,
                url: segmentUrl,
                urlPattern: segmentUrl ? this.extractUrlPattern(segmentUrl) : undefined,
                intent: 'generic',
                confidence: 0.7,
                triggerAction: previousBoundary?.trigger  // Link that was clicked to get here
            });
        }

        return segments;
    }

    /**
     * Extract URL from first navigation action in segment
     */
    private extractUrlFromActions(actions: Action[]): string | undefined {
        const navAction = actions.find(a => a.type === 'navigation');
        return navAction?.args[0] as string;
    }

    /**
     * Generate intelligent page names for segments
     */
    private generatePageNames(segments: PageSegment[], intentAnalysis: IntentAnalysis): PageSegment[] {
        return segments.map((segment, index) => {
            // Analyze segment intent
            const intent = this.analyzeSegmentIntent(segment);

            // Generate page name based on URL, actions, and intent
            const pageName = this.generatePageName(segment, intent, index);

            return {
                ...segment,
                pageName,
                intent,
                confidence: this.calculateConfidence(segment, intent)
            };
        });
    }

    /**
     * Analyze intent of actions in segment
     */
    private analyzeSegmentIntent(segment: PageSegment): string {
        const { actions } = segment;

        // Count action types
        const actionCounts = {
            fill: 0,
            click: 0,
            select: 0,
            assertion: 0,
            navigation: 0
        };

        for (const action of actions) {
            if (action.type === 'fill' || action.type === 'type') actionCounts.fill++;
            else if (action.type === 'click') actionCounts.click++;
            else if (action.type === 'select') actionCounts.select++;
            else if (action.type === 'assertion') actionCounts.assertion++;
            else if (action.type === 'navigation') actionCounts.navigation++;
        }

        // Detect authentication pattern
        if (this.hasAuthenticationPattern(actions)) {
            return 'authentication';
        }

        // Detect form pattern
        if (actionCounts.fill > 0 && actionCounts.click > 0) {
            return 'form';
        }

        // Detect dashboard pattern
        if (segment.url && this.isDashboardUrl(segment.url)) {
            return 'dashboard';
        }

        // Detect navigation pattern
        if (actionCounts.click > 0 && actionCounts.fill === 0) {
            return 'navigation';
        }

        // Detect read-only pattern
        if (actionCounts.assertion > 0 && actionCounts.fill === 0 && actionCounts.click === 0) {
            return 'verification';
        }

        return 'generic';
    }

    /**
     * Check if actions contain authentication pattern
     */
    private hasAuthenticationPattern(actions: Action[]): boolean {
        const expressions = actions.map(a => a.expression.toLowerCase()).join(' ');

        const authKeywords = ['username', 'password', 'login', 'sign in', 'email', 'credentials'];
        const hasAuthFields = authKeywords.some(kw => expressions.includes(kw));

        const hasLoginButton = actions.some(a => {
            const elementName = this.extractElementName(a).toLowerCase();
            return a.type === 'click' && (elementName.includes('login') || elementName.includes('sign in'));
        });

        return hasAuthFields && hasLoginButton;
    }

    /**
     * Check if URL is a dashboard
     */
    private isDashboardUrl(url: string): boolean {
        const lowerUrl = url.toLowerCase();
        return lowerUrl.includes('dashboard') ||
               lowerUrl.includes('/home') ||
               lowerUrl.includes('/main');
    }

    /**
     * Generate page class name based on segment analysis
     */
    private generatePageName(segment: PageSegment, intent: string, index: number): string {
        // Strategy 0: Use trigger action (link that was clicked to get to this page)
        if (segment.triggerAction) {
            const triggerName = this.extractElementName(segment.triggerAction);
            if (triggerName && triggerName.length > 0) {
                // Convert link name to page name (e.g., "Admin" -> "AdminPage", "Recruitment" -> "RecruitmentPage")
                const pageName = `${this.toPascalCase(triggerName)}Page`;
                return pageName;
            }
        }

        // Strategy 1: Use URL path
        if (segment.urlPattern) {
            const urlBasedName = this.generateNameFromUrl(segment.urlPattern);
            if (urlBasedName) {
                return urlBasedName;
            }
        }

        // Strategy 2: Use intent
        const intentBasedName = this.generateNameFromIntent(intent, segment);
        if (intentBasedName) {
            return intentBasedName;
        }

        // Strategy 3: Use action analysis
        const actionBasedName = this.generateNameFromActions(segment.actions);
        if (actionBasedName) {
            return actionBasedName;
        }

        // Fallback: Generic name with index
        return `Page${index + 1}`;
    }

    /**
     * Generate page name from URL pattern
     */
    private generateNameFromUrl(urlPattern: string): string | null {
        // Remove leading/trailing slashes
        const cleanPath = urlPattern.replace(/^\/|\/$/g, '');

        if (!cleanPath) {
            return null;
        }

        // Split by slash and get meaningful parts
        const parts = cleanPath.split('/').filter(p => p && !p.match(/^\d+$/)); // Exclude IDs

        if (parts.length === 0) {
            return null;
        }

        // Prioritize meaningful keywords over generic ones
        const meaningfulKeywords = ['dashboard', 'admin', 'auth', 'login', 'profile', 'settings', 'user', 'employee', 'time', 'leave', 'pim'];
        const genericKeywords = ['index', 'main', 'home', 'page'];

        // Find most meaningful part
        let selectedPart = null;

        // First, look for meaningful keywords
        for (const part of parts.reverse()) {
            const lowerPart = part.toLowerCase();
            if (meaningfulKeywords.some(kw => lowerPart.includes(kw))) {
                selectedPart = part;
                break;
            }
        }

        // If no meaningful keyword found, use last non-generic part
        if (!selectedPart) {
            for (const part of parts) {
                const lowerPart = part.toLowerCase();
                if (!genericKeywords.includes(lowerPart) && !lowerPart.match(/php|jsp|html|aspx/)) {
                    selectedPart = part;
                    break;
                }
            }
        }

        // Fallback to last part
        if (!selectedPart) {
            selectedPart = parts[parts.length - 1];
        }

        // Convert to PascalCase
        const pageName = this.toPascalCase(selectedPart);

        // Add "Page" suffix if not already present
        if (!pageName.endsWith('Page')) {
            return `${pageName}Page`;
        }

        return pageName;
    }

    /**
     * Generate page name from intent
     */
    private generateNameFromIntent(intent: string, segment: PageSegment): string | null {
        const intentMap: Record<string, string> = {
            'authentication': 'LoginPage',
            'dashboard': 'DashboardPage',
            'form': 'FormPage',
            'navigation': 'NavigationPage',
            'verification': 'VerificationPage'
        };

        return intentMap[intent] || null;
    }

    /**
     * Generate page name from action analysis
     */
    private generateNameFromActions(actions: Action[]): string | null {
        // Look for dominant entity/context in actions
        const entities = new Set<string>();

        for (const action of actions) {
            const elementName = this.extractElementName(action);
            if (elementName) {
                // Extract meaningful words (capitalized or multi-word)
                const words = elementName.match(/[A-Z][a-z]+/g) || elementName.split(/[\s_-]+/);
                words.forEach(word => {
                    if (word.length > 3 && !this.isCommonWord(word)) {
                        entities.add(word);
                    }
                });
            }
        }

        if (entities.size > 0) {
            const entityName = Array.from(entities)[0]; // Take first entity
            return `${this.toPascalCase(entityName)}Page`;
        }

        return null;
    }

    /**
     * Check if word is too common to be useful
     */
    private isCommonWord(word: string): boolean {
        const common = ['button', 'link', 'input', 'field', 'text', 'form', 'page', 'name', 'label'];
        return common.includes(word.toLowerCase());
    }

    /**
     * Convert string to PascalCase
     */
    private toPascalCase(str: string): string {
        return str
            .split(/[\s_-]+/)
            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join('');
    }

    /**
     * Calculate confidence score for segment detection
     */
    private calculateConfidence(segment: PageSegment, intent: string): number {
        let confidence = 0.5; // Base confidence

        // Increase confidence if we have clear URL
        if (segment.url) {
            confidence += 0.2;
        }

        // Increase confidence if intent is clear
        if (intent !== 'generic') {
            confidence += 0.2;
        }

        // Increase confidence if we have enough actions
        if (segment.actions.length >= 3) {
            confidence += 0.1;
        }

        return Math.min(confidence, 1.0);
    }
}
