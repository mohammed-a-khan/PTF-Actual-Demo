/**
 * Agentic SDLC Platform — barrel export
 *
 * The v3 single-agent architecture: five meta-tools, thirteen SDLC modes,
 * a deterministic playbook engine, lazy capability packs, and live
 * guardrails. See MCP_AGENTIC_REDESIGN.md at the repo root.
 *
 * @module agentic
 */

export * from './types';
export { CSSDLCCatalog, MODE_DEFINITIONS } from './CSSDLCCatalog';
export { CSToolPacks, ToolPackInfo } from './CSToolPacks';
export { CSSessionStore, SESSION_BUDGET_DEFAULTS } from './CSSessionStore';
export { CSGuardrailEngine, GUARDRAIL_LIMITS } from './CSGuardrailEngine';
export { CSInteract } from './CSInteract';
export { CSPlaybooks } from './CSPlaybooks';
export { CSPlaybookEngine } from './CSPlaybookEngine';
export { agenticMetaTools, registerAgenticTools } from './CSAgenticTools';
