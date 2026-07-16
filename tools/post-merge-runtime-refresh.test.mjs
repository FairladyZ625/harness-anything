// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  executePostMergeRuntimeRefresh,
  planPostMergeRuntimeRefresh,
  runPostMergeRuntimeRefresh
} from "./post-merge-runtime-refresh.mjs";

test("feature worktree merges never install or restart the shared runtime", () => {
  const plan = planPostMergeRuntimeRefresh({
    branch: "codex/example",
    changedPaths: ["packages/daemon/src/index.ts"],
    daemonStatus: {
      started: true,
      reachable: true,
      pid: 42,
      rootDir: "/repo"
    },
    repoRoot: "/repo/.worktrees/example"
  });

  assert.equal(plan.buildCli, true);
  assert.equal(plan.installCli, false);
  assert.equal(plan.refreshDaemon, false);
});

test("canonical main installs daemon-only changes without starting a stopped daemon", () => {
  const plan = planPostMergeRuntimeRefresh({
    branch: "main",
    changedPaths: ["packages/daemon/src/protocol/method-registry.ts"],
    daemonStatus: {
      started: false,
      reachable: false,
      rootDir: "/repo"
    },
    repoRoot: "/repo"
  });

  assert.deepEqual(plan, {
    buildCli: true,
    buildGui: false,
    installCli: true,
    refreshDaemon: false,
    syncDependencies: false
  });
});

test("canonical main does not restart when the old daemon PID is unknown", () => {
  const plan = planPostMergeRuntimeRefresh({
    branch: "main",
    changedPaths: ["packages/daemon/src/index.ts"],
    daemonStatus: { started: true, reachable: true, rootDir: "/repo" },
    repoRoot: "/repo"
  });

  assert.equal(plan.installCli, true);
  assert.equal(plan.refreshDaemon, false);
});

test("test-only changes do not rebuild or restart the installed runtime", () => {
  const plan = planPostMergeRuntimeRefresh({
    branch: "main",
    changedPaths: ["packages/daemon/test/json-rpc-protocol.test.ts"],
    daemonStatus: { started: true, reachable: true, pid: 42, rootDir: "/repo" },
    repoRoot: "/repo"
  });

  assert.equal(plan.buildCli, false);
  assert.equal(plan.buildGui, false);
  assert.equal(plan.installCli, false);
  assert.equal(plan.refreshDaemon, false);
});

test("lockfile changes synchronize dependencies before rebuilding both workspaces", () => {
  const plan = planPostMergeRuntimeRefresh({
    branch: "main",
    changedPaths: ["package-lock.json"],
    daemonStatus: { started: false, reachable: false },
    repoRoot: "/repo"
  });

  assert.equal(plan.syncDependencies, true);
  assert.equal(plan.buildCli, true);
  assert.equal(plan.buildGui, true);
  assert.equal(plan.installCli, true);
  assert.equal(plan.refreshDaemon, false);
});

test("canonical refresh completes every build and install before requesting canonical control", () => {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    if (args.includes("refresh")) {
      return JSON.stringify({
        ok: true,
        schema: "daemon-command/v1",
        command: "daemon-refresh",
        accepted: true,
        operationId: "control-refresh",
        kind: "refresh",
        before: {
          pid: 42,
          loadedIdentity: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        }
      });
    }
    if (args.includes("status")) {
      return JSON.stringify({
        ok: true,
        started: true,
        reachable: true,
        pid: 84,
        queueDepth: 0,
        rootDir: "/repo",
        service: {
          pid: 84,
          queue: { depth: 0 },
          build: {
            loadedIdentity: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            installedIdentity: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            stale: false
          }
        },
        requestedRepo: { canonicalRoot: "/repo" }
      });
    }
    return "";
  };

  executePostMergeRuntimeRefresh({
    daemonStatus: {
      started: true,
      reachable: true,
      pid: 42,
      rootDir: "/repo",
      service: {
        pid: 42,
        build: {
          loadedIdentity: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        }
      }
    },
    plan: {
      buildCli: true,
      buildGui: true,
      installCli: true,
      refreshDaemon: true,
      syncDependencies: true
    },
    repoRoot: "/repo",
    run
  });

  const rendered = calls.map((call) => call.join(" "));
  const refreshIndex = rendered.findIndex((call) => call.includes("daemon refresh"));
  assert.ok(rendered.findIndex((call) => call.includes("npm ci")) < refreshIndex);
  assert.ok(rendered.findIndex((call) => call.includes("@harness-anything/cli")) < refreshIndex);
  assert.ok(rendered.findIndex((call) => call.includes("@harness-anything/gui")) < refreshIndex);
  assert.ok(rendered.findIndex((call) => call.includes("npm install -g")) < refreshIndex);
  assert.ok(refreshIndex >= 0);
  assert.ok(rendered[refreshIndex].includes("--trigger post-merge"));
  assert.equal(rendered.some((call) => call.includes("daemon stop")), false);
  assert.equal(rendered.some((call) => call.includes("daemon start")), false);
  assert.ok(rendered.some((call) => call.includes("daemon status --json")));
  assert.ok(rendered.some((call) => call.includes("task list --limit 1")));
});

