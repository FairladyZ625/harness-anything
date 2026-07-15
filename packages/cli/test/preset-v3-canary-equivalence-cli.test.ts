// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { findTaskPackagePath, readTaskProjection, resolveHarnessLayout } from "../../kernel/src/index.ts";
import { ensureTestHarnessIdentity } from "./helpers/git-fixtures.ts";
import { runJson, withTempRoot } from "./helpers/preset-script-fixtures.ts";

process.env.HARNESS_DAEMON_MODE = "direct";
process.env.HARNESS_DAEMON_PROFILE = "isolated";
delete process.env.HARNESS_DAEMON_USER_ROOT;

type CanaryId = "doc-canon-sync" | "usage-acceptance" | "milestone-dossier" | "dogfood-utilization-audit";
type Version = "v2" | "v3";

interface CanaryRun {
  readonly taskId: string;
  readonly result: Record<string, any>;
  readonly reports: Readonly<Record<string, unknown>>;
  readonly context?: Record<string, any>;
}

const fixtureRoot = path.resolve("packages/cli/test/fixtures/preset-v3-canaries");
const trackedPresets = [
  "standard-task", "module", "legacy-migration", "doc-canon-sync", "milestone-closeout",
  "lesson-sedimentation", "milestone-dossier", "version-upgrade", "publish-standard",
  "release-closeout", "long-running-task", "dogfood-utilization-audit"
];

for (const canary of ["doc-canon-sync", "usage-acceptance", "milestone-dossier", "dogfood-utilization-audit"] as const) {
  test(`${canary} v3 semantic runtime preserves the v2 business report with narrower authority`, () => {
    const legacy = runCanary(canary, "v2");
    const semantic = runCanary(canary, "v3");

    assert.deepEqual(
      normalizeBusinessOutput(semantic.reports, semantic.taskId, canary),
      normalizeBusinessOutput(legacy.reports, legacy.taskId, canary)
    );
    assert.equal(legacy.result.warnings.some((warning: Record<string, unknown>) => warning.code === "legacy-physical-scope"), true);
    assert.equal(semantic.result.capabilityReceipt.schema, "preset-capability-runtime-receipt/v1");
    assert.equal(semantic.result.capabilityReceipt.semanticFailureFallback, "forbidden");
    assertV2ContextIsHandleOnly(semantic.context);
    assertSemanticManifestHasNoPhysicalScopeTokens(canary);
  });
}

test("v3 semantic execution fails closed when a required projection is empty", () => {
  withTempRoot((rootDir) => {
    seedRoot(rootDir);
    installPreset(rootDir, "doc-canon-sync", "v3");
    const created = runJson(rootDir, ["new-task", "--title", "Empty Projection", "--vertical", "software/coding", "--preset", "doc-canon-sync"]);
    removeCanonicalSources(rootDir);
    runJson(rootDir, ["governance", "rebuild"]);

    const result = runJson(rootDir, [
      "preset", "action", "doc-canon-sync", "check", "--task", created.taskId, "--allow-scripts"
    ], false);

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "preset_runtime_unavailable");
    assert.match(result.error.hint, /empty projection; raw-fs fallback is forbidden/u);
    assert.equal(result.warnings?.some((warning: Record<string, unknown>) => warning.code === "legacy-physical-scope") ?? false, false);
  });
});

