// harness-test-tier: integration
import { waitForArrival, watchDirectoryArrival } from "../../../tools/fixtures/event-arrival.ts";
import { seedBuiltinSchedules } from "../src/daemon-host/schedule-builtin-executor.ts";
import { signInPolicyTestUser, withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader, makeTaskProjection } from "@harness-anything/storage";
import { localUserDaemonEndpoint } from "../src/daemon-host/client/local-daemon-target.ts";
import { openDaemonHost } from "../src/daemon-host/daemon-host.ts";
import { readDispatchStream } from "../src/daemon-host/dispatch-stream.ts";
import { createJsonRpcProtocolServer } from "../src/daemon-host/protocol/json-rpc-server.ts";
import { createUnixSocketTransportServer } from "../src/daemon-host/transport/unix-socket.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";
import { registerBootstrappedDaemonRepo as registerDaemonRepo } from "./repo-settings.fixture.ts";
import { definition, initIngressRepo, installation, rpc } from "./fixtures/runtime-ingress.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

test(
  "post-tool transient fault retries same-session resume up to 2 times without repeating tools and never cold-replays",
  { timeout: 120_000 },
  async (t) => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-same-session-fault-")),
      root = path.join(parent, "repo"),
      userRoot = path.join(parent, "user"),
      executablePath = writeProviderExecutable(path.join(parent, "codex-stub.mjs"), "process.exit(0);\n"),
      claudeExecutable = writeProviderExecutable(path.join(parent, "claude-stub.mjs"), "process.exit(0);\n"),
      repoId = "same-session-fault-repo",
      uid = process.getuid?.() ?? 0;
    initIngressRepo(root, uid);
    writeFileSync(
      path.join(root, "harness/harness.yaml"),
      "schema: harness-anything/v1\nname: runtime-same-session-fault-resume\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n" +
        "settings:\n  runtime:\n    allowedInstances:\n      - codex-review\n      - codex-provider\n      - codex-resume\n      - codex-cancel\n      - codex-fast-provider\n      - claude-provider\n",
    );
    execFileSync("git", ["add", "harness/harness.yaml"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "order codex candidates ahead of claude fallback"], { cwd: root });
    signInPolicyTestUser(userRoot, "owner", [repoId], "admin");
    registerDaemonRepo({
      canonicalRoot: root,
      repoId,
      userRoot,
      createConvenienceLinks: false,
    });
    const originalPath = process.env.PATH;
    writeProviderExecutable(
      path.join(parent, "gh"),
      'if (process.argv[2] === "api") console.log(JSON.stringify({workflow_runs: []})); else if (process.argv[2] === "run" && process.argv[3] === "list") console.log("[]"); else process.exit(1);\n',
    );
    process.env.PATH = `${parent}${path.delimiter}${originalPath ?? ""}`;
    t.after(() => {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    });
    const auth = {
      transportKind: "unix-socket",
      unixSocketOwnerBoundary: {
        ownerUid: uid,
        source: "unix-socket-filesystem-owner-boundary",
      },
    } as const;
    const codexInstances = [
        "codex-review",
        "codex-provider",
        "codex-resume",
        "codex-cancel",
        "codex-fast-provider",
      ] as const,
      codexInstallations = codexInstances.map((instanceId) => ({
        ...installation,
        installationId: `installation-${instanceId}`,
        executablePath,
      })),
      claudeInstallation = {
        ...installation,
        installationId: "installation-claude",
        kindId: "claude" as const,
        executablePath: claudeExecutable,
        version: "2.1.305 (Claude Code)",
      };

    interface RecordedLaunch {
      readonly instanceId: string;
      readonly args: readonly string[];
      readonly prompt: string;
      readonly launchedAt: number;
    }
    let currentHandler: (
      request: { definition: { instanceId: string; kindId: string }; args: readonly string[]; prompt: string },
      emit: (line: unknown) => void,
      exit: (code: number | null) => void,
    ) => void = () => undefined;
    const launches: RecordedLaunch[] = [];

    const host = await openDaemonHost({
      daemonId: "same-session-fault-daemon",
      userRoot,
      runtimeDiscover: () => [...codexInstallations, claudeInstallation],
      runtimeLaunch: (request) => {
        launches.push({
          instanceId: request.definition.instanceId,
          args: [...request.args],
          prompt: request.prompt,
          launchedAt: Date.now(),
        });
        const outputListeners: ((chunk: string) => void)[] = [],
          exitListeners: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
        let exited = false;
        setImmediate(() => {
          currentHandler(
            request,
            (frame) => {
              const line = `${JSON.stringify(frame)}\n`;
              for (const listener of outputListeners) listener(line);
            },
            (code) => {
              if (exited) return;
              exited = true;
              setImmediate(() => {
                for (const listener of exitListeners) listener(code, null);
              });
            },
          );
        });
        return {
          pid: 4400 + launches.length,
          onOutput: (listener) => {
            outputListeners.push(listener);
          },
          onErrorOutput: () => undefined,
          onExit: (listener) => {
            exitListeners.push(listener);
          },
          terminate: () => undefined,
        };
      },
    });
    await host.attachmentsSettled();
    const endpoint = localUserDaemonEndpoint(userRoot, "same-session-fault-daemon"),
      transport = createUnixSocketTransportServer({
        daemonId: "same-session-fault-daemon",
        socketPath: endpoint,
        createProtocolServer: (authContext, emit) =>
          createJsonRpcProtocolServer({
            host,
            build: { commit: null },
            authContext,
            emit,
          }),
      });
    await transport.start();
    try {
      await seedBuiltinSchedules({
        cell: { run: (action) => host.run(repoId, action, auth) },
        binding: withPolicyGroup(
          { actor: { principal: { personId: "owner" }, executor: null }, source: "local" as const },
          "admin",
        ),
      });
      for (const instanceId of codexInstances) {
        await host.runtimeInstance(
          "daemon.runtimeInstance.create",
          {
            instanceId,
            name: `Codex ${instanceId}`,
            kindId: "codex",
            installationId: `installation-${instanceId}`,
            providerId: definition.providerId,
            models: [`model-${instanceId}`],
            permissionMode: "workspace-write",
            isolationState: "enforced",
            codex: { reasoningEffort: definition.reasoningEffort, fast: definition.fast },
            authMode: "subscription",
          },
          auth,
        );
      }
      await host.runtimeInstance(
        "daemon.runtimeInstance.create",
        {
          instanceId: "claude-provider",
          name: "Claude Provider",
          kindId: "claude",
          installationId: claudeInstallation.installationId,
          providerId: "anthropic",
          models: ["claude-sonnet-4-6"],
          permissionMode: "workspace-write",
          isolationState: "enforced",
          authMode: "subscription",
        },
        auth,
      );

      const runChainScenario = async (
        name: string,
        primaryInstance: string,
        handler: typeof currentHandler,
        expectedOutcome: "succeeded" | "failed",
      ) => {
        launches.length = 0;
        currentHandler = handler;
        const agentId = `worker-${name}`;
        const installed = await host.run(
          repoId,
          {
            kind: "agent-install",
            declaration: {
              schema: "agent-declaration/v1",
              id: agentId,
              name: `Worker ${name}`,
              instructions: "Execute carefully.",
              role: "worker",
              runtimes: [
                { type: "codex", model: `model-${primaryInstance}` },
                { type: "claude", model: "claude-sonnet-4-6" },
              ],
            },
          },
          auth,
        );
        assert.equal(installed.outcome, "applied", JSON.stringify(installed));
        const spawned = await rpc(host, auth, "repo.agentRuntime.spawn", {
          repo: { repoId },
          payload: {
            agentId,
            taskId: null,
            cwd: { scope: "repo-root" },
            prompt: `Run scenario ${name}`,
            dispatchKey: `same-session-${name}`,
          },
        });
        assert.equal(spawned.outcome, "applied", JSON.stringify(spawned));
        const rootDispatchId = String(spawned.dispatchId);
        const projection = makeTaskProjection({
          rootDir: root,
          eventStore: makeTaskEventReader({ repoId, rootDir: root }),
        });
        let settled;
        let leaf;
        try {
          settled = await waitForArrival(async () => {
            const read = projection.readDispatchLifecycle({ by: "dispatch", dispatchIds: [rootDispatchId] });
            return read.status === "ready" && read.rows[0]?.policy.groupSettled ? read.rows[0] : null;
          }, watchDirectoryArrival(root));
          const leafRead = projection.readDispatchLifecycle({
            by: "dispatch",
            dispatchIds: [settled.controlLeafDispatchId],
          });
          assert.equal(leafRead.status, "ready");
          leaf = leafRead.rows[0]!;
        } finally {
          projection.close();
        }
        assert.equal(leaf.attempt.outcome, expectedOutcome, JSON.stringify(leaf));
        const terminalEvent = makeTaskEventReader({ repoId, rootDir: root })
          .read()
          .events.find(
            (event) =>
              event.type === "runtime_session_outcome_observed" &&
              event.payload.runtimeSessionId === leaf.attempt.runtimeSessionId,
          );
        assert.ok(terminalEvent, "missing terminal runtime_session_outcome_observed event");
        if (terminalEvent.type !== "runtime_session_outcome_observed") throw new Error("unreachable");
        assert.equal(terminalEvent.payload.outcome, expectedOutcome, JSON.stringify(terminalEvent.payload));
        return { spawned, terminalEvent, settled, leaf };
      };

      await t.test("positive: post-tool 503 resumes same session via exec resume without repeating tools", async () => {
        let attempt = 0;
        let toolExecutions = 0;
        let firstFailureAt = 0;
        await runChainScenario(
          "pos",
          "codex-review",
          (_req, emit, exit) => {
            attempt += 1;
            if (attempt === 1) {
              emit({ type: "thread.started", thread_id: "codex-thread-pos" });
              toolExecutions += 1;
              emit({
                type: "item.completed",
                item: {
                  id: "cmd_1",
                  type: "command_execution",
                  command: "echo tool-once",
                  aggregated_output: "ok",
                  exit_code: 0,
                  status: "completed",
                },
              });
              firstFailureAt = Date.now();
              emit({ type: "turn.failed", error: { http_status: 503, message: "service unavailable" } });
              exit(1);
              return;
            }
            emit({ type: "thread.started", thread_id: "codex-thread-pos" });
            emit({
              type: "item.completed",
              item: { id: "msg_1", type: "agent_message", text: "healed via same-session resume" },
            });
            emit({ type: "turn.completed" });
            exit(0);
          },
          "succeeded",
        );
        assert.equal(launches.length, 2);
        assert.equal(launches[0]?.instanceId, "codex-review");
        assert.equal(launches[1]?.instanceId, "codex-review");
        assert.equal(toolExecutions, 1, "tool step executed only on the initial attempt");
        assert.ok(
          launches[1]!.args.includes("resume") && launches[1]!.args.includes("codex-thread-pos"),
          `expected codex exec resume codex-thread-pos in args=${JSON.stringify(launches[1]?.args)}`,
        );
        assert.match(launches[1]!.prompt, /# Same-session transient fault continuation/u);
        assert.ok(launches[1]!.launchedAt >= firstFailureAt, "backoff timer ran after failure");
      });

      await t.test(
        "exhaustion: 3 consecutive 503s perform 1 + 2 attempts then fail closed with zero cold replay",
        async () => {
          let attempt = 0;
          const { settled, terminalEvent } = await runChainScenario(
            "exhaust",
            "codex-provider",
            (_req, emit, exit) => {
              attempt += 1;
              emit({ type: "thread.started", thread_id: "codex-thread-exhaust" });
              if (attempt === 1) {
                emit({
                  type: "item.completed",
                  item: {
                    id: "cmd_exhaust",
                    type: "command_execution",
                    command: "echo side-effect",
                    aggregated_output: "ok",
                    exit_code: 0,
                    status: "completed",
                  },
                });
              }
              emit({ type: "turn.failed", error: { http_status: 503, message: `503 failure #${String(attempt)}` } });
              exit(1);
            },
            "failed",
          );
          assert.equal(launches.length, 3, "initial launch + 2 same-session retries");
          assert.deepEqual(
            launches.map((item) => item.instanceId),
            ["codex-provider", "codex-provider", "codex-provider"],
          );
          assert.ok(launches[1]!.args.includes("resume") && launches[1]!.args.includes("codex-thread-exhaust"));
          assert.ok(launches[2]!.args.includes("resume") && launches[2]!.args.includes("codex-thread-exhaust"));
          assert.equal(terminalEvent.payload.attempt?.fallbackState, "exhausted");
          const exhaustedRecord = readDispatchStream(root, settled.controlLeafDispatchId)?.records.findLast(
            (record) => record.kind === "fallback_state" && record.state === "exhausted",
          );
          assert.match(
            String(exhaustedRecord && "reason" in exhaustedRecord ? exhaustedRecord.reason : ""),
            /Same-session resume exhausted after 2 retry/u,
          );
        },
      );

      await t.test(
        "negative: unrecognized_model, auth_failed, and missing providerSessionId fail closed in 1 launch",
        async () => {
          const modelRes = await runChainScenario(
            "neg-model",
            "codex-resume",
            (_req, emit, exit) => {
              emit({ type: "thread.started", thread_id: "codex-thread-neg-model" });
              emit({
                type: "item.completed",
                item: {
                  id: "cmd_neg1",
                  type: "command_execution",
                  command: "echo tool",
                  aggregated_output: "ok",
                  exit_code: 0,
                  status: "completed",
                },
              });
              emit({
                type: "turn.failed",
                error: { code: "unknown_model", message: "model_not_found bad-model" },
              });
              exit(1);
            },
            "failed",
          );
          assert.equal(launches.length, 1);
          assert.equal(modelRes.terminalEvent.payload.attempt?.fallbackState ?? null, null);

          const authRes = await runChainScenario(
            "neg-auth",
            "codex-resume",
            (_req, emit, exit) => {
              emit({ type: "thread.started", thread_id: "codex-thread-neg-auth" });
              emit({
                type: "item.completed",
                item: {
                  id: "cmd_neg_auth",
                  type: "command_execution",
                  command: "echo tool",
                  aggregated_output: "ok",
                  exit_code: 0,
                  status: "completed",
                },
              });
              emit({
                type: "turn.failed",
                error: { http_status: 401, message: "unauthorized" },
              });
              exit(1);
            },
            "failed",
          );
          assert.equal(launches.length, 1);
          assert.equal(authRes.terminalEvent.payload.attempt?.fallbackState ?? null, null);

          const noSessionRes = await runChainScenario(
            "neg-nosession",
            "codex-cancel",
            (_req, emit, exit) => {
              emit({
                type: "item.completed",
                item: {
                  id: "cmd_neg2",
                  type: "command_execution",
                  command: "echo tool",
                  aggregated_output: "ok",
                  exit_code: 0,
                  status: "completed",
                },
              });
              emit({ type: "turn.failed", error: { http_status: 503, message: "service unavailable" } });
              exit(1);
            },
            "failed",
          );
          assert.equal(launches.length, 1);
          assert.equal(noSessionRes.terminalEvent.payload.attempt?.fallbackState ?? null, null);
        },
      );

      await t.test("pre-tool fault preserves immediate cross-instance fallback", async () => {
        await runChainScenario(
          "pretool",
          "codex-fast-provider",
          (req, emit, exit) => {
            if (req.definition.instanceId === "codex-fast-provider") {
              emit({ type: "thread.started", thread_id: "codex-thread-pretool" });
              emit({ type: "turn.failed", error: { http_status: 503, message: "pre-tool unavailable" } });
              exit(1);
              return;
            }
            emit({ type: "system", subtype: "init", session_id: "claude-fallback-ok" });
            emit({
              type: "result",
              subtype: "success",
              is_error: false,
              session_id: "claude-fallback-ok",
              result: "fallback succeeded",
            });
            exit(0);
          },
          "succeeded",
        );
        assert.deepEqual(
          launches.map((item) => item.instanceId),
          ["codex-fast-provider", "claude-provider"],
        );
      });
    } finally {
      await transport.stop();
      await host.close();
      removeTempRepository(parent);
    }
  },
);
