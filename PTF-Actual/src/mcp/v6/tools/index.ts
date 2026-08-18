import './fs_tool';
import './shell_tool';
import './search_tool';
import './browse_tool';
import './ask_user_tool';
import './memory_tool';
import './rag_tool';
import './db_select_tool';
import './ado_read_tool';
import './ado_write_tool';
import './ado_config_tool';
import './ado_sprint_context_tool';
import './ado_ctrf_export_tool';
import './ado_publish_run_results_tool';
import './ado_coverage_heatmap_tool';
import './publish_feature_to_ado_tool';
import './ado_testcases_manage_tool';
import './ado_trace_tool';
import './ado_build_delta_tool';
import './ado_test_points_bulk_tool';
import './git_tool';
import './doc_parse_tool';
import './code_analyze_tool';
import './verify_generated_tool';
import './heal_loop_tool';
import './init_project_tool';
import './ado_sprint_watcher_tool';
import './ado_kg_build_tool';
import './ado_kg_query_tool';
import './ado_detect_drift_tool';
import './ado_auto_heal_drift_tool';
import './ado_import_openapi_tool';
import './ado_gen_soap_test_tool';
import './ado_gen_perf_test_tool';
import './ado_analyze_perf_tool';
import './ado_create_security_bug_tool';
import './ado_gen_visual_regression_tool';
import './ado_env_health_tool';
// Phase D1 — UI scaffolding, DOM inspection, locator sync, manual-to-automated conversion.
import './ado_inspect_dom_tool';
import './ado_ui_scaffold_tool';
import './ado_sync_locators_tool';
import './ado_automate_manual_tool';
import './ado_automate_suite_tool';
import './ado_automation_inventory_tool';
// Phase E — governance hooks that ACTUALLY FIRE (executable primitives that
// Copilot invokes automatically before/after mutations).
import './ado_gov_audit_trail_tool';
import './ado_gov_attachment_audit_tool';
import './ado_gov_scaffold_audit_tool';
import './ado_gov_code_mutation_audit_tool';
import './ado_gov_secret_scanner_tool';
import './ado_gov_ado_policy_guard_tool';
import './ado_gov_compliance_check_tool';
import './ado_gov_upgrade_governance_tool';
import './ado_gov_pat_rotation_reminder_tool';
// Phase F — DORA + release gate + flaky/a11y dedupe + dashboard/webhook + healer bridge.
// Appended AFTER any concurrent Phase E imports. Do NOT reorder — Phase E may
// land 9 imports between the previous line and this block.
import './ado_dora_metrics_tool';
import './ado_release_gate_tool';
import './ado_flaky_signature_cluster_tool';
import './ado_a11y_scan_dedup_tool';
import './ado_dashboard_push_tool';
import './ado_service_hook_subscribe_tool';
import './ado_healer_bridge_tool';
// Phase G — GraphQL test generator.
import './ado_gen_graphql_test_tool';
// Phase H — source-grounded understanding: ingest app source into a model,
// ground stories against real facts, cross-reference against tests.
import './ado_source_ingest_tool';
import './ado_ground_story_tool';
import './ado_source_coverage_tool';
// Phase H — legacy-suite migration (Selenium/JUnit/TestNG/Cucumber/Jasmine/Mocha).
import './ado_migrate_legacy_tool';
// Phase H — docs-side ingestion complement (requirements, spec files, data
// fixtures) merged with the code-side model.
import './ado_docs_ingest_tool';
// Phase H — intent router.
import './ado_route_tool';
// Phase H — verified test generation pipeline: bootstrap gate, existing-tests
// reuse audit, live locator verification, grounded test-data resolution. The
// four tools compose into the /generate-verified orchestrator skill.
import './ado_bootstrap_check_tool';
import './ado_check_existing_tests_tool';
import './ado_verify_locators_live_tool';
import './ado_resolve_test_data_tool';

// Phase H — grouped bug/defect creation from test reports
import './ado_log_failures_as_bugs_tool';

// Phase H — manual TC generation from ADO stories (two-round LLM-drafted flow).
import './ado_generate_manual_tcs_tool';

// Phase H — verb-driven sprint / QA workflow ops (my-queue, claim-story,
// post-checkpoint, summary, link-work-items, find-tests-for-story).
import './ado_sprint_ops_tool';

// Phase H — verb-driven protocol test generator (REST / SOAP / GraphQL / Pact / WebSocket).
import './ado_gen_protocol_test_tool';

// Wave 1 — bulk fixture generator (faker-backed, lazy).
import './ado_gen_test_data_tool';

// Wave 2 — accessibility (axe-core) + security (OWASP) test generators.
import './ado_gen_a11y_test_tool';
import './ado_gen_security_test_tool';

export { listPrimitives, getPrimitive, registerPrimitive } from '../runtime/Primitive';
