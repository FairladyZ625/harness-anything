// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  compileVerticalDeclarationEvent,
  parseVerticalDeclarationDocument,
  validateVerticalDeclarationEvent,
} from "../../src/domain/vertical-declaration.ts";

const definition = JSON.parse(
  readFileSync(new URL("../../fixtures/schemas/vertical-definition/valid.json", import.meta.url), "utf8"),
);

test("vertical declaration event owns one repository declaration and exact authored write plan", () => {
  const bundle = compileVerticalDeclarationEvent({
    type: "vertical_declared",
    definition,
    eventId: "event-vertical-declaration-1",
    opId: "vertical-declaration-initialize-1",
    workspaceRevision: 1,
    actor: { principal: { personId: "person-test" }, executor: null },
    source: "local",
    occurredAt: "2026-09-05T00:00:00.000Z",
  });
  assert.deepEqual(validateVerticalDeclarationEvent(bundle.event), []);
  assert.equal(bundle.event.entity.kind, "vertical-declaration");
  assert.equal(bundle.event.payload.declaration.revision, 1);
  assert.equal(
    bundle.plan.targets.some((target) => target.kind === "authored_file" && target.path === "vertical.json"),
    true,
  );
  assert.deepEqual(
    parseVerticalDeclarationDocument(JSON.parse(bundle.blobs[0].body)),
    bundle.event.payload.declaration,
  );
});

test("vertical declaration rejects a snapshot revision different from its event cut", () => {
  const bundle = compileVerticalDeclarationEvent({
    type: "vertical_kind_retired",
    definition,
    kindId: "example",
    reason: "No longer supported.",
    eventId: "event-vertical-declaration-2",
    opId: "vertical-declaration-retire-2",
    workspaceRevision: 2,
    actor: { principal: { personId: "person-test" }, executor: null },
    source: "local",
    occurredAt: "2026-09-05T00:00:00.000Z",
  });
  assert.notDeepEqual(
    validateVerticalDeclarationEvent({
      ...bundle.event,
      payload: { ...bundle.event.payload, declaration: { ...bundle.event.payload.declaration, revision: 1 } },
    }),
    [],
  );
  assert.equal(bundle.event.payload.reason, "No longer supported.");
});
