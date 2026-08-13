// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { daemonProtocolCommands } from "../../daemon/src/protocol/daemon-protocol.contract.ts";
import { deriveThinCliInputs, type ThinCliInput } from "../src/cli/thin-command.ts";

type CommandDeclaration = { readonly id: string; readonly path: readonly string[]; readonly usage: string; readonly flags?: readonly { readonly name: string }[] };

function inputsDeclaredByUsage(command: CommandDeclaration): readonly ThinCliInput[] {
  return [...command.usage.matchAll(/(--[a-z][a-z0-9-]*)(?:\s+(<\S+))?/gu)].flatMap((match) => {
    const name = match[1]; if (!name || command.path.includes(name)) return [];
    const prefix = command.usage.slice(0, match.index), value = match[2];
    return [{ name, kind: value ? value.endsWith("...") ? "repeated" : "single" : "boolean", required: prefix.lastIndexOf("[") <= prefix.lastIndexOf("]") } as const];
  });
}

test("thin CLI input directory has parity with every protocol command declaration", () => {
  assert.equal(daemonProtocolCommands.length, 39);
  for (const command of daemonProtocolCommands) {
    const derived = deriveThinCliInputs(command), declared = inputsDeclaredByUsage(command);
    assert.deepEqual(derived, declared, command.id);
    if ("flags" in command) assert.deepEqual([...derived.map(({ name }) => name)].sort(), [...command.flags.map(({ name }) => name)].sort(), `${command.id} structured flags`);
  }
});

test("removing any declared input kills parity instead of moving the sample", () => {
  let mutations = 0;
  for (const command of daemonProtocolCommands) {
    const expected = deriveThinCliInputs(command);
    for (const input of expected) {
      const mutated = { ...command, usage: command.usage.replace(input.name, "") };
      assert.throws(() => assert.deepEqual(deriveThinCliInputs(mutated), expected), undefined, `${command.id}:${input.name}`);
      mutations += 1;
    }
  }
  assert.ok(mutations > daemonProtocolCommands.length, `${mutations} declaration-field mutations exercised`);
});
