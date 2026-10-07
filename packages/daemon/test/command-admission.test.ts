// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { daemonProtocolCommands, repoCellExecutionForAction } from "../src/protocol/daemon-protocol-commands.ts";
import { observeTailReadMethod } from "../src/protocol/daemon-protocol-observe-tail-read.ts";
import { daemonRepoModeWords } from "../src/protocol/daemon-protocol-vocabulary.ts";
import { admitRepoMode, builtinOccurrenceCommandTopology, entityActionCommandTopology } from "../src/repo-mode.ts";

const localSource = "local" as const;
const nodeSource = { kind: "node", nodeId: "edge-one" } as const;
const admissionRoutes = new Set(["direct", "via-node", "via-center-forward", "edge-replica", "rejected"]);

test("all daemon commands close every repo-mode admission cell", () => {
  let cells = 0;
  for (const command of daemonProtocolCommands) {
    assert.deepEqual(Object.keys(command.admission).sort(), [...daemonRepoModeWords].sort(), command.id);
    for (const mode of daemonRepoModeWords) {
      cells += 1;
      const route = command.admission[mode];
      assert.equal(admissionRoutes.has(route), true, `${command.id} ${mode} ${route}`);
      const direct = admitRepoMode(mode, command, localSource),
        assigned = admitRepoMode(mode, command, nodeSource);
      if (route === "direct") {
        assert.equal(direct.ok, true, `${command.id} ${mode} direct fixture`);
      } else if (route === "via-node") {
        assert.equal(direct.ok, false, `${command.id} ${mode} requires assignment`);
        assert.equal(assigned.ok, true, `${command.id} ${mode} assignment fixture`);
      } else if (route === "edge-replica") {
        assert.equal(direct.ok, true, `${command.id} ${mode} is answered by the edge cell from its replica`);
        assert.equal(assigned.ok, false, `${command.id} ${mode} is never executed for an assignment`);
      } else if (route === "via-center-forward") {
        assert.equal(direct.ok, false, `${command.id} ${mode} forwards instead of executing locally`);
        assert.equal(direct.nextAction, direct.code, command.id);
      } else {
        assert.equal(direct.ok, false, `${command.id} ${mode} explicitly rejected`);
        assert.equal(assigned.ok, false, `${command.id} ${mode} explicitly rejected for assignments`);
      }
    }
  }
  assert.equal(cells, daemonProtocolCommands.length * daemonRepoModeWords.length);
});

test("legacy repo reads have no descriptor left on the serialized write method", () => {
  const legacyReadIds = ["task-list", "task-show", "doc-status", "settings-read"];
  for (const command of daemonProtocolCommands)
    if (command.commandClass === "repo-read") assert.notEqual(command.method, "repo.task.run", command.id);
  for (const id of legacyReadIds)
    assert.equal(daemonProtocolCommands.find((command) => command.id === id)?.method, "repo.task.read", id);
});

test("RepoCell execution context is declared independently from read authorization", () => {
  const byId = new Map(daemonProtocolCommands.map((command) => [command.id, command]));
  for (const id of ["receipt-show", "doctor-health", "preset-list"]) {
    assert.equal(byId.get(id)?.commandClass, "repo-read", id);
    assert.equal(byId.get(id)?.repoCellExecution, "writer", id);
  }
  // Edge-replica reads execute in the query-only context: the edge answers from its replica, and
  // the center's own writer cell is never entered for them.
  for (const id of ["task-list", "task-show", "agent-list", "doc-status"])
    assert.equal(byId.get(id)?.repoCellExecution, "query-only", id);
  for (const command of daemonProtocolCommands)
    if (command.commandClass !== "repo-read")
      assert.equal(
        repoCellExecutionForAction("actionKind" in command ? command.actionKind : command.id),
        "writer",
        command.id,
      );
});

