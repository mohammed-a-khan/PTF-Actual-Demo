/**
 * CS Playwright MCP — v3 rewrite pending (Phase 1+).
 *
 * v2 and pre-v2 MCP surfaces were deleted 2026-08-07 as part of the Phase 0
 * nuclear-delete. See docs/mcp/AGENTIC_QA_V3_ARCHITECTURE.md for the redesign
 * that replaces both.
 *
 * Salvaged from v2, kept for v3 to import:
 *   - src/mcp/_salvage/adapters/     (CSAdoAdapter, CSGherkin, CSTemplateEngine,
 *                                     CSFileAdapter, CSBrowserAdapter)
 *   - src/mcp/_salvage/config/       (CSMcpConfig, CSMcpConfigCli)
 *   - src/mcp/_salvage/publish-feature/composition.ts
 *                                    (pure functions extracted from CSAdoMode)
 *   - src/mcp/_salvage/skills/       (~50 framework skill markdown files;
 *                                     curated into .github/skills/ during
 *                                     earlier phases)
 *
 * Nothing outside src/mcp/ imports from this module today. The v6 MCP server
 * lives under src/mcp/v6/ and is launched by dist/mcp/v6/server/bin.js.
 */

export {};
