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
  assert.equal(has("packages/gui/src/renderer/views/DecisionPoolView.tsx", 'decision.state === "proposed"'), true);
  assert.equal(has("packages/gui/src/renderer/views/DecisionPoolView.tsx", '["high", "medium", "low", "unknown"]'), true);
  assert.equal(has("packages/gui/src/renderer/views/DecisionsView.tsx", 'decision.state === "proposed"'), true);
  assert.equal(has("packages/gui/src/renderer/decision-actions.ts", 'decision.state === "proposed"'), true);
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

test("source identity survives formatting, responsibility split, and file rename", () => {
  const register = [
    { id: "task.status", entity: "Task", field: "status", module: "packages/kernel/src/domain/task.ts", anchor: "taskStatuses", words: ["active", "blocked"] }
  ];
  withFixture({
    "packages/gui/src/panel.ts": 'type TaskStatus = "active" | "blocked";\nexport const visible = (status: TaskStatus) => /* @gate-identity check-gui-status-judgments/gui-fixture */ status === "active";\n'
  }, (root) => {
    const original = scanGuiStatusJudgments(root, register);
    assert.equal(original.length, 1);
    const baseline = [{
      key: "gui-fixture",
      classification: "domain-judgment",
      kind: "comparison",
      shape: "point-comparison",
      words: ["active"]
    }];
    assert.deepEqual(checkGuiStatusJudgments(original, baseline), []);

    const movedPath = path.join(root, "packages/gui/src/visibility.ts");
    writeFileSync(movedPath, [
      'type TaskStatus = "active" | "blocked";',
      "export function visible(status: TaskStatus) {",
      "  return /* @gate-identity check-gui-status-judgments/gui-fixture */ status ===",
      '    "active";',
      "}"
    ].join("\n"));
    rmSync(path.join(root, "packages/gui/src/panel.ts"));
    const moved = scanGuiStatusJudgments(root, register);
    assert.equal(moved[0].key, original[0].key);
    assert.deepEqual(checkGuiStatusJudgments(moved, baseline), []);

    writeFileSync(movedPath, [
      'type TaskStatus = "active" | "blocked";',
      "export function visible(status: TaskStatus) {",
      '  return /* @gate-identity check-gui-status-judgments/gui-fixture */ status === "blocked";',
      "}"
    ].join("\n"));
    const semanticChange = checkGuiStatusJudgments(scanGuiStatusJudgments(root, register), baseline);
    assert.ok(semanticChange.some((finding) => finding.includes("baseline freezes")), semanticChange.join("\n"));
  });
});

// The test above covers the formatter wrapping the marked expression across lines.
// It did not cover the formatter inserting a parenthesis *between* the marker and
// the node, which is what prettier does to a multi-line condition — and which broke
// gui-status-033 and gui-status-035 in taskFilters.ts for real.
test("source identity survives a parenthesis the formatter inserts between the marker and its node", () => {
  const register = [
    { id: "task.status", entity: "Task", field: "status", module: "packages/kernel/src/domain/task.ts", anchor: "taskStatuses", words: ["active", "blocked"] }
  ];
  const baseline = [{
    key: "gui-fixture",
    classification: "domain-judgment",
    kind: "comparison",
    shape: "point-comparison",
    words: ["active"]
  }];
  withFixture({
    "packages/gui/src/panel.ts": [
      'type TaskStatus = "active" | "blocked";',
      "export function visible(status: TaskStatus, archived: boolean): boolean {",
      "  return (",
      "    !archived &&",
      "    /* @gate-identity check-gui-status-judgments/gui-fixture */",
      '    (status === "active" || status === "blocked")',
      "  );",
      "}",
      ""
    ].join("\n")
  }, (root) => {
    const sites = scanGuiStatusJudgments(root, register);
    assert.ok(
      sites.some((site) => site.identity === "gui-fixture"),
      `the marked node must still resolve its identity; got ${JSON.stringify(sites.map((site) => site.identity))}`
    );
    const findings = checkGuiStatusJudgments(sites, baseline);
    assert.equal(
      findings.filter((finding) => finding.includes("stale baseline entry")).length,
      0,
      findings.join("\n")
    );
  });
});

// The widening must stay narrow: any real token between the marker and a node means
// that node is not the marked one, so the identity must not leak onto it.
test("source identity does not leak past a real token onto an unmarked node", () => {
  const register = [
    { id: "task.status", entity: "Task", field: "status", module: "packages/kernel/src/domain/task.ts", anchor: "taskStatuses", words: ["active", "blocked"] }
  ];
  withFixture({
    "packages/gui/src/panel.ts": [
      'type TaskStatus = "active" | "blocked";',
      "declare function wrap(value: boolean): boolean;",
      "export function visible(status: TaskStatus): boolean {",
      '  return /* @gate-identity check-gui-status-judgments/gui-fixture */ wrap(status === "active");',
      "}",
      ""
    ].join("\n")
  }, (root) => {
    const sites = scanGuiStatusJudgments(root, register);
    const marked = sites.filter((site) => site.identity === "gui-fixture");
    assert.equal(marked.length, 0, "a call expression between the marker and the comparison must not pass the identity through");
  });
});

test("duplicate source identities fail closed", () => {
  const register = [
    { id: "task.status", entity: "Task", field: "status", module: "packages/kernel/src/domain/task.ts", anchor: "taskStatuses", words: ["active", "blocked"] }
  ];
  withFixture({
    "packages/gui/src/panel.ts": 'export function first(status: string) { return /* @gate-identity check-gui-status-judgments/gui-fixture */ status === "active"; }\nexport function second(status: string) { return /* @gate-identity check-gui-status-judgments/gui-fixture */ status === "active"; }\n'
  }, (root) => {
    const findings = checkGuiStatusJudgments(scanGuiStatusJudgments(root, register), [
      {
        key: "gui-fixture",
        classification: "domain-judgment",
        kind: "comparison",
        shape: "point-comparison",
        words: ["active"]
      }
    ]);
    assert.ok(findings.some((finding) => finding.includes("duplicate source identity")), findings.join("\n"));
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
