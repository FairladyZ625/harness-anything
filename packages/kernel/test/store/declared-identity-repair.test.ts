// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  inspectDeclaredIdentityState,
  repairDeclaredIdentityState
} from "../../src/index.ts";
import { withTempStore } from "./helpers.ts";

const taskId = "task_01KZ6MD2SMMHH91WC3RMRPV4P0";
const taskIdB = "task_01KZ6MD2SMMHH91WC3RMRPV4P1";
const executionId = "exe_01KXQ4WTA7Q4XJ5GDDRS1YXNG5";
const consentId = "cns_01KXQ4WTA7Q4XJ5GDDRS1YXNG5";

test("declared identity repair does not let a stale higher-state duplicate overwrite canonical", () => {
  withTempStore((rootDir) => {
    writeIndex(rootDir, `${taskId}-live`, taskId);
    writeExecution(rootDir, `${taskId}-live`, taskId, "active");
    writeExecution(rootDir, taskId, taskId, "changes_requested");
    const canonicalPath = path.join(rootDir, "harness/tasks", `${taskId}-live/executions/${executionId}.md`);
    const canonicalBody = readFileSync(canonicalPath, "utf8");

    const report = repairDeclaredIdentityState(rootDir);

    assert.equal(report.unresolved.length, 1, JSON.stringify(report));
    assert.equal(report.changed, false, JSON.stringify(report));
    assert.equal(readFileSync(canonicalPath, "utf8"), canonicalBody);
    assert.equal(existsSync(path.join(rootDir, "harness/tasks", `${taskId}/executions/${executionId}.md`)), true);
  });
});

test("unknown declared lifecycle state is unresolved instead of scoring as zero", () => {
  withTempStore((rootDir) => {
    writeIndex(rootDir, `${taskId}-live`, taskId);
    writeConsent(rootDir, `${taskId}-live`, taskId);
    writeConsent(rootDir, taskId, taskId);

    const report = repairDeclaredIdentityState(rootDir);

    assert.equal(report.unresolved.length, 1, JSON.stringify(report));
    assert.equal(report.changed, false, JSON.stringify(report));
  });
});

test("repeated repair preserves every quarantine body instead of replacing an old quarantine", () => {
  withTempStore((rootDir) => {
    writeIndex(rootDir, `${taskId}-live`, taskId);
    writeExecution(rootDir, `${taskId}-live`, taskId, "active");
    writeExecution(rootDir, taskId, taskId, "active");

    repairDeclaredIdentityState(rootDir);
    writeExecution(rootDir, taskId, taskId, "active");
    repairDeclaredIdentityState(rootDir);

    const quarantineRoot = path.join(rootDir, "harness/.repair/declared-identity");
    assert.equal(listFiles(quarantineRoot).length, 2);
  });
});

test("identity inspection reports every canonical candidate when an identity has divergent canonical paths", () => {
  withTempStore((rootDir) => {
    writeIndex(rootDir, `${taskId}-one`, taskId);
    writeIndex(rootDir, `${taskIdB}-two`, taskIdB);
    writeExecution(rootDir, `${taskId}-one`, taskId, "active");
    writeExecution(rootDir, `${taskIdB}-two`, taskIdB, "active");

    const inspection = inspectDeclaredIdentityState(rootDir);
    assert.equal(inspection.conflicts.length, 1, JSON.stringify(inspection));
    assert.deepEqual(inspection.conflicts[0]?.canonicalSourcePaths, [
      `tasks/${taskId}-one/executions/${executionId}.md`,
      `tasks/${taskIdB}-two/executions/${executionId}.md`
    ]);
    assert.equal(inspection.conflicts[0]?.canonicalSourcePath, null);
  });
});

