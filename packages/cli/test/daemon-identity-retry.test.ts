// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { DaemonLaunchSpec } from "@harness-anything/daemon/internal/client/daemon-autostart";
import { withAutostart } from "../src/daemon/with-autostart.ts";

const unusedLaunch = (): DaemonLaunchSpec => ({ command: "unused", args: [], env: {} });

function options(parent: string) {
  return {
    autostart: false,
    env: {},
    invokingRoot: process.cwd(),
    userRoot: parent,
    daemonId: "identity-retry",
    restartBudgetMs: 5_000,
    commandCategory: "operation" as const,
  };
}

test("an identity-authority outage is retried once in the unified daemon restart path", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-identity-retry-"));
  let calls = 0;
  try {
    const result = await withAutostart(
      async () => {
        calls += 1;
        return calls === 1
          ? { ok: false, outcome: "op_rejected", code: "keycloak_unavailable" }
          : { ok: true, outcome: "applied", code: null };
      },
      unusedLaunch,
      path.join(parent, "daemon.sock"),
      options(parent),
    );
    assert.equal(result.outcome, "applied");
    assert.equal(calls, 2, "the pre-apply identity refusal is resent after its window closes");
    assert.equal((result.daemonRestart as { retries: number }).retries, 1);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a second identity-authority refusal is returned without another retry", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-identity-retry-exhausted-"));
  let calls = 0;
  try {
    const result = await withAutostart(
      async () => {
        calls += 1;
        return { ok: false, outcome: "op_rejected", code: "keycloak_unavailable" };
      },
      unusedLaunch,
      path.join(parent, "daemon.sock"),
      options(parent),
    );
    assert.equal(result.code, "keycloak_unavailable");
    assert.equal(calls, 2, "one immediate resend, then the real identity failure is returned");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("an indeterminate identity failure is not replayed", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-identity-indeterminate-"));
  let calls = 0;
  try {
    const result = await withAutostart(
      async () => {
        calls += 1;
        return { ok: false, outcome: "indeterminate", code: "keycloak_unavailable" };
      },
      unusedLaunch,
      path.join(parent, "daemon.sock"),
      options(parent),
    );
    assert.equal(result.outcome, "indeterminate");
    assert.equal(calls, 1, "a write that may already have landed is never replayed");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
