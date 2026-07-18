// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { openDurableAuthorityServiceState } from "../src/daemon/authority-service-state.ts";
import {
  defaultDaemonUserRoot,
  pollUntil,
  runDaemonCommand,
  runRawJsonMaybeFail,
  stopDaemon
} from "./helpers/daemon-cli.ts";
import {
  authorityOperationRecords,
  createFixture,
  git,
  indeterminateWithoutPublication,
  prepareLongHistoryFixture,
  sealLongHistoryFixture
} from "./production-authority-canonical-ingress/fixture.ts";

test("production service exposes its socket while authority recovery scans history, then uses the persisted increment", { timeout: 120_000 }, async () => {
  const fixture = createFixture();
  const userRoot = defaultDaemonUserRoot(fixture.root);
  const env = {
    HARNESS_ACTOR: "agent:codex",
    HARNESS_DAEMON_MODE: "local",
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_DAEMON_IDLE_MS: "60000",
    HARNESS_DAEMON_AUTOSTART_TIMEOUT_MS: "20000",
    CODEX_THREAD_ID: "service-recovery-session"
  };
  const watermarkPath = path.join(
    fixture.serviceRoot,
    "authority",
    Buffer.from("canonical", "utf8").toString("base64url"),
    "recovery-watermark.json"
  );
  try {
    prepareLongHistoryFixture(fixture.authoredRoot);
    for (let index = 0; index < 800; index += 1) {
      git(fixture.authoredRoot, "commit", "-q", "--allow-empty", "-m", `fixture history ${index}`);
    }
    const coldHead = sealLongHistoryFixture(fixture.authoredRoot);
    const seededState = openDurableAuthorityServiceState({ serviceStateRoot: fixture.serviceRoot, repoId: "canonical" });
    await seededState.operationRegistry.put(indeterminateWithoutPublication());
    await seededState.close();
    const registered = runDaemonCommand(fixture.repoRoot, [
      "daemon", "repo", "register", "--repo-id", "canonical", "--canonical-root", fixture.repoRoot,
      "--user-root", userRoot, "--no-link", "--json"
    ], env);
    assert.equal(registered.ok, true, JSON.stringify(registered));

    const coldStartedAt = Date.now();
    runDaemonCommand(fixture.repoRoot, [
      "daemon", "start", "--service", "--authority-manifest", fixture.manifestPath, "--json"
    ], env);
    const coldSocketMs = Date.now() - coldStartedAt;
    const statusDuringRecovery = runDaemonCommand(fixture.repoRoot, ["daemon", "status", "--user-root", userRoot, "--json"], env);
    assert.equal(statusDuringRecovery.reachable, true, JSON.stringify(statusDuringRecovery));
    assert.equal(existsSync(watermarkPath), false, "cold full scan must still be in progress when the socket is first reachable");
    const gated = runRawJsonMaybeFail(fixture.repoRoot, [
      "task", "progress", "append", "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4", "--text", "must wait for recovery"
    ], env);
    assert.notEqual(gated.status, 0, JSON.stringify(gated.receipt));
    assert.match(JSON.stringify(gated.receipt), /AUTHORITY_RECOVERY_IN_PROGRESS/u);

    await pollUntil(
      () => existsSync(watermarkPath) ? JSON.parse(readFileSync(watermarkPath, "utf8")) as { readonly commitSha?: string } : undefined,
      (watermark) => watermark?.commitSha === coldHead,
      (watermark, error) => JSON.stringify({ watermark, error: String(error ?? "") }),
      { timeoutMs: 30_000 }
    );
    const coldRecoveryMs = Date.now() - coldStartedAt;
    assert.equal(authorityOperationRecords(fixture.serviceRoot).find((record) => record.opId === "namespace-production:unpublished-startup")?.state, "REJECTED");
    const committed = runRawJsonMaybeFail(fixture.repoRoot, [
      "task", "progress", "append", "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4", "--text", "recovery completed"
    ], env);
    assert.equal(committed.status, 0, JSON.stringify(committed.receipt));

    await stopDaemon(fixture.repoRoot, userRoot);
    for (let index = 0; index < 5; index += 1) {
      git(fixture.authoredRoot, "commit", "-q", "--allow-empty", "-m", `fixture increment ${index}`);
    }
    const incrementalHead = sealLongHistoryFixture(fixture.authoredRoot);
    const incrementalStartedAt = Date.now();
    runDaemonCommand(fixture.repoRoot, [
      "daemon", "start", "--service", "--authority-manifest", fixture.manifestPath, "--json"
    ], env);
    const incrementalSocketMs = Date.now() - incrementalStartedAt;
    await pollUntil(
      () => JSON.parse(readFileSync(watermarkPath, "utf8")) as { readonly commitSha?: string },
      (watermark) => watermark.commitSha === incrementalHead,
      (watermark, error) => JSON.stringify({ watermark, error: String(error ?? "") }),
      { timeoutMs: 10_000 }
    );
    const incrementalRecoveryMs = Date.now() - incrementalStartedAt;
    assert.ok(coldSocketMs < coldRecoveryMs, JSON.stringify({ coldSocketMs, coldRecoveryMs }));
    assert.ok(incrementalRecoveryMs < coldRecoveryMs, JSON.stringify({ incrementalRecoveryMs, coldRecoveryMs }));
    console.log(JSON.stringify({ coldSocketMs, coldRecoveryMs, incrementalSocketMs, incrementalRecoveryMs }));
  } finally {
    await stopDaemon(fixture.repoRoot, userRoot).catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
