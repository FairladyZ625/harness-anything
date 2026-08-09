// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { failureReceiptNextActions } from "../src/index.ts";

test("task lease recovery uses only the structured task id", () => {
  assert.deepEqual(failureReceiptNextActions("task_lease_required", {
    taskId: "task_01KXN3G16TKNHCV29Z4ZWM4VY2"
  }), [{
    command: "ha task start task_01KXN3G16TKNHCV29Z4ZWM4VY2",
    description: "Start the task and acquire its lease, then retry the original command."
  }]);
  assert.equal(failureReceiptNextActions("task_lease_required", {}), undefined);
});

test("daemon build drift points to a service restart", () => {
  for (const code of ["daemon_build_stale", "daemon_build_identity_unavailable"]) {
    assert.deepEqual(failureReceiptNextActions(code), [{
      command: "ha daemon restart",
      description: "Restart the daemon on the current dist build, then retry the original write."
    }]);
  }
});

test("repo recovery commands use structured repo identity and remain shell-copyable", () => {
  assert.deepEqual(failureReceiptNextActions("repo_unavailable", {
    repo: {
      repoId: "team repo",
      canonicalRoot: "/tmp/team's repo"
    }
  }), [{
    command: "ha --repo 'team repo' daemon status --json",
    description: "Inspect this repo's daemon attachment and recovery state before choosing a repair."
  }, {
    command: "ha daemon repo register --repo-id 'team repo' --root '/tmp/team'\"'\"'s repo'",
    description: "Register or re-enable this repo only if status reports that it is missing or disabled, then retry the original command."
  }]);
});

test("repo lock recovery waits for the current writer and never mutates registry state", () => {
  assert.deepEqual(failureReceiptNextActions("repo_lock_held", {
    repo: {
      repoId: "canonical",
      canonicalRoot: "/tmp/canonical",
      lockPath: ".harness/locks/global.lock",
      lastError: "lock already held by daemon owner"
    }
  }), [{
    command: "ha --repo canonical daemon status --json",
    description: "The repo writer lock is held at .harness/locks/global.lock (owner: lock already held by daemon owner). Wait for the current writer to release it, then rerun this status command before retrying. Do not register, purge, stop, or restart the repo while the lock is held."
  }]);
});
