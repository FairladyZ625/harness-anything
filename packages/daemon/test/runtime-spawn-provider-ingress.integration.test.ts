// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader } from "../../kernel/src/index.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";
import { registerBootstrappedDaemonRepo as registerDaemonRepo } from "./repo-settings.fixture.ts";
import {
  initIngressRepo,
  rpc,
  rpcAttach,
  eventually,
  eventuallyValue,
  writeProviderStub,
  installationFixture,
} from "./fixtures/runtime-ingress.ts";

test("daemon ingress persists scrubbed provider JSONL while returning canonical results for both runtime kinds", async (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-provider-events-")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    repoId = "runtime-provider-events",
    uid = 4302;
  initIngressRepo(root, uid);
  registerDaemonRepo({
    canonicalRoot: root,
    repoId,
    userRoot,
    createConvenienceLinks: false,
  });
  const installations = (["claude", "codex"] as const).map((kindId) => {
    const executablePath = writeProviderStub(
      path.join(parent, `${kindId}-stub.mjs`),
      kindId,
      undefined,
      kindId === "claude" ? 1_000 : 40,
    );
    return {
      installationId: `installation-${kindId}`,
      kindId,
      executablePath,
      version: "1.0.0",
      observedAt: "2026-08-19T00:00:00.000Z",
    } as const;
  });
  const auth = {
      transportKind: "unix-socket",
      unixSocketOwnerBoundary: {
        ownerUid: uid,
        source: "unix-socket-filesystem-owner-boundary",
      },
    } as const,
    host = await openDaemonHost({
      daemonId: "runtime-provider-events",
      userRoot,
      runtimeDiscover: () => installations,
    });
  await host.attachmentsSettled();
  try {
    for (const kindId of ["claude", "codex"] as const)
      host.runtimeInstance(
        "daemon.runtimeInstance.create",
        {
          instanceId: `${kindId}-provider`,
          name: `${kindId} provider`,
          kindId,
          installationId: `installation-${kindId}`,
          providerId: kindId === "claude" ? "anthropic" : "openai",
          models: [`${kindId}-model`],
          authMode: "subscription",
        },
        auth,
      );
    host.runtimeInstance(
      "daemon.runtimeInstance.create",
      {
        instanceId: "codex-read-only",
        name: "codex read only",
        kindId: "codex",
        installationId: "installation-codex",
        providerId: "openai",
        models: ["codex-model"],
        permissionMode: "read-only",
        authMode: "subscription",
      },
      auth,
    );
    for (const kindId of ["claude", "codex"] as const)
      await t.test(kindId, async () => {
        const receipt = await rpc(host, auth, "repo.agentRuntime.spawn", {
          repo: { repoId },
          payload: {
            runtimeInstanceId: `${kindId}-provider`,
            cwd: { scope: "repo-root" },
            prompt: `Run ${kindId}`,
            taskId: null,
            idempotencyKey: `${kindId}-provider-events`,
          },
        });
        assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
        // Keep Claude active while its first message is already buffered so it covers the attach
        // response's replay path; Codex continues to cover live notifications after attachment.
        if (kindId === "claude") await new Promise((resolve) => setTimeout(resolve, 2_000));
        const frames: Record<string, unknown>[] = [],
          attached = await rpcAttach(host, auth, repoId, String(receipt.runtimeSessionId), frames);
        try {
          await eventually(async () =>
            frames.some(
              (frame) =>
                frame.type === "activity" && frame.activity === "message" && frame.content === `${kindId} live content`,
            ),
          );
          const read = await eventuallyValue(async () => {
            const value = await rpc(host, auth, "repo.agentRuntime.sessions.read", {
              repo: { repoId },
              payload: { runtimeSessionId: receipt.runtimeSessionId },
            });
            return value.result ? value : null;
          });
          assert.equal((read.session as Record<string, unknown>).providerSessionId, `${kindId}-provider-session`);
          assert.deepEqual((read.session as { activity: unknown }).activity, {
            lastObservedAt: (read.session as { activity: { lastObservedAt: string } }).activity.lastObservedAt,
            outcome: "succeeded",
            exitCode: 0,
            resultRef: (read.result as Record<string, unknown>).ref,
            missingEvidence: null,
          });
          assert.deepEqual(read.result, {
            ref: (read.result as Record<string, unknown>).ref,
            text: `${kindId} final result`,
          });
          assert.match(
            String((read.result as Record<string, unknown>).ref),
            /^artifact:runtime-result\/sha256\/[0-9a-f]{64}$/u,
          );
          const streamPath = path.join(root, ".harness", "runtime", "dispatches", `${receipt.dispatchId}.jsonl`),
            stream = await eventuallyValue(() => {
              try {
                return readFileSync(streamPath, "utf8");
              } catch {
                return null;
              }
            });
          assert.match(stream, /"kind":"provider_event"/u);
          if (kindId === "codex") {
            assert.doesNotMatch(
              stream,
              /credentialRef|executablePath|apiToken|sk-provider-secret|\/provider\/private/u,
            );
          }
          const outcome = makeTaskEventReader({ repoId, rootDir: root })
            .read()
            .events.find(
              (event) =>
                event.type === "runtime_session_outcome_observed" &&
                event.payload.runtimeSessionId === receipt.runtimeSessionId,
            );
          assert.equal(outcome?.type, "runtime_session_outcome_observed");
          if (outcome?.type === "runtime_session_outcome_observed")
            assert.equal(
              Buffer.from(
                makeTaskEventReader({ repoId, rootDir: root }).readContentBlob(outcome.payload.result!.sha256)!,
              ).toString("utf8"),
              `${kindId} final result`,
            );
        } finally {
          attached.close();
        }
      });
    const readOnly = await rpc(host, auth, "repo.agentRuntime.spawn", {
        repo: { repoId },
        payload: {
          runtimeInstanceId: "codex-read-only",
          cwd: { scope: "repo-root" },
          prompt: "read-only",
          taskId: null,
          idempotencyKey: "codex-read-only",
        },
      }),
      readOnlyRead = await eventuallyValue(async () => {
        const value = await rpc(host, auth, "repo.agentRuntime.sessions.read", {
          repo: { repoId },
          payload: { runtimeSessionId: readOnly.runtimeSessionId },
        });
        // A read racing the writer's projection catch-up can observe the session before it is
        // projected (runtime_session_not_found), which returns a receipt with no `session` at
        // all -- keep polling rather than crashing on that transient shape.
        return (value.session as { activity?: { outcome: unknown } } | undefined)?.activity?.outcome ? value : null;
      });
    assert.deepEqual(
      (
        readOnlyRead.session as {
          activity: { outcome: unknown; exitCode: unknown };
        }
      ).activity && {
        outcome: (readOnlyRead.session as { activity: { outcome: unknown } }).activity.outcome,
        exitCode: (readOnlyRead.session as { activity: { exitCode: unknown } }).activity.exitCode,
      },
      { outcome: "succeeded", exitCode: 0 },
    );
    const noAction = await rpc(host, auth, "repo.agentRuntime.spawn", {
        repo: { repoId },
        payload: {
          runtimeInstanceId: "codex-provider",
          cwd: { scope: "repo-root" },
          prompt: "no-action",
          taskId: null,
          idempotencyKey: "codex-no-action",
        },
      }),
      noActionRead = await eventuallyValue(async () => {
        const value = await rpc(host, auth, "repo.agentRuntime.sessions.read", {
          repo: { repoId },
          payload: { runtimeSessionId: noAction.runtimeSessionId },
        });
        // A read racing the writer's projection catch-up can observe the session before it is
        // projected (runtime_session_not_found), which returns a receipt with no `session` at
        // all -- keep polling rather than crashing on that transient shape.
        return (value.session as { activity?: { outcome: unknown } } | undefined)?.activity?.outcome ? value : null;
      });
    assert.deepEqual(
      (
        noActionRead.session as {
          activity: { outcome: unknown; exitCode: unknown };
        }
      ).activity && {
        outcome: (noActionRead.session as { activity: { outcome: unknown } }).activity.outcome,
        exitCode: (noActionRead.session as { activity: { exitCode: unknown } }).activity.exitCode,
      },
      { outcome: "succeeded", exitCode: 0 },
    );
    const noWrite = await rpc(host, auth, "repo.agentRuntime.spawn", {
        repo: { repoId },
        payload: {
          runtimeInstanceId: "codex-provider",
          cwd: { scope: "repo-root" },
          prompt: "no-write",
          taskId: null,
          idempotencyKey: "codex-no-write",
        },
      }),
      noWriteRead = await eventuallyValue(async () => {
        const value = await rpc(host, auth, "repo.agentRuntime.sessions.read", {
          repo: { repoId },
          payload: { runtimeSessionId: noWrite.runtimeSessionId },
        });
        // A read racing the writer's projection catch-up can observe the session before it is
        // projected (runtime_session_not_found), which returns a receipt with no `session` at
        // all -- keep polling rather than crashing on that transient shape.
        return (value.session as { activity?: { outcome: unknown } } | undefined)?.activity?.outcome ? value : null;
      });
    assert.deepEqual(
      (
        noWriteRead.session as {
          activity: { outcome: unknown; exitCode: unknown };
        }
      ).activity && {
        outcome: (noWriteRead.session as { activity: { outcome: unknown } }).activity.outcome,
        exitCode: (noWriteRead.session as { activity: { exitCode: unknown } }).activity.exitCode,
      },
      { outcome: "succeeded", exitCode: 0 },
    );
    const denied = await rpc(host, auth, "repo.agentRuntime.spawn", {
        repo: { repoId },
        payload: {
          runtimeInstanceId: "claude-provider",
          cwd: { scope: "repo-root" },
          prompt: "permission-denied",
          taskId: null,
          idempotencyKey: "claude-permission-denied",
        },
      }),
      deniedRead = await eventuallyValue(async () => {
        const value = await rpc(host, auth, "repo.agentRuntime.sessions.read", {
          repo: { repoId },
          payload: { runtimeSessionId: denied.runtimeSessionId },
        });
        // A read racing the writer's projection catch-up can observe the session before it is
        // projected (runtime_session_not_found), which returns a receipt with no `session` at
        // all -- keep polling rather than crashing on that transient shape.
        return (value.session as { activity?: { outcome: unknown } } | undefined)?.activity?.outcome ? value : null;
      });
    assert.deepEqual(
      (
        deniedRead.session as {
          activity: { outcome: unknown; exitCode: unknown };
        }
      ).activity && {
        outcome: (deniedRead.session as { activity: { outcome: unknown } }).activity.outcome,
        exitCode: (deniedRead.session as { activity: { exitCode: unknown } }).activity.exitCode,
      },
      { outcome: "succeeded", exitCode: 0 },
    );
    const empty = await rpc(host, auth, "repo.agentRuntime.spawn", {
      repo: { repoId },
      payload: {
        runtimeInstanceId: "codex-provider",
        cwd: { scope: "repo-root" },
        prompt: "failure:empty",
        taskId: null,
        idempotencyKey: "codex-empty-failure",
      },
    });
    const emptyRead = await eventuallyValue(async () => {
      const value = await rpc(host, auth, "repo.agentRuntime.sessions.read", {
        repo: { repoId },
        payload: { runtimeSessionId: empty.runtimeSessionId },
      });
      // See the comment above the first occurrence of this guard: a read racing the writer's
      // projection catch-up can return a receipt with no `session` yet.
      return (value.session as { activity?: { outcome: unknown } } | undefined)?.activity?.outcome ? value : null;
    });
    assert.deepEqual(
      (
        emptyRead.session as {
          activity: { outcome: unknown; exitCode: unknown };
        }
      ).activity && {
        outcome: (emptyRead.session as { activity: { outcome: unknown } }).activity.outcome,
        exitCode: (emptyRead.session as { activity: { exitCode: unknown } }).activity.exitCode,
      },
      { outcome: "failed", exitCode: 1 },
    );
    assert.equal(
      (emptyRead.result as Record<string, unknown>).text,
      "Provider exited with code 1 and produced no output.",
    );
    const secret = "sk-runtime-secret-1234567890",
      stderrFailure = await rpc(host, auth, "repo.agentRuntime.spawn", {
        repo: { repoId },
        payload: {
          runtimeInstanceId: "codex-provider",
          cwd: { scope: "repo-root" },
          prompt: "failure:secret",
          taskId: null,
          idempotencyKey: "codex-stderr-failure",
        },
      });
    const stderrRead = await eventuallyValue(async () => {
      const value = await rpc(host, auth, "repo.agentRuntime.sessions.read", {
        repo: { repoId },
        payload: { runtimeSessionId: stderrFailure.runtimeSessionId },
      });
      // See the comment above the first occurrence of this guard: a read racing the writer's
      // projection catch-up can return a receipt with no `session` yet.
      return (value.session as { activity?: { outcome: unknown } } | undefined)?.activity?.outcome ? value : null;
    });
    assert.match(
      String((stderrRead.result as Record<string, unknown>).text),
      /Provider exited with code 1.*OPENAI_API_KEY=\[REDACTED\]/u,
    );
    assert.doesNotMatch(JSON.stringify(stderrRead), new RegExp(secret, "u"));
    assert.doesNotMatch(
      readFileSync(path.join(root, ".harness", "runtime", "dispatches", `${stderrFailure.dispatchId}.jsonl`), "utf8"),
      new RegExp(secret, "u"),
    );
    const structured = await rpc(host, auth, "repo.agentRuntime.spawn", {
      repo: { repoId },
      payload: {
        runtimeInstanceId: "codex-provider",
        cwd: { scope: "repo-root" },
        prompt: "failure:structured",
        taskId: null,
        idempotencyKey: "codex-structured-failure",
      },
    });
    const structuredRead = await eventuallyValue(async () => {
      const value = await rpc(host, auth, "repo.agentRuntime.sessions.read", {
        repo: { repoId },
        payload: { runtimeSessionId: structured.runtimeSessionId },
      });
      // See the comment above the first occurrence of this guard: a read racing the writer's
      // projection catch-up can return a receipt with no `session` yet.
      return (value.session as { activity?: { outcome: unknown } } | undefined)?.activity?.outcome ? value : null;
    });
    assert.match(String((structuredRead.result as Record<string, unknown>).text), /structured provider failure/u);
    assert.doesNotMatch(JSON.stringify(structuredRead), new RegExp(secret, "u"));
  } finally {
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("daemon ingress resumes the same provider session for Claude and Codex", async (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-resume-")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    repoId = "runtime-resume",
    uid = 4303;
  initIngressRepo(root, uid);
  registerDaemonRepo({
    canonicalRoot: root,
    repoId,
    userRoot,
    createConvenienceLinks: false,
  });
  const launches: {
      readonly kindId: string;
      readonly args: readonly string[];
    }[] = [],
    installations = (["claude", "codex"] as const).map((kindId) => {
      const executablePath = writeProviderStub(path.join(parent, `${kindId}-resume-stub.mjs`), kindId);
      return {
        installationId: `installation-${kindId}`,
        kindId,
        executablePath,
        version: "1.0.0",
        observedAt: "2026-08-19T00:00:00.000Z",
      } as const;
    });
  const auth = {
      transportKind: "unix-socket",
      unixSocketOwnerBoundary: {
        ownerUid: uid,
        source: "unix-socket-filesystem-owner-boundary",
      },
    } as const,
    host = await openDaemonHost({
      daemonId: "runtime-resume",
      userRoot,
      runtimeDiscover: () => installations,
      runtimeLaunch: (prepared) => {
        const kindId = prepared.definition.kindId,
          resumed = prepared.args.includes("--resume") || prepared.args.includes("resume"),
          providerSessionId = kindId === "claude" ? "claude-resume-session" : "codex-resume-session";
        launches.push({ kindId, args: prepared.args });
        const output =
          kindId === "claude"
            ? [
                {
                  type: "system",
                  subtype: "init",
                  session_id: providerSessionId,
                },
                {
                  type: "assistant",
                  session_id: providerSessionId,
                  message: {
                    content: [
                      {
                        type: "text",
                        text: resumed ? "claude second turn" : "claude first turn",
                      },
                    ],
                  },
                },
                {
                  type: "result",
                  subtype: "success",
                  is_error: false,
                  session_id: providerSessionId,
                  result: resumed ? "claude second result" : "claude first result",
                },
              ]
            : [
                { type: "thread.started", thread_id: providerSessionId },
                {
                  type: "item.completed",
                  item: {
                    id: "resume-item",
                    type: "agent_message",
                    text: resumed ? "codex second turn" : "codex first turn",
                  },
                },
                {
                  type: "turn.completed",
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
              ];
        return {
          pid: 4400 + launches.length,
          onOutput: (listener) => {
            queueMicrotask(() => output.forEach((frame) => listener(`${JSON.stringify(frame)}\n`)));
          },
          onErrorOutput: () => undefined,
          onExit: (listener) => {
            queueMicrotask(() => listener(0));
          },
          terminate: () => undefined,
        };
      },
    });
  try {
    for (const kindId of ["claude", "codex"] as const)
      await t.test(kindId, async () => {
        const definition = {
          instanceId: `${kindId}-resume`,
          name: `${kindId} resume`,
          kindId,
          installationId: `installation-${kindId}`,
          providerId: kindId === "claude" ? "anthropic" : "openai",
          models: [`${kindId}-model`],
          authMode: "subscription",
        };
        host.runtimeInstance("daemon.runtimeInstance.create", definition, auth);
        const first = await rpc(host, auth, "repo.agentRuntime.spawn", {
          repo: { repoId },
          payload: {
            runtimeInstanceId: definition.instanceId,
            cwd: { scope: "repo-root" },
            prompt: "First turn",
            taskId: null,
            idempotencyKey: `${kindId}-resume-first`,
          },
        });
        assert.equal(first.outcome, "applied", JSON.stringify(first));
        await eventually(async () =>
          makeTaskEventReader({ repoId, rootDir: root })
            .read()
            .events.some(
              (event) =>
                event.type === "runtime_session_outcome_observed" &&
                event.payload.runtimeSessionId === first.runtimeSessionId,
            ),
        );
        const providerSessionId = kindId === "claude" ? "claude-resume-session" : "codex-resume-session",
          second = await rpc(host, auth, "repo.agentRuntime.spawn", {
            repo: { repoId },
            payload: {
              runtimeInstanceId: definition.instanceId,
              cwd: { scope: "repo-root" },
              prompt: "Second turn",
              providerSessionId,
              taskId: null,
              idempotencyKey: `${kindId}-resume-second`,
            },
          });
        await eventually(async () =>
          makeTaskEventReader({ repoId, rootDir: root })
            .read()
            .events.some(
              (event) =>
                event.type === "runtime_session_outcome_observed" &&
                event.payload.runtimeSessionId === second.runtimeSessionId,
            ),
        );
        const read = await eventuallyValue(async () => {
          const value = await rpc(host, auth, "repo.agentRuntime.sessions.read", {
            repo: { repoId },
            payload: { runtimeSessionId: second.runtimeSessionId },
          });
          return value.result ? value : null;
        });
        assert.equal((read.session as Record<string, unknown>).providerSessionId, providerSessionId);
        assert.equal(
          (read.result as Record<string, unknown>).text,
          kindId === "claude" ? "claude second result" : "codex second turn",
        );
        const secondLaunch = launches.findLast((launch) => launch.kindId === kindId)!;
        if (kindId === "claude") assert.deepEqual(secondLaunch.args.slice(-2), ["--resume", providerSessionId]);
        else {
          assert.deepEqual(secondLaunch.args.slice(0, 2), ["exec", "resume"]);
          assert.equal(secondLaunch.args.at(-2), providerSessionId);
        }
      });
  } finally {
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("daemon ingress cancellation is explicit and idempotent for an active runtime", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-cancel-")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    executablePath = path.join(parent, "cancel-stub.mjs"),
    repoId = "runtime-cancel",
    uid = 4304;
  initIngressRepo(root, uid);
  registerDaemonRepo({
    canonicalRoot: root,
    repoId,
    userRoot,
    createConvenienceLinks: false,
  });
  const installation = installationFixture("codex", writeProviderStub(executablePath, "codex"));
  const auth = {
      transportKind: "unix-socket",
      unixSocketOwnerBoundary: {
        ownerUid: uid,
        source: "unix-socket-filesystem-owner-boundary",
      },
    } as const,
    host = await openDaemonHost({
      daemonId: "runtime-cancel",
      userRoot,
      runtimeDiscover: () => [installation],
      runtimeLaunch: () => ({
        pid: 4501,
        onOutput: () => undefined,
        onErrorOutput: () => undefined,
        onExit: () => undefined,
        terminate: () => undefined,
      }),
    });
  try {
    const definition = {
      instanceId: "codex-cancel",
      name: "codex cancel",
      kindId: "codex" as const,
      installationId: installation.installationId,
      providerId: "openai",
      models: ["codex-model"],
      authMode: "subscription" as const,
    };
    host.runtimeInstance("daemon.runtimeInstance.create", definition, auth);
    const spawned = await rpc(host, auth, "repo.agentRuntime.spawn", {
      repo: { repoId },
      payload: {
        runtimeInstanceId: definition.instanceId,
        cwd: { scope: "repo-root" },
        prompt: "Keep running",
        taskId: null,
        idempotencyKey: "cancel-active",
      },
    });
    assert.equal(spawned.outcome, "applied", JSON.stringify(spawned));
    const frames: Record<string, unknown>[] = [],
      attached = await rpcAttach(host, auth, repoId, String(spawned.runtimeSessionId), frames);
    try {
      const cancelled = await rpc(host, auth, "repo.agentRuntime.cancel", {
        repo: { repoId },
        payload: { runtimeSessionId: spawned.runtimeSessionId },
      });
      assert.equal(cancelled.outcome, "applied");
      assert.equal(cancelled.command, "runtime-cancel");
      const read = await eventuallyValue(async () => {
        const value = await rpc(host, auth, "repo.agentRuntime.sessions.read", {
          repo: { repoId },
          payload: { runtimeSessionId: spawned.runtimeSessionId },
        });
        // See the comment above the `.activity` polling guards: a read racing the writer's
        // projection catch-up can return a receipt with no `session` yet.
        return (value.session as Record<string, unknown> | undefined)?.liveness === "exited" ? value : null;
      });
      assert.equal(
        (read.session as Record<string, unknown>).activity &&
          ((read.session as Record<string, unknown>).activity as Record<string, unknown>).outcome,
        "cancelled",
      );
      await eventually(() => frames.some((frame) => frame.type === "exit" && frame.outcome === "cancelled"));
      const events = makeTaskEventReader({ repoId, rootDir: root })
        .read()
        .events.filter(
          (event) => "runtimeSessionId" in event.payload && event.payload.runtimeSessionId === spawned.runtimeSessionId,
        );
      assert.equal(
        events.some((event) => event.type === "runtime_session_cancelled"),
        true,
      );
      const repeat = await rpc(host, auth, "repo.agentRuntime.cancel", {
        repo: { repoId },
        payload: { runtimeSessionId: spawned.runtimeSessionId },
      });
      assert.equal(repeat.outcome, "applied");
      assert.equal(repeat.detail, "already-exited");
      const missing = await rpc(host, auth, "repo.agentRuntime.cancel", {
        repo: { repoId },
        payload: { runtimeSessionId: "runtime_missing" },
      });
      assert.equal(missing.outcome, "pending");
      assert.equal((missing.proof as Record<string, unknown>).canonicalVisible, false);
    } finally {
      attached.close();
    }
  } finally {
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("agy consumes only its closed stream-json event protocol", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-agy-events-")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    repoId = "runtime-agy-events",
    uid = 4305;
  let installation = {
    installationId: "installation-agy",
    kindId: "agy" as const,
    executablePath: "/opt/witnessed/agy",
    version: "1.1.15",
    observedAt: "2026-08-19T00:00:00.000Z",
  };
  initIngressRepo(root, uid);
  registerDaemonRepo({
    canonicalRoot: root,
    repoId,
    userRoot,
    createConvenienceLinks: false,
  });
  const agyStub = writeProviderExecutable(path.join(parent, "agy-stub"), "process.exit(0)\n");
  installation = { ...installation, executablePath: agyStub };
  let unknown = false;
  const auth = {
      transportKind: "unix-socket",
      unixSocketOwnerBoundary: {
        ownerUid: uid,
        source: "unix-socket-filesystem-owner-boundary",
      },
    } as const,
    host = await openDaemonHost({
      daemonId: "runtime-agy-events",
      userRoot,
      runtimeDiscover: () => [installation],
      runtimeLaunch: (prepared) => {
        assert.deepEqual(prepared.args, [
          "-p",
          unknown ? "Unknown event" : "Structured result",
          "--output-format",
          "stream-json",
          "--model",
          "gemini-3.1-pro-low",
          "--dangerously-skip-permissions",
          "--effort",
          "low",
        ]);
        const output = unknown
          ? [{ event: "future_event", text: "must not become a result" }]
          : [
              { event: "init", conversation_id: "agy-conversation" },
              {
                event: "step_update",
                step_update: {
                  conversation_id: "agy-conversation",
                  step_index: 1,
                  state: "ACTIVE",
                  step_type: "agent_response",
                  text_delta: "live",
                },
              },
              {
                event: "result",
                result: {
                  conversation_id: "agy-conversation",
                  status: "SUCCESS",
                  response: "AGY-OK",
                },
              },
            ];
        return {
          pid: 4601,
          onOutput: (listener) => {
            queueMicrotask(() => output.forEach((frame) => listener(`${JSON.stringify(frame)}\n`)));
          },
          onErrorOutput: () => undefined,
          onExit: (listener) => {
            queueMicrotask(() => listener(0));
          },
          terminate: () => undefined,
        };
      },
    });
  try {
    host.runtimeInstance(
      "daemon.runtimeInstance.create",
      {
        instanceId: "agy-provider",
        name: "agy provider",
        kindId: "agy",
        installationId: installation.installationId,
        providerId: "google",
        models: ["gemini-3.1-pro-low"],
        agy: { effort: "low" },
        authMode: "subscription",
      },
      auth,
    );
    const succeeded = await rpc(host, auth, "repo.agentRuntime.spawn", {
      repo: { repoId },
      payload: {
        runtimeInstanceId: "agy-provider",
        cwd: { scope: "repo-root" },
        prompt: "Structured result",
        effort: "low",
        taskId: null,
        idempotencyKey: "agy-structured",
      },
    });
    assert.equal(succeeded.outcome, "applied", JSON.stringify(succeeded));
    const read = await eventuallyValue(async () => {
      const value = await rpc(host, auth, "repo.agentRuntime.sessions.read", {
        repo: { repoId },
        payload: { runtimeSessionId: succeeded.runtimeSessionId },
      });
      return value.result ? value : null;
    });
    assert.equal((read.session as Record<string, unknown>).providerSessionId, "agy-conversation");
    assert.equal((read.result as Record<string, unknown>).text, "AGY-OK");
    assert.equal((read.session as { activity: { outcome: string } }).activity.outcome, "succeeded");
    unknown = true;
    const rejected = await rpc(host, auth, "repo.agentRuntime.spawn", {
      repo: { repoId },
      payload: {
        runtimeInstanceId: "agy-provider",
        cwd: { scope: "repo-root" },
        prompt: "Unknown event",
        effort: "low",
        taskId: null,
        idempotencyKey: "agy-unknown",
      },
    });
    assert.equal(rejected.outcome, "applied", JSON.stringify(rejected));
    const rejectedRead = await eventuallyValue(async () => {
      const value = await rpc(host, auth, "repo.agentRuntime.sessions.read", {
        repo: { repoId },
        payload: { runtimeSessionId: rejected.runtimeSessionId },
      });
      // See the comment above the first occurrence of this guard: a read racing the writer's
      // projection catch-up can return a receipt with no `session` yet.
      return (value.session as { activity?: { outcome: unknown } } | undefined)?.activity?.outcome ? value : null;
    });
    assert.equal((rejectedRead.session as { activity: { outcome: string } }).activity.outcome, "succeeded");
    assert.equal((rejectedRead.result as Record<string, unknown>).text, "");
  } finally {
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
