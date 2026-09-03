// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { explainEntityKind, getExecutableEntityAction } from "../../src/domain/entity-kind-registry.ts";
import { SettingsActionError } from "../../src/domain/settings-action-contract.ts";
import { readSettingsFacet, repositorySettings } from "../../src/domain/settings.ts";

const documentBody = [
  "schema: harness-anything/v1",
  "name: settings-action-test",
  "layout:",
  "  authoredRoot: harness",
  "  adrRoot: harness/adr",
  "settings:",
  "  defaultVertical: software/coding",
  "  defaultPreset: standard-task",
  "  defaultProfile: baseline",
  "  scaffolds:",
  "    task: governance/task-scaffold.json",
  "    repository: governance/repository-scaffold.json",
  "",
].join("\n");
const current = repositorySettings(readSettingsFacet(documentBody));

test("Settings exposes executable singleton read and update contracts", () => {
  const explanation = explainEntityKind("settings"),
    byId = new Map(explanation.transitions.actions.map((action) => [action.id, action])),
    update = getExecutableEntityAction("settings-update");
  assert.deepEqual(explanation.transitions.available, ["read", "update"]);
  assert.equal(update?.execution?.implementation, "catalog-runtime");
  assert.equal(update?.execution?.targetIdField, "settingsId");
  assert.equal(byId.get("update")?.concurrency.expectedVersion.conflict, "revision_conflict");
  assert.equal(byId.get("update")?.concurrency.expectedVersion.arbitration, "center-single-write-queue");
  assert.equal(byId.get("update")?.concurrency.idempotency.retry, "canonical-event-replay");
  assert.equal(byId.get("update")?.concurrency.artifactOwnership.repositoryDocument, "harness.yaml");
});

test("Settings update compiles the existing audit event with actor and parent document", () => {
  const draft = compile({ defaultPreset: "docs-task", expectedVersion: 7 });
  assert.equal(draft.kind, "settings");
  if (draft.kind !== "settings" || draft.result.kind !== "event") return;
  assert.equal(draft.result.bundle.event.type, "settings_changed");
  assert.equal(draft.result.bundle.event.entity.id, "repository");
  assert.deepEqual(draft.result.bundle.event.actor, {
    principal: { personId: "person-settings-action" },
    executor: { kind: "agent", id: "settings-action-test" },
  });
  assert.equal(draft.result.bundle.event.payload.settings.defaultPreset, "docs-task");
  assert.equal(Object.hasOwn(draft.result.bundle.event.payload.settings, "locale"), false);
  assert.match(draft.result.bundle.blobs[0].body, /defaultPreset: docs-task/u);
});

test("Settings update removes the retired layout key through the existing event path", () => {
  const draft = compile({ layoutUnset: "adrRoot", expectedVersion: 7 });
  assert.equal(draft.kind, "settings");
  if (draft.kind !== "settings" || draft.result.kind !== "event") return;
  assert.equal(draft.result.bundle.blobs[0].body.includes("adrRoot"), false);
  assert.equal(draft.result.bundle.event.payload.settings.defaultPreset, "standard-task");
});

test("Settings expectedVersion rejects a stale edge update with a typed error", () => {
  assert.throws(
    () => compile({ walFlushEvents: 512, expectedVersion: 6 }),
    (error: unknown) => error instanceof SettingsActionError && error.code === "revision_conflict",
  );
  assert.throws(
    () => compile({ locale: "zh-CN", expectedVersion: 1.5 }),
    (error: unknown) => error instanceof SettingsActionError && error.code === "invalid_command",
  );
});

test("Settings locale remains outside the canonical event compiler", () => {
  const draft = compile({ locale: "zh-CN", expectedVersion: 0 });
  assert.equal(draft.kind, "settings");
  if (draft.kind !== "settings") return;
  assert.deepEqual(draft.result, { kind: "no-changes", settings: current, revision: 7 });
});

function compile(action: Readonly<Record<string, unknown>>) {
  const compiler = getExecutableEntityAction("settings-update")?.execution?.compile;
  assert.ok(compiler);
  return compiler({
    action,
    actor: {
      principal: { personId: "person-settings-action" },
      executor: { kind: "agent", id: "settings-action-test" },
    },
    source: "local",
    session: { kind: "unavailable", reason: "contract-test" },
    opId: "settings-action-contract",
    occurredAt: "2026-09-01T00:00:00.000Z",
    workspaceRevision: 8,
    currentEntity: current,
    entityRevision: 7,
    currentDocumentBody: documentBody,
  });
}
