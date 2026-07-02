import assert from "node:assert/strict";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("CLI process preset script entrypoint requires authorization and writes evidence", () => {
  withTempRoot((rootDir) => {
    const inspected = runJson(rootDir, ["preset", "inspect", "publish-standard"]);
    assert.equal(inspected.ok, true);
    assert.equal(inspected.preset.kind, "process-action");
    assert.match(inspected.preset.title, /Capability Smoke/u);
    assert.deepEqual(inspected.preset.entrypoints, ["plan", "scaffold"]);

    const unauthorized = runJson(rootDir, ["preset", "action", "publish-standard", "scaffold", "--task", "task-1"], false);
    assert.equal(unauthorized.ok, false);
    assert.equal(unauthorized.error.code, "preset_script_authorization_required");
    assert.equal(unauthorized.report.scriptAuthorized, false);
    assert.equal(unauthorized.evidenceBundle.startsWith(".harness/evidence/presets/publish-standard/"), true);
    assert.equal(existsSync(path.join(rootDir, unauthorized.evidenceBundle, "evidence.json")), true);
    assert.equal(existsSync(path.join(rootDir, "harness/tasks/task-1/artifacts/evidence.json")), false);

    const result = runJson(rootDir, ["preset", "action", "publish-standard", "scaffold", "--task", "task-1", "--allow-scripts"]);

    assert.equal(result.ok, true);
    assert.equal(result.command, "preset-action");
    assert.equal(result.report.scriptAuthorized, true);
    assert.equal(result.generated.some((filePath: string) => filePath.endsWith("references/publish-standard.md")), true);
    assert.equal(result.generated.some((filePath: string) => filePath.endsWith("artifacts/evidence.json")), true);
    assert.equal(result.generated.every((filePath: string) => filePath.startsWith("harness/tasks/task-1/")), true);
    assert.equal(result.evidenceBundle.startsWith(".harness/evidence/presets/publish-standard/"), true);
    assert.equal(existsSync(path.join(rootDir, result.evidenceBundle, "context.json")), true);
    assert.equal(existsSync(path.join(rootDir, result.evidenceBundle, "stdout.txt")), true);
    assert.equal(existsSync(path.join(rootDir, result.evidenceBundle, "stderr.txt")), true);
    const scriptEvidence = JSON.parse(readFileSync(path.join(rootDir, "harness/tasks/task-1/artifacts/evidence.json"), "utf8"));
    assert.equal(scriptEvidence.mode, "capability-smoke");
  });
});

test("CLI script command lists, inspects, and runs preset script entries through ScriptHost", () => {
  withTempRoot((rootDir) => {
    const listed = runJson(rootDir, ["script", "list", "--source", "preset", "--purpose", "scaffold"]);

    assert.equal(listed.ok, true);
    assert.equal(listed.command, "script-list");
    assert.equal(listed.scripts.some((script: Record<string, unknown>) => script.id === "preset:publish-standard:scaffold"), true);

    const inspected = runJson(rootDir, ["script", "inspect", "preset:publish-standard:scaffold"]);

    assert.equal(inspected.ok, true);
    assert.equal(inspected.script.id, "preset:publish-standard:scaffold");
    assert.equal(inspected.script.contractVersion, "script-entry/v1");
    assert.deepEqual(inspected.script.writes, ["{{outputRoot}}/**"]);

    const result = runJson(rootDir, ["script", "run", "preset:publish-standard:scaffold", "--task", "task-1"]);

    assert.equal(result.ok, true);
    assert.equal(result.command, "script-run");
    assert.equal(result.script.id, "preset:publish-standard:scaffold");
    assert.equal(result.evidenceBundle.startsWith(".harness/script-runs/"), true);
    assert.equal(result.generated.some((filePath: string) => filePath.endsWith("references/publish-standard.md")), true);
    assert.equal(result.generated.some((filePath: string) => filePath.endsWith("artifacts/evidence.json")), true);
    assert.equal(existsSync(path.join(rootDir, result.evidenceBundle, "context.json")), true);
    assert.equal(existsSync(path.join(rootDir, result.evidenceBundle, "stdout.txt")), true);
    assert.equal(existsSync(path.join(rootDir, result.evidenceBundle, "stderr.txt")), true);
  });
});

