// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { readUnionAttributionEvents } from "../../kernel/src/index.ts";
import {
  defaultDaemonUserRoot,
  runDaemonCommand,
  runRawJson,
  runRawJsonMaybeFail,
  stopDaemonQuietly,
  withTempRoot,
  withTempRootAsync
} from "./helpers/daemon-cli.ts";
import { receiptDataString, writePeopleRoster } from "./helpers/forced-command-daemon.ts";

test("local daemon derives its owner from project identity when people roster is absent", () => {
  withTempRoot((rootDir) => {
    const identityEnv = {
      HARNESS_GIT_AUTHOR_NAME: "Harness Test",
      HARNESS_GIT_AUTHOR_EMAIL: "harness@example.test"
    };
    runRawJson(rootDir, ["init"], {
      ...identityEnv,
      HARNESS_ACTOR: "agent:test-bootstrap",
      HARNESS_DAEMON_MODE: "direct"
    });
    assert.equal(existsSync(path.join(rootDir, "harness/people.yaml")), false);

    const created = runRawJson(rootDir, ["new-task", "--title", "Rosterless Local Daemon Write"], {
      HARNESS_DAEMON_MODE: "local",
      HARNESS_DAEMON_IDLE_MS: "250",
      ...identityEnv
    });

    assert.equal(created.ok, true);
    assert.equal(((created.details as Record<string, unknown>).actor as { personId?: string }).personId, "person_test");
    assert.equal(
      execFileSync("git", ["-C", path.join(rootDir, "harness"), "log", "-1", "--pretty=format:%an <%ae>"], { encoding: "utf8" }),
      "Harness Test <harness@example.test>"
    );
  });
});

test("linked worktree writes route to the canonical daemon with transport-derived identity", async () => {
  await withTempRootAsync(async (rootDir) => {
    initOuterGitRepo(rootDir);
    const userRoot = defaultDaemonUserRoot(rootDir);
    runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "direct", HARNESS_DAEMON_USER_ROOT: userRoot });
    const created = runRawJson(rootDir, ["new-task", "--title", "Worktree Daemon Routing"], {
      HARNESS_DAEMON_MODE: "direct",
      HARNESS_DAEMON_USER_ROOT: userRoot
    });
    writePeopleRoster(rootDir, {
      personId: "person_owner",
      displayName: "Owner User",
      email: "owner@example.test",
      role: "owner"
    });
    runDaemonCommand(rootDir, ["daemon", "start", "--service", "--json"], { HARNESS_DAEMON_USER_ROOT: userRoot });

    const worktreeRoot = path.join(rootDir, ".worktrees", "feature");
    execFileSync("git", ["-C", rootDir, "worktree", "add", "-q", "-b", "feature", worktreeRoot]);
    assert.equal(existsSync(path.join(worktreeRoot, "harness")), false);
    const worktreeCommandRoot = path.join(worktreeRoot, "packages", "cli");
    mkdirSync(worktreeCommandRoot, { recursive: true });

    const taskId = receiptDataString(created, "taskId");
    const progressArgs = [
      "--actor", "agent:worktree-worker",
      "task", "progress", "append", taskId, "--text", "routed from linked worktree"
    ];
    const progressed = runRawJsonMaybeFail(worktreeCommandRoot, progressArgs, {
      HARNESS_ACTOR: "",
      HARNESS_DAEMON_MODE: "local",
      HARNESS_DAEMON_USER_ROOT: userRoot
    });

    assert.equal(progressed.receipt.ok, true, JSON.stringify(progressed.receipt));
    const progressEvent = readUnionAttributionEvents(rootDir)
      .findLast((event) => event.actor.executor?.id === "worktree-worker");
    assert.deepEqual(progressEvent?.actor, {
      principal: { kind: "person", personId: "person_owner" },
      executor: { kind: "agent", id: "worktree-worker" }
    });
    assert.equal(progressEvent?.principalSource.kind, "daemon-authenticated");
    assert.equal(progressEvent?.executorSource, "client-asserted");

    stopDaemonQuietly(rootDir, userRoot);
    const directRejected = runRawJsonMaybeFail(worktreeCommandRoot, progressArgs, {
      HARNESS_ACTOR: "",
      HARNESS_DAEMON_MODE: "direct",
      HARNESS_DIRECT_WRITE_REASON: "",
      HARNESS_DAEMON_USER_ROOT: userRoot,
      NODE_TEST_CONTEXT: ""
    });
    assert.notEqual(directRejected.status, 0);
    assert.match(JSON.stringify(directRejected.receipt), /Direct canonical writes are disabled/u);

    const directFallback = runRawJsonMaybeFail(worktreeCommandRoot, progressArgs, {
      HARNESS_ACTOR: "",
      HARNESS_DAEMON_MODE: "direct",
      HARNESS_DIRECT_WRITE_REASON: "recovery",
      HARNESS_DAEMON_USER_ROOT: userRoot
    });
    assert.notEqual(directFallback.status, 0);
    assert.equal((directFallback.receipt.error as { readonly code?: string }).code, "task_not_found");
    assert.equal(
      (directFallback.receipt.warnings as ReadonlyArray<{ readonly message?: string }> | undefined)
        ?.some((warning) => /machine identity|people\.yaml/u.test(warning.message ?? "")),
      true
    );

    const localWrite = runRawJsonMaybeFail(worktreeCommandRoot, [
      "--actor", "agent:worktree-worker", "new-task", "--title", "Must Not Write Locally"
    ], {
      HARNESS_ACTOR: "",
      HARNESS_DAEMON_MODE: "direct",
      HARNESS_DIRECT_WRITE_REASON: "recovery",
      HARNESS_DAEMON_USER_ROOT: userRoot
    });
    assert.notEqual(localWrite.status, 0);
    assert.equal((localWrite.receipt.error as { readonly code?: string }).code, "write_rejected");
    assert.match((localWrite.receipt.error as { readonly hint?: string }).hint ?? "", /machine identity|people\.yaml/u);
  });
});

function initOuterGitRepo(rootDir: string): void {
  execFileSync("git", ["-C", rootDir, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", rootDir, "config", "user.name", "Harness Test"]);
  execFileSync("git", ["-C", rootDir, "config", "user.email", "harness@example.test"]);
  writeFileSync(path.join(rootDir, "README.md"), "fixture\n", "utf8");
  execFileSync("git", ["-C", rootDir, "add", "README.md"]);
  execFileSync("git", ["-C", rootDir, "commit", "-q", "-m", "seed outer repo"]);
}
