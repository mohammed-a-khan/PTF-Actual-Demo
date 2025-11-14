/**
 * Advanced AST Parser for CS Codegen
 * Layer 1: Foundation - Parses Playwright codegen output with deep analysis
 */

import * as ts from 'typescript';
import {
    DeepCodeAnalysis,
    Action,
    LocatorInfo,
    LocatorChainStep,
    ControlFlowGraph,
    CFGNode,
    CFGEdge,
    DataFlowGraph,
    VariableFlow,
    DataDependency,
    TypeInformation,
    TypeInfo,
    ExecutionPath
} from '../types';

export class AdvancedASTParser {
    private sourceFile!: ts.SourceFile;
    private typeChecker!: ts.TypeChecker;
    private program!: ts.Program;

    /**
     * Main entry point: Parse Playwright codegen output
     */
    public parse(sourceCode: string): DeepCodeAnalysis {
        // Create source file
        this.sourceFile = ts.createSourceFile(
            'codegen.spec.ts',
            sourceCode,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS
        );

        // Create program for type checking
        const compilerHost = ts.createCompilerHost({});
        const originalGetSourceFile = compilerHost.getSourceFile;
        compilerHost.getSourceFile = (fileName, languageVersion) => {
            if (fileName === 'codegen.spec.ts') {
                return this.sourceFile;
            }
            return originalGetSourceFile.call(compilerHost, fileName, languageVersion);
        };

        this.program = ts.createProgram(['codegen.spec.ts'], {
            target: ts.ScriptTarget.Latest,
            module: ts.ModuleKind.CommonJS,
            noResolve: true
        }, compilerHost);

        this.typeChecker = this.program.getTypeChecker();

        // Extract actions
        const actions = this.extractActions();

        // Build control flow graph
        const controlFlow = this.buildControlFlowGraph();

        // Build data flow graph
        const dataFlow = this.buildDataFlowGraph();

        // Extract type information
        const typeInfo = this.extractTypeInformation();

        // Identify execution paths
        const executionPaths = this.identifyExecutionPaths(actions);

        return {
            syntaxTree: this.sourceFile,
            actions,
            controlFlow,
            dataFlow,
            typeInfo,
            executionPaths
        };
    }

    /**
     * Extract all actions from the AST
     * FIXED: Now properly extracts all actions including assertions
     */
    private extractActions(): Action[] {
        const actions: Action[] = [];
        let actionId = 0;

        const visit = (node: ts.Node) => {
            // Look for await expressions (most Playwright actions are awaited)
            if (ts.isAwaitExpression(node)) {
                const action = this.parseAction(node.expression, actionId++);
                if (action) {
                    actions.push(action);
                }
            }

            ts.forEachChild(node, visit);
        };

        visit(this.sourceFile);
        return actions;
    }

    /**
     * Parse a single action from expression
     */
    private parseAction(expression: ts.Expression, id: number): Action | null {
        if (!ts.isCallExpression(expression)) {
            return null;
        }

        const { line } = this.sourceFile.getLineAndCharacterOfPosition(expression.getStart());
        const methodName = this.getMethodName(expression);
        const locator = this.parseLocator(expression);
        const args = this.extractArguments(expression);
        const options = this.extractOptions(expression);

        return {
            id: `action_${id}`,
            type: this.classifyActionType(methodName),
            method: methodName,
            target: locator,
            args,
            options,
            lineNumber: line + 1,
            expression: expression.getText(this.sourceFile),
            astNode: expression
        };
    }

    /**
     * Get method name from call expression
     */
    private getMethodName(expression: ts.CallExpression): string {
        if (ts.isPropertyAccessExpression(expression.expression)) {
            return expression.expression.name.getText();
        }
        return 'unknown';
    }

