// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { renderCliReceipt } from "../src/cli/receipt-render-registry.ts";
import { writeProviderExecutable } from "../../daemon/test/fixtures/runtime-stub.ts";
import { writeFileSync } from "node:fs";
import { makeTaskEventReader } from "@harness-anything/storage";
import {
  createRuntimeFixture,
  eventuallyFile,
  eventuallyNotification,
  installIdentities,
  run as runRuntimeCli,
  runMaybe as runRuntimeCliMaybe,
  seedTask,
} from "./runtime-cli.fixtures.ts";
import { readDaemonPid } from "@harness-anything/daemon/internal/runtime";
import { waitForDaemonProcessExitSync } from "./daemon-cleanup.fixture.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

const cli = path.resolve("packages/cli/src/index.ts");

test("real CLI performs machine runtime instance CRUD through an isolated resident daemon", () => {
  // Runtime installations are witnessed by scanning PATH for `claude`/`codex`, so the
  // fixture puts its own on PATH: asserting that some runtime happens to be installed
  // would assert a property of the host, which is false on every clean machine.
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-instance-cli-")),
    userRoot = path.join(root, "user"),
    binRoot = path.join(root, "bin"),
    fixtureVersion = "0.0.0-runtime-instance-fixture";
  mkdirSync(binRoot, { recursive: true });
  for (const kind of ["claude", "codex", "codex-acp"] as const)
    writeProviderExecutable(path.join(binRoot, kind), `console.log("${kind} ${fixtureVersion}");\n`);
  const env = {
    ...process.env,
    HOME: path.join(root, "home"),
    CODEX_HOME: undefined,
    CLAUDE_CONFIG_DIR: undefined,
    PATH: [
      binRoot,
      ...(process.env.PATH ?? "")
        .split(path.delimiter)
        .filter((entry) => ["codex", "codex.cmd", "codex.exe"].every((name) => !existsSync(path.join(entry, name)))),
    ].join(path.delimiter),
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_DAEMON_ID: "runtime-instance-test",
  };
  try {
    assert.equal(run(root, env, ["daemon", "start", "--service"]).ok, true);
    const initial = run(root, env, ["runtime", "instance", "list"]),
      installations = initial.installations as Array<{
        installationId: string;
        kindId: "claude" | "codex";
        version: string;
      }>;
    const installation = installations.find(
      ({ kindId, version }) => kindId === "codex" && version === `codex ${fixtureVersion}`,
    );
    assert.ok(installation, JSON.stringify(initial));
    const created = run(root, env, [
      "runtime",
      "instance",
      "create",
      "--tier",
      "2",
      "--id",
      "cli-isolated",
      "--name",
      "CLI Isolated",
      "--kind",
      installation.kindId,
      "--provider",
      "codex_local_access",
      "--model",
      "runtime-test-model",
      "--effort",
      "high",
      "--fast",
      "--base-url",
      "http://127.0.0.1:1/v1",
      "--wire-api",
      "responses",
      "--requires-openai-auth",
      "--http-header",
      "X-Harness-Probe=present",
      "--auth",
      "api-key",
      "--credential-ref",
      "keychain:harness/cli-isolated",
    ]);
    assert.equal((created.instance as Record<string, unknown>).isolationState, "enforced");
    const shown = run(root, env, ["runtime", "instance", "show", "cli-isolated"]),
      probed = run(root, env, ["runtime", "instance", "show", "cli-isolated", "--probe"]),
      listed = run(root, env, ["runtime", "instance", "list"]);
    // Background auth warmup can settle a legacy `keychain:` lookup between `create` and `show`
    // (synchronously on non-macOS hosts), moving authReadiness from `runtime_auth_not_checked` to
    // `runtime_credential_unavailable`. Assert every other field matches verbatim and validate
    // `authReadiness` explicitly.
    const { authReadiness: shownReadiness, ...shownInstance } = shown.instance as Record<string, unknown>,
      { authReadiness: _createdReadiness, ...createdInstance } = created.instance as Record<string, unknown>;
    assert.deepEqual(shownInstance, createdInstance);
    const readinessRecord = shownReadiness as Record<string, unknown>;
    assert.equal(readinessRecord.status, "not-ready");
    assert.ok(
      readinessRecord.code === "runtime_auth_not_checked" || readinessRecord.code === "runtime_credential_unavailable",
      JSON.stringify(readinessRecord),
    );
    assert.equal((shown.instance as Record<string, unknown>).tier, 2);
    run(root, env, ["runtime", "instance", "update", "cli-isolated", "--tier", "1"]);
    assert.equal(
      (run(root, env, ["runtime", "instance", "show", "cli-isolated"]).instance as Record<string, unknown>).tier,
      1,
    );
    assert.deepEqual((shown.instance as Record<string, unknown>).configuration, {
      reasoningEffort: "high",
      fast: true,
      webSearch: "disabled",
      baseUrl: "http://127.0.0.1:1/v1",
      baseUrlConfigured: true,
      wire_api: "responses",
      requires_openai_auth: true,
      http_headers: { "X-Harness-Probe": "present" },
    });
    assert.equal((listed.instances as Array<Record<string, unknown>>).length, 1);
    assert.equal((shown.instance as Record<string, unknown>).permissionMode, "bypass");
    assert.equal((shown.instance as Record<string, unknown>).mcpPolicy, "disabled");
    assert.match(renderCliReceipt(shown).text, /permissionMode: bypass/u);
    assert.match(renderCliReceipt(shown).text, /mcpPolicy: disabled/u);
    run(root, env, ["runtime", "instance", "update", "cli-isolated", "--mcp-policy", "inherit"]);
    assert.equal(
      (run(root, env, ["runtime", "instance", "show", "cli-isolated"]).instance as Record<string, unknown>).mcpPolicy,
      "inherit",
    );
    run(root, env, ["runtime", "instance", "update", "cli-isolated", "--mcp-policy", "disabled"]);
    assert.equal(
      (run(root, env, ["runtime", "instance", "show", "cli-isolated"]).instance as Record<string, unknown>).mcpPolicy,
      "disabled",
    );
    for (const permissionMode of ["bypass", "read-only", "workspace-write"]) {
      run(root, env, ["runtime", "instance", "update", "cli-isolated", "--permission-mode", permissionMode]);
      const updatedShow = run(root, env, ["runtime", "instance", "show", "cli-isolated"]),
        updatedProbe = run(root, env, ["runtime", "instance", "show", "cli-isolated", "--probe"]),
        updatedList = run(root, env, ["runtime", "instance", "list"]);
      for (const receipt of [updatedShow, updatedProbe]) {
        assert.equal((receipt.instance as Record<string, unknown>).permissionMode, permissionMode);
        assert.match(renderCliReceipt(receipt).text, new RegExp(`permissionMode: ${permissionMode}`, "u"));
      }
      assert.equal((updatedList.instances as Array<Record<string, unknown>>)[0].permissionMode, permissionMode);
      assert.match(renderCliReceipt(updatedList).text, /PERMISSION MODE/u);
      assert.ok(
        renderCliReceipt(updatedList)
          .text.split("\n")
          .some((line) => line.split("\t").includes(permissionMode)),
      );
    }
    assert.equal(
      ((probed.instance as Record<string, unknown>).authReadiness as Record<string, unknown>).status,
      "not-ready",
    );
    assert.match(String(listed.summary), /INSTALLATION\tKIND\tVERSION\tOBSERVED AT/u);
    assert.match(String(listed.summary), new RegExp(String(installation.installationId), "u"));
    for (const receipt of [created, shown, probed, listed])
      assert.doesNotMatch(JSON.stringify(receipt), /credentialRef|keychain:|executablePath/u);
    const target = path.join(userRoot, "runtime-instances.json"),
      stateRoot = path.join(userRoot, "runtime-instances", "cli-isolated"),
      codexConfig = path.join(stateRoot, "home", ".codex", "config.toml");
    assert.equal(existsSync(target), true);
    if (process.platform !== "win32") assert.equal(statSync(target).mode & 0o777, 0o600);
    for (const directory of [stateRoot, "home", "tmp", "run"].map((entry) =>
      entry === stateRoot ? entry : path.join(stateRoot, entry),
    )) {
      assert.equal(existsSync(directory), true, directory);
      if (process.platform !== "win32") assert.equal(statSync(directory).mode & 0o777, 0o700, directory);
    }
    const persisted = readFileSync(codexConfig, "utf8");
    assert.match(persisted, /wire_api = "responses"/u);
    assert.match(persisted, /requires_openai_auth = true/u);
    assert.match(persisted, /http_headers = \{ "X-Harness-Probe" = "present" \}/u);
    assert.doesNotMatch(`${readFileSync(target, "utf8")}\n${persisted}`, /Bearer |instance-secret|OPENAI_API_KEY/u);
    // dec_DA1602487428A58E8B446ECE38 CH1 / F-5A49386A: persisted enforced
    // Codex ACP rows must not block the real `ha runtime instance list --all` path.
    run(root, env, [
      "runtime",
      "instance",
      "create",
      "--id",
      "cli-codex-acp",
      "--name",
      "Codex ACP",
      "--kind",
      "codex-acp",
      "--provider",
      "openai",
      "--model",
      "runtime-test-model",
      "--auth",
      "subscription",
      "--isolation",
      "enforced",
    ]);
    const withAcp = run(root, env, ["runtime", "instance", "list", "--all"]);
    assert.equal(withAcp.ok, true);
    assert.equal(
      (withAcp.instances as Array<Record<string, unknown>>).find((row) => row.instanceId === "cli-codex-acp")
        ?.isolationState,
      "enforced",
    );
    run(root, env, ["runtime", "instance", "delete", "cli-codex-acp"]);
    assert.equal(run(root, env, ["runtime", "instance", "delete", "cli-isolated"]).deletedInstanceId, "cli-isolated");
    assert.equal(existsSync(stateRoot), false);
    const missing = runMaybe(root, env, ["runtime", "instance", "show", "cli-isolated"]);
    assert.notEqual(missing.status, 0);
    assert.equal((missing.receipt.error as Record<string, unknown>).code, "runtime_instance_not_found");
  } finally {
    stopRuntimeInstanceDaemon(root, userRoot, "runtime-instance-test", env);
    removeTempRepository(root);
  }
});

