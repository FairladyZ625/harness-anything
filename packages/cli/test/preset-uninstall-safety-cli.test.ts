// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureTestHarnessIdentity } from "./helpers/git-fixtures.ts";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";
import { writeSubstantiveTaskPlan } from "./helpers/task-plan-fixture.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");
const noAgentRuntimeEnv = {
  CLAUDE_SESSION_ID: "",
  CLAUDE_CODE_SESSION_ID: "",
  CODEX_SESSION_ID: "",
  CODEX_THREAD_ID: "",
  ZCODE_SESSION_ID: "",
  ANTIGRAVITY_SESSION_ID: ""
};

test("preset uninstall dry-run emits impact without deleting and declarative active tasks allow apply", () => {
  withFixture("template-content", (fixture) => {
    setTaskStatus(fixture.taskIndexPath, "active");

    const preview = fixture.run(["preset", "uninstall", fixture.presetId, "--dry-run"]);
    assert.equal(preview.ok, true);
    assert.equal(preview.report.mode, "dry-run");
    assert.equal(preview.report.allowed, true);
    assert.equal(preview.report.inboundTaskCount, 1);
    assert.equal(preview.report.tasks[0].reason, "declarative_snapshot_self_contained");
    assert.equal(existsSync(fixture.installedManifestPath), true);

    const applied = fixture.run(["preset", "uninstall", fixture.presetId]);
    assert.equal(applied.ok, true);
    assert.equal(applied.report.mode, "apply");
    assert.equal(applied.report.removed, true);
    assert.equal(existsSync(fixture.installedManifestPath), false);

    const shown = fixture.run(["task", "show", fixture.taskId]);
    assert.equal(shown.report.task.taskId, fixture.taskId);
    const checked = fixture.run(["check", "--profile", "target-project", "--strict"]);
    assert.equal(checked.ok, true);
  });
});

test("preset uninstall fails closed for unsnapshotted inbound tasks and names contract migration", () => {
  withFixture("template-content", (fixture) => {
    rmSync(fixture.taskContractPath, { force: true });

    const blocked = fixture.run(["preset", "uninstall", fixture.presetId], false);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error.code, "preset_uninstall_blocked");
    assert.match(blocked.error.hint, /task contract migrate/u);
    assert.equal(blocked.report.blockerCount, 1);
    assert.equal(blocked.report.tasks[0].reason, "task_contract_snapshot_missing");
    assert.equal(existsSync(fixture.installedManifestPath), true);
  });
});

test("preset uninstall blocks open private-runtime tasks but allows terminal snapshots", () => {
  withFixture("process-action", (fixture) => {
    setTaskStatus(fixture.taskIndexPath, "in_review");
    const blocked = fixture.run(["preset", "uninstall", fixture.presetId, "--dry-run"], false);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error.code, "preset_uninstall_blocked");
    assert.equal(blocked.report.tasks[0].reason, "preset_private_runtime_required");
    assert.match(blocked.error.hint, /finish.*generic action.*retire/iu);
    assert.equal(existsSync(fixture.installedManifestPath), true);

    setTaskStatus(fixture.taskIndexPath, "done");
    const applied = fixture.run(["preset", "uninstall", fixture.presetId]);
    assert.equal(applied.ok, true);
    assert.equal(applied.report.tasks[0].reason, "terminal_snapshot_self_contained");
    assert.equal(existsSync(fixture.installedManifestPath), false);
  });
});

test("preset proprietary run reports frozen runtime identity after uninstall", () => {
  withFixture("process-action", (fixture) => {
    setTaskStatus(fixture.taskIndexPath, "done");
    const applied = fixture.run(["preset", "uninstall", fixture.presetId]);
    assert.equal(applied.ok, true);

    const unavailable = fixture.run([
      "preset",
      "run",
      fixture.presetId,
      "plan",
      "--task",
      fixture.taskId,
      "--allow-scripts"
    ], false);
    assert.equal(unavailable.ok, false);
    assert.equal(unavailable.error.code, "preset_runtime_unavailable");
    assert.match(unavailable.error.hint, new RegExp(`${fixture.presetId}@${fixture.version}`, "u"));
    assert.doesNotMatch(unavailable.error.hint, /task unknown|frontmatter/iu);
  });
});

