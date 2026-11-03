// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { makeTaskEventReader } from "@harness-anything/storage";
import { realizedTaskPlan } from "../../../tools/fixtures/task-plan.mjs";
import { signInProcessPolicyTestUser } from "./keycloak-process-policy.fixtures.ts";
import { daemonProcessAlive } from "../src/daemon-singleton.ts";
import { readDispatchStream } from "../src/dispatch-stream.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";

const repoRoot = path.resolve("packages/daemon/test/../../..");

test(
  "an old-build runtime survives release restart, is adopted and continues authorized writes",
  { timeout: 120_000 },
  async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "ha-runtime-stop-start-")),
      repo = path.join(scratch, "repo"),
      userRoot = path.join(scratch, "user"),
      bin = path.join(scratch, "bin"),
      repoId = "runtime-stop-start",
      daemonId = `runtime-stop-start-${process.pid}`,
      release = path.join(scratch, "write-after-adoption"),
      writeResult = path.join(scratch, "worker-write.json"),
      oldCliStamp = path.join(scratch, "release-A.mjs"),
      oldCliIdentity = path.join(scratch, "release-A-identity.json");
    mkdirSync(repo, { recursive: true });
    mkdirSync(bin, { recursive: true });
    // Runtime isolation intentionally drops HARNESS_BUILD_COMMIT. Freeze the old source CLI's
    // stamp in its own launch entry, and record the actual cached identity used by its hello.
    writeFileSync(
      oldCliStamp,
      `process.env.HARNESS_BUILD_COMMIT = "release-A";\n` +
        `const {daemonBuildStamp} = await import(${JSON.stringify(pathToFileURL(path.join(repoRoot, "packages/daemon/src/build-identity.ts")).href)});\n` +
        `const {writeFileSync} = await import("node:fs"); writeFileSync(${JSON.stringify(oldCliIdentity)}, JSON.stringify(daemonBuildStamp()));\n`,
    );
    await signInProcessPolicyTestUser(userRoot, "owner", [repoId], "admin");
    writeProviderExecutable(
      path.join(bin, "codex"),
      `const fs = require("node:fs");\n` +
        `if (process.argv[2] === "--version") { console.log("codex 0.0.0-stop-start"); process.exit(0); }\n` +
        `if (process.argv[2] === "login" && process.argv[3] === "status") process.exit(0);\n` +
        `fs.readFileSync(0, "utf8");\n` +
        `console.log(JSON.stringify({ type: "thread.started", thread_id: "stop-start-session" }));\n` +
        `console.log(JSON.stringify({ type: "item.completed", item: { id: "live", type: "agent_message", text: "alive" } }));\n` +
        `let wrote = false; setInterval(() => { if (wrote || !fs.existsSync(${JSON.stringify(release)})) return; wrote = true; const result = require("node:child_process").spawnSync(process.execPath, ${JSON.stringify(["--import", oldCliStamp, path.join(repoRoot, "packages/cli/src/index.ts"), "--root", repo, "--json", "task", "create", "--title", "Adopted worker write", "--preset", "docs-task", "--risk-tier", "low", "--plan-file", "session-plan.md"])}, {env: process.env, encoding: "utf8"}); fs.writeFileSync(${JSON.stringify(writeResult)}, JSON.stringify({buildCommit: JSON.parse(fs.readFileSync(${JSON.stringify(oldCliIdentity)}, "utf8")).commit, status: result.status, stdout: result.stdout, stderr: result.stderr})); }, 100);\n`,
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: path.join(scratch, "home"),
      GIT_CONFIG_GLOBAL: "/dev/null",
      HARNESS_ACTOR: "agent:runtime-stop-start-test",
      HARNESS_BUILD_COMMIT: "release-A",
      HARNESS_DAEMON_USER_ROOT: userRoot,
      HARNESS_DAEMON_ID: daemonId,
      HARNESS_DAEMON_REPO_ID: repoId,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    };
    // CLI service startup deliberately resolves the built bin. Start source entries explicitly so
    // each process resolves its own immutable test build stamp instead of the runner's dist marker.
    const start = async (buildCommit: string) => {
      const child = spawn(
        process.execPath,
        [
          path.join(repoRoot, "packages/daemon/src/bin.ts"),
          "--service",
          "--user-root",
          userRoot,
          "--daemon-id",
          daemonId,
        ],
        {
          cwd: repo,
          env: { ...env, HARNESS_BUILD_COMMIT: buildCommit },
          stdio: "ignore",
        },
      );
      return waitFor(() => {
        assert.equal(child.exitCode, null, "source daemon exited during startup");
        const status = cliMaybe(repo, env, ["daemon", "status"]).receipt;
        return status.ok === true && status.build?.commit === buildCommit ? status : null;
      });
    };
    let dispatchId = "";
    try {
      await start("release-A");
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
      writeFileSync(path.join(repo, "session-plan.md"), realizedTaskPlan("Adopted worker write"));
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
        restarted = await start("release-B"),
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
      assert.equal(daemonAfter.build?.commit, "release-B");
      // The original worker, credential, relay and stamped release-A CLI remain unchanged.
      writeFileSync(release, "write now");
      const written = await waitFor(() =>
        existsSync(writeResult) ? JSON.parse(readFileSync(writeResult, "utf8")) : null,
      );
      assert.equal(written.buildCommit, "release-A");
      assert.equal(written.status, 0, JSON.stringify(written));
      const receipt = JSON.parse(written.stdout);
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
      const created = makeTaskEventReader({ repoId, rootDir: repo })
        .read()
        .events.find((entry) => entry.type === "task_bootstrapped" && entry.opId === receipt.opId);
      assert.equal(created?.actor.principal.personId, "owner");
      assert.equal(created?.actor.executor?.id, `runtime-session:${runtimeSessionId}`);
      console.log(
        `RELEASE_ADOPTION_WRITE ${JSON.stringify({ oldBuild: written.buildCommit, daemonBuild: daemonAfter.build, workerPid, taskId: receipt.taskId, outcome: receipt.outcome, actor: created?.actor })}`,
      );
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
