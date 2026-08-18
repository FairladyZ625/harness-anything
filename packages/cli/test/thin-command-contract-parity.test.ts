// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { daemonProtocolCommands } from "../../daemon/src/protocol/daemon-protocol.contract.ts";
import { deriveThinCliInputs, parseThinCommand } from "../src/cli/thin-command.ts";

const frozenMutations = Object.freeze([
  { commandId: "task-create", inputName: "--title", facet: "required", argv: ["task", "create"] },
  { commandId: "task-submit", inputName: "--execution-id", facet: "kind", argv: ["task", "submit", "task-1"] },
  { commandId: "task-create", inputName: "--title", facet: "name", argv: ["task", "create"] },
  { commandId: "task-create", inputName: "--title", facet: "error", argv: ["task", "create"] },
  { commandId: "fact-search", inputName: "--confidence", facet: "enum", argv: ["fact", "search", "--confidence", "impossible"] },
  { commandId: "fact-show", inputName: "--id", facet: "regex", argv: ["fact", "show", "--task", "task-1", "--id", "bad"] },
  { commandId: "fact-record", inputName: "--memory-tag", facet: "repeated", argv: ["fact", "record", "--task", "task-1", "--statement", "s", "--source", "src", "--memory-tag", "a"] },
  { commandId: "decision-show", inputName: "--include-body", facet: "boolean", argv: ["decision", "show", "dec_1", "--include-body"] }
] as const);

test("all 82 public commands expose the canonical structured input facet", () => {
  assert.equal(daemonProtocolCommands.length, 82);
  for (const command of daemonProtocolCommands) {
    assert.equal(Object.hasOwn(command, "inputs"), true, `${command.id}: explicit inputs`);
    assert.deepEqual(deriveThinCliInputs(command), command.inputs, command.id);
    assert.equal(command.inputs.every((input) => input.name.startsWith("--") && Object.hasOwn(input, "required") && Object.hasOwn(input, "error")), true, command.id);
  }
  for (const id of ["task-show", "receipt-show", "doc-materialize", "preset-upgrade", "ledger-migrate", "daemon-start", "daemon-status", "daemon-stop"]) assert.deepEqual(daemonProtocolCommands.find((command) => command.id === id)?.inputs, [], id);
});

test("daemon-effective rebuilds keep their declared positional in usage", () => {
  // #1544: effectiveDaemonOwnedProtocolCommands rebuilds task-start and repo-bootstrap by spreading an
  // already-built command into a second defineCliCommand call. Both declare a required positional
  // (<task-id> / --repo-id etc.), and the rebuild must not silently drop it from the rendered usage.
  const taskStart = daemonProtocolCommands.find((command) => command.id === "task-start");
  assert.ok(taskStart); assert.match(taskStart.usage, /task start <task-id>/u);
  const repoBootstrap = daemonProtocolCommands.find((command) => command.id === "repo-bootstrap");
  assert.ok(repoBootstrap); assert.match(repoBootstrap.usage, /--repo-id <repo-id>/u);
});

test("frozen public-parser mutations kill every canonical input facet", () => {
  for (const mutation of frozenMutations) {
    const command = daemonProtocolCommands.find((candidate) => candidate.id === mutation.commandId); assert.ok(command, mutation.commandId);
    const input = command.inputs.find((candidate) => candidate.name === mutation.inputName); assert.ok(input, `${mutation.commandId}:${mutation.inputName}`);
    if (["required", "kind", "name", "error", "enum", "regex"].includes(mutation.facet)) assert.equal(Object.hasOwn(input, mutation.facet), true, `${mutation.commandId}:${mutation.facet}`);
    const removeInput = mutation.facet === "repeated" || mutation.facet === "boolean", inputs = removeInput ? command.inputs.filter((candidate) => candidate.name !== mutation.inputName) : command.inputs.map((candidate) => candidate.name === mutation.inputName ? Object.fromEntries(Object.entries(candidate).filter(([key]) => key !== mutation.facet)) : candidate), mutatedCommand = { ...command, inputs, flags: inputs }, catalog = daemonProtocolCommands.map((candidate) => candidate.id === command.id ? mutatedCommand : candidate) as unknown as typeof daemonProtocolCommands;
    const baseline = parseThinCommand(mutation.argv); if (["required", "kind", "name", "error"].includes(mutation.facet)) assert.throws(() => parseThinCommand(mutation.argv, process.cwd(), catalog), undefined, `${mutation.commandId}:${mutation.facet}`); else { const mutant = parseThinCommand(mutation.argv, process.cwd(), catalog); assert.notDeepEqual(mutant, baseline, `${mutation.commandId}:${mutation.facet}`); assert.equal(removeInput ? baseline.ok && !mutant.ok : !baseline.ok && mutant.ok, true, `${mutation.commandId}:${mutation.facet}`); }
  }
});