    /**
     * Parse locator chain from expression
     * FIXED: Now handles expect() assertions and complex chains properly
     */
    private parseLocator(expression: ts.CallExpression): LocatorInfo | undefined {
        const chain: LocatorChainStep[] = [];
        let current: ts.Expression = expression;

        // SPECIAL CASE: Handle expect(locator).assertion() pattern
        // Structure: expect(page.getByRole(...)).toBeVisible()
        //   expression = toBeVisible() CallExpression
        //   expression.expression = .toBeVisible PropertyAccessExpression
        //   expression.expression.expression = expect(...) CallExpression
        const expressionText = expression.getText(this.sourceFile);
        if (expressionText.startsWith('expect(')) {
            // Get the expect() call from: toBeVisible() -> .toBeVisible -> expect(...)
            let expectCall: ts.CallExpression | undefined;
            if (ts.isPropertyAccessExpression(expression.expression)) {
                const propertyAccess = expression.expression;
                if (ts.isCallExpression(propertyAccess.expression)) {
                    expectCall = propertyAccess.expression;
                }
            }

            // Parse the locator inside expect()
            if (expectCall && expectCall.arguments.length > 0) {
                const expectArg = expectCall.arguments[0];
                if (ts.isCallExpression(expectArg)) {
                    // The expectArg is a call expression like page.getByRole(...)
                    // We need to walk its chain to extract the locator steps
                    this.walkChain(expectArg, chain);
                } else if (ts.isPropertyAccessExpression(expectArg)) {
                    // Handle property access expressions
                    this.walkChain(expectArg, chain);
                }
            }

            // Get the assertion method (toBeVisible, toHaveText, etc.)
            const assertionMethod = this.getMethodName(expression);
            chain.push({
                method: assertionMethod,
                args: this.extractArguments(expression)
            });
        } else {
            // NORMAL CASE: Regular action chain (page.locator().click())
            this.walkChain(current, chain);
        }

        if (chain.length === 0) {
            return undefined;
        }

        // Identify locator type
        const locatorStep = chain.find(step =>
            step.method === 'getByRole' ||
            step.method === 'getByPlaceholder' ||
            step.method === 'getByText' ||
            step.method === 'getByLabel' ||
            step.method === 'getByTestId' ||
            step.method === 'locator'
        );

        // Even if no explicit locator found, return something for assertions
        if (!locatorStep && expressionText.startsWith('expect(')) {
            // Create a synthetic locator for assertions
            return {
                type: 'unknown',
                selector: expressionText.substring(7, expressionText.indexOf(')')),  // Extract from expect(...)
                options: {},
                chain: chain.length > 0 ? chain : undefined
            };
        }

        if (!locatorStep) {
            return undefined;
        }

        return {
            type: locatorStep.method,
            selector: this.buildSelectorString(locatorStep),
            options: this.extractLocatorOptions(locatorStep),
            chain: chain.length > 1 ? chain : undefined
        };
    }

    /**
     * Walk through a chain of method calls to extract locator steps
     */
    private walkChain(startExpr: ts.Expression, chain: LocatorChainStep[]): void {
        let current: ts.Expression = startExpr;

        // Walk backwards through the chain
        while (ts.isCallExpression(current) || ts.isPropertyAccessExpression(current)) {
            if (ts.isCallExpression(current)) {
                const methodName = this.getMethodName(current);
                const args = current.arguments.map(arg => this.evaluateArgument(arg));

                chain.unshift({
                    method: methodName,
                    args
                });

                // Move to parent expression
                if (ts.isPropertyAccessExpression(current.expression)) {
                    current = current.expression.expression;
                } else {
                    break;
                }
            } else if (ts.isPropertyAccessExpression(current)) {
                // Just a property access without call
                current = current.expression;
            } else {
                break;
            }
        }
    }

    /**
     * Build selector string from locator step
     */
    private buildSelectorString(step: LocatorChainStep): string {
        if (step.method === 'locator' && step.args.length > 0) {
            return String(step.args[0]);
        }
        if (step.method === 'getByRole' && step.args.length > 0) {
            return String(step.args[0]);
        }
        if (step.method === 'getByPlaceholder' && step.args.length > 0) {
            return String(step.args[0]);
        }
        if (step.method === 'getByText' && step.args.length > 0) {
            return String(step.args[0]);
        }
        return '';
    }

