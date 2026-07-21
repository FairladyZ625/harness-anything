#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = process.cwd();
const cliEntry = path.join(root, "packages/cli/src/index.ts");
const fixturePreload = pathToFileURL(fileURLToPath(new URL("./cli-test-fixture-register.mjs", import.meta.url))).href;

export function runDirectRecoverySmoke() {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "ha-direct-recovery-"));
  const isolatedHome = mkdtempSync(path.join(tmpdir(), "ha-direct-recovery-home-"));
  const env = hermeticDirectEnv(tempRoot, isolatedHome);
  try {
    runJson(tempRoot, ["init"], env);
    const created = runJson(tempRoot, ["task", "create", "--title", "Direct Recovery CI Smoke"], env);
    const taskId = created.details?.data?.taskId;
    if (typeof taskId !== "string" || !taskId.startsWith("task_")) {
      throw new Error(`direct recovery did not create a task: ${JSON.stringify(created)}`);
    }

    const listed = runJson(tempRoot, ["task", "list"], env);
    const item = listed.items?.find((candidate) => candidate.taskId === taskId);
    if (!item || item.title !== "Direct Recovery CI Smoke" || item.canonicalStatus !== "planned") {
      throw new Error(`direct recovery task was not readable: ${JSON.stringify({ taskId, listed })}`);
    }

    const evidence = {
      schema: "harness-direct-recovery-smoke/v1",
      mode: "direct",
      reason: "recovery",
      daemon: "absent",
      created: { taskId, title: item.title, status: item.canonicalStatus },
      readBack: true,
      hermetic: {
        homeIsolated: true,
        gitConfigGlobal: "/dev/null",
        gitConfigSystem: "/dev/null",
        fixturePreload: true
      }
    };
    console.log(JSON.stringify(evidence));
    return evidence;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(isolatedHome, { recursive: true, force: true });
  }
}

function runJson(tempRoot, args, env) {
  const stdout = execFileSync(process.execPath, [cliEntry, "--root", tempRoot, "--json", ...args], {
    cwd: root,
    encoding: "utf8",
    env
  });
  const receipt = JSON.parse(stdout);
  if (receipt.ok !== true || receipt.schema !== "command-receipt/v2") {
    throw new Error(`direct recovery command failed: ${JSON.stringify(receipt)}`);
  }
  return receipt;
}

function hermeticDirectEnv(tempRoot, isolatedHome) {
  return {
    PATH: process.env.PATH ?? "",
    HOME: isolatedHome,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    HARNESS_CLI_TEST_FIXTURE_PRELOAD: "1",
    NODE_OPTIONS: `--import=${fixturePreload}`,
    HARNESS_DAEMON_MODE: "direct",
    HARNESS_DIRECT_WRITE_REASON: "recovery",
    HARNESS_DAEMON_USER_ROOT: path.join(tempRoot, ".daemon-user"),
    HARNESS_BOOTSTRAP_MACHINE_IDENTITY: "1",
    HARNESS_ACTOR: "agent:direct-recovery-smoke",
    HARNESS_GIT_AUTHOR_NAME: "Harness Direct Recovery",
    HARNESS_GIT_AUTHOR_EMAIL: "direct-recovery@example.test"
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runDirectRecoverySmoke();
}