test("CLI script command lists, inspects, and runs vertical script entries through ScriptHost", () => {
  withTempRoot((rootDir) => {
    const listed = runJson(rootDir, ["script", "list", "--source", "vertical", "--purpose", "audit"]);

    assert.equal(listed.ok, true);
    assert.equal(listed.command, "script-list");
    assert.equal(listed.scripts.some((script: Record<string, unknown>) => script.id === "vertical:software-coding:repository-audit"), true);

    const inspected = runJson(rootDir, ["script", "inspect", "vertical:software-coding:repository-audit"]);

    assert.equal(inspected.ok, true);
    assert.equal(inspected.script.id, "vertical:software-coding:repository-audit");
    assert.equal(inspected.script.source, "vertical");
    assert.deepEqual(inspected.script.writes, []);

    const result = runJson(rootDir, ["script", "run", "vertical:software-coding:repository-audit"]);

    assert.equal(result.ok, true);
    assert.equal(result.command, "script-run");
    assert.equal(result.script.id, "vertical:software-coding:repository-audit");
    assert.equal(result.report.verticalId, "software/coding");
    assert.deepEqual(result.generated, []);
    assert.equal(existsSync(path.join(rootDir, "harness/decisions")), false);
  });
});

test("CLI script command discovers and runs the vertical ADR seed scaffold", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, ["init"]);
    const listed = runJson(rootDir, ["script", "list", "--source", "vertical", "--purpose", "scaffold"]);

    assert.equal(listed.ok, true);
    assert.equal(listed.scripts.some((script: Record<string, unknown>) => script.id === "vertical:software-coding:adr-seed"), true);

    const inspected = runJson(rootDir, ["script", "inspect", "vertical:software-coding:adr-seed"]);

    assert.equal(inspected.ok, true);
    assert.equal(inspected.script.id, "vertical:software-coding:adr-seed");
    assert.equal(inspected.script.source, "vertical");
    assert.deepEqual(inspected.script.writes, ["{{paths.adrRoot}}/**"]);

    const result = runJson(rootDir, ["script", "run", "vertical:software-coding:adr-seed"]);

    assert.equal(result.ok, true);
    assert.equal(result.command, "script-run");
    assert.equal(result.script.id, "vertical:software-coding:adr-seed");
    assert.equal(result.generated.includes("harness/adr/README.md"), true);
    assert.equal(result.generated.includes("harness/adr/0000-template.md"), true);
    assert.match(readFileSync(path.join(rootDir, "harness/adr/README.md"), "utf8"), /# ADR/u);
    assert.match(readFileSync(path.join(rootDir, "harness/adr/0000-template.md"), "utf8"), /## Decision/u);
  });
});

test("CLI script command runs with an explicit environment allowlist", () => {
  withTempRoot((rootDir) => {
    writeFile(rootDir, ".harness/presets/env-check/preset.json", JSON.stringify({
      schema: "preset-manifest/v2",
      id: "env-check",
      title: "Env Check",
      vertical: "software/coding",
      version: "1.0.0",
      kind: "process-action",
      kernelVersionRange: { min: "1.0.0", maxExclusive: "2.0.0" },
      capabilityImports: [],
      entrypoints: {
        scaffold: { type: "script", command: "scripts/env-check.mjs", writes: ["{{outputRoot}}/**"] }
      },
      profiles: [{
        id: "baseline",
        title: "Baseline",
        checkerProfile: "standard",
        templateSelections: []
      }],
      defaultProfile: "baseline"
    }, null, 2));
    writeFile(rootDir, ".harness/presets/env-check/scripts/env-check.mjs", [
      "#!/usr/bin/env node",
      "import { writeFileSync } from 'node:fs';",
      "const envKeys = Object.keys(process.env).sort();",
      "writeFileSync(process.env.HARNESS_SCRIPT_RESULT, JSON.stringify({",
      "  schema: 'script-result/v1',",
      "  ok: true,",
      "  report: { envKeys, hasHome: Object.hasOwn(process.env, 'HOME') },",
      "  produced: []",
      "}), 'utf8');",
      ""
    ].join("\n"));

    const result = runJson(rootDir, ["script", "run", "preset:env-check:scaffold", "--task", "task-1"]);

    assert.equal(result.ok, true);
    assert.equal(result.report.envKeys.includes("HARNESS_PRESET_CONTEXT"), true);
    assert.equal(result.report.envKeys.includes("HARNESS_SCRIPT_CONTEXT"), true);
    assert.equal(result.report.envKeys.includes("HARNESS_SCRIPT_RESULT"), true);
    assert.equal(result.report.hasHome, false);
    assert.equal(result.report.envKeys.includes("PATH"), false);
    assert.equal(result.report.envKeys.includes("USER"), false);
    assert.equal(result.report.envKeys.every((key: string) => key.startsWith("HARNESS_") || key === "__CF_USER_TEXT_ENCODING"), true);
  });
});

