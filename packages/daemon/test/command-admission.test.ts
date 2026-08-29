// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { daemonProtocolCommands } from "../src/protocol/daemon-protocol-commands.ts";
import { observeTailReadMethod } from "../src/protocol/daemon-protocol-gui-reads.ts";
import { daemonRepoModeWords } from "../src/protocol/daemon-protocol-vocabulary.ts";
import { admitRepoMode, settingsCommandTopology } from "../src/repo-mode.ts";

const localSource = "local" as const;
const assignmentSource = { kind: "assignment", nodeId: "edge-one", assignmentId: "assignment-one" } as const;
const admissionRoutes = new Set(["direct", "via-assignment", "via-center-forward", "rejected"]);

test("all 138 daemon commands close every repo-mode admission cell", () => {
  assert.equal(daemonProtocolCommands.length, 138);
  let cells = 0;
  for (const command of daemonProtocolCommands) {
    assert.deepEqual(Object.keys(command.admission).sort(), [...daemonRepoModeWords].sort(), command.id);
    for (const mode of daemonRepoModeWords) {
      cells += 1;
      const route = command.admission[mode];
      assert.equal(admissionRoutes.has(route), true, `${command.id} ${mode} ${route}`);
      const direct = admitRepoMode(mode, command, localSource),
        assigned = admitRepoMode(mode, command, assignmentSource);
      if (route === "direct") {
        assert.equal(direct.ok, true, `${command.id} ${mode} direct fixture`);
      } else if (route === "via-assignment") {
        assert.equal(direct.ok, false, `${command.id} ${mode} requires assignment`);
        assert.equal(assigned.ok, true, `${command.id} ${mode} assignment fixture`);
      } else if (route === "via-center-forward") {
        assert.equal(direct.ok, false, `${command.id} ${mode} forwards instead of executing locally`);
        assert.match(direct.nextAction, /forward/iu, command.id);
      } else {
        assert.equal(direct.ok, false, `${command.id} ${mode} explicitly rejected`);
        assert.equal(assigned.ok, false, `${command.id} ${mode} explicitly rejected for assignments`);
      }
    }
  }
  assert.equal(cells, 138 * 3);
});

test("observe.tail declares direct admission and named source residency for every tail kind", () => {
  const command = observeTailReadMethod;
  assert.deepEqual(command.admission, {
    local: "direct",
    "remote-center": "direct",
    "remote-edge": "direct",
  });
  assert.deepEqual(command.residency, {
    events: "projection",
    "repo-log": "runtime-local",
    "daemon-log": "runtime-local",
    dispatch: "runtime-local",
  });
  for (const mode of daemonRepoModeWords)
    assert.equal(admitRepoMode(mode, command, localSource).ok, true, `observe.tail ${mode} direct fixture`);
});

test("Schedule descriptors derive all three mode routes without a CLI mode branch", () => {
  const byId = new Map(daemonProtocolCommands.map((command) => [command.id, command]));
  for (const id of ["schedule-create", "schedule-update", "schedule-delete", "schedule-enable", "schedule-disable"])
    assert.deepEqual(byId.get(id)?.admission, {
      local: "direct",
      "remote-center": "via-assignment",
      "remote-edge": "via-center-forward",
    });
  for (const id of ["schedule-list", "schedule-runs", "schedule-show"])
    assert.deepEqual(byId.get(id)?.admission, {
      local: "direct",
      "remote-center": "direct",
      "remote-edge": "via-center-forward",
    });
  assert.deepEqual(byId.get("schedule-run-now")?.admission, {
    local: "direct",
    "remote-center": "via-assignment",
    "remote-edge": "direct",
  });
  assert.equal(admitRepoMode("remote-center", byId.get("schedule-run-now")!, localSource).ok, false);
  assert.equal(admitRepoMode("remote-center", byId.get("schedule-run-now")!, assignmentSource).ok, true);
});

test("Settings CLI read uses the common read topology while update forwards from edge", () => {
  const byId = new Map(daemonProtocolCommands.map((command) => [command.id, command]));
  assert.deepEqual(byId.get("settings-read")?.admission, {
    local: "direct",
    "remote-center": "direct",
    "remote-edge": "direct",
  });
  assert.deepEqual(byId.get("settings-update")?.admission, {
    local: "direct",
    "remote-center": "direct",
    "remote-edge": "via-center-forward",
  });
  assert.equal(byId.get("settings-read")?.commandClass, "repo-read");
  assert.equal(byId.get("settings-update")?.commandClass, "repo-write");
});

test("Settings locale-only updates use local admission while repository fields keep center routing", () => {
  const descriptor = new Map(daemonProtocolCommands.map((command) => [command.id, command])).get("settings-update")!;
  assert.deepEqual(settingsCommandTopology(descriptor, { kind: "settings-update", locale: "zh-CN" }).admission, {
    local: "direct",
    "remote-center": "direct",
    "remote-edge": "direct",
  });
  assert.deepEqual(
    settingsCommandTopology(descriptor, { kind: "settings-update", defaultPreset: "strict-task" }).admission,
    descriptor.admission,
  );
  assert.deepEqual(
    settingsCommandTopology(descriptor, { kind: "settings-update", locale: "zh-CN", defaultPreset: "strict-task" })
      .admission,
    descriptor.admission,
  );
});

test("People mutations are admin Actions and forward from an edge", () => {
  const byId = new Map(daemonProtocolCommands.map((command) => [command.id, command]));
  for (const id of [
    "people-add",
    "people-set-role",
    "people-bind",
    "people-delegate",
    "people-revoke-delegation",
    "people-remove",
  ]) {
    assert.deepEqual(byId.get(id)?.admission, {
      local: "direct",
      "remote-center": "direct",
      "remote-edge": "via-center-forward",
    });
    assert.equal(byId.get(id)?.commandClass, "admin");
  }
});
