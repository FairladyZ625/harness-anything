// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { parseThinCommand } from "../src/cli/thin-command.ts";
import { runRuntimeFacadeCommand } from "../src/cli-runtime-command.ts";
import { fleetNodeClaimFixture } from "../../daemon/test/fleet-node-claim.fixtures.ts";
import type { JsonObject } from "@harness-anything/daemon/internal/protocol/json-rpc-types";

test(
  "two node consumers race a real TLS CAS pool; loser advances then both exhaust",
  { timeout: 60_000 },
  async (t) => {
    const f = await fleetNodeClaimFixture(t);
    for (const taskId of ["task-first", "task-next"]) {
      assert.equal((await f.command("node-one", { kind: "task-create", taskId, title: taskId })).outcome, "applied");
    }
    assert.equal(
      (await f.command("node-one", { kind: "settings-update", fleetClaimScope: "startable" })).outcome,
      "applied",
    );
    const parsed = parseThinCommand(["agent", "run", "sol", "--claim-next"]);
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    if (!parsed.ok) throw new Error(parsed.nextAction);
    const bothRead = Promise.withResolvers<void>(),
      launches: { nodeId: string; taskId: string }[] = [];
    let reads = 0;
    const startResults: JsonObject[] = [];
    const consume = (nodeId: string, synchronize: boolean) =>
      runRuntimeFacadeCommand(
        parsed.command,
        () => {},
        async (command) => {
          if (command.method === "repo.tasks.claimable") {
            const pool = await f.host.read("lease-repo", "repo.tasks.claimable", {}, f.owners.auth({ nodeId }));
            if (synchronize) {
              if (++reads === 2) bothRead.resolve();
              await bothRead.promise;
            }
            return pool as unknown as JsonObject;
          }
          if (command.action.kind === "task-start") {
            const result = (await f.command(nodeId, { ...command.action })) as unknown as JsonObject;
            startResults.push(result);
            return result;
          }
          assert.equal(command.method, "repo.agentRuntime.spawn");
          const taskId = String(command.action.taskId);
          const shown = await f.host.run("lease-repo", { kind: "task-show", taskId }, f.owners.auth({ nodeId }));
          assert.equal(JSON.parse(String(shown.evidence)).lease.source.nodeId, nodeId);
          launches.push({ nodeId, taskId });
          // Provider launch is a boundary spy: lease acquisition and candidate selection above are real.
          return { ok: true, runtimeSessionId: `runtime-${nodeId}`, dispatchId: `dispatch-${nodeId}` };
        },
      );
    const results = await Promise.all([consume("node-one", true), consume("node-two", true)]);
    assert.deepEqual(
      results.map((r) => r.outcome),
      ["running", "running"],
    );
    assert.equal(startResults.filter((r) => r.outcome === "applied").length, 2);
    assert.equal(startResults.filter((r) => r.code === "lease_conflict").length, 1);
    assert.equal(new Set(launches.map((l) => l.taskId)).size, 2);
    assert.equal(launches.length, 2);
    const empty = await Promise.all([consume("node-one", false), consume("node-two", false)]);
    assert.deepEqual(
      empty.map((r) => r.outcome),
      ["empty", "empty"],
    );
    assert.equal(launches.length, 2);
    console.log(
      "claim-next evidence: 2 nodes, 2 candidates, 2 applied (1 per task), 1 lease_conflict, 2 launches, 2 empty exits",
    );
  },
);

test(
  "real CLI socket entry reads candidates, starts through TLS, and reaches runtime spawn",
  { timeout: 60_000 },
  async (t) => {
    const { spawn } = await import("node:child_process"),
      path = await import("node:path"),
      { createJsonRpcProtocolServer } = await import("@harness-anything/daemon"),
      { createUnixSocketTransportServer } = await import("@harness-anything/daemon"),
      { localUserDaemonEndpoint } = await import("@harness-anything/daemon/internal/client/local-daemon-target");
    const f = await fleetNodeClaimFixture(t);
    assert.equal(
      (await f.command("node-one", { kind: "task-create", taskId: "task-cli", title: "CLI" })).outcome,
      "applied",
    );
    assert.equal(
      (await f.command("node-one", { kind: "settings-update", fleetClaimScope: "startable" })).outcome,
      "applied",
    );
    const { makeDaemonCommandReceipt } = await import(
      "@harness-anything/daemon/internal/protocol/daemon-protocol.contract"
    );
    let launched = 0,
      startReceipt: JsonObject;
    const userRoot = path.join(f.root, "user"),
      socketPath = localUserDaemonEndpoint(userRoot, "claim-cli");
    const transport = createUnixSocketTransportServer({
      daemonId: "claim-cli",
      socketPath,
      createProtocolServer: (_auth, emit) =>
        createJsonRpcProtocolServer({
          host: {
            ...f.host,
            run: async (_repo, action) => {
              assert.equal(action.kind, "task-start");
              const result = await f.command("node-one", action);
              startReceipt = makeDaemonCommandReceipt("runtime-spawn", result.receipt!);
              return result as never;
            },
            spawnRuntime: async (_repo, payload) => {
              assert.equal(payload.taskId, "task-cli");
              assert.equal(payload.agentId, "sol");
              assert.equal(payload.claimNext, undefined);
              const shown = await f.host.run(
                "lease-repo",
                { kind: "task-show", taskId: "task-cli" },
                f.owners.auth({ nodeId: "node-one" }),
              );
              assert.equal(JSON.parse(String(shown.evidence)).lease.source.nodeId, "node-one");
              launched++;
              const fields = [
                "schema",
                "ok",
                "command",
                "outcome",
                "opId",
                "revision",
                "evidence",
                "visibility",
                "proof",
                "cut",
                "commitSha",
                "status",
                "acceptance",
                "projection",
                "git",
                "worktree",
                "replica",
                "authorizationDecision",
              ];
              return {
                ...Object.fromEntries(fields.map((key) => [key, startReceipt[key]])),
                runtimeSessionId: "runtime-cli",
                dispatchId: "dispatch-cli",
              } as JsonObject;
            },
          },
          build: { commit: null },
          authContext: f.owners.auth({ nodeId: "node-one" }),
          emit,
        }),
    });
    await transport.start();
    t.after(() => transport.stop());
    const invoke = async () => {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("HARNESS_")));
      const child = spawn(
        process.execPath,
        [path.resolve("packages/cli/src/index.ts"), "--root", f.repo, "--json", "agent", "run", "sol", "--claim-next"],
        {
          env: {
            ...env,
            HARNESS_DAEMON_USER_ROOT: userRoot,
            HARNESS_DAEMON_ID: "claim-cli",
            HARNESS_DAEMON_ENDPOINT: socketPath,
            HARNESS_DAEMON_REPO_ID: "lease-repo",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      t.after(() => child.kill());
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      assert.equal(code, 0, stderr + stdout);
      return JSON.parse(stdout);
    };
    assert.equal((await invoke()).outcome, "running");
    assert.equal((await invoke()).outcome, "empty");
    assert.equal(launched, 1);
  },
);