test("real CLI runtime instance list/show/--probe displays subscription quota windows and reset timestamps end-to-end", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-instance-quota-cli-")),
    userRoot = path.join(root, "user"),
    binRoot = path.join(root, "bin"),
    resetAt = "2026-11-28T00:00:00.000Z";
  mkdirSync(binRoot, { recursive: true });
  writeProviderExecutable(
    path.join(binRoot, "agy"),
    `
      const args = process.argv.slice(2);
      if (args[0] === "--version") { console.log("agy 1.2.2"); process.exit(0); }
      if (args[0] === "models") { console.log("gemini-4-hydrogen-low\\tmodel"); process.exit(0); }
      if (args[0] === "-p" && args[1] === "/quota") {
        console.log(JSON.stringify({
          data: {
            plan: "Ultra",
            groups: [
              {
                group_id: "gemini",
                display_name: "Gemini",
                buckets: [{ bucket_id: "gemini-5h", display_name: "5h", remaining_fraction: 0.72, reset_time: ${JSON.stringify(resetAt)} }]
              }
            ]
          }
        }));
        process.exit(0);
      }
      process.exit(0);
    `,
  );
  const env = {
    ...process.env,
    HOME: path.join(root, "home"),
    PATH: [
      binRoot,
      ...(process.env.PATH ?? "")
        .split(path.delimiter)
        .filter((entry) => ["agy", "agy.cmd", "agy.exe"].every((name) => !existsSync(path.join(entry, name)))),
    ].join(path.delimiter),
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_DAEMON_ID: "runtime-instance-quota-test",
  };
  try {
    assert.equal(run(root, env, ["daemon", "start", "--service"]).ok, true);
    run(root, env, [
      "runtime",
      "instance",
      "create",
      "--id",
      "cli-agy-quota",
      "--name",
      "CLI AGY Quota",
      "--kind",
      "agy",
      "--provider",
      "google",
      "--model",
      "gemini-4-hydrogen-low",
      "--auth",
      "subscription",
    ]);
    const probed = run(root, env, ["runtime", "instance", "show", "cli-agy-quota", "--probe"]);
    assert.match(
      renderCliReceipt(probed).text,
      /quota: \[Ultra\] Gemini · 5h 72% \(resets 2026-11-28T00:00:00\.000Z\)/u,
    );

    // Cached non-probe list and show render the persisted quota column and reset window.
    const listed = run(root, env, ["runtime", "instance", "list"]);
    const renderedList = renderCliReceipt(listed).text;
    assert.match(renderedList, /\tQUOTA\n/u);
    assert.match(renderedList, /\[Ultra\] Gemini · 5h 72% \(resets 2026-11-28T00:00:00\.000Z\)/u);

    const shown = run(root, env, ["runtime", "instance", "show", "cli-agy-quota"]);
    assert.match(
      renderCliReceipt(shown).text,
      /quota: \[Ultra\] Gemini · 5h 72% \(resets 2026-11-28T00:00:00\.000Z\)/u,
    );

    // QUOTA-20: CLI health table projects still-future clocks (max of cooldownUntil & quotaExhaustedUntil)
    // and treats expired quotaExhaustedUntil as ready (never cooldown / quota_exhausted).
    const healthFile = path.join(userRoot, "runtime-provider-health.json");
    writeFileSync(
      healthFile,
      JSON.stringify({
        "cli-agy-quota": {
          instanceId: "cli-agy-quota",
          failureStreak: 0,
          cooldownUntil: null,
          frozen: false,
          frozenUntil: null,
          reason: null,
          lastFailureAt: null,
          lastResetAt: null,
          quotaExhaustedUntil: "2020-01-01T00:00:00.000Z",
          quotaObservedAt: "2020-01-01T00:00:00.000Z",
        },
      }),
      { mode: 0o600 },
    );
    const expiredList = renderCliReceipt(run(root, env, ["runtime", "instance", "list"])).text;
    assert.match(expiredList, /cli-agy-quota\tCLI AGY Quota\tagy\tgemini-4-hydrogen-low\tenabled\tready\t-\t-/u);

    writeFileSync(
      healthFile,
      JSON.stringify({
        "cli-agy-quota": {
          instanceId: "cli-agy-quota",
          failureStreak: 1,
          cooldownUntil: "2099-01-01T01:00:00.000Z",
          frozen: false,
          frozenUntil: null,
          reason: "HTTP 503",
          lastFailureAt: "2026-11-21T10:00:00.000Z",
          lastResetAt: null,
          quotaExhaustedUntil: "2099-01-01T05:00:00.000Z",
          quotaObservedAt: "2026-11-21T10:00:00.000Z",
        },
      }),
      { mode: 0o600 },
    );
    const activeBothList = renderCliReceipt(run(root, env, ["runtime", "instance", "list"])).text;
    assert.match(
      activeBothList,
      /cli-agy-quota\tCLI AGY Quota\tagy\tgemini-4-hydrogen-low\tenabled\tcooldown\tHTTP 503\t2099-01-01T05:00:00\.000Z/u,
    );
  } finally {
    stopRuntimeInstanceDaemon(root, userRoot, "runtime-instance-quota-test", env);
    removeTempRepository(root);
  }
});

