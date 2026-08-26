// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { sha256Text } from "../../src/integrity/stable-hash.ts";
import { compileSettingsChangedEvent, validateSettingsEvent } from "../../src/domain/settings-event.ts";
import { readSettingsFacet, writeSettingsFacet, type SettingsV1 } from "../../src/domain/settings.ts";

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

test("Settings facet codec changes owned fields and preserves every unowned byte", () => {
  const settings: SettingsV1 = {
      ...readSettingsFacet(original),
      defaultPreset: "strict-task",
      locale: "zh-CN",
    },
    candidate = writeSettingsFacet(original, settings);

  assert.deepEqual(readSettingsFacet(candidate), settings);
  assert.equal(candidate.includes("defaultPreset: strict-task # owned"), true);
  assert.equal(candidate.includes("    wipLimit: 60"), true);
  assert.equal(candidate.includes("    enabled: true"), true);
  assert.equal(candidate.replace("strict-task", "standard-task").replace("zh-CN", "en-US"), original);
});

test("settings_changed carries the singleton snapshot, parent CAS, YAML claim, and exact write plan", () => {
  const settings = { ...readSettingsFacet(original), locale: "zh-CN" } as SettingsV1,
    candidate = writeSettingsFacet(original, settings),
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
