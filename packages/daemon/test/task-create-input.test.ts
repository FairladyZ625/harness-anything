// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { taskCreateAction } from "../src/repo-cell-action-parse.ts";

test("task creation rejects retired legacy inputs through direct and structured sources", () => {
  for (const fields of [{ fromLegacyId: "legacy-1" }, { title: "New task", fromLegacyId: "legacy-1" }]) {
    for (const action of [fields, { jsonInput: JSON.stringify(fields) }])
      assert.throws(
        () => taskCreateAction("/unused", { kind: "task-create", ...action }),
        /unsupported task create fields: fromLegacyId/u,
      );
  }
});

test("ordinary task creation retains direct overrides of structured fields", () => {
  assert.deepEqual(
    taskCreateAction("/unused", {
      kind: "task-create",
      title: "Override",
      jsonInput: JSON.stringify({ title: "Packet", slug: "packet" }),
    }),
    { kind: "task-create", title: "Override", slug: "packet" },
  );
});

test("task creation resolves the plan file into the plan body on the same action", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-plan-input-"));
  try {
    const plan = "# Authored plan\n\n## Brief\n\nWritten at create.\n";
    mkdirSync(path.join(rootDir, "plans"), { recursive: true });
    writeFileSync(path.join(rootDir, "plans", "authored.md"), plan);
    assert.deepEqual(
      taskCreateAction(rootDir, { kind: "task-create", title: "Planned", planFile: "plans/authored.md" }),
      {
        kind: "task-create",
        title: "Planned",
        plan,
        planFile: "plans/authored.md",
      },
    );
    assert.deepEqual(
      taskCreateAction(rootDir, {
        kind: "task-create",
        title: "Structured",
        jsonInput: JSON.stringify({ title: "Packet" }),
        planFile: "plans/authored.md",
      }),
      { kind: "task-create", title: "Structured", plan, planFile: "plans/authored.md" },
    );
    assert.throws(
      () => taskCreateAction(rootDir, { kind: "task-create", title: "Both", planFile: "plans/authored.md", plan: "x" }),
      /only plan source/u,
    );
    assert.throws(
      () => taskCreateAction(rootDir, { kind: "task-create", title: "Outside", planFile: "../../plans/authored.md" }),
      /planFile must name a readable UTF-8 file inside workspace root/u,
    );
    assert.throws(
      () =>
        taskCreateAction(rootDir, {
          kind: "task-create",
          jsonInput: JSON.stringify({ title: "Packet", plan: "# inline" }),
        }),
      /unsupported task create fields: plan/u,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
