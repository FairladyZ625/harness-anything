// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { emit } from "../src/index.ts";
import { runFleetTaskCommandClient } from "@harness-anything/daemon";
import { fleetFixture } from "../../daemon/test/fleet-tls-session.fixture.ts";

test("a successful Fleet task carries the handshake warning into CLI output", { timeout: 30_000 }, async (t) => {
  const fixture = await fleetFixture(t);
  t.after(() => fixture.close());
  const center = await fixture.center(),
    result = await runFleetTaskCommandClient({
      readAccessToken: async () => `device-token-${fixture.subject.nodeId}`,
      port: center.port,
      ca: fixture.cert,
      servername: "localhost",
      nodeId: fixture.subject.nodeId,
      credential: "machine-secret",
      repoId: fixture.subject.repoId,
      buildCommit: "0".repeat(40),
      opId: "cli-version-warning",
      taskId: fixture.subject.taskId,
      action: {
        kind: "task-progress-append",
        taskId: fixture.subject.taskId,
        executionId: fixture.subject.executionId,
        text: "version warning reaches the CLI",
      },
      waitMs: 1_000,
    });
  assert.equal(result.outcome, "applied", JSON.stringify(result));
  const warning = result.receipt?.versionWarning as {
    readonly centerBuildCommit?: unknown;
    readonly localBuildCommit?: unknown;
    readonly upgradeCommand?: unknown;
  };
  assert.equal(typeof warning.centerBuildCommit, "string");
  assert.equal(typeof warning.localBuildCommit, "string");
  assert.equal(warning.upgradeCommand, "git pull --ff-only, then build CLI and daemon");
  const lines: string[] = [],
    originalLog = console.log,
    originalError = console.error;
  console.log = (line?: unknown) => lines.push(String(line ?? ""));
  console.error = (line?: unknown) => lines.push(String(line ?? ""));
  try {
    emit(
      {
        ...(result.receipt as Record<string, unknown>),
        schema: "command-receipt/v2",
        command: "task-show",
        ok: result.outcome === "applied",
      },
      false,
    );
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  assert.match(
    lines.join("\n"),
    /WARNING version mismatch .* upgrade with git pull --ff-only, then build CLI and daemon/u,
  );
});