    /**
     * Extract options from locator step
     */
    private extractLocatorOptions(step: LocatorChainStep): Record<string, any> {
        if (step.args.length > 1 && typeof step.args[1] === 'object') {
            return step.args[1] as Record<string, any>;
        }
        return {};
    }

    /**
     * Evaluate argument value
     */
    private evaluateArgument(arg: ts.Expression): any {
        if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
            return arg.text;
        }
        if (ts.isNumericLiteral(arg)) {
            return Number(arg.text);
        }
        if (arg.kind === ts.SyntaxKind.TrueKeyword) {
            return true;
        }
        if (arg.kind === ts.SyntaxKind.FalseKeyword) {
            return false;
        }
        if (ts.isObjectLiteralExpression(arg)) {
            return this.evaluateObjectLiteral(arg);
        }
        if (ts.isArrayLiteralExpression(arg)) {
            return arg.elements.map(el => this.evaluateArgument(el));
        }
        return arg.getText(this.sourceFile);
    }

    /**
     * Evaluate object literal
     */
    private evaluateObjectLiteral(obj: ts.ObjectLiteralExpression): Record<string, any> {
        const result: Record<string, any> = {};
        for (const prop of obj.properties) {
            if (ts.isPropertyAssignment(prop)) {
                const key = prop.name.getText(this.sourceFile);
                const value = this.evaluateArgument(prop.initializer);
                result[key] = value;
            }
        }
        return result;
    }

    /**
     * Extract arguments from call expression
     */
    private extractArguments(expression: ts.CallExpression): any[] {
        return expression.arguments.map(arg => this.evaluateArgument(arg));
    }

    /**
     * Extract options object from arguments
     */
    private extractOptions(expression: ts.CallExpression): Record<string, any> {
        // Look for options object (usually last argument if it's an object literal)
        const lastArg = expression.arguments[expression.arguments.length - 1];
        if (lastArg && ts.isObjectLiteralExpression(lastArg)) {
            return this.evaluateObjectLiteral(lastArg);
        }
        return {};
    }

    /**
     * Classify action type
     */
    private classifyActionType(methodName: string): string {
        const actionMap: Record<string, string> = {
            'click': 'click',
            'dblclick': 'double-click',
            'fill': 'fill',
            'type': 'type',
            'press': 'keypress',
            'selectOption': 'select',
            'check': 'check',
            'uncheck': 'uncheck',
            'hover': 'hover',
            'focus': 'focus',
            'blur': 'blur',
            'goto': 'navigation',
            'waitFor': 'wait',
            'expect': 'assertion',
            'toBeVisible': 'assertion',
            'toHaveText': 'assertion',
            'toHaveValue': 'assertion',
            'setInputFiles': 'file-upload',
            'dragTo': 'drag-drop'
        };

        return actionMap[methodName] || 'generic';
    }

    /**
     * Build Control Flow Graph
     */
    private buildControlFlowGraph(): ControlFlowGraph {
        const nodes: CFGNode[] = [];
        const edges: CFGEdge[] = [];
        let nodeId = 0;

        const createNode = (statement: ts.Node, type: CFGNode['type']): CFGNode => {
            const { line } = this.sourceFile.getLineAndCharacterOfPosition(statement.getStart());
            return {
                id: `node_${nodeId++}`,
                type,
                statement,
                lineNumber: line + 1
            };
        };

        let prevNodeId: string | null = null;

        const visit = (node: ts.Node) => {
            if (ts.isExpressionStatement(node) || ts.isVariableStatement(node)) {
                const cfgNode = createNode(node, 'statement');
                nodes.push(cfgNode);

                if (prevNodeId) {
                    edges.push({ from: prevNodeId, to: cfgNode.id });
                }
                prevNodeId = cfgNode.id;
            } else if (ts.isIfStatement(node)) {
                const branchNode = createNode(node, 'branch');
                nodes.push(branchNode);

                if (prevNodeId) {
                    edges.push({ from: prevNodeId, to: branchNode.id });
                }

                // Process then branch
                const thenPrevId = prevNodeId;
                prevNodeId = branchNode.id;
                visit(node.thenStatement);
                const thenExitId = prevNodeId;

                // Process else branch if exists
                let elseExitId = branchNode.id;
                if (node.elseStatement) {
                    prevNodeId = branchNode.id;
                    visit(node.elseStatement);
                    elseExitId = prevNodeId!;
                }

                prevNodeId = thenExitId; // Continue from then branch
            } else if (ts.isWhileStatement(node) || ts.isForStatement(node)) {
                const loopNode = createNode(node, 'loop');
                nodes.push(loopNode);

                if (prevNodeId) {
                    edges.push({ from: prevNodeId, to: loopNode.id });
                }

                prevNodeId = loopNode.id;
                visit(node.statement);

                // Loop back
                if (prevNodeId) {
                    edges.push({ from: prevNodeId, to: loopNode.id });
                }
            } else {
                ts.forEachChild(node, visit);
            }
        };

        visit(this.sourceFile);

        return {
            nodes,
            edges,
            entryNode: nodes[0]?.id || '',
            exitNodes: [prevNodeId || '']
        };
    }

    /**
     * Build Data Flow Graph
     */
    private buildDataFlowGraph(): DataFlowGraph {
        const variables = new Map<string, VariableFlow>();
        const dependencies: DataDependency[] = [];

        const recordVariable = (name: string, lineNumber: number, isDef: boolean) => {
            if (!variables.has(name)) {
                variables.set(name, {
                    name,
                    definitions: [],
                    uses: [],
                    type: 'unknown'
                });
            }

            const varFlow = variables.get(name)!;
            if (isDef) {
                varFlow.definitions.push(lineNumber);
            } else {
                varFlow.uses.push(lineNumber);
            }
        };

        const visit = (node: ts.Node) => {
            const { line } = this.sourceFile.getLineAndCharacterOfPosition(node.getStart());

            if (ts.isVariableDeclaration(node)) {
                const name = node.name.getText(this.sourceFile);
                recordVariable(name, line + 1, true);

                if (node.initializer) {
                    this.findIdentifiers(node.initializer).forEach(id => {
                        recordVariable(id, line + 1, false);
                        dependencies.push({
                            from: id,
                            to: name,
                            type: 'data'
                        });
                    });
                }
            }

            ts.forEachChild(node, visit);
        };

        visit(this.sourceFile);

        return {
            variables,
            dependencies
        };
    }

    /**
     * Find all identifiers in an expression
     */
    private findIdentifiers(node: ts.Node): string[] {
        const identifiers: string[] = [];

        const visit = (n: ts.Node) => {
            if (ts.isIdentifier(n)) {
                identifiers.push(n.text);
            }
            ts.forEachChild(n, visit);
        };

        visit(node);
        return identifiers;
    }

    /**
     * Extract type information
     */
    private extractTypeInformation(): TypeInformation {
        const typeInfo: TypeInformation = {
            variables: new Map(),
            parameters: new Map(),
            returnTypes: new Map()
        };

        const visit = (node: ts.Node) => {
            if (ts.isVariableDeclaration(node)) {
                const name = node.name.getText(this.sourceFile);
                const symbol = this.typeChecker.getSymbolAtLocation(node.name);

                if (symbol) {
                    const type = this.typeChecker.getTypeOfSymbolAtLocation(symbol, node);
                    const typeString = this.typeChecker.typeToString(type);

                    typeInfo.variables.set(name, {
                        type: typeString,
                        isLocator: typeString.includes('Locator'),
                        isPromise: typeString.includes('Promise'),
                        elementType: this.extractElementType(typeString)
                    });
                }
            }

            ts.forEachChild(node, visit);
        };

        visit(this.sourceFile);
        return typeInfo;
    }

    /**
     * Extract element type from type string
     */
    private extractElementType(typeString: string): string | undefined {
        const match = typeString.match(/Promise<(.+)>/);
        return match ? match[1] : undefined;
    }

    /**
     * Identify execution paths
     */
    private identifyExecutionPaths(actions: Action[]): ExecutionPath[] {
        // For now, create a single linear path
        // TODO: Handle branches and loops for multiple paths
        return [{
            id: 'main_path',
            actions,
            conditions: []
        }];
    }
}
