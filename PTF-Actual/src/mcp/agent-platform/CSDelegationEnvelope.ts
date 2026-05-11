/**
 * Delegation envelope — the structured payload `csaa_analyze` and
 * `csaa_translate` return to the host agent so the LLM does the cognitive
 * work, then hands the result back via a partner `csaa_record_*` tool.
 *
 * The envelope contains:
 *   - `task`        — short stable id (used by host UIs).
 *   - `instruction` — plain-English brief for the LLM. Keep it strict.
 *   - `responseSchema` — JSON schema the LLM's response MUST satisfy.
 *   - `grounding`   — material the LLM needs to do the job (source file
 *                     bytes, existing pages index, framework conventions).
 *   - `recordWith`  — name of the partner tool the LLM calls with the
 *                     produced JSON.
 *   - `recordArgs`  — args to thread back (runId etc).
 *
 * The host agent (Copilot in agent mode, Claude Code, OpenCode, etc.)
 * reads the envelope, runs the LLM with the instruction + grounding,
 * produces JSON matching the schema, then calls `recordWith` with
 * `recordArgs` + a `payload` field carrying the produced JSON.
 *
 * @module agent-platform/CSDelegationEnvelope
 */

import type { JsonSchema } from './CSDelegationSchemas';

export interface DelegationEnvelope {
    task: string;
    instruction: string;
    responseSchema: JsonSchema;
    grounding: Record<string, unknown>;
    recordWith: string;
    recordArgs: Record<string, unknown>;
}
