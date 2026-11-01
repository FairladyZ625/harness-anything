// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { allDaemonProtocolMethods } from "../src/protocol/daemon-protocol-commands.ts";
import { assertDaemonRpcRouting, daemonRpcRoutingDeclarations } from "../src/rpc-command-routing.ts";
import { getExecutableEntityAction } from "@harness-anything/kernel";
import { isFleetTaskAction } from "../src/fleet/command-protocol.ts";
import { daemonProtocolCommands, repoCellExecutionForAction } from "../src/protocol/daemon-protocol-commands.ts";
import { observeTailReadMethod } from "../src/protocol/daemon-protocol-observe-tail-read.ts";
import { daemonRepoModeWords } from "../src/protocol/daemon-protocol-vocabulary.ts";
import { admitRepoMode, builtinOccurrenceCommandTopology, entityActionCommandTopology } from "../src/repo-mode.ts";

const localSource = "local" as const;
const nodeSource = { kind: "node", nodeId: "edge-one" } as const;
const admissionRoutes = new Set(["direct", "via-node", "via-center-forward", "edge-replica", "rejected"]);

function assertAdmissionDeclared(command: { readonly id: string; readonly admission: object }) {
  assert.deepEqual(Object.keys(command.admission).sort(), [...daemonRepoModeWords].sort(), command.id);
}

test("admission coverage rejects a new write command missing its edge decision", () => {
  const command = {
    id: "new-write",
    admission: { local: "direct", "remote-proxy": "rejected", "remote-center": "direct" },
  };
  assert.throws(() => assertAdmissionDeclared(command), assert.AssertionError);
  assertAdmissionDeclared({ ...command, admission: { ...command.admission, "remote-edge": "rejected" } });
});

test("fleet declaration writes carry values and cannot ask the center to read a source path", () => {
  for (const kind of ["agent-install", "squad-install"]) {
    const action = { kind, declaration: { schema: `${kind.split("-")[0]}-declaration/v1` } };
    assert.equal(isFleetTaskAction(action), true, kind);
    assert.equal(isFleetTaskAction({ kind, packageSource: "/center/private.json" }), false, kind);
    assert.equal(isFleetTaskAction({ ...action, packageSource: "/center/private.json" }), false, kind);
    assert.equal(isFleetTaskAction({ ...action, actor: { personId: "spoofed" } }), false, kind);
  }
});

test("fleet forwarded writes use their declared entity identity", () => {
  for (const action of [
    { kind: "agent-delete", agentId: "worker", reason: "Remove worker.", expectedVersion: 1 },
    { kind: "agent-retire", agentId: "worker", reason: "Retire worker." },
    { kind: "squad-delete", squadId: "team", reason: "Remove team.", expectedVersion: 1 },
    { kind: "vertical-kind-publish-schema", kindId: "software/document", attributes: {}, expectedVersion: 1 },
    { kind: "vertical-kind-retire", kindId: "software/document", reason: "Retire kind.", expectedVersion: 1 },
    {
      kind: "entity-update",
      entityKind: "software/document",
      entityId: "doc-one",
      title: "Update",
      expectedVersion: 1,
    },
    {
      kind: "entity-delete",
      entityKind: "software/document",
      entityId: "doc-one",
      reason: "Delete.",
      expectedVersion: 1,
    },
    {
      kind: "entity-archive",
      entityKind: "software/document",
      entityId: "doc-one",
      reason: "Archive.",
      expectedVersion: 1,
    },
  ]) {
    assert.equal(isFleetTaskAction(action), true, action.kind);
    const spoofed = { ...action, actor: { personId: "spoofed" } };
    assert.equal(isFleetTaskAction(spoofed), false, action.kind);
  }
});

test("forwarded command positional tokens name their canonical payload field", () => {
  for (const command of daemonProtocolCommands) {
    if (command.admission["remote-edge"] !== "via-center-forward" || !("positional" in command)) continue;
    const token = command.syntaxPath.find((part) => /^<[a-z][a-z0-9-]*>$/u.test(part));
    if (!token) continue;
    assert.equal(
      token.slice(1, -1).replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase()),
      command.positional,
      command.id,
    );
  }
});

