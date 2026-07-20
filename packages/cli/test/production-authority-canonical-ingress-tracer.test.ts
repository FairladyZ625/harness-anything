// harness-test-tier: integration
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createGitCanonicalPublicationInspector } from "@harness-anything/daemon";
import {
  defaultDaemonUserRoot,
  pollUntil,
  runDaemonCommand,
  runRawJsonMaybeFail,
  stopDaemon
} from "./helpers/daemon-cli.ts";
import {
  createFixture,
  latestAuthorityOperation
} from "./production-authority-canonical-ingress/fixture.ts";

test("PR canonical ingress tracer starts the real daemon and publishes one full-chain task write", { timeout: 60_000 }, async () => {
  const fixture = createFixture();
  const userRoot = defaultDaemonUserRoot(fixture.root);
  const env = {
    HARNESS_ACTOR: "agent:codex",
    HARNESS_DAEMON_MODE: "local",
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_DAEMON_IDLE_MS: "60000",
    HARNESS_DAEMON_AUTOSTART_TIMEOUT_MS: "20000",
    CODEX_THREAD_ID: "canonical-ingress-pr-tracer"
  };
  try {
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
      // Keep observing the detached production service when startup outlives
      // the CLI command's fixed reachability wait.
    }
    const status = await pollUntil(
      () => runDaemonCommand(fixture.repoRoot, ["daemon", "status", "--user-root", userRoot, "--json"], env),
      (value) => value.reachable === true,
      (value, error) => JSON.stringify({ value, error: String(error ?? "") }),
      { timeoutMs: 20_000 }
    );
    assert.equal(status.repoCount, 1, JSON.stringify(status));

    const appended = runRawJsonMaybeFail(fixture.repoRoot, [
      "task", "progress", "append", "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4",
      "--text", "PR canonical ingress tracer"
    ], env);
    assert.equal(appended.status, 0, JSON.stringify(appended.receipt));
    assert.equal(appended.receipt.ok, true, JSON.stringify(appended.receipt));
    assert.match(readFileSync(path.join(
      fixture.authoredRoot,
      "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4/progress.md"
    ), "utf8"), /PR canonical ingress tracer/u);

    const operation = latestAuthorityOperation(fixture.serviceRoot);
    assert.equal(operation.state, "COMMITTED", JSON.stringify(operation));
    assert.equal(operation.receipt?.tag, "COMMITTED", JSON.stringify(operation));
    assert.equal(typeof operation.opId, "string", JSON.stringify(operation));
    const publication = await createGitCanonicalPublicationInspector(fixture.authoredRoot)
      .findPublicationForOperation(operation.opId!);
    assert.equal(publication.commitSha, operation.commitSha);
    assert.equal(publication.physicalChanges.some((change) => change.path ===
      "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4/progress.md"), true);
    assert.equal(publication.physicalChanges.some((change) => change.path.startsWith("attribution-events/")), true);
  } finally {
    await stopDaemon(fixture.repoRoot, userRoot).catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