test("v3 repository-source materializes a read-only text snapshot while empty artifact selection stays data", () => {
  withTempRoot((rootDir) => {
    seedRoot(rootDir);
    writeText(rootDir, "package.json", `${JSON.stringify({ scripts: { check: "node tools/check.mjs" } }, null, 2)}\n`);
    writeText(rootDir, "eslint.config.mjs", "export default [];\n");
    writeText(rootDir, "tools/check.mjs", "export const check = true;\n");
    writeText(rootDir, "packages/example/src/index.ts", "export const example = 1;\n");
    writeText(rootDir, ".harness/presets/repository-source-canary/PRESET.md", [
      "---", "schema: preset-document/v1", "description: Exercise the repository source snapshot provider.",
      "whenToUse: Provider contract test only.", "entrypoints:", "  gather: provider contract", "---", "", "# Repository Source Canary", ""
    ].join("\n"));
    writeText(rootDir, ".harness/presets/repository-source-canary/preset.json", `${JSON.stringify({
      schema: "preset-manifest/v3",
      id: "repository-source-canary",
      title: "Repository Source Canary",
      vertical: "software/coding",
      version: "1.0.0",
      kind: "process-action",
      kernelVersionRange: { min: "1.0.0", maxExclusive: "2.0.0" },
      capabilityImports: [],
      entrypoints: {
        gather: {
          type: "script",
          command: "scripts/gather.mjs",
          intent: { verb: "gather", subject: "repository-source-contract" },
          inputs: {},
          requires: [
            { capability: "repository-source", version: "1", select: { collections: ["project-config", "gate-tooling", "product-source"], view: "text-snapshot" } },
            { capability: "task-artifacts", version: "1", select: { scope: "all-tasks", artifactIds: ["missing-artifact"] } }
          ],
          produces: [{
            capability: "task-artifacts",
            version: "1",
            target: { taskFrom: "current-task" },
            artifacts: [{ id: "repository-source-report", schema: "repository-source-report/v1", mediaTypes: ["application/json"], cardinality: "one", required: true }]
          }],
          sideEffects: []
        }
      },
      profiles: [{ id: "baseline", title: "Baseline", checkerProfile: "standard", completionGates: [], templateSelections: [] }],
      defaultProfile: "baseline"
    }, null, 2)}\n`);
    writeText(rootDir, ".harness/presets/repository-source-canary/scripts/gather.mjs", [
      "#!/usr/bin/env node",
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "import path from 'node:path';",
      "const context = JSON.parse(readFileSync(process.env.HARNESS_PRESET_CONTEXT, 'utf8'));",
      "if (context.paths || context.outputRoot) throw new Error('semantic context leaked a physical root');",
      "const sourceHandle = context.capabilities.reads['repository-source'][0];",
      "const source = JSON.parse(readFileSync(sourceHandle.path, 'utf8'));",
      "const artifactsHandle = context.capabilities.reads['task-artifacts'][0];",
      "const artifacts = JSON.parse(readFileSync(artifactsHandle.path, 'utf8'));",
      "if (artifacts.artifacts.length !== 0) throw new Error('missing artifact selection must stay empty data');",
      "const example = readFileSync(path.join(source.root, 'packages/example/src/index.ts'), 'utf8');",
      "const writer = context.capabilities.writes['task-artifacts'][0].artifacts['repository-source-report'].representations[0];",
      "const report = { schema: 'repository-source-report/v1', files: source.files.map((file) => file.path), example };",
      "writeFileSync(writer.path, `${JSON.stringify(report, null, 2)}\\n`, 'utf8');",
      "writeFileSync(context.result.path, `${JSON.stringify({ schema: 'script-result/v1', ok: true, report, produced: ['repository-source-report'] }, null, 2)}\\n`, 'utf8');",
      ""
    ].join("\n"));

    const created = runJson(rootDir, ["new-task", "--title", "Repository Source", "--vertical", "software/coding", "--preset", "repository-source-canary"]);
    const result = runJson(rootDir, ["preset", "action", "repository-source-canary", "gather", "--task", created.taskId, "--allow-scripts"]);
    assert.equal(result.capabilityReceipt.contextSchema, "preset-context/v2");
    assert.equal(result.report.schema, "repository-source-report/v1");
    assert.equal(result.report.files.includes("package.json"), true);
    assert.equal(result.report.files.includes("tools/check.mjs"), true);
    assert.equal(result.report.files.includes("packages/example/src/index.ts"), true);
    assert.match(result.report.example, /example = 1/u);
  });
});

function runCanary(canary: CanaryId, version: Version): CanaryRun {
  return withTempRoot((rootDir) => {
    seedRoot(rootDir);
    installPreset(rootDir, canary, version);
    const created = runJson(rootDir, [
      "new-task", "--title", `${canary} Canary`, "--vertical", "software/coding", "--preset", canary
    ]);
    const taskId = String(created.taskId);
    if (canary === "usage-acceptance") writeDecision(rootDir, "dec_USAGE", "Usage Intent Decision", taskId);
    runJson(rootDir, ["governance", "rebuild"]);

    if (version === "v3") {
      const validated = runJson(rootDir, ["preset", "validate", path.join(fixtureRoot, canary, version, "preset.json")]);
      const checked = runJson(rootDir, ["preset", "check", canary]);
      assert.equal(validated.report.preflight.valid, true);
      assert.equal(checked.preset.valid, true);
    }

    if (canary === "usage-acceptance") return runUsageAcceptance(rootDir, taskId, version);
    if (canary === "dogfood-utilization-audit") resetAuditInventories(rootDir);
    const args = ["preset", "action", canary, entrypointFor(canary), "--task", taskId, "--allow-scripts"];
    if (canary === "milestone-dossier") args.push("--input", "decisionId=dec_CANARY");
    const result = version === "v2" && (canary === "milestone-dossier" || canary === "dogfood-utilization-audit")
      ? runLegacyBaselineDirect(rootDir, canary, taskId)
      : runJson(rootDir, args);
    const artifactsRoot = taskArtifactsRoot(rootDir, taskId);
    const reportName = canary === "doc-canon-sync"
      ? "doc-canon-drift.json"
      : canary === "milestone-dossier"
        ? "dossier.data.json"
        : "dogfood-utilization-audit.json";
    return {
      taskId,
      result,
      reports: {
        business: readJson(path.join(artifactsRoot, reportName)),
        receiptReport: result.report
      },
      ...(version === "v3" ? { context: readRunContext(rootDir, result) } : {})
    };
  });
}

