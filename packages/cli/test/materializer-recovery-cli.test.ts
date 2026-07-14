// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  defaultDaemonUserRoot,
  runDaemonCommand,
  runRawJson,
  sleep,
  stopDaemonQuietly,
  withTempRoot
} from "./helpers/daemon-cli.ts";
import { writePeopleRoster } from "./helpers/forced-command-daemon.ts";

test("materializer recovery does not auto-start a daemon and emits a valid success receipt", () => {
  withTempRoot((rootDir) => {
    runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "direct" });

    const receipt = runRawJson(rootDir, ["materializer", "run", "--dry-run"], {
      HARNESS_DAEMON_MODE: "local",
      HARNESS_DAEMON_IDLE_MS: "10000"
    });

    assert.equal(receipt.ok, true, JSON.stringify(receipt));
    assert.equal(receipt.command, "materializer run");
    assert.equal((receipt.details as { data?: { report?: { warnings?: unknown[] } } }).data?.report?.warnings?.length, 0);
    sleep(100);
    assert.equal(runDaemonCommand(rootDir, ["daemon", "status", "--json"]).started, false);
  });
});

test("materializer run uses an already-running daemon without contending for its lock", () => {
  withTempRoot((rootDir) => {
    runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "direct" });
    writePeopleRoster(rootDir, {
      personId: "person_materializer",
      displayName: "Materializer Operator",
      email: "materializer@example.test",
      role: "owner"
    });
    try {
      runDaemonCommand(rootDir, ["daemon", "start", "--service", "--json"]);

      const receipt = runRawJson(rootDir, ["materializer", "run", "--dry-run"], {
        HARNESS_DAEMON_MODE: "local"
      });

      assert.equal(receipt.ok, true, JSON.stringify(receipt));
    } finally {
      stopDaemonQuietly(rootDir, defaultDaemonUserRoot(rootDir));
    }
  });
});

test("daemon write receipt is not successful until its session write is readable despite an older conflict", () => {
  withTempRoot((rootDir) => {
    runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "direct" });
    writePeopleRoster(rootDir, {
      personId: "person_visibility",
      displayName: "Visibility Operator",
      email: "visibility@example.test",
      role: "owner"
    });
    createOlderConflictedSessionBranch(rootDir);

    try {
      const decisionId = "dec_receipt_visibility";
      const receipt = runRawJson(rootDir, [
        "decision", "propose",
        "--id", decisionId,
        "--title", "Receipt visibility",
        "--question", "Is the successful write readable?",
        "--chosen", "yes",
        "--rejected", "no",
        "--why-not", "A success receipt must be honest"
      ], {
        HARNESS_DAEMON_MODE: "local",
        HARNESS_DAEMON_IDLE_MS: "20000",
        CODEX_THREAD_ID: "receipt-visibility-session"
      });

      const decisionPath = path.join(rootDir, "harness/decisions/decision-dec_receipt_visibility/decision.md");
      assert.equal(receipt.ok, true, JSON.stringify(receipt));
      assert.equal(existsSync(decisionPath), true, JSON.stringify(receipt));
      const shown = runRawJson(rootDir, ["decision", "show", decisionId], {
        HARNESS_DAEMON_MODE: "local",
        HARNESS_DAEMON_IDLE_MS: "20000",
        CODEX_THREAD_ID: "receipt-visibility-session"
      });
      assert.equal(shown.ok, true, JSON.stringify(shown));
      assert.equal(git(rootDir, "branch", "--list", "sessions/receipt-visibility-session"), "");
    } finally {
      stopDaemonQuietly(rootDir, defaultDaemonUserRoot(rootDir));
    }
  });
});

test("daemon success receipt declares pending materialization with a next command when its own session conflicts", () => {
  withTempRoot((rootDir) => {
    runRawJson(rootDir, ["init"], { HARNESS_DAEMON_MODE: "direct" });
    writePeopleRoster(rootDir, {
      personId: "person_pending",
      displayName: "Pending Operator",
      email: "pending@example.test",
      role: "owner"
    });
    createOlderConflictedSessionBranch(rootDir, "receipt-pending-session");

    try {
      const receipt = runRawJson(rootDir, [
        "decision", "propose",
        "--id", "dec_receipt_pending",
        "--title", "Pending receipt",
        "--question", "Can the write be read now?",
        "--chosen", "not yet",
        "--rejected", "pretend yes",
        "--why-not", "That would be dishonest"
      ], {
        HARNESS_DAEMON_MODE: "local",
        HARNESS_DAEMON_IDLE_MS: "20000",
        CODEX_THREAD_ID: "receipt-pending-session"
      });

      const warnings = receipt.warnings as ReadonlyArray<{ readonly code?: string; readonly nextCommand?: string }>;
      const pending = warnings.find((warning) => warning.code === "pending_materialization");
      assert.equal(receipt.ok, true, JSON.stringify(receipt));
      assert.equal(pending?.nextCommand, "ha materializer run --json");
      assert.equal(existsSync(path.join(rootDir, "harness/decisions/decision-dec_receipt_pending/decision.md")), false);
    } finally {
      stopDaemonQuietly(rootDir, defaultDaemonUserRoot(rootDir));
    }
  });
});

function createOlderConflictedSessionBranch(rootDir: string, sessionId = "older-conflict"): void {
  const harnessRoot = path.join(rootDir, "harness");
  const sharedPath = path.join(harnessRoot, "conflict.txt");
  git(rootDir, "config", "user.name", "Harness Test");
  git(rootDir, "config", "user.email", "harness@example.test");
  writeFileSync(sharedPath, "base\n", "utf8");
  git(rootDir, "add", "conflict.txt");
  git(rootDir, "commit", "-m", "seed conflict fixture");
  git(rootDir, "checkout", "-b", `sessions/${sessionId}`);
  writeFileSync(sharedPath, "session\n", "utf8");
  git(rootDir, "add", "conflict.txt");
  git(rootDir, "commit", "-m", "session conflict");
  git(rootDir, "checkout", "master");
  writeFileSync(sharedPath, "trunk\n", "utf8");
  git(rootDir, "add", "conflict.txt");
  git(rootDir, "commit", "-m", "trunk conflict");
}

function git(rootDir: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", [
    "-C", path.join(rootDir, "harness"),
    "-c", "user.name=Harness Test",
    "-c", "user.email=harness@example.test",
    ...args
  ], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}
