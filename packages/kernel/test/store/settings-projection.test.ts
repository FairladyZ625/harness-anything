// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { compileSettingsChangedEvent } from "../../src/domain/settings-event.ts";
import { readSettingsFacet, writeSettingsFacet, type SettingsV1 } from "../../src/domain/settings.ts";
import { makeTaskProjection } from "../../src/projection/task-projection.ts";
import { makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { withTempStoreAsync } from "./helpers.ts";

const actor = { principal: { personId: "person-settings" }, executor: null } as const;
const rebuildTitle =
  "Settings publication commits harness.yaml and cold rebuild restores its entity and document projections";

test(rebuildTitle, async () => {
  await withTempStoreAsync(async (rootDir) => {
    const original = initRepo(rootDir),
      eventStore = makeTaskEventStore({ repoId: "settings-projection", rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore }),
      settings = { ...readSettingsFacet(original), defaultPreset: "strict-task", locale: "zh-CN" } as SettingsV1,
      candidate = writeSettingsFacet(original, settings),
      bundle = compileSettingsChangedEvent({
        settings,
        baseDocumentBody: original,
        candidateDocumentBody: candidate,
        eventId: "event-settings-1",
        opId: "op-settings-1",
        workspaceRevision: 1,
        actor,
        source: "local",
        occurredAt: "2026-08-27T01:00:00.000Z",
      });

    eventStore.append(bundle);
    projection.apply(bundle.event, bundle.plan);
    assert.equal(readFileSync(path.join(rootDir, "harness/harness.yaml"), "utf8"), candidate);
    assert.deepEqual(projection.getEntity("settings", "repository")?.value, settings);
    assert.equal(projection.readDocument("harness.yaml").document?.body, candidate);

    const liveRow = projection.getEntity("settings", "repository"),
      liveDocument = projection.readDocument("harness.yaml").document;
    projection.close();
    const cold = makeTaskProjection({
      rootDir,
      eventStore,
      projectionPath: path.join(rootDir, ".harness/cache/settings-cold.sqlite"),
    });
    assert.equal(cold.rebuild().watermark, 1);
    assert.deepEqual(cold.getEntity("settings", "repository"), liveRow);
    assert.deepEqual(cold.readDocument("harness.yaml").document, liveDocument);
  });
});

test("Settings publication rejects a candidate that also mutates layout, WIP, or probe bytes", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const original = initRepo(rootDir),
      eventStore = makeTaskEventStore({ repoId: "settings-ownership", rootDir }),
      settings = { ...readSettingsFacet(original), locale: "zh-CN" } as SettingsV1,
      ownedCandidate = writeSettingsFacet(original, settings),
      trespassing = ownedCandidate
        .replace("authoredRoot: harness", "authoredRoot: elsewhere")
        .replace("wipLimit: 60", "wipLimit: 1")
        .replace("enabled: true", "enabled: false"),
      bundle = compileSettingsChangedEvent({
        settings,
        baseDocumentBody: original,
        candidateDocumentBody: trespassing,
        eventId: "event-settings-trespass",
        opId: "op-settings-trespass",
        workspaceRevision: 1,
        actor,
        source: "local",
        occurredAt: "2026-08-27T01:00:00.000Z",
      });

    assert.throws(() => eventStore.append(bundle), /only their owned harness\.yaml facet fields/u);
    assert.equal(readFileSync(path.join(rootDir, "harness/harness.yaml"), "utf8"), original);
  });
});

function initRepo(rootDir: string): string {
  const body = [
    "schema: harness-anything/v1",
    "name: fixture",
    "layout:",
    "  authoredRoot: harness",
    "  localRoot: .harness",
    "  contextRoot: harness/context",
    "  governanceRoot: harness/governance",
    "  adrRoot: harness/adr",
    "  milestonesRoot: harness/milestones",
    "settings:",
    "  defaultVertical: software/coding",
    "  defaultPreset: standard-task",
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
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  writeFileSync(path.join(rootDir, "harness/harness.yaml"), body);
  git(rootDir, "init", "--quiet");
  git(rootDir, "config", "user.name", "Settings Projection Test");
  git(rootDir, "config", "user.email", "settings-projection@example.invalid");
  git(rootDir, "add", "harness/harness.yaml");
  git(rootDir, "commit", "--quiet", "-m", "fixture base");
  return body;
}

function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