function runUsageAcceptance(rootDir: string, taskId: string, version: Version): CanaryRun {
  const captured = runJson(rootDir, [
    "preset", "action", "usage-acceptance", "scaffold", "--task", taskId, "--allow-scripts"
  ]);
  const artifactsRoot = taskArtifactsRoot(rootDir, taskId);
  const findingsPath = path.join(artifactsRoot, "usage-acceptance-findings.json");
  const initialFindings = readJson(findingsPath);
  const completedFindings = {
    ...initialFindings,
    findings: [{
      id: "canary-friction",
      severity: "friction",
      expected: "semantic and legacy runs expose the same workflow",
      actual: "both canaries completed",
      evidence: ["artifacts/usage-acceptance-evidence.txt"],
      resolution: "verified"
    }],
    verdict: "pass"
  };
  writeFileSync(findingsPath, `${JSON.stringify(completedFindings, null, 2)}\n`, "utf8");
  writeFileSync(path.join(artifactsRoot, "usage-acceptance-evidence.txt"), "canary evidence\n", "utf8");
  const checked = runJson(rootDir, [
    "preset", "action", "usage-acceptance", "check", "--task", taskId, "--allow-scripts"
  ]);
  return {
    taskId,
    result: checked,
    reports: {
      capture: captured.report,
      findings: initialFindings,
      check: readJson(path.join(artifactsRoot, "usage-acceptance-check.json")),
      checkReceiptReport: checked.report
    },
    ...(version === "v3" ? { context: readRunContext(rootDir, checked) } : {})
  };
}

function seedRoot(rootDir: string): void {
  writeTask(rootDir, "task_BASE_CANARY", "Base Canary Task", "standard-task");
  writeDecision(rootDir, "dec_CANARY", "CLI Canon Decision", "task_BASE_CANARY");
  writeText(rootDir, "harness/adr/ADR-0001-canary.md", [
    "---", "id: ADR-0001", "title: Canary Architecture", "status: accepted", "date: 2026-07-01", "---", "",
    "# Canary Architecture", "", "## Status", "", "Accepted 2026-07-01", ""
  ].join("\n"));
  writeText(rootDir, "harness/AGENTS.md", [
    "# Operating Guide", "", "Tasks circulate through decision, fact, and relation records.",
    "The CLI canon includes dec_CANARY and ADR-0001.",
    "<!-- canon-synced-through: dec_CANARY @ 2026-12-01T00:00:00.000Z -->", ""
  ].join("\n"));
  writeText(rootDir, "harness/governance/guide.md", "# Governance\n\nDecision, fact, and relation circulation.\n");
  writeText(rootDir, "harness/standards/guide.md", "# Standards\n\nCLI report and schema standards cover dec_CANARY and ADR-0001.\n");
  writeText(rootDir, "harness/docmap.json", "{\"schema\":\"docmap/v1\"}\n");
  writeText(rootDir, ".harness/generated/runtime-events/canary.jsonl", `${JSON.stringify({
    schema: "runtime-event/v1",
    result: { summary: "CLI command succeeded: preset-action" },
    presets: trackedPresets
  })}\n`);
  writeText(rootDir, ".harness/generated/distill/candidate.json", "{}\n");
  writeText(rootDir, ".harness/generated/lessons/promotion.json", "{}\n");
  writeText(rootDir, ".harness/generated/graph-panorama/index.html", "<html></html>\n");
  writeText(rootDir, ".harness/write-journal/canary.json", "{}\n");
  writeText(rootDir, "harness/tasks/task_BASE_CANARY-fixture/artifacts/evidence.json", `${JSON.stringify({ presetId: "standard-task" })}\n`);
  ensureTestHarnessIdentity(rootDir);
  runJson(rootDir, ["governance", "rebuild"]);
}