test("observe.tail declares direct admission and named source residency for every tail kind", () => {
  const command = observeTailReadMethod;
  assert.deepEqual(command.admission, {
    local: "direct",
    "remote-proxy": "rejected",
    "remote-center": "direct",
    "remote-edge": "direct",
  });
  assert.deepEqual(command.residency, {
    events: "projection",
    "repo-log": "runtime-local",
    "daemon-log": "runtime-local",
    lifecycle: "runtime-local",
    dispatch: "runtime-local",
  });
  for (const mode of daemonRepoModeWords)
    assert.equal(
      admitRepoMode(mode, command, localSource).ok,
      mode !== "remote-proxy",
      `observe.tail ${mode} ${mode === "remote-proxy" ? "rejected locally" : "direct"} fixture`,
    );
});

test("Schedule descriptors derive all three mode routes without a CLI mode branch", () => {
  const byId = new Map(daemonProtocolCommands.map((command) => [command.id, command]));
  for (const id of ["schedule-create", "schedule-update", "schedule-delete", "schedule-enable", "schedule-disable"])
    assert.deepEqual(byId.get(id)?.admission, {
      local: "direct",
      "remote-proxy": "rejected",
      "remote-center": "direct",
      "remote-edge": "via-center-forward",
    });
  for (const id of ["schedule-list", "schedule-runs", "schedule-show"])
    assert.deepEqual(byId.get(id)?.admission, {
      local: "direct",
      "remote-proxy": "rejected",
      "remote-center": "direct",
      "remote-edge": "edge-replica",
    });
  assert.deepEqual(byId.get("schedule-run-now")?.admission, {
    local: "direct",
    "remote-proxy": "rejected",
    "remote-center": "via-node",
    "remote-edge": "direct",
  });
  assert.equal(admitRepoMode("remote-center", byId.get("schedule-run-now")!, localSource).ok, false);
  assert.equal(admitRepoMode("remote-center", byId.get("schedule-run-now")!, nodeSource).ok, true);
});

test("the center admits its own local source on every ledger write an edge cannot run itself", () => {
  let ledgerWrites = 0;
  for (const command of daemonProtocolCommands) {
    if (command.commandClass !== "repo-write") continue;
    const runsOnEdge = command.admission["remote-edge"] === "direct";
    // Only runtime-local execution keeps the center on assignment ingress; a ledger write that an
    // edge cannot execute itself must have a center entrance, or nobody in the topology can run it.
    assert.equal(command.admission["remote-center"], runsOnEdge ? "via-node" : "direct", command.id);
    if (runsOnEdge) continue;
    ledgerWrites += 1;
    assert.equal(admitRepoMode("remote-center", command, localSource).ok, true, command.id);
    assert.equal(admitRepoMode("remote-center", command, nodeSource).ok, true, command.id);
    assert.equal(admitRepoMode("remote-edge", command, localSource).ok, false, command.id);
    assert.equal(admitRepoMode("remote-proxy", command, localSource).ok, false, command.id);
  }
  assert.ok(ledgerWrites > 0);
});

test("a builtin occurrence resolves the center to its own executor and moves no other cell", () => {
  let resolved = 0;
  for (const command of daemonProtocolCommands) {
    assert.equal(builtinOccurrenceCommandTopology(command, false), command, command.id);
    const builtin = builtinOccurrenceCommandTopology(command, true);
    if (command.admission["remote-center"] !== "via-node") {
      assert.equal(builtin, command, command.id);
      continue;
    }
    resolved += 1;
    assert.deepEqual(builtin.admission, { ...command.admission, "remote-center": "direct" }, command.id);
    assert.equal(admitRepoMode("remote-center", builtin, localSource).ok, true, command.id);
    // The declared route is what host admission reads: a transport source on the center still
    // needs assignment ingress, so only the daemon's own scheduler reaches the resolved route.
    assert.equal(admitRepoMode("remote-center", command, localSource).ok, false, command.id);
  }
  assert.ok(resolved > 0);
});

