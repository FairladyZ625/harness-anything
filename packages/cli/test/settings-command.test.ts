// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { daemonMethodAcceptsPayload } from "@harness-anything/daemon/internal/protocol/daemon-protocol.contract";
import { parseThinCommand } from "../src/cli/thin-command.ts";

test("Settings CLI projects read and owned update flags to the closed daemon actions", () => {
  const read = parseThinCommand(["settings", "read"]);
  assert.equal(read.ok, true);
  if (read.ok) {
    assert.equal(read.command.method, "repo.task.read");
    assert.equal(daemonMethodAcceptsPayload(read.command.method), true);
    assert.deepEqual(read.command.action, { kind: "settings-read" });
  }

  // settings show is a pure alias of settings read: the wire Action keeps the read kind and handler.
  const shown = parseThinCommand(["settings", "show"]);
  assert.equal(shown.ok, true);
  if (shown.ok) {
    assert.equal(shown.command.method, "repo.task.read");
    assert.deepEqual(shown.command.action, { kind: "settings-read" });
    if (read.ok) assert.deepEqual(shown.command.action, read.command.action);
  }

  const update = parseThinCommand([
    "settings",
    "update",
    "--default-preset",
    "strict-task",
    "--review-independence",
    "principal",
    "--locale",
    "zh-CN",
    "--task-scaffold",
    "governance/task-scaffold.json",
    "--delivery-target-ref",
    "refs/heads/main",
    "--closeout-review",
    "true",
    "--agenda-pin-limit",
    "40",
    "--wip-limit",
    "12",
    "--root-threshold",
    "4",
    "--schedule-admission-window-ms",
    "600000",
    "--restore-drill-retention",
    "5",
    "--expected-version",
    "42",
    "--idempotency-key",
    "settings-one",
  ]);
  assert.equal(update.ok, true);
  if (update.ok)
    assert.deepEqual(update.command.action, {
      kind: "settings-update",
      defaultPreset: "strict-task",
      reviewIndependence: "principal",
      locale: "zh-CN",
      taskScaffold: "governance/task-scaffold.json",
      deliveryTargetRef: "refs/heads/main",
      closeoutReview: true,
      agendaPinLimit: 40,
      wipLimit: 12,
      rootThreshold: 4,
      scheduleAdmissionWindowMs: 600_000,
      restoreDrillRetention: 5,
      expectedVersion: 42,
      idempotencyKey: "settings-one",
    });
});

test("Settings CLI accepts complete local delivery refs and rejects branch-shaped values", () => {
  const local = parseThinCommand(["settings", "update", "--delivery-target-ref", "refs/heads/main"]);
  assert.equal(local.ok, true);
  assert.equal(parseThinCommand(["settings", "update", "--delivery-target-ref", "main"]).ok, false);
  assert.equal(parseThinCommand(["settings", "update", "--delivery-target-ref", "refs/tags/v1"]).ok, false);
});

test("Settings CLI rejects unknown and unsupported locale fields", () => {
  assert.equal(parseThinCommand(["settings", "update", "--locale", "fr-FR"]).ok, false);
  assert.equal(parseThinCommand(["settings", "update", "--wip-limit", "0"]).ok, false);
  // Below the declared one-second floor.
  assert.equal(parseThinCommand(["settings", "update", "--schedule-admission-window-ms", "999"]).ok, false);
  assert.equal(parseThinCommand(["settings", "read", "--locale", "en-US"]).ok, false);
  const shown = parseThinCommand(["settings", "show", "--locale", "en-US"]);
  assert.equal(shown.ok, false);
  if (!shown.ok) assert.equal(shown.code, "unknown_field");
});

test("Settings CLI no longer accepts the retired storage flush options", () => {
  for (const [option, value] of [
    ["--wal-flush-adaptive", "false"],
    ["--wal-flush-events", "512"],
    ["--wal-flush-bytes", "1048576"],
    ["--wal-flush-milliseconds", "1000"],
  ] as const) {
    const parsed = parseThinCommand(["settings", "update", option, value]);
    assert.equal(parsed.ok, false, option);
    if (!parsed.ok) assert.equal(parsed.code, "unknown_field", option);
  }
  // Negative control: a neighbouring storage option still parses.
  const kept = parseThinCommand(["settings", "update", "--restore-drill-retention", "5"]);
  assert.equal(kept.ok, true);
  if (kept.ok) assert.deepEqual(kept.command.action, { kind: "settings-update", restoreDrillRetention: 5 });
});

test("Settings CLI forwards ordered worktree setup steps and the none clear", () => {
  const parsed = parseThinCommand([
    "settings",
    "update",
    "--worktree-setup",
    "node-modules",
    "--worktree-setup",
    "run: pip install -e .",
  ]);
  assert.equal(parsed.ok, true);
  if (parsed.ok)
    assert.deepEqual(parsed.command.action, {
      kind: "settings-update",
      worktreeSetup: ["node-modules", "run: pip install -e ."],
    });
  const cleared = parseThinCommand(["settings", "update", "--worktree-setup", "none"]);
  if (cleared.ok) assert.deepEqual(cleared.command.action, { kind: "settings-update", worktreeSetup: ["none"] });
  assert.equal(cleared.ok, true);
  // A bare command is not a step: it has to say run: so the setting reads the same everywhere.
  assert.equal(parseThinCommand(["settings", "update", "--worktree-setup", "pip install -e ."]).ok, false);
});

test("Settings CLI forwards --gates-from-document as a boolean action field", () => {
  const parsed = parseThinCommand(["settings", "update", "--gates-from-document"]);
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.deepEqual(parsed.command.action, { kind: "settings-update", gatesFromDocument: true });
  // The flag carries no value: gate mappings are minted by the daemon from harness.yaml.
  assert.equal(parseThinCommand(["settings", "update", "--gates-from-document", "ci"]).ok, false);
});

test("Settings CLI rejects retired CI and permission switches while preserving credential mode", () => {
  for (const [flag, value] of [
    ["--ci-workflows", "ci"],
    ["--delivery-platform", "github"],
    ...["ci-read", "artifact-read", "push", "pull-request", "merge", "repository-settings", "gitlab"].map((name) => [
      `--worker-permissions-${name}`,
      "true",
    ]),
  ]) {
    const parsed = parseThinCommand(["settings", "update", flag!, value!]);
    assert.equal(parsed.ok, false, flag);
    if (!parsed.ok) assert.equal(parsed.code, "unknown_field", flag);
  }
  const kept = parseThinCommand(["settings", "update", "--worker-permissions-mode", "restricted"]);
  assert.equal(kept.ok, true);
  if (kept.ok) assert.deepEqual(kept.command.action, { kind: "settings-update", workerPermissionsMode: "restricted" });
});
