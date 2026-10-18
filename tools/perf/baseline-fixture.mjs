// Throwaway CLI fixture shared by the cli and daemon arms: a fresh git repo the CLI inits (which
// registers the repo and autostarts a real daemon), plus the environment scoping
// tools/measure-cli-command-timing.mjs proved out — no inherited HARNESS_DAEMON_* routing, no
// inherited developer gitconfig, fixture-owned HOME.
//
// Two deliberate differences from the cli-timing fixture, both forced by the worktree:
// 1. The CLI runs from the SOURCE entry (packages/cli/src/index.ts). The compiled dist entry
//    refuses every daemon-routed command from a linked worktree by design
//    (cli_entry_not_canonical), and that guard is not ours to bypass. Source execution is the
//    mode the guard itself documents as the supported path for any checkout.
// 2. The fixture binds the in-process fake Keycloak realm (the same serveKeycloak fixture the
//    soak and GUI tests use) because the daemon refuses repo bootstrap without an RBAC authority.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { daemonRuntimeScopedEnvironmentKeys } from "../../packages/cli/src/daemon/client.ts";
import { requestDaemonJsonRpcAt } from "../../packages/daemon/src/client/local-json-rpc-client.ts";
import { requestDaemonShutdownAt } from "../../packages/daemon/src/client/local-json-rpc-shutdown.ts";
import { localUserDaemonEndpoint } from "../../packages/daemon/src/client/local-daemon-target.ts";
import { deriveBasePolicyGroups, effectivePolicyGroupScopes } from "../../packages/kernel/src/index.ts";
import { signInAt, spawnKeycloak } from "../../packages/daemon/test/keycloak.fixtures.ts";

export const PROBE_TASK_ID = "task-perf-suite-probe";
export const PROBE_REPO_ID = "alpha";
export const PROBE_PERSON_ID = "person-perf";

const TIMING_KEYS = ["HA_CLI_TIMING", "HA_CLI_TIMING_SHA"];

export function makeCliFixture(rootDir) {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "ha-perf-suite-"));
  const repo = path.join(fixtureRoot, "repo");
  const userRoot = path.join(fixtureRoot, "user");
  const home = path.join(fixtureRoot, "home");
  const cli = path.join(rootDir, "packages/cli/src/index.ts");
  if (!existsSync(cli)) throw new Error(`CLI source entry is missing at ${cli}`);
  mkdirSync(repo, { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync("git", ["-C", repo, "init", "--quiet"], { stdio: "ignore" });
  return { fixtureRoot, repo, userRoot, home, cli };
}

export function fixtureEnv(fixture, extra = {}) {
  const env = { ...process.env };
  for (const key of [...daemonRuntimeScopedEnvironmentKeys, ...TIMING_KEYS]) delete env[key];
  return {
    ...env,
    HOME: fixture.home,
    // git for Windows >= 2.55 refuses the NUL device as a config path; a missing file under the
    // fixture home reads as no configuration (same treatment as the cli-timing fixture).
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? path.join(fixture.home, ".gitconfig-empty") : "/dev/null",
    HARNESS_DAEMON_USER_ROOT: fixture.userRoot,
    ...extra,
  };
}

export function invoke(fixture, argv, { timing = false, env = {} } = {}) {
  const startedAt = performance.now();
  const result = spawnSync(process.execPath, [fixture.cli, "--root", fixture.repo, ...argv], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
    env: fixtureEnv(fixture, { ...(timing ? { HA_CLI_TIMING: "1" } : {}), ...env }),
  });
  return { ...result, wallMs: performance.now() - startedAt };
}

export function failureDetail(result) {
  return `${(result.stdout ?? "").slice(0, 600)}${(result.stderr ?? "").slice(0, 600)}`.trim() || "no output";
}

// The realm runs in its own process (spawnKeycloak, the variant keycloak.fixtures.ts provides
// for harnesses that block their event loop on spawnSync): this suite's CLI invocations are
// spawnSync, so an in-process realm server would be frozen exactly when the daemon needs it.
export async function bindFixtureRealm(fixture) {
  const realm = await spawnKeycloak();
  await realm.control({ op: "account", personId: PROBE_PERSON_ID });
  await realm.control({
    op: "permit",
    personId: PROBE_PERSON_ID,
    resource: PROBE_REPO_ID,
    actions: effectivePolicyGroupScopes(deriveBasePolicyGroups(), "admin"),
  });
  realm.bind(fixture.userRoot);
  signInAt(fixture.userRoot, PROBE_PERSON_ID);
  return realm;
}