test("compiled entity writes retain the edge route declared by their canonical action", () => {
  let checked = 0;
  for (const command of daemonProtocolCommands) {
    const action = getExecutableEntityAction("actionKind" in command ? command.actionKind : command.id);
    if (action?.execution?.implementation !== "compiled-event" || action.execution.topology !== "center-forward-write")
      continue;
    checked += 1;
    assert.equal(command.admission["remote-edge"], "via-center-forward", command.id);
  }
  assert.ok(checked > 0);
});

test("all daemon commands close every repo-mode admission cell", () => {
  let cells = 0;
  for (const command of daemonProtocolCommands) {
    assertAdmissionDeclared(command);
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
    // dec_2AAF1D0612D3295C80F87E49FE CH1: publish where the managed checkout lives.
    if (command.id === "task-push") {
      assert.deepEqual(command.admission, {
        local: "direct",
        "remote-proxy": "rejected",
        "remote-center": "direct",
        "remote-edge": "direct",
      });
      for (const source of [localSource, nodeSource]) {
        assert.equal(admitRepoMode("remote-center", command, source).ok, true, command.id);
        assert.equal(admitRepoMode("remote-edge", command, source).ok, source === localSource, command.id);
        assert.equal(admitRepoMode("remote-proxy", command, source).ok, false, command.id);
      }
      continue;
    }
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

test("todo reads use the edge replica like other repository query-only reads", () => {
  const byId = new Map(daemonProtocolCommands.map((command) => [command.id, command]));
  for (const id of ["todo-list", "todo-show"]) {
    const command = byId.get(id);
    assert.equal(command?.commandClass, "repo-read", id);
    assert.equal(command?.admission["remote-edge"], "edge-replica", id);
    assert.equal(command?.repoCellExecution, "query-only", id);
  }
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

test("all GUI and host RPC declarations have an explicit repository/node route", () => {
  const routes = daemonRpcRoutingDeclarations();
  assertDaemonRpcRouting(routes);
  assert.deepEqual(
    new Set(routes.map((route) => route.method)),
    new Set(allDaemonProtocolMethods.map((method) => method.method)),
  );
});

test("the full RPC route gate rejects a missing GUI edge route and an undeclared host method", () => {
  const routes = daemonRpcRoutingDeclarations();
  const missingEdge = routes.map((route) => {
    if (route.method !== "repo.terminal.spawn") return route;
    const { "remote-edge": _edge, ...admission } = route.topology.admission;
    return { ...route, topology: { ...route.topology, admission } };
  });
  assert.throws(() => assertDaemonRpcRouting(missingEdge as typeof routes), /repo\.terminal\.spawn has no declared/u);
  assert.throws(
    () =>
      daemonRpcRoutingDeclarations([
        ...allDaemonProtocolMethods,
        { id: "new-host-write", method: "daemon.new.write", commandClass: "admin" },
      ]),
    /daemon\.new\.write has no declared/u,
  );
});

test("RPC coverage retains every generic action and rejects conflicting aliases", () => {
  const routes = daemonRpcRoutingDeclarations();
  assert.throws(
    () =>
      assertDaemonRpcRouting(
        routes.filter((route) => !(route.method === "repo.task.run" && route.actionKind === "agent-install")),
      ),
    /repo\.task\.run has no declared/u,
  );
  const conflict = routes.map((route) =>
    route.method === "repo.agentRuntime.steer"
      ? {
          ...route,
          topology: {
            ...route.topology,
            admission: { ...route.topology.admission, "remote-edge": "rejected" as const },
          },
        }
      : route,
  );
  assert.throws(() => assertDaemonRpcRouting(conflict), /repo\.agentRuntime\.steer has no declared/u);
  assert.throws(
    () =>
      daemonRpcRoutingDeclarations([
        ...allDaemonProtocolMethods,
        { id: "new-read", method: "daemon.new.read", commandClass: "repo-read" },
      ]),
    /daemon\.new\.read has no declared/u,
  );
});
