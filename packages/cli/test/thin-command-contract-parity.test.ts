// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  DAEMON_RPC_SCHEMA,
  daemonMethodAcceptsPayloadExecutor,
  daemonProtocolCommands,
  validateDaemonRpcCall,
} from "../../daemon/src/protocol/daemon-protocol.contract.ts";
import { unknownFieldViolation } from "../../daemon/src/protocol/json-rpc-types.ts";
import { deriveThinCliInputs, parseThinCommand } from "../src/cli/thin-command.ts";

const frozenMutations = Object.freeze([
  { commandId: "task-create", inputName: "--title", facet: "required", argv: ["task", "create"] },
  { commandId: "task-submit", inputName: "--execution-id", facet: "kind", argv: ["task", "submit", "task-1"] },
  { commandId: "task-create", inputName: "--title", facet: "name", argv: ["task", "create"] },
  { commandId: "task-create", inputName: "--title", facet: "error", argv: ["task", "create"] },
  {
    commandId: "fact-search",
    inputName: "--confidence",
    facet: "enum",
    argv: ["fact", "search", "--confidence", "impossible"],
  },
  {
    commandId: "fact-show",
    inputName: "--id",
    facet: "regex",
    argv: ["fact", "show", "--task", "task-1", "--id", "bad"],
  },
  {
    commandId: "fact-record",
    inputName: "--memory-tag",
    facet: "repeated",
    argv: ["fact", "record", "--task", "task-1", "--statement", "s", "--source", "src", "--memory-tag", "a"],
  },
  {
    commandId: "decision-show",
    inputName: "--include-body",
    facet: "boolean",
    argv: ["decision", "show", "dec_1", "--include-body"],
  },
] as const);

test("all public commands expose the canonical structured input facet", () => {
  assert.equal(daemonProtocolCommands.length, 135);
  for (const command of daemonProtocolCommands) {
    assert.equal(Object.hasOwn(command, "inputs"), true, `${command.id}: explicit inputs`);
    assert.deepEqual(deriveThinCliInputs(command), command.inputs, command.id);
    assert.equal(
      command.inputs.every(
        (input) => input.name.startsWith("--") && Object.hasOwn(input, "required") && Object.hasOwn(input, "error"),
      ),
      true,
      command.id,
    );
  }
  for (const id of [
    "task-show",
    "receipt-show",
    "doc-materialize",
    "preset-upgrade",
    "ledger-migrate",
    "daemon-projection-rebuild",
    "daemon-start",
    "daemon-status",
  ])
    assert.deepEqual(daemonProtocolCommands.find((command) => command.id === id)?.inputs, [], id);
  // daemon-stop is the one daemon control with a flag: --force is the supported escalation when
  // a cooperative stop times out, and the usage line is derived from this declaration.
  const daemonStop = daemonProtocolCommands.find((command) => command.id === "daemon-stop");
  assert.deepEqual(
    daemonStop?.inputs.map((input) => [input.name, input.kind]),
    [["--force", "boolean"]],
    "daemon-stop",
  );
  assert.match(daemonStop?.usage ?? "", /daemon stop \[--force\]/u, "daemon-stop");
  for (const id of [
    "people-add",
    "people-set-role",
    "people-bind",
    "people-delegate",
    "people-revoke-delegation",
    "people-remove",
    "schedule-show",
    "schedule-update",
    "schedule-delete",
  ]) {
    const fromFile = daemonProtocolCommands
      .find((command) => command.id === id)
      ?.inputs.find((input) => input.name === "--from-file");
    assert.ok(fromFile, `${id}: --from-file`);
    assert.equal(fromFile.kind, "single", id);
    assert.equal((fromFile.jsonFields?.length ?? 0) > 0, true, `${id}: JSON required fields`);
    assert.equal((fromFile.jsonAllowedFields?.length ?? 0) >= (fromFile.jsonFields?.length ?? 0), true, id);
  }
});

test("daemon-effective rebuilds keep their declared positional in usage", () => {
  // #1544: effectiveDaemonOwnedProtocolCommands rebuilds task-start and repo-bootstrap by spreading an
  // already-built command into a second defineCliCommand call. Both declare a required positional
  // (<task-id> / --repo-id etc.), and the rebuild must not silently drop it from the rendered usage.
  const taskStart = daemonProtocolCommands.find((command) => command.id === "task-start");
  assert.ok(taskStart);
  assert.match(taskStart.usage, /task start <task-id>/u);
  const repoBootstrap = daemonProtocolCommands.find((command) => command.id === "repo-bootstrap");
  assert.ok(repoBootstrap);
  assert.match(repoBootstrap.usage, /--repo-id <repo-id>/u);
});

test("closed-field violations bind the rejected name to the legal field table", () => {
  assert.equal(
    unknownFieldViolation({ schema: "probe", permissionMode: "bypass" }, ["schema", "permission-mode"]),
    'unknown field "permissionMode"; allowed fields: "schema", "permission-mode".',
  );
  assert.equal(unknownFieldViolation({ schema: "probe" }, ["schema", "permission-mode"]), null);
});