test("CLI script command rejects broad authored entity write roots before execution", () => {
  withTempRoot((rootDir) => {
    writeFile(rootDir, ".harness/presets/task-root-writer/preset.json", JSON.stringify({
      schema: "preset-manifest/v2",
      id: "task-root-writer",
      title: "Task Root Writer",
      vertical: "software/coding",
      version: "1.0.0",
      kind: "process-action",
      kernelVersionRange: { min: "1.0.0", maxExclusive: "2.0.0" },
      capabilityImports: [],
      entrypoints: {
        scaffold: { type: "script", command: "scripts/task-root-writer.mjs", writes: ["{{paths.tasksRoot}}/**"] }
      },
      profiles: [{
        id: "baseline",
        title: "Baseline",
        checkerProfile: "standard",
        templateSelections: []
      }],
      defaultProfile: "baseline"
    }, null, 2));
    writeFile(rootDir, ".harness/presets/task-root-writer/scripts/task-root-writer.mjs", "console.log('should not execute');\n");

    const result = runJson(rootDir, ["script", "run", "preset:task-root-writer:scaffold", "--task", "task-1"], false);

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "script_scope_invalid_write");
    assert.equal(existsSync(path.join(rootDir, "harness/tasks/task-1")), false);
  });
});

test("CLI process preset script entrypoint rejects undeclared output write scope", () => {
  withTempRoot((rootDir) => {
    writeFile(rootDir, ".harness/presets/bad-script/preset.json", JSON.stringify({
      schema: "preset-manifest/v2",
      id: "bad-script",
      title: "Bad Script",
      vertical: "software/coding",
      version: "1.0.0",
      kind: "process-action",
      kernelVersionRange: { min: "1.0.0", maxExclusive: "2.0.0" },
      capabilityImports: [],
      entrypoints: {
        scaffold: { type: "script", command: "scripts/preset-action.mjs", writes: ["{{paths.generatedRoot}}/**"] }
      },
      profiles: [{
        id: "baseline",
        title: "Baseline",
        checkerProfile: "standard",
        templateSelections: []
      }],
      defaultProfile: "baseline"
    }, null, 2));
    writeFile(rootDir, ".harness/presets/bad-script/scripts/preset-action.mjs", [
      "#!/usr/bin/env node",
      "console.log('should not execute');",
      ""
    ].join("\n"));

    const result = runJson(rootDir, ["preset", "action", "bad-script", "scaffold", "--task", "task-1", "--allow-scripts"], false);

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "preset_write_scope_invalid");
    assert.equal(existsSync(path.join(rootDir, ".harness/generated/preset-scripts/bad-script")), false);
  });
});

test("CLI process preset script entrypoint rejects repository-wide declared write scope", () => {
  withTempRoot((rootDir) => {
    writeFile(rootDir, ".harness/presets/root-writer/preset.json", JSON.stringify({
      schema: "preset-manifest/v2",
      id: "root-writer",
      title: "Root Writer",
      vertical: "software/coding",
      version: "1.0.0",
      kind: "process-action",
      kernelVersionRange: { min: "1.0.0", maxExclusive: "2.0.0" },
      capabilityImports: [],
      entrypoints: {
        scaffold: { type: "script", command: "scripts/preset-action.mjs", writes: ["{{paths.rootDir}}/**"] }
      },
      profiles: [{
        id: "baseline",
        title: "Baseline",
        checkerProfile: "standard",
        templateSelections: []
      }],
      defaultProfile: "baseline"
    }, null, 2));
    writeFile(rootDir, ".harness/presets/root-writer/scripts/preset-action.mjs", "console.log('should not execute');\n");

    const result = runJson(rootDir, ["preset", "action", "root-writer", "scaffold", "--task", "task-1", "--allow-scripts"], false);

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "preset_write_scope_invalid");
    assert.equal(existsSync(path.join(rootDir, "harness/tasks/task-1")), false);
  });
});

