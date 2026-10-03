// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { existsSync, globSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader, runtimeSessionOutcomeFromEvidence } from "@harness-anything/kernel";
import { localUserDaemonEndpoint } from "../src/client/local-daemon-target.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { createUnixSocketTransportServer } from "../src/transport/unix-socket.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import { listenFleetTls } from "../src/fleet/center.ts";
import { runFleetReplicaPullClient } from "../src/fleet/edge.ts";
import { applyFleetMirrorCut } from "../src/fleet-edge-mirror.ts";
import { runtimePidIsAlive } from "../src/runtime-process-liveness.ts";
import { readDispatchStream } from "../src/dispatch-stream.ts";
import { fleetFixture, git, initRepo, localAuthFixture } from "./fleet-runtime-recovery.fixtures.ts";
import { waitForFleetPublication } from "./fleet-store.fixture.ts";
import { registerBootstrappedDaemonRepo } from "./repo-settings.fixture.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";
// Explicit live acceptance uses the installed macOS Codex and each node's own auth link.
// CI leaves this unset and runs the deterministic provider subprocess.
const liveCodex = process.env.HARNESS_HANDOFF_LIVE_CODEX;
async function eventually(check: () => boolean | Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + (liveCodex ? 120_000 : 20_000);
  do {
    if (await check()) return true;
    await delay(25);
  } while (Date.now() < deadline);
  return false;
}
import type { JsonObject } from "../src/protocol/json-rpc-types.ts";

