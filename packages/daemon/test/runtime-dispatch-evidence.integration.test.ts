// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader } from "@harness-anything/storage";
import { dispatchStreamPath, readDispatchStreamSummary } from "../src/dispatch-stream.ts";
import { waitForArrival, watchFileArrival, watchLedgerArrival } from "../../../tools/fixtures/event-arrival.ts";
import { purgeRepoCache } from "../src/repo-cache-purge.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { definition, installation, initIngressRepo } from "./fixtures/runtime-ingress.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

test(
  "an abnormal dispatch keeps its evidence readable after the dispatches cache is purged",
  { timeout: 30_000 },
  async (context) => {
    const settlementErrors: string[] = [];
    context.mock.method(console, "error", (...args: unknown[]) => {
      settlementErrors.push(args.map(String).join(" "));
    });
    const root = mkdtempSync(path.join(tmpdir(), "ha-dispatch-evidence-")),
      providerHome = path.join(root, "provider-home"),
      providerSessionId = "provider-evidence";
    mkdirSync(providerHome, { recursive: true });
    initIngressRepo(root, process.getuid?.() ?? 0);
    let output: ((chunk: string, persisted?: boolean) => void) | undefined,
      exit: ((code: number | null) => void) | undefined;
    const cell = await openRepoCell({
      repoId: workspaceId("dispatch-evidence"),
      rootDir: canonicalRoot(root),
      ownerId: "dispatch-evidence-test",
      runtimeDaemonRoute: {
        userRoot: path.join(root, ".daemon-user"),
        daemonId: "dispatch-evidence-test",
        endpoint: path.join(root, ".daemon-user", "daemon.sock"),
      },
      runtimeInstances: () => [
        {
          schemaVersion: 2,
          instanceId: definition.instanceId,
          name: "Codex Evidence",
          kindId: definition.kindId,
          installationId: definition.installationId,
          providerId: definition.providerId,
          models: [definition.model],
          defaultModel: definition.model,
          enabled: true,
          permissionMode: "workspace-write",
          codex: {},
          authMode: definition.authMode,
          authState: "configured",
          authReadiness: { status: "ready", code: null, hint: null },
          isolationState: "enforced",
        },
      ],
      prepareRuntimeLaunch: async (_instanceId, request) => ({
        definition,
        installation,
        executablePath: installation.executablePath,
        args: ["exec", "--json", "-"],
        env: { ...process.env, CODEX_HOME: providerHome },
        cwd: request.cwd,
        prompt: request.prompt,
      }),
      runtimeLaunch: () => ({
        pid: process.pid,
        onOutput: (listener) => {
          output = listener;
        },
        onErrorOutput: () => undefined,
        onExit: (listener) => {
          exit = listener;
        },
        terminate: () => undefined,
      }),
    });
    try {
      const binding = withPolicyGroup(
          { actor: { principal: { personId: "person-evidence" }, executor: null }, source: "local" as const },
          "admin",
        ),
        taskId = "task-dispatch-evidence",
        created = await cell.run(
          { kind: "task-create", taskId, title: "Dispatch evidence", presetId: "docs-task" },
          binding,
        );
      assert.equal(created.outcome, "applied", JSON.stringify(created));
      await waitForFixturePublication(cell, created.opId, binding);
      const packagePath = String((created as Record<string, unknown>).packagePath);
      await realizeTaskPlanFixture(
        root,
        packagePath,
        (planPath) => cell.run({ kind: "doc-submit", paths: [planPath] }, binding),
        "Dispatch evidence",
      );
      assert.equal((await cell.run({ kind: "task-start", taskId }, binding)).outcome, "applied");
      const receipt = await cell.spawnRuntime(
          {
            runtimeInstanceId: definition.instanceId,
            cwd: { scope: "repo-root" },
            prompt: "Preserve the transport before it is compacted",
            taskId,
            dispatchKey: "forensics",
          },
          binding,
        ),
        dispatchId = String(receipt.dispatchId);
      assert.ok(output, "the runtime output listener must be attached");
      assert.ok(exit, "the runtime exit listener must be attached");
      output(
        [
          JSON.stringify({ type: "thread.started", thread_id: providerSessionId, request_id: "request-1" }),
          JSON.stringify({
            type: "item.completed",
            item: { type: "agent_message", text: "authorization: Bearer sk-provider-secret" },
          }),
          JSON.stringify({ type: "turn.failed", error: { message: "provider disconnected" } }),
        ]
          .map((record) => `${record}\n`)
          .join(""),
      );
      await waitForArrival(
        () => (readDispatchStreamSummary(root, dispatchId)?.providerSessionId === providerSessionId ? true : null),
        watchFileArrival(dispatchStreamPath(root, dispatchId)),
      );
      const rollout = path.join(
        providerHome,
        "sessions",
        "2026",
        "11",
        "05",
        `rollout-2026-11-05T00-00-00-${providerSessionId}.jsonl`,
      );
      mkdirSync(path.dirname(rollout), { recursive: true });
      writeFileSync(
        rollout,
        `${JSON.stringify({
          type: "session_meta",
          payload: { id: providerSessionId, token: "sk-provider-secret", turn_id: "turn-1" },
        })}\n`,
      );
      exit(1);
      const terminal = await waitForArrival(
        () => readDispatchStreamSummary(root, dispatchId)?.terminalOutcome ?? null,
        watchFileArrival(dispatchStreamPath(root, dispatchId)),
      );
      assert.ok(
        ["failed", "stopped", "unknown"].includes(terminal.payload.outcome),
        `abnormal settlement expected, got ${terminal.payload.outcome}`,
      );
      await waitForArrival(
        () =>
          makeTaskEventReader({ repoId: workspaceId("dispatch-evidence"), rootDir: root })
            .read()
            .events.some(
              (event) =>
                event.type === "runtime_session_outcome_observed" &&
                event.payload.runtimeSessionId === String(receipt.runtimeSessionId),
            )
            ? true
            : null,
        watchLedgerArrival(root),
      );
      const evidenceDir = path.join(root, "harness", packagePath, "artifacts", "dispatches", dispatchId),
        streamPath = path.join(evidenceDir, "stream.jsonl"),
        rolloutPath = path.join(evidenceDir, "provider-rollout.jsonl"),
        tracePath = path.join(evidenceDir, "request-trace.json");
      await waitForArrival(
        () => (existsSync(tracePath) && existsSync(streamPath) && existsSync(rolloutPath) ? true : null),
        watchFileArrival(tracePath),
      );
      const streamBody = readFileSync(streamPath, "utf8"),
        rolloutBody = readFileSync(rolloutPath, "utf8"),
        traceBody = readFileSync(tracePath, "utf8");
      for (const body of [streamBody, rolloutBody, traceBody])
        assert.doesNotMatch(body, /sk-provider-secret/u, "no snapshot may carry the provider token");
      assert.match(traceBody, /request-1/u);
      assert.match(traceBody, /turn-1/u);
      // The runtime outcome is the canonical settlement witness; the write-queue drain covers the
      // compaction that runs after the outcome event, so the purge cannot race the same archive.
      await cell.awaitRuntimeOutcome(String(receipt.runtimeSessionId));
      await cell.settlePendingMaterialization("runtime dispatch evidence");
      assert.deepEqual(
        settlementErrors.filter((line) => /runtime-(?:archive|forensics)|ENOENT/u.test(line)),
        [],
        "settlement errors must fail this test instead of surviving as async noise",
      );
      // The cache purge deletes the whole runtime/dispatches root, including the archived stream
      // that settlement just compacted. The evidence copy lives in the task package and survives.
      const removed = purgeRepoCache(root);
      assert.ok(removed.includes(".harness/runtime/dispatches"), JSON.stringify(removed));
      assert.equal(existsSync(path.join(root, ".harness", "runtime", "dispatches")), false);
      assert.equal(readFileSync(streamPath, "utf8"), streamBody);
      assert.equal(readFileSync(rolloutPath, "utf8"), rolloutBody);
      assert.equal(readFileSync(tracePath, "utf8"), traceBody);
    } finally {
      await cell.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