test("CLI process preset script entrypoint rejects repository-wide recursive read scope", () => {
  withTempRoot((rootDir) => {
    writeFile(rootDir, ".harness/presets/root-reader/preset.json", JSON.stringify({
      schema: "preset-manifest/v2",
      id: "root-reader",
      title: "Root Reader",
      vertical: "software/coding",
      version: "1.0.0",
      kind: "process-action",
      kernelVersionRange: { min: "1.0.0", maxExclusive: "2.0.0" },
      capabilityImports: [],
      entrypoints: {
        scaffold: {
          type: "script",
          command: "scripts/preset-action.mjs",
          reads: ["{{paths.rootDir}}/**"],
          writes: ["{{outputRoot}}/**"]
        }
      },
      profiles: [{
        id: "baseline",
        title: "Baseline",
        checkerProfile: "standard",
        templateSelections: []
      }],
      defaultProfile: "baseline"
    }, null, 2));
    writeFile(rootDir, ".harness/presets/root-reader/scripts/preset-action.mjs", "console.log('should not execute');\n");

    const result = runJson(rootDir, ["preset", "action", "root-reader", "scaffold", "--task", "task-1", "--allow-scripts"], false);

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "preset_read_scope_invalid");
    assert.equal(existsSync(path.join(rootDir, "harness/tasks/task-1")), false);
  });
});

test("CLI process preset script entrypoint blocks out-of-scope filesystem writes", () => {
  withTempRoot((rootDir) => {
    writeFile(rootDir, ".harness/presets/escape-script/preset.json", JSON.stringify({
      schema: "preset-manifest/v2",
      id: "escape-script",
      title: "Escape Script",
      vertical: "software/coding",
      version: "1.0.0",
      kind: "process-action",
      kernelVersionRange: { min: "1.0.0", maxExclusive: "2.0.0" },
      capabilityImports: [],
      entrypoints: {
        scaffold: { type: "script", command: "scripts/preset-action.mjs", writes: ["{{outputRoot}}/**"] }
      },
      profiles: [{
        id: "baseline",
        title: "Baseline",
        checkerProfile: "standard",
        templateSelections: []
      }],
      defaultProfile: "baseline"
    }, null, 2));
    writeFile(rootDir, ".harness/presets/escape-script/scripts/preset-action.mjs", [
      "#!/usr/bin/env node",
      "import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
      "import path from 'node:path';",
      "const context = JSON.parse(readFileSync(process.env.HARNESS_PRESET_CONTEXT, 'utf8'));",
      "mkdirSync(path.join(context.outputRoot, 'artifacts'), { recursive: true });",
      "writeFileSync(path.join(context.outputRoot, 'artifacts/evidence.json'), '{}', 'utf8');",
      "writeFileSync(path.join(context.paths.rootDir, 'escaped.txt'), 'bad', 'utf8');",
      ""
    ].join("\n"));

    const result = runJson(rootDir, ["preset", "action", "escape-script", "scaffold", "--task", "task-1", "--allow-scripts"], false);

    assert.equal(result.ok, false);
    assert.match(result.error.code, /^preset_(read|write)_scope_violation$/u);
    assert.equal(existsSync(path.join(rootDir, "escaped.txt")), false);
  });
});

