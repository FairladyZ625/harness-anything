// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentDefinitionSnapshot } from "@harness-anything/kernel";
import type { RuntimeInstanceSummary } from "../src/agent-runtime-instances.ts";
import { openDispatchStream } from "../src/dispatch-stream.ts";
import { RuntimeProcessStartRejected } from "../src/runtime-spawn-process.ts";
import { createRuntimeInstanceDispatchState } from "../src/runtime-instance-selection.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell } from "./repo-settings.fixture.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { fixtureRuntimeProcess } from "./fixtures/runtime-process.ts";

for (const selectionStrategy of ["sticky", "lru"] as const)
  for (const phase of [
    "awaiting-confirmation",
    "failed-unproven",
    "failed-stopped",
    "launcher-unknown",
    "start-rejected",
  ] as const)
    test(`F2: ${selectionStrategy} counts cross-repository resume load while ${phase}`, async (t) => {
      const root = mkdtempSync(path.join(tmpdir(), "ha-node-resume-load-")),
        state = createRuntimeInstanceDispatchState(),
        cells: Awaited<ReturnType<typeof openBootstrappedRepoCell>>[] = [],
        controllers: {
          sessionId: string;
          output: (chunk: string) => void;
          exit: (code: number) => void;
          pid: number;
        }[] = [],
        launched = Promise.withResolvers<void>(),
        pending: Promise<unknown>[] = [],
        resumeCount = 1,
        instances: RuntimeInstanceSummary[] = ["pro-a", "pro-b"].map((instanceId) => ({
          schemaVersion: 2,
          instanceId,
          name: instanceId,
          kindId: "codex",
          installationId: "pool-installation",
          providerId: "openai",
          models: ["pool-model"],
          defaultModel: "pool-model",
          enabled: true,
          tier: 1,
          credentialSource: "instance",
          permissionMode: "bypass",
          authMode: "subscription",
          authState: "authenticated",
          authReadiness: { status: "ready", code: null, hint: null },
          isolationState: "enforced",
          configuration: {},
        })),
        binding = withPolicyGroup(
          { actor: { principal: { personId: "person-resume-load" }, executor: null }, source: "local" },
          "admin",
        );
      let resumeLaunches = 0;
      try {
        for (const name of ["x", "y"]) {
          const repo = path.join(root, name);
          mkdirSync(path.join(repo, "harness"), { recursive: true });
          execFileSync("git", ["init", "-q", repo]);
          execFileSync("git", ["-C", repo, "config", "user.name", "Resume Load Test"]);
          execFileSync("git", ["-C", repo, "config", "user.email", "resume-load@example.invalid"]);
          execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-qm", "base"]);
          writeFileSync(
            path.join(repo, "harness/harness.yaml"),
            `schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\nsettings:\n  runtime:\n    selectionStrategy: ${selectionStrategy}\n`,
          );
          cells.push(
            await openBootstrappedRepoCell({
              repoId: workspaceId(`resume-load-${selectionStrategy}-${phase}-${name}`),
              rootDir: canonicalRoot(repo),
              ownerId: "resume-load-test",
              runtimeInstanceDispatchState: state,
              runtimeInstances: () => instances,
              prepareRuntimeLaunch: (instanceId, request) => ({
                definition: {
                  schema: "agent-definition-snapshot/v1",
                  configVersion: 1,
                  instanceId,
                  installationId: "pool-installation",
                  kindId: "codex",
                  providerId: "openai",
                  model: "pool-model",
                  reasoningEffort: null,
                  baseUrl: null,
                  authMode: "subscription",
                } satisfies AgentDefinitionSnapshot,
                installation: {
                  installationId: "pool-installation",
                  kindId: "codex",
                  executablePath: "/fixture/codex",
                  version: "1.0.0",
                  observedAt: "2026-11-14T00:00:00.000Z",
                },
                executablePath: "/fixture/codex",
                args: request.providerSessionId ? [request.providerSessionId] : [],
                env: {},
                cwd: request.cwd,
                prompt: request.prompt,
              }),
              runtimeLaunch: (prepared) => {
                const sessionId = prepared.args[0];
                if (sessionId) resumeLaunches++;
                if (sessionId && phase === "start-rejected") {
                  if (resumeLaunches === resumeCount) launched.resolve();
                  throw new RuntimeProcessStartRejected(new Error("test proves no process was created"));
                }
                const child = fixtureRuntimeProcess(t);
                if (!sessionId)
                  return {
                    ...child,
                    onOutput: () => undefined,
                    onErrorOutput: () => undefined,
                    onExit: () => undefined,
                  };
                const controller = {
                  sessionId,
                  output: (_chunk: string) => {},
                  exit: (_code: number) => {},
                  pid: child.pid,
                };
                controllers.push(controller);
                if (phase === "launcher-unknown") {
                  if (resumeLaunches === resumeCount) launched.resolve();
                  throw new Error("launcher lost the new process handle");
                }
                return {
                  ...child,
                  ...(phase === "failed-unproven"
                    ? { terminate: () => undefined, terminateTree: async () => undefined }
                    : {}),
                  onOutput: (listener) => {
                    controller.output = listener;
                  },
                  onErrorOutput: () => undefined,
                  onExit: (listener) => {
                    controller.exit = listener;
                    if (controllers.length === resumeCount) launched.resolve();
                  },
                };
              },
            }),
          );
        }
        const [repoX, repoY] = cells;
        if (selectionStrategy === "lru")
          await repoY!.spawnRuntime(
            { runtimeInstanceId: "pro-b", prompt: "Hold pro-b", dispatchKey: "busy-b" },
            binding,
          );
        for (let index = 0; index < resumeCount; index++) {
          const sourceDispatchId = `dispatch_${String(index + 1).repeat(24)}`,
            sessionId = `provider-resume-${index}`;
          openDispatchStream(path.join(root, "x"), {
            dispatchId: sourceDispatchId,
            runtimeSessionId: `source-${index}`,
            instanceId: "pro-a",
            taskId: null,
            executionId: null,
            kindId: "codex",
            startedAt: "2026-11-14T00:00:00.000Z",
            cwd: path.join(root, "x"),
            prompt: "Resume the existing provider session",
            model: "pool-model",
          }).appendProviderBinding(sessionId, "2026-11-14T00:00:01.000Z");
          const resumed = repoX!.spawnRuntime(
            { dispatchId: sourceDispatchId, dispatchKey: `resume-${index}`, prompt: "Continue work" },
            binding,
          );
          void resumed.catch(() => undefined);
          pending.push(resumed);
        }
        if (phase === "launcher-unknown" || phase === "start-rejected") await launched.promise;
        else
          await Promise.race([
            launched.promise,
            ...pending.map((resumed) => resumed.then(() => assert.fail("resume confirmed before the test witness"))),
          ]);
        for (const controller of controllers)
          assert.equal(process.kill(controller.pid, 0), true, "a real child is running");
        if (phase !== "awaiting-confirmation") {
          for (const controller of controllers) controller.exit(1);
          for (const resumed of pending) await assert.rejects(resumed, { code: "runtime_resume_failed" });
        }
        const selected = await repoY!.spawnRuntime(
          { prompt: "Choose from the pool", dispatchKey: "selection" },
          binding,
        );
        assert.equal(
          (selected.runtimeSelection as { instanceId: string }).instanceId,
          phase === "failed-stopped" || phase === "start-rejected" ? "pro-a" : "pro-b",
          "an unconfirmed or unproven-stop resume must count; a proven stop must release load",
        );
        assert.equal(
          state.readActiveLoads().get("pro-a") ?? 0,
          phase === "failed-stopped" || phase === "start-rejected" ? 1 : resumeCount,
        );
      } finally {
        for (const controller of controllers)
          controller.output(JSON.stringify({ type: "thread.started", thread_id: controller.sessionId }) + "\n");
        await Promise.allSettled(pending);
        for (const cell of cells) await cell.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
