// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { requestLocalDaemonJsonRpc } from "../../daemon/src/client/local-json-rpc-client.ts";
import {
  canonicalRoot,
  workspaceId,
} from "../../daemon/src/protocol/daemon-protocol.contract.ts";
import { openRepoCell } from "../../daemon/src/repo-cell.ts";
import { readDaemonPid } from "../../daemon/src/runtime.ts";
import { makeTaskEventStore } from "../../kernel/src/index.ts";

import {
  cli,
  makeCanary,
  register,
  run,
  runMaybe,
  setup,
  stop,
  waitForRun,
} from "./daemon-multi-repo-lifecycle-cli.fixtures.ts";
test("real CLI dogfoods a user-layer v3 preset through daemon phases and RepoCell produce", () => {
  const fixture = setup(),
    source = makeCanary(fixture.root);
  try {
    assert.equal(
      run(fixture.alpha, fixture.userRoot, ["daemon", "start", "--service"]).ok,
      true,
    );
    register(fixture.alpha, fixture.userRoot, "alpha");
    const installed = run(fixture.alpha, fixture.userRoot, [
      "preset",
      "install",
      "--source",
      source,
    ]);
    assert.equal(installed.outcome, "pending");
    assert.equal(
      (installed.proof as Record<string, unknown>).canonicalVisible,
      false,
    );
    const result = spawnSync(
      process.execPath,
      [
        cli,
        "--root",
        fixture.alpha,
        "script",
        "run",
        "preset:user-canary/create",
        "--idempotency-key",
        "dogfood",
        "--inputs",
        '{"title":"Daemon canary"}',
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: path.join(fixture.alpha, ".home"),
          GIT_CONFIG_GLOBAL: "/dev/null",
          HARNESS_DAEMON_USER_ROOT: fixture.userRoot,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const output = result.stdout.trim().split("\n");
    for (const phase of [
      "admitted",
      "spawned",
      "running",
      "publishing",
      "applied",
    ])
      assert.equal(
        output.some((line) => line.includes(`preset-run-start: ${phase}`)),
        true,
        `${phase}: ${result.stdout}`,
      );
    assert.match(
      String(
        run(fixture.alpha, fixture.userRoot, ["task", "show", "task-canary"])
          .evidence,
      ),
      /Daemon canary/u,
    );
    const childEvent = makeTaskEventStore({
      rootDir: fixture.alpha,
      repoId: "alpha",
    })
      .read()
      .events.find(
        (event) =>
          event.schema === "task-bootstrap-event/v1" &&
          event.taskId === "task-canary",
      );
    assert.ok(childEvent);
    const producedReceipt = run(fixture.alpha, fixture.userRoot, [
        "receipt",
        "show",
        childEvent.opId,
      ]),
      directReceipt = run(fixture.alpha, fixture.userRoot, [
        "task",
        "create",
        "--id",
        "task-direct",
        "--admin",
        "--title",
        "Direct",
      ]),
      producedProof = producedReceipt.proof as Record<string, unknown>,
      directProof = directReceipt.proof as Record<string, unknown>;
    assert.deepEqual(
      {
        outcome: producedReceipt.outcome,
        visibility: producedReceipt.visibility,
        proofFields: Object.keys(producedProof).sort(),
        durable: producedProof.durable,
        canonicalVisible: producedProof.canonicalVisible,
      },
      {
        outcome: directReceipt.outcome,
        visibility: directReceipt.visibility,
        proofFields: Object.keys(directProof).sort(),
        durable: directProof.durable,
        canonicalVisible: directProof.canonicalVisible,
      },
    );
    assert.equal(directReceipt.commitSha, null);
    assert.ok(directReceipt.cut);
    stop(fixture.alpha, fixture.userRoot);
    const materialized = makeTaskEventStore({
      rootDir: fixture.alpha,
      repoId: "alpha",
    }).read();
    assert.equal(materialized.revision, 2);
    assert.equal(
      materialized.events.some((event) => event.opId === childEvent.opId),
      true,
    );
    assert.equal(
      materialized.events.some((event) => event.opId === directReceipt.opId),
      true,
    );
  } finally {
    stop(fixture.alpha, fixture.userRoot);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("hard daemon crash projects an admitted child to outcome_unknown without respawn", async () => {
  const fixture = setup(),
    source = makeCanary(
      fixture.root,
      "setTimeout(() => process.exit(0), 2_000);",
      [],
    );
  try {
    run(fixture.alpha, fixture.userRoot, ["daemon", "start", "--service"]);
    register(fixture.alpha, fixture.userRoot, "alpha");
    run(fixture.alpha, fixture.userRoot, [
      "preset",
      "install",
      "--source",
      source,
    ]);
    const params = {
        repo: { repoId: "alpha" },
        payload: {
          presetId: "user-canary",
          entrypoint: "create",
          inputs: { title: "Crash" },
          idempotencyKey: "crash-once",
        },
      },
      started = await requestLocalDaemonJsonRpc(
        fixture.alpha,
        "repo.preset.run.start",
        params,
        1_000,
        { userRoot: fixture.userRoot },
      );
    assert.equal(started.phase, "admitted");
    await waitForRun(
      fixture.alpha,
      fixture.userRoot,
      String(started.runId),
      "running",
    );
    const pid = readDaemonPid(fixture.userRoot, "default");
    assert.ok(pid);
    process.kill(pid, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 50));
    run(fixture.alpha, fixture.userRoot, ["daemon", "start", "--service"]);
    const unknown = await requestLocalDaemonJsonRpc(
      fixture.alpha,
      "repo.preset.run.status",
      { repo: { repoId: "alpha" }, payload: { runId: started.runId } },
      1_000,
      { userRoot: fixture.userRoot },
    );
    assert.equal(unknown.outcome, "outcome_unknown", JSON.stringify(unknown));
    assert.equal(
      (unknown.phases as string[]).filter((phase) => phase === "spawned")
        .length,
      1,
    );
  } finally {
    stop(fixture.alpha, fixture.userRoot);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("one RepoCell lock failure closes only that repo admission", async () => {
  const fixture = setup();
  let held: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    held = await openRepoCell({
      repoId: workspaceId("held-alpha"),
      rootDir: canonicalRoot(fixture.alpha),
      ownerId: "external-writer",
    });
    run(fixture.beta, fixture.userRoot, ["daemon", "start", "--service"]);
    register(fixture.alpha, fixture.userRoot, "alpha");
    register(fixture.beta, fixture.userRoot, "beta");
    const status = run(fixture.beta, fixture.userRoot, ["daemon", "status"]);
    const repos = status.repos as Array<{ repoId: string; state: string }>;
    assert.deepEqual(
      repos.map(({ repoId, state }) => [repoId, state]),
      [
        ["alpha", "unavailable"],
        ["beta", "attached"],
      ],
    );
    const blocked = runMaybe(fixture.alpha, fixture.userRoot, [
      "task",
      "create",
      "--id",
      "task-blocked",
      "--admin",
      "--title",
      "Blocked",
    ]);
    assert.notEqual(blocked.status, 0);
    assert.equal(
      (blocked.receipt.error as { code?: string }).code,
      "repo_unavailable",
    );
    assert.equal(
      run(fixture.beta, fixture.userRoot, [
        "task",
        "create",
        "--id",
        "task-live",
        "--admin",
        "--title",
        "Live",
      ]).outcome,
      "applied",
    );
  } finally {
    stop(fixture.beta, fixture.userRoot);
    await held?.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("one invalid registry entry stays visible and removable without blocking healthy repos", async () => {
  const fixture = setup();
  try {
    run(fixture.beta, fixture.userRoot, ["daemon", "start", "--service"]);
    register(fixture.alpha, fixture.userRoot, "alpha");
    register(fixture.beta, fixture.userRoot, "beta");
    run(fixture.beta, fixture.userRoot, ["daemon", "stop"]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const registryPath = path.join(fixture.userRoot, "registry.json"),
      registry = JSON.parse(readFileSync(registryPath, "utf8")) as {
        repos: Array<Record<string, unknown>>;
      },
      bad = registry.repos.find((repo) => repo.repoId === "alpha");
    assert.ok(bad);
    delete bad.authoredBranch;
    writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
    assert.equal(
      run(fixture.beta, fixture.userRoot, ["daemon", "start", "--service"]).ok,
      true,
    );
    const status = run(fixture.beta, fixture.userRoot, ["daemon", "status"]),
      rows = status.repos as Array<{
        repoId: string;
        state: string;
        lastError: string | null;
      }>,
      invalid = rows.find((repo) => repo.repoId === "alpha");
    assert.equal(invalid?.state, "unavailable");
    assert.match(invalid?.lastError ?? "", /authoredBranch/u);
    assert.equal(
      rows.find((repo) => repo.repoId === "beta")?.state,
      "attached",
    );
    assert.equal(
      run(fixture.beta, fixture.userRoot, ["task", "list"]).outcome,
      "applied",
    );
    const system = await requestLocalDaemonJsonRpc(
        fixture.beta,
        "daemon.gui.system.read",
        {},
        1_000,
        { userRoot: fixture.userRoot },
      ),
      guiInvalid = (
        system.repos as Array<{
          repoId: string;
          cellState: string;
          unavailableReason: string | null;
        }>
      ).find((repo) => repo.repoId === "alpha");
    assert.equal(guiInvalid?.cellState, "unavailable");
    assert.match(guiInvalid?.unavailableReason ?? "", /authoredBranch/u);
    const unregistered = run(fixture.beta, fixture.userRoot, [
      "daemon",
      "repo",
      "unregister",
      "--repo-id",
      "alpha",
    ]);
    assert.equal(unregistered.ok, true);
    assert.equal((unregistered.repo as { state: string }).state, "disabled");
    const persisted = JSON.parse(readFileSync(registryPath, "utf8")) as {
        repos: Array<Record<string, unknown>>;
      },
      disabled = persisted.repos.find((repo) => repo.repoId === "alpha");
    assert.equal(disabled?.state, "disabled");
    assert.equal(Object.hasOwn(disabled ?? {}, "authoredBranch"), false);
  } finally {
    stop(fixture.beta, fixture.userRoot);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