test("CLI milestone-closeout preset script red-blocks task evidence missing milestone criteria and passes after mapped evidence is complete", () => {
  withTempRoot((rootDir) => {
    writeFile(rootDir, "harness/milestones/m2-5/feature-breakdown.md", [
      "# M2.5 Feature Breakdown",
      "",
      "## Exit Criteria",
      "",
      "- [x] Implemented behavior has source evidence.",
      "- [x] Stub criterion still pending.",
      ""
    ].join("\n"));
    writeFile(rootDir, "harness/tasks/task-closeout/INDEX.md", [
      "---",
      "schema: task-package/v2",
      "task_id: task-closeout",
      "title: Closeout fixture",
      "---",
      "# Closeout fixture",
      ""
    ].join("\n"));
    writeFile(rootDir, "harness/tasks/task-closeout/task_plan.md", [
      "# Plan",
      "",
      "## Task Evidence",
      "",
      "- [x] Implemented behavior has source evidence.",
      ""
    ].join("\n"));

    const unauthorized = runJson(rootDir, ["preset", "action", "milestone-closeout", "check", "--task", "task-closeout"], false);
    assert.equal(unauthorized.error.code, "preset_script_authorization_required");

    const blocked = runJson(rootDir, ["preset", "action", "milestone-closeout", "check", "--task", "task-closeout", "--allow-scripts"], false);

    assert.equal(blocked.ok, false);
    assert.equal(blocked.error.code, "milestone_closeout_blocked");
    assert.equal(blocked.report.status, "blocked");
    assert.equal(blocked.report.criteriaSource, "milestone-feature-breakdown");
    assert.equal(blocked.report.items.some((item: Record<string, unknown>) => item.status === "red" && item.reason === "milestone_criterion_stub_or_placeholder"), true);
    assert.equal(existsSync(path.join(rootDir, "harness/tasks/task-closeout/artifacts/milestone-closeout-report.json")), true);

    writeFile(rootDir, "harness/milestones/m2-5/feature-breakdown.md", [
      "# M2.5 Feature Breakdown",
      "",
      "## Exit Criteria",
      "",
      "- [x] Implemented behavior has source evidence.",
      "- [x] Former open criterion now has source evidence.",
      ""
    ].join("\n"));
    writeFile(rootDir, "harness/tasks/task-closeout/task_plan.md", [
      "# Plan",
      "",
      "## Task Evidence",
      "",
      "- [x] Implemented behavior has source evidence.",
      "- [x] Former open criterion now has source evidence.",
      ""
    ].join("\n"));

    const passed = runJson(rootDir, ["preset", "action", "milestone-closeout", "check", "--task", "task-closeout", "--allow-scripts"]);

    assert.equal(passed.ok, true);
    assert.equal(passed.report.status, "passed");
    assert.equal(passed.report.summary.red, 0);
    assert.equal(passed.report.summary.green, 2);
  });
});

test("CLI legacy-migration preset action plans V2 task discovery and context forward evidence", () => {
  withTempRoot((rootDir) => {
    writeFile(rootDir, "old/.harness-private/coding-agent-harness/harness.yaml", [
      "version: 2",
      "structure:",
      "  harnessRoot: coding-agent-harness",
      "  tasksRoot: coding-agent-harness/tasks",
      ""
    ].join("\n"));
    writeFile(rootDir, "old/.harness-private/coding-agent-harness/tasks/v2-task/INDEX.md", "---\ntitle: V2 Task\nstatus: active\n---\n# V2 Task\n");
    writeFile(rootDir, "old/.harness-private/coding-agent-harness/tasks/v2-task/progress.md", "progress\n");
    writeFile(rootDir, "old/.harness-private/coding-agent-harness/context/architecture/overview.md", "# Architecture\n");

    const result = runJson(rootDir, ["preset", "action", "legacy-migration", "plan", "--task", "task-migration", "--allow-scripts"]);

    assert.equal(result.ok, true);
    assert.equal(result.command, "preset-action");
    assert.equal(result.report.scan.summary.taskCount, 1);
    assert.equal(result.report.scan.entries.some((entry: Record<string, unknown>) => entry.sourcePath === ".harness-private/coding-agent-harness/tasks/v2-task"), true);
    const contextEntry = result.report.scan.entries.find((entry: Record<string, unknown>) => entry.sourcePath === ".harness-private/coding-agent-harness/context/architecture/overview.md");
    assert.equal(contextEntry.forwardPath, "harness/context/architecture/overview.md");
    assert.equal(existsSync(path.join(rootDir, "harness/tasks/task-migration/artifacts/legacy-migration-plan.json")), true);
    assert.match(readFileSync(path.join(rootDir, "harness/tasks/task-migration/artifacts/legacy-migration-plan.md"), "utf8"), /V2 Task/u);
  });
});

function runJson(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true): Record<string, any> {
  try {
    const output = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8"
    });
    const parsed = JSON.parse(output) as Record<string, any>;
    if (expectSuccess) assert.equal(parsed.ok, true, output);
    return unwrapCommandReceipt(parsed);
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return JSON.parse(failure.stdout ?? "{}") as Record<string, any>;
  }
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "harness-preset-script-"));
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function writeFile(rootDir: string, relativePath: string, body: string): void {
  const target = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body, "utf8");
}
