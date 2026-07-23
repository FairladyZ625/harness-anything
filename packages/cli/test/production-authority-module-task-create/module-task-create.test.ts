// harness-test-tier: nightly
// harness-test-tier-decision: dec_01KXZ2WZMB8YS18F549K8BMM7H
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  defaultDaemonUserRoot,
  pollUntil,
  runDaemonCommand,
  runRawJsonMaybeFail,
  stopDaemon
} from "../helpers/daemon-cli.ts";
import {
  createFixture,
  enablePresetAwareTaskCreate,
  installProductionArtifactPreset,
  writeColdCodexSessionLog
} from "../production-authority-canonical-ingress/fixture.ts";

test("production task create supports parent plus an existing module and rejects inline module registration", { timeout: 120_000 }, async () => {
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
    enablePresetAwareTaskCreate(fixture.authoredRoot);
    installProductionArtifactPreset(fixture.repoRoot);
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
      // Production authority startup can outlive the fixed reachability wait.
    }
    await pollUntil(
      () => runDaemonCommand(fixture.repoRoot, ["daemon", "status", "--user-root", userRoot, "--json"], env),
      (status) => status.reachable === true,
      (status, error) => JSON.stringify({ status, error: error instanceof Error ? error.message : String(error ?? "") }),
      { timeoutMs: 20_000 }
    );

    const sessionId = "service-module-task-create-session";
    writeColdCodexSessionLog(fixture.repoRoot, sessionId);
    const commandEnv = { ...env, CODEX_THREAD_ID: sessionId };
    const missingModuleTask = runRawJsonMaybeFail(fixture.repoRoot, [
      "task", "create",
      "--title", "Missing module task",
      "--preset", "long-running-task",
      "--module", "missing-daemon-performance"
    ], commandEnv);
    assert.equal(missingModuleTask.status, 1, JSON.stringify(missingModuleTask.receipt));
    assert.equal(missingModuleTask.receipt.error?.code, "module_not_found", JSON.stringify(missingModuleTask.receipt));
    assert.equal(
      missingModuleTask.receipt.error?.hint,
      "Module missing-daemon-performance was not found.",
      JSON.stringify(missingModuleTask.receipt)
    );

    const moduleRegistered = runRawJsonMaybeFail(fixture.repoRoot, [
      "module", "register", "daemon-performance", "--title", "Daemon Performance", "--scope", "packages/daemon/**"
    ], commandEnv);
    assert.equal(moduleRegistered.status, 0, JSON.stringify(moduleRegistered.receipt));
    assert.equal(moduleRegistered.receipt.ok, true, JSON.stringify(moduleRegistered.receipt));

    const parentTaskId = "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4";
    const moduleTaskCreated = runRawJsonMaybeFail(fixture.repoRoot, [
      "task", "create",
      "--title", "Service route module preset task",
      "--parent", parentTaskId,
      "--preset", "long-running-task",
      "--module", "daemon-performance"
    ], commandEnv);
    assert.equal(moduleTaskCreated.status, 0, JSON.stringify(moduleTaskCreated.receipt));
    assert.equal(moduleTaskCreated.receipt.ok, true, JSON.stringify(moduleTaskCreated.receipt));
    const packagePath = (moduleTaskCreated.receipt.paths as ReadonlyArray<{ readonly role?: string; readonly path?: string }> | undefined)
      ?.find((entry) => entry.role === "package")?.path ?? "";
    assert.equal(existsSync(path.join(fixture.repoRoot, packagePath, "INDEX.md")), true);
    assert.match(readFileSync(path.join(fixture.repoRoot, packagePath, "INDEX.md"), "utf8"), new RegExp(`^parent: ${parentTaskId}$`, "mu"));
    assert.match(readFileSync(path.join(fixture.repoRoot, packagePath, "module.md"), "utf8"), /^Module key: daemon-performance$/mu);

    const inlineModuleRegistration = runRawJsonMaybeFail(fixture.repoRoot, [
      "task", "create",
      "--title", "Unsupported inline module registration",
      "--preset", "long-running-task",
      "--register-module", "inline-daemon-performance",
      "--module-title", "Inline Daemon Performance",
      "--module-scope", "packages/daemon/**"
    ], commandEnv);
    assert.equal(inlineModuleRegistration.status, 1, JSON.stringify(inlineModuleRegistration.receipt));
    assert.equal(inlineModuleRegistration.receipt.error?.code, "authority_ingress_rejected", JSON.stringify(inlineModuleRegistration.receipt));
    assert.match(
      inlineModuleRegistration.receipt.error?.hint ?? "",
      /rejected new-task variant register-module: inline module registration is a cross-entity composite write/u
    );

    const moduleUnregistered = runRawJsonMaybeFail(fixture.repoRoot, [
      "module", "unregister", "daemon-performance"
    ], commandEnv);
    assert.equal(moduleUnregistered.status, 0, JSON.stringify(moduleUnregistered.receipt));
    assert.equal(moduleUnregistered.receipt.ok, true, JSON.stringify(moduleUnregistered.receipt));
    const unregisteredModuleTask = runRawJsonMaybeFail(fixture.repoRoot, [
      "task", "create",
      "--title", "Unregistered module task",
      "--preset", "long-running-task",
      "--module", "daemon-performance"
    ], commandEnv);
    assert.equal(unregisteredModuleTask.status, 1, JSON.stringify(unregisteredModuleTask.receipt));
    assert.equal(unregisteredModuleTask.receipt.error?.code, "module_not_found", JSON.stringify(unregisteredModuleTask.receipt));
    assert.equal(
      unregisteredModuleTask.receipt.error?.hint,
      "Module daemon-performance was not found.",
      JSON.stringify(unregisteredModuleTask.receipt)
    );
  } finally {
    await stopDaemon(fixture.repoRoot, userRoot).catch(() => undefined);
    if (process.env.KEEP_AUTHORITY_SERVICE_FIXTURE !== "1") rmSync(fixture.root, { recursive: true, force: true });
  }
});
