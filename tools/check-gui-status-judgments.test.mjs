// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkGuiStatusJudgments,
  scanGuiStatusJudgments
} from "./check-gui-status-judgments.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("required positive controls are detected in the repository", () => {
  const sites = scanGuiStatusJudgments(repoRoot);
  const has = (file, fragment) => sites.some((site) => site.path === file && site.content.includes(fragment));
  assert.equal(has("packages/gui/src/renderer/views/DecisionPoolView.tsx", '["proposed", "rejected", "deferred"]'), true);
  assert.equal(has("packages/gui/src/renderer/views/DecisionPoolView.tsx", '["proposed", "active", "retired"]'), true);
  assert.equal(has("packages/gui/src/renderer/views/DecisionPoolView.tsx", 'decision.state === "outcome_retired"'), true);
  assert.equal(has("packages/gui/src/renderer/App.tsx", 'd.state === "proposed"'), true);
  assert.equal(has("packages/gui/src/renderer/model/taskFilters.ts", 'task.packageDisposition !== "active"'), true);
  assert.equal(has("packages/gui/src/renderer/model/taskFilters.ts", 'task.coordinationStatus === "cancelled"'), true);
});

test("registry-derived detector needs no hand-written status words or file list", () => {
  withFixture({
    "packages/gui/src/new-panel.ts": 'type TimewarpState = "before" | "after";\nexport const order: TimewarpState[] = ["before", "after"];\n'
  }, (root) => {
    const register = [
      { id: "timewarp.state", entity: "Task", field: "state", module: "packages/kernel/src/domain/timewarp.ts", anchor: "timewarpStates", words: ["before", "after"] }
    ];
    const sites = scanGuiStatusJudgments(root, register);
    assert.equal(sites.length, 1);
    assert.deepEqual(sites[0].words, ["after", "before"]);
  });
});

test("negative controls exclude mirrors, response validators, presentation props, and non-domain homonyms", () => {
  withFixture({
    "packages/gui/src/model/types.ts": 'export type DecisionState = "proposed" | "rejected";\n',
    "packages/gui/src/api-client.ts": 'type ProjectionRead = { status: "ready" | "pending" };\ntype Receipt = { outcome: "applied" | "pending" | "op_rejected" };\nexport function read(value: ProjectionRead, receipt: Receipt) { if ((value.status !== "ready" && value.status !== "pending") || !["applied", "pending", "op_rejected"].includes(receipt.outcome)) throw new Error(); return value; }\n',
    "packages/gui/src/presentation.tsx": 'declare const Badge: (p: { status: string }) => unknown;\nexport const badge = <Badge status="proposed" />;\n',
    "packages/gui/src/promise.ts": 'export function consume(result: PromiseSettledResult<unknown>) { return result.status === "rejected"; }\n'
  }, (root) => {
    const register = [
      { id: "decision.state", entity: "Decision", field: "state", module: "packages/kernel/src/domain/decision.ts", anchor: "decisionStates", words: ["proposed", "rejected"] },
      { id: "task-blocking.availability", entity: "Task", field: "blocking projection availability", module: "packages/kernel/src/domain/task-blocking.ts", anchor: "BlockingAvailabilityState", words: ["ready", "pending"] },
      { id: "receipt.outcome", entity: "WriteReceipt", field: "outcome", module: "packages/kernel/src/domain/write.ts", anchor: "outcomes", words: ["applied", "pending", "op_rejected"] },
      { id: "gui.decision.state", entity: "GuiAdapter", field: "state", module: "packages/gui/src/model/types.ts", anchor: "DecisionState", words: ["proposed", "rejected"], mirrorOf: "decision.state" }
    ];
    assert.deepEqual(scanGuiStatusJudgments(root, register), []);
  });
});

test("entity standing stays in scope while operation outcomes stay outside it", () => {
  withFixture({
    "packages/gui/src/panel.ts": 'type RuntimeLiveness = "live" | "exited";\ntype ReceiptOutcome = "applied" | "pending";\ntype WitnessResult = "pass";\nexport const live = (session: RuntimeLiveness) => session === "live";\nexport const valid = (receipt: ReceiptOutcome) => receipt === "applied";\nexport const witnessed = (result: WitnessResult) => result === "pass";\n'
  }, (root) => {
    const register = [
      { id: "runtime.liveness", entity: "RuntimeSession", field: "liveness", module: "packages/kernel/src/domain/runtime.ts", anchor: "runtimeLiveness", words: ["live", "exited"] },
      { id: "receipt.outcome", entity: "WriteReceipt", field: "outcome", module: "packages/kernel/src/domain/write.ts", anchor: "receiptOutcomes", words: ["applied", "pending"] },
      { id: "task.gate-witness", entity: "Task", field: "gate witness result", module: "packages/kernel/src/domain/task.ts", anchor: "#result", words: ["pass"] }
    ];
    const sites = scanGuiStatusJudgments(root, register);
    assert.equal(sites.length, 1);
    assert.deepEqual(sites[0].words, ["live"]);
  });
});

test("complete vocabulary mirrors are observed but do not need a baseline exemption", () => {
  withFixture({
    "packages/gui/src/panel.ts": 'type TaskStatus = "active" | "blocked";\nexport const all: TaskStatus[] = ["active", "blocked"];\n'
  }, (root) => {
    const register = [
      { id: "task.status", entity: "Task", field: "status", module: "packages/kernel/src/domain/task.ts", anchor: "taskStatuses", words: ["active", "blocked"] }
    ];
    const sites = scanGuiStatusJudgments(root, register);
    assert.equal(sites.length, 1);
    assert.equal(sites[0].shape, "complete-mirror");
    assert.equal(sites[0].classification, "registry-mirror");
    assert.deepEqual(checkGuiStatusJudgments(sites, []), []);
  });
});