test("identity repair refuses a symlinked source path before touching its target", () => {
  withTempStore((rootDir) => {
    writeIndex(rootDir, `${taskId}-live`, taskId);
    writeExecution(rootDir, `${taskId}-live`, taskId, "active");
    const outsideRoot = path.join(rootDir, "outside");
    const outsidePath = path.join(outsideRoot, `${executionId}.md`);
    mkdirSync(outsideRoot, { recursive: true });
    const canonicalPath = path.join(rootDir, "harness/tasks", `${taskId}-live/executions/${executionId}.md`);
    writeFileSync(outsidePath, readFileSync(canonicalPath), "utf8");
    const sourceRoot = path.join(rootDir, "harness/tasks", taskId, "executions");
    mkdirSync(sourceRoot, { recursive: true });
    symlinkSync(outsidePath, path.join(sourceRoot, `${executionId}.md`));
    const outsideBody = readFileSync(outsidePath, "utf8");

    assert.throws(() => repairDeclaredIdentityState(rootDir), /symbolic link/u);
    assert.equal(readFileSync(outsidePath, "utf8"), outsideBody);
  });
});

function writeIndex(rootDir: string, directoryName: string, taskIdValue: string): void {
  const taskRoot = path.join(rootDir, "harness/tasks", directoryName);
  mkdirSync(taskRoot, { recursive: true });
  writeFileSync(path.join(taskRoot, "INDEX.md"), [
    "---",
    "schema: task-package/v2",
    `task_id: ${taskIdValue}`,
    `title: ${directoryName}`,
    "lifecycle:",
    "  bindingSchema: lifecycle-binding/v1",
    "  engine: local",
    "  status: active",
    "  ref: ",
    "  titleSnapshot: fixture",
    "  url: ",
    "  bindingCreatedAt: 2026-08-05T00:00:00.000Z",
    "  bindingFingerprint: sha256:fixture",
    "packageDisposition: active",
    "vertical: software/coding",
    "preset: standard-task",
    "provenance:",
    "  - {runtime: human, sessionId: fixture, boundAt: 2026-08-05T00:00:00.000Z}",
    "---",
    "",
    `# ${directoryName}`,
    ""
  ].join("\n"), "utf8");
}

function writeExecution(rootDir: string, directoryName: string, taskIdValue: string, state: string): void {
  const executionRoot = path.join(rootDir, "harness/tasks", directoryName, "executions");
  mkdirSync(executionRoot, { recursive: true });
  writeFileSync(path.join(executionRoot, `${executionId}.md`), `${JSON.stringify({
    schema: "execution/v2",
    execution_id: executionId,
    task_ref: `task/${taskIdValue}`,
    state,
    primary_actor: {
      principal: { personId: "person_fixture" },
      executor: { kind: "agent", id: "fixture" },
      responsibleHuman: "person_fixture"
    },
    claimed_at: "2026-08-05T00:00:00.000Z",
    submitted_at: null,
    closed_at: null,
    session_bindings: [],
    outputs: [],
    submission: null
  }, null, 2)}\n`, "utf8");
}

function writeConsent(rootDir: string, directoryName: string, taskIdValue: string): void {
  const consentRoot = path.join(rootDir, "harness/tasks", directoryName, "consents");
  mkdirSync(consentRoot, { recursive: true });
  writeFileSync(path.join(consentRoot, `${consentId}.md`), `${JSON.stringify({
    schema: "consent/v2",
    consent_id: consentId,
    task_ref: `task/${taskIdValue}`,
    execution_ref: `execution/${taskIdValue}/${executionId}`,
    principal: { personId: "person_fixture" },
    scope: {
      actions: ["approve_execution"],
      content_pin: { algorithm: "execution-consent-pin/v1", digest: `sha256:${"b".repeat(64)}` }
    },
    disclosure: { completion_claim: "ready", known_gaps: [], residual_risks: [] },
    channel: { kind: "agent-relayed", assurance: "relayed-assertion" },
    response: { kind: "authorization-declaration", source: "asserted" },
    source: { strength: "asserted", rationale: "Fixture consent source." },
    recorded_by: {
      principal: { personId: "person_fixture" },
      executor: { kind: "agent", id: "fixture" },
      responsibleHuman: "person_fixture"
    },
    granted_at: "2026-08-05T00:00:00.000Z",
    expires_at: "2026-08-06T00:00:00.000Z",
    state: "open",
    consumed_by: null,
    consumed_at: null
  }, null, 2)}\n`, "utf8");
}

function listFiles(rootDir: string): ReadonlyArray<string> {
  if (!existsSync(rootDir)) return [];
  return readdirSync(rootDir, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(rootDir, entry.name);
    return entry.isDirectory() ? listFiles(child).map((file) => path.join(entry.name, file)) : [entry.name];
  });
}
