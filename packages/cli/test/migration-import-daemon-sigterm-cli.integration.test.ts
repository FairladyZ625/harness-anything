// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { spawnKeycloak, signInAt } from "../../daemon/test/keycloak.fixtures.ts";
import { deriveBasePolicyGroups, effectivePolicyGroupScopes } from "@harness-anything/kernel";
import { makeTaskEventReader, makeTaskProjection, sha256Text, stableStringify } from "@harness-anything/kernel";
import { localUserDaemonEndpoint } from "../src/daemon/client.ts";
import { multiSourceFixture, sources } from "../../daemon/test/migration-import.fixtures.ts";

const realm = await spawnKeycloak();
after(() => realm.close());
await realm.control({ op: "account", personId: "owner" });
for (const resource of ["source-alpha", "control", "interrupted"])
  await realm.control({
    op: "permit",
    personId: "owner",
    resource,
    actions: effectivePolicyGroupScopes(deriveBasePolicyGroups(), "admin"),
  });

const cli = path.resolve("packages/cli/src/index.ts");

test(
  "CLI migrate import reports exit 0 after SIGTERM during its first ledger write only when the import is complete",
  { skip: process.platform === "win32" ? "requires POSIX SIGTERM delivery to a detached daemon" : false },
  async (context) => {
    const parent = mkdtempSync(path.join(process.platform === "win32" ? tmpdir() : "/tmp", "ha-cli-sigterm-")),
      source = path.join(parent, "source"),
      control = path.join(parent, "control"),
      interrupted = path.join(parent, "interrupted"),
      userRoot = path.join(parent, "user"),
      childTmp = path.join(parent, "tmp");
    mkdirSync(childTmp, { recursive: true });
    realm.bind(userRoot);
    signInAt(userRoot, "owner");
    let walPoll: NodeJS.Timeout | undefined;
    try {
      // One legacy Git source holding several event kinds (task, fact, decision, relation).
      multiSourceFixture(source, "alpha", "person_alpha");
      sources(source);
      initialize(control, userRoot, "control");
      initialize(interrupted, userRoot, "interrupted");
      // `daemon stop` plants the operator-stop marker, so it must run once, after every init;
      // the subsequent `daemon start --service` is the documented marker-clearing restart.
      run(control, userRoot, ["daemon", "stop"]);
      run(control, userRoot, ["daemon", "start", "--service"]);
      const daemonPidBefore = readDaemonPidFile(userRoot);
      assert.ok(daemonPidBefore !== null, "daemon pid file must exist after daemon start --service");

      // The uninterrupted control import is the completeness oracle for the interrupted run.
      const controlReceipt = run(control, userRoot, ["migrate", "import", "--source", source]);
      assert.equal(controlReceipt.outcome, "applied", JSON.stringify(controlReceipt));
      assert.equal(controlReceipt.exitCode, 0, JSON.stringify(controlReceipt));

      // Settle repo-open file touches before arming the watcher: import planning performs no
      // destination writes, so the first armed event is the ledger commit itself or later
      // (projection catch-up, publication followers) — never a pre-commit moment.
      run(interrupted, userRoot, ["agenda"]);

      const ledgerDir = generationLedgerDir(interrupted);
      assert.ok(ledgerDir !== null, "the initialized center must already hold a generation ledger");
      // The import performs no destination writes during planning, so the first change of the
      // ledger WAL size after arming is the durable write itself starting. FSEvents delivery on
      // macOS lags past the response window, so poll the file instead of watching it.
      const walPath = path.join(ledgerDir, "ledger.sqlite-wal"),
        walSize = (): number => (existsSync(walPath) ? statSync(walPath).size : -1),
        walBaseline = walSize();
      let sigtermTrigger: string | null = null,
        signalFailure: unknown,
        stdoutAtSignal: string | null = null;
      const child = spawn(
        process.execPath,
        [cli, "--root", interrupted, "--json", "migrate", "import", "--source", source],
        { env: environment(interrupted, userRoot, childTmp), stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "",
        stderr = "";
      assert.ok(child.stdout !== null && child.stderr !== null, "stdio pipe must be captured");
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
      walPoll = setInterval(() => {
        const size = walSize();
        if (size === walBaseline) return;
        clearInterval(walPoll);
        sigtermTrigger = `ledger.sqlite-wal@${size}`;
        stdoutAtSignal = stdout;
        try {
          process.kill(daemonPidBefore!, "SIGTERM");
        } catch (error) {
          signalFailure = error;
        }
      }, 15);

      const status = await new Promise<number | null>((resolve, reject) => {
        const bounded = setTimeout(
          () => reject(new Error(`interrupted import CLI did not exit within 120s\nstderr:\n${stderr}`)),
          120_000,
        );
        child.once("close", (code) => {
          clearTimeout(bounded);
          resolve(code);
        });
        child.once("error", (error) => {
          clearTimeout(bounded);
          reject(error);
        });
      });
      assert.ok(
        sigtermTrigger !== null,
        `the first ledger write must be observed; stdout:\n${stdout}\nstderr:\n${stderr}`,
      );
      clearInterval(walPoll);
      assert.equal(
        signalFailure,
        undefined,
        `SIGTERM must reach the daemon during the import: ${String(signalFailure)}`,
      );
      assert.equal(stdoutAtSignal, "", "the CLI must not have received a receipt before SIGTERM was sent");
      assert.equal(status, 0, `stderr:\n${stderr}\nstdout:\n${stdout}`);
      const receipt = JSON.parse(stdout.trim().split("\n").at(-1)!) as Record<string, unknown>;
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
      assert.equal(receipt.exitCode, 0, JSON.stringify(receipt));
      assert.equal(
        receipt.daemonRestart,
        undefined,
        "the original in-flight request must complete without autostart retry",
      );
      const daemonPidAfter = readDaemonPidFile(userRoot);
      assert.ok(
        daemonPidAfter === null || daemonPidAfter === daemonPidBefore,
        `this request must not start a successor daemon; before=${daemonPidBefore} after=${daemonPidAfter}`,
      );

      // Event-chain completeness: every migration event must land with the control run's exact
      // opId and restated entity. The interrupted center holds extra bookkeeping events (the
      // pre-touch agenda read, possibly a retried command), so revisions shift by design; map
      // documents legitimately differ by their generatedAt wall clock.
      const controlEvents = migrationEvents("control", control),
        interruptedEvents = migrationEvents("interrupted", interrupted);
      assert.deepEqual(
        interruptedEvents,
        controlEvents,
        "the interrupted center must hold exactly the control's migration events",
      );
      assert.ok(interruptedEvents.length >= 4, `expected several migration events, saw ${interruptedEvents.length}`);
      assert.equal(
        existsSync(path.join(interrupted, "harness", String(receipt.idMapPath))),
        true,
        "the migration id map must be published into the interrupted worktree",
      );
      const controlState = entityState(parent, "control", control),
        interruptedState = entityState(parent, "interrupted", interrupted);
      assert.deepEqual(
        interruptedState,
        controlState,
        "the interrupted center must project the control's exact entity state",
      );
      assert.equal(
        readdirSync(childTmp).filter((entry) => entry.startsWith("harness-migration-stage-")).length,
        0,
        "no migration planning workspace may survive the interrupted import",
      );
      context.diagnostic(
        [
          `sigterm.trigger=${String(sigtermTrigger)}`,
          `cli.status=${String(status)}`,
          `receipt.outcome=${String(receipt.outcome)}`,
          `receipt.daemonRestart=${JSON.stringify(receipt.daemonRestart ?? null)}`,
          `daemon.pid.before=${String(daemonPidBefore)}`,
          `daemon.pid.after=${String(daemonPidAfter)}`,
          "sigterm.signal=sent",
          "sigterm.beforeCliReceipt=true",
          `migration.events=${interruptedEvents.length}`,
          `cold.digest.control=${sha256Text(stableStringify(controlState))}`,
          `cold.digest.interrupted=${sha256Text(stableStringify(interruptedState))}`,
        ].join("\n"),
      );
    } finally {
      clearInterval(walPoll);
      stop(userRoot, interrupted);
      rmSync(parent, { recursive: true, force: true });
    }
  },
);

function initialize(root: string, userRoot: string, repoId: string): void {
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q");
  git(root, "config", "user.name", "CLI Migration Test");
  git(root, "config", "user.email", "cli-migration@example.invalid");
  git(root, "commit", "--allow-empty", "-qm", `project root ${repoId}`);
  const receipt = run(root, userRoot, [
    "init",
    "--repo-id",
    repoId,
    "--person-id",
    "person_zeyu",
    "--display-name",
    "Zeyu Li",
  ]);
  assert.equal(receipt.ok, true, JSON.stringify(receipt));
}
function run(root: string, userRoot: string, args: readonly string[], tmp = "/tmp"): Record<string, unknown> {
  const result = spawnSync(process.execPath, [cli, "--root", root, "--json", ...args], {
    encoding: "utf8",
    env: environment(root, userRoot, process.platform === "win32" ? undefined : tmp),
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}
function environment(root: string, userRoot: string, tmp: string | undefined): NodeJS.ProcessEnv {
  const { HARNESS_ACTOR: _actor, HARNESS_DAEMON_ENDPOINT: _endpoint, ...base } = process.env;
  return {
    ...base,
    ...(tmp === undefined ? {} : { TMPDIR: tmp }),
    HOME: path.join(root, ".home"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_DAEMON_ENDPOINT: localUserDaemonEndpoint(userRoot),
  };
}
function stop(userRoot: string, root: string): void {
  spawnSync(process.execPath, [cli, "--root", root, "--json", "daemon", "stop"], {
    encoding: "utf8",
    env: environment(root, userRoot, undefined),
  });
}
function readDaemonPidFile(userRoot: string): number | null {
  const target = path.join(userRoot, "daemon-default.pid");
  if (!existsSync(target)) return null;
  const pid = Number.parseInt(readFileSync(target, "utf8").trim(), 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}
function generationLedgerDir(root: string): string | null {
  const generations = path.join(root, ".harness", "store", "generations");
  if (!existsSync(generations)) return null;
  const holders = readdirSync(generations, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(generations, entry.name, "ledger.sqlite")))
    .map((entry) => Number.parseInt(entry.name, 10))
    .filter((revision) => Number.isSafeInteger(revision))
    .sort((a, b) => b - a);
  return holders.length === 0 ? null : path.join(generations, String(holders[0]));
}
function migrationEvents(repoId: string, rootDir: string): readonly unknown[] {
  return makeTaskEventReader({ repoId, rootDir })
    .read()
    .events.filter((event) => event.schema === "migration-import-event/v1")
    .map((event) => {
      const payload = event.payload as { readonly entity?: unknown; readonly migratedFrom?: unknown };
      return {
        opId: event.opId,
        migratedFrom: payload.migratedFrom ?? null,
        entity: payload.entity === undefined ? null : volatileStripped(payload.entity, /^sha256$/u),
      };
    })
    .sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)));
}
function entityState(parent: string, label: string, rootDir: string): unknown {
  const store = makeTaskEventReader({ repoId: label, rootDir }),
    projection = makeTaskProjection({
      rootDir,
      eventStore: store,
      projectionPath: path.join(parent, `cold-${label}.sqlite`),
      now: () => "2026-10-21T00:00:00.000Z",
    });
  try {
    projection.rebuild();
    return volatileStripped(
      {
        tasks: projection.list(),
        decisions: projection.listDecisions({}),
        facts: projection.readFactGraph(),
      },
      /^(?:workspaceRevision|revision|updatedAt|createdAt|at)$/u,
    );
  } finally {
    projection.close();
  }
}
// Revisions shift with the interrupted center's extra bookkeeping events and updatedAt follows the
// import wall clock; entity identity lives in every other field. Map events additionally strip
// document digests, whose bodies embed the generatedAt wall clock.
function volatileStripped(
  value: unknown,
  volatileKeys: RegExp = /^(?:workspaceRevision|revision|updatedAt)$/u,
): unknown {
  if (Array.isArray(value)) return value.map((entry) => volatileStripped(entry, volatileKeys));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !volatileKeys.test(key))
        .map(([key, entry]) => [key, volatileStripped(entry, volatileKeys)]),
    );
  return value;
}
function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
