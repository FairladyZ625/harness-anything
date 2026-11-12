// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentRuntimeEventV1 } from "@harness-anything/kernel";
import { makeTaskEventReader } from "@harness-anything/storage";
import { readDispatchStream } from "../src/dispatch-stream.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { makeRuntimeSpawner } from "../src/runtime-spawner.ts";
import { definition, installation, initIngressRepo } from "./fixtures/runtime-ingress.ts";
import { policyTestCenter, withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { openBootstrappedRepoCell } from "./repo-settings.fixture.ts";

for (const fault of ["credential issuance", "lost receipt", "unavailable acceptance"] as const)
  test(`an accepted launch settles after ${fault} fails`, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-admission-failure-")),
      repoId = "admission-failure",
      binding = withPolicyGroup(
        {
          actor: { principal: { personId: "person-admission" }, executor: null },
          source: { kind: "node" as const, nodeId: "edge-admission" },
        },
        "admin",
      ),
      center = await policyTestCenter();
    initIngressRepo(root, 0);
    const cell = await openBootstrappedRepoCell({
      repoId: workspaceId(repoId),
      rootDir: canonicalRoot(root),
      ownerId: repoId,
    });
    // Authorization installs a bounded fetch port on a fresh adapter. Inject on its shared
    // method so the test faults the actual issuance boundary, including that authorized clone.
    const prototype = Object.getPrototypeOf(center.provider) as typeof center.provider,
      issue = prototype.issueExecutionCredential;
    let injected = false,
      launches = 0;
    t.mock.method(
      prototype,
      "issueExecutionCredential",
      async function (this: typeof center.provider, ...args: Parameters<typeof issue>) {
        if (fault === "credential issuance" && !injected) {
          injected = true;
          throw new Error("injected credential issuance failure after commit");
        }
        return issue.apply(this, args);
      },
    );
    const spawner = makeRuntimeSpawner({
      repoId,
      rootDir: root,
      daemonGeneration: 1,
      runtimeNode: { nodeId: "edge-admission" },
      runtimeDaemonRoute: {
        userRoot: path.join(root, ".daemon-user"),
        daemonId: repoId,
        endpoint: path.join(root, "daemon.sock"),
      },
      stream: { publish: () => undefined },
      now: () => new Date().toISOString(),
      readSettings: () => ({ runtime: { allowedInstances: [definition.instanceId] } }) as never,
      runtimeInstances: () => [
        {
          schemaVersion: 2,
          instanceId: definition.instanceId,
          name: "Admission worker",
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
      prepareLaunch: async (_instance, request) => ({
        definition,
        installation,
        executablePath: installation.executablePath,
        args: [],
        env: process.env,
        cwd: request.cwd,
        prompt: request.prompt,
      }),
      launch: () => {
        launches++;
        assert.fail("an unacknowledged launch must not start a provider");
      },
      schedule: () => assert.fail("launch cleanup settles in its current turn"),
      remote: {
        executionCredential: () => assert.fail("no credential was delivered"),
        taskContext: async () => assert.fail("taskless dispatch"),
        readRuntimeSession: async () => null,
        readRuntimeSessions: async () => [],
        readRuntimeDispatch: async () => assert.fail("a stale edge replica cannot prove admission"),
        readDispatchLifecycle: (query) => {
          if (injected && fault === "unavailable acceptance") throw new Error("injected acceptance read failure");
          return cell.readDispatchLifecycle(query);
        },
        publish: async (draft) => {
          const receipt = await cell.runtimeIngress({ kind: "event", ...draft }, binding);
          if (draft.type === "runtime_dispatch_requested" && fault !== "credential issuance") {
            injected = true;
            throw new Error("injected receipt loss after commit");
          }
          return { event: (receipt.event as unknown as AgentRuntimeEventV1) ?? null, receipt };
        },
        archive: async () => assert.fail("failed preparation is not an archive"),
      },
    });
    t.after(async () => {
      await spawner.close();
      await cell.close();
      rmSync(root, { recursive: true, force: true });
    });
    await assert.rejects(
      spawner.spawn(
        {
          runtimeInstanceId: definition.instanceId,
          prompt: "Never launch",
          dispatchKey: fault,
          cwd: { scope: "repo-root" },
        },
        binding,
      ),
      /injected/,
    );
    assert.equal(injected, true, "fault reached the post-commit boundary");
    assert.equal(launches, 0);
    const events = makeTaskEventReader({ rootDir: root, repoId }).read().events,
      dispatches = events.filter((event) => event.type === "runtime_dispatch_requested"),
      starts = events.filter((event) => event.type === "runtime_session_started"),
      outcomes = events.filter((event) => event.type === "runtime_session_outcome_observed");
    assert.equal(dispatches.length, 1, "cleanup must not invent another dispatch");
    assert.equal(starts.length, 1, "the center already accepted its session");
    if (fault === "unavailable acceptance") {
      assert.equal(outcomes.length, 0, "an unavailable center read cannot invent a settlement");
      assert.ok(readDispatchStream(root, dispatches[0]!.payload.dispatchId), "keep the accepted attempt recoverable");
      return;
    }
    assert.equal(outcomes.length, 1, "the admitted attempt must settle despite the missing reply");
    const lifecycle = await cell.readDispatchLifecycle({
      by: "dispatch",
      dispatchIds: [dispatches[0]!.payload.dispatchId],
    });
    assert.equal(lifecycle.status, "ready");
    if (lifecycle.status === "ready") {
      assert.equal(lifecycle.rows[0]!.attempt.stopProof, "proven_stopped");
      assert.equal(lifecycle.rows[0]!.groupPhase, "closed");
    }
  });
