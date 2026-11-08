// harness-test-tier: fast

import assert from "node:assert/strict";
import test from "node:test";
import { probeDocPaths } from "./baseline-fixture.mjs";

// The CLI prints `workspacePackagePath`; the daemon `repo.task.run` doc-submit action resolves
// `ledgerPackagePath` (authored key). Mixing them submitted `harness/tasks/...` to a daemon that
// joined it under `harness/` again, so the probe task never received its plan.
test("probe doc paths keep the submitted key authored and the shown path workspace-relative", () => {
  assert.deepEqual(
    probeDocPaths({
      workspacePackagePath: "harness/tasks/task-perf-suite-probe",
      ledgerPackagePath: "tasks/task-perf-suite-probe",
    }),
    {
      submit: "tasks/task-perf-suite-probe/task_plan.md",
      show: "harness/tasks/task-perf-suite-probe/task_plan.md",
    },
  );
});

test("a receipt missing either coordinate fails closed instead of guessing a root", () => {
  assert.throws(() => probeDocPaths({ workspacePackagePath: "harness/tasks/task-a" }), /ledgerPackagePath/u);
  assert.throws(() => probeDocPaths({ ledgerPackagePath: "tasks/task-a" }), /workspacePackagePath/u);
});