interface Fixture {
  readonly presetId: string;
  readonly version: string;
  readonly taskId: string;
  readonly taskIndexPath: string;
  readonly taskContractPath: string;
  readonly installedManifestPath: string;
  readonly run: (args: ReadonlyArray<string>, expectSuccess?: boolean) => Record<string, any>;
}

function withFixture(kind: "process-action" | "template-content", fn: (fixture: Fixture) => void): void {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-preset-uninstall-"));
  const userHome = mkdtempSync(path.join(tmpdir(), "ha-preset-uninstall-user-"));
  const presetId = kind === "process-action" ? "private-runtime-task" : "declarative-task";
  const version = "3.4.5";
  const sourceDir = path.join(rootDir, "source-preset");
  const env = {
    ...noAgentRuntimeEnv,
    HARNESS_DAEMON_MODE: "direct",
    HARNESS_USER_HOME: userHome,
    HARNESS_ACTOR: "agent:preset-uninstall-test"
  };
  const run = (args: ReadonlyArray<string>, expectSuccess = true) => runJson(rootDir, args, expectSuccess, env);
  try {
    run(["init"]);
    ensureTestHarnessIdentity(path.join(rootDir, "harness"));
    writeFileSync(path.join(rootDir, "harness", "harness.yaml"), [
      "schema: harness-anything/v1",
      "name: fixture",
      "settings:",
      "  identity:",
      "    personId: person_fixture",
      "    displayName: Fixture",
      "  locale: en-US",
      "  defaultVertical: software/coding",
      "  defaultPreset: standard-task",
      ""
    ].join("\n"), "utf8");
    writePresetSource(sourceDir, presetId, version, kind);
    run(["preset", "install", sourceDir]);
    const created = run([
      "task",
      "create",
      "--title",
      `${kind} fixture`,
      "--vertical",
      "software/coding",
      "--preset",
      presetId
    ]);
    writeSubstantiveTaskPlan(rootDir, String(created.packagePath));
    const taskPackagePath = path.join(rootDir, String(created.packagePath));
    fn({
      presetId,
      version,
      taskId: String(created.taskId),
      taskIndexPath: path.join(taskPackagePath, "INDEX.md"),
      taskContractPath: path.join(taskPackagePath, "task-contract.json"),
      installedManifestPath: path.join(userHome, "presets", presetId, "preset.json"),
      run
    });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(userHome, { recursive: true, force: true });
  }
}

function writePresetSource(
  sourceDir: string,
  presetId: string,
  version: string,
  kind: "process-action" | "template-content"
): void {
  const manifest = {
    schema: "preset-manifest/v2",
    id: presetId,
    title: `${kind} Fixture`,
    vertical: "software/coding",
    version,
    kind,
    kernelVersionRange: { min: "1.0.0", maxExclusive: "2.0.0" },
    capabilityImports: [],
    ...(kind === "process-action" ? {
      entrypoints: { plan: { type: "script", command: "scripts/plan.mjs", reads: [], writes: [] } }
    } : {}),
    profiles: [{
      id: "baseline",
      title: "Baseline",
      checkerProfile: "standard",
      completionGates: [],
      templateSelections: []
    }],
    defaultProfile: "baseline"
  };
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(path.join(sourceDir, "preset.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function setTaskStatus(indexPath: string, status: string): void {
  const body = readFileSync(indexPath, "utf8");
  writeFileSync(indexPath, body.replace(/^  status: .*$/mu, `  status: ${status}`), "utf8");
}

function runJson(
  rootDir: string,
  args: ReadonlyArray<string>,
  expectSuccess: boolean,
  env: NodeJS.ProcessEnv
): Record<string, any> {
  try {
    const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env }
    });
    return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return unwrapCommandReceipt(JSON.parse(failure.stdout ?? "{}") as Record<string, any>);
  }
}
