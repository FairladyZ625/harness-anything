// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseThinCommand } from "../src/cli/thin-command.ts";

test("task create preserves the complete contract and initial relations in one closed action", () => {
  const parsed = parseThinCommand([
    "task",
    "create",
    "--title",
    "Surface",
    "--id",
    "task_surface",
    "--migration",
    "--idempotency-key",
    "surface-once",
    "--parent",
    "task_parent",
    "--kind",
    "feat",
    "--risk-tier",
    "high",
    "--urgency",
    "medium",
    "--vertical",
    "software/coding",
    "--preset",
    "standard-task",
    "--profile",
    "default",
    "--module",
    "kernel",
    "--slug",
    "surface",
    "--surface",
    "ha task create",
    "--surface",
    "packages/kernel",
    "--relation",
    "depends-on:task/task_dependency:Dependency must land first",
    "--locale",
    "zh-CN",
    "--dry-run",
  ]);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (parsed.ok)
    assert.deepEqual(parsed.command.action, {
      kind: "task-create",
      title: "Surface",
      taskId: "task_surface",
      createMode: "migration",
      idempotencyKey: "surface-once",
      parentTaskId: "task_parent",
      workKind: "feat",
      riskTier: "high",
      urgency: "medium",
      verticalId: "software/coding",
      presetId: "standard-task",
      profileId: "default",
      moduleKey: "kernel",
      slug: "surface",
      surfaces: ["ha task create", "packages/kernel"],
      relations: [
        {
          type: "depends-on",
          target: "task/task_dependency",
          rationale: "Dependency must land first",
        },
      ],
      locale: "zh-CN",
      dryRun: true,
    });
  assert.equal(parseThinCommand(["task", "create", "--title", "Bad id", "--id", "task_bad"]).ok, false);
  assert.equal(parseThinCommand(["task", "create", "--task-id", "task_old", "--title", "Retired alias"]).ok, false);
  assert.equal(
    parseThinCommand(["task", "create", "--title", "Bad input", "--from-file", "task.json", "--json-input", "{}"]).ok,
    false,
  );
  assert.equal(
    parseThinCommand([
      "task",
      "create",
      "--title",
      "Bad module",
      "--register-module",
      "kernel",
      "--module-title",
      "Kernel",
    ]).ok,
    false,
  );
  assert.equal(parseThinCommand(["task", "create", "--json-input", '{"title":"Structured"}']).ok, true);
  assert.equal(parseThinCommand(["task", "create", "--from-legacy", "legacy-1"]).ok, true);
  assert.equal(parseThinCommand(["task", "create"]).ok, false);
});

test("long-running work arrives only as --task-class long_running; the retired boolean flag is unknown", () => {
  const resident = parseThinCommand(["task", "create", "--title", "Resident ledger", "--task-class", "long_running"]);
  assert.equal(resident.ok, true, JSON.stringify(resident));
  if (resident.ok)
    assert.deepEqual(resident.command.action, {
      kind: "task-create",
      title: "Resident ledger",
      taskClass: "long_running",
    });
  assert.deepEqual(parseThinCommand(["task", "create", "--title", "Resident ledger", "--long-running"]), {
    ok: false,
    code: "unknown_field",
    nextAction: "Unknown option --long-running. Run ha task create --help.",
    json: false,
  });
  assert.equal(
    parseThinCommand(["task", "create", "--title", "Resident ledger", "--task-class", "long-running"]).ok,
    false,
  );
});

