// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { signInProcessPolicyTestUser } from "./keycloak-process-policy.fixtures.ts";
import { daemonProcessAlive } from "../src/daemon-singleton.ts";
import { readDispatchStream } from "../src/dispatch-stream.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";

const repoRoot = path.resolve("packages/daemon/test/../../..");

test(
  "a detached runtime remains alive for 60 seconds across explicit daemon stop and service start",
  { timeout: 120_000 },
  async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "ha-runtime-stop-start-")),
      repo = path.join(scratch, "repo"),
      userRoot = path.join(scratch, "user"),
      bin = path.join(scratch, "bin"),
      repoId = "runtime-stop-start",
      daemonId = `runtime-stop-start-${process.pid}`,
      release = path.join(scratch, "release");
    mkdirSync(repo, { recursive: true });
    mkdirSync(bin, { recursive: true });
    await signInProcessPolicyTestUser(userRoot, "owner", [repoId], "admin");
    writeProviderExecutable(
      path.join(bin, "codex"),
      `const fs = require("node:fs");\n` +
        `if (process.argv[2] === "--version") { console.log("codex 0.0.0-stop-start"); process.exit(0); }\n` +
        `if (process.argv[2] === "login" && process.argv[3] === "status") process.exit(0);\n` +
        `fs.readFileSync(0, "utf8");\n` +
        `console.log(JSON.stringify({ type: "thread.started", thread_id: "stop-start-session" }));\n` +
        `console.log(JSON.stringify({ type: "item.completed", item: { id: "live", type: "agent_message", text: "alive" } }));\n` +
        `const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(timer); process.exit(0); } }, 100);\n`,
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: path.join(scratch, "home"),
      GIT_CONFIG_GLOBAL: "/dev/null",
      HARNESS_ACTOR: "agent:runtime-stop-start-test",
      HARNESS_DAEMON_USER_ROOT: userRoot,
      HARNESS_DAEMON_ID: daemonId,
      HARNESS_DAEMON_REPO_ID: repoId,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    };
    let dispatchId = "";
    try {
      cli(repo, env, ["daemon", "start", "--service"]);
      cli(repo, env, ["init", "--repo-id", repoId, "--person-id", "owner", "--display-name", "Owner"]);
      const inventory = cli(repo, env, ["runtime", "instance", "list"]),
        installation = inventory.installations.find(
          (row: { kindId?: string; version?: string }) =>
            row.kindId === "codex" && row.version === "codex 0.0.0-stop-start",
        );
      assert.ok(installation, JSON.stringify(inventory));
      cli(repo, env, [
        "runtime",
        "instance",
        "create",
        "--id",
        "stop-start-runtime",
        "--name",
        "Stop Start Runtime",
        "--kind",
        "codex",
        "--installation",
        installation.installationId,
        "--provider",
        "openai",
        "--model",
        "test-model",
        "--auth",
        "subscription",
      ]);
      cli(repo, { ...env, HARNESS_ACTOR: undefined }, [
        "settings",
        "update",
        "--runtime-allowed-instance",
        "stop-start-runtime",
      ]);
      const spawned = cli(repo, env, [
          "runtime",
          "run",
          "stop-start-runtime",
          "--prompt",
          "hold across stop start",
          "--detach",
        ]),
        runtimeSessionId = String(spawned.runtimeSessionId);
      dispatchId = String(spawned.dispatchId);
      const initial = await waitFor(() => {
        const status = cliMaybe(repo, env, ["runtime", "status", runtimeSessionId]).receipt;
        return status.session?.liveness === "live" ? status : null;
      });
      const workerPid = await waitFor(() => {
        const record = readDispatchStream(repo, dispatchId)?.records.find((entry) => entry.kind === "process_started");
        return Number.isInteger(record?.pid) ? record.pid : null;
      });
      const samples: Array<{ at: string; alive: boolean }> = [],
        stopAt = new Date().toISOString(),
        stop = cli(repo, env, ["daemon", "stop"]),
        startAt = new Date().toISOString(),
        restarted = cli(repo, env, ["daemon", "start", "--service"]),
        daemonAfter = cli(repo, env, ["daemon", "status"]);
      samples.push({ at: stopAt, alive: daemonProcessAlive(workerPid) });
      const sampleTimer = setInterval(
        () => samples.push({ at: new Date().toISOString(), alive: daemonProcessAlive(workerPid) }),
        5_000,
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 60_000));
      clearInterval(sampleTimer);
      samples.push({ at: new Date().toISOString(), alive: daemonProcessAlive(workerPid) });
      const adopted = cli(repo, env, ["runtime", "status", runtimeSessionId]);
      assert.equal(
        daemonProcessAlive(workerPid),
        true,
        "worker-host must survive explicit stop/start and observation window",
      );
      assert.equal(adopted.session?.liveness, "live");
      const cancellation = cli(repo, env, ["runtime", "cancel", runtimeSessionId]),
        settled = await waitFor(() => {
          const status = cliMaybe(repo, env, ["runtime", "status", runtimeSessionId]).receipt;
          return status.session?.liveness === "exited" ? status : null;
        });
      console.log(
        `STOP_START_EVIDENCE ${JSON.stringify({ stopAt, stop, startAt, restarted, daemonAfter, workerPid, samples, initial, adopted, cancellation, settled })}`,
      );
      assert.ok(samples.length >= 13, JSON.stringify(samples));
      assert.equal(
        samples.every((sample) => sample.alive),
        true,
        JSON.stringify(samples),
      );
      assert.equal(daemonProcessAlive(workerPid), false, "worker-host must exit after adopted runtime cancellation");
    } finally {
      rmSync(release, { force: true });
      cliMaybe(repo, env, ["daemon", "stop", "--force"]);
      rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  },
);

function cli(root: string, env: NodeJS.ProcessEnv, args: readonly string[]): any {
  const result = cliMaybe(root, env, args);
  assert.equal(result.status, 0, `${result.stderr}\n${JSON.stringify(result.receipt)}`);
  return result.receipt;
}

function cliMaybe(root: string, env: NodeJS.ProcessEnv, args: readonly string[]) {
  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, "packages/cli/src/index.ts"), "--root", root, "--json", ...args],
    {
      encoding: "utf8",
      env,
      timeout: 60_000,
    },
  );
  return {
    status: result.status,
    receipt: result.stdout.trim() ? JSON.parse(result.stdout) : {},
    stderr: result.stderr,
  };
}

async function waitFor<T>(read: () => T | null, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== null) return value;
    if (Date.now() >= deadline) throw new Error(`condition did not settle within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