function resetAuditInventories(rootDir: string): void {
  rmSync(path.join(rootDir, ".harness/generated"), { recursive: true, force: true });
  rmSync(path.join(rootDir, ".harness/write-journal"), { recursive: true, force: true });
  writeText(rootDir, ".harness/generated/runtime-events/canary.jsonl", `${JSON.stringify({
    schema: "runtime-event/v1",
    result: { summary: "CLI command succeeded: preset-action" },
    presets: trackedPresets
  })}\n`);
  writeText(rootDir, ".harness/generated/distill/candidate.json", "{}\n");
  writeText(rootDir, ".harness/generated/lessons/promotion.json", "{}\n");
  writeText(rootDir, ".harness/generated/graph-panorama/index.html", "<html></html>\n");
  writeText(rootDir, ".harness/write-journal/canary.json", "{}\n");
}

function runLegacyBaselineDirect(
  rootDir: string,
  canary: "milestone-dossier" | "dogfood-utilization-audit",
  taskId: string
): Record<string, any> {
  const layout = resolveHarnessLayout(rootDir);
  const outputRoot = findTaskPackagePath(rootDir, taskId);
  assert.ok(outputRoot);
  const entrypoint = canary === "milestone-dossier" ? "gather" : "audit";
  const scriptName = canary === "milestone-dossier" ? "dossier-data.mjs" : "preset-action.mjs";
  const contextPath = path.join(layout.localRoot, "legacy-baseline", `${canary}.context.json`);
  const taskIndex = readTaskProjection({ rootDir }).rows.map((task) => ({
    taskId: task.taskId,
    title: task.title,
    preset: task.preset,
    indexPath: task.sourcePath,
    packagePath: path.posix.dirname(task.sourcePath)
  }));
  const context = {
    schema: "preset-context/v1",
    presetId: canary,
    entrypoint,
    taskId,
    outputRoot,
    paths: {
      rootDir: layout.rootDir,
      authoredRoot: layout.authoredRoot,
      tasksRoot: layout.tasksRoot,
      decisionsRoot: layout.decisionsRoot,
      adrRoot: layout.adrRoot,
      generatedRoot: layout.generatedRoot,
      localRoot: layout.localRoot
    },
    taskIndex,
    inputs: canary === "milestone-dossier"
      ? { coordinationTaskId: taskId, decisionId: "dec_CANARY" }
      : { trackedPresets: trackedPresets.join(","), trackedArtifacts: "runtime-events,distill-candidates,lesson-promotions,graph-panorama,write-journal,docmap" }
  };
  mkdirSync(path.dirname(contextPath), { recursive: true });
  writeFileSync(contextPath, `${JSON.stringify(context, null, 2)}\n`, "utf8");
  execFileSync(process.execPath, [path.join(fixtureRoot, canary, "v2/scripts", scriptName)], {
    env: { ...process.env, HARNESS_PRESET_CONTEXT: contextPath, HARNESS_SCRIPT_CONTEXT: contextPath }
  });
  const scriptedResult = readJson(path.join(outputRoot, "artifacts/preset-result.json"));
  return {
    ok: scriptedResult.ok === true,
    report: scriptedResult.report,
    warnings: [{ code: "legacy-physical-scope" }]
  };
}

function installPreset(rootDir: string, canary: CanaryId, version: Version): void {
  if (version === "v2") {
    cpSync(path.join(fixtureRoot, canary, version), path.join(rootDir, ".harness/presets", canary), { recursive: true });
    return;
  }
  const installed = runJson(rootDir, ["preset", "install", path.join(fixtureRoot, canary, version), "--project"]);
  assert.equal(installed.ok, true);
}

function writeTask(rootDir: string, taskId: string, title: string, preset: string): void {
  writeText(rootDir, `harness/tasks/${taskId}-fixture/INDEX.md`, [
    "---", "schema: task-package/v2", `task_id: ${taskId}`, `title: ${title}`,
    "lifecycle:", "  bindingSchema: lifecycle-binding/v1", "  engine: local", "  status: active", "  ref: ",
    `  titleSnapshot: ${title}`, "  url: ", "  bindingCreatedAt: 2026-07-04T00:00:00.000Z",
    "  bindingFingerprint: sha256:4d1771ef6e83619eb8a82f1593bf118383084665fc58f634072d379178d525d7",
    "packageDisposition: active", "vertical: software/coding", `preset: ${preset}`, "---", "", `# ${title}`, ""
  ].join("\n"));
}

