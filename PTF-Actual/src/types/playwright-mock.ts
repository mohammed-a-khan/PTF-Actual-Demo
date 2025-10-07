/**
 * Mock Playwright types for testing when Playwright imports hang
 * This file provides type definitions without actual implementation
 */

export interface Page {
    goto(url: string, options?: any): Promise<any>;
    click(selector: string, options?: any): Promise<void>;
    fill(selector: string, value: string, options?: any): Promise<void>;
    waitForSelector(selector: string, options?: any): Promise<any>;
    screenshot(options?: any): Promise<Buffer>;
    locator(selector: string): Locator;
    close(): Promise<void>;
    evaluate(fn: any, ...args: any[]): Promise<any>;
    url(): string;
    title(): Promise<string>;
}

export interface BrowserContext {
    newPage(): Promise<Page>;
    close(): Promise<void>;
    pages(): Page[];
}

export interface Browser {
    newContext(options?: any): Promise<BrowserContext>;
    close(): Promise<void>;
}

export interface Locator {
    click(options?: any): Promise<void>;
    fill(value: string, options?: any): Promise<void>;
    isVisible(): Promise<boolean>;
    textContent(): Promise<string | null>;
    getAttribute(name: string): Promise<string | null>;
    count(): Promise<number>;
    first(): Locator;
    last(): Locator;
    nth(index: number): Locator;
}

export interface ElementHandle {
    click(options?: any): Promise<void>;
    fill(value: string, options?: any): Promise<void>;
    getAttribute(name: string): Promise<string | null>;
}

export interface Route {
    continue(options?: any): Promise<void>;
    fulfill(options?: any): Promise<void>;
    abort(errorCode?: string): Promise<void>;
}

export interface Request {
    url(): string;
    method(): string;
    headers(): { [key: string]: string };
}

export interface Response {
    status(): number;
    statusText(): string;
    headers(): { [key: string]: string };
    body(): Promise<Buffer>;
}

export interface FrameLocator {
    locator(selector: string): Locator;
}

export interface JSHandle {
    evaluate(fn: any, ...args: any[]): Promise<any>;
    dispose(): Promise<void>;
}

// Export mock test function
export const test = {
    beforeEach: (fn: any) => {},
    afterEach: (fn: any) => {},
    describe: (name: string, fn: any) => {},
    it: (name: string, fn: any) => {},
};