// The provider subprocess is deterministic; TLS, node identity, private transfer, task worktrees,
// both daemon hosts, worker-host process records and the actual resume adapter are real.
test(
  "node handoff facade exports a settled process and launches the same native session at the exact SHA",
  { timeout: liveCodex ? 360_000 : 120_000 },
  async (t) => {
    const f = await fleetFixture(
        t,
        ["tasks/task-fleet-fleet", "agents"],
        [
          {
            installationId: "handoff-codex",
            kindId: "codex",
            executablePath: "/usr/bin/true",
            version: "codex-cli 0.159.1",
            observedAt: new Date().toISOString(),
          },
        ],
      ),
      { repoId, taskId } = f.subject,
      fixtureNativeId = "019abcdef-1234-5678-9999-abcdef123456",
      phrase = `private-handoff-tool-result-${randomUUID()}`,
      executablePath =
        liveCodex ??
        writeProviderExecutable(
          path.join(f.root, "codex.mjs"),
          `
import { mkdirSync, writeFileSync, readFileSync, globSync } from 'node:fs';
import path from 'node:path';
const id = ${JSON.stringify(fixtureNativeId)}, home = process.env.CODEX_HOME;
if (process.argv.includes('--version')) { console.log('codex-cli 0.159.1'); process.exit(0); }
if (process.argv.includes('login')) { console.log('Logged in using ChatGPT'); process.exit(0); }
for await (const chunk of process.stdin) { /* drain the real prompt */ }
const sessions = path.join(home, 'sessions'), resumed = process.argv.includes('resume');
let message = 'source settled';
if (resumed) {
  if (!process.argv.includes(id)) throw new Error('native identity changed');
  const matches = globSync('**/rollout-*-' + id + '.jsonl', { cwd: sessions });
  if (matches.length !== 1) throw new Error('native rollout unavailable');
  const native = readFileSync(path.join(sessions, matches[0]), 'utf8');
  if (!native.includes(${JSON.stringify(phrase)})) throw new Error('conversation missing');
  message = ${JSON.stringify(phrase)};
} else {
  const directory = path.join(sessions, '2026', '10', '04'); mkdirSync(directory, {recursive:true});
  const records = [
    {type:'session_meta',payload:{id,cli_version:'0.159.1',timestamp:'2026-10-04T00:00:00.000Z'}},
    {type:'response_item',payload:{type:'function_call_output',output:${JSON.stringify(phrase)}}},
    {type:'compacted',payload:{message:${JSON.stringify(phrase)}}}
  ];
  writeFileSync(path.join(directory,'rollout-2026-10-04T00-00-00-' + id + '.jsonl'), records.map(JSON.stringify).join('\\n')+'\\n');
}
for (const row of [{type:'thread.started',thread_id:id},
 {type:'item.completed',item:{id:'answer',type:'agent_message',text:message}},
 {type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}]) console.log(JSON.stringify(row));
`,
        ),
      installation = {
        installationId: "handoff-codex",
        kindId: "codex",
        executablePath,
        version: liveCodex ? execFileSync(liveCodex, ["--version"], { encoding: "utf8" }).trim() : "codex-cli 0.159.1",
        observedAt: new Date().toISOString(),
      },
      instance = {
        instanceId: "handoff-codex",
        name: "Handoff Codex",
        kindId: "codex",
        installationId: installation.installationId,
        providerId: "openai",
        models: [liveCodex ? "gpt-6.1-sol" : "gpt-5.6-sol"],
        authMode: "subscription",
        codex: { reasoningEffort: "high" },
      },
      localAuth = localAuthFixture();
    await f.host.runtimeInstance("daemon.runtimeInstance.create", instance, localAuth);
    const packageSource = path.join(f.root, "handoff-agent");
    mkdirSync(packageSource);
    writeFileSync(
      path.join(packageSource, "agent.json"),
      JSON.stringify({
        schema: "agent-declaration/v1",
        id: "handoff-worker",
        name: "Handoff Worker",
        instructions: "Continue the same task.",
        runtimes: [{ type: "codex" }],
        role: "worker",
      }),
    );
    // Agent declarations do not bind credentials or an installation; both nodes resolve their own instance.
    const installed = await f.host.run(
      repoId,
      { kind: "agent-install", packageSource, expectedVersion: 0, idempotencyKey: "handoff-agent" },
      localAuth,
    );
    assert.equal(installed.outcome, "applied", JSON.stringify(installed));
    await waitForFleetPublication(f.host, repoId, installed.opId, localAuth);
    const center = await f.hold(
        listenFleetTls({
          host: f.host,
          ...f.writerOptions,
          stateRoot: f.stateRoot,
          key: f.key,
          cert: f.cert,
          replicaDiskQuotaBytes: 64 * 1024 * 1024,
          authenticate: (_node, credential) => credential === "machine-secret",
          nodeOwner: f.owners.nodeOwner,
        }),
      ),
      remote = path.join(f.root, "code.git");
    git(f.root, "init", "--bare", "-q", "--initial-branch=main", remote);
    const sourceRoot = path.join(f.root, "source");
    mkdirSync(path.join(sourceRoot, "harness"), { recursive: true });
    initRepo(sourceRoot);
    git(sourceRoot, "branch", "-M", "main");
    writeFileSync(
      path.join(sourceRoot, "harness/harness.yaml"),
      "schema: harness-anything/v1\nname: handoff\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
    );
    writeFileSync(path.join(sourceRoot, "token.txt"), `${phrase}\n`);
    git(sourceRoot, "add", "harness", "token.txt");
    git(sourceRoot, "commit", "-qm", "test: code baseline");
    git(sourceRoot, "remote", "add", "origin", remote);
    git(sourceRoot, "push", "-qu", "origin", "main");
    const targetRoot = path.join(f.root, "target");
    git(f.root, "clone", "-q", remote, targetRoot);
    git(targetRoot, "config", "user.name", "Handoff Test");
    git(targetRoot, "config", "user.email", "handoff@example.invalid");
    async function node(nodeId: string, rootDir: string) {
      const userRoot = path.join(f.root, `${nodeId}-user`),
        viewRoot = path.join(f.root, `${nodeId}-view`);
      await runFleetReplicaPullClient({
        port: center.port,
        ca: f.cert,
        nodeId,
        credential: "machine-secret",
        repoId,
        viewRoot,
        diskQuotaBytes: 64 * 1024 * 1024,
      });
      applyFleetMirrorCut(viewRoot, repoId, rootDir, "pull");
      registerBootstrappedDaemonRepo({
        canonicalRoot: rootDir,
        repoId,
        mode: "remote-edge",
        userRoot,
        createConvenienceLinks: false,
      });
      const host = await openDaemonHost({ daemonId: nodeId, userRoot, runtimeDiscover: () => [installation] });
      t.after(() => host.close());
      await host.attachmentsSettled();
      await host.runtimeInstance("daemon.runtimeInstance.create", instance, localAuth);
      const request = {
        host: "127.0.0.1",
        port: center.port,
        caPath: f.certFile,
        nodeId,
        credential: "machine-secret",
        repoId,
        viewRoot,
        quotaBytes: 64 * 1024 * 1024,
        workspaceRoot: rootDir,
      };
      writeFileSync(
        path.join(rootDir, "fleet-edge.json"),
        JSON.stringify({ schema: "fleet-edge-config/v1", ...request }),
      );
      const transport = createUnixSocketTransportServer({
        daemonId: nodeId,
        socketPath: localUserDaemonEndpoint(userRoot, nodeId),
        createProtocolServer: (authContext, emit, _connectionId, connectionSignal) =>
          createJsonRpcProtocolServer({
            host,
            build: { commit: null },
            authContext: { ...authContext, connectionSignal },
            emit,
          }),
      });
      await transport.start();
      t.after(() => transport.stop());
      const cli = async (args: string[]) => {
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("HARNESS_")));
        const child = spawn(
          process.execPath,
          [path.resolve("packages/cli/src/index.ts"), "--root", rootDir, "--json", ...args],
          {
            env: { ...env, HARNESS_DAEMON_USER_ROOT: userRoot, HARNESS_DAEMON_ID: nodeId },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        f.track(() => child.kill());
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
        assert.equal(code, 0, JSON.stringify({ args, stdout, stderr }));
        return JSON.parse(stdout);
      };
      return {
        cli,
        userRoot,
        rootDir,
        host,
        run: (method: "repo.agentRuntime.spawn" | "repo.agentRuntime.handoff", action: JsonObject) =>
          host.fleet.edgeRuntime({ ...request, method, action }, localAuth),
      };
    }
    const source = await node("node-one", sourceRoot),
      target = await node("node-two", targetRoot);
    const first = await source.run("repo.agentRuntime.spawn", {
      agentId: "handoff-worker",
      runtimeInstanceId: instance.instanceId,
      taskId,
      handoffEnabled: true,
      prompt: liveCodex
        ? "This is a disposable handoff acceptance session. Read token.txt using your shell tool and remember its exact contents. Do not modify files, use ha, submit the task, or do other work. Respond only SOURCE_READY without repeating the token."
        : "Remember the private tool result.",
      idempotencyKey: "handoff-product-source",
    });
    assert.equal(first.outcome, "applied", JSON.stringify(first));
    const dispatchId = String(first.dispatchId),
      sourceWorktree = path.join(sourceRoot, ".worktrees", taskId);
    assert.equal(
      await eventually(async () => {
        const stream = readDispatchStream(sourceRoot, dispatchId);
        return Boolean(stream?.terminalOutcome && stream.process?.exited && !runtimePidIsAlive(stream.process.pid));
      }),
      true,
    );
    const nativeId = readDispatchStream(sourceRoot, dispatchId)?.providerSessionId;
    assert.ok(nativeId);
    if (!liveCodex) assert.equal(nativeId, fixtureNativeId);
    assert.equal(
      runtimeSessionOutcomeFromEvidence(readDispatchStream(sourceRoot, dispatchId)!.terminalOutcome!.payload),
      "succeeded",
      JSON.stringify(readDispatchStream(sourceRoot, dispatchId)?.terminalOutcome),
    );
    assert.equal(
      await eventually(async () =>
        makeTaskEventReader({ rootDir: f.repo, repoId })
          .read()
          .events.some(
            (event) =>
              event.type === "runtime_session_outcome_observed" &&
              event.payload.runtimeSessionId === first.runtimeSessionId,
          ),
      ),
      true,
    );
    if (liveCodex) {
      const sessions = path.join(source.userRoot, "runtime-instances", instance.instanceId, "home/.codex/sessions");
      const files = globSync(`**/rollout-*-${nativeId}.jsonl`, { cwd: sessions });
      const rows = readFileSync(path.join(sessions, files[0]!), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      t.diagnostic(
        JSON.stringify({
          nativeSchema: [...new Set(rows.map((row) => row.type))],
          tools: rows
            .filter((row) => row.payload?.name)
            .map((row) => ({ type: row.payload.type, name: row.payload.name })),
          worldStateFields: rows
            .filter((row) => row.type === "world_state")
            .map((row) => Object.keys(row.payload?.state ?? {})),
          unknownRecords: rows
            .filter(
              (row) => !["session_meta", "response_item", "event_msg", "turn_context", "compacted"].includes(row.type),
            )
            .map((row) => ({
              type: row.type,
              fields: Object.keys(row),
              payloadFields: Object.keys(row.payload ?? {}),
            })),
        }),
      );
    }
    const commit = git(sourceWorktree, "rev-parse", "HEAD");
    // The fixture publishes only to its temporary bare Git remote, as a completed source delivery would.
    git(sourceWorktree, "push", "-q", "origin", `HEAD:refs/heads/${taskId}`);
    writeFileSync(path.join(sourceWorktree, "dirty.txt"), "uncommitted");
    await assert.rejects(source.run("repo.agentRuntime.handoff", { operation: "export", dispatchId }), {
      code: "runtime_handoff_dirty",
    });
    rmSync(path.join(sourceWorktree, "dirty.txt"));
    const exported = await source.cli(["runtime", "handoff", "export", dispatchId]);
    assert.equal(
      exported.outcome,
      "applied",
      JSON.stringify({
        exported,
        runtime: await f.host.read(
          repoId,
          "repo.agentRuntime.sessions.read",
          { runtimeSessionId: first.runtimeSessionId },
          f.auth,
        ),
        dispatch: makeTaskEventReader({ rootDir: f.repo, repoId })
          .read()
          .events.find((event) => event.type === "runtime_dispatch_requested"),
      }),
    );
    assert.equal((exported.checkpoint as JsonObject).commit, commit);
    const started = await f.host.run(
      repoId,
      { kind: "task-start", taskId },
      f.owners.auth({ ...f.subject, nodeId: "node-two", viewId: "node-two" }),
    );
    assert.equal(started.outcome, "applied", JSON.stringify(started));
    const claim = {
      operation: "claim",
      dispatchId,
      runtimeInstanceId: instance.instanceId,
      prompt: liveCodex
        ? "Without using tools or opening any files, what was the exact content read from token.txt earlier? Reply only with that content. If unavailable say UNKNOWN. Do no other work."
        : "Recall the tool result.",
      idempotencyKey: "handoff-product-target",
    };
    const resumed = await target.cli([
      "runtime",
      "handoff",
      "claim",
      dispatchId,
      "--instance",
      instance.instanceId,
      "--prompt",
      claim.prompt,
      "--idempotency-key",
      claim.idempotencyKey,
    ]);
    assert.equal(resumed.outcome, "applied", JSON.stringify(resumed));
    const targetDispatch = String(resumed.dispatchId),
      targetWorktree = path.join(targetRoot, ".worktrees", taskId);
    assert.equal(git(targetWorktree, "rev-parse", "HEAD"), commit);
    assert.equal(
      await eventually(async () => Boolean(readDispatchStream(targetRoot, targetDispatch)?.terminalOutcome)),
      true,
    );
    assert.equal(readDispatchStream(targetRoot, targetDispatch)?.providerSessionId, nativeId);
    assert.ok(
      readDispatchStream(targetRoot, targetDispatch)?.terminalOutcome?.body.includes(phrase),
      JSON.stringify(readDispatchStream(targetRoot, targetDispatch)?.terminalOutcome),
    );
    assert.equal(readDispatchStream(targetRoot, targetDispatch)?.header.cwd, targetWorktree);
    const nativeFiles = globSync(`**/rollout-*-${nativeId}.jsonl`, {
      cwd: path.join(target.userRoot, "runtime-instances", instance.instanceId, "home/.codex/sessions"),
    });
    assert.equal(nativeFiles.length, 1);
    assert.match(
      path.basename(nativeFiles[0]!),
      /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[a-zA-Z0-9_-]+\.jsonl$/u,
    );
    if (liveCodex) {
      const native = readFileSync(
        path.join(target.userRoot, "runtime-instances", instance.instanceId, "home/.codex/sessions", nativeFiles[0]!),
      );
      const exportedBytes = Number(((exported.checkpoint as JsonObject).blob as JsonObject).size);
      const resumedRows = native
        .subarray(exportedBytes)
        .toString("utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      assert.equal(
        resumedRows.filter((row) => ["function_call", "custom_tool_call"].includes(row.payload?.type)).length,
        0,
        "target recalled context without tools",
      );
    }
    assert.equal(
      existsSync(path.join(target.userRoot, "runtime-instances", instance.instanceId, "home/.codex/auth.json")),
      Boolean(liveCodex),
    );
    if (liveCodex)
      assert.equal(
        lstatSync(
          path.join(target.userRoot, "runtime-instances", instance.instanceId, "home/.codex/auth.json"),
        ).isSymbolicLink(),
        true,
      );
    assert.equal(
      await eventually(async () =>
        makeTaskEventReader({ rootDir: f.repo, repoId })
          .read()
          .events.some(
            (event) =>
              event.type === "runtime_session_outcome_observed" &&
              event.payload.runtimeSessionId === resumed.runtimeSessionId,
          ),
      ),
      true,
    );
    const replay = await target.run("repo.agentRuntime.handoff", claim);
    assert.equal(replay.dispatchId, resumed.dispatchId, JSON.stringify(replay));
    assert.equal(replay.replayed, true);
    assert.equal(replay.handoffResumed, true);
    const repeated = await target.run("repo.agentRuntime.handoff", { ...claim, idempotencyKey: "another-target" });
    assert.equal(repeated.code, "runtime_dispatch_already_resumed", JSON.stringify(repeated));
    if (liveCodex) {
      const negative = await target.run("repo.agentRuntime.spawn", {
        runtimeInstanceId: instance.instanceId,
        prompt:
          "Without using tools or opening any files, what was the exact content read from token.txt earlier? Reply only with that content. If unavailable say UNKNOWN. Do no other work.",
        idempotencyKey: "handoff-empty-negative",
        cwd: { scope: "repo-root" },
      });
      assert.equal(negative.outcome, "applied", JSON.stringify(negative));
      assert.equal(
        await eventually(async () =>
          Boolean(readDispatchStream(targetRoot, String(negative.dispatchId))?.terminalOutcome),
        ),
        true,
      );
      const negativeStream = readDispatchStream(targetRoot, String(negative.dispatchId))!;
      assert.notEqual(negativeStream.providerSessionId, nativeId);
      assert.match(negativeStream.terminalOutcome!.body, /UNKNOWN/u);
      assert.equal(negativeStream.terminalOutcome!.body.includes(phrase), false);
      assert.equal(
        await eventually(async () =>
          makeTaskEventReader({ rootDir: f.repo, repoId })
            .read()
            .events.some(
              (event) =>
                event.type === "runtime_session_outcome_observed" &&
                event.payload.runtimeSessionId === negative.runtimeSessionId,
            ),
        ),
        true,
      );
      t.diagnostic(
        JSON.stringify({
          emptySession: negativeStream.providerSessionId,
          emptyAnswer: negativeStream.terminalOutcome!.body,
        }),
      );
    }
    const revoked = await source.cli(["runtime", "handoff", "revoke", dispatchId]);
    assert.equal(revoked.outcome, "applied", JSON.stringify(revoked));
    assert.equal(existsSync(path.join(f.repo, ".harness/runtime-handoffs", dispatchId, "rollout.jsonl")), false);
    assert.equal(git(sourceRoot, "rev-parse", "HEAD"), commit, "source main stays at its original commit");
    if (liveCodex)
      t.diagnostic(
        JSON.stringify({
          provider: "real Codex",
          version: installation.version,
          source: sourceRoot,
          target: targetRoot,
          nativeId,
          commit,
          phrase,
          sourceDispatch: dispatchId,
          targetDispatch,
          resumedAnswer: readDispatchStream(targetRoot, targetDispatch)?.terminalOutcome?.body,
        }),
      );
    await source.host.close();
    await target.host.close();
    assert.ok(
      readFileSync(path.join(f.repo, ".harness/runtime-handoffs", dispatchId, "checkpoint.json"), "utf8").includes(
        commit,
      ),
    );
  },
);
