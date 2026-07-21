// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  executePostMergeRuntimeRefresh,
  planPostMergeRuntimeRefresh,
  runPostMergeRuntimeRefresh
} from "./post-merge-runtime-refresh.mjs";

test("feature worktree merges build without installing the shared runtime", () => {
  const plan = planPostMergeRuntimeRefresh({
    branch: "codex/example",
    changedPaths: ["packages/daemon/src/index.ts"]
  });

  assert.deepEqual(plan, {
    buildCli: true,
    buildGui: false,
    installCli: false,
    syncDependencies: false
  });
});

test("canonical main installs daemon-only changes without scheduling daemon control", () => {
  const plan = planPostMergeRuntimeRefresh({
    branch: "main",
    changedPaths: ["packages/daemon/src/protocol/method-registry.ts"]
  });

  assert.deepEqual(plan, {
    buildCli: true,
    buildGui: false,
    installCli: true,
    syncDependencies: false
  });
});

test("test-only changes do not rebuild or install the runtime", () => {
  const plan = planPostMergeRuntimeRefresh({
    branch: "main",
    changedPaths: ["packages/daemon/test/json-rpc-protocol.test.ts"]
  });

  assert.deepEqual(plan, {
    buildCli: false,
    buildGui: false,
    installCli: false,
    syncDependencies: false
  });
});

test("lockfile changes synchronize dependencies before rebuilding both workspaces", () => {
  const plan = planPostMergeRuntimeRefresh({
    branch: "main",
    changedPaths: ["package-lock.json"]
  });

  assert.deepEqual(plan, {
    buildCli: true,
    buildGui: true,
    installCli: true,
    syncDependencies: true
  });
});

test("post-merge execution preserves dependency, CLI, GUI, and install ordering", () => {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    return "";
  };

  executePostMergeRuntimeRefresh({
    plan: {
      buildCli: true,
      buildGui: true,
      installCli: true,
      syncDependencies: true
    },
    repoRoot: "/repo",
    run
  });

  const rendered = calls.map((call) => call.join(" "));
  const dependencyIndex = rendered.findIndex((call) => call.includes("npm ci"));
  const kernelIndex = rendered.findIndex((call) => call.includes("packages/kernel/tsconfig.json"));
  const cliIndex = rendered.findIndex((call) => call.includes("@harness-anything/cli"));
  const guiIndex = rendered.findIndex((call) => call.includes("@harness-anything/gui"));
  const installIndex = rendered.findIndex((call) => call.includes("npm install -g"));
  assert.ok(dependencyIndex < kernelIndex);
  assert.ok(kernelIndex < cliIndex);
  assert.ok(cliIndex < guiIndex);
  assert.ok(guiIndex < installIndex);
  assert.equal(rendered.some((call) => /daemon (?:status|refresh|stop|start)/u.test(call)), false);
});

test("build failure stops later build and install work", () => {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args].join(" "));
    if (args.includes("@harness-anything/cli")) throw new Error("build failed");
    return "";
  };

  assert.throws(() => executePostMergeRuntimeRefresh({
    plan: {
      buildCli: true,
      buildGui: true,
      installCli: true,
      syncDependencies: false
    },
    repoRoot: "/repo",
    run
  }), /build failed/u);

  assert.equal(calls.some((call) => call.includes("@harness-anything/gui")), false);
  assert.equal(calls.some((call) => call.includes("npm install -g")), false);
});

test("post-merge discovery builds and installs without issuing daemon commands", () => {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    if (command === "git" && args[0] === "branch") return "main\n";
    if (command === "git" && args[0] === "diff") return "packages/daemon/src/index.ts\n";
    return "";
  };

  const plan = runPostMergeRuntimeRefresh({
    currentHead: "new",
    previousHead: "old",
    repoRoot: "/repo",
    run
  });

  const rendered = calls.map((call) => call.join(" "));
  assert.deepEqual(plan, {
    buildCli: true,
    buildGui: false,
    installCli: true,
    syncDependencies: false
  });
  assert.ok(rendered.some((call) => call === "git diff --name-only old new --"));
  assert.ok(rendered.some((call) => call.includes("@harness-anything/cli")));
  assert.ok(rendered.some((call) => call.includes("npm install -g")));
  assert.equal(rendered.some((call) => /daemon (?:status|refresh|stop|start)/u.test(call)), false);
});