// #1572: the CLI executor-injection surface is derived from the daemon shapes (daemonMethodAcceptsPayloadExecutor),
// not a hand-copied method list. This register reconciles both directions: the reviewed surface below, and the
// real wire validator — wherever injection may happen, validateDaemonRpcCall must accept the field, and wherever
// a payload envelope exists without the declaration, the validator must reject the field. A newly contracted
// command therefore needs no CLI edit to stay un-injected, and removing a declaration from an injected method
// fails here instead of silently dropping attribution.
const reviewedExecutorSurface = Object.freeze([
  "repo.task.create",
  "repo.preset.list",
  "repo.preset.inspect",
  "repo.preset.check",
  "repo.preset.validate",
  "repo.preset.install",
  "repo.preset.seed",
  "repo.preset.audit",
  "repo.preset.uninstall",
  "repo.preset.upgrade",
  "repo.vertical.validate",
  "repo.template.list",
  "repo.template.render",
  "repo.script.list",
  "repo.script.inspect",
  "repo.script.run",
  "repo.preset.run.start",
  "repo.preset.run.status",
  "repo.agentRuntime.spawn",
] as const);
const agent = Object.freeze({ kind: "agent", id: "parity-probe" });
const payloadShapeOf = (params: (typeof DAEMON_RPC_SCHEMA.methods)[number]["params"]) => {
  const payload = params.fields.payload;
  return typeof payload === "object" && payload !== null && "fields" in payload ? payload : null;
};

test("executor injection follows the daemon-declared surface exactly", () => {
  for (const { method, params } of DAEMON_RPC_SCHEMA.methods) {
    const accepts = daemonMethodAcceptsPayloadExecutor(method),
      payload = payloadShapeOf(params);
    const errors = validateDaemonRpcCall({
      method,
      params: { repo: { repoId: "parity" }, payload: { executor: agent } },
    });
    const executorRejected = errors.some((error) =>
      error.includes('params.payload contains an unknown field "executor"'),
    );
    assert.equal(
      accepts,
      reviewedExecutorSurface.includes(method),
      `${method}: derived surface matches the reviewed register`,
    );
    if (accepts)
      assert.equal(executorRejected, false, `${method}: the validator must accept a declared payload executor`);
    else if (payload && !payload.open)
      assert.equal(executorRejected, true, `${method}: an undeclared payload executor must be rejected`);
    else if (!payload)
      assert.equal(
        errors.some((error) => error.includes('params contains an unknown field "payload"')),
        true,
        `${method}: carries no payload envelope at all`,
      );
  }
  // repo.task.run is the one structural exception: the executor rides inside the open action envelope.
  assert.deepEqual(
    validateDaemonRpcCall({
      method: "repo.task.run",
      params: { repo: { repoId: "parity" }, payload: { action: { kind: "task-list", executor: agent } } },
    }),
    [],
  );
  assert.equal(daemonMethodAcceptsPayloadExecutor("repo.task.run"), false);
  assert.equal(daemonMethodAcceptsPayloadExecutor("repo.not.contracted"), false);
});

test("frozen public-parser mutations kill every canonical input facet", () => {
  for (const mutation of frozenMutations) {
    const command = daemonProtocolCommands.find((candidate) => candidate.id === mutation.commandId);
    assert.ok(command, mutation.commandId);
    const input = command.inputs.find((candidate) => candidate.name === mutation.inputName);
    assert.ok(input, `${mutation.commandId}:${mutation.inputName}`);
    if (["required", "kind", "name", "error", "enum", "regex"].includes(mutation.facet))
      assert.equal(Object.hasOwn(input, mutation.facet), true, `${mutation.commandId}:${mutation.facet}`);
    const removeInput = mutation.facet === "repeated" || mutation.facet === "boolean",
      inputs = removeInput
        ? command.inputs.filter((candidate) => candidate.name !== mutation.inputName)
        : command.inputs.map((candidate) =>
            candidate.name === mutation.inputName
              ? Object.fromEntries(Object.entries(candidate).filter(([key]) => key !== mutation.facet))
              : candidate,
          ),
      mutatedCommand = { ...command, inputs, flags: inputs },
      catalog = daemonProtocolCommands.map((candidate) =>
        candidate.id === command.id ? mutatedCommand : candidate,
      ) as unknown as typeof daemonProtocolCommands;
    const baseline = parseThinCommand(mutation.argv);
    if (["required", "kind", "name", "error"].includes(mutation.facet))
      assert.throws(
        () => parseThinCommand(mutation.argv, process.cwd(), catalog),
        undefined,
        `${mutation.commandId}:${mutation.facet}`,
      );
    else {
      const mutant = parseThinCommand(mutation.argv, process.cwd(), catalog);
      assert.notDeepEqual(mutant, baseline, `${mutation.commandId}:${mutation.facet}`);
      assert.equal(
        removeInput ? baseline.ok && !mutant.ok : !baseline.ok && mutant.ok,
        true,
        `${mutation.commandId}:${mutation.facet}`,
      );
    }
  }
});
