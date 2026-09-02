// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  projectFrozenDaemonResponses,
  validateFrozenCanonicalEvents,
  validateFrozenDaemonReadside,
  validateProjectedDaemonResponses,
} from "../canonical-event-compat.mjs";
import { repoRoot } from "../git.mjs";
import { makeRepo } from "./helpers.mjs";

test("canonical event compatibility gate names a rejected frozen sample", () => {
  const { rootDir } = makeRepo({
    "packages/kernel/fixtures/canonical-events/task-event-v1/sample.json": '{"schema":"task-event/v1"}\n',
  });

  const errors = validateFrozenCanonicalEvents(rootDir, [
    {
      schema: "task-event/v1",
      validate: () => ["legacy shape is no longer accepted"],
    },
  ]);

  assert.deepEqual(errors, [
    "packages/kernel/fixtures/canonical-events/task-event-v1/sample.json [sourceEventIds=unknown]: task-event/v1 rejected frozen sample: legacy shape is no longer accepted",
  ]);
});

test("canonical event compatibility gate binds each sample to its directory schema", () => {
  const { rootDir } = makeRepo({
    "packages/kernel/fixtures/canonical-events/task-event-v1/sample.json": '{"schema":"doc-event/v1"}\n',
  });

  assert.deepEqual(
    validateFrozenCanonicalEvents(rootDir, [
      {
        schema: "task-event/v1",
        validate: () => [],
      },
    ]),
    ["packages/kernel/fixtures/canonical-events/task-event-v1/sample.json: expected task-event/v1, found doc-event/v1"],
  );
});

test("canonical event compatibility gate verifies the frozen bytes, not only parsed JSON", () => {
  const { rootDir } = makeRepo({
    "packages/kernel/fixtures/canonical-events/task-event-v1/sample.json": '{ "schema": "task-event/v1" }\n',
  });

  assert.deepEqual(
    validateFrozenCanonicalEvents(
      rootDir,
      [
        {
          schema: "task-event/v1",
          validate: () => [],
        },
      ],
      () => {
        throw new Error("canonical event bytes are not canonical");
      },
    ),
    [
      "packages/kernel/fixtures/canonical-events/task-event-v1/sample.json: frozen bytes are invalid: canonical event bytes are not canonical",
    ],
  );
});

test("canonical event compatibility gate names the source event, validator, and rejected field", () => {
  const errors = validateProjectedDaemonResponses(
    [
      {
        name: "validateDaemonDecisionList",
        sourceEventIds: ["event-83528bd4ab507b4464f6367395476707fd11d8b055bafa53eb569e189f0d1f58"],
        value: { ok: true, decisions: [{}] },
      },
    ],
    [
      {
        name: "validateDaemonDecisionList",
        validate: () => ["compatibilityCanary is required"],
      },
    ],
  );

  assert.deepEqual(errors, [
    "event-83528bd4ab507b4464f6367395476707fd11d8b055bafa53eb569e189f0d1f58 -> validateDaemonDecisionList rejected projected history: compatibilityCanary is required",
  ]);
});

test("canonical event compatibility gate requires a projected historical sample for every registered validator", () => {
  assert.deepEqual(
    validateProjectedDaemonResponses(
      [],
      [
        {
          name: "validateDaemonAgenda",
          validate: () => [],
        },
      ],
    ),
    ["validateDaemonAgenda: no projected historical sample"],
  );
});

test("canonical event compatibility gate projects the locked history through production reads", () => {
  const result = validateFrozenDaemonReadside(repoRoot());
  assert.deepEqual(result.errors, []);
  assert.equal(result.eventCount, 8);
  assert.ok(result.durationMs < 8_000);
});

test("pre-#2158 relation strength history fails the production replay with its source event id", () => {
  const result = validateFrozenDaemonReadside(repoRoot(), undefined, (event) => {
    if (event.eventId !== "event-fixture-relation-created") return event;
    const { targetObservedVersion: _targetObservedVersion, ...historical } = event.payload.relation;
    return { ...event, payload: { relation: { ...historical, strength: "strong" } } };
  });

  assert.match(result.errors.join("\n"), /event-fixture-relation-created: historical replay failed/u);
  assert.match(result.errors.join("\n"), /Relation facet fields are invalid/u);
});

test("dec_3EDA6CB3-era decision digest fails the production replay with its source event id", () => {
  const historicalDigest = "sha256:dff93a59f31e53d26a1da857d137bde0c93824056ed7f641d97b189c4e1cc3fb",
    result = validateFrozenDaemonReadside(repoRoot(), undefined, (event) =>
      event.eventId === "event-fixture-decision-accepted"
        ? {
            ...event,
            payload: {
              ...event.payload,
              judgmentConsent: { ...event.payload.judgmentConsent, machineDigest: historicalDigest },
              contentPin: { ...event.payload.contentPin, digest: historicalDigest },
            },
          }
        : event,
    );

  assert.match(result.errors.join("\n"), /event-fixture-decision-accepted: historical replay failed/u);
  assert.match(result.errors.join("\n"), /machine content cut/u);
});

test("locked-history document reads replay through the rootDir-first production signature without a worktree", () => {
  const responses = new Map(projectFrozenDaemonResponses(repoRoot()).map(({ name, value }) => [name, value]));
  const read = responses.get("validateDaemonDocumentRead"),
    list = responses.get("validateDaemonTaskDocumentList");
  assert.equal(read.ok, true);
  assert.equal(read.uncommitted, false, "projection-only history must not be labelled uncommitted");
  assert.equal(read.worktreeBody, null);
  assert.equal(list.ok, true);
  assert.ok(
    list.documents.every((row) => row.uncommitted === false),
    JSON.stringify(list.documents),
  );
});
