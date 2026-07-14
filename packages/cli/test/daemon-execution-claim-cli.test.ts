// harness-test-tier: integration
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { receiptDataString, writePeopleRoster } from "./helpers/forced-command-daemon.ts";
import { runRawJson, withTempRootAsync } from "./helpers/daemon-cli.ts";
import { git, receiptPath } from "./helpers/daemon-thin-client-fixtures.ts";

test("daemon-backed Execution claim upgrades Holder V1 and preserves the caller session binding", async () => {
  await withTempRootAsync(async (rootDir) => {
    runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "direct" });
    const harnessRoot = path.join(rootDir, "harness");
    git(harnessRoot, "config", "user.name", "Harness Test");
    git(harnessRoot, "config", "user.email", "harness@example.test");
    writePeopleRoster(rootDir, {
      personId: "person_execution",
      displayName: "Execution User",
      email: "execution@example.test",
      role: "owner"
    });
    const created = runRawJson(rootDir, ["task", "create", "--title", "Daemon Execution Claim"], {
      HARNESS_DAEMON_MODE: "local",
      HARNESS_DAEMON_IDLE_MS: "10000"
    });
    const taskId = receiptDataString(created, "taskId");

    const legacyClaim = runRawJson(rootDir, ["task", "claim", taskId], {
      HARNESS_DAEMON_MODE: "local",
      HARNESS_DAEMON_IDLE_MS: "10000",
      CLAUDE_SESSION_ID: "",
      CLAUDE_CODE_SESSION_ID: "",
      CODEX_THREAD_ID: "",
      CODEX_SESSION_ID: ""
    });
    assert.equal(legacyClaim.ok, true, JSON.stringify(legacyClaim));
    assert.equal((((legacyClaim.details as Record<string, unknown>).data as Record<string, unknown>).report as {
      readonly holder?: { readonly schema?: string };
    }).holder?.schema, "task-holder/v1");

    const claimed = runRawJson(rootDir, ["task", "claim", taskId, "--execution"], {
      HARNESS_DAEMON_MODE: "local",
      HARNESS_DAEMON_IDLE_MS: "10000",
      CLAUDE_SESSION_ID: "",
      CLAUDE_CODE_SESSION_ID: "",
      CODEX_THREAD_ID: "claiming-codex-session",
      CODEX_SESSION_ID: "claiming-codex-session"
    });

    assert.equal(claimed.ok, true, JSON.stringify(claimed));
    const executionId = receiptDataString(claimed, "executionId");
    assert.match(executionId, /^exe_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/u, JSON.stringify(claimed));
    const claimReport = (((claimed.details as Record<string, unknown>).data as Record<string, unknown>).report as {
      readonly leaseToken?: unknown;
    });
    assert.match(String(claimReport.leaseToken), /^[0-9a-f]{64}$/u, JSON.stringify(claimed));
    const executionPath = path.posix.join(
      receiptPath(created, "package").replace(/^harness\//u, ""),
      "executions",
      `${executionId}.md`
    );
    const execution = JSON.parse(git(
      harnessRoot,
      "show",
      `master:${executionPath}`
    )) as {
      readonly session_bindings?: ReadonlyArray<{ readonly session_ref?: string | null }>;
    };
    assert.equal(execution.session_bindings?.[0]?.session_ref, "session/claiming-codex-session");
    assert.equal(git(harnessRoot, "branch", "--list", "sessions/claiming-codex-session"), "");

    const holder = runRawJson(rootDir, ["task", "holder", taskId], {
      HARNESS_DAEMON_MODE: "local",
      HARNESS_DAEMON_IDLE_MS: "10000"
    });
    const holderData = (holder.details as { readonly data?: { readonly holder?: { readonly schema?: string } } } | undefined)?.data;
    assert.equal(holderData?.holder?.schema, "task-holder/v2");

    const released = runRawJson(rootDir, ["task", "release", taskId], {
      HARNESS_DAEMON_MODE: "local",
      HARNESS_DAEMON_IDLE_MS: "10000",
      CLAUDE_SESSION_ID: "",
      CLAUDE_CODE_SESSION_ID: "",
      CODEX_THREAD_ID: "claiming-codex-session",
      CODEX_SESSION_ID: "claiming-codex-session"
    });
    assert.equal(released.ok, true, JSON.stringify(released));

    const releasedHolder = runRawJson(rootDir, ["task", "holder", taskId], {
      HARNESS_DAEMON_MODE: "local",
      HARNESS_DAEMON_IDLE_MS: "10000"
    });
    const releasedHolderData = (releasedHolder.details as {
      readonly data?: { readonly holder?: { readonly schema?: string; readonly holder?: unknown } }
    } | undefined)?.data;
    assert.equal(releasedHolderData?.holder?.schema, "task-holder/v1");
    assert.equal(releasedHolderData?.holder?.holder, null);
  });
});