test("build failure leaves the running daemon untouched", () => {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args].join(" "));
    if (args.includes("@harness-anything/cli")) throw new Error("build failed");
    return "";
  };

  assert.throws(() => executePostMergeRuntimeRefresh({
    daemonStatus: { started: true, reachable: true, pid: 42, rootDir: "/repo" },
    plan: {
      buildCli: true,
      buildGui: false,
      installCli: true,
      refreshDaemon: true,
      syncDependencies: false
    },
    repoRoot: "/repo",
    run
  }), /build failed/u);

  assert.equal(calls.some((call) => call.includes("daemon refresh")), false);
});

test("RPC rejection leaves post-merge verification untouched", () => {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args].join(" "));
    if (args.includes("refresh")) {
      return JSON.stringify({ ok: false, schema: "daemon-command/v1", command: "daemon-refresh" });
    }
    return "";
  };

  assert.throws(() => executePostMergeRuntimeRefresh({
    daemonStatus: { started: true, reachable: true, pid: 42, rootDir: "/repo" },
    plan: {
      buildCli: false,
      buildGui: false,
      installCli: false,
      refreshDaemon: true,
      syncDependencies: false
    },
    repoRoot: "/repo",
    run
  }), /refresh request was rejected/u);

  assert.equal(calls.some((call) => call.includes("daemon status")), false);
});

test("refresh verification rejects an unchanged daemon PID", () => {
  assert.throws(() => executePostMergeRuntimeRefresh({
    daemonStatus: {
      started: true,
      reachable: true,
      pid: 42,
      rootDir: "/repo",
      service: {
        pid: 42,
        build: {
          loadedIdentity: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        }
      }
    },
    plan: {
      buildCli: false,
      buildGui: false,
      installCli: false,
      refreshDaemon: true,
      syncDependencies: false
    },
    repoRoot: "/repo",
    statusPollAttempts: 1,
    run: (_command, args) => args.includes("refresh")
      ? JSON.stringify({
        ok: true,
        accepted: true,
        operationId: "control-refresh",
        kind: "refresh",
        before: {
          pid: 42,
          loadedIdentity: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        }
      })
      : JSON.stringify({
        started: true,
        reachable: true,
        service: {
          pid: 42,
          queue: { depth: 0 },
          build: {
            loadedIdentity: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            installedIdentity: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            stale: false
          }
        },
        requestedRepo: { canonicalRoot: "/repo" }
      })
  }), /PID did not change/u);
});

test("refresh verification rejects an unchanged loaded build identity", () => {
  const identity = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  assert.throws(() => executePostMergeRuntimeRefresh({
    daemonStatus: {
      started: true,
      reachable: true,
      pid: 42,
      rootDir: "/repo",
      service: { pid: 42, build: { loadedIdentity: identity } }
    },
    plan: {
      buildCli: false,
      buildGui: false,
      installCli: false,
      refreshDaemon: true,
      syncDependencies: false
    },
    repoRoot: "/repo",
    statusPollAttempts: 1,
    run: (_command, args) => args.includes("refresh")
      ? JSON.stringify({
        ok: true,
        accepted: true,
        operationId: "control-refresh",
        kind: "refresh",
        before: { pid: 42, loadedIdentity: identity }
      })
      : JSON.stringify({
        started: true,
        reachable: true,
        service: {
          pid: 84,
          queue: { depth: 0 },
          build: { loadedIdentity: identity, installedIdentity: identity, stale: false }
        },
        requestedRepo: { canonicalRoot: "/repo" }
      })
  }), /build identity did not change/u);
});

test("post-merge discovery refreshes a running canonical daemon for daemon-only changes", () => {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    if (command === "git" && args[0] === "branch") return "main\n";
    if (command === "git" && args[0] === "diff") return "packages/daemon/src/index.ts\n";
    if (command === "ha") {
      return JSON.stringify({
        started: true,
        reachable: true,
        pid: 42,
        rootDir: "/repo",
        service: {
          pid: 42,
          build: {
            loadedIdentity: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          }
        }
      });
    }
    if (args.includes("refresh")) {
      return JSON.stringify({
        ok: true,
        accepted: true,
        operationId: "control-refresh",
        kind: "refresh",
        before: {
          pid: 42,
          loadedIdentity: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        }
      });
    }
    if (args.includes("status")) {
      return JSON.stringify({
        started: true,
        reachable: true,
        pid: 84,
        queueDepth: 0,
        rootDir: "/repo",
        service: {
          pid: 84,
          queue: { depth: 0 },
          build: {
            loadedIdentity: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            installedIdentity: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            stale: false
          }
        },
        requestedRepo: { canonicalRoot: "/repo" }
      });
    }
    return "";
  };

  runPostMergeRuntimeRefresh({
    currentHead: "new",
    previousHead: "old",
    repoRoot: "/repo",
    run
  });

  const rendered = calls.map((call) => call.join(" "));
  assert.ok(rendered.some((call) => call === "git diff --name-only old new --"));
  assert.ok(rendered.some((call) => call.includes("daemon refresh") && call.includes("--trigger post-merge")));
  assert.equal(rendered.some((call) => call.includes("daemon stop")), false);
  assert.equal(rendered.some((call) => call.includes("daemon start")), false);
});
