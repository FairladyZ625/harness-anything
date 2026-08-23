// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { validateFrozenCanonicalEvents, validateFrozenDaemonResponses } from "../canonical-event-compat.mjs";
import { makeRepo } from "./helpers.mjs";

test("canonical event compatibility gate names a rejected frozen sample", () => {
  const { rootDir } = makeRepo({
    "packages/kernel/fixtures/canonical-events/task-event-v1/sample.json": "{\"schema\":\"task-event/v1\"}\n"
  });

  const errors = validateFrozenCanonicalEvents(rootDir, [{
    schema: "task-event/v1",
    validate: () => ["legacy shape is no longer accepted"]
  }]);

  assert.deepEqual(errors, [
    "packages/kernel/fixtures/canonical-events/task-event-v1/sample.json: task-event/v1 rejected frozen sample: legacy shape is no longer accepted"
  ]);
});

test("canonical event compatibility gate binds each sample to its directory schema", () => {
  const { rootDir } = makeRepo({
    "packages/kernel/fixtures/canonical-events/task-event-v1/sample.json": "{\"schema\":\"doc-event/v1\"}\n"
  });

  assert.deepEqual(validateFrozenCanonicalEvents(rootDir, [{
    schema: "task-event/v1",
    validate: () => []
  }]), [
    "packages/kernel/fixtures/canonical-events/task-event-v1/sample.json: expected task-event/v1, found doc-event/v1"
  ]);
});

test("canonical event compatibility gate verifies the frozen bytes, not only parsed JSON", () => {
  const { rootDir } = makeRepo({
    "packages/kernel/fixtures/canonical-events/task-event-v1/sample.json": "{ \"schema\": \"task-event/v1\" }\n"
  });

  assert.deepEqual(validateFrozenCanonicalEvents(rootDir, [{
    schema: "task-event/v1",
    validate: () => []
  }], () => { throw new Error("canonical event bytes are not canonical"); }), [
    "packages/kernel/fixtures/canonical-events/task-event-v1/sample.json: frozen bytes are invalid: canonical event bytes are not canonical"
  ]);
});

test("canonical event compatibility gate names a rejected daemon response and validator", () => {
  const { rootDir } = makeRepo({
    "packages/daemon/fixtures/readside-responses/validateDaemonDecisionList/accepted-before-provenance.json": "{\"ok\":true,\"decisions\":[{}]}\n"
  });

  const errors = validateFrozenDaemonResponses(rootDir, [{
    name: "validateDaemonDecisionList",
    validate: () => ["provenance is required"]
  }]);

  assert.deepEqual(errors, [
    "packages/daemon/fixtures/readside-responses/validateDaemonDecisionList/accepted-before-provenance.json: validateDaemonDecisionList rejected frozen response: provenance is required"
  ]);
});

test("canonical event compatibility gate requires a frozen response for every registered validator", () => {
  const { rootDir } = makeRepo({ "README.md": "fixture repo\n" });

  assert.deepEqual(validateFrozenDaemonResponses(rootDir, [{
    name: "validateDaemonAgenda",
    validate: () => []
  }]), [
    "packages/daemon/fixtures/readside-responses/validateDaemonAgenda: validateDaemonAgenda has no frozen samples"
  ]);
});