test("task lifecycle and read surfaces parse every F03 F04 F05 leaf into closed actions", () => {
  const cases = [
    [
      ["task", "start", "task-1", "--execution-id", "exe-1", "--ttl-ms", "60000", "--dry-run"],
      {
        kind: "task-start",
        taskId: "task-1",
        executionId: "exe-1",
        ttlMs: 60000,
        dryRun: true,
      },
    ],
    [["task", "release", "task-1"], { kind: "task-release", taskId: "task-1" }],
    [
      ["task", "transition", "task-1", "cancelled", "--force", "--reason", "Invalid scope"],
      {
        kind: "task-transition",
        taskId: "task-1",
        status: "cancelled",
        force: true,
        reason: "Invalid scope",
      },
    ],
    [
      ["task", "transition", "task-1", "planned", "--reason", "Owner rolled back the batch cancellation"],
      {
        kind: "task-transition",
        taskId: "task-1",
        status: "planned",
        reason: "Owner rolled back the batch cancellation",
      },
    ],
    [
      ["task", "amend", "task-1", "--set", "title:New title", "--set", "riskTier:high"],
      {
        kind: "task-amend",
        taskId: "task-1",
        patches: [
          { field: "title", value: "New title" },
          { field: "riskTier", value: "high" },
        ],
      },
    ],
    [
      ["task", "amend", "task-1", "--set", "pinned:true"],
      {
        kind: "task-amend",
        taskId: "task-1",
        patches: [{ field: "pinned", value: "true" }],
      },
    ],
    [
      ["task", "pin", "task-1"],
      {
        kind: "task-amend",
        taskId: "task-1",
        patches: [{ field: "pinned", value: "true" }],
      },
    ],
    [
      ["task", "unpin", "task-1"],
      {
        kind: "task-amend",
        taskId: "task-1",
        patches: [{ field: "pinned", value: "false" }],
      },
    ],
    [["agenda", "--limit", "25", "--cursor", "cursor-a"], { kind: "agenda", limit: 25, cursor: "cursor-a" }],
    [
      ["task", "archive", "task-1", "--reason", "Delivered", "--archived-by", "owner"],
      {
        kind: "task-archive",
        taskId: "task-1",
        reason: "Delivered",
        archivedBy: "owner",
      },
    ],
    [
      ["task", "supersede", "task-1", "--by", "task-2", "--confirm", "task-1", "--reason", "Scope changed"],
      {
        kind: "task-supersede",
        oldTaskId: "task-1",
        byTaskId: "task-2",
        confirm: "task-1",
        reason: "Scope changed",
        allowOpenFindings: false,
      },
    ],
    [
      ["task", "delete", "--soft", "task-1", "--reason", "Duplicate"],
      {
        kind: "task-delete",
        taskId: "task-1",
        mode: "soft",
        reason: "Duplicate",
      },
    ],
    [
      ["task", "reopen", "task-1", "--reason", "Needed again"],
      { kind: "task-reopen", taskId: "task-1", reason: "Needed again" },
    ],
    [
      ["task", "contract", "migrate", "--dry-run", "--task", "task-1"],
      { kind: "task-contract-migrate", mode: "dry-run", taskId: "task-1" },
    ],
    [
      ["task", "review", "task-1", "--reviewer", "reviewer-1"],
      { kind: "task-review", taskId: "task-1", reviewerId: "reviewer-1" },
    ],
    [
      [
        "task",
        "list",
        "--status",
        "blocked",
        "--module",
        "kernel",
        "--search",
        "surface",
        "--updated-after",
        "2026-08-01T00:00:00.000Z",
        "--updated-before",
        "2026-08-31T00:00:00.000Z",
        "--limit",
        "25",
        "--cursor",
        "cursor-a",
      ],
      {
        kind: "task-list",
        status: "blocked",
        module: "kernel",
        search: "surface",
        updatedAfter: "2026-08-01T00:00:00.000Z",
        updatedBefore: "2026-08-31T00:00:00.000Z",
        limit: 25,
        cursor: "cursor-a",
      },
    ],
    [
      [
        "relation",
        "list",
        "--entity",
        "task/task-1",
        "--type",
        "depends-on",
        "--state",
        "active",
        "--updated-after",
        "2026-08-01T00:00:00.000Z",
        "--updated-before",
        "2026-08-31T00:00:00.000Z",
        "--limit",
        "25",
        "--cursor",
        "cursor-a",
      ],
      {
        kind: "relation-list",
        entity: "task/task-1",
        relationType: "depends-on",
        state: "active",
        updatedAfter: "2026-08-01T00:00:00.000Z",
        updatedBefore: "2026-08-31T00:00:00.000Z",
        limit: 25,
        cursor: "cursor-a",
      },
    ],
    [
      ["task", "relate", "task-1", "depends-on", "task-2", "--rationale", "Must land first", "--dry-run"],
      {
        kind: "task-relate",
        taskId: "task-1",
        target: "task/task-2",
        relationType: "depends-on",
        rationale: "Must land first",
        dryRun: true,
      },
    ],
  ] as const;
  for (const [argv, expected] of cases) {
    const parsed = parseThinCommand(argv);
    assert.equal(parsed.ok, true, `${argv.join(" ")}: ${JSON.stringify(parsed)}`);
    if (parsed.ok) assert.deepEqual(parsed.command.action, expected);
  }
  const agenda = parseThinCommand(["agenda", "--limit", "25"]);
  assert.equal(agenda.ok, true);
  if (agenda.ok) assert.equal(agenda.command.method, "repo.agenda.read");
  assert.equal(parseThinCommand(["task", "transition", "task-1", "done"]).ok, false);
  const bareReinstate = parseThinCommand(["task", "transition", "task-1", "planned"]);
  assert.equal(bareReinstate.ok, false);
  if (!bareReinstate.ok) {
    assert.equal(bareReinstate.code, "missing_field");
    assert.match(bareReinstate.nextAction, /--reason/u);
  }
  // G-cancel-hint: each missing piece of an audited cancellation is named on its own, never told to add a flag already present.
  const cancelReasonOnly = parseThinCommand(["task", "transition", "task-1", "cancelled", "--reason", "Superseded"]);
  assert.equal(cancelReasonOnly.ok, false);
  if (!cancelReasonOnly.ok) {
    assert.match(cancelReasonOnly.nextAction, /--force/u);
    assert.doesNotMatch(cancelReasonOnly.nextAction, /add --reason/u);
  }
  const cancelForceOnly = parseThinCommand(["task", "transition", "task-1", "cancelled", "--force"]);
  assert.equal(cancelForceOnly.ok, false);
  if (!cancelForceOnly.ok) {
    assert.equal(cancelForceOnly.code, "missing_field");
    assert.match(cancelForceOnly.nextAction, /--reason/u);
  }
  const cancelBare = parseThinCommand(["task", "transition", "task-1", "cancelled"]);
  assert.equal(cancelBare.ok, false);
  if (!cancelBare.ok) assert.match(cancelBare.nextAction, /--force/u);
  const forceOutsideCancel = parseThinCommand(["task", "transition", "task-1", "active", "--force"]);
  assert.equal(forceOutsideCancel.ok, false);
  if (!forceOutsideCancel.ok) assert.doesNotMatch(forceOutsideCancel.nextAction, /add --reason/u);
  assert.equal(parseThinCommand(["task", "delete", "--hard", "task-1", "--confirm", "task-1"]).ok, true);
  assert.equal(parseThinCommand(["task", "contract", "migrate", "--apply", "--dry-run"]).ok, false);
  assert.equal(parseThinCommand(["task", "supersede", "task-1", "--by", "task-2"]).ok, false);
  assert.equal(parseThinCommand(["task", "supersede", "task-1", "--by", "task-2", "--confirm", "task-1"]).ok, true);
});
