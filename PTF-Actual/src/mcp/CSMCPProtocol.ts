/**
 * PTF-ADO MCP Protocol Handler
 * Implements JSON-RPC 2.0 over stdio for Model Context Protocol
 * Zero-dependency implementation using only Node.js built-ins
 *
 * @module CSMCPProtocol
 */

import { createInterface, Interface as ReadlineInterface } from 'readline';
import {
    JsonRpcRequest,
    JsonRpcResponse,
    JsonRpcError,
    JsonRpcNotification,
    JSON_RPC_ERRORS,
    MCPNotification,
    MCPLogLevel,
    MCPLogMessage,
    MCP_NOTIFICATIONS,
} from './types/CSMCPTypes';

// ============================================================================
// Types
// ============================================================================

export type MessageHandler = (request: JsonRpcRequest, abortSignal?: AbortSignal) => Promise<unknown>;
export type NotificationHandler = (notification: JsonRpcNotification) => void;

export interface PendingRequest {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
}

// ============================================================================
// MCP Protocol Handler Class
// ============================================================================

export class CSMCPProtocol {
    private readline: ReadlineInterface | null = null;
    private messageHandler: MessageHandler | null = null;
    private notificationHandlers: Map<string, NotificationHandler[]> = new Map();
    private pendingRequests: Map<string | number, PendingRequest> = new Map();
    private requestIdCounter: number = 0;
    private isRunning: boolean = false;
    private inputBuffer: string = '';
    private logLevel: MCPLogLevel = 'info';
    /** In-flight client→server requests, so notifications/cancelled can abort them. */
    private inflightRequests: Map<string | number, { controller: AbortController; cancelled: boolean }> = new Map();
    /** The real stdout writer, captured before the stray-write guard replaces it. */
    private rawStdoutWrite: typeof process.stdout.write | null = null;

    // Log level priorities for filtering
    private static readonly LOG_PRIORITIES: Record<MCPLogLevel, number> = {
        debug: 0,
        info: 1,
        notice: 2,
        warning: 3,
        error: 4,
        critical: 5,
        alert: 6,
        emergency: 7,
    };

    constructor() {
        // Bind methods to preserve context
        this.handleLine = this.handleLine.bind(this);
        this.handleClose = this.handleClose.bind(this);
    }

    // ========================================================================
    // Lifecycle Methods
    // ========================================================================

    /**
     * Start the protocol handler
     * Sets up stdin/stdout communication
     */
    public start(): void {
        if (this.isRunning) {
            return;
        }

        this.isRunning = true;

        // Guard the JSON-RPC channel: stdout belongs EXCLUSIVELY to the
        // protocol. In-process tool runs (the bdd runner, CSReporter's
        // ANSI-colored console.log output, stray library prints) would
        // otherwise inject non-JSON lines into the stream and make strict
        // hosts error out mid-session — losing all the credits already spent
        // on it. We capture the real writer for writeMessage and reroute
        // every other stdout write to stderr.
        this.rawStdoutWrite = process.stdout.write.bind(process.stdout);
        process.stdout.write = ((chunk: unknown, ...rest: unknown[]) =>
            (process.stderr.write as unknown as (...a: unknown[]) => boolean)(chunk, ...rest)) as typeof process.stdout.write;

        // Create readline interface for stdin
        this.readline = createInterface({
            input: process.stdin,
            output: undefined, // We write directly to stdout
            terminal: false,
        });

        this.readline.on('line', this.handleLine);
        this.readline.on('close', this.handleClose);

        // Cancellation: abort the matching in-flight request so long tool runs
        // (bdd execution, exploration) can stop burning compute, and so we
        // know to suppress the response the spec says a cancelled request
        // must not receive.
        this.onNotification(MCP_NOTIFICATIONS.CANCELLED, (notification) => {
            const requestId = notification.params?.requestId as string | number | undefined;
            if (requestId === undefined) return;
            const inflight = this.inflightRequests.get(requestId);
            if (inflight) {
                inflight.cancelled = true;
                inflight.controller.abort();
                this.log('debug', 'Request cancelled by client', { requestId });
            }
        });

        // Handle process signals for graceful shutdown
        process.on('SIGINT', () => this.stop());
        process.on('SIGTERM', () => this.stop());

        this.log('debug', 'MCP Protocol handler started');
    }

    /**
     * Stop the protocol handler
     */
    public stop(): void {
        if (!this.isRunning) {
            return;
        }

        this.isRunning = false;

        // Restore the real stdout writer.
        if (this.rawStdoutWrite) {
            process.stdout.write = this.rawStdoutWrite;
            this.rawStdoutWrite = null;
        }

        // Clear all pending requests
        for (const [id, pending] of this.pendingRequests) {
            clearTimeout(pending.timeout);
            pending.reject(new Error('Protocol handler stopped'));
            this.pendingRequests.delete(id);
        }

        // Close readline
        if (this.readline) {
            this.readline.close();
            this.readline = null;
        }

        this.log('debug', 'MCP Protocol handler stopped');
    }

    /**
     * Check if the protocol handler is running
     */
    public isActive(): boolean {
        return this.isRunning;
    }