function stopRuntimeInstanceDaemon(root: string, userRoot: string, daemonId: string, env: NodeJS.ProcessEnv): void {
  const pid = readDaemonPid(userRoot, daemonId);
  if (pid === null) return;
  const stopped = runMaybe(root, env, ["daemon", "stop", "--daemon-id", daemonId]);
  assert.equal(stopped.status, 0, `${stopped.stderr}\n${JSON.stringify(stopped.receipt)}`);
  waitForDaemonProcessExitSync(pid);
}

function run(root: string, env: NodeJS.ProcessEnv, args: readonly string[]): Record<string, unknown> {
  const result = runMaybe(root, env, args);
  assert.equal(result.status, 0, `${result.stderr}\n${JSON.stringify(result.receipt)}`);
  return result.receipt;
}
function runMaybe(
  root: string,
  env: NodeJS.ProcessEnv,
  args: readonly string[],
): { readonly status: number | null; readonly receipt: Record<string, unknown>; readonly stderr: string } {
  const result = spawnSync(process.execPath, [cli, "--root", root, "--json", ...args], { encoding: "utf8", env });
  return {
    status: result.status,
    receipt: result.stdout.trim() ? (JSON.parse(result.stdout) as Record<string, unknown>) : {},
    stderr: result.stderr,
  };
}

