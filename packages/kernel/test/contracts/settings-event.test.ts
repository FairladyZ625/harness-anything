// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { sha256Text } from "../../src/integrity/stable-hash.ts";
import { compileSettingsChangedEvent, validateSettingsEvent } from "../../src/domain/settings-event.ts";
import { requireEntityKindContract } from "../../src/domain/entity-kind-registry.ts";
import { interpretEntityValue } from "../../src/domain/entity-kind-projection.ts";
import {
  SETTINGS_FIELD_OWNERSHIP,
  SETTINGS_REPOSITORY_V1_SCHEMA,
  SETTINGS_V1_SCHEMA,
  validateRepositorySettings,
  readSettingsFacet,
  repositorySettings,
  writeRepositorySettingsFacet,
  type SettingsV1,
} from "../../src/domain/settings.ts";

const original = [
  "schema: harness-anything/v1",
  "name: fixture",
  "layout:",
  "  authoredRoot: harness",
  "settings:",
  "  defaultVertical: software/coding",
  "  defaultPreset: standard-task # owned",
  "  defaultProfile: baseline",
  "  locale: en-US",
  "  tasks:",
  "    wipLimit: 60",
  "  e2eProbe:",
  "    enabled: true",
  "  scaffolds:",
  "    task: governance/task-scaffold.json",
  "    repository: governance/repository-scaffold.json",
  "",
].join("\n");

test("every Settings business field declares repository or local ownership", () => {
  const businessFields = Object.keys(SETTINGS_V1_SCHEMA.properties).filter(
    (field) => field !== "schema" && field !== "settingsId",
  );
  assert.deepEqual(businessFields.sort(), Object.keys(SETTINGS_FIELD_OWNERSHIP).sort());
  for (const field of businessFields)
    assert.equal(
      SETTINGS_V1_SCHEMA.properties[field]!["x-settings-ownership"],
      SETTINGS_FIELD_OWNERSHIP[field as keyof typeof SETTINGS_FIELD_OWNERSHIP],
      field,
    );
});

test("a repository Settings declaration recorded before reviewIndependence existed still projects", () => {
  // Positive control: the exact shape `settings-initialize` wrote on 2026-08-31, before the field was added.
  // Projection rebuilds (schema bumps) re-validate every stored declaration against the registry schema, so a
  // field that has a read-side default must not be required here or every older repository latches on rebuild.
  const legacy = {
    schema: "settings/v1",
    settingsId: "repository",
    defaultVertical: "software/coding",
    defaultPreset: "standard-task",
    defaultProfile: "baseline",
    scaffolds: { task: "governance/task-scaffold.json", repository: "governance/repository-scaffold.json" },
    walFlush: { adaptive: true, events: 256, bytes: 8388608, milliseconds: 2000 },
  };
  assert.deepEqual(validateRepositorySettings(legacy), []);
  assert.equal(SETTINGS_REPOSITORY_V1_SCHEMA.required.includes("reviewIndependence"), false);
  assert.equal(SETTINGS_V1_SCHEMA.required.includes("reviewIndependence"), false);
  const interpreted = interpretEntityValue(requireEntityKindContract("settings"), legacy);
  assert.equal(interpreted.id, "repository");
  assert.equal(repositorySettings(legacy as never).reviewIndependence, "execution");
});

test("Settings defaults review independence to the execution axis when omitted", () => {
  assert.equal(readSettingsFacet(original).reviewIndependence, "execution");
  assert.equal(repositorySettings(readSettingsFacet(original)).reviewIndependence, "execution");
});

test("Settings facet codec changes owned fields and preserves every unowned byte", () => {
  const settings: SettingsV1 = {
      ...readSettingsFacet(original),
      defaultPreset: "strict-task",
      locale: "zh-CN",
    },
    candidate = writeRepositorySettingsFacet(original, settings);

  assert.deepEqual(repositorySettings(readSettingsFacet(candidate)), repositorySettings(settings));
  assert.equal(candidate.includes("defaultPreset: strict-task # owned"), true);
  assert.equal(candidate.includes("    wipLimit: 60"), true);
  assert.equal(candidate.includes("    enabled: true"), true);
  assert.equal(candidate.includes("locale: en-US"), false);
  assert.equal(candidate.replace("strict-task", "standard-task"), original.replace("  locale: en-US\n", ""));
});

test("Settings facet persists all adaptive WAL flush controls", () => {
  const settings: SettingsV1 = {
      ...readSettingsFacet(original),
      walFlush: { adaptive: false, events: 4096, bytes: 16_777_216, milliseconds: 30_000 },
    },
    candidate = writeRepositorySettingsFacet(original, settings);
  assert.deepEqual(readSettingsFacet(candidate).walFlush, settings.walFlush);
  assert.match(
    candidate,
    /  walFlush:\n    adaptive: false\n    events: 4096\n    bytes: 16777216\n    milliseconds: 30000/u,
  );
  assert.equal(candidate.includes("    wipLimit: 60"), true);
});

test("settings_changed carries the singleton snapshot, parent CAS, YAML claim, and exact write plan", () => {
  const settings = { ...readSettingsFacet(original), locale: "zh-CN" } as SettingsV1,
    candidate = writeRepositorySettingsFacet(original, settings),
    bundle = compileSettingsChangedEvent({
      settings,
      baseDocumentBody: original,
      candidateDocumentBody: candidate,
      eventId: "event-settings-1",
      opId: "op-settings-1",
      workspaceRevision: 1,
      actor: { principal: { personId: "person-settings" }, executor: null },
      source: "local",
      occurredAt: "2026-08-27T01:00:00.000Z",
    });

  assert.deepEqual(validateSettingsEvent(bundle.event), []);
  assert.equal(Object.hasOwn(bundle.event.payload.settings, "locale"), false);
  assert.equal(bundle.event.entity.id, "repository");
  assert.equal(bundle.event.type, "settings_changed");
  assert.equal(bundle.event.payload.baseDocumentSha256, sha256Text(original));
  assert.deepEqual(bundle.blobs[0], {
    sha256: sha256Text(candidate),
    size: Buffer.byteLength(candidate),
    mediaType: "application/yaml",
    body: candidate,
  });
  assert.deepEqual(
    bundle.plan.targets.filter(({ kind }) => kind === "projection_invalidation"),
    [
      { kind: "projection_invalidation", projection: "document/v1", key: "harness.yaml" },
      { kind: "projection_invalidation", projection: "entity/v1", key: "settings/repository" },
    ],
  );
});
