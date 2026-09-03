// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { normalizeProjectionLineEndings } from "./generate-daemon-status-vocabulary.mjs";
import {
  generateTaskActionProtocolProjection,
  projectTaskActions,
  renderTaskActionProtocolProjection,
} from "./generate-task-action-protocol.mjs";

const generatedSource = readFileSync(
    new URL("../packages/preset/src/task-action-projection.generated.ts", import.meta.url),
    "utf8",
  ),
  presetCommandContractSource = readFileSync(
    new URL("../packages/preset/src/preset-command-contract.ts", import.meta.url),
    "utf8",
  );

test("Task Action transport has one current build-time projection", async () => {
  await assert.doesNotReject(() => generateTaskActionProtocolProjection(true));
  assert.equal(await renderTaskActionProtocolProjection(), normalizeProjectionLineEndings(generatedSource));
  assert.match(presetCommandContractSource, /from "\.\/task-action-projection\.generated\.ts"/u);
  assert.doesNotMatch(presetCommandContractSource, /task-action-projection:generated/u);
  assert.deepEqual(
    projectTaskActions().actions.map(({ id }) => id),
    ["create", "start", "transition", "submit", "review", "consent", "reconcile", "repoint", "complete"],
  );
});

test("Task Action transport projection is readable source without compression or elision", async () => {
  const rendered = await renderTaskActionProtocolProjection();
  assert.match(rendered, /export const taskActionDescriptorProjection = \{\n/u);
  assert.doesNotMatch(rendered, /zlib|brotli|base64/iu);
  for (const field of projectTaskActions().actions.flatMap((action) => action.input.fields)) {
    assert.ok(Object.hasOwn(field, "type"), `${field.field} must project type`);
    assert.ok(Object.hasOwn(field, "required"), `${field.field} must project required`);
    if (field.cli) assert.ok(Object.hasOwn(field.cli, "error"), `${field.field} must project cli.error`);
  }
  assert.equal(
    rendered
      .split("\n")
      .filter((line) => line.length > 120)
      .join("\n"),
    "",
  );
});