test("structurally pure display branching does not need a baseline exemption", () => {
  withFixture({
    "packages/gui/src/panel.tsx": 'type TaskStatus = "active" | "blocked";\nexport const Panel = ({ status }: { status: TaskStatus }) => <div>{status === "active" && <span>active</span>}</div>;\n'
  }, (root) => {
    const register = [
      { id: "task.status", entity: "Task", field: "status", module: "packages/kernel/src/domain/task.ts", anchor: "taskStatuses", words: ["active", "blocked"] }
    ];
    const sites = scanGuiStatusJudgments(root, register);
    assert.equal(sites.length, 1);
    assert.equal(sites[0].classification, "display-only");
    assert.deepEqual(checkGuiStatusJudgments(sites, []), []);
  });
});

test("line movement keeps identity while new same-shape judgment and content mutation fail", () => {
  const register = [
    { id: "task.status", entity: "Task", field: "status", module: "packages/kernel/src/domain/task.ts", anchor: "taskStatuses", words: ["active", "blocked"] }
  ];
  withFixture({
    "packages/gui/src/panel.ts": 'type TaskStatus = "active" | "blocked";\nexport const visible = (status: TaskStatus) => status === "active";\n'
  }, (root) => {
    const original = scanGuiStatusJudgments(root, register);
    assert.equal(original.length, 1);
    assert.match(checkGuiStatusJudgments(original, [])[0], /new GUI status judgment/u);
    const baseline = [{ key: original[0].key, classification: "domain-judgment" }];
    assert.deepEqual(checkGuiStatusJudgments(original, baseline), []);

    writeFileSync(path.join(root, "packages/gui/src/panel.ts"), '\ntype TaskStatus = "active" | "blocked";\nexport const visible = (status: TaskStatus) => status === "active";\n');
    const moved = scanGuiStatusJudgments(root, register);
    assert.equal(moved[0].key, original[0].key);
    assert.equal(moved[0].line, original[0].line + 1);
    assert.deepEqual(checkGuiStatusJudgments(moved, baseline), []);

    writeFileSync(path.join(root, "packages/gui/src/panel.ts"), 'type TaskStatus = "active" | "blocked";\nexport const visible = (status: TaskStatus) => status === "blocked";\n');
    const mutated = scanGuiStatusJudgments(root, register);
    const findings = checkGuiStatusJudgments(mutated, baseline);
    assert.ok(findings.some((finding) => finding.includes("new GUI status judgment")), findings.join("\n"));
    assert.ok(findings.some((finding) => finding.includes("stale baseline entry")), findings.join("\n"));
  });
});

test("semantic scopes distinguish delete-and-add movement of identical sites without line coordinates", () => {
  const register = [
    { id: "task.status", entity: "Task", field: "status", module: "packages/kernel/src/domain/task.ts", anchor: "taskStatuses", words: ["active", "blocked"] }
  ];
  withFixture({
    "packages/gui/src/panel.ts": 'export function first(status: string) { return status === "active"; }\nexport function second(status: string) { return status === "active"; }\n'
  }, (root) => {
    const original = scanGuiStatusJudgments(root, register);
    assert.equal(original.length, 2);
    assert.notEqual(original[0].key, original[1].key);
    const baseline = original.map((site) => ({ key: site.key, classification: "domain-judgment" }));

    writeFileSync(path.join(root, "packages/gui/src/panel.ts"), 'export function second(status: string) { return status === "active"; }\nexport function third(status: string) { return status === "active"; }\n');
    const findings = checkGuiStatusJudgments(scanGuiStatusJudgments(root, register), baseline);
    assert.equal(findings.filter((finding) => finding.includes("new GUI status judgment")).length, 1, findings.join("\n"));
    assert.equal(findings.filter((finding) => finding.includes("stale baseline entry")).length, 1, findings.join("\n"));
  });
});

test("a broad string status carrier cannot bypass the registry-derived rule", () => {
  const register = [
    { id: "task.status", entity: "Task", field: "status", module: "packages/kernel/src/domain/task.ts", anchor: "taskStatuses", words: ["active", "blocked"] }
  ];
  withFixture({
    "packages/gui/src/panel.ts": 'export const visible = (status: string) => status === "active";\n'
  }, (root) => {
    const sites = scanGuiStatusJudgments(root, register);
    assert.equal(sites.length, 1);
    assert.match(checkGuiStatusJudgments(sites, [])[0], /new GUI status judgment/u);
  });
});

test("an unresolved carrier is not mistaken for an intentional broad string carrier", () => {
  const register = [
    { id: "task.status", entity: "Task", field: "status", module: "packages/kernel/src/domain/task.ts", anchor: "taskStatuses", words: ["active", "blocked"] }
  ];
  withFixture({
    "packages/gui/src/panel.ts": 'import type { Missing } from "./missing.ts";\nexport const visible = (row: Missing) => row.status === "active";\n'
  }, (root) => {
    assert.deepEqual(scanGuiStatusJudgments(root, register), []);
  });
});

function withFixture(files, run) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-gui-status-judgment-"));
  try {
    for (const [relative, content] of Object.entries(files)) {
      const file = path.join(root, relative);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
