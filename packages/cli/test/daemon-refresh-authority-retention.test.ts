// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { requestLocalDaemonJsonRpc } from "../../daemon/src/index.ts";
import {
  defaultDaemonUserRoot,
  pollUntil,
  runDaemonCommand,
  runRawJsonMaybeFail,
  stopDaemon
} from "./helpers/daemon-cli.ts";
import { createFixture } from "./production-authority-canonical-ingress/fixture.ts";

test("production refresh automatically rebuilds from the retained authority launch configuration", { timeout: 60_000 }, async () => {
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
    const registered = runDaemonCommand(fixture.repoRoot, [
      "daemon", "repo", "register", "--repo-id", "canonical",
      "--canonical-root", fixture.repoRoot, "--user-root", userRoot, "--no-link", "--json"
    ], env);
    assert.equal(registered.ok, true, JSON.stringify(registered));

    const started = runDaemonCommand(fixture.repoRoot, [
      "daemon", "start", "--service", "--authority-manifest", fixture.manifestPath, "--json"
    ], env);
    assert.equal(started.started, true, JSON.stringify(started));
    const before = runDaemonCommand(
      fixture.repoRoot,
      ["daemon", "status", "--user-root", userRoot, "--json"],
      env
    );
    assert.equal(typeof before.pid, "number", JSON.stringify(before));

    const refresh = runRawJsonMaybeFail(fixture.repoRoot, [
      "daemon", "refresh", "--timeout-ms", "20000", "--user-root", userRoot
    ], env);
    assert.equal(refresh.status, 0, JSON.stringify(refresh.receipt));
    assert.equal(refresh.receipt.accepted, true, JSON.stringify(refresh.receipt));
    const after = await pollUntil(
      () => runDaemonCommand(fixture.repoRoot, ["daemon", "status", "--user-root", userRoot, "--json"], env),
      (status) => status.reachable === true && typeof status.pid === "number" && status.pid !== before.pid,
      (status, error) => JSON.stringify({ refresh: refresh.receipt, status, error: String(error ?? "") }),
      { timeoutMs: 20_000 }
    );
    assert.notEqual(after.pid, before.pid, JSON.stringify({ before, after }));

    const launchReceipt = await requestLocalDaemonJsonRpc(
      fixture.repoRoot,
      "admin.daemon.launch-spec",
      {},
      1_000,
      { userRoot, allowLegacySocket: false }
    );
    const launchDetails = launchReceipt.details as Record<string, unknown>;
    const launchConfiguration = launchDetails.data as { readonly args?: ReadonlyArray<string> };
    const manifestIndex = launchConfiguration.args?.indexOf("--authority-manifest") ?? -1;
    assert.notEqual(manifestIndex, -1, JSON.stringify(launchReceipt));
    assert.equal(launchConfiguration.args?.[manifestIndex + 1], fixture.manifestPath);

    const proposed = runRawJsonMaybeFail(fixture.repoRoot, [
      "decision", "propose",
      "--title", "Authority retained after refresh",
      "--question", "Did automatic daemon replacement retain production authority?",
      "--chosen", "Use the retained launch configuration",
      "--rejected", "Supply authority flags again",
      "--why-not", "Refresh must rebuild from the running daemon specification",
      "--claim", "A production write succeeds after automatic replacement",
      "--risk-tier", "medium", "--urgency", "medium", "--module", "cli"
    ], env);
    assert.equal(proposed.status, 0, JSON.stringify(proposed.receipt));
    assert.equal(proposed.receipt.ok, true, JSON.stringify(proposed.receipt));
    const decisionId = String((proposed.receipt.details as {
      readonly data?: { readonly decisionId?: string };
    } | undefined)?.data?.decisionId ?? "");
    assert.match(decisionId, /^dec_[0-9A-HJKMNP-TV-Z]{26}$/u, JSON.stringify(proposed.receipt));
    assert.equal(existsSync(path.join(fixture.authoredRoot, `decisions/decision-${decisionId}/decision.md`)), true);
  } finally {
    await stopDaemon(fixture.repoRoot, userRoot).catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
