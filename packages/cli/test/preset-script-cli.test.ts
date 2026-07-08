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

    const result = runJson(rootDir, ["preset", "action", "publish-standard", "scaffold", "--task", "task-1", "--allow-scripts", "--input", "mode=agent-smoke"]);

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
    assert.equal(scriptEvidence.mode, "agent-smoke");
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

test("CLI script command lists decision conformance as a vertical check script", () => {
  withTempRoot((rootDir) => {
    const listed = runJson(rootDir, ["script", "list", "--source", "vertical", "--kind", "check"]);
    assert.equal(listed.ok, true);
    assert.equal(listed.command, "script-list");
    assert.equal(listed.scripts.some((script: Record<string, unknown>) => script.id === "vertical:software-coding:decision-conformance" && script.kind === "check" && script.purpose === "audit"), true);
  });
});

test("CLI check runs decision conformance scripts and fails closed on accepted decisions without task edges", () => {
  withTempRoot((rootDir) => {
    runJson(rootDir, ["init"]);
    const task = runJson(rootDir, ["task", "create", "--title", "Conformance Implementation"]);
    runJson(rootDir, [
      "fact", "record",
      "--task", task.taskId,
      "--id", "F-C123ABCD",
      "--statement", "The conformance fixture covers the accepted decision claim.",
      "--source", "test",
      "--confidence", "high"
    ]);
    runJson(rootDir, [
      "decision", "propose",
      "--id", "dec_CONFORMANCE_EDGE",
      "--title", "Conformance Edge",
      "--question", "Should accepted decisions derive work?",
      "--chosen", "Accepted decisions derive work",
      "--rejected", "Leave accepted decisions unbound",
      "--why-not", "The milestone loop needs task or defer closure",
      "--evidence-relation", `C1:evidenced-by:fact/${task.taskId}/F-C123ABCD:Fact covers the accepted conformance claim`
    ]);
    runJson(rootDir, ["decision", "accept", "dec_CONFORMANCE_EDGE", "--arbiter", "human:ZeyuLi"]);
    const failed = runJson(rootDir, ["check", "--profile", "source-package"], false);
    assert.equal(failed.ok, false);
    assert.equal(failed.error.code, "check_profile_failed");
    assert.equal(failed.warnings.some((warning: Record<string, unknown>) => (
      warning.source === "vertical-check:vertical:software-coding:decision-conformance" &&
      warning.code === "accepted-decision-missing-task-or-defer" &&
      String(warning.message).includes("decision/dec_CONFORMANCE_EDGE")
    )), true);
    assert.equal(failed.report.scriptChecks.some((entry: Record<string, any>) => (
      entry.scriptId === "vertical:software-coding:decision-conformance" &&
      entry.report?.summary?.findingCount > 0
    )), true);

    runJson(rootDir, [
      "decision", "relate", "dec_CONFORMANCE_EDGE",
      "--anchor", "CH1",
      "--type", "derives",
      "--target", `task/${task.taskId}`,
      "--rationale", "Accepted conformance decision derives implementation work"
    ]);

    const passed = runJson(rootDir, ["check", "--profile", "source-package"]);
    assert.equal(passed.ok, true);
    assert.equal(passed.report.scriptChecks.some((entry: Record<string, any>) => (
      entry.scriptId === "vertical:software-coding:decision-conformance" &&
      entry.report?.summary?.findingCount === 0
    )), true);
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
    // adr/README.md is materialized by init's seededDoc (single source, ADR-0021 D1);
    // adr-seed now only produces the ADR template stub, not the README.
    assert.equal(result.generated.includes("harness/adr/0000-template.md"), true);
    assert.equal(result.generated.includes("harness/adr/README.md"), false);
    assert.match(readFileSync(path.join(rootDir, "harness/adr/0000-template.md"), "utf8"), /## Decision/u);
  });
});

test("CLI script command renders an ADR from a decision entity, reuses the number, and preserves the human block", () => {
  withTempRoot((rootDir) => {
    writeDecisionFixture(rootDir, "dec_ADR_RENDER_FIXTURE");

    const inspected = runJson(rootDir, ["script", "inspect", "vertical:software-coding:adr-render"]);
    assert.equal(inspected.ok, true);
    assert.equal(inspected.script.source, "vertical");
    assert.equal(inspected.script.purpose, "generate");
    assert.deepEqual(inspected.script.reads, ["{{paths.decisionsRoot}}/**", "{{paths.adrRoot}}/**"]);
    assert.deepEqual(inspected.script.writes, ["{{paths.adrRoot}}/**"]);

    const listed = runJson(rootDir, ["script", "list", "--source", "vertical", "--purpose", "generate"]);
    assert.equal(listed.scripts.some((script: Record<string, unknown>) => script.id === "vertical:software-coding:adr-render"), true);

    const result = runJson(rootDir, ["script", "run", "vertical:software-coding:adr-render", "--input", "decisionId=dec_ADR_RENDER_FIXTURE"]);
    assert.equal(result.ok, true);
    assert.equal(result.report.decisionId, "dec_ADR_RENDER_FIXTURE");
    assert.equal(result.report.reused, false);
    assert.equal(result.report.watermark, "wm-1");
    const adrRelPath = result.report.adrPath as string;
    assert.match(adrRelPath, /^harness\/adr\/ADR-0000-/u);

    const adrPath = path.join(rootDir, adrRelPath);
    const rendered = readFileSync(adrPath, "utf8");
    // D8: never writes decisionsRoot; only adrRoot.
    assert.equal(result.generated.every((filePath: string) => filePath.startsWith("harness/adr/")), true);
    // Machine sentinel carries decision id + watermark.
    assert.match(rendered, /<!-- adr-render:begin machine \(decision dec_ADR_RENDER_FIXTURE @ wm-1\) -->/u);
    // Status ← state + decidedAt + decision anchor.
    assert.match(rendered, /Accepted 2026-07-04T00:00:00\.000Z/u);
    assert.match(rendered, /Decision 锚：`dec_ADR_RENDER_FIXTURE`（active）/u);
    // Decision ← chosen + rejected.why_not.
    assert.match(rendered, /### CH1 · chosen anchor text/u);
    assert.match(rendered, /否决理由：rejected because drift/u);
    // Consequences ← claims + relations.
    assert.match(rendered, /- C1：claim anchor text/u);
    assert.match(rendered, /derives → task\/task_FIXTURE/u);
    // Human block present.
    assert.match(rendered, /<!-- adr-render:human -->/u);

    // Inject manual narrative, rerun: number reused, machine block byte-stable, human preserved.
    const machineBefore = sliceMachineBlock(rendered);
    writeFileSync(adrPath, rendered.replace("此处人工补充", "MANUAL-NARRATIVE-SENTINEL"), "utf8");
    const rerun = runJson(rootDir, ["script", "run", "vertical:software-coding:adr-render", "--input", "decisionId=dec_ADR_RENDER_FIXTURE"]);
    assert.equal(rerun.report.reused, true);
    assert.equal((rerun.report.adrPath as string), adrRelPath);
    const rerendered = readFileSync(adrPath, "utf8");
    assert.equal(sliceMachineBlock(rerendered), machineBefore);
    assert.match(rerendered, /MANUAL-NARRATIVE-SENTINEL/u);
  });
});

function writeDecisionFixture(rootDir: string, decisionId: string): void {
  writeFile(rootDir, `harness/decisions/decision-${decisionId}/decision.md`, [
    "---",
    "schema: decision-package/v1",
    `decision_id: ${decisionId}`,
    "_coordinatorWatermark: wm-1",
    "title: \"Fixture decision for ADR render\"",
    "state: active",
    "riskTier: medium",
    "urgency: medium",
    "vertical: \"software/coding\"",
    "preset: \"architecture-decision\"",
    "applies_to:",
    "  modules: []",
    "  productLines: []",
    "proposedBy: { kind: \"agent\", id: \"claude-opus\" }",
    "proposedAt: \"2026-07-04T00:00:00.000Z\"",
    "arbiter: { kind: \"human\", id: \"zeyuli\" }",
    "decidedAt: \"2026-07-04T00:00:00.000Z\"",
    "provenance:",
    "  - { runtime: \"claude-code\", sessionId: \"session-fixture\", boundAt: \"2026-07-04T00:00:00.000Z\" }",
    "question: \"what is the fixture question?\"",
    "chosen:",
    "  - { id: \"CH1\", text: \"chosen anchor text\" }",
    "rejected:",
    "  - { id: \"RJ1\", text: \"rejected anchor text\", why_not: \"rejected because drift\" }",
    "claims:",
    "  - { id: \"C1\", text: \"claim anchor text\" }",
    "relations:",
    "  - { relation_id: \"rel_0000000000000000\", source: \"decision/dec_ADR_RENDER_FIXTURE/CH1\", target: \"task/task_FIXTURE\", type: \"derives\", strength: \"strong\", direction: \"directed\", origin: \"declared\", rationale: \"fixture relation\", state: \"active\" }",
    "---",
    "",
    "# Fixture decision for ADR render",
    ""
  ].join("\n"));
}

function sliceMachineBlock(body: string): string {
  const begin = body.indexOf("<!-- adr-render:begin machine");
  const endMarker = "<!-- adr-render:end machine -->";
  const end = body.indexOf(endMarker);
  return body.slice(begin, end + endMarker.length);
}

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
    if (process.platform !== "win32") assert.equal(result.report.hasHome, false);
    if (process.platform !== "win32") assert.equal(result.report.envKeys.includes("PATH"), false);
    assert.equal(result.report.envKeys.includes("USER"), false);
    assert.equal(result.report.envKeys.every((key: string) =>
      key.startsWith("HARNESS_") ||
      key === "__CF_USER_TEXT_ENCODING" ||
      (process.platform === "win32" && [
        "HOMEDRIVE",
        "HOMEPATH",
        "LOGONSERVER",
        "PATH",
        "SYSTEMDRIVE",
        "SYSTEMROOT",
        "TEMP",
        "USERDOMAIN",
        "USERNAME",
        "USERPROFILE",
        "WINDIR"
      ].includes(key.toUpperCase()))
    ), true);
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

test("CLI process preset script entrypoint directly rejects localRoot write scope", () => {
  withTempRoot((rootDir) => {
    writeFile(rootDir, ".harness/presets/local-root-writer/preset.json", JSON.stringify({
      schema: "preset-manifest/v2",
      id: "local-root-writer",
      title: "Local Root Writer",
      vertical: "software/coding",
      version: "1.0.0",
      kind: "process-action",
      kernelVersionRange: { min: "1.0.0", maxExclusive: "2.0.0" },
      capabilityImports: [],
      entrypoints: {
        scaffold: { type: "script", command: "scripts/preset-action.mjs", writes: ["{{paths.localRoot}}"] }
      },
      profiles: [{
        id: "baseline",
        title: "Baseline",
        checkerProfile: "standard",
        templateSelections: []
      }],
      defaultProfile: "baseline"
    }, null, 2));
    writeFile(rootDir, ".harness/presets/local-root-writer/scripts/preset-action.mjs", "console.log('should not execute');\n");

    const result = runJson(rootDir, ["preset", "action", "local-root-writer", "scaffold", "--task", "task-1", "--allow-scripts"], false);

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "preset_write_scope_invalid");
    assert.equal(existsSync(path.join(rootDir, ".harness/preset-scripts")), false);
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

test("CLI doc-canon-sync preset reports canonical drift into task artifacts", () => {
  withTempRoot((rootDir) => {
    writeFile(rootDir, "harness/tasks/task-doc-sync/INDEX.md", [
      "---",
      "schema: task-package/v2",
      "task_id: task-doc-sync",
      "title: Doc canon sync fixture",
      "---",
      "# Doc canon sync fixture",
      ""
    ].join("\n"));
    writeFile(rootDir, "harness/AGENTS.md", [
      "# Local Agent Entry",
      "",
      "<!-- canon-synced-through: dec_OLD @ 2026-07-01T00:00:00.000Z -->",
      "",
      "Use task packages for work tracking.",
      ""
    ].join("\n"));
    writeFile(rootDir, "harness/governance/standards/ops.md", [
      "# Ops",
      "",
      "Task workflow remains the only documented path.",
      ""
    ].join("\n"));
    writeFile(rootDir, "harness/decisions/decision-dec_M5_E76_CLI_AGENT_ERGONOMICS/decision.md", [
      "---",
      "schema: decision-package/v1",
      "decision_id: dec_M5_E76_CLI_AGENT_ERGONOMICS",
      "title: E76 CLI agent ergonomics",
      "state: active",
      "decidedAt: 2026-07-04T02:01:45.822Z",
      "---",
      "# E76 CLI agent ergonomics",
      ""
    ].join("\n"));
    writeFile(rootDir, "harness/decisions/decision-dec_M5_OLD_RETIRED/decision.md", [
      "---",
      "schema: decision-package/v1",
      "decision_id: dec_M5_OLD_RETIRED",
      "title: Retired decision",
      "state: retired",
      "decidedAt: 2026-07-04T02:01:45.822Z",
      "---",
      "# Retired decision",
      ""
    ].join("\n"));
    writeFile(rootDir, "harness/adr/ADR-0019-entity-crud-framework.md", [
      "---",
      "id: ADR-0019",
      "status: accepted",
      "date: 2026-07-04",
      "title: Entity CRUD Framework",
      "---",
      "# Entity CRUD Framework",
      ""
    ].join("\n"));

    const unauthorized = runJson(rootDir, ["preset", "action", "doc-canon-sync", "check", "--task", "task-doc-sync"], false);
    assert.equal(unauthorized.ok, false);
    assert.equal(unauthorized.error.code, "preset_script_authorization_required");

    const blocked = runJson(rootDir, ["preset", "action", "doc-canon-sync", "check", "--task", "task-doc-sync", "--allow-scripts"], false);

    assert.equal(blocked.ok, false);
    assert.equal(blocked.error.code, "preset_script_result_failed");
    assert.equal(blocked.report.status, "blocked");
    assert.equal(blocked.report.summary.red, 2);
    assert.equal(blocked.report.drift.some((item: Record<string, unknown>) => item.canonicalId === "dec_M5_E76_CLI_AGENT_ERGONOMICS"), true);
    assert.equal(blocked.report.drift.some((item: Record<string, unknown>) => item.canonicalId === "ADR-0019"), true);
    assert.equal(blocked.report.drift.some((item: Record<string, unknown>) => item.canonicalId === "dec_M5_OLD_RETIRED"), false);
    assert.equal(blocked.report.warnings.some((item: Record<string, unknown>) => item.code === "task_only_workflow_smell"), true);
    assert.equal(existsSync(path.join(rootDir, "harness/tasks/task-doc-sync/artifacts/doc-canon-drift.json")), true);
    assert.match(readFileSync(path.join(rootDir, "harness/tasks/task-doc-sync/artifacts/doc-canon-drift.md"), "utf8"), /dec_M5_E76_CLI_AGENT_ERGONOMICS/u);
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
    return unwrapCommandReceipt(JSON.parse(failure.stdout ?? "{}") as Record<string, any>);
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