function writeDecision(rootDir: string, decisionId: string, title: string, taskId: string): void {
  writeText(rootDir, `harness/decisions/${decisionId}/decision.md`, [
    "---", "schema: decision-package/v1", `decision_id: ${decisionId}`, `_coordinatorWatermark: wm-${decisionId}`,
    `title: "${title}"`, "state: active", "riskTier: low", "urgency: low", "vertical: software/coding",
    "preset: architecture-decision", "applies_to:", "  modules: []", "  productLines: []",
    "proposedBy: { kind: agent, id: fixture }", "proposedAt: 2026-07-01T00:00:00.000Z",
    "arbiter: { kind: human, id: fixture }", "decidedAt: 2026-07-01T00:00:00.000Z",
    `question: "Should ${title} derive ${taskId}?"`, "chosen:", "  - { id: CH1, text: Yes }",
    "rejected:", "  - { id: RJ1, text: No, why_not: Fixture }", "claims: []", "relations: []",
    "---", "", `# ${title}`, "", `This decision derives ${taskId}.`, ""
  ].join("\n"));
}

function removeCanonicalSources(rootDir: string): void {
  const decisions = path.join(rootDir, "harness/decisions");
  const adrs = path.join(rootDir, "harness/adr");
  for (const target of [decisions, adrs]) {
    if (!existsSync(target)) continue;
    for (const entry of readdirSync(target)) rmSync(path.join(target, entry), { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
  }
}

function entrypointFor(canary: Exclude<CanaryId, "usage-acceptance">): string {
  if (canary === "doc-canon-sync") return "check";
  if (canary === "milestone-dossier") return "gather";
  return "audit";
}

function taskArtifactsRoot(rootDir: string, taskId: string): string {
  const taskRoot = findTaskPackagePath(rootDir, taskId);
  assert.ok(taskRoot, `task package ${taskId} must exist`);
  return path.join(taskRoot, "artifacts");
}

function readRunContext(rootDir: string, result: Record<string, any>): Record<string, any> {
  assert.equal(typeof result.evidenceBundle, "string");
  return readJson(path.join(rootDir, result.evidenceBundle, "context.json"));
}

function assertV2ContextIsHandleOnly(context: Record<string, any> | undefined): void {
  assert.ok(context);
  assert.equal(context.schema, "preset-context/v2");
  for (const forbidden of ["paths", "readScopes", "writeScopes", "outputRoot", "repository"]) {
    assert.equal(Object.hasOwn(context, forbidden), false, `preset-context/v2 must not expose ${forbidden}`);
  }
  assert.equal(context.receipt.semanticFailureFallback, "forbidden");
  assert.equal(typeof context.capabilities, "object");
}

function assertSemanticManifestHasNoPhysicalScopeTokens(canary: CanaryId): void {
  const body = readFileSync(path.join(fixtureRoot, canary, "v3/preset.json"), "utf8");
  for (const forbidden of ["\"reads\"", "\"writes\"", "{{paths", "{{outputRoot", ".harness/", "harness/tasks/"]) {
    assert.equal(body.includes(forbidden), false, `${canary} v3 manifest contains ${forbidden}`);
  }
}

function normalizeBusinessOutput(value: unknown, taskId: string, canary: CanaryId): unknown {
  const cloned = JSON.parse(JSON.stringify(value).split(taskId).join("<task>")) as unknown;
  walkMutable(cloned, (record) => {
    delete record.generatedAt;
    delete record.capturedAt;
    if (canary === "milestone-dossier" && "projection" in record && isRecord(record.projection)) {
      record.projection.path = "<relation-graph-projection>";
    }
  });
  return cloned;
}

function walkMutable(value: unknown, visit: (record: Record<string, any>) => void): void {
  if (Array.isArray(value)) {
    for (const entry of value) walkMutable(entry, visit);
    return;
  }
  if (!isRecord(value)) return;
  visit(value);
  for (const entry of Object.values(value)) walkMutable(entry, visit);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(filename: string): Record<string, any> {
  return JSON.parse(readFileSync(filename, "utf8")) as Record<string, any>;
}

function writeText(rootDir: string, relativePath: string, body: string): void {
  const filename = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(filename, body, "utf8");
}