    // ========================================================================
    // Handler Registration
    // ========================================================================

    /**
     * Set the message handler for incoming requests
     */
    public setMessageHandler(handler: MessageHandler): void {
        this.messageHandler = handler;
    }

    /**
     * Register a notification handler
     */
    public onNotification(method: string, handler: NotificationHandler): void {
        if (!this.notificationHandlers.has(method)) {
            this.notificationHandlers.set(method, []);
        }
        this.notificationHandlers.get(method)!.push(handler);
    }

    /**
     * Remove a notification handler
     */
    public offNotification(method: string, handler: NotificationHandler): void {
        const handlers = this.notificationHandlers.get(method);
        if (handlers) {
            const index = handlers.indexOf(handler);
            if (index !== -1) {
                handlers.splice(index, 1);
            }
        }
    }

    // ========================================================================
    // Message Sending
    // ========================================================================

    /**
     * Send a JSON-RPC response
     */
    public sendResponse(id: string | number, result?: unknown, error?: JsonRpcError): void {
        const response: JsonRpcResponse = {
            jsonrpc: '2.0',
            id,
        };

        if (error) {
            response.error = error;
        } else {
            response.result = result;
        }

        this.writeMessage(response);
    }

    /**
     * Send a JSON-RPC request and wait for response
     */
    public async sendRequest(method: string, params?: Record<string, unknown>, timeoutMs: number = 30000): Promise<unknown> {
        const id = `req_${++this.requestIdCounter}`;

        const request: JsonRpcRequest = {
            jsonrpc: '2.0',
            id,
            method,
            params,
        };

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new Error(`Request ${method} timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            this.pendingRequests.set(id, { resolve, reject, timeout });
            this.writeMessage(request);
        });
    }

    /**
     * Send a JSON-RPC notification (no response expected)
     */
    public sendNotification(method: string, params?: Record<string, unknown>): void {
        const notification: JsonRpcNotification = {
            jsonrpc: '2.0',
            method,
            params,
        };

        this.writeMessage(notification);
    }

    /**
     * Send an MCP notification
     */
    public notify(notification: MCPNotification): void {
        this.sendNotification(notification.method, notification.params);
    }

    /**
     * Send a log message notification
     */
    public log(level: MCPLogLevel, message: string, data?: unknown): void {
        // Check if we should log at this level
        if (CSMCPProtocol.LOG_PRIORITIES[level] < CSMCPProtocol.LOG_PRIORITIES[this.logLevel]) {
            return;
        }

        const logMessage: MCPLogMessage = {
            level,
            logger: 'cs-playwright-mcp',
            data: data !== undefined ? { message, ...((typeof data === 'object' && data !== null) ? data : { value: data }) } : message,
        };

        this.sendNotification(MCP_NOTIFICATIONS.LOG_MESSAGE, logMessage as unknown as Record<string, unknown>);
    }

    /**
     * Send a progress notification
     */
    public sendProgress(progressToken: string | number, progress: number, total?: number, message?: string): void {
        this.sendNotification(MCP_NOTIFICATIONS.PROGRESS, {
            progressToken,
            progress,
            ...(total !== undefined ? { total } : {}),
            ...(message !== undefined ? { message } : {}),
        });
    }

    /**
     * Set the logging level
     */
    public setLogLevel(level: MCPLogLevel): void {
        this.logLevel = level;
    }

    // ========================================================================
    // Error Helpers
    // ========================================================================

    /**
     * Create a JSON-RPC error response
     */
    public static createError(code: number, message: string, data?: unknown): JsonRpcError {
        return { code, message, data };
    }

    /**
     * Create a parse error
     */
    public static parseError(data?: unknown): JsonRpcError {
        return CSMCPProtocol.createError(JSON_RPC_ERRORS.PARSE_ERROR, 'Parse error', data);
    }

    /**
     * Create an invalid request error
     */
    public static invalidRequest(data?: unknown): JsonRpcError {
        return CSMCPProtocol.createError(JSON_RPC_ERRORS.INVALID_REQUEST, 'Invalid Request', data);
    }

    /**
     * Create a method not found error
     */
    public static methodNotFound(method: string): JsonRpcError {
        return CSMCPProtocol.createError(JSON_RPC_ERRORS.METHOD_NOT_FOUND, `Method not found: ${method}`);
    }

    /**
     * Create an invalid params error
     */
    public static invalidParams(data?: unknown): JsonRpcError {
        return CSMCPProtocol.createError(JSON_RPC_ERRORS.INVALID_PARAMS, 'Invalid params', data);
    }

    /**
     * Create an internal error
     */
    public static internalError(message: string, data?: unknown): JsonRpcError {
        return CSMCPProtocol.createError(JSON_RPC_ERRORS.INTERNAL_ERROR, message, data);
    }

    // ========================================================================
    // Private Methods
    // ========================================================================

    /**
     * Handle incoming line from stdin
     */
    private handleLine(line: string): void {
        // Skip empty lines
        if (!line.trim()) {
            return;
        }

        try {
            const message = JSON.parse(line);
            this.handleMessage(message);
        } catch (error) {
            // Handle JSON parse errors
            this.log('error', 'Failed to parse JSON message', { line, error: (error as Error).message });

            // If we can determine the ID, send an error response
            // Otherwise, we can't respond (per JSON-RPC spec)
            try {
                const partialParse = line.match(/"id"\s*:\s*("[^"]*"|\d+)/);
                if (partialParse) {
                    const id = JSON.parse(partialParse[1]);
                    this.sendResponse(id, undefined, CSMCPProtocol.parseError((error as Error).message));
                }
            } catch {
                // Can't determine ID, can't respond
            }
        }
    }

    /**
     * Handle parsed JSON-RPC message
     */
    private async handleMessage(message: unknown): Promise<void> {
        // Validate basic structure
        if (!message || typeof message !== 'object') {
            return;
        }

        const msg = message as Record<string, unknown>;

        // Check JSON-RPC version
        if (msg.jsonrpc !== '2.0') {
            if (msg.id !== undefined) {
                this.sendResponse(msg.id as string | number, undefined, CSMCPProtocol.invalidRequest('Missing or invalid jsonrpc version'));
            }
            return;
        }

        // Check if this is a response to a pending request
        if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
            this.handleResponse(msg as unknown as JsonRpcResponse);
            return;
        }

        // Check if this is a notification (no id)
        if (msg.id === undefined && msg.method !== undefined) {
            this.handleNotification(msg as unknown as JsonRpcNotification);
            return;
        }

        // This is a request
        if (msg.id !== undefined && msg.method !== undefined) {
            await this.handleRequest(msg as unknown as JsonRpcRequest);
            return;
        }

        // Invalid message
        if (msg.id !== undefined) {
            this.sendResponse(msg.id as string | number, undefined, CSMCPProtocol.invalidRequest('Invalid message structure'));
        }
    }

    /**
     * Handle incoming request
     */
    private async handleRequest(request: JsonRpcRequest): Promise<void> {
        if (!this.messageHandler) {
            this.sendResponse(request.id, undefined, CSMCPProtocol.internalError('No message handler registered'));
            return;
        }

        const controller = new AbortController();
        this.inflightRequests.set(request.id, { controller, cancelled: false });
        try {
            const result = await this.messageHandler(request, controller.signal);
            // A cancelled request MUST NOT receive a response (the client is
            // no longer waiting and would treat it as a protocol violation).
            if (!this.inflightRequests.get(request.id)?.cancelled) {
                this.sendResponse(request.id, result);
            }
        } catch (error) {
            if (this.inflightRequests.get(request.id)?.cancelled) return;
            const errorMessage = error instanceof Error ? error.message : String(error);
            // Preserve JSON-RPC error codes thrown by handlers (e.g. -32601
            // method-not-found, -32602 invalid-params) instead of flattening
            // everything to -32603 — hosts feature-detect optional methods by
            // this distinction.
            const code = (error as { code?: unknown })?.code;
            const rpcError =
                typeof code === 'number'
                    ? CSMCPProtocol.createError(code, errorMessage)
                    : CSMCPProtocol.internalError(errorMessage);
            this.sendResponse(request.id, undefined, rpcError);
        } finally {
            this.inflightRequests.delete(request.id);
        }
    }

    /**
     * Handle incoming notification
     */
    private handleNotification(notification: JsonRpcNotification): void {
        const handlers = this.notificationHandlers.get(notification.method);
        if (handlers) {
            for (const handler of handlers) {
                try {
                    handler(notification);
                } catch (error) {
                    this.log('error', 'Notification handler error', {
                        method: notification.method,
                        error: (error as Error).message,
                    });
                }
            }
        }
    }

    /**
     * Handle incoming response to a pending request
     */
    private handleResponse(response: JsonRpcResponse): void {
        const pending = this.pendingRequests.get(response.id);
        if (!pending) {
            this.log('warning', 'Received response for unknown request', { id: response.id });
            return;
        }

        clearTimeout(pending.timeout);
        this.pendingRequests.delete(response.id);

        if (response.error) {
            pending.reject(new Error(`${response.error.message} (code: ${response.error.code})`));
        } else {
            pending.resolve(response.result);
        }
    }

    /**
     * Handle readline close event
     */
    private handleClose(): void {
        this.log('debug', 'Stdin closed');
        this.stop();
    }

    /**
     * Write a message to stdout
     */
    private writeMessage(message: JsonRpcRequest | JsonRpcResponse | JsonRpcNotification): void {
        if (!this.isRunning) {
            return;
        }

        try {
            const json = JSON.stringify(message);
            // Use the captured raw writer — process.stdout.write is rerouted
            // to stderr while the server runs (see start()'s channel guard).
            (this.rawStdoutWrite ?? process.stdout.write.bind(process.stdout))(json + '\n');
        } catch (error) {
            // Log to stderr if we can't write to stdout
            console.error('Failed to write message:', error);
        }
    }
}

// ============================================================================
// Export singleton instance for convenience
// ============================================================================

export const mcpProtocol = new CSMCPProtocol();