test("Repository writes commit while an exit callback is still running", { timeout: 300_000 }, async (context) => {
  const fixture = await createRuntimeFixture(context);
  installIdentities(fixture.parent, fixture.root, fixture.env);
  const { parent, root, env } = fixture;
  const { taskId, executionId } = seedTask(root, env, "notification-queue");
  runRuntimeCli(root, env, ["task", "start", taskId, "--execution-id", executionId]);
  const notificationStarted = path.join(root, ".notify-hold-started"),
    notificationRelease = path.join(root, ".notify-hold-release"),
    notificationFinished = path.join(root, ".notify-hold-finished");
  const holdNotifier = writeProviderExecutable(
    path.join(parent, "notify-hold"),
    'const fs = require("node:fs"); fs.readFileSync(0, "utf8"); ' +
      'const watcher = fs.watch(".", (_, filename) => { if (filename !== ".notify-hold-release") return; ' +
      'watcher.close(); fs.writeFileSync(".notify-hold-finished", "finished\\n"); }); ' +
      'fs.writeFileSync(".notify-hold-started", "started\\n");\n',
  );
  const queueNotification = runRuntimeCli(root, env, [
    "agent",
    "run",
    "terra",
    "--prompt",
    "notification queue hold",
    "--cwd",
    ".",
    "--task",
    taskId,
    "--detach",
    "--on-exit",
    holdNotifier,
  ]);
  const queueSettled = runRuntimeCliMaybe(root, env, [
    "runtime",
    "status",
    String(queueNotification.runtimeSessionId),
    "--wait",
    "--no-stream",
  ]);
  assert.equal(queueSettled.status, 1, "the no-delivery worker settles stopped and its wait exits 1");
  await eventuallyFile(notificationStarted);
  runRuntimeCli(root, env, ["task", "start", taskId, "--execution-id", executionId]);
  const revisionBefore = makeTaskEventReader({ repoId: "runtime-cli", rootDir: root }).readHead()?.revision ?? 0,
    queueWrite = runRuntimeCli(root, env, [
      "task",
      "progress",
      "append",
      taskId,
      "--text",
      "Notification queue remained writable.",
      "--evidence",
      "test:reports/notification-queue.txt:write progressed while callback was active",
    ]),
    revisionAfter = makeTaskEventReader({ repoId: "runtime-cli", rootDir: root }).readHead()?.revision ?? 0;
  assert.ok(revisionAfter > revisionBefore, `${revisionBefore} -> ${revisionAfter}`);
  assert.equal(
    existsSync(notificationFinished),
    false,
    "the notification must still be executing when the repo write commits",
  );
  writeFileSync(notificationRelease, "release\n");
  const queueNotificationTrace = await eventuallyNotification(root, String(queueNotification.dispatchId));
  assert.equal(queueNotificationTrace.started?.phase, "started");
  assert.equal(queueNotificationTrace.finished?.timedOut, false);
  assert.equal(existsSync(notificationFinished), true);
  context.diagnostic(
    `notification queue concurrency: ${JSON.stringify({ revisionBefore, revisionAfter, writeReceiptRevision: queueWrite.revision, notifierStillRunningAtCommit: true })}`,
  );
});
