// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { receiptDataString, writePeopleRoster } from "./helpers/forced-command-daemon.ts";
import { runRawJson, runRawJsonMaybeFail, withTempRootAsync } from "./helpers/daemon-cli.ts";
import { git, receiptPath } from "./helpers/daemon-thin-client-fixtures.ts";
import { writeSubstantiveTaskPlan } from "./helpers/task-plan-fixture.ts";

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

    const otherHolder = runRawJsonMaybeFail(rootDir, ["task", "claim", taskId, "--execution"], {
      HARNESS_DAEMON_MODE: "local",
      HARNESS_DAEMON_IDLE_MS: "10000",
      HARNESS_ACTOR: "agent:other-worker",
      CLAUDE_SESSION_ID: "",
      CLAUDE_CODE_SESSION_ID: "",
      CODEX_THREAD_ID: "other-worker-session",
      CODEX_SESSION_ID: "other-worker-session"
    });
    assert.equal(otherHolder.status, 1);
    assert.equal(otherHolder.receipt.ok, false, JSON.stringify(otherHolder.receipt));
    assert.match(String((otherHolder.receipt.error as { readonly hint?: string } | undefined)?.hint), /current holder principal=person_execution, executor=agent:daemon-cli-test/u);

    const renewed = runRawJson(rootDir, ["task", "claim", taskId, "--execution"], {
      HARNESS_DAEMON_MODE: "local",
      HARNESS_DAEMON_IDLE_MS: "10000",
      CLAUDE_SESSION_ID: "",
      CLAUDE_CODE_SESSION_ID: "",
      CODEX_THREAD_ID: "claiming-codex-session",
      CODEX_SESSION_ID: "claiming-codex-session"
    });
    assert.equal(receiptDataString(renewed, "executionId"), executionId);
    const renewedReport = (((renewed.details as Record<string, unknown>).data as Record<string, unknown>).report as {
      readonly leaseToken?: unknown;
    });
    assert.match(String(renewedReport.leaseToken), /^[0-9a-f]{64}$/u, JSON.stringify(renewed));
    assert.notEqual(renewedReport.leaseToken, claimReport.leaseToken);

    const executionPath = path.posix.join(
      receiptPath(created, "package").replace(/^harness\//u, ""),
      "executions",
      `${executionId}.md`
    );
    const branches = git(path.join(rootDir, "harness"), "branch", "--format=%(refname:short)");
    assert.doesNotMatch(branches, /^sessions\/claiming-codex-session$/mu, JSON.stringify({ claimed, branches }));
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

test("daemon-backed Execution submit materializes a newly exported Session before canonical validation", async () => {
  await withTempRootAsync(async (rootDir) => {
    runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "direct" });
    const harnessRoot = path.join(rootDir, "harness");
    git(harnessRoot, "config", "user.name", "Harness Test");
    git(harnessRoot, "config", "user.email", "harness@example.test");
    writePeopleRoster(rootDir, {
      personId: "person_test",
      displayName: "Harness Test",
      email: "harness@example.test",
      role: "owner"
    });
    const created = runRawJson(rootDir, ["task", "create", "--title", "Daemon First Submit"], {
      HARNESS_DAEMON_MODE: "direct"
    });
    const taskId = receiptDataString(created, "taskId");
    writeSubstantiveTaskPlan(rootDir, receiptPath(created, "package"));
    git(harnessRoot, "add", "--", ".");
    git(harnessRoot, "commit", "-m", "test: prepare daemon submit fixture");
    runRawJson(rootDir, ["task", "transition", taskId, "active"], { HARNESS_DAEMON_MODE: "direct" });

    const sessionId = "daemon-first-submit-session";
    const sessionDir = path.join(rootDir, ".home", ".codex", "sessions");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(path.join(sessionDir, `${sessionId}.jsonl`), [
      JSON.stringify({ timestamp: "2026-07-15T00:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "submit on the first attempt" } }),
      JSON.stringify({ timestamp: "2026-07-15T00:00:02.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "ready" }] } })
    ].join("\n"), "utf8");
    const daemonSessionEnv = {
      HARNESS_DAEMON_MODE: "local",
      HARNESS_DAEMON_IDLE_MS: "10000",
      CLAUDE_SESSION_ID: "",
      CLAUDE_CODE_SESSION_ID: "",
      CODEX_THREAD_ID: sessionId,
      CODEX_SESSION_ID: sessionId
    };
    const claimed = runRawJson(rootDir, ["task", "claim", taskId, "--execution"], daemonSessionEnv);
    const claimReport = (((claimed.details as Record<string, unknown>).data as Record<string, unknown>).report as {
      readonly leaseToken?: unknown;
    });

    const submitted = runRawJson(rootDir, [
      "task", "transition", taskId, "in_review",
      "--lease-token", String(claimReport.leaseToken),
      "--summary", "ready on the first submit",
      "--verification", "daemon session materialization verified"
    ], daemonSessionEnv);

    assert.equal(receiptDataString(submitted, "status"), "in_review", JSON.stringify(submitted));
    assert.equal(git(harnessRoot, "branch", "--list", `sessions/${sessionId}`), "");
  });
});