export async function initializeFixtureRepo(fixture) {
  const initialized = invoke(fixture, [
    "--json",
    "init",
    "--repo-id",
    PROBE_REPO_ID,
    "--person-id",
    PROBE_PERSON_ID,
    "--display-name",
    "Perf Suite",
  ]);
  if (initialized.status !== 0) throw new Error(`fixture init failed: ${failureDetail(initialized)}`);
  const created = invoke(fixture, [
    "--json",
    "task",
    "create",
    "--id",
    PROBE_TASK_ID,
    "--admin",
    "--title",
    "Performance suite probe task",
  ]);
  if (created.status !== 0) throw new Error(`probe task create failed: ${failureDetail(created)}`);
  try {
    fixture.packagePath = JSON.parse(created.stdout).packagePath ?? null;
  } catch {
    fixture.packagePath = null;
  }
}

// Publishes the probe task's plan through the same doc-submit action the GUI resident-daemon
// fixture uses (the task package on disk starts as worktree-only; the canonical read the CLI
// serves needs one submitted document).
export async function submitProbeDoc(fixture) {
  if (!fixture.packagePath) throw new Error("probe task create receipt carried no packagePath");
  const endpoint = localUserDaemonEndpoint(fixture.userRoot, "default");
  const receipt = await withoutExecutionCredential(() =>
    requestDaemonJsonRpcAt(
      endpoint,
      "repo.task.run",
      {
        repo: { repoId: PROBE_REPO_ID },
        payload: { action: { kind: "doc-submit", paths: [`${fixture.packagePath}/task_plan.md`] } },
      },
      1_000,
      30_000,
    ),
  );
  if (receipt.ok !== true) throw new Error(`probe doc submit failed: ${JSON.stringify(receipt).slice(0, 600)}`);
  return `${fixture.packagePath}/task_plan.md`;
}

// The RPC clients this suite uses read process.env for an execution credential; this process may
// carry one bound to the runtime that dispatched the suite, and the fixture daemon rejects it
// (execution_credential_rejected) because it is scoped to another task. Every suite-side RPC
// against a fixture daemon runs with the credential keys lifted and restored afterwards.
export async function withoutExecutionCredential(fn) {
  const lifted = {};
  for (const key of ["HARNESS_EXECUTION_CREDENTIAL", "HARNESS_EXECUTION_EXPIRES_AT"]) {
    if (process.env[key] !== undefined) {
      lifted[key] = process.env[key];
      delete process.env[key];
    }
  }
  try {
    return await fn();
  } finally {
    Object.assign(process.env, lifted);
  }
}

// Stops the fixture daemon the same way the CLI's `daemon stop` does — a cooperative
// protocol.hello + daemon.stop exchange over the fixture socket. Going through the CLI is not
// possible from a linked worktree (cli_entry_not_canonical guards daemon control commands), and
// that guard must not be worked around from a measurement harness.
export async function stopFixtureDaemon(fixture, timeoutMs = 30_000) {
  const endpoint = localUserDaemonEndpoint(fixture.userRoot, "default");
  await withoutExecutionCredential(async () => {
    try {
      await requestDaemonShutdownAt(endpoint, 250, 2_000);
    } catch {
      // Already down or never started: the down-wait below decides.
    }
  });
  const deadline = Date.now() + timeoutMs;
  let refusals = 0;
  while (Date.now() < deadline) {
    const answered = await withoutExecutionCredential(async () => {
      try {
        const status = await requestDaemonJsonRpcAt(endpoint, "daemon.status", {}, 150, 300);
        return status.ok === true;
      } catch {
        return false;
      }
    });
    if (!answered) {
      refusals += 1;
      if (refusals >= 2) return;
    } else refusals = 0;
    await delay(150);
  }
  throw new Error(`fixture daemon did not stop within ${timeoutMs}ms`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
