// harness-test-tier: integration
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import {
  makeJournaledWriteCoordinator,
  makeOperationalJournaledWriteCoordinator,
  moduleEntityId,
  taskEntityId
} from "../../kernel/src/index.ts";
import {
  defaultDaemonUserRoot,
  pollUntil,
  runDaemonCommand,
  stopDaemon
} from "./helpers/daemon-cli.ts";
import { createFixture, git } from "./production-authority-canonical-ingress/fixture.ts";

test("production service upgrades a pre-domain mixed journal before canonical attach", { timeout: 60_000 }, async () => {
  const fixture = createFixture();
  const userRoot = defaultDaemonUserRoot(fixture.root);
  const env = {
    HARNESS_ACTOR: "agent:codex",
    HARNESS_DAEMON_MODE: "local",
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_DAEMON_IDLE_MS: "60000",
    HARNESS_DAEMON_AUTOSTART_TIMEOUT_MS: "20000"
  };
  try {
    git(fixture.authoredRoot, "config", "user.name", "Harness Upgrade Test");
    git(fixture.authoredRoot, "config", "user.email", "harness-upgrade@example.test");
    seedPreDomainJournal(fixture.repoRoot);
    const registered = runDaemonCommand(fixture.repoRoot, [
      "daemon", "repo", "register", "--repo-id", "canonical", "--canonical-root", fixture.repoRoot,
      "--user-root", userRoot, "--no-link", "--json"
    ], env);
    assert.equal(registered.ok, true, JSON.stringify(registered));
    try {
      runDaemonCommand(fixture.repoRoot, [
        "daemon", "start", "--service", "--authority-manifest", fixture.manifestPath, "--json"
      ], env);
    } catch {
      // Observe the detached service when startup outlives the CLI reachability wait.
    }
    const status = await pollUntil(
      () => runDaemonCommand(fixture.repoRoot, ["daemon", "status", "--user-root", userRoot, "--json"], env),
      (candidate) => candidate.reachable === true
        && Array.isArray(candidate.repos)
        && candidate.repos.some((repo) => repo.repoId === "canonical" && repo.state === "attached"),
      (candidate, error) => JSON.stringify({ candidate, error: String(error ?? "") }),
      { timeoutMs: 20_000 }
    );
    assert.equal(status.reachable, true, JSON.stringify(status));
    assert.equal(readFileSync(path.join(fixture.authoredRoot, "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4/upgrade.md"), "utf8"), "authority upgraded\n");
    assert.match(readFileSync(path.join(fixture.repoRoot, ".harness/generated/runtime-events/upgrade.jsonl"), "utf8"), /evt-upgrade/u);
    assert.match(git(fixture.authoredRoot, "log", "-2", "--format=%B"), /Harness-Authority-Batch:/u);
    assert.equal(readFileSync(path.join(fixture.repoRoot, ".harness/write-journal/writes.jsonl"), "utf8"), "");
  } finally {
    await stopDaemon(fixture.repoRoot, userRoot).catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function seedPreDomainJournal(rootDir: string): void {
  const legacy = makeOperationalJournaledWriteCoordinator({
    rootDir,
    operationalActor: { scope: "operational", kind: "system", id: "legacy-runtime" },
    autoMaterialize: false
  });
  const authority = makeJournaledWriteCoordinator({
    rootDir,
    attribution: {
      actor: { principal: { kind: "person", personId: "person_alice" }, executor: { kind: "agent", id: "codex" } },
      principalSource: { kind: "daemon-authenticated", providerId: "fixture-provider", credentialFingerprint: "fixture-credential" },
      executorSource: "client-asserted"
    },
    autoMaterialize: false
  });
  Effect.runSync(legacy.enqueue({
    opId: "runtime-event-upgrade",
    entityId: moduleEntityId("runtime-event-ledger"),
    kind: "machine_artifact_append_jsonl",
    payload: {
      boundary: "runtime-event-ledger",
      path: ".harness/generated/runtime-events/upgrade.jsonl",
      value: { schema: "runtime-event/v1", eventId: "evt-upgrade" }
    }
  }));
  Effect.runSync(authority.enqueue({
    opId: "op-authority-upgrade",
    entityId: taskEntityId("task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4"),
    kind: "doc_write",
    payload: { path: "upgrade.md", body: "authority upgraded\n" },
    authorityIntegrity: authorityIntegrity()
  }));
}

function authorityIntegrity() {
  return {
    schema: "authority-operation-integrity/v2" as const,
    semanticRequestDigest: "1".repeat(64),
    semanticMutationSetDigest: "2".repeat(64),
    mutationRegistryVersion: 1,
    actorAxesBindingDigest: "3".repeat(64),
    canonicalMutationSet: {
      registryVersion: 1,
      mutations: [{
        entity: { registryVersion: 1, entityKind: "task", canonicalRef: "task/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4" },
        action: { registryVersion: 1, action: "append" }
      }]
    }
  } as const;
}