test("the center admits review adjudication and no edge or proxy executes it locally", () => {
  const arbiterCommands = daemonProtocolCommands.filter((command) => command.commandClass === "arbiter");
  assert.deepEqual(arbiterCommands.map(({ id }) => id).sort(), [
    "decision-override-review",
    "decision-reject",
    "decision-review",
    "task-review-execution",
  ]);
  for (const command of arbiterCommands) {
    assert.equal(command.admission["remote-center"], "direct", command.id);
    assert.equal(admitRepoMode("remote-center", command, localSource).ok, true, command.id);
    assert.equal(admitRepoMode("remote-edge", command, localSource).ok, false, command.id);
    assert.equal(admitRepoMode("remote-edge", command, nodeSource).ok, false, command.id);
    assert.equal(admitRepoMode("remote-proxy", command, localSource).ok, false, command.id);
  }
  // Only the Task review declares an edge forward; Decision adjudication has no edge route at all.
  assert.deepEqual(arbiterCommands.map(({ id, admission }) => [id, admission["remote-edge"]]).sort(), [
    ["decision-override-review", "rejected"],
    ["decision-reject", "rejected"],
    ["decision-review", "rejected"],
    ["task-review-execution", "via-center-forward"],
  ]);
});

test("Settings CLI read uses the common read topology while update forwards from edge", () => {
  const byId = new Map(daemonProtocolCommands.map((command) => [command.id, command]));
  assert.deepEqual(byId.get("settings-read")?.admission, {
    local: "direct",
    "remote-proxy": "rejected",
    "remote-center": "direct",
    "remote-edge": "edge-replica",
  });
  assert.deepEqual(byId.get("settings-update")?.admission, {
    local: "direct",
    "remote-proxy": "rejected",
    "remote-center": "direct",
    "remote-edge": "via-center-forward",
  });
  assert.equal(byId.get("settings-read")?.commandClass, "repo-read");
  assert.equal(byId.get("settings-update")?.commandClass, "repo-write");
});

test("Artifact import forwards edge observations into the center single-writer queue", () => {
  const command = daemonProtocolCommands.find(({ id }) => id === "entity-import");
  assert.deepEqual(command?.admission, {
    local: "direct",
    "remote-proxy": "rejected",
    "remote-center": "direct",
    "remote-edge": "via-center-forward",
  });
  assert.equal(command?.commandClass, "repo-write");
  const squadMigration = daemonProtocolCommands.find(({ id }) => id === "entity-migrate-squads");
  assert.equal(squadMigration, undefined, "in-place Squad migration has no live command descriptor");
});

test("Settings locale-only updates use local admission while repository fields keep center routing", () => {
  const descriptor = new Map(daemonProtocolCommands.map((command) => [command.id, command])).get("settings-update")!;
  assert.deepEqual(entityActionCommandTopology(descriptor, { kind: "settings-update", locale: "zh-CN" }).admission, {
    local: "direct",
    "remote-proxy": "rejected",
    "remote-center": "direct",
    "remote-edge": "direct",
  });
  assert.deepEqual(
    entityActionCommandTopology(descriptor, { kind: "settings-update", defaultPreset: "strict-task" }).admission,
    descriptor.admission,
  );
  assert.deepEqual(
    entityActionCommandTopology(descriptor, {
      kind: "settings-update",
      locale: "zh-CN",
      defaultPreset: "strict-task",
    }).admission,
    descriptor.admission,
  );
});

test("Person delegation Actions are admin Actions and forward from an edge", () => {
  const byId = new Map(daemonProtocolCommands.map((command) => [command.id, command]));
  for (const id of ["people-delegate", "people-revoke-delegation"]) {
    assert.deepEqual(byId.get(id)?.admission, {
      local: "direct",
      "remote-proxy": "rejected",
      "remote-center": "direct",
      "remote-edge": "via-center-forward",
    });
    assert.equal(byId.get(id)?.commandClass, "admin");
  }
});